"""Estimate BOC Capital factoring fees + interest from cash flows.

Model (per user description):
  Per factored invoice of value $I:
    - BOC advances 70% of $I, less 1% fee. Net to Chase 6611: 0.70*I - 0.01*I = 0.69*I
    - 1% fee BOC keeps                                           = 0.01 * I  (fee revenue to BOC)
    - Client pays $I to DACA at Dime
    - BOC takes 30% holdback, less interest accrued during the float period
    - Dime receives (0.30 * I) - interest, which Aquatech wires to Chase 6611

User's stated assumption: the Aquatech Dime account is empty NOW.
  --> Every dollar of 30% holdback that did NOT come back to Aquatech via
      Dime is BOC's accrued interest (i.e. the cost of capital BOC charged).

For paid invoices on Mt Vernon Flood Study + BWT Design Assistance + LTCP4:
  expected 30% holdback total  = 0.30 * sum(amount_paid)
  observed Dime wires received = sum(Dime->Chase 6611 inflows)
  implied BOC interest         = expected_holdback - observed_dime_wires
  implied BOC 1% fees          = 0.01 * sum(amount_paid)

Allocates the implied interest across the Dime-wire LoanPayment rows so the
P&L picks them up automatically as `interest_expense`. The 1% fees go on a
single fee-only LoanPayment row dated at the most recent advance.
Idempotent.
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
from app.models import Invoice, Loan, LoanPayment, Project

LOAN_NAME = "BOC Capital Factoring Facility"
PROJECT_NAMES = ["Mount Vernon Flood Study", "BWT Design Assistance", "LTCP4"]

ADVANCE_FRAC = 0.70   # BOC advances 70% of invoice
FEE_FRAC = 0.01       # 1% upfront fee per invoice
HOLDBACK_FRAC = 1.0 - ADVANCE_FRAC  # 30%


def main() -> None:
    db = SessionLocal()
    try:
        loan = db.scalar(select(Loan).where(Loan.name == LOAN_NAME))
        if not loan:
            print(f"ERROR: Loan '{LOAN_NAME}' not found. Run import_boc_factoring.py first.")
            return

        # Per-year paid-invoice totals on the 3 factored projects
        per_year_paid: dict[int, float] = {}
        all_paid_invoices: list[Invoice] = []
        for pname in PROJECT_NAMES:
            proj = db.scalar(select(Project).where(Project.name == pname))
            if not proj:
                continue
            for inv in db.scalars(
                select(Invoice).where(Invoice.project_id == proj.id)
            ).all():
                if inv.paid_date and (inv.amount_paid or 0) > 0:
                    yr = inv.paid_date.year
                    per_year_paid[yr] = per_year_paid.get(yr, 0.0) + float(inv.amount_paid or 0)
                    all_paid_invoices.append(inv)

        total_paid = sum(per_year_paid.values())
        if total_paid <= 0:
            print("No paid invoices found on the 3 factored projects.")
            return

        expected_holdback_total = HOLDBACK_FRAC * total_paid
        implied_fees_total = FEE_FRAC * total_paid

        # Dime wires already booked as LoanPayments (positive principal)
        dime_payments = db.scalars(
            select(LoanPayment)
            .where(LoanPayment.loan_id == loan.id)
            .where(LoanPayment.principal_amount > 0)
            .order_by(LoanPayment.payment_date.asc())
        ).all()
        observed_dime_total = sum(p.total_amount for p in dime_payments)
        implied_interest_total = expected_holdback_total - observed_dime_total

        # Per-year split for the Dime wires
        per_year_dime: dict[int, float] = {}
        for p in dime_payments:
            yr = p.payment_date.year if p.payment_date else 0
            per_year_dime[yr] = per_year_dime.get(yr, 0.0) + p.total_amount

        # Per-year holdback expected (allocated by paid year)
        per_year_holdback: dict[int, float] = {y: HOLDBACK_FRAC * v for y, v in per_year_paid.items()}

        # Implied interest by year (allocate by Dime wire year)
        # Method: implied_interest_year = expected_holdback_year - dime_received_year
        # Where holdback by year is keyed off paid_invoice_year and dime by wire year.
        per_year_interest: dict[int, float] = {}
        per_year_fees: dict[int, float] = {}
        for yr, paid in per_year_paid.items():
            hb = HOLDBACK_FRAC * paid
            dime_rec = per_year_dime.get(yr, 0.0)
            per_year_interest[yr] = max(0.0, hb - dime_rec)
            per_year_fees[yr] = FEE_FRAC * paid

        # ---- Print summary ----
        print("=" * 76)
        print("BOC Capital Factoring — implied fees + interest estimate")
        print("=" * 76)
        print(f"  Paid invoices on 3 factored projects:")
        for yr in sorted(per_year_paid.keys()):
            print(f"    {yr}: ${per_year_paid[yr]:>12,.2f}")
        print(f"    TOTAL: ${total_paid:>12,.2f}")
        print()
        print(f"  Expected 30% holdback total : ${expected_holdback_total:>12,.2f}")
        print(f"  Observed Dime-wire receipts : ${observed_dime_total:>12,.2f}")
        print(f"  Implied lifetime interest   : ${implied_interest_total:>12,.2f}")
        print(f"  Implied 1% upfront fees     : ${implied_fees_total:>12,.2f}")
        print(f"  Total deductible cost       : ${implied_interest_total + implied_fees_total:>12,.2f}")
        print()
        print("  By tax year:")
        all_years = sorted(set(list(per_year_paid.keys()) + list(per_year_dime.keys())))
        for yr in all_years:
            paid = per_year_paid.get(yr, 0.0)
            hb = per_year_holdback.get(yr, 0.0)
            dime = per_year_dime.get(yr, 0.0)
            intr = per_year_interest.get(yr, 0.0)
            fee = per_year_fees.get(yr, 0.0)
            print(f"    {yr}: paid ${paid:>11,.2f}  holdback ${hb:>10,.2f}  dime ${dime:>9,.2f}  "
                  f"--> interest ${intr:>9,.2f} + fees ${fee:>7,.2f} = ${intr+fee:>9,.2f}")

        # ---- Apply: split each Dime wire into principal + interest ----
        # interest portion of each wire is allocated proportionally
        # to its share of the year's Dime wires.
        applied = 0
        for p in dime_payments:
            yr = p.payment_date.year if p.payment_date else 0
            year_interest = per_year_interest.get(yr, 0.0)
            year_dime_total = per_year_dime.get(yr, 0.0)
            if year_dime_total <= 0:
                continue
            # This wire's share of the year's Dime total
            wire_interest = round(year_interest * (p.total_amount / year_dime_total), 2)
            # Reset principal/interest split: wire_total stays the same,
            # but split into interest (BOC's cut deducted before remittance)
            # plus the "principal repaid" (the residual that came back).
            # NOTE: the wire amount IS the residual; the interest was already
            # deducted by BOC. So principal = wire_amount, and the interest is
            # tracked as a separate "imputed" expense. We model that by adding
            # the interest to interest_amount but NOT changing total_amount.
            p.principal_amount = round(p.total_amount, 2)  # the cash that actually came back
            p.interest_amount = wire_interest
            p.notes = (p.notes or "") + f" | imputed interest portion: ${wire_interest:,.2f}"
            applied += 1
        print()
        print(f"Applied imputed interest to {applied} Dime-wire LoanPayments.")

        # ---- Add a single "1% upfront fees" LoanPayment row per year ----
        # Use the latest BOC advance date in each year as the booking date.
        boc_advances = db.scalars(
            select(LoanPayment)
            .where(LoanPayment.loan_id == loan.id)
            .where(LoanPayment.principal_amount < 0)
            .order_by(LoanPayment.payment_date.asc())
        ).all()
        latest_by_year: dict[int, date] = {}
        for p in boc_advances:
            yr = p.payment_date.year if p.payment_date else 0
            if yr not in latest_by_year or p.payment_date > latest_by_year[yr]:
                latest_by_year[yr] = p.payment_date

        # First clear any prior synthetic fee rows (they have notes starting with "BOC 1% fee imputed")
        for p in db.scalars(
            select(LoanPayment).where(LoanPayment.loan_id == loan.id, LoanPayment.notes.like("BOC 1% fee imputed%"))
        ).all():
            db.delete(p)

        for yr, fee_amt in per_year_fees.items():
            if fee_amt <= 0:
                continue
            booking_date = latest_by_year.get(yr) or date(yr, 12, 31)
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=booking_date,
                total_amount=fee_amt,
                principal_amount=0.0,
                interest_amount=0.0,
                fees_amount=round(fee_amt, 2),
                bank_transaction_id=None,
                notes=f"BOC 1% fee imputed for {yr} paid invoices on Mt Vernon/BWT/LTCP4 (${fee_amt:,.2f})",
            ))

        # ---- Update loan notes ----
        loan.notes = (
            f"Invoice factoring: 70% advance, 1% upfront fee, 30% holdback, "
            f"BOC takes interest from holdback. Estimates derived assuming Dime is empty: "
            f"lifetime interest ${implied_interest_total:,.2f} + fees ${implied_fees_total:,.2f} = "
            f"${implied_interest_total + implied_fees_total:,.2f} deductible. "
            f"By year: " + ", ".join(
                f"{yr} ${per_year_interest.get(yr, 0.0) + per_year_fees.get(yr, 0.0):,.2f}"
                for yr in all_years
            )
            + ". Refine with BOC year-end statements when available."
        )
        db.commit()
        print()
        print(f"Loan notes updated. Loan id={loan.id} interest_total now reflects estimate.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
