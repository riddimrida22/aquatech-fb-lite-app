"""Set up BOC Capital invoice-factoring facility and import all related cash flows.

Mechanics (per user description):
  - Aquatech invoices client (HDR / Stantec+B&C / Woodard&Curran) on
    Mount Vernon Flood / BWT Design Assistance / LTCP4 projects.
  - BOC purchases the receivable, advances 70% of invoice less 1% fee to
    Aquatech's Chase 6611 (so net advance ~= 69% of invoice).
  - Client pays 100% of invoice into a DACA account at Dime Bank — out of
    Aquatech's direct visibility.
  - BOC takes the 30% holdback minus accrued interest, and remits the residual
    to Aquatech's Dime account; user manually wires/Zelles those residuals to
    Chase 6611. Those wires are visible on Chase 6611 with descriptions
    referencing Dime Community Bank.

Tracking model:
  - Loan record represents the factoring facility itself.
  - Each BOC ACH advance to Chase 6611 = a "draw" (LoanPayment with negative
    principal so balance increases — these are advances against AR).
  - Each Dime->Chase 6611 wire/Zelle = a "principal repayment" (balance drops).
  - The difference between (sum of paid invoices on the 3 projects) and
    (BOC advances + Dime residuals received) = financing cost (1% upfront
    fee + accrued interest), all of it deductible as interest expense.

This script links each BOC advance and Dime residual transaction to a
LoanPayment so OPEX queries exclude them and the loan ledger is auditable.
Idempotent: clears + recreates the BOC loan + payments on every run.
"""
from __future__ import annotations
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from sqlalchemy import select
from app.db import SessionLocal
from app.models import BankTransaction, Invoice, Loan, LoanPayment, Project

LOAN_NAME = "BOC Capital Factoring Facility"
BOC_NAME_RE = re.compile(r"BOC CAPITAL", re.IGNORECASE)
DIME_NAME_RE = re.compile(r"DIME COMMUNITY BANK|DIME COMMERCIAL", re.IGNORECASE)
CHASE_6611 = "Chase6611_Activity_20260220"
PROJECT_NAMES = ["Mount Vernon Flood Study", "BWT Design Assistance", "LTCP4"]


