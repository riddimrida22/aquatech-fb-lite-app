"""Mount Vernon factoring + invoice cleanup.

User context:
  - All 12 Woodard & Curran invoices were factored through BOC.
  - Only the last 3 (by issue date) are still unpaid.
  - 6 unaccounted BOC ACH inflows totaling $108,136.23 are the Mt Vernon
    advances (they don't match LTCP loan 2506-5 or BWT loan 2509-10).

This script:
  1. Reassigns the 12 W&C invoices to project_id=6 (Mt Vernon Flood Study).
  2. Marks WSMV07 + WSMV08 as paid (per user — only the last 3 by date are
     actually unpaid: WSMV009, BBWC001, BBWC002).
  3. Creates a BOC Capital - Mount Vernon (Loan TBD) loan record with the 6
     ACH inflows as draws.
  4. Estimates fees + interest using the same structure as LTCP4/BWT loans:
     - 1% upfront fee per drawdown (financed)
     - 3% APR on outstanding principal over the holding period
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
from app.models import BankTransaction, Invoice, Loan, LoanPayment, Project

CHASE_6611 = "Chase6611_Activity_20260220"

# These 6 BOC ACH advances on Chase 6611 correspond to Mt Vernon (per analysis):
MT_VERNON_BOC_ADVANCES = [
    ("2025-10-02", 46118.98),
    ("2025-10-10", 12984.03),
    ("2025-11-17",  6488.13),
    ("2025-12-30", 26230.14),
    ("2026-01-20",  2749.48),
    ("2026-02-13", 13565.47),
]

# Per user: WSMV07 + WSMV08 should be paid; only WSMV009, BBWC001, BBWC002 still unpaid
INVOICES_TO_MARK_PAID = ["WSMV07", "WSMV08"]

# Today is the placeholder paid_date if exact dates unknown
PAID_PLACEHOLDER_DATE = date(2026, 5, 2)

LOAN_RATE = 0.030  # 3% APR matches LTCP4 / BWT BOC loans
FEE_FRAC = 0.01    # 1% upfront fee per drawdown


def main() -> None:
    db = SessionLocal()
    try:
        # ---- 1. Find Mt Vernon project + reassign invoices ----
        proj = db.scalar(select(Project).where(Project.name == "Mount Vernon Flood Study"))
        if not proj:
            print("ERROR: Mount Vernon Flood Study project not found")
            return

        wc_invs = db.scalars(
            select(Invoice).where(
                (Invoice.client_name.ilike("%Woodard%Curran%"))
                | (Invoice.client_name.ilike("%Mount Vernon%"))
            )
        ).all()
        # Filter to ones that LOOK like Mt Vernon (invoice prefix WSMV or BBWC or 022026)
        # Skip Brentwood Brook (W&C), White Plains SewerGEMS (W&C)
        OTHER_PROJECT_PREFIXES = ("BBWB", "WPSG", "WPS", "BRBB")  # BB = Brentwood, WP = WhitePlains
        mtv_invs = [
            inv for inv in wc_invs
            if (inv.invoice_number or "").upper().startswith(("WSMV", "BBWC", "022026"))
        ]
        # Manual: '022026' is a Mt Vernon invoice
        print(f"Found {len(mtv_invs)} Mt Vernon-shaped invoices (WSMV / BBWC / 022026 prefix):")
        reassigned = 0
        for inv in mtv_invs:
            if inv.project_id != proj.id:
                old_pid = inv.project_id
                inv.project_id = proj.id
                reassigned += 1
                print(f"  + {inv.invoice_number} reassigned project {old_pid} -> {proj.id}")
            else:
                print(f"    {inv.invoice_number} already on project {proj.id}")
        print(f"  Reassigned: {reassigned} invoices")

        # ---- 2. Mark WSMV07 + WSMV08 as paid ----
        for invnum in INVOICES_TO_MARK_PAID:
            inv = db.scalar(select(Invoice).where(Invoice.invoice_number == invnum))
            if not inv:
                print(f"  ! {invnum} not found")
                continue
            if (inv.amount_paid or 0) >= (inv.subtotal_amount or 0):
                print(f"    {invnum} already paid")
                continue
            inv.amount_paid = inv.subtotal_amount
            inv.balance_due = 0.0
            inv.status = "paid"
            inv.paid_date = inv.paid_date or PAID_PLACEHOLDER_DATE
            print(f"  + {invnum} marked paid (${inv.subtotal_amount:,.2f}, paid_date={inv.paid_date})")

        # ---- 3. Drop existing Mt Vernon BOC placeholder + recreate with data ----
        old = db.scalar(select(Loan).where(Loan.name.like("%Mount Vernon%")))
        if old:
            for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == old.id)).all():
                db.delete(p)
            db.delete(old)
            db.flush()
            print(f"Reset Mount Vernon BOC loan placeholder")

        # ---- 4. Calculate Mt Vernon outstanding balance ----
        # Total invoiced (after marking WSMV07+08 paid):
        db.flush()
        mtv_invs_fresh = db.scalars(select(Invoice).where(Invoice.project_id == proj.id)).all()
        mv_total = sum(float(i.subtotal_amount or 0) for i in mtv_invs_fresh)
        mv_unpaid = sum(float(i.balance_due or 0) for i in mtv_invs_fresh)
        mv_paid = mv_total - mv_unpaid

        # Outstanding BOC balance ≈ 70% × unpaid invoices (capped at $60k facility)
        outstanding_estimate = min(0.70 * mv_unpaid, 60000.0)

        sum_advances = sum(amt for _, amt in MT_VERNON_BOC_ADVANCES)
        sum_fees_estimated = sum(amt * FEE_FRAC / 0.99 for _, amt in MT_VERNON_BOC_ADVANCES)
        # Each advance carries an implied gross of advance / 0.99 (the 1% fee deducted)

        loan = Loan(
            name="BOC Capital - Mount Vernon (Loan TBD)",
            lender="BOC Capital CDFI",
            loan_type="line_of_credit",
            account_last4=None,
            principal_original=60000.0,
            principal_current=round(outstanding_estimate, 2),
            interest_rate_apr=LOAN_RATE,
            payment_amount=0.0,
            payment_frequency="irregular",
            origination_date=date(2025, 10, 2),  # date of first advance
            maturity_date=None,
            description_match="BOC CAPITAL",
            notes="",  # populated below
            is_active=outstanding_estimate > 0,
        )
        db.add(loan)
        db.flush()

        # ---- 5. Book each BOC ACH advance as a LoanPayment, link to bank tx ----
        for d_iso, amt in MT_VERNON_BOC_ADVANCES:
            d = date.fromisoformat(d_iso)
            # Find the corresponding bank tx
            tx = db.scalar(
                select(BankTransaction).where(
                    BankTransaction.account_id == CHASE_6611,
                    BankTransaction.amount.between(amt - 0.5, amt + 0.5),
                    BankTransaction.posted_date == d,
                ).limit(1)
            )
            tx_id = tx.id if tx else None
            # Estimate the 1% fee for this draw (financed, not yet paid in cash)
            implied_fee = round(amt * FEE_FRAC / 0.99, 2)
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=d,
                total_amount=-amt,
                principal_amount=-amt,
                interest_amount=0.0,
                fees_amount=0.0,            # fee is financed by the loan, not paid in cash here
                bank_transaction_id=tx_id,
                notes=(
                    f"Mt Vernon: ACH advance ${amt:,.2f} (implied 1% fee ${implied_fee:,.2f} financed). "
                    + ("Linked to Chase 6611 row." if tx_id else "Unmapped to bank tx.")
                ),
            ))
            print(f"  + advance {d_iso} ${amt:>10,.2f}  fee est ${implied_fee:.2f}  tx_id={tx_id}")

        # ---- 6. Estimate lifetime fees + interest ----
        # Lifetime fees = sum of 1% × gross_amount for each advance
        lifetime_fees = round(sum_fees_estimated, 2)

        # Interest: 3% APR on outstanding balance. With many short-cycle advances
        # (avg 30-60 days), estimate aggregate interest as 3% × sum(advance × days_outstanding/365).
        # Rough estimate: lifetime advances $108k × ~45 day avg cycle × 3%/365 = ~$400 interest
        avg_days = 45
        lifetime_interest_estimate = round(sum_advances * (LOAN_RATE * avg_days / 365), 2)

        # Add a single placeholder LoanPayment for estimated lifetime fees+interest
        # (so they show up in the P&L even though we don't have the real BOC PDF yet)
        db.add(LoanPayment(
            loan_id=loan.id,
            payment_date=date(2026, 5, 2),
            total_amount=lifetime_fees + lifetime_interest_estimate,
            principal_amount=0.0,
            interest_amount=lifetime_interest_estimate,
            fees_amount=lifetime_fees,
            bank_transaction_id=None,
            notes=(
                f"Mt Vernon: ESTIMATED lifetime cost on {len(MT_VERNON_BOC_ADVANCES)} "
                f"BOC advances totaling ${sum_advances:,.2f}. "
                f"1% upfront fees ≈ ${lifetime_fees:,.2f}. "
                f"3% APR over avg {avg_days}-day cycle ≈ ${lifetime_interest_estimate:,.2f}. "
                f"Refine with the actual BOC transaction history PDF when available."
            ),
        ))

        loan.notes = (
            f"BOC facility for Mount Vernon Flood Study (Woodard & Curran). "
            f"Cap ${60000:,.0f} at {LOAN_RATE*100:.1f}% APR, 1% per-draw fee. "
            f"Lifetime advances: ${sum_advances:,.2f} across {len(MT_VERNON_BOC_ADVANCES)} draws. "
            f"Project totals: ${mv_total:,.2f} invoiced, ${mv_paid:,.2f} paid, "
            f"${mv_unpaid:,.2f} unpaid (last 3 invoices). "
            f"Outstanding factored AR estimate: ${outstanding_estimate:,.2f} "
            f"(capped at $60k facility limit if 70% advance > cap). "
            f"Lifetime fees ≈ ${lifetime_fees:,.2f}, interest ≈ ${lifetime_interest_estimate:,.2f} "
            f"(both estimates — replace with BOC transaction history when received)."
        )

        db.commit()

        # ---- 7. Print summary ----
        print()
        print("=" * 76)
        print("Mt Vernon factoring summary")
        print("=" * 76)
        print(f"  Project totals (after WSMV07+08 paid):")
        print(f"    Invoiced  : ${mv_total:>11,.2f}  ({len(mtv_invs_fresh)} invoices)")
        print(f"    Paid      : ${mv_paid:>11,.2f}  ({len([i for i in mtv_invs_fresh if (i.balance_due or 0) == 0])})")
        print(f"    Unpaid    : ${mv_unpaid:>11,.2f}  ({len([i for i in mtv_invs_fresh if (i.balance_due or 0) > 0])})")
        print()
        print(f"  BOC Mt Vernon facility:")
        print(f"    Cap                       : $60,000")
        print(f"    Lifetime advances         : ${sum_advances:>11,.2f}")
        print(f"    Estimated lifetime fees   : ${lifetime_fees:>11,.2f}")
        print(f"    Estimated lifetime interest: ${lifetime_interest_estimate:>10,.2f}")
        print(f"    Outstanding balance estimate: ${outstanding_estimate:>9,.2f}")
        print(f"    Total deductible (fees+int): ${lifetime_fees + lifetime_interest_estimate:>10,.2f}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
