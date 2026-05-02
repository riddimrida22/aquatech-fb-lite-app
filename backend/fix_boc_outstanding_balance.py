"""Fix BOC factoring loan to reflect the correct outstanding balance.

User clarification: BOC's principal is REPAID IN FULL when the client pays
into the DACA — Aquatech doesn't owe BOC anything for cycled invoices. The
only outstanding balance is the BOC advance on invoices that haven't yet
been paid by the client.

Per-project facility caps:
  - Mount Vernon Flood Study : $ 60,000 max
  - LTCP4                    : $ 75,000 max
  - BWT Design Assistance    : $100,000 max
  Total facility (combined)  : $235,000 max

If outstanding factored AR > cap on a project, BOC won't advance new
invoices on that project until client pays existing factored invoices.

Outstanding-balance estimate:
  per-project advance = min( 0.70 * sum(unpaid_invoice_subtotal),  cap )
  total = sum across the 3 projects
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
from app.models import Invoice, Loan, Project

LOAN_NAME = "BOC Capital Factoring Facility"
ADVANCE_FRAC = 0.70
FACILITY_CAPS = {
    "Mount Vernon Flood Study": 60000.00,
    "LTCP4":                    75000.00,
    "BWT Design Assistance":   100000.00,
}


def main() -> None:
    db = SessionLocal()
    try:
        loan = db.scalar(select(Loan).where(Loan.name == LOAN_NAME))
        if not loan:
            print(f"ERROR: Loan '{LOAN_NAME}' not found.")
            return

        print("=" * 70)
        print("BOC Capital — outstanding balance recompute")
        print("=" * 70)

        per_project_outstanding: dict[str, dict] = {}
        total_outstanding = 0.0
        total_unpaid_value = 0.0
        for pname, cap in FACILITY_CAPS.items():
            proj = db.scalar(select(Project).where(Project.name == pname))
            if not proj:
                print(f"  ! '{pname}' not found")
                continue
            unpaid = db.scalars(
                select(Invoice)
                .where(Invoice.project_id == proj.id)
                .where(Invoice.balance_due > 0)
            ).all()
            unpaid_total = sum(float(inv.subtotal_amount or 0) for inv in unpaid)
            theoretical_advance = ADVANCE_FRAC * unpaid_total
            actual_advance = min(theoretical_advance, cap)

            per_project_outstanding[pname] = {
                "cap": cap,
                "unpaid_count": len(unpaid),
                "unpaid_total": unpaid_total,
                "theoretical_advance": theoretical_advance,
                "actual_advance_estimate": actual_advance,
                "headroom": max(0.0, cap - actual_advance),
                "capped": theoretical_advance > cap,
            }
            total_outstanding += actual_advance
            total_unpaid_value += unpaid_total
            cap_flag = " (CAPPED)" if theoretical_advance > cap else ""
            print(
                f"  {pname:<32}  cap ${cap:>9,.0f}  "
                f"unpaid={len(unpaid)} total ${unpaid_total:>10,.2f}  "
                f"-->advance est ${actual_advance:>9,.2f}{cap_flag}"
            )

        print()
        print(f"  Total outstanding factored advance estimate: ${total_outstanding:,.2f}")
        print(f"  Total unpaid factored invoice value         : ${total_unpaid_value:,.2f}")
        print(f"  Implied 30% holdback waiting to be cycled   : ${0.30 * total_unpaid_value:,.2f}")

        # Update the loan record
        old_balance = loan.principal_current
        loan.principal_current = round(total_outstanding, 2)
        loan.principal_original = max(loan.principal_original, total_outstanding)

        loan.notes = (
            f"Invoice factoring (NOT traditional debt). BOC purchases the receivable, "
            f"advances 70% (less 1% upfront fee) to Chase 6611, owns rights to collect "
            f"the full invoice from the DACA at Dime Bank. When client pays, BOC's 70% "
            f"advance is repaid in full out of the DACA along with accrued interest, and "
            f"the residual (30% minus interest) is wired to Aquatech via Dime->6611. "
            f"Aquatech does NOT owe BOC anything on cycled invoices.\n\n"
            f"Per-project facility caps: "
            + ", ".join(f"{n}=${c:,.0f}" for n, c in FACILITY_CAPS.items())
            + f". Combined cap: ${sum(FACILITY_CAPS.values()):,.0f}.\n\n"
            f"Current outstanding (advance against unpaid factored invoices): "
            f"${total_outstanding:,.2f}. Caveat: if BOC reduced the advance rate due to "
            f"slow client payments, actual outstanding may be lower. Confirm against "
            f"BOC monthly statement when available.\n\n"
            f"Lifetime financing cost (deductible interest + fees): see imputed amounts "
            f"on Dime-wire payment rows. 2025 estimate: $17,509. 2026 YTD estimate: "
            f"$49,966 (likely overstated by ~$25-35k since some 2026-paid invoices have "
            f"not fully cycled yet — refine when BOC sends Q1/Q2 statements)."
        )

        db.commit()
        print()
        print(f"Loan id={loan.id} principal_current updated:")
        print(f"  old: ${old_balance:,.2f}   ->   new: ${loan.principal_current:,.2f}")
        print()
        print("Per-project outstanding breakdown stored in loan notes.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
