"""Create project_members table (idempotent) and backfill:

1. Every project's pm_user_id -> ProjectMember(role='Lead')
2. JBCON (project id 13): Bertrand Byrne='Lead', Roger Wang='QA/QC'
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

from sqlalchemy import inspect, select
from app.db import Base, engine, SessionLocal
from app.models import Project, ProjectMember, User


def main() -> None:
    insp = inspect(engine)
    if "project_members" not in insp.get_table_names():
        print("Creating project_members table...")
        ProjectMember.__table__.create(engine)
    else:
        print("project_members table already exists; skipping create.")

    db = SessionLocal()
    try:
        # 1. Backfill: every project's pm_user_id becomes a Lead member
        for proj in db.scalars(select(Project)).all():
            if proj.pm_user_id:
                exists = db.scalar(
                    select(ProjectMember).where(
                        ProjectMember.project_id == proj.id,
                        ProjectMember.user_id == proj.pm_user_id,
                        ProjectMember.role == "Lead",
                    )
                )
                if not exists:
                    db.add(ProjectMember(
                        project_id=proj.id,
                        user_id=proj.pm_user_id,
                        role="Lead",
                        allocation_pct=0.0,
                        start_date=proj.start_date,
                        end_date=proj.end_date,
                        notes="Backfilled from project.pm_user_id",
                    ))
                    print(f"  + Lead on project {proj.id} ({proj.name[:40]})")

        # 2. JBCON-specific: add Roger Wang as QA/QC (Bertrand already added by step 1)
        jbcon = db.scalar(select(Project).where(Project.id == 13))
        roger = db.scalar(select(User).where(User.full_name == "Roger Wang"))
        if jbcon and roger:
            roger_qa = db.scalar(
                select(ProjectMember).where(
                    ProjectMember.project_id == jbcon.id,
                    ProjectMember.user_id == roger.id,
                    ProjectMember.role == "QA/QC",
                )
            )
            if not roger_qa:
                db.add(ProjectMember(
                    project_id=jbcon.id,
                    user_id=roger.id,
                    role="QA/QC",
                    allocation_pct=0.0,
                    start_date=jbcon.start_date,
                    end_date=jbcon.end_date,
                    notes="Initial QA/QC reviewer per kickoff",
                ))
                print(f"  + QA/QC: Roger Wang on project {jbcon.id} (JBCON)")
        db.commit()

        # Verification
        print()
        print("Project members after migration:")
        for proj in db.scalars(select(Project).order_by(Project.id)).all():
            mems = db.scalars(
                select(ProjectMember).where(ProjectMember.project_id == proj.id)
            ).all()
            if mems:
                print(f"  Project {proj.id}: {proj.name[:50]}")
                for m in mems:
                    u = db.get(User, m.user_id)
                    print(f"    - {u.full_name if u else '?'} = {m.role}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
