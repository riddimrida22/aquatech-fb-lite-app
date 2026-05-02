"""Create loans + loan_payments tables (idempotent)."""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from sqlalchemy import inspect
from app.db import engine
from app.models import Loan, LoanPayment


def main() -> None:
    insp = inspect(engine)
    created: list[str] = []
    for cls in (Loan, LoanPayment):
        if cls.__tablename__ not in insp.get_table_names():
            print(f"Creating table {cls.__tablename__}")
            cls.__table__.create(engine)
            created.append(cls.__tablename__)
        else:
            print(f"Table {cls.__tablename__} already exists; skipping.")
    if created:
        print(f"Created: {created}")
    else:
        print("All tables already present.")


if __name__ == "__main__":
    main()
