#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

from sqlalchemy import and_, func, select

from app.db import SessionLocal, init_db
from app.models import Project, Subtask, Task, TimeEntry, User, UserRate

OUT_DIR = Path("/home/sharing_pc_unix01/projects/aquatech-fb-lite-app/docs/reconciliation")


def to_jsonable(v):
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def main():
    init_db()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with SessionLocal() as db:
        users = db.scalars(select(User)).all()
        projects = db.scalars(select(Project)).all()
        tasks = db.scalars(select(Task)).all()
        subtasks = db.scalars(select(Subtask)).all()
        rates = db.scalars(select(UserRate)).all()
        entries = db.scalars(select(TimeEntry).order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())).all()

        users_by_id = {u.id: u for u in users}
        projects_by_id = {p.id: p for p in projects}
        tasks_by_id = {t.id: t for t in tasks}
        subtasks_by_id = {s.id: s for s in subtasks}

        rates_by_user: dict[int, list[UserRate]] = {}
        for r in rates:
            rates_by_user.setdefault(r.user_id, []).append(r)
        for uid in rates_by_user:
            rates_by_user[uid].sort(key=lambda x: x.effective_date)

        orphan_user_ids = []
        orphan_project_ids = []
        orphan_task_ids = []
        orphan_subtask_ids = []
        wbs_task_project_mismatch_ids = []
        wbs_subtask_task_mismatch_ids = []
        non_positive_rate_ids = []
        missing_effective_rate_ids = []

        for te in entries:
            if te.user_id not in users_by_id:
                orphan_user_ids.append(te.id)
            if te.project_id not in projects_by_id:
                orphan_project_ids.append(te.id)
            if te.task_id not in tasks_by_id:
                orphan_task_ids.append(te.id)
            if te.subtask_id not in subtasks_by_id:
                orphan_subtask_ids.append(te.id)

            task = tasks_by_id.get(te.task_id)
            if task and task.project_id != te.project_id:
                wbs_task_project_mismatch_ids.append(te.id)
            sub = subtasks_by_id.get(te.subtask_id)
            if sub and sub.task_id != te.task_id:
                wbs_subtask_task_mismatch_ids.append(te.id)

            if te.bill_rate_applied <= 0 or te.cost_rate_applied <= 0:
                non_positive_rate_ids.append(te.id)

            user_rates = rates_by_user.get(te.user_id, [])
            has_effective = any(r.effective_date <= te.work_date for r in user_rates)
            if not has_effective:
                missing_effective_rate_ids.append(te.id)

        active_users_without_rates = sorted(
            [u.email for u in users if u.is_active and len(rates_by_user.get(u.id, [])) == 0]
        )

        project_ids_with_tasks = {t.project_id for t in tasks}
        projects_without_tasks = sorted([p.name for p in projects if p.id not in project_ids_with_tasks])

        task_ids_with_subtasks = {s.task_id for s in subtasks}
        tasks_without_subtasks = sorted([f"{t.id}:{t.name}" for t in tasks if t.id not in task_ids_with_subtasks])

        min_date = min((e.work_date for e in entries), default=date.today())
        max_date = max((e.work_date for e in entries), default=date.today())

        summary = {
            "date_span_start": min_date,
            "date_span_end": max_date,
            "time_entries_total": len(entries),
            "orphan_user_refs": len(orphan_user_ids),
            "orphan_project_refs": len(orphan_project_ids),
            "orphan_task_refs": len(orphan_task_ids),
            "orphan_subtask_refs": len(orphan_subtask_ids),
            "wbs_task_project_mismatch": len(wbs_task_project_mismatch_ids),
            "wbs_subtask_task_mismatch": len(wbs_subtask_task_mismatch_ids),
            "non_positive_rate_entries": len(non_positive_rate_ids),
            "missing_effective_rate_entries": len(missing_effective_rate_ids),
            "active_users_without_rates": len(active_users_without_rates),
            "projects_without_tasks": len(projects_without_tasks),
            "tasks_without_subtasks": len(tasks_without_subtasks),
        }

        details = {
            "active_users_without_rates": active_users_without_rates,
            "projects_without_tasks": projects_without_tasks,
            "tasks_without_subtasks": tasks_without_subtasks,
            "example_ids": {
                "orphan_user_refs": orphan_user_ids[:100],
                "orphan_project_refs": orphan_project_ids[:100],
                "orphan_task_refs": orphan_task_ids[:100],
                "orphan_subtask_refs": orphan_subtask_ids[:100],
                "wbs_task_project_mismatch": wbs_task_project_mismatch_ids[:100],
                "wbs_subtask_task_mismatch": wbs_subtask_task_mismatch_ids[:100],
                "non_positive_rate_entries": non_positive_rate_ids[:100],
                "missing_effective_rate_entries": missing_effective_rate_ids[:100],
            },
        }

    json_path = OUT_DIR / f"data_gaps_{to_jsonable(summary['date_span_start'])}_{to_jsonable(summary['date_span_end'])}.json"
    csv_path = OUT_DIR / f"data_gaps_{to_jsonable(summary['date_span_start'])}_{to_jsonable(summary['date_span_end'])}.csv"

    payload = {"summary": {k: to_jsonable(v) for k, v in summary.items()}, "details": details}
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["metric", "value"])
        for k, v in payload["summary"].items():
            w.writerow([k, v])

    print(f"Wrote: {json_path}")
    print(f"Wrote: {csv_path}")
    print("Summary:")
    for k, v in payload["summary"].items():
        print(f"- {k}: {v}")


if __name__ == "__main__":
    main()
