"""Add lifecycle_status + completed_date columns to projects (idempotent),
backfill from is_active, then flip the user-specified completed projects.
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

from sqlalchemy import inspect, select, text
from app.db import engine, SessionLocal
from app.models import Project

# Names exactly as they appear in the projects.name column.
COMPLETED_NAMES = [
    "AECOM SWPPP Proposal",
    "Renovation of Single Family",
    "White Plains SewerGEMS Model Review",
]


def main() -> None:
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("projects")}

    with engine.begin() as conn:
        if "lifecycle_status" not in cols:
            print("Adding column projects.lifecycle_status (TEXT NOT NULL DEFAULT 'active')")
            conn.execute(text(
                "ALTER TABLE projects ADD COLUMN lifecycle_status VARCHAR(32) NOT NULL DEFAULT 'active'"
            ))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_projects_lifecycle_status ON projects(lifecycle_status)"))
        else:
            print("Column lifecycle_status already exists; skipping ALTER.")

        if "completed_date" not in cols:
            print("Adding column projects.completed_date (DATE NULL)")
            conn.execute(text("ALTER TABLE projects ADD COLUMN completed_date DATE NULL"))
        else:
            print("Column completed_date already exists; skipping ALTER.")

    # Now do logical backfill via ORM
    db = SessionLocal()
    try:
        # Backfill: any inactive project -> 'completed' if status still 'active'
        for p in db.scalars(select(Project)).all():
            if not p.is_active and (p.lifecycle_status or "active") == "active":
                p.lifecycle_status = "completed"
                if p.end_date and not p.completed_date:
                    p.completed_date = p.end_date
                print(f"  backfill: {p.id} {p.name!r} -> completed")

        # Apply user-specified completions
        for nm in COMPLETED_NAMES:
            p = db.scalar(select(Project).where(Project.name == nm))
            if not p:
                print(f"  ! project '{nm}' not found")
                continue
            p.lifecycle_status = "completed"
            p.is_active = False
            if not p.completed_date:
                p.completed_date = p.end_date or date.today()
            print(f"  marked completed: {p.id} '{p.name}'  completed_date={p.completed_date}")
        db.commit()

        print()
        print("Final project lifecycle status:")
        for p in db.scalars(select(Project).order_by(Project.id)).all():
            print(f"  {p.id:>2} {p.name[:50]:<50}  status={p.lifecycle_status:<10}  active={p.is_active}  overhead={p.is_overhead}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
