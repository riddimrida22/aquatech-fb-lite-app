"""One-shot: apply Roger Wang's corrected rates and create the BWT-1608-JBCON project + WBS.

User-provided facts (the binding spec):
- Roger billable rate = 90 * 2.14 * 1.10 = 211.86  (90 base * 2.14 multiplier * 10% profit)
- Roger cost rate    = 110.00 (per user, latest correction)
- New project: BWT-1608-JBCON, Master Planning for Jamaica Bay WRRF Consolidation
  Client: NYC DEP via Brown & Caldwell.  Cap fee = $47,490.  End 2029-02-22.
  WBS (from compensation appendix B):
    Task 2.01.003  Existing Data Collection Memo & Gap Analysis  $9,375
    Task 2.05.001  Workshop                                       $9,375
    Task 2.05.002  Regulatory Futures Report Support              $5,830
    Task 2.06      Existing Conditions Assessment Report         $22,910
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

from sqlalchemy import select
from app.db import SessionLocal
from app.models import Project, Subtask, Task, User, UserRate

ROGER_BILL = round(90 * 2.14 * 1.10, 2)  # 211.86
ROGER_COST = 110.00
TODAY = date.today()

PROJECT_NAME = "BWT-1608-JBCON Jamaica Bay WRRF Consolidation"
PROJECT_CLIENT = "Brown and Caldwell (NYC DEP via prime)"
PROJECT_FEE = 47490.0
PROJECT_END = date(2029, 2, 22)

# WBS as (code, name, budget_fee). Hours unknown -> leave None and let PM fill in later.
WBS = [
    ("2.01.003", "Existing Data Collection Memorandum and Gap Analysis", 9375.0),
    ("2.05.001", "Workshop", 9375.0),
    ("2.05.002", "Regulatory Futures Report Support", 5830.0),
    ("2.06",     "Existing Conditions Assessment Report",                22910.0),
]


def main() -> None:
    db = SessionLocal()
    try:
        # 1. Roger's rate update --------------------------------------------------
        roger = db.scalar(select(User).where(User.full_name == "Roger Wang"))
        if not roger:
            print("ERROR: Roger Wang not in users table; aborting.")
            return
        existing_today = db.scalar(
            select(UserRate).where(
                UserRate.user_id == roger.id,
                UserRate.effective_date == TODAY,
            )
        )
        if existing_today:
            existing_today.bill_rate = ROGER_BILL
            existing_today.cost_rate = ROGER_COST
            print(f"  -> Updated existing UserRate for Roger ({TODAY}): bill={ROGER_BILL}, cost={ROGER_COST}")
        else:
            db.add(UserRate(
                user_id=roger.id,
                effective_date=TODAY,
                bill_rate=ROGER_BILL,
                cost_rate=ROGER_COST,
            ))
            print(f"  -> Inserted new UserRate for Roger ({TODAY}): bill={ROGER_BILL}, cost={ROGER_COST}")

        # 2. Create / fetch project ---------------------------------------------
        proj = db.scalar(select(Project).where(Project.name == PROJECT_NAME))
        if proj:
            print(f"  -> Project already exists (id={proj.id}); refreshing fields")
            proj.client_name = PROJECT_CLIENT
            proj.overall_budget_fee = PROJECT_FEE
            proj.end_date = PROJECT_END
            proj.is_billable = True
            proj.is_active = True
            proj.is_overhead = False
            proj.target_gross_margin_pct = 0.10
        else:
            proj = Project(
                name=PROJECT_NAME,
                client_name=PROJECT_CLIENT,
                pm_user_id=db.scalar(select(User.id).where(User.role == "admin")),
                start_date=TODAY,
                end_date=PROJECT_END,
                overall_budget_fee=PROJECT_FEE,
                target_gross_margin_pct=0.10,
                is_overhead=False,
                is_billable=True,
                is_active=True,
            )
            db.add(proj)
            db.flush()
            print(f"  -> Created project id={proj.id}: {PROJECT_NAME}")

        # 3. WBS tasks + (single) subtask per task to hold $ fee --------------
        for code, name, fee in WBS:
            tname = f"{code} {name}"
            task = db.scalar(select(Task).where(Task.project_id == proj.id, Task.name == tname))
            if not task:
                task = Task(project_id=proj.id, name=tname, is_billable=True)
                db.add(task)
                db.flush()
                print(f"     + Task {code}: {name}  (id={task.id})")
            # one canonical subtask per task carries the fee budget
            sub = db.scalar(select(Subtask).where(Subtask.task_id == task.id, Subtask.code == code))
            if sub:
                sub.name = name
                sub.budget_fee = fee
            else:
                db.add(Subtask(task_id=task.id, code=code, name=name, budget_fee=fee))
                print(f"        + Subtask {code} budget=${fee:,.2f}")

        db.commit()

        # Verification readout ---------------------------------------------
        proj = db.scalar(select(Project).where(Project.name == PROJECT_NAME))
        print()
        print(f"Project {proj.id}: {proj.name}")
        print(f"  Client: {proj.client_name}")
        print(f"  Fee   : ${proj.overall_budget_fee:,.2f}")
        print(f"  End   : {proj.end_date}")
        total_check = 0.0
        for t in db.scalars(select(Task).where(Task.project_id == proj.id).order_by(Task.id)).all():
            for s in db.scalars(select(Subtask).where(Subtask.task_id == t.id)).all():
                print(f"   - {t.name}  ::  ${s.budget_fee:,.2f}")
                total_check += s.budget_fee or 0.0
        print(f"  WBS total (sum of subtask budgets): ${total_check:,.2f}")
        rr = db.scalars(select(UserRate).where(UserRate.user_id == roger.id).order_by(UserRate.effective_date.desc())).first()
        print(f"  Roger latest rate: bill=${rr.bill_rate:,.2f}  cost=${rr.cost_rate:,.2f}  eff={rr.effective_date}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
