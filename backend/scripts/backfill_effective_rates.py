#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import TimeEntry, User, UserRate

OUT_DIR = Path("/home/sharing_pc_unix01/projects/aquatech-fb-lite-app/docs/reconciliation")


def _missing_effective_entries(entries: list[TimeEntry], rates_by_user: dict[int, list[UserRate]]) -> list[TimeEntry]:
    missing = []
    for te in entries:
        user_rates = rates_by_user.get(te.user_id, [])
        has_effective = any(r.effective_date <= te.work_date for r in user_rates)
        if not has_effective:
            missing.append(te)
    return missing


def main():
    init_db()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with SessionLocal() as db:
        users = db.scalars(select(User)).all()
        entries = db.scalars(select(TimeEntry).order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())).all()
        rates = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.asc())).all()

        users_by_id = {u.id: u for u in users}
        rates_by_user: dict[int, list[UserRate]] = {}
        for r in rates:
            rates_by_user.setdefault(r.user_id, []).append(r)

        before_missing = _missing_effective_entries(entries, rates_by_user)
        before_count = len(before_missing)

        per_user_missing_dates: dict[int, list] = {}
        for te in before_missing:
            per_user_missing_dates.setdefault(te.user_id, []).append(te.work_date)

        inserted = []
        unresolved = []

        for user_id, missing_dates in per_user_missing_dates.items():
            user_rates = rates_by_user.get(user_id, [])
            if not user_rates:
                unresolved.append(
                    {
                        "user_id": user_id,
                        "email": users_by_id.get(user_id).email if users_by_id.get(user_id) else None,
                        "reason": "no_existing_rates",
                        "missing_entries": len(missing_dates),
                    }
                )
                continue

            first_missing_date = min(missing_dates)
            earliest_rate = min(user_rates, key=lambda r: r.effective_date)

            # Avoid duplicate same-day rate rows.
            existing_same_day = any(r.effective_date == first_missing_date for r in user_rates)
            if existing_same_day:
                continue

            new_rate = UserRate(
                user_id=user_id,
                effective_date=first_missing_date,
                bill_rate=float(earliest_rate.bill_rate),
                cost_rate=float(earliest_rate.cost_rate),
            )
            db.add(new_rate)
            inserted.append(
                {
                    "user_id": user_id,
                    "email": users_by_id.get(user_id).email if users_by_id.get(user_id) else None,
                    "effective_date": first_missing_date.isoformat(),
                    "bill_rate": float(earliest_rate.bill_rate),
                    "cost_rate": float(earliest_rate.cost_rate),
                    "missing_entries_covered": len(missing_dates),
                }
            )

        db.commit()

        # Recompute after insert.
        rates_after = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.asc())).all()
        rates_by_user_after: dict[int, list[UserRate]] = {}
        for r in rates_after:
            rates_by_user_after.setdefault(r.user_id, []).append(r)
        after_missing = _missing_effective_entries(entries, rates_by_user_after)
        after_count = len(after_missing)

        payload = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "before_missing_effective_rate_entries": before_count,
            "after_missing_effective_rate_entries": after_count,
            "delta_resolved": before_count - after_count,
            "inserted_rate_rows": inserted,
            "unresolved_users": unresolved,
        }

    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    json_path = OUT_DIR / f"backfill_rate_delta_{stamp}.json"
    csv_path = OUT_DIR / f"backfill_rate_delta_{stamp}.csv"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["metric", "value"])
        w.writerow(["before_missing_effective_rate_entries", payload["before_missing_effective_rate_entries"]])
        w.writerow(["after_missing_effective_rate_entries", payload["after_missing_effective_rate_entries"]])
        w.writerow(["delta_resolved", payload["delta_resolved"]])
        w.writerow(["inserted_rate_rows_count", len(payload["inserted_rate_rows"])])
        w.writerow(["unresolved_users_count", len(payload["unresolved_users"])])

    print(f"Wrote: {json_path}")
    print(f"Wrote: {csv_path}")
    print(f"Before missing effective rates: {before_count}")
    print(f"After missing effective rates: {after_count}")
    print(f"Resolved: {before_count - after_count}")
    print(f"Inserted rate rows: {len(inserted)}")
    if unresolved:
        print("Unresolved users:", unresolved)


if __name__ == "__main__":
    main()
