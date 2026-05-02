"""One-shot:
  1. Create FundBox LOC loan stub (revolving line, current balance $6,756.53)
  2. Flip account ending 0273 to personal (is_business=False) on both BankAccount
     and all child BankTransaction rows so OPEX queries drop them.
  3. Scan all bank/CC transactions for FUNDBOX activity and print a report so
     the user can review which ones to map as loan payments.
"""
from __future__ import annotations
import os
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from sqlalchemy import select, update
from app.db import SessionLocal
from app.models import BankAccount, BankTransaction, Loan

PERSONAL_ACCOUNT = "Chase0273_Activity_20260220"
FUNDBOX_RE = re.compile(r"FUNDBOX|FUND BOX|FUND_BOX", re.IGNORECASE)


def main() -> None:
    db = SessionLocal()
    try:
        # ---- 1. FundBox LOC loan stub ----
        existing = db.scalar(select(Loan).where(Loan.lender == "Fundbox"))
        if existing:
            print(f"FundBox loan already exists (id={existing.id}); refreshing balance.")
            existing.principal_current = 6756.53
            existing.principal_original = 6756.53
            existing.is_active = True
        else:
            fundbox = Loan(
                name="Fundbox LOC (revolving)",
                lender="Fundbox",
                loan_type="line_of_credit",
                account_last4=None,
                principal_original=6756.53,   # current draw balance
                principal_current=6756.53,    # outstanding as of 2026-05-02
                interest_rate_apr=0.0,        # Fundbox uses weekly fee structure not APR
                payment_amount=0.0,           # variable
                payment_frequency="irregular",
                origination_date=None,
                maturity_date=None,
                description_match="FUNDBOX|FUND BOX|FUND_BOX",
                notes=(
                    "Revolving line of credit with Fundbox. Pay-off-and-reuse pattern. "
                    "Current balance of $6,756.53 includes principal + remaining fees on "
                    "outstanding draws as of 2026-05-02 (Fundbox balance confirmation letter). "
                    "Drawdowns and pay-downs flow through the Chase 6611 operating account. "
                    "Need to map individual bank transactions to this loan for proper "
                    "principal/interest split."
                ),
                is_active=True,
            )
            db.add(fundbox)
            db.flush()
            print(f"  + FundBox loan created (id={fundbox.id})")

        # ---- 2. Flip 0273 to personal ----
        acct = db.scalar(select(BankAccount).where(BankAccount.account_id == PERSONAL_ACCOUNT))
        if acct:
            if acct.is_business:
                acct.is_business = False
                print(f"  Flipped BankAccount {PERSONAL_ACCOUNT} -> is_business=False")
            else:
                print(f"  BankAccount {PERSONAL_ACCOUNT} already personal")

            # Also flip all transactions in that account
            result = db.execute(
                update(BankTransaction)
                .where(BankTransaction.account_id == PERSONAL_ACCOUNT)
                .where(BankTransaction.is_business.is_(True))
                .values(is_business=False)
            )
            print(f"  Flipped {result.rowcount} BankTransaction rows in 0273 -> is_business=False")
        else:
            print(f"  ! BankAccount '{PERSONAL_ACCOUNT}' not found")

        # ---- 3. Scan for FUNDBOX activity ----
        candidates = []
        for tx in db.scalars(
            select(BankTransaction)
            .order_by(BankTransaction.posted_date.desc())
        ).all():
            text = f"{tx.name or ''} {tx.merchant_name or ''}"
            if FUNDBOX_RE.search(text):
                candidates.append(tx)

        print()
        print(f"Found {len(candidates)} FUNDBOX-related bank transactions:")
        total_in = total_out = 0.0
        for tx in candidates[:60]:
            sign = "OUT" if tx.amount < 0 else "IN "
            print(f"    {tx.posted_date}  {sign}  ${abs(tx.amount):>9,.2f}   acct={tx.account_id[:24]:<24}  {(tx.name or '')[:80]}")
            if tx.amount < 0:
                total_out += abs(tx.amount)
            else:
                total_in += tx.amount
        if len(candidates) > 60:
            print(f"  … {len(candidates) - 60} more")
        print()
        print(f"  Total IN (draws / advances received): ${total_in:>9,.2f}")
        print(f"  Total OUT (payments / repayments)  : ${total_out:>9,.2f}")
        print(f"  Net (cash impact)                  : ${total_in - total_out:>9,.2f}")

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
