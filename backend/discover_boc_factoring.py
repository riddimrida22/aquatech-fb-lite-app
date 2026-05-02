"""Discover BOC Capital invoice-factoring activity from bank data and invoices.

Setup as described by user:
  Aquatech invoices client (HDR / Stantec+B&C / Woodard&Curran) on
  Mount Vernon Flood / BWT / LTCP projects.

  BOC Capital advances 70% of invoice, less 1% fee, to Chase 6611.
    Net advance = 70% * invoice - 1% * invoice = 69% * invoice
  Client pays 100% of invoice to DACA at Dime Bank (out of our visibility).
  BOC takes 30% holdback - interest_for_period; remainder hits Aquatech's
    Dime account, which the user then wires/Zelles to Chase 6611.

  Net cash to Aquatech per invoice:
    advance(69%) + holdback_residual(<30% - interest)  =  100% - 1%fee - interest
  Total financing cost = 1% * invoice + interest_for_period

This script is read-only — it surfaces the candidate transactions so we can
review and verify before booking a Loan + LoanPayments.
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
from app.models import BankTransaction, Invoice, Project

# Patterns we expect to see for BOC + Dime activity
BOC_RE = re.compile(r"BOC|BOC CAPITAL|BOC FACTORING", re.IGNORECASE)
DIME_RE = re.compile(r"DIME|DIME BANK|DIME COMM|DIMECB", re.IGNORECASE)
WIRE_ZELLE_RE = re.compile(r"WIRE|ZELLE|REAL TIME|REAL TIME PAYMENT", re.IGNORECASE)

PROJECT_NAMES = ["Mount Vernon Flood Study", "BWT Design Assistance", "LTCP4"]
CHASE_6611 = "Chase6611_Activity_20260220"


def main() -> None:
    db = SessionLocal()
    try:
        # 1. Find the 3 projects + their invoices
        print("=" * 80)
        print("INVOICES on Mount Vernon Flood Study / BWT Design Assistance / LTCP4")
        print("=" * 80)
        invoice_total = 0.0
        invoice_paid_total = 0.0
        invoice_data: list[dict] = []
        for pname in PROJECT_NAMES:
            proj = db.scalar(select(Project).where(Project.name == pname))
            if not proj:
                print(f"  ! project not found: {pname}")
                continue
            invs = db.scalars(
                select(Invoice).where(Invoice.project_id == proj.id).order_by(Invoice.issue_date.asc())
            ).all()
            print(f"\n  -- {pname} (id={proj.id}, client={proj.client_name}) — {len(invs)} invoices --")
            for inv in invs:
                invoice_total += inv.subtotal_amount or 0
                invoice_paid_total += inv.amount_paid or 0
                invoice_data.append({
                    "project": pname,
                    "invoice_number": inv.invoice_number,
                    "client": inv.client_name,
                    "issue_date": inv.issue_date,
                    "paid_date": inv.paid_date,
                    "subtotal": inv.subtotal_amount,
                    "amount_paid": inv.amount_paid,
                    "balance_due": inv.balance_due,
                    "status": inv.status,
                })
                print(
                    f"    {inv.invoice_number:<14} {str(inv.issue_date):<11} "
                    f"paid={str(inv.paid_date or '—'):<11} "
                    f"sub=${(inv.subtotal_amount or 0):>10,.2f} "
                    f"paid=${(inv.amount_paid or 0):>10,.2f} "
                    f"bal=${(inv.balance_due or 0):>10,.2f} "
                    f"{inv.status}"
                )
        print(f"\n  Total invoiced on these 3 projects: ${invoice_total:>10,.2f}")
        print(f"  Total paid                         : ${invoice_paid_total:>10,.2f}")

        # 2. Look for BOC-named transactions in any account
        print()
        print("=" * 80)
        print("BANK TRANSACTIONS mentioning BOC")
        print("=" * 80)
        boc_rows = []
        all_txns = db.scalars(select(BankTransaction).order_by(BankTransaction.posted_date.asc())).all()
        for tx in all_txns:
            blob = f"{tx.name or ''} {tx.merchant_name or ''}"
            if BOC_RE.search(blob):
                boc_rows.append(tx)
        for tx in boc_rows:
            sign = "IN " if (tx.amount or 0) > 0 else "OUT"
            print(f"  {tx.posted_date}  {sign}  ${abs(tx.amount or 0):>10,.2f}  acct={tx.account_id[:24]:<24}  {(tx.name or '')[:90]}")
        print(f"  Total BOC rows: {len(boc_rows)}")
        boc_in = sum((t.amount or 0) for t in boc_rows if (t.amount or 0) > 0)
        boc_out = sum((t.amount or 0) for t in boc_rows if (t.amount or 0) < 0)
        print(f"  IN total : ${boc_in:>10,.2f}")
        print(f"  OUT total: ${abs(boc_out):>10,.2f}")

        # 3. Look for Dime / wire / Zelle inflows on Chase 6611 — candidate holdback receipts
        print()
        print("=" * 80)
        print("CHASE 6611 INFLOWS that look like wires/Zelle (likely Dime->6611 holdback)")
        print("=" * 80)
        dime_candidates = []
        for tx in all_txns:
            if tx.account_id != CHASE_6611:
                continue
            if (tx.amount or 0) <= 0:
                continue  # only inflows
            blob = f"{tx.name or ''} {tx.merchant_name or ''}"
            if DIME_RE.search(blob) or WIRE_ZELLE_RE.search(blob):
                dime_candidates.append(tx)
        # Sort by amount desc to see the big ones first
        dime_candidates.sort(key=lambda t: -(t.amount or 0))
        for tx in dime_candidates[:80]:
            print(f"  {tx.posted_date}  IN   ${(tx.amount or 0):>10,.2f}  {(tx.name or '')[:130]}")
        if len(dime_candidates) > 80:
            print(f"  ... {len(dime_candidates) - 80} more")
        print(f"  Total wire/Zelle/Real-Time inflow rows: {len(dime_candidates)}")
        print(f"  Total amount: ${sum((t.amount or 0) for t in dime_candidates):>12,.2f}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
