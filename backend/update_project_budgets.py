"""Update overall_budget_fee for the projects per user-provided figures."""
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
from app.models import Project

# user-provided figures
UPDATES = {
    "LTCP4":                       1286086.72,
    "BWT Design Assistance":        211000.00,
    "Hydraulic Modeling 4063001X":  311000.00,   # BEPA Modeling
    "Brentwood Brook":               50000.00,
    "Mount Vernon Flood Study":     200000.00,
}


def main() -> None:
    db = SessionLocal()
    try:
        print("Updating project budgets...")
        for name, fee in UPDATES.items():
            p = db.scalar(select(Project).where(Project.name == name))
            if not p:
                print(f"  ! '{name}' not found")
                continue
            old = p.overall_budget_fee or 0.0
            p.overall_budget_fee = fee
            print(f"  {p.id:>2}  {name:<40}  ${old:>12,.2f} -> ${fee:>12,.2f}")
        db.commit()

        print()
        print("Final active project budgets:")
        for p in db.scalars(select(Project).order_by(Project.id)).all():
            if p.is_active and not p.is_overhead:
                print(f"  {p.id:>2}  {p.name[:50]:<50}  ${p.overall_budget_fee:>12,.2f}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
