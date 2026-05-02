"""Import the full FundBox draw + payment history from bank/CC data.

Source of truth: BankTransaction rows in Chase 6611 (operating) and
Chase 0434 (business CC) where the description matches FUNDBOX. The mirrored
rows in FB-Expenses category buckets are excluded to avoid double-counting.

Method:
  1. Sum all FundBox draws (IN to Chase) and payments (OUT from Chase).
  2. Implied lifetime interest = sum(payments) - sum(draws) + current_balance.
     This is the cumulative cost of capital for FundBox over the lifetime of the
     account, derived purely from bank flows and the official 2026-05-02 balance.
  3. Allocate that lifetime interest proportionally across each payment (by
     payment amount).
  4. Create one LoanPayment per Chase transaction with the bank_transaction_id
     linked, so OPEX queries exclude them and the loan ledger is auditable.

Idempotent: drops + recreates the FundBox payment ledger on every run.
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

from sqlalchemy import select
from app.db import SessionLocal
from app.models import BankTransaction, Loan, LoanPayment

CURRENT_BALANCE_ON_FILE = 6756.53
FUNDBOX_RE = re.compile(r"FUNDBOX|FUND BOX|FUND_BOX", re.IGNORECASE)
# Real Chase accounts (not FB-Expenses buckets):
CHASE_ACCOUNT_PREFIXES = ("Chase6611_", "Chase 0434", "Chase0273_")
# Exclude personal account
EXCLUDE_ACCOUNT = "Chase0273_Activity_20260220"


def main() -> None:
    db = SessionLocal()
    try:
        loan = db.scalar(select(Loan).where(Loan.lender == "Fundbox"))
        if not loan:
            print("ERROR: FundBox loan not found. Run setup_loans_and_personal_account.py first.")
            return

        # Drop any prior FundBox-mapped payments
        prior = db.scalars(select(LoanPayment).where(LoanPayment.loan_id == loan.id)).all()
        for p in prior:
            db.delete(p)
        db.flush()
        if prior:
            print(f"Cleared {len(prior)} prior FundBox payment rows.")

        # Find all FundBox-flagged Chase transactions
        candidates = db.scalars(select(BankTransaction).order_by(BankTransaction.posted_date.asc())).all()
        chase_fundbox = [
            t for t in candidates
            if t.account_id != EXCLUDE_ACCOUNT
            and any(t.account_id.startswith(pfx) for pfx in CHASE_ACCOUNT_PREFIXES)
            and FUNDBOX_RE.search(f"{t.name or ''} {t.merchant_name or ''}")
        ]

        print(f"Identified {len(chase_fundbox)} FundBox transactions in Chase accounts (FB-Expense duplicates excluded)")

        # Categorize: IN = draw, OUT = payment
        draws = [t for t in chase_fundbox if (t.amount or 0) > 0]
        payments = [t for t in chase_fundbox if (t.amount or 0) < 0]
        sum_draws = sum(float(t.amount) for t in draws)
        sum_payments = sum(-float(t.amount) for t in payments)  # store as positive

        print()
        print(f"  Draws received        : {len(draws)} txns  total ${sum_draws:>10,.2f}")
        print(f"  Payments to FundBox   : {len(payments)} txns  total ${sum_payments:>10,.2f}")
        print(f"  Current balance owed  : ${CURRENT_BALANCE_ON_FILE:>10,.2f} (per Fundbox 2026-05-02 letter)")

        # Lifetime interest reconciliation
        # principal_repaid = draws - current_balance
        # interest_paid    = payments - principal_repaid
        principal_repaid = sum_draws - CURRENT_BALANCE_ON_FILE
        interest_paid_total = sum_payments - principal_repaid
        if principal_repaid < 0:
            print(f"  ! Bank-side draws ({sum_draws:,.2f}) < current balance ({CURRENT_BALANCE_ON_FILE:,.2f}).")
            print(f"    Some early draws may pre-date the bank-data window. Adjusting balance to draws.")
            principal_repaid = max(sum_payments - 0.0, 0.0)  # all payments are principal
            interest_paid_total = sum_payments - principal_repaid

        print()
        print(f"  --> Implied lifetime principal repaid : ${principal_repaid:>10,.2f}")
        print(f"  --> Implied lifetime interest paid    : ${interest_paid_total:>10,.2f}")
        if sum_payments > 0:
            print(f"  --> Interest as % of payments         : {(interest_paid_total / sum_payments * 100):.2f}%")

        # Allocate interest proportionally to each payment
        interest_ratio = interest_paid_total / sum_payments if sum_payments > 0 else 0.0
        principal_ratio = 1.0 - interest_ratio

        # Track tax-year split
        year_totals: dict[int, dict[str, float]] = {}
        for t in payments:
            total = -float(t.amount)
            interest = round(total * interest_ratio, 2)
            principal = round(total - interest, 2)
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=t.posted_date or date.today(),
                total_amount=total,
                principal_amount=principal,
                interest_amount=interest,
                fees_amount=0.0,
                bank_transaction_id=t.id,
                notes=f"FundBox payment from {t.account_id}: {(t.name or '')[:120]}",
            ))
            yr = (t.posted_date.year if t.posted_date else 0)
            yt = year_totals.setdefault(yr, {"principal": 0.0, "interest": 0.0, "total": 0.0, "count": 0})
            yt["principal"] += principal
            yt["interest"] += interest
            yt["total"] += total
            yt["count"] += 1

        # For draws, model as negative-principal LoanPayments so principal_current grows
        # back appropriately. They are NOT expenses (no interest, no fees).
        for t in draws:
            amount = float(t.amount)
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=t.posted_date or date.today(),
                total_amount=-amount,            # store sign-flipped so payment ledger nets to (payments - draws)
                principal_amount=-amount,        # negative principal == draw, increases balance
                interest_amount=0.0,
                fees_amount=0.0,
                bank_transaction_id=t.id,
                notes=f"FundBox DRAW credited to {t.account_id}: {(t.name or '')[:120]}",
            ))

        # Reconcile loan.principal_current to the official balance
        loan.principal_current = CURRENT_BALANCE_ON_FILE
        loan.principal_original = max(loan.principal_original, sum_draws)  # high-water mark
        loan.notes = (
            f"Revolving line of credit. Total lifetime draws: ${sum_draws:,.2f}. "
            f"Total lifetime payments: ${sum_payments:,.2f}. Principal repaid: ${principal_repaid:,.2f}. "
            f"Lifetime interest paid (deductible): ${interest_paid_total:,.2f}. "
            f"Current balance per Fundbox 2026-05-02 letter: ${CURRENT_BALANCE_ON_FILE:,.2f}. "
            "All bank-side FUNDBOX rows linked to loan ledger so they no longer count as OPEX."
        )

        db.commit()

        print()
        print("Tax-year breakdown (interest deductible):")
        for yr in sorted(year_totals.keys()):
            yt = year_totals[yr]
            print(f"  {yr}: {yt['count']:>3} payments, total ${yt['total']:>10,.2f} = "
                  f"principal ${yt['principal']:>10,.2f} + interest ${yt['interest']:>9,.2f}")
        print()
        print(f"Loan id={loan.id} '{loan.name}' updated.")
        print(f"  principal_current = ${loan.principal_current:,.2f} (matches Fundbox 2026-05-02 letter)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
