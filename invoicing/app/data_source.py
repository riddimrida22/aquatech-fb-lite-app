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


def pull_notes_by_subtask(project_id: int, begin: dt.date, end: dt.date) -> list[dict]:
    """Time-entry notes grouped by sub-task for the month, in task order — the raw
    material for the Work Summary. Each: {code, name, notes:[...]} (notes de-duped,
    in date order). Sub-task code parsed from the task name leading number."""
    import re
    with _get_engine().connect() as conn:
        rows = conn.execute(text("""
            SELECT t.name AS task, st.name AS subtask, te.work_date, te.note
            FROM time_entries te
            LEFT JOIN tasks t ON t.id = te.task_id
            LEFT JOIN subtasks st ON st.id = te.subtask_id
            WHERE te.project_id = :proj AND te.work_date >= :begin AND te.work_date <= :end
              AND coalesce(te.note, '') <> ''
            ORDER BY t.name, te.work_date
        """), {"proj": project_id, "begin": begin, "end": end}).all()
    groups: dict[str, dict] = {}
    for task, subtask, _d, note in rows:
        label = task or subtask or "(no task)"
        m = re.match(r"\s*(\d+(?:\.\d+)+)", label)
        code = m.group(1) if m else ""
        # display name = the label with any leading code stripped
        name = re.sub(r"^\s*\d+(?:\.\d+)+\s*", "", label).strip() or (subtask or label)
        g = groups.setdefault(code or label, {"code": code, "name": name, "notes": []})
        n = (note or "").strip()
        if n and n not in g["notes"]:
            g["notes"].append(n)
    return list(groups.values())


def official_for(project_key: str, period_id: str) -> dict | None:
    """The latest OFFICIAL generation for a (project, period), or None. Drives the
    official/draft decision: if an official already exists, a second generation is a
    watermarked DRAFT (unless the original author re-issues a correction)."""
    with _get_engine().connect() as conn:
        row = conn.execute(text("""
            SELECT id, invoice_no, generated_by, generated_by_name, generated_at
            FROM invoice_generations
            WHERE project_key = :pk AND period_id = :pid AND kind = 'official'
            ORDER BY generated_at DESC
            LIMIT 1
        """), {"pk": project_key, "pid": str(period_id)}).mappings().first()
    if not row:
        return None
    d = dict(row)
    ga = d.get("generated_at")
    d["generated_at"] = ga.isoformat() if hasattr(ga, "isoformat") else ga
    return d


def recent_generations(limit: int = 15) -> list[dict]:
    """Most-recent generation events for the in-app activity banner. Never raises."""
    limit = max(1, min(int(limit or 15), 100))
    try:
        with _get_engine().connect() as conn:
            rows = conn.execute(text("""
                SELECT project_key, period_id, period_label, invoice_no, kind,
                       generated_by, generated_by_name, this_total, generated_at
                FROM invoice_generations
                ORDER BY generated_at DESC
                LIMIT :lim
            """), {"lim": limit}).mappings().all()
    except Exception:
        return []
    out = []
    for r in rows:
        d = dict(r)
        ga = d.get("generated_at")
        d["generated_at"] = ga.isoformat() if hasattr(ga, "isoformat") else ga
        out.append(d)
    return out


def record_generation(*, project_key: str, period_id: str, period_label: str | None,
                      invoice_no: str | None, kind: str, generated_by: str,
                      generated_by_name: str | None, this_total: float | None) -> None:
    """Append a generation event (official|draft). Shared table read by the backend for
    the in-app activity banner and by official_for() for the lock decision."""
    with _get_engine().begin() as conn:
        conn.execute(text("""
            INSERT INTO invoice_generations
              (project_key, period_id, period_label, invoice_no, kind,
               generated_by, generated_by_name, this_total, generated_at)
            VALUES
              (:pk, :pid, :plabel, :ino, :kind, :by, :byname, :total, :ts)
        """), {"pk": project_key, "pid": str(period_id), "plabel": period_label,
               "ino": invoice_no, "kind": kind, "by": generated_by or "unknown",
               "byname": generated_by_name, "total": this_total,
               "ts": dt.datetime.utcnow()})


def publish_invoice(*, invoice_number: str, project_id: int, client_name: str,
                    begin, end, issue_date, due_days: int, subtotal: float,
                    source: str = "aqtpm_generator", notes: str | None = None) -> str:
    """Persist an OFFICIAL generated invoice into public.invoices so it shows in the
    books/AR (finance.v_money_owed, v_project_economics) — the replacement for the old
    FreshBooks sync that used to create these rows. Upsert by invoice_number: insert if
    new, update in place on a re-issue (preserving any amount_paid). Returns 'inserted'
    or 'updated'."""
    def _d(x):
        return x if isinstance(x, dt.date) else dt.date.fromisoformat(str(x))
    b, e, iss = _d(begin), _d(end), _d(issue_date)
    due = iss + dt.timedelta(days=int(due_days or 30))
    subtotal = round(float(subtotal or 0), 2)
    with _get_engine().begin() as conn:
        existing = conn.execute(
            text("SELECT id, coalesce(amount_paid,0) AS paid FROM invoices WHERE invoice_number = :n"),
            {"n": invoice_number}).mappings().first()
        if existing:
            conn.execute(text("""
                UPDATE invoices
                   SET project_id=:pid, client_name=:cn, start_date=:b, end_date=:e,
                       issue_date=:iss, due_date=:due, subtotal_amount=:sub,
                       balance_due=:sub - coalesce(amount_paid,0),
                       source=:src, notes=:notes
                 WHERE invoice_number=:n
            """), {"pid": project_id, "cn": client_name, "b": b, "e": e, "iss": iss,
                   "due": due, "sub": subtotal, "src": source, "notes": notes,
                   "n": invoice_number})
            return "updated"
        conn.execute(text("""
            INSERT INTO invoices
              (invoice_number, project_id, client_name, source, start_date, end_date,
               issue_date, due_date, status, subtotal_amount, amount_paid, balance_due,
               total_cost, total_profit, payment_link_enabled, notes, created_at)
            VALUES
              (:n, :pid, :cn, :src, :b, :e, :iss, :due, 'sent', :sub, 0, :sub,
               0, 0, false, :notes, :now)
        """), {"n": invoice_number, "pid": project_id, "cn": client_name, "src": source,
               "b": b, "e": e, "iss": iss, "due": due, "sub": subtotal,
               "notes": notes or "", "now": dt.datetime.utcnow()})
        return "inserted"


def mark_time_entries_billed(*, project_id: int, begin, end) -> int:
    """Flag the billable time entries covered by a just-published invoice as billed=true,
    so the app's unbilled-hours views stop counting them. This is the replacement for the
    old FreshBooks sync (which set the same `billed` flag). Idempotent and scoped: only
    flips is_billable, not-yet-billed entries in [begin,end] for this project. Returns the
    number of entries flipped."""
    def _d(x):
        return x if isinstance(x, dt.date) else dt.date.fromisoformat(str(x))
    b, e = _d(begin), _d(end)
    with _get_engine().begin() as conn:
        res = conn.execute(text("""
            UPDATE time_entries
               SET billed = true
             WHERE project_id = :pid
               AND coalesce(is_billable, false) = true
               AND coalesce(billed, false) = false
               AND work_date >= :b AND work_date <= :e
        """), {"pid": project_id, "b": b, "e": e})
        return res.rowcount or 0


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
