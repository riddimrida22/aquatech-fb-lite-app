"""Parallel-run reconciliation: our engine vs a Paychex journal for the same period.

For each employee in the Paychex PDF we take the actual gross + 401(k) deferral,
run our engine (jurisdiction + W-4 from the roster, YTD from the ledger), and diff
every tax line + net. This is the acceptance gate before cutover: it must tie out.

CLI:  python -m app.payroll.reconcile <paychex_journal.pdf>   (from backend/)
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .engine import EmployeeInput, cents, compute_employee
from .models import PayrollEmployee, PayrollYtd
from .paychex_parse import parse_journal

TOL = Decimal("0.02")
_TAX_KEYS = ["fed", "ss", "medicare", "ny_inc", "nyc", "ny_sdi", "ny_pfl",
             "nj_inc", "nj_sdi", "nj_ui", "nj_wf"]


def _match(db: Session, parsed_name: str) -> PayrollEmployee | None:
    fam = parsed_name.split(",")[0].strip().lower()
    roster = list(db.scalars(select(PayrollEmployee)))
    # exact family-token match first (avoids "Gilliam" vs "Welch Gilliam" collision)
    for e in roster:
        if e.legal_name.split(",")[0].strip().lower() == fam:
            return e
    for e in roster:  # fallback: substring
        if fam and fam in e.legal_name.lower():
            return e
    return None


def _ytd(db: Session, emp_id: int, yr: int) -> float:
    r = db.scalar(select(PayrollYtd).where(PayrollYtd.employee_id == emp_id, PayrollYtd.tax_year == yr))
    return float(r.ytd_gross) if r else 0.0


def reconcile(pdf_path: str, db: Session, tax_year: int = 2026) -> dict:
    pj = parse_journal(pdf_path)
    emp_rows, company_engine = [], {k: Decimal("0") for k in _TAX_KEYS}
    net_engine_total = Decimal("0")
    for pe in pj["employees"]:
        emp = _match(db, str(pe["name"]))
        gross = Decimal(str(pe["gross"] or 0))
        k401 = Decimal(str(pe["k401_ee"] or 0))
        if not emp or gross == 0:
            emp_rows.append({"name": pe["name"], "matched": bool(emp), "skipped": True})
            continue
        ei = EmployeeInput(
            name=emp.legal_name, gross=gross, pretax_401k=k401,
            state=emp.work_state, nyc_resident=emp.nyc_resident,
            k401_er_match_pct=Decimal(str(emp.k401_er_match_pct)),
            ytd_gross=Decimal(str(_ytd(db, emp.id, tax_year))),
            w4={"filing_status": emp.fed_filing_status, "step2": emp.fed_multiple_jobs,
                "dependents_annual": emp.fed_dependents_amt, "extra_per_period": emp.fed_extra_withholding,
                "ny_marital": emp.ny_marital or "single", "ny_exemptions": emp.state_allowances,
                "nyc_marital": emp.nyc_marital or emp.ny_marital or "single",
                "nyc_exemptions": emp.nyc_allowances if emp.nyc_allowances is not None else emp.state_allowances,
                "nj_exemptions": emp.state_allowances if emp.work_state == "NJ" else 0},
        )
        r = compute_employee(ei)
        for k in _TAX_KEYS:
            if r.lines.get(k) is not None:
                company_engine[k] += r.lines[k]
        pe_net = Decimal(str(pe["net"])) if pe["net"] is not None else None
        d = (r.net - pe_net) if (r.net is not None and pe_net is not None) else None
        if r.net is not None:
            net_engine_total += r.net
        emp_rows.append({"name": emp.legal_name, "matched": True,
                         "gross": float(gross), "paychex_net": float(pe_net) if pe_net is not None else None,
                         "engine_net": float(r.net) if r.net is not None else None,
                         "net_delta": float(d) if d is not None else None,
                         "ok": (d is not None and abs(d) <= TOL)})

    # company tax-total diffs (Paychex parsed vs engine summed)
    comp = pj["company"]["lines"]
    company_diffs = []
    for k in _TAX_KEYS:
        pv = comp.get(k)
        ev = company_engine[k]
        if pv is None and ev == 0:
            continue
        delta = ev - Decimal(str(pv or 0))
        company_diffs.append({"line": k, "paychex": pv, "engine": float(ev),
                              "delta": float(delta), "ok": abs(delta) <= TOL})

    net_paychex_total = pj["company"].get("net")
    net_delta = float(net_engine_total - Decimal(str(net_paychex_total or 0))) if net_paychex_total else None
    n_diffs = sum(1 for r in emp_rows if r.get("ok") is False) + sum(1 for c in company_diffs if not c["ok"])
    return {
        "period": pj["meta"], "source": pdf_path,
        "employees": emp_rows, "company_diffs": company_diffs,
        "net_engine_total": float(net_engine_total), "net_paychex_total": net_paychex_total,
        "net_delta_total": net_delta,
        "discrepancies": n_diffs,
        "verdict": "MATCH (within ±$0.02)" if n_diffs == 0 else f"{n_diffs} line(s) to review",
    }


def _print(rep: dict) -> None:
    m = rep["period"]
    print(f"\nRECONCILIATION — period {m.get('period_start')}..{m.get('period_end')} "
          f"check {m.get('check_date')}")
    print(f"source: {rep['source']}\n")
    print("Per-employee NET (Paychex vs engine):")
    for r in rep["employees"]:
        if r.get("skipped"):
            print(f"  [SKIP] {r['name']} (matched={r['matched']})"); continue
        flag = "OK " if r["ok"] else "DIFF"
        print(f"  [{flag}] {r['name'][:24]:24} gross {r['gross']:>9} "
              f"paychex {r['paychex_net']:>9} engine {r['engine_net']:>9}  Δ {r['net_delta']}")
    print("\nCompany tax totals (Paychex vs engine):")
    for c in rep["company_diffs"]:
        flag = "OK " if c["ok"] else "DIFF"
        print(f"  [{flag}] {c['line']:9} paychex {str(c['paychex']):>9} engine {c['engine']:>9}  Δ {c['delta']}")
    print(f"\nNet total: engine {rep['net_engine_total']} vs paychex {rep['net_paychex_total']} "
          f"(Δ {rep['net_delta_total']})")
    print(f"VERDICT: {rep['verdict']}  ({rep['discrepancies']} discrepancies)")


if __name__ == "__main__":
    import sys
    from ..db import SessionLocal
    with SessionLocal() as db:
        _print(reconcile(sys.argv[1], db))
