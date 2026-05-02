"""Import Chase business credit card PDF statements into AquatechPM bank tables.

User context: card 0434, ALL charges are BUSINESS (none are personal).

Maps each statement transaction line into a BankTransaction row with:
- account_id = "Chase 0434 Business CC"
- is_business = True
- amount sign: purchases = NEGATIVE (outflow, matches Chase bank convention),
               payments-on-CC = POSITIVE (inflow / paid down)
- source_file = original PDF filename (so dedup matches against bank-side payments later)
- raw_json captures the full extracted info
"""
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

import pypdf
from sqlalchemy import select
from app.db import SessionLocal
from app.models import BankAccount, BankConnection, BankTransaction, User

CC_PDFS = [
    Path("C:/Users/bertr/Downloads/3D4C8783-4043-41E8-8F01-C7BE70DBDFFE-list.pdf"),
    Path("C:/Users/bertr/Downloads/75C4DC7D-67B4-4859-A686-23BEFD4C6131-list.pdf"),
    Path("C:/Users/bertr/Downloads/B9ABD959-BF34-4A6D-967E-E7686CDB97B7-list.pdf"),
]
ACCOUNT_ID = "Chase 0434 Business CC"

# Heuristic merchant rules for typical Chase business CC categories
RULES = [
    (r"PAYMENT THANK YOU|PAYMENT-?THANK", ("Other", "Internal Transfer")),
    (r"BIBERK", ("COGS", "Cost of Goods Sold_Labor Insurance")),
    (r"NYSIF", ("COGS", "Cost of Goods Sold_Labor Insurance")),
    (r"FUNDBOX", ("Other", "Loan Payment")),
    (r"REGUS|IWGPLC", ("OH", "Office Rent")),
    (r"OPENAI|CHATGPT", ("OH", "Software & Subscriptions")),
    (r"ADOBE", ("OH", "Software & Subscriptions")),
    (r"AUTODESK", ("OH", "Software & Subscriptions")),
    (r"FEDEX", ("OH", "Shipping & Freight")),
    (r"FOREIGN TRANSACTION FEE", ("OH", "Bank Fees")),
    (r"MEDIA MARKT|ELCHE|VILLAJOYOSA", ("OH", "Office Equipment")),
    (r"EXCHG RATE|EUR(O|) ", ("OH", "Office Equipment")),  # foreign-currency context lines
    (r"ALPACA|ALPACADB", ("OH", "Software & Subscriptions")),
    (r"GOOGLE\\*|GSUITE|G SUITE", ("OH", "Software & Subscriptions")),
    (r"AMAZON|AMZN", ("OH", "Office Supplies")),
    (r"USPS|UPS\\*|UPS ", ("OH", "Shipping & Freight")),
]


def categorize(description: str) -> tuple[str, str]:
    up = description.upper()
    for pattern, (group, cat) in RULES:
        if re.search(pattern, up):
            return group, cat
    return ("Unassigned", "Uncategorized")


def extract_text(pdf_path: Path) -> tuple[str, str | None, str | None]:
    """Return (full_text, opening_date, closing_date) — dates as 'YYYY-MM-DD' or None."""
    reader = pypdf.PdfReader(str(pdf_path))
    text = "\n".join((pg.extract_text() or "") for pg in reader.pages)
    open_iso = close_iso = None
    m = re.search(r"Opening/Closing Date\s+(\d{2}/\d{2}/\d{2})\s*-\s*(\d{2}/\d{2}/\d{2})", text)
    if m:
        try:
            o = datetime.strptime(m.group(1), "%m/%d/%y").date()
            c = datetime.strptime(m.group(2), "%m/%d/%y").date()
            open_iso = o.isoformat()
            close_iso = c.isoformat()
        except ValueError:
            pass
    return text, open_iso, close_iso


