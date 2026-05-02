"""Flip the moonlight / personal-tracking projects to is_overhead=True so they
stop polluting portfolio KPIs (active projects, total revenue, total margin),
while preserving all historical time entries.

Currently flipping:
  - Project 8: 'CAVALRY JOB' (client: PABLO RODRIGUEZ)
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
from app.models import Project

PROJECT_IDS_TO_FLAG = [8]  # CAVALRY JOB / Pablo Rodriguez


def main() -> None:
    db = SessionLocal()
    try:
        for pid in PROJECT_IDS_TO_FLAG:
            p = db.scalar(select(Project).where(Project.id == pid))
            if not p:
                print(f"  ! project {pid} not found")
                continue
            print(f"Project {pid}: '{p.name}' (client={p.client_name})")
            print(f"  before: is_overhead={p.is_overhead}  is_billable={p.is_billable}  is_active={p.is_active}")
            p.is_overhead = True
            p.is_billable = False
            # Keep is_active so it still shows under the All filter, just out of delivery KPIs.
            print(f"  after : is_overhead={p.is_overhead}  is_billable={p.is_billable}  is_active={p.is_active}")
        db.commit()
        print()
        print("Done. These projects are now treated as overhead (excluded from delivery KPIs).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
