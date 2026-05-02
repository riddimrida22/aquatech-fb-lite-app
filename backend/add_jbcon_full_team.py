"""Add all current Aquatech employees to project 13 (BWT-1608-JBCON) as Engineers,
preserving the existing Bertrand=Lead and Roger=QA/QC assignments.
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
from app.models import Project, ProjectMember, User

JBCON_ID = 13
DEFAULT_ROLE = "Engineer"


def main() -> None:
    db = SessionLocal()
    try:
        proj = db.scalar(select(Project).where(Project.id == JBCON_ID))
        if not proj:
            print(f"Project {JBCON_ID} not found")
            return
        print(f"Adding default-role members to project: {proj.name}")
        active_users = db.scalars(
            select(User).where(User.is_active.is_(True)).order_by(User.id)
        ).all()
        added = 0
        skipped: list[str] = []
        for u in active_users:
            # Skip if user already has any role on this project
            existing_any = db.scalar(
                select(ProjectMember).where(
                    ProjectMember.project_id == JBCON_ID,
                    ProjectMember.user_id == u.id,
                )
            )
            if existing_any:
                skipped.append(f"{u.full_name} (already has role: {existing_any.role})")
                continue
            db.add(ProjectMember(
                project_id=JBCON_ID,
                user_id=u.id,
                role=DEFAULT_ROLE,
                allocation_pct=0.0,
                start_date=proj.start_date,
                end_date=proj.end_date,
                notes="Initial JBCON roster — adjust role as needed",
            ))
            added += 1
            print(f"  + {u.full_name} -> {DEFAULT_ROLE}")
        db.commit()

        print()
        print(f"Added {added} new member(s); skipped {len(skipped)} (already on team):")
        for s in skipped:
            print(f"  - {s}")

        print()
        print("Final JBCON team:")
        rows = db.scalars(
            select(ProjectMember)
            .where(ProjectMember.project_id == JBCON_ID)
            .order_by(ProjectMember.role.asc(), ProjectMember.created_at.asc())
        ).all()
        for m in rows:
            u = db.get(User, m.user_id)
            print(f"  {(u.full_name if u else '?'):<24} {m.role}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