def parse_transactions(text: str, open_iso: str | None, close_iso: str | None) -> list[dict]:
    """Pull MM/DD transaction lines out of the statement body. The statement uses MM/DD
    so we infer year from the Opening date (most txns) and roll over if a date is before
    the open date by more than a month."""
    open_year = int(open_iso[:4]) if open_iso else date.today().year
    open_md = open_iso[5:] if open_iso else "01-01"
    rows: list[dict] = []
    # Use a regex tolerant of varying whitespace
    pattern = re.compile(r"^\s*(\d{2}/\d{2})\s+(.+?)\s+(-?\d+(?:,\d{3})*\.\d{2})\s*$")
    for raw in text.splitlines():
        line = raw.rstrip()
        m = pattern.match(line)
        if not m:
            continue
        md, desc, amt_raw = m.groups()
        # Skip totals / cycle summary lines that may match the regex
        u = desc.upper()
        if "TOTAL FEES CHARGED" in u or "TOTAL INTEREST CHARGED" in u:
            continue
        if "TRANSACTIONS THIS CYCLE" in u:
            continue
        # Year inference: assume open_year for MM/DD; if MM is much greater than open MM,
        # treat as previous year (rare for monthly statements)
        try:
            d = datetime.strptime(f"{md}/{open_year}", "%m/%d/%Y").date()
        except ValueError:
            continue
        if open_iso:
            o_year = int(open_iso[:4])
            o_month = int(open_iso[5:7])
            if d.month < max(o_month - 2, 1):
                # Wraparound: belongs to prev calendar year
                try:
                    d = d.replace(year=o_year - 1)
                except ValueError:
                    pass
        amt = float(amt_raw.replace(",", ""))
        # Statement convention: positive = charge (expense), negative = payment received
        # AquatechPM convention: negative = outflow expense, positive = inflow
        # So invert sign.
        amt_signed = -amt
        rows.append({"posted_date": d, "amount": amt_signed, "description": desc.strip(), "raw_amount": amt})
    return rows


def main() -> None:
    db = SessionLocal()
    user = db.scalar(select(User).where(User.role == "admin"))
    if not user:
        print("No admin user")
        return

    conn = db.scalar(
        select(BankConnection).where(
            BankConnection.provider == "chase_cc_pdf_import",
            BankConnection.user_id == user.id,
        )
    )
    if not conn:
        conn = BankConnection(
            provider="chase_cc_pdf_import",
            user_id=user.id,
            institution_name="Chase Business CC 0434",
            institution_id=None,
            item_id=None,
            access_token=None,
            status="connected",
        )
        db.add(conn)
        db.flush()

    acct = db.scalar(
        select(BankAccount).where(
            BankAccount.connection_id == conn.id,
            BankAccount.account_id == ACCOUNT_ID,
        )
    )
    if not acct:
        acct = BankAccount(
            connection_id=conn.id,
            account_id=ACCOUNT_ID,
            name=ACCOUNT_ID,
            type="credit",
            subtype="credit_card",
            is_business=True,
        )
        db.add(acct)
        db.flush()

    total_inserted = total_updated = total_rows = 0
    for pdf in CC_PDFS:
        if not pdf.exists():
            print(f"MISSING: {pdf}")
            continue
        text, open_iso, close_iso = extract_text(pdf)
        rows = parse_transactions(text, open_iso, close_iso)
        print(f"{pdf.name}: {len(rows)} transactions, {open_iso} -> {close_iso}")
        for r in rows:
            seed = f"chase-cc|0434|{r['posted_date'].isoformat()}|{r['amount']:.2f}|{r['description'][:80]}"
            transaction_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:40]
            existing = db.scalar(
                select(BankTransaction).where(
                    BankTransaction.connection_id == conn.id,
                    BankTransaction.transaction_id == transaction_id,
                )
            )
            group, cat = categorize(r["description"])
            payload = {
                "source": "chase_cc_pdf",
                "source_file": pdf.name,
                "statement_open_date": open_iso,
                "statement_close_date": close_iso,
                "raw_amount_on_statement": r["raw_amount"],
                "card_last4": "0434",
                "category": cat,
                "expense_group": group,
            }
            if existing:
                existing.posted_date = r["posted_date"]
                existing.amount = r["amount"]
                existing.name = r["description"][:255]
                existing.is_business = True
                existing.category_json = json.dumps([cat])
                existing.raw_json = json.dumps(payload)
                total_updated += 1
            else:
                tx = BankTransaction(
                    connection_id=conn.id,
                    account_id=ACCOUNT_ID,
                    transaction_id=transaction_id,
                    posted_date=r["posted_date"],
                    name=r["description"][:255],
                    amount=r["amount"],
                    iso_currency_code="USD",
                    pending=False,
                    is_business=True,
                    category_json=json.dumps([cat]),
                    raw_json=json.dumps(payload),
                )
                db.add(tx)
                total_inserted += 1
            total_rows += 1

    db.commit()
    print(f"\nDONE: parsed {total_rows} txns total. Inserted={total_inserted} Updated={total_updated}")


if __name__ == "__main__":
    main()
