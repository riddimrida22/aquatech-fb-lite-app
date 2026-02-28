#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

from app.db import SessionLocal, init_db
from app.main import _reconciliation_rows

OUT_DIR = Path("/home/sharing_pc_unix01/projects/AquatechPM/docs/reconciliation")


def to_iso(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def main():
    init_db()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with SessionLocal() as db:
        # Use full data span by default.
        from sqlalchemy import func, select
        from app.models import TimeEntry

        min_date = db.scalar(select(func.min(TimeEntry.work_date))) or date.today()
        max_date = db.scalar(select(func.max(TimeEntry.work_date))) or date.today()

        snapshot, monthly_rows = _reconciliation_rows(db, min_date, max_date)

    payload = {
        "start": min_date.isoformat(),
        "end": max_date.isoformat(),
        "snapshot": {k: to_iso(v) for k, v in snapshot.items()},
        "monthly": monthly_rows,
    }

    json_path = OUT_DIR / f"reconciliation_{min_date.isoformat()}_{max_date.isoformat()}.json"
    csv_path = OUT_DIR / f"reconciliation_{min_date.isoformat()}_{max_date.isoformat()}.csv"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "period",
                "entry_count",
                "unique_users",
                "unique_projects",
                "unique_tasks",
                "unique_subtasks",
                "total_hours",
                "bill_amount",
                "cost_amount",
                "profit_amount",
                "orphan_user_refs",
                "orphan_project_refs",
                "orphan_task_refs",
                "orphan_subtask_refs",
                "zero_or_negative_rate_entries",
            ]
        )
        for r in monthly_rows:
            writer.writerow(
                [
                    r["period"],
                    r["entry_count"],
                    r["unique_users"],
                    r["unique_projects"],
                    r["unique_tasks"],
                    r["unique_subtasks"],
                    f"{float(r['total_hours']):.2f}",
                    f"{float(r['bill_amount']):.2f}",
                    f"{float(r['cost_amount']):.2f}",
                    f"{float(r['profit_amount']):.2f}",
                    r["orphan_user_refs"],
                    r["orphan_project_refs"],
                    r["orphan_task_refs"],
                    r["orphan_subtask_refs"],
                    r["zero_or_negative_rate_entries"],
                ]
            )

    print(f"Wrote: {json_path}")
    print(f"Wrote: {csv_path}")
    print("Snapshot:")
    for k, v in payload["snapshot"].items():
        print(f"- {k}: {v}")


if __name__ == "__main__":
    main()
