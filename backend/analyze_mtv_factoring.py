"""Match Mount Vernon invoices to BOC advances and Dime/Zelle holdback wires.

User context:
  - ALL Mt Vernon invoices have been factored through BOC
  - Only the last 3 invoices are still unpaid
  - There are unaccounted BOC inflows of $2,749.48 (2026-01-20) and $13,565.47 (2026-02-13)
    in Chase 6611 that don't match LTCP (2506-5) or BWT (2509-10) loans
"""
from __future__ import annotations
import os
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

CHASE_6611 = "Chase6611_Activity_20260220"

# Per the BOC PDFs, these are the LTCP draws (loan 2506-5)
LTCP_DRAW_AMOUNTS = [
    43640.82, 19449.05, 27706.15, 23664.54, 16976.12,
    18369.43, 14498.33, 10855.71, 18746.85,
]
# These are the BWT draws (loan 2509-10)
BWT_DRAW_AMOUNTS = [
    18937.42, 21962.79, 24636.66, 13987.84, 8455.44,
]


def main() -> None:
    db = SessionLocal()
    try:
        # 1. Mount Vernon invoices
        proj = db.scalar(select(Project).where(Project.name == "Mount Vernon Flood Study"))
        print("=" * 76)
        print(f"MOUNT VERNON FLOOD STUDY — project id={proj.id if proj else 'MISSING'}")
        print("=" * 76)
        if proj:
            invs = db.scalars(
                select(Invoice).where(Invoice.project_id == proj.id).order_by(Invoice.issue_date.asc())
            ).all()
            print(f"  {len(invs)} invoices on file:")
            for inv in invs:
                print(
                    f"    {inv.invoice_number:<18} issued {str(inv.issue_date):<11} "
                    f"paid={str(inv.paid_date or '—'):<11} "
                    f"sub=${(inv.subtotal_amount or 0):>10,.2f} "
                    f"paid=${(inv.amount_paid or 0):>10,.2f} bal=${(inv.balance_due or 0):>10,.2f} "
                    f"{inv.status}"
                )
        print()

        # 2. Search invoices that look like Mt Vernon by client name
        print("Invoices with 'Mount Vernon' or W&C in client / project_id...")
        wc_invs = db.scalars(
            select(Invoice).where(
                (Invoice.client_name.ilike("%Mount Vernon%"))
                | (Invoice.client_name.ilike("%Woodard%Curran%"))
            ).order_by(Invoice.issue_date.asc())
        ).all()
        print(f"  Found {len(wc_invs)} invoices via client-name search")
        for inv in wc_invs:
            print(
                f"    [{inv.project_id}] {inv.invoice_number:<18} {str(inv.issue_date):<11} "
                f"client={(inv.client_name or '')[:30]:<30} "
                f"sub=${(inv.subtotal_amount or 0):>10,.2f} paid=${(inv.amount_paid or 0):>10,.2f} {inv.status}"
            )
        print()

        # 3. All BOC ACH IN to Chase 6611 — check which are already mapped to loans
        boc_ach = db.scalars(
            select(BankTransaction)
            .where(BankTransaction.account_id == CHASE_6611)
            .where(BankTransaction.amount > 0)
            .order_by(BankTransaction.posted_date.asc())
        ).all()
        boc_ach = [
            t for t in boc_ach
            if "BOC CAPITAL" in (t.name or "").upper()
        ]

        # Build a set of bank_transaction_ids already linked to ANY LoanPayment
        linked_tx_ids = set()
        for p in db.scalars(select(LoanPayment).where(LoanPayment.bank_transaction_id.isnot(None))).all():
            linked_tx_ids.add(p.bank_transaction_id)

        print("=" * 76)
        print("BOC ACH disbursements to Chase 6611 (with loan-mapping status)")
        print("=" * 76)
        for tx in boc_ach:
            amt = float(tx.amount or 0)
            # classify
            if any(abs(amt - d) < 1.0 for d in LTCP_DRAW_AMOUNTS):
                tag = "LTCP (2506-5)"
            elif any(abs(amt - d) < 1.0 for d in BWT_DRAW_AMOUNTS):
                tag = "BWT (2509-10)"
            else:
                tag = "??? UNACCOUNTED"
            mapped = "linked" if tx.id in linked_tx_ids else "UNLINKED"
            print(f"  {tx.posted_date}  ${amt:>10,.2f}  {tag:<22}  {mapped}")
        print()

        # 4. Suspicious inflows that could be Mt Vernon BOC if NO project has it yet
        unaccounted = [
            t for t in boc_ach
            if not any(abs(float(t.amount or 0) - d) < 1.0 for d in LTCP_DRAW_AMOUNTS)
            and not any(abs(float(t.amount or 0) - d) < 1.0 for d in BWT_DRAW_AMOUNTS)
        ]
        print(f"UNACCOUNTED BOC inflows ({len(unaccounted)}):")
        sum_unacc = 0.0
        for tx in unaccounted:
            amt = float(tx.amount or 0)
            sum_unacc += amt
            print(f"  {tx.posted_date}  ${amt:>10,.2f}  {(tx.name or '')[:90]}")
        print(f"  Total unaccounted: ${sum_unacc:,.2f}")
        print()

        # 5. Total invoiced on Mt Vernon for cross-check
        if wc_invs:
            mv_total = sum(float(i.subtotal_amount or 0) for i in wc_invs)
            mv_paid = sum(float(i.amount_paid or 0) for i in wc_invs)
            mv_unpaid = mv_total - mv_paid
            print(f"Mt Vernon (Woodard & Curran) invoice context:")
            print(f"  Total invoiced: ${mv_total:>11,.2f}")
            print(f"  Total paid    : ${mv_paid:>11,.2f}")
            print(f"  Unpaid        : ${mv_unpaid:>11,.2f}")
            print(f"  Expected BOC advance @ 70%: ${0.70 * mv_total:>11,.2f}")
            print(f"  Sum of unaccounted BOC ACH: ${sum_unacc:>11,.2f}")

        # 6. Look for Dime / Zelle / wire inflows that haven't been mapped yet
        print()
        print("=" * 76)
        print("Chase 6611 inflows that look like wire/Zelle from Dime or self (holdback candidates)")
        print("=" * 76)
        candidates = db.scalars(
            select(BankTransaction)
            .where(BankTransaction.account_id == CHASE_6611)
            .where(BankTransaction.amount > 0)
            .order_by(BankTransaction.posted_date.asc())
        ).all()
        candidates = [
            t for t in candidates
            if "BOC CAPITAL" not in (t.name or "").upper()  # exclude direct BOC
            and ("DIME" in (t.name or "").upper()
                 or "ZELLE" in (t.name or "").upper()
                 or "BERTRANDALBERT" in (t.name or "").upper()
                 or "B BYRNE" in (t.name or "").upper()
                 or "FEDWIRE" in (t.name or "").upper())
        ]
        # exclude Fundbox
        candidates = [t for t in candidates if "FUNDBOX" not in (t.name or "").upper()]
        for tx in candidates[:80]:
            amt = float(tx.amount or 0)
            print(f"  {tx.posted_date}  ${amt:>10,.2f}  {(tx.name or '')[:120]}")
        print(f"  Total: ${sum(t.amount or 0 for t in candidates):,.2f}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
