"""One-shot migration: copy data from SQLite → Postgres.

Source: SQLite file at $SQLITE_PATH (default: ./backend/aquatech.db)
Target: Postgres at $POSTGRES_URL (default: postgres compose service)

Steps:
  1. Connect to Postgres, drop & recreate all tables via SQLAlchemy metadata
  2. For each table in dependency order (created_order from metadata.sorted_tables),
     SELECT * FROM SQLite, bulk-insert into Postgres with the same primary keys.
  3. After bulk insert, reset Postgres sequences for serial columns so future
     INSERTs don't collide with copied IDs.

Run from project root via WSL:
  SQLITE_PATH=/tmp/aquatech_dev/aquatech.db \
  POSTGRES_URL=postgresql+psycopg://postgres:CHANGE_ME_DB_PASSWORD@localhost:5432/fblite \
  .env_py/bin/python backend/migrate_sqlite_to_postgres.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Make backend.app importable
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

# Set env BEFORE importing app (so settings picks up POSTGRES_URL when imported)
SQLITE_PATH = os.environ.get(
    "SQLITE_PATH",
    str((Path(__file__).parent / "aquatech.db").resolve()),
)
POSTGRES_URL = os.environ.get(
    "POSTGRES_URL",
    "postgresql+psycopg://postgres:CHANGE_ME_DB_PASSWORD@localhost:5432/fblite",
)
os.environ["DATABASE_URL"] = POSTGRES_URL
os.environ.setdefault("DEV_AUTH_BYPASS", "true")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")

from sqlalchemy import create_engine, MetaData, text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

# Import models AFTER setting env so models pick up correct DB
from app import models  # noqa: F401, E402
from app.database import Base  # noqa: E402

print(f"Source SQLite : {SQLITE_PATH}")
print(f"Target Postgres: {POSTGRES_URL}")
print("=" * 72)

# ---- Source: SQLite ----
src_engine = create_engine(f"sqlite:///{SQLITE_PATH}")
src_meta = MetaData()
src_meta.reflect(bind=src_engine)
print(f"Source tables ({len(src_meta.tables)}):")
for name in sorted(src_meta.tables.keys()):
    n = src_engine.connect().execute(text(f"SELECT COUNT(*) FROM {name}")).scalar()
    print(f"  {name}: {n} rows")

# ---- Target: Postgres ----
print("\nConnecting to Postgres...")
dst_engine = create_engine(POSTGRES_URL, pool_pre_ping=True)
with dst_engine.connect() as conn:
    conn.execute(text("SELECT 1"))
    print("  Postgres connection OK")

# ---- Drop & recreate all tables in Postgres ----
print("\nDropping existing tables in Postgres (if any)...")
Base.metadata.drop_all(bind=dst_engine)
print("Creating fresh schema in Postgres...")
Base.metadata.create_all(bind=dst_engine)

# Sorted in dependency order (parents before children)
created_tables = Base.metadata.sorted_tables
print(f"Created {len(created_tables)} tables in dependency order")

# ---- Copy data table-by-table ----
print("\nCopying data...")
SrcSession = sessionmaker(bind=src_engine)
DstSession = sessionmaker(bind=dst_engine)

stats = {}
for table in created_tables:
    name = table.name
    if name not in src_meta.tables:
        print(f"  SKIP {name} (not in source SQLite)")
        continue
    src_table = src_meta.tables[name]
    with src_engine.connect() as sconn:
        rows = [dict(r._mapping) for r in sconn.execute(src_table.select())]
    if not rows:
        stats[name] = 0
        continue

    # Filter columns to those present in destination (handle schema drift)
    dst_cols = {c.name for c in table.columns}
    cleaned = []
    for r in rows:
        cleaned.append({k: v for k, v in r.items() if k in dst_cols})

    with dst_engine.begin() as dconn:
        dconn.execute(table.insert(), cleaned)
    stats[name] = len(cleaned)
    print(f"  {name}: {len(cleaned)} rows copied")

# ---- Reset Postgres sequences so future INSERTs don't collide with copied IDs ----
print("\nResetting Postgres sequences for serial columns...")
with dst_engine.begin() as conn:
    for table in created_tables:
        for col in table.columns:
            if col.primary_key and col.autoincrement:
                seq_name = f"{table.name}_{col.name}_seq"
                # Check sequence exists
                exists = conn.execute(
                    text(
                        "SELECT 1 FROM pg_class WHERE relname = :seq AND relkind = 'S'"
                    ),
                    {"seq": seq_name},
                ).scalar()
                if not exists:
                    continue
                max_id = conn.execute(
                    text(f"SELECT COALESCE(MAX({col.name}), 0) FROM {table.name}")
                ).scalar()
                next_id = (max_id or 0) + 1
                conn.execute(
                    text(f"ALTER SEQUENCE {seq_name} RESTART WITH {next_id}")
                )
                print(f"  {seq_name} -> {next_id}")

print("\n" + "=" * 72)
print(f"DONE. Migrated {sum(stats.values())} rows across {len(stats)} tables.")
