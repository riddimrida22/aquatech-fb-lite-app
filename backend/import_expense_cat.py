"""One-shot: import Expense_CAT categorized.csv into AquatechPM bank tables.
Mirrors /bank/import/expense-cat-categorized but bypasses HTTP auth.
"""
import csv
import hashlib
import io
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from sqlalchemy import select
from app.db import SessionLocal
from app.models import BankAccount, BankConnection, BankMerchantRule, BankTransaction, User
from app.main import _truncate_text, _parse_optional_date, _apply_merchant_rule_to_tx

CSV_PATH = Path("C:/Users/bertr/Organized/Curated/Projects_Master/Expense_CAT/output/chase_20260220/categorized.csv")
print(f"Reading {CSV_PATH.name} ({CSV_PATH.stat().st_size/1024:.0f} KB)...")
text = CSV_PATH.read_text(encoding="utf-8-sig")
reader = csv.DictReader(io.StringIO(text))

db = SessionLocal()
current_user = db.scalar(select(User).where(User.role == "admin"))
if not current_user:
    print("No admin user")
    sys.exit(1)

connection_name_clean = "Expense_CAT 2026-02-20"
conn_row = db.scalar(
    select(BankConnection).where(
        BankConnection.provider == "expense_cat_import",
        BankConnection.institution_name == connection_name_clean,
        BankConnection.user_id == current_user.id,
    )
)
if not conn_row:
    conn_row = BankConnection(
        provider="expense_cat_import",
        user_id=current_user.id,
        institution_name=connection_name_clean,
        institution_id=None,
        item_id=None,
        access_token=None,
        status="connected",
    )
    db.add(conn_row)
    db.flush()

rules_by_key = {
    r.merchant_key: (r.expense_group, r.category)
    for r in db.scalars(select(BankMerchantRule).where(BankMerchantRule.user_id == current_user.id)).all()
}
account_cache: dict[str, BankAccount] = {}
created_accounts = created_tx = updated_tx = rows_total = rows_skipped = 0

for row in reader:
    rows_total += 1
    date_raw = str(row.get("date") or "").strip()
    desc_raw = str(row.get("description") or "").strip()
    amount_raw = str(row.get("amount") or "").strip()
    if not date_raw or not desc_raw or not amount_raw:
        rows_skipped += 1; continue
    try:
        amount = float(amount_raw)
    except ValueError:
        rows_skipped += 1; continue
    posted_date = _parse_optional_date(date_raw)
    if posted_date is None:
        rows_skipped += 1; continue

    account_id = _truncate_text(str(row.get("account") or "Expense_CAT_Imported"), 128) or "Expense_CAT_Imported"
    acct = account_cache.get(account_id)
    if acct is None:
        acct = db.scalar(
            select(BankAccount).where(
                BankAccount.connection_id == conn_row.id,
                BankAccount.account_id == account_id,
            )
        )
        if not acct:
            acct = BankAccount(
                connection_id=conn_row.id,
                account_id=account_id,
                name=account_id,
                is_business=True,
            )
            db.add(acct)
            db.flush()
            created_accounts += 1
        account_cache[account_id] = acct

    transaction_id = _truncate_text(str(row.get("transaction_id") or ""), 128)
    if not transaction_id:
        seed = f"{account_id}|{posted_date.isoformat()}|{desc_raw}|{amount:.2f}"
        transaction_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:40]

    tx = db.scalar(
        select(BankTransaction).where(
            BankTransaction.connection_id == conn_row.id,
            BankTransaction.transaction_id == transaction_id,
        )
    )
    category = _truncate_text(str(row.get("final_category") or row.get("category") or ""), 180)
    expense_group = _truncate_text(str(row.get("expense_group") or ""), 64)
    merchant = _truncate_text(str(row.get("merchant_key") or ""), 255) or None
    needs_review_raw = str(row.get("needs_review") or "").strip().lower()
    needs_review = needs_review_raw in {"1", "true", "yes", "y"}
    raw_payload = {
        "source": "expense_cat",
        "source_file": row.get("source_file"),
        "transaction_id": row.get("transaction_id"),
        "date": date_raw,
        "description": desc_raw,
        "merchant_key": row.get("merchant_key"),
        "account": account_id,
        "amount": amount,
        "is_expense": row.get("is_expense"),
        "expense_amount": row.get("expense_amount"),
        "expense_group": expense_group,
        "category": row.get("category"),
        "final_category": row.get("final_category"),
        "confidence": row.get("confidence"),
        "category_source": row.get("category_source"),
        "needs_review": needs_review,
        "notes": row.get("notes"),
    }

    if not tx:
        tx = BankTransaction(
            connection_id=conn_row.id,
            account_id=account_id,
            transaction_id=transaction_id,
        )
        db.add(tx)
        created_tx += 1
    else:
        updated_tx += 1
    tx.posted_date = posted_date
    tx.name = _truncate_text(desc_raw, 255)
    tx.merchant_name = merchant
    tx.amount = float(amount)
    tx.iso_currency_code = "USD"
    tx.pending = False
    tx.is_business = bool(acct.is_business)
    tx.category_json = json.dumps([category] if category else [])
    tx.raw_json = json.dumps(raw_payload)
    _apply_merchant_rule_to_tx(tx, raw_payload, rules_by_key)

conn_row.last_synced_at = datetime.utcnow()
db.commit()
print(f"DONE: rows={rows_total} skipped={rows_skipped} accounts+={created_accounts} tx+={created_tx} tx_upd={updated_tx}")
