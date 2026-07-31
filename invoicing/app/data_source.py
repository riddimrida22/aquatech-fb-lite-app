"""
Data source — pulls live hours from the AqtPM Postgres DB.

Cloud version: connects DIRECTLY to Postgres (no SSH). On the GCE server the
invoicing service sits on the same Docker network as the `db` container and reads
DATABASE_URL from the environment. Function signatures are unchanged so the
generators/packagers work as-is.
"""
from __future__ import annotations
import os
import datetime as dt

from sqlalchemy import create_engine, text

_DB_URL = os.environ.get("DATABASE_URL") or os.environ.get("INVOICING_DATABASE_URL")
_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        if not _DB_URL:
            raise RuntimeError("DATABASE_URL not set for the invoicing service")
        _engine = create_engine(_DB_URL, pool_pre_ping=True)
    return _engine


def _project_name(conn, project_id: int):
    return conn.execute(
        text("SELECT name FROM projects WHERE id = :p"), {"p": project_id}
    ).scalar_one_or_none()


def pull(project_id: int, begin: dt.date, end: dt.date,
         ts_begin: dt.date | None = None, ts_end: dt.date | None = None) -> dict:
    """invoice_hours over [begin,end]; timesheet rows over [ts_begin,ts_end]
    (defaults to the invoice period). Returns invoice_hours, timesheet, bill_rates,
    project_name — matching the old SSH implementation exactly."""
    ts_begin = ts_begin or begin
    ts_end = ts_end or end
    with _get_engine().connect() as conn:
        proj_name = _project_name(conn, project_id)
        rows = conn.execute(text("""
            SELECT u.full_name, p.name AS pname, te.work_date, te.hours, te.note,
                   te.bill_rate_applied
            FROM time_entries te
            JOIN users u ON u.id = te.user_id
            JOIN projects p ON p.id = te.project_id
            WHERE te.work_date >= :ts_begin AND te.work_date <= :ts_end
            ORDER BY u.full_name, te.work_date
        """), {"ts_begin": ts_begin, "ts_end": ts_end}).all()

    invoice_hours: dict[str, float] = {}
    timesheet: dict[str, list] = {}
    bill_rates: dict[str, float] = {}
    for full_name, pname, d, hrs, note, brate in rows:
        h = float(hrs or 0)
        timesheet.setdefault(full_name, []).append(
            {"project": pname, "date": d, "hours": h, "note": note or ""})
        if pname == proj_name and begin <= d <= end:
            invoice_hours[full_name] = round(invoice_hours.get(full_name, 0.0) + h, 2)
            if brate:
                bill_rates[full_name] = float(brate)
    return {"invoice_hours": invoice_hours, "timesheet": timesheet,
            "bill_rates": bill_rates, "project_name": proj_name}


def pull_fb_lines(project_id: int, begin: dt.date, end: dt.date) -> dict:
    """Per-time-entry line items for the FreshBooks-style invoice."""
    with _get_engine().connect() as conn:
        proj_name = _project_name(conn, project_id)
        rows = conn.execute(text("""
            SELECT u.full_name, te.work_date, te.hours, te.note, te.bill_rate_applied,
                   t.name AS task
            FROM time_entries te
            JOIN users u ON u.id = te.user_id
            JOIN projects p ON p.id = te.project_id
            LEFT JOIN tasks t ON t.id = te.task_id
            WHERE te.project_id = :proj AND te.work_date >= :begin AND te.work_date <= :end
            ORDER BY te.work_date, u.full_name
        """), {"proj": project_id, "begin": begin, "end": end}).all()
    out = []
    for nm, d, h, note, br, task in rows:
        h = float(h or 0); br = float(br or 0)
        out.append({"person": nm, "date": d, "hours": h, "note": note or "",
                    "rate": br, "task": task or "", "amount": round(h * br, 2)})
    return {"lines": out, "project_name": proj_name}


def pull_subtasks(project_id: int, begin: dt.date, end: dt.date) -> dict:
    """Hours grouped by (sub-task/task name -> {full_name: hours}) + bill rates."""
    with _get_engine().connect() as conn:
        proj_name = _project_name(conn, project_id)
        rows = conn.execute(text("""
            SELECT u.full_name, t.name AS task, te.hours, te.bill_rate_applied
            FROM time_entries te
            JOIN users u ON u.id = te.user_id
            LEFT JOIN tasks t ON t.id = te.task_id
            WHERE te.project_id = :proj AND te.work_date >= :begin AND te.work_date <= :end
        """), {"proj": project_id, "begin": begin, "end": end}).all()
    by_sub: dict[str, dict] = {}
    bill_rates: dict[str, float] = {}
    for full_name, task, hrs, brate in rows:
        h = float(hrs or 0)
        if not h:
            continue
        key = task or "(no task)"
        by_sub.setdefault(key, {})
        by_sub[key][full_name] = round(by_sub[key].get(full_name, 0.0) + h, 2)
        if brate:
            bill_rates[full_name] = float(brate)
    return {"by_subtask": by_sub, "bill_rates": bill_rates, "project_name": proj_name}
