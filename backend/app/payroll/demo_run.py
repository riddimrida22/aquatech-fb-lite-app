"""End-to-end Phase-3 demo against the golden run (local only).

Exercises: compute_run -> build_journal (balances) -> DB lifecycle
(create/approve[dual-control]/pay + YTD) -> pay-stub PDF.

Run:  python -m app.payroll.demo_run   (from backend/)
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from .engine import EmployeeInput
from .service import (approve_run, build_journal, compute_run, journal_balances,
                      mark_paid)
from .stubs import render_stub_pdf

GOLDEN = Path(__file__).parent / "golden" / "run_2026-08-21.json"


def _inputs(g):
    out = []
    for e in g["employees"]:
        out.append(EmployeeInput(
            name=e["name"], gross=e["gross"], pretax_401k=e["k401_ee"],
            state=e["state"], nyc_resident=e["nyc"],
            k401_er_match_pct=Decimal("4"), w4=dict(e.get("w4", {})),
        ))
    return out


def main():
    g = json.loads(GOLDEN.read_text())
    run = compute_run(date(2026, 8, 3), date(2026, 8, 16), date(2026, 8, 21),
                      _inputs(g), weeks=2,
                      employer_extra={  # from the golden employer totals (pending YTD engine)
                          "futa": Decimal("4.33"), "ny_ui": Decimal("39.10"), "ny_rsf": Decimal("1.61"),
                          "nj_sdi": Decimal("15.30"), "nj_ui": Decimal("82.08"), "nj_wf": Decimal("3.60"),
                      })

    print(f"RUN {run.period_start}..{run.period_end}  check {run.check_date}  ({len(run.results)} employees)")
    print(f"  gross {run.gross}  ee_tax {run.ee_withholdings}  401k(ee/er) {run.ee_401k}/{run.er_401k}")
    print(f"  employer taxes {run.employer_taxes}  NET {run.net}")

    print("\nFINANCE JOURNAL")
    jl = build_journal(run)
    for l in jl:
        side = f"Dr {l.debit}" if l.debit else f"        Cr {l.credit}"
        print(f"  {l.account:42} {side}")
    d, c, ok = journal_balances(jl)
    print(f"  --- debits {d}  credits {c}  balanced={ok}")

    # DB lifecycle (in-memory sqlite; create only payroll tables)
    print("\nWORKFLOW (create -> approve[dual-control] -> pay)")
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        from . import models as M
        eng = create_engine("sqlite:///:memory:")
        for t in (M.PayrollEmployee, M.PayrollRun, M.PayrollLine, M.PayrollYtd, M.TaxTableVersion):
            t.__table__.create(bind=eng, checkfirst=True)
        with Session(eng) as db:
            from .service import create_run
            prun = create_run(db, run.period_start, run.period_end, run.check_date, created_by=1)
            print(f"  created run id={prun.id} status={prun.status}")
            try:
                approve_run(db, prun, approver_id=1)  # same as creator -> must fail
            except ValueError as ex:
                print(f"  dual-control correctly blocked self-approval: {ex}")
            approve_run(db, prun, approver_id=2)
            print(f"  approved by user 2 -> status={prun.status}")
            for r in run.results:
                r.employee_id = 0
            mark_paid(db, prun, run)
            print(f"  paid -> status={prun.status}; YTD rows={db.query(M.PayrollYtd).count()}")
            snap = json.loads(prun.totals_json)
            print(f"  snapshot net={snap['net']} employer_taxes={snap['employer_taxes']}")
    except Exception as ex:
        print(f"  [db lifecycle skipped: {type(ex).__name__}: {ex}]")

    # Pay stub PDF for one employee
    zach = next(r for r in run.results if "Zachary" in r.name)
    out = str(Path.home() / "Downloads" / "AqtPM_PayStub_sample.pdf")
    render_stub_pdf(out, {"period_start": "2026-08-03", "period_end": "2026-08-16",
                          "check_date": "2026-08-21"}, zach)
    print(f"\nPay stub written: {out}  (net {zach.net})")


if __name__ == "__main__":
    main()
