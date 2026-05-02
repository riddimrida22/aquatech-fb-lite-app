"""Add `source` + `external_id` provenance columns to operational tables (idempotent).

Tables touched:
  - invoices            : source, external_id
  - bank_transactions   : source
  - project_expenses    : source, external_id

Backfill: every existing row gets source='csv' (representing pre-API-era data).
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

from sqlalchemy import inspect, text
from app.db import engine


def column_exists(table: str, column: str) -> bool:
    insp = inspect(engine)
    return any(c["name"] == column for c in insp.get_columns(table))


def main() -> None:
    work: list[tuple[str, str, str, str]] = [
        # (table, column, ddl_type, default_for_existing)
        ("invoices",          "source",      "VARCHAR(32) NOT NULL DEFAULT 'csv'",   "csv"),
        ("invoices",          "external_id", "VARCHAR(128)",                          None),
        ("bank_transactions", "source",      "VARCHAR(32) NOT NULL DEFAULT 'csv'",   "csv"),
        ("project_expenses",  "source",      "VARCHAR(32) NOT NULL DEFAULT 'csv'",   "csv"),
        ("project_expenses",  "external_id", "VARCHAR(128)",                          None),
    ]

    with engine.begin() as conn:
        for table, column, ddl, default in work:
            if column_exists(table, column):
                print(f"  {table}.{column} already exists; skipping ALTER.")
                continue
            print(f"  Adding {table}.{column} ({ddl})")
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))

        # Index source columns for fast filtering
        for table in ("invoices", "bank_transactions", "project_expenses"):
            idx_name = f"ix_{table}_source"
            try:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table}(source)"))
            except Exception as e:
                print(f"  ! could not create {idx_name}: {e}")

    # Verification
    print()
    print("Final column check:")
    for table, column, _, _ in work:
        ok = column_exists(table, column)
        print(f"  {table}.{column}: {'OK' if ok else 'MISSING'}")


if __name__ == "__main__":
    main()
