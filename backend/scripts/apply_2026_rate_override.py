#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import and_, select

from app.db import SessionLocal, init_db
from app.models import Project, TimeEntry, User, UserRate

OUT_DIR = Path("/home/sharing_pc_unix01/projects/AquatechPM/docs/reconciliation")
OVERRIDE_DATE = date(2026, 1, 1)
START_2026 = date(2026, 1, 1)
END_2026 = date(2026, 12, 31)


def summarize(entries: list[TimeEntry]) -> dict[str, float]:
    hours = sum(float(e.hours) for e in entries)
    bill = sum(float(e.hours * e.bill_rate_applied) for e in entries)
    cost = sum(float(e.hours * e.cost_rate_applied) for e in entries)
    return {"hours": hours, "bill": bill, "cost": cost, "profit": bill - cost}


def by_employee(entries: list[TimeEntry], users_by_id: dict[int, User]):
    data = defaultdict(lambda: {"hours": 0.0, "bill": 0.0, "cost": 0.0})
    for e in entries:
        key = users_by_id.get(e.user_id).email if users_by_id.get(e.user_id) else f"user_{e.user_id}"
        d = data[key]
        d["hours"] += float(e.hours)
        d["bill"] += float(e.hours * e.bill_rate_applied)
        d["cost"] += float(e.hours * e.cost_rate_applied)
    rows = []
    for k, v in sorted(data.items()):
        rows.append(
            {
                "employee": k,
                "hours": v["hours"],
                "bill": v["bill"],
                "cost": v["cost"],
                "profit": v["bill"] - v["cost"],
            }
        )
    return rows


def by_project(entries: list[TimeEntry], projects_by_id: dict[int, Project]):
    data = defaultdict(lambda: {"hours": 0.0, "bill": 0.0, "cost": 0.0})
    for e in entries:
        key = projects_by_id.get(e.project_id).name if projects_by_id.get(e.project_id) else f"project_{e.project_id}"
        d = data[key]
        d["hours"] += float(e.hours)
        d["bill"] += float(e.hours * e.bill_rate_applied)
        d["cost"] += float(e.hours * e.cost_rate_applied)
    rows = []
    for k, v in sorted(data.items()):
        rows.append(
            {
                "project": k,
                "hours": v["hours"],
                "bill": v["bill"],
                "cost": v["cost"],
                "profit": v["bill"] - v["cost"],
            }
        )
    return rows


def row_map(rows: list[dict], key: str):
    return {r[key]: r for r in rows}


def delta_rows(before: list[dict], after: list[dict], key: str):
    b = row_map(before, key)
    a = row_map(after, key)
    keys = sorted(set(b.keys()) | set(a.keys()))
    out = []
    for k in keys:
        rb = b.get(k, {"hours": 0.0, "bill": 0.0, "cost": 0.0, "profit": 0.0})
        ra = a.get(k, {"hours": 0.0, "bill": 0.0, "cost": 0.0, "profit": 0.0})
        out.append(
            {
                key: k,
                "hours_before": rb["hours"],
                "hours_after": ra["hours"],
                "bill_before": rb["bill"],
                "bill_after": ra["bill"],
                "bill_delta": ra["bill"] - rb["bill"],
                "cost_before": rb["cost"],
                "cost_after": ra["cost"],
                "cost_delta": ra["cost"] - rb["cost"],
                "profit_before": rb["profit"],
                "profit_after": ra["profit"],
                "profit_delta": ra["profit"] - rb["profit"],
            }
        )
    return out


