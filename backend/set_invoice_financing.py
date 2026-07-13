"""Add invoice financing columns + set the currently-financed invoices.

Data-driven replacement for the old hardcoded BOC_FINANCED tuple in main.py.
Right now only WSMV009 (Mount Vernon Flood Study) is BOC-financed at 70%
(per Bertrand 2026-07). Re-run and edit FINANCED as invoices are financed/settled.

    docker exec aquatechpm_backend_1 python set_invoice_financing.py          # preview
    docker exec aquatechpm_backend_1 python set_invoice_financing.py --apply  # commit
"""
import sys
from sqlalchemy import inspect, text

from app.db import SessionLocal, engine
from app.models import Invoice

# invoice_number -> (financed_pct, source)
FINANCED: dict[str, tuple[float, str]] = {
    "WSMV009": (0.70, "BOC"),
}


def ensure_columns() -> None:
    cols = {c["name"] for c in inspect(engine).get_columns("invoices")}
    with engine.begin() as conn:
        if "financed_pct" not in cols:
            conn.execute(text("ALTER TABLE invoices ADD COLUMN financed_pct FLOAT DEFAULT 0.0"))
            print("added column invoices.financed_pct")
        if "financed_source" not in cols:
            conn.execute(text("ALTER TABLE invoices ADD COLUMN financed_source VARCHAR(64) DEFAULT ''"))
            print("added column invoices.financed_source")


def main() -> None:
    apply = "--apply" in sys.argv[1:]
    ensure_columns()
    with SessionLocal() as db:
        # reset everything, then set the current financed set (single source of truth)
        db.query(Invoice).filter(Invoice.financed_pct != 0.0).update(
            {Invoice.financed_pct: 0.0, Invoice.financed_source: ""}
        )
        report: list[str] = []
        for num, (pct, src) in FINANCED.items():
            inv = db.query(Invoice).filter(Invoice.invoice_number == num).first()
            if not inv:
                report.append(f"  ! {num}: NOT FOUND")
                continue
            # Tag only. The app already imports the factoring as a payment from
            # FreshBooks, so amount_paid/balance_due are ALREADY the true net — we do
            # NOT touch them. financed_pct is metadata for the "70% advanced" badge
            # and to keep the advance out of client revenue.
            inv.financed_pct = pct
            inv.financed_source = src
            adv = round((inv.subtotal_amount or 0.0) * pct, 2)
            report.append(
                f"  {num}: tagged {int(pct*100)}% {src} (advance ~${adv:,.2f}); "
                f"balance already ${float(inv.balance_due or 0):,.2f} (unchanged)"
            )
        print(("APPLIED" if apply else "DRY-RUN") + " financing set:")
        print("\n".join(report))
        if apply:
            db.commit()
            print("committed.")
        else:
            db.rollback()
            print("\n(dry-run — re-run with --apply to commit)")


if __name__ == "__main__":
    main()
