"""
FreshBooks reconciliation — treats AqtPM's FreshBooks-synced invoices as the source
of truth for what's already been billed. Used to derive the prior-billed cumulative
(instead of a hand-maintained ledger) and to show the real invoice history so the
user can see what's already invoiced and pick the next number.

FreshBooks numbering is inconsistent (HYDRAQ16, HYDRAQ17, HDRAQ017, HDRAQ-015 ...),
so numbering is user-chosen; only the amounts + dates are used for reconciliation.
"""
from __future__ import annotations
import datetime as dt
import config
import data_source

_Q = '''
import json, datetime as dt
from app.db import SessionLocal
from app.models import Invoice, InvoiceLine
from sqlalchemy import select, or_, func
db = SessionLocal()
conds = []
{cond_lines}
rows = db.execute(select(Invoice).where(or_(*conds)).order_by(Invoice.end_date)).scalars().all()
out = []
for r in rows:
    nl = db.execute(select(func.count(InvoiceLine.id)).where(InvoiceLine.invoice_id==r.id)).scalar()
    out.append(dict(number=r.invoice_number, client=r.client_name or "",
                    start=str(r.start_date), end=str(r.end_date), issue=str(r.issue_date),
                    subtotal=float(r.subtotal_amount or 0), paid=float(r.amount_paid or 0),
                    balance=float(r.balance_due or 0), status=r.status, lines=nl))
print("__JSON__" + json.dumps({{"invoices": out}}))
db.close()
'''


def _build_conds(match: dict) -> str:
    lines = []
    if match.get("client_ilike"):
        lines.append(f'conds.append(Invoice.client_name.ilike("%{match["client_ilike"]}%"))')
    if match.get("number_like"):
        lines.append(f'conds.append(Invoice.invoice_number.like("{match["number_like"]}"))')
    return "\n".join(lines) if lines else 'conds.append(Invoice.id == -1)'


def invoices(project_key: str) -> list[dict]:
    cfg = config.PROJECTS[project_key]
    q = _Q.format(cond_lines=_build_conds(cfg.get("fb_match", {})))
    return data_source.run_remote_query(q)["invoices"]


def prior_billed(project_key: str, before: dt.date,
                 exclude_status: set[str] | None = None) -> dict:
    """Sum of FreshBooks-billed subtotals already issued before `before`, treating
    FreshBooks as source of truth. Excludes draft/junk invoices (exclude_status), which
    drops the current draft + the superseded HYDRAQ-016 duplicate."""
    exclude_status = exclude_status or set()
    inv = invoices(project_key)
    prior, counted = 0.0, []
    for r in inv:
        if (r.get("status") or "").lower() in exclude_status:
            continue
        try:
            issue = dt.date.fromisoformat(r["issue"])
        except Exception:
            continue
        if issue < before:
            prior += r["subtotal"]
            counted.append(r["number"])
    return {"prior_cumulative": round(prior, 2), "invoices_counted": counted, "all": inv}


if __name__ == "__main__":
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    inv = invoices("HDR_LTCP4")
    print(f"{len(inv)} HDR invoices in FreshBooks:")
    for r in inv:
        print(f"  {r['number']:12s} end={r['end']:11s} ${r['subtotal']:>11,.2f} {r['status']:8s} lines={r['lines']}")
    # prior billed before June period (period 6 begins 2026-05-31)
    pb = prior_billed("HDR_LTCP4", dt.date(2026, 5, 31))
    print(f"\nPrior billed before 2026-05-31 (June invoice): ${pb['prior_cumulative']:,.2f}")
    print(f"  counted: {pb['invoices_counted']}")
