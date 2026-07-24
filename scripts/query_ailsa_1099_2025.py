"""One-off: list the 2025 "Ailsa Welch 1099" bank transactions behind the
$24,900 P&L line, so we can confirm the total and see the payment dates
(before vs. after her Oct-2025 employee conversion).

Run on the PROD box:
  docker exec -i aquatechpm_backend_1 python - < scripts/query_ailsa_1099_2025.py
or copy it in and:
  docker exec aquatechpm_backend_1 python /app/scripts/query_ailsa_1099_2025.py
"""
import json
from datetime import date

from app.db import SessionLocal
from app.models import BankTransaction

NEEDLE = "ailsa welch 1099"      # match the category regardless of casing/spacing
Y0, Y1 = date(2025, 1, 1), date(2025, 12, 31)


def category_of(tx: BankTransaction) -> str:
    try:
        parsed = json.loads(tx.category_json or "[]")
        if isinstance(parsed, list) and parsed:
            return str(parsed[0] or "").strip()
    except Exception:
        pass
    try:
        obj = json.loads(tx.raw_json or "{}")
        return str(obj.get("category") or obj.get("expense_group") or "").strip()
    except Exception:
        return ""


with SessionLocal() as db:
    rows = []
    for tx in db.query(BankTransaction).all():
        cat = category_of(tx)
        blob = f"{cat} {tx.category_json or ''} {tx.raw_json or ''}".lower()
        if NEEDLE not in blob:
            continue
        if not tx.posted_date or not (Y0 <= tx.posted_date <= Y1):
            continue
        if tx.pending or not tx.is_business:      # D-014: exclude pending
            continue
        rows.append(tx)

    rows.sort(key=lambda t: (t.posted_date or Y0))
    print(f"{'DATE':<12} {'AMOUNT':>12}  {'CATEGORY':<20} DESCRIPTION")
    print("-" * 78)
    total = 0.0
    for t in rows:
        amt = float(t.amount or 0)
        total += amt
        desc = (t.merchant_name or t.name or "")[:34]
        print(f"{t.posted_date!s:<12} {amt:>12,.2f}  {category_of(t):<20} {desc}")
    print("-" * 78)
    print(f"{len(rows)} transactions   net total: {total:,.2f}   abs total: {abs(total):,.2f}")
