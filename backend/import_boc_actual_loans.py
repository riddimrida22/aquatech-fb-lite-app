"""Replace the imputed BOC factoring estimates with actual BOC loan data
from the per-loan transaction history PDFs.

Two loans documented:
  - 2506-5 (LTCP4 facility, $75k cap, OFN/GWG1 fund, 3.0% APR)
  - 2509-10 (BWT facility, $100k cap, NYC EDC ECFLF, 3.0% APR)
  Mt Vernon facility ($60k cap) has no documented draws — leave placeholder.

Each loan's transactions become per-project LoanPayment rows so the P&L
picks up the real interest + fee numbers (much lower than my imputed
estimates — actual is fee = 1% per drawdown + 3% APR on outstanding,
NOT 30%-of-holdback as I imputed).
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
from app.models import BankTransaction, Loan, LoanPayment

# -----------------------------------------------------------------------
# Loan 2506-5 (LTCP4 facility)
# Transcribed from "2506-5 transaction_history-2026-02-26 23_22_29 +0000.pdf"
# Each row: (date, code, amt_paid, fee_paid, int_paid, prin_paid, disbursement, comment)
# -----------------------------------------------------------------------
LOAN_2506_5_TXNS = [
    # date,        code,  amt_paid,  fee_paid, int_paid,  prin_paid, disbursement, comment
    ("2025-06-11", "FX",        0,    510.00,         0,           0,            0, "Closing Costs"),
    ("2025-06-11", "LD",        0,         0,         0,           0,       510.00, "Closing Costs Financed by Loan"),
    ("2025-06-11", "PRE",  510.00,    510.00,         0,           0,            0, "Closing Costs Paid by Loan"),
    ("2025-06-25", "LD",        0,         0,         0,           0,    43640.82, "ACH Disbursement - Draw 1"),
    ("2025-06-25", "FX",        0,    440.82,         0,           0,            0, "1% Drawdown Fee - Draw 1"),
    ("2025-06-25", "LD",        0,         0,         0,           0,       440.82, "Drawdown Fee Financed by Loan"),
    ("2025-06-25", "PRE",  440.82,    440.82,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-07-03", "AT", 25281.41,         0,         0,    25251.50,            0, "ACH Payment"),
    ("2025-07-22", "LD",        0,         0,         0,           0,    19449.05, "ACH Disbursement - Draw 2"),
    ("2025-07-22", "FX",        0,    196.46,         0,           0,            0, "1% Drawdown Fee - Draw 2"),
    ("2025-07-22", "LD",        0,         0,         0,           0,       196.46, "Drawdown Fee Financed by Loan"),
    ("2025-07-22", "PRE",  196.46,    196.46,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-08-14", "LD",        0,         0,         0,           0,    27706.15, "ACH Disbursement - Draw 3"),
    ("2025-08-14", "FX",        0,    279.86,         0,           0,            0, "1% Drawdown Fee - Draw 3"),
    ("2025-08-14", "LD",        0,         0,         0,           0,       279.86, "Drawdown Fee Financed by Loan"),
    ("2025-08-14", "PRE",  279.86,    279.86,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-08-15", "AT", 18936.96,         0,         0,    18827.56,            0, "ACH Payment"),
    ("2025-09-24", "LD",        0,         0,         0,           0,    23664.54, "ACH Disbursement - Draw 4"),
    ("2025-09-24", "FX",        0,    239.04,         0,           0,            0, "1% Drawdown Fee - Draw 4"),
    ("2025-09-24", "LD",        0,         0,         0,           0,       239.04, "Drawdown Fee Financed by Loan"),
    ("2025-09-24", "PRE",  239.04,    239.04,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-10-01", "AT", 47831.26,         0,    199.73,    47631.53,            0, "ACH Payment"),
    ("2025-10-24", "LD",        0,         0,         0,           0,    16976.12, "ACH Disbursement - Draw 5"),
    ("2025-10-24", "FX",        0,    171.48,         0,           0,            0, "1% Drawdown Fee - Draw 5"),
    ("2025-10-24", "LD",        0,         0,         0,           0,       171.48, "Drawdown Fee Financed by Loan"),
    ("2025-10-24", "PRE",  171.48,    171.48,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-11-14", "LD",        0,         0,         0,           0,    18369.43, "ACH Disbursement - Draw 6"),
    ("2025-11-14", "FX",        0,    185.55,         0,           0,            0, "1% Drawdown Fee - Draw 6"),
    ("2025-11-14", "LD",        0,         0,         0,           0,       185.55, "Drawdown Fee Financed by Loan"),
    ("2025-11-14", "PRE",  185.55,    185.55,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-12-17", "LD",        0,         0,         0,           0,    14498.33, "ACH Disbursement - Draw 7"),
    ("2025-12-17", "FX",        0,    146.45,         0,           0,            0, "1% Drawdown Fee - Draw 7"),
    ("2025-12-17", "LD",        0,         0,         0,           0,       146.45, "Drawdown Fee Financed by Loan"),
    ("2025-12-17", "PRE",  146.45,    146.45,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-12-31", "AT", 17514.59,         0,    366.99,    17147.60,            0, "ACH Payment"),
    ("2026-01-16", "LD",        0,         0,         0,           0,    10855.71, "ACH Disbursement - Draw 8"),
    ("2026-01-16", "FX",        0,    109.65,         0,           0,            0, "1% Drawdown Fee - Draw 8"),
    ("2026-01-16", "LD",        0,         0,         0,           0,       109.65, "Drawdown Fee Financed by Loan"),
    ("2026-01-16", "PRE",  109.65,    109.65,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2026-01-23", "AT", 18658.92,         0,    115.23,    18543.69,            0, "ACH Payment"),
    ("2026-01-28", "PM", 23924.14,         0,     20.56,    23903.58,            0, "ACH Payment (period maturity)"),
    ("2026-02-10", "LD",        0,         0,         0,           0,    18746.85, "ACH Disbursement - Draw 9"),
    ("2026-02-10", "FX",        0,    189.36,         0,           0,            0, "1% Drawdown Fee - Draw 9"),
    ("2026-02-10", "LD",        0,         0,         0,           0,       189.36, "Drawdown Fee Financed by Loan"),
    ("2026-02-10", "PRE",  189.36,    189.36,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2026-02-25", "AI",        0,         0,         0,           0,            0, "Accrued Interest 83.49 (not yet paid)"),
]

# -----------------------------------------------------------------------
# Loan 2509-10 (BWT facility)
# -----------------------------------------------------------------------
LOAN_2509_10_TXNS = [
    ("2025-09-22", "FX",        0,    500.00,         0,           0,            0, "Closing Costs"),
    ("2025-09-22", "LD",        0,         0,         0,           0,       500.00, "Closing Costs Financed by Loan"),
    ("2025-09-22", "PRE",  500.00,    500.00,         0,           0,            0, "Closing Costs Paid by Loan"),
    ("2025-12-02", "LD",        0,         0,         0,           0,    18937.42, "ACH Disbursement - Draw 1"),
    ("2025-12-02", "FX",        0,    191.29,         0,           0,            0, "1% Drawdown Fee - Draw 1"),
    ("2025-12-02", "LD",        0,         0,         0,           0,       191.29, "Drawdown Fee Financed by Loan"),
    ("2025-12-02", "PRE",  191.29,    191.29,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2025-12-18", "LD",        0,         0,         0,           0,    21962.79, "ACH Disbursement - Draw 2"),
    ("2025-12-18", "FX",        0,    221.84,         0,           0,            0, "1% Drawdown Fee - Draw 2"),
    ("2025-12-18", "LD",        0,         0,         0,           0,       221.84, "Drawdown Fee Financed by Loan"),
    ("2025-12-18", "PRE",  221.84,    221.84,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2026-01-14", "LD",        0,         0,         0,           0,    24636.66, "ACH Disbursement - Draw 3"),
    ("2026-01-14", "FX",        0,    248.86,         0,           0,            0, "1% Drawdown Fee - Draw 3"),
    ("2026-01-14", "LD",        0,         0,         0,           0,       248.86, "Drawdown Fee Financed by Loan"),
    ("2026-01-14", "PRE",  248.86,    248.86,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2026-01-15", "AT", 19255.71,         0,    127.00,    19128.71,            0, "ACH Payment"),
    ("2026-01-21", "AT", 22208.09,         0,     23.46,    22184.63,            0, "ACH Payment"),
    ("2026-02-12", "LD",        0,         0,         0,           0,    13987.84, "ACH Disbursement - Draw 4"),
    ("2026-02-12", "FX",        0,    141.29,         0,           0,            0, "1% Drawdown Fee - Draw 4"),
    ("2026-02-12", "LD",        0,         0,         0,           0,       141.29, "Drawdown Fee Financed by Loan"),
    ("2026-02-12", "PRE",  141.29,    141.29,         0,           0,            0, "Drawdown Fee Paid by Loan"),
    ("2026-03-10", "LD",        0,         0,         0,           0,     8455.44, "ACH Disbursement - Draw 5"),
    ("2026-03-10", "FX",        0,     85.40,         0,           0,            0, "1% Drawdown Fee - Draw 5"),
    ("2026-03-10", "LD",        0,         0,         0,           0,        85.40, "Drawdown Fee Financed by Loan"),
    ("2026-03-10", "PRE",   85.40,     85.40,         0,           0,            0, "Drawdown Fee Paid by Loan"),
]


def make_loan(db, name, lender, fund, cap, close_date, maturity_date, rate, last_balance,
              interest_balance, fee_balance, project_label, transactions):
    """Drop+recreate a per-loan record with full transaction history."""
    existing = db.scalar(select(Loan).where(Loan.name == name))
    if existing:
        for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == existing.id)).all():
            db.delete(p)
        db.delete(existing)
        db.flush()

    loan = Loan(
        name=name,
        lender=lender,
        loan_type="line_of_credit",
        account_last4=None,
        principal_original=cap,
        principal_current=last_balance,
        interest_rate_apr=rate,
        payment_amount=0.0,
        payment_frequency="irregular",
        origination_date=close_date,
        maturity_date=maturity_date,
        description_match="BOC CAPITAL",
        notes="",   # populated below
        is_active=last_balance > 0,
    )
    db.add(loan)
    db.flush()

    # Create LoanPayments. Only the meaningful events (not duplicate accounting entries):
    # - LD with disbursement > 0 (cash to me — book as draw with negative principal)
    # - PRE that pays the 1% fee (book as fee-only)
    # - AT/PM ACH Payment (book as principal payment with int + fee splits)
    sum_disbursed = 0.0
    sum_amt_paid = 0.0
    sum_fee_paid = 0.0
    sum_int_paid = 0.0
    sum_prin_paid = 0.0

    for (d_iso, code, amt_paid, fee_paid, int_paid, prin_paid, disbursement, comment) in transactions:
        d = date.fromisoformat(d_iso)
        if code == "LD" and disbursement > 0:
            # Loan disbursement - cash either hits Chase 6611 (ACH) or finances a fee
            sum_disbursed += disbursement
            # ACH disbursements link to bank tx. Fee-financing LDs are bookkeeping only.
            is_ach = "ACH Disbursement" in comment
            bank_tx_id = None
            if is_ach:
                # Try to find matching Chase 6611 BankTransaction
                tx = db.scalar(
                    select(BankTransaction).where(
                        BankTransaction.amount.between(disbursement - 0.5, disbursement + 0.5),
                        BankTransaction.posted_date.between(
                            date(d.year, d.month, max(1, d.day - 5)),
                            date(d.year, d.month, min(28, d.day + 5)) if d.day < 28 else d,
                        ),
                        BankTransaction.account_id == "Chase6611_Activity_20260220",
                    ).limit(1)
                )
                # broader fallback
                if not tx:
                    tx = db.scalar(
                        select(BankTransaction).where(
                            BankTransaction.amount.between(disbursement - 0.5, disbursement + 0.5),
                            BankTransaction.account_id == "Chase6611_Activity_20260220",
                        ).order_by(BankTransaction.posted_date.asc()).limit(1)
                    )
                if tx:
                    bank_tx_id = tx.id
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=d,
                total_amount=-disbursement,        # draw (cash IN to me)
                principal_amount=-disbursement,
                interest_amount=0.0,
                fees_amount=0.0,
                bank_transaction_id=bank_tx_id,
                notes=f"{name}: {comment}" + (" (linked to Chase 6611 row)" if bank_tx_id else ""),
            ))
        elif code == "PRE":
            # Pre-paid fee — book the fee_paid amount
            if fee_paid > 0:
                sum_fee_paid += fee_paid
                db.add(LoanPayment(
                    loan_id=loan.id,
                    payment_date=d,
                    total_amount=fee_paid,
                    principal_amount=0.0,
                    interest_amount=0.0,
                    fees_amount=fee_paid,
                    bank_transaction_id=None,
                    notes=f"{name}: {comment}",
                ))
        elif code in ("AT", "PM"):
            # ACH Payment from DACA — book as principal repayment + interest + fee
            sum_amt_paid += amt_paid
            sum_fee_paid += fee_paid
            sum_int_paid += int_paid
            sum_prin_paid += prin_paid
            db.add(LoanPayment(
                loan_id=loan.id,
                payment_date=d,
                total_amount=amt_paid,
                principal_amount=prin_paid,
                interest_amount=int_paid,
                fees_amount=fee_paid,
                bank_transaction_id=None,    # this is a DACA event, not visible in our bank data
                notes=f"{name}: {comment} (DACA-internal, paid by client)",
            ))
        elif code == "AI":
            # Accrued interest — not yet paid, reflected in interest_balance only
            pass
        # FX entries are accounting events, not real cash; skip them
        # LD without disbursement (fee-financing) skip too

    loan.notes = (
        f"BOC loan {name.split('(')[-1].rstrip(')')} for project {project_label}. "
        f"Lender: {lender} ({fund}), facility cap ${cap:,.0f} at {rate*100:.1f}% APR. "
        f"Lifetime: ${sum_disbursed:,.2f} disbursed; client paid ${sum_amt_paid:,.2f} into DACA, "
        f"of which BOC took principal ${sum_prin_paid:,.2f} + interest ${sum_int_paid:,.2f} + "
        f"in-payment fees ${sum_fee_paid - 510 if sum_fee_paid > 510 else sum_fee_paid:,.2f}. "
        f"Outstanding principal balance: ${last_balance:,.2f}. "
        f"Accrued interest balance: ${interest_balance:,.2f}. "
        f"Outstanding fee balance: ${fee_balance:,.2f}."
    )
    db.commit()
    print(f"  Loan {name}: disbursed ${sum_disbursed:,.2f}, paid ${sum_amt_paid:,.2f}, "
          f"fees ${sum_fee_paid:,.2f}, interest ${sum_int_paid:,.2f}, "
          f"prin paid ${sum_prin_paid:,.2f}, current ${last_balance:,.2f}")
    return loan


def main() -> None:
    db = SessionLocal()
    try:
        # Drop the imputed combined BOC loan first
        old = db.scalar(select(Loan).where(Loan.name == "BOC Capital Factoring Facility"))
        if old:
            for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == old.id)).all():
                db.delete(p)
            db.delete(old)
            db.flush()
            print("Deleted old combined 'BOC Capital Factoring Facility' loan + payments.")

        print()
        print("Importing actual BOC loan transaction histories...")
        make_loan(
            db=db,
            name="BOC Capital - LTCP4 (Loan 2506-5)",
            lender="BOC Capital CDFI - OFN/GWG1",
            fund="OFN/GWG1",
            cap=75000.0,
            close_date=date(2025, 6, 11),
            maturity_date=date(2026, 6, 11),
            rate=0.030,
            last_balance=45070.21,
            interest_balance=83.49,
            fee_balance=0.0,
            project_label="LTCP4 (HDR)",
            transactions=LOAN_2506_5_TXNS,
        )
        make_loan(
            db=db,
            name="BOC Capital - BWT (Loan 2509-10)",
            lender="BOC Capital CDFI - NYC EDC ECFLF",
            fund="ECFLF01",
            cap=100000.0,
            close_date=date(2025, 9, 22),
            maturity_date=date(2026, 9, 22),
            rate=0.030,
            last_balance=48055.49,
            interest_balance=130.34,
            fee_balance=85.40,
            project_label="BWT Design Assistance (Stantec + Brown & Caldwell)",
            transactions=LOAN_2509_10_TXNS,
        )

        # Mt Vernon placeholder — no documented draws yet
        existing_mv = db.scalar(select(Loan).where(Loan.name == "BOC Capital - Mount Vernon (Loan TBD)"))
        if existing_mv:
            for p in db.scalars(select(LoanPayment).where(LoanPayment.loan_id == existing_mv.id)).all():
                db.delete(p)
            db.delete(existing_mv)
            db.flush()
        mv = Loan(
            name="BOC Capital - Mount Vernon (Loan TBD)",
            lender="BOC Capital CDFI",
            loan_type="line_of_credit",
            account_last4=None,
            principal_original=60000.0,
            principal_current=0.0,
            interest_rate_apr=0.030,
            payment_amount=0.0,
            payment_frequency="irregular",
            origination_date=None,
            maturity_date=None,
            description_match="BOC CAPITAL",
            notes=(
                "BOC facility for Mount Vernon Flood Study (Woodard & Curran). "
                "Cap $60,000 at 3.0% APR. No draws documented yet — request transaction "
                "history from BOC if any draws have occurred. There may be additional "
                "BOC ACH inflows on Chase 6611 not yet matched to a loan number "
                "(e.g. $2,749.48 on 2026-01-20 and $13,565.47 on 2026-02-13 are "
                "unaccounted for in 2506-5 + 2509-10)."
            ),
            is_active=True,
        )
        db.add(mv)
        db.commit()
        print(f"  Created Mt Vernon placeholder (loan id={mv.id}, $0 outstanding).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
