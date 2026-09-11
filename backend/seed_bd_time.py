#!/usr/bin/env python
"""Seed BD time entries (mostly Bertrand + Ailsa) against pursuits, so the Phase-3
cost-per-pursuit / cost-per-win rollups have data. Local demo only.

  DATABASE_URL="sqlite:///./bd_local.db" python seed_bd_time.py
"""
from __future__ import annotations

import random
from datetime import date, timedelta

import app.models  # register tables
from app import db as _db
from app.models import Project, Pursuit, Subtask, Task, TimeEntry, User, UserRate

random.seed(7)


def main():
    _db.init_db()  # ensures time_entries.pursuit_id exists
    s = _db.SessionLocal()

    def ensure_user(email, name, cost):
        u = s.query(User).filter_by(email=email).first()
        if not u:
            u = User(email=email, full_name=name, role="admin", is_active=True, start_date=date(2024, 1, 1))
            s.add(u); s.flush()
        if not s.query(UserRate).filter_by(user_id=u.id).first():
            s.add(UserRate(user_id=u.id, effective_date=date(2025, 1, 1),
                           bill_rate=round(cost * 2.35, 2), cost_rate=cost))
        return u

    bert = ensure_user("bertrand.byrne@aquatechpc.com", "Bertrand Byrne", 100.0)
    ailsa = ensure_user("ailsa.welch@aquatechpc.com", "Ailsa Welch", 78.5)
    s.flush()

    proj = s.query(Project).filter_by(name="Business Development").first()
    if not proj:
        proj = Project(name="Business Development", client_name="Internal", is_overhead=True,
                       is_billable=False, is_active=True, lifecycle_status="active",
                       source="system", overall_budget_fee=0.0)
        s.add(proj); s.flush()
    task = s.query(Task).filter_by(project_id=proj.id, name="Pursuits").first()
    if not task:
        task = Task(project_id=proj.id, name="Pursuits", is_billable=False)
        s.add(task); s.flush()
    sub = s.query(Subtask).filter_by(task_id=task.id).first()
    if not sub:
        sub = Subtask(task_id=task.id, code="BD", name="Business development", budget_hours=0, budget_fee=0)
        s.add(sub); s.flush()

    # clear any prior BD-linked time so re-runs stay clean
    s.query(TimeEntry).filter(TimeEntry.pursuit_id.isnot(None)).delete(synchronize_session=False)

    rate = {bert.id: 100.0, ailsa.id: 78.5}
    n = 0
    for p in s.query(Pursuit).all():
        if random.random() >= 0.6:      # ~60% of pursuits had logged BD effort
            continue
        # losers we chased hard cost more; quick no-gos cost little
        base = 14 if p.stage == "lost" else (10 if p.stage == "won" else 7)
        for uid in (bert.id, ailsa.id):
            if random.random() < 0.72:
                hrs = round(max(1.0, random.gauss(base, 5)), 1)
                s.add(TimeEntry(user_id=uid, project_id=proj.id, task_id=task.id, subtask_id=sub.id,
                                work_date=date.today() - timedelta(days=random.randint(20, 150)),
                                hours=hrs, note=f"BD: {p.name}", bill_rate_applied=0.0,
                                cost_rate_applied=rate[uid], pursuit_id=p.id,
                                is_billable=False, billed=False, source="manual"))
                n += 1
    s.commit()
    total = s.query(TimeEntry).filter(TimeEntry.pursuit_id.isnot(None)).count()
    print(f"seeded {n} BD time entries across pursuits (total BD-linked entries: {total})")
    s.close()


if __name__ == "__main__":
    main()