def main():
    init_db()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with SessionLocal() as db:
        users = db.scalars(select(User).order_by(User.id.asc())).all()
        projects = db.scalars(select(Project).order_by(Project.id.asc())).all()
        users_by_id = {u.id: u for u in users}
        projects_by_id = {p.id: p for p in projects}

        rates = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.asc(), UserRate.id.asc())).all()
        rates_by_user: dict[int, list[UserRate]] = defaultdict(list)
        for r in rates:
            rates_by_user[r.user_id].append(r)

        entries_2026 = db.scalars(
            select(TimeEntry).where(and_(TimeEntry.work_date >= START_2026, TimeEntry.work_date <= END_2026))
        ).all()
        entries_pre_2026 = db.scalars(select(TimeEntry).where(TimeEntry.work_date < START_2026)).all()
        pre_before = {e.id: (float(e.bill_rate_applied), float(e.cost_rate_applied)) for e in entries_pre_2026}

        before_total = summarize(entries_2026)
        before_emp = by_employee(entries_2026, users_by_id)
        before_proj = by_project(entries_2026, projects_by_id)

        # Build override rate by user from latest known rate row.
        override_by_user: dict[int, tuple[float, float]] = {}
        upserted = []
        unresolved_users = []

        for u in users:
            if u.id not in {e.user_id for e in entries_2026}:
                continue
            user_rates = rates_by_user.get(u.id, [])
            if not user_rates:
                unresolved_users.append({"user_id": u.id, "email": u.email, "reason": "no_rates_available"})
                continue

            latest = max(user_rates, key=lambda r: (r.effective_date, r.id))
            bill = float(latest.bill_rate)
            cost = float(latest.cost_rate)
            override_by_user[u.id] = (bill, cost)

            existing = db.scalar(
                select(UserRate).where(and_(UserRate.user_id == u.id, UserRate.effective_date == OVERRIDE_DATE))
            )
            if existing:
                existing.bill_rate = bill
                existing.cost_rate = cost
                action = "updated"
            else:
                db.add(UserRate(user_id=u.id, effective_date=OVERRIDE_DATE, bill_rate=bill, cost_rate=cost))
                action = "inserted"
            upserted.append({"user_id": u.id, "email": u.email, "effective_date": OVERRIDE_DATE.isoformat(), "bill_rate": bill, "cost_rate": cost, "action": action})

        # Reapply only 2026 entries using override rates.
        updated_entries = 0
        skipped_no_override = 0
        for e in entries_2026:
            ov = override_by_user.get(e.user_id)
            if not ov:
                skipped_no_override += 1
                continue
            new_bill, new_cost = ov
            if float(e.bill_rate_applied) != new_bill or float(e.cost_rate_applied) != new_cost:
                e.bill_rate_applied = new_bill
                e.cost_rate_applied = new_cost
                updated_entries += 1

        db.commit()

        # Re-read and summarize after.
        entries_2026_after = db.scalars(
            select(TimeEntry).where(and_(TimeEntry.work_date >= START_2026, TimeEntry.work_date <= END_2026))
        ).all()
        entries_pre_2026_after = db.scalars(select(TimeEntry).where(TimeEntry.work_date < START_2026)).all()

        pre_changed = 0
        for e in entries_pre_2026_after:
            b = pre_before.get(e.id)
            if b and (float(e.bill_rate_applied), float(e.cost_rate_applied)) != b:
                pre_changed += 1

        after_total = summarize(entries_2026_after)
        after_emp = by_employee(entries_2026_after, users_by_id)
        after_proj = by_project(entries_2026_after, projects_by_id)

    emp_delta = delta_rows(before_emp, after_emp, "employee")
    proj_delta = delta_rows(before_proj, after_proj, "project")

    payload = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "override_effective_date": OVERRIDE_DATE.isoformat(),
        "range_start": START_2026.isoformat(),
        "range_end": END_2026.isoformat(),
        "entries_2026_count": len(entries_2026_after),
        "entries_updated_2026": updated_entries,
        "entries_skipped_no_override": skipped_no_override,
        "pre_2026_entries_changed": pre_changed,
        "before_total": before_total,
        "after_total": after_total,
        "delta_total": {
            "hours": after_total["hours"] - before_total["hours"],
            "bill": after_total["bill"] - before_total["bill"],
            "cost": after_total["cost"] - before_total["cost"],
            "profit": after_total["profit"] - before_total["profit"],
        },
        "rate_rows_upserted": upserted,
        "unresolved_users": unresolved_users,
        "by_employee_delta": emp_delta,
        "by_project_delta": proj_delta,
    }

    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    json_path = OUT_DIR / f"rate_override_2026_delta_{stamp}.json"
    csv_emp = OUT_DIR / f"rate_override_2026_by_employee_{stamp}.csv"
    csv_proj = OUT_DIR / f"rate_override_2026_by_project_{stamp}.csv"
    csv_summary = OUT_DIR / f"rate_override_2026_summary_{stamp}.csv"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    with csv_summary.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["metric", "value"])
        w.writerow(["override_effective_date", payload["override_effective_date"]])
        w.writerow(["entries_2026_count", payload["entries_2026_count"]])
        w.writerow(["entries_updated_2026", payload["entries_updated_2026"]])
        w.writerow(["entries_skipped_no_override", payload["entries_skipped_no_override"]])
        w.writerow(["pre_2026_entries_changed", payload["pre_2026_entries_changed"]])
        for k in ["hours", "bill", "cost", "profit"]:
            w.writerow([f"before_{k}", payload["before_total"][k]])
            w.writerow([f"after_{k}", payload["after_total"][k]])
            w.writerow([f"delta_{k}", payload["delta_total"][k]])

    with csv_emp.open("w", newline="", encoding="utf-8") as f:
        if emp_delta:
            w = csv.DictWriter(f, fieldnames=list(emp_delta[0].keys()))
            w.writeheader()
            w.writerows(emp_delta)
        else:
            f.write("employee,hours_before,hours_after,bill_before,bill_after,bill_delta,cost_before,cost_after,cost_delta,profit_before,profit_after,profit_delta\n")

    with csv_proj.open("w", newline="", encoding="utf-8") as f:
        if proj_delta:
            w = csv.DictWriter(f, fieldnames=list(proj_delta[0].keys()))
            w.writeheader()
            w.writerows(proj_delta)
        else:
            f.write("project,hours_before,hours_after,bill_before,bill_after,bill_delta,cost_before,cost_after,cost_delta,profit_before,profit_after,profit_delta\n")

    print(f"Wrote: {json_path}")
    print(f"Wrote: {csv_summary}")
    print(f"Wrote: {csv_emp}")
    print(f"Wrote: {csv_proj}")
    print(f"2026 entries updated: {updated_entries}")
    print(f"Pre-2026 entries changed: {pre_changed}")


if __name__ == "__main__":
    main()
