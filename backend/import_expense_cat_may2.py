"""Import refreshed Expense_CAT categorized.csv (May 2 Chase data) into AquatechPM.

Mirrors POST /bank/import/expense-cat-categorized but bypasses HTTP auth.
Connection name 'Expense_CAT 2026-05-02'. Removes the older 'Expense_CAT 2026-02-20'
import to avoid double-counting (May 2 is a SUPERSET — re-pulls the same Chase period).
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

from sqlalchemy import select, delete
from app.db import SessionLocal
from app.models import BankAccount, BankConnection, BankMerchantRule, BankTransaction, User
from app.main import _truncate_text, _parse_optional_date, _apply_merchant_rule_to_tx

# Import BOTH historical (Feb 20) AND current (May 2) categorized files into ONE
# connection. Chase exports are rolling window — Feb file has 2024-05 to 2026-02,
# May file has 2024-08 to 2026-05, so we need both to keep full history. Stable
# transaction_id hash de-dups overlapping rows.
CSV_PATHS = [
    Path("/mnt/c/Users/bertr/Organized/Curated/Projects_Master/Expense_CAT/output/chase_20260220/categorized.csv"),  # historical (early data)
    Path("/mnt/c/Users/bertr/Organized/Curated/Projects_Master/Expense_CAT/output/may2_refresh/categorized.csv"),     # current (latest data)
]
CONNECTION_NAME = "Expense_CAT (rolling refresh)"

db = SessionLocal()
current_user = db.scalar(select(User).where(User.role == "admin"))
if not current_user:
    print("No admin user")
    sys.exit(1)

# Clean up any orphan partial-import connections from earlier runs
for old_name in ["Expense_CAT 2026-02-20", "Expense_CAT 2026-05-02", "Expense_CAT (rolling refresh)"]:
    old_conn = db.scalar(
        select(BankConnection).where(
            BankConnection.provider == "expense_cat_import",
            BankConnection.institution_name == old_name,
            BankConnection.user_id == current_user.id,
        )
    )
    if old_conn:
        old_accts = db.scalars(select(BankAccount).where(BankAccount.connection_id == old_conn.id)).all()
        if old_accts:
            del_count = db.execute(delete(BankTransaction).where(BankTransaction.connection_id == old_conn.id)).rowcount
            print(f"  Removed {del_count} transactions from old connection '{old_name}'")
        for a in old_accts:
            db.delete(a)
        db.delete(old_conn)
        db.flush()

conn_row = db.scalar(
    select(BankConnection).where(
        BankConnection.provider == "expense_cat_import",
        BankConnection.institution_name == CONNECTION_NAME,
        BankConnection.user_id == current_user.id,
    )
)
if not conn_row:
    conn_row = BankConnection(
        provider="expense_cat_import",
        user_id=current_user.id,
        institution_name=CONNECTION_NAME,
        institution_id=None,
        item_id=None,
        access_token=None,
        status="connected",
    )
    db.add(conn_row)
    db.flush()
    print(f"  Created connection '{CONNECTION_NAME}' (id={conn_row.id})")
else:
    print(f"  Reusing existing connection '{CONNECTION_NAME}' (id={conn_row.id})")

rules_by_key = {
    r.merchant_key: (r.expense_group, r.category)
    for r in db.scalars(select(BankMerchantRule).where(BankMerchantRule.user_id == current_user.id)).all()
}

created_accounts = created_tx = updated_tx = rows_total = rows_skipped = 0
account_cache: dict[str, BankAccount] = {}
in_run_tx: dict[str, BankTransaction] = {}    # track tx_ids added in THIS run

# Iterate every input CSV in order (later files update overlap rows in place)
all_rows = []
for csv_path in CSV_PATHS:
    if not csv_path.exists():
        print(f"  WARN: missing {csv_path}")
        continue
    text = csv_path.read_text(encoding="utf-8-sig")
    file_rows = list(csv.DictReader(io.StringIO(text)))
    print(f"  + {csv_path.name}: {len(file_rows)} rows")
    all_rows.extend(file_rows)

print(f"  Total rows across files: {len(all_rows)}")

for row in all_rows:
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

    # Normalize account_id: strip date suffix (Chase0273_Activity_20260502 -> Chase0273_Activity)
    raw_account = str(row.get("account") or "Expense_CAT_Imported").strip() or "Expense_CAT_Imported"
    import re as _re
    account_id = _truncate_text(_re.sub(r"_(2024|2025|2026)\d{4}$", "", raw_account), 128)
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

    # FORCE stable hash regardless of Expense_CAT's per-export transaction_id —
    # because the same logical Chase transaction gets different transaction_ids
    # across multiple Expense_CAT runs (filename embedded in id), preventing dedup.
    dedupe_raw = f"{account_id}|{posted_date.isoformat()}|{desc_raw}|{amount:.2f}"
    transaction_id = hashlib.sha256(dedupe_raw.encode("utf-8")).hexdigest()[:40]

    # First check in-run cache (May file may overlap Feb file in same loop)
    tx = in_run_tx.get(transaction_id)
    if tx is None:
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
    category_arr = [category] if category else []
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
        in_run_tx[transaction_id] = tx
        created_tx += 1
    else:
        updated_tx += 1
    tx.posted_date = posted_date
    tx.name = _truncate_text(desc_raw, 255)
    tx.merchant_name = merchant
    tx.amount = float(amount)
    tx.iso_currency_code = str(row.get("currency") or "USD").strip() or "USD"
    tx.pending = False
    tx.is_business = bool(acct.is_business)
    tx.category_json = json.dumps(category_arr)
    tx.raw_json = json.dumps(raw_payload)
    _apply_merchant_rule_to_tx(tx, raw_payload, rules_by_key)

conn_row.last_synced_at = datetime.utcnow()
db.commit()
print(f"\nResults:")
print(f"  rows total:      {rows_total}")
print(f"  rows skipped:    {rows_skipped}")
print(f"  accounts created:{created_accounts}")
print(f"  tx created:      {created_tx}")
print(f"  tx updated:      {updated_tx}")
print(f"  Connection: '{CONNECTION_NAME}' (id={conn_row.id})")
