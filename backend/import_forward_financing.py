"""Import the Forward Financing merchant cash advance into the Loans tab.

Source data (from the customer statement PDF):
  Advance:  $11,000.00 on 2025-09-05
  Payback:  $16,940.00 (collected via daily holdbacks)
  Upfront:  $695.00 processing fee (booked 2025-09-05)
  Paid off: 2026-02-13 (final balloon of $5,159.18)

Cost of capital allocation:
  Total holdbacks       = $16,940.00
  Total principal       = $11,000.00     -> 64.9410% of each holdback
  Total interest        = $5,940.00      -> 35.0590% of each holdback
  Plus processing fee   = $695.00 booked separately on 2025-09-05

Monthly aggregate payments are created so the 2025 vs 2026 interest deduction
is clean for taxes. Each loan-payment row splits into principal + interest.

Idempotent: drops + recreates the loan and its payments on every run.
"""
from __future__ import annotations
import os
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
from app.models import Loan, LoanPayment

LOAN_NAME = "Forward Financing (paid off 2026-02-13)"
PRINCIPAL_FRAC = 11000.0 / 16940.0   # 0.6494...
INTEREST_FRAC = 5940.0 / 16940.0     # 0.3506...

# Monthly holdback totals taken straight from the PDF
MONTHLY_HOLDBACKS = [
    ("2025-09-30", 1961.12),  # 16 days × $122.57
    ("2025-10-31", 2696.54),  # 22 days × $122.57
    ("2025-11-30", 2206.26),  # 18 days × $122.57
    ("2025-12-31", 1264.37),  # mixed amounts ($122.57, $63, $20.38, $98)
    ("2026-01-31", 2426.83),  # 19 days × $122.57 + 1 × $98
    ("2026-02-13", 6384.88),  # 10 × $122.57 + final balloon $5,159.18
]


def main() -> None:
    db = SessionLocal()
    try:
        # Drop existing copy if any (so re-runs are clean)
        existing = db.scalar(select(Loan).where(Loan.name == LOAN_NAME))
        if existing:
            for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == existing.id)).all():
                db.delete(p)
            db.delete(existing)
            db.flush()
            print(f"Reset existing Forward Financing loan + payments")

        loan = Loan(
            name=LOAN_NAME,
            lender="Forward Financing",
            loan_type="other",                # "merchant cash advance" — closest fit
            account_last4=None,
            principal_original=11000.0,
            principal_current=0.0,            # paid off
            interest_rate_apr=0.0,            # MCA — not a real APR; cost is in factor not rate
            payment_amount=122.57,            # nominal daily holdback
            payment_frequency="irregular",    # daily-with-pauses, modeled as monthly aggregates
            origination_date=date(2025, 9, 5),
            maturity_date=date(2026, 2, 13),
            description_match="FORWARD FINANCING|FORWARDFIN|FORWARD FINANC",
            notes=(
                "Merchant cash advance. Total payback $16,940 on $11,000 advance "
                "(cost factor 1.54). Paid via daily holdbacks from operating account, "
                "modeled here as monthly aggregates so 2025 vs 2026 interest deduction is clean."
            ),
            is_active=False,
        )
        db.add(loan)
        db.flush()

        # Upfront processing fee booked on origination date as a fees-only payment
        db.add(LoanPayment(
            loan_id=loan.id,
            payment_date=date(2025, 9, 5),
            total_amount=695.0,
            principal_amount=0.0,
            interest_amount=0.0,
            fees_amount=695.0,
            notes="Upfront processing fee",
        ))
        print(f"  + Upfront fee 2025-09-05: $695.00")

        # Monthly holdback aggregates, split by ratio
        running_principal = 11000.0
        running_interest = 5940.0
        for date_str, total in MONTHLY_HOLDBACKS:
            d = date.fromisoformat(date_str)
            principal = round(total * PRINCIPAL_FRAC, 2)
            interest = round(total * INTEREST_FRAC, 2)
            # Adjust last-row for rounding so totals reconcile exactly
            if (date_str, total) == MONTHLY_HOLDBACKS[-1]:
                principal = round(running_principal, 2)
                interest = round(running_interest, 2)
                # And ensure total reconciles to the monthly total
                tot = round(principal + interest, 2)
                if abs(tot - total) > 0.01:
                    # nudge interest to swallow the difference
                    interest = round(interest + (total - tot), 2)
            running_principal -= principal
            running_interest -= interest
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=d,
                total_amount=round(total, 2),
                principal_amount=principal,
                interest_amount=interest,
                fees_amount=0.0,
                notes=f"Monthly aggregate of daily holdbacks · {date_str}",
            ))
            print(f"  + {date_str}: total ${total:>9,.2f} = principal ${principal:>9,.2f} + interest ${interest:>8,.2f}")

        # Verification
        payments = db.scalars(select(LoanPayment).where(LoanPayment.loan_id == loan.id)).all()
        sum_p = sum(p.principal_amount for p in payments)
        sum_i = sum(p.interest_amount for p in payments)
        sum_f = sum(p.fees_amount for p in payments)
        sum_t = sum(p.total_amount for p in payments)
        print()
        print(f"Loan {LOAN_NAME!r} created (id={loan.id})")
        print(f"  Sum principal: ${sum_p:>10,.2f}   (expected $11,000.00)")
        print(f"  Sum interest : ${sum_i:>10,.2f}   (expected  $5,940.00)")
        print(f"  Sum fees     : ${sum_f:>10,.2f}   (expected    $695.00)")
        print(f"  Sum total    : ${sum_t:>10,.2f}   (expected $17,635.00)")

        # Tax-year breakdown
        for year in (2025, 2026):
            year_payments = [p for p in payments if p.payment_date.year == year]
            yp = sum(p.principal_amount for p in year_payments)
            yi = sum(p.interest_amount for p in year_payments)
            yf = sum(p.fees_amount for p in year_payments)
            print(f"  {year} interest deductible (interest + fees): ${yi + yf:>9,.2f}  (principal repaid: ${yp:>9,.2f})")

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