def main() -> None:
    db = SessionLocal()
    try:
        # ---- 1. Drop and recreate loan ----
        existing = db.scalar(select(Loan).where(Loan.name == LOAN_NAME))
        if existing:
            for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == existing.id)).all():
                db.delete(p)
            db.delete(existing)
            db.flush()
            print(f"Reset existing BOC factoring loan + payments")

        loan = Loan(
            name=LOAN_NAME,
            lender="BOC Capital CDFI",
            loan_type="other",
            account_last4=None,
            principal_original=0.0,    # gets updated below
            principal_current=0.0,
            interest_rate_apr=0.0,     # variable; computed per-invoice
            payment_amount=0.0,
            payment_frequency="irregular",
            origination_date=None,
            maturity_date=None,
            description_match="BOC CAPITAL|DIME COMMUNITY BANK",
            notes=(
                "Invoice factoring facility. BOC advances 70% of invoice (less 1% upfront fee) "
                "to Chase 6611; client pays full invoice into DACA at Dime Bank; BOC takes 30% "
                "holdback less interest and remits residual to Aquatech's Dime account, which is "
                "then wired/Zelled to Chase 6611. Only Mount Vernon Flood Study, BWT Design "
                "Assistance, and LTCP4 invoices are factored through this facility."
            ),
            is_active=True,
        )
        db.add(loan)
        db.flush()

        # ---- 2. Identify BOC advances ----
        boc_advances = db.scalars(
            select(BankTransaction)
            .where(BankTransaction.account_id == CHASE_6611)
            .where(BankTransaction.amount > 0)
            .order_by(BankTransaction.posted_date.asc())
        ).all()
        boc_advances = [
            t for t in boc_advances
            if BOC_NAME_RE.search(f"{t.name or ''} {t.merchant_name or ''}")
        ]

        # ---- 3. Identify Dime->6611 holdback wires ----
        dime_inflows = db.scalars(
            select(BankTransaction)
            .where(BankTransaction.account_id == CHASE_6611)
            .where(BankTransaction.amount > 0)
            .order_by(BankTransaction.posted_date.asc())
        ).all()
        dime_inflows = [
            t for t in dime_inflows
            if DIME_NAME_RE.search(f"{t.name or ''} {t.merchant_name or ''}")
        ]

        # ---- 4. Insert advances as "draws" (negative principal so balance grows) ----
        sum_advances = 0.0
        for t in boc_advances:
            amt = float(t.amount)
            sum_advances += amt
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=t.posted_date,
                total_amount=-amt,
                principal_amount=-amt,    # negative = draw against the facility
                interest_amount=0.0,
                fees_amount=0.0,
                bank_transaction_id=t.id,
                notes=f"BOC Capital advance to Chase 6611: {(t.name or '')[:120]}",
            ))

        # ---- 5. Insert Dime residuals as "payments" (positive principal) ----
        sum_dime_residuals = 0.0
        for t in dime_inflows:
            amt = float(t.amount)
            sum_dime_residuals += amt
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=t.posted_date,
                total_amount=amt,
                principal_amount=amt,
                interest_amount=0.0,
                fees_amount=0.0,
                bank_transaction_id=t.id,
                notes=f"Dime->Chase 6611 holdback residual: {(t.name or '')[:120]}",
            ))

        # ---- 6. Compute total invoice value through the 3 projects ----
        invoice_total = 0.0
        invoice_paid = 0.0
        for pname in PROJECT_NAMES:
            proj = db.scalar(select(Project).where(Project.name == pname))
            if not proj:
                continue
            for inv in db.scalars(select(Invoice).where(Invoice.project_id == proj.id)).all():
                invoice_total += float(inv.subtotal_amount or 0)
                invoice_paid += float(inv.amount_paid or 0)

        # ---- 7. Reconcile financing cost ----
        # For PAID invoices only:
        #   client paid X (=invoice_paid)
        #   Aquatech received in 6611 = BOC advances on those + Dime residuals on those
        #   Difference = total financing cost (1% fee + accrued interest)
        cash_received = sum_advances + sum_dime_residuals
        financing_cost = invoice_paid - cash_received

        # ---- 8. Update loan summary ----
        loan.principal_original = sum_advances  # high-water mark of advances
        loan.principal_current = max(0.0, sum_advances - sum_dime_residuals)
        loan.notes = (
            f"Invoice factoring facility (Mount Vernon / BWT / LTCP4 only). "
            f"Lifetime advances (70% less 1% fee): ${sum_advances:,.2f}. "
            f"Lifetime Dime->Chase 6611 holdback residuals: ${sum_dime_residuals:,.2f}. "
            f"Outstanding factored receivables (advance not yet repaid): ${loan.principal_current:,.2f}. "
            f"Total invoice value on the 3 projects: ${invoice_total:,.2f} ({invoice_paid:,.2f} paid). "
            f"Implied lifetime financing cost (1% fees + interest, deductible): "
            f"${financing_cost:,.2f} for paid invoices."
        )

        db.commit()

        # ---- 9. Tax-year breakdown ----
        year_data: dict[int, dict[str, float]] = {}
        for t in boc_advances:
            yr = t.posted_date.year if t.posted_date else 0
            yt = year_data.setdefault(yr, {"adv": 0.0, "dime": 0.0})
            yt["adv"] += float(t.amount or 0)
        for t in dime_inflows:
            yr = t.posted_date.year if t.posted_date else 0
            yt = year_data.setdefault(yr, {"adv": 0.0, "dime": 0.0})
            yt["dime"] += float(t.amount or 0)

        # ---- 10. Print summary ----
        print()
        print("=" * 72)
        print(f"BOC Capital Factoring Facility (loan id={loan.id})")
        print("=" * 72)
        print(f"  BOC advances received   : {len(boc_advances):>3} txns  ${sum_advances:>12,.2f}")
        print(f"  Dime residuals received : {len(dime_inflows):>3} txns  ${sum_dime_residuals:>12,.2f}")
        print(f"  Total cash received     :        ${cash_received:>12,.2f}")
        print(f"  Total invoiced (3 projs):        ${invoice_total:>12,.2f}")
        print(f"  Total client-paid       :        ${invoice_paid:>12,.2f}")
        print(f"  Outstanding factored AR :        ${loan.principal_current:>12,.2f}")
        print(f"  Implied financing cost  :        ${financing_cost:>12,.2f}  (deductible)")
        print()
        print("By year:")
        for yr in sorted(year_data.keys()):
            yt = year_data[yr]
            print(f"  {yr}: BOC advances ${yt['adv']:>11,.2f}   Dime residuals ${yt['dime']:>10,.2f}")

        print()
        print("Note: Implied financing cost = client_paid - (BOC advances + Dime residuals).")
        print("This includes both the 1% upfront fee on each invoice AND the accrued interest")
        print("BOC charges on the period the advance is outstanding before the client pays.")
        print("All deductible as interest expense for tax purposes.")
        print()
        print("Caveat: Some BOC advances may be against invoices that aren't yet paid by")
        print("clients (so no Dime residual back yet). The financing cost computed above is")
        print("an estimate for fully-cycled invoices; refine when each invoice's BOC advance")
        print("date and client-payment date are matched up.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
