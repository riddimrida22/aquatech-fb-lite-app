"""One-time backfill: retroactive QA/QC records from earlier timesheet notes (owner 2026-10-06).

Every time entry on the project whose note mentions QA/QC (QA, QC, QA/QC, QAQC, quality control or
quality assurance) and is not already tied to a record is grouped by person and main plant area
(the first area named in the note). Each group becomes one record:

  * status "to_complete", marked retroactive, reviewer = the person who wrote the notes, preparer
    left for them to name (D-038), dated from the first entry, numbered after the existing records
    in date order;
  * Part 1 prefilled from the notes (task, type of work, area, sources, IDs named in the notes);
  * the earlier entries copied onto the record as "earlier QA/QC time (already billed)".

Time entries are never changed: no hours, notes, tasks, billed flags or invoice links, and they
are not linked to the record (owner: "dont move any time ... just place a note for the previous
times since they are already billed to the client").

Usage (inside the backend container or with DATABASE_URL set):
  python -m app.qaqc.backfill --project LTCP4 --actor bertrand.byrne@aquatechpc.com --preview out.csv
  python -m app.qaqc.backfill --project LTCP4 --actor bertrand.byrne@aquatechpc.com --apply
Running --apply twice adds nothing: entries already noted on a record are skipped.
"""

from __future__ import annotations

import argparse
import collections
import csv
import re
from datetime import datetime

from sqlalchemy import func, inspect, select

from ..db import SessionLocal
from ..models import Invoice, Project, Task, TimeEntry, User
from . import service
from .models import QaqcEarlierTime, QaqcReview

QA_RE = re.compile(r"\bQA\b|\bQC\b|QA\s*[/\\]?\s*QC|\bQAQC|quality\s+(control|assurance)", re.I)

# (code, name, pattern); the first one named in a note is the record's area.
AREAS = [
    ("NCB", "Newtown Creek Brooklyn", r"newtown creek brooklyn|\bNCB\b|NC-B|\bbrooklyn\b"),
    ("NCQ", "Newtown Creek Queens", r"newtown creek queens|\bNCQ\b|NC-Q|\bqueens\b"),
    ("NC", "Newtown Creek", r"newtown"),
    ("CIOH", "Coney Island / Owls Head", r"\bCIOH\b|coney|owls? head"),
    ("PR", "Port Richmond", r"port richmond|\bPR\b"),
    ("HP", "Hunts Point", r"hunts? point|\bHP\b"),
    ("JA", "Jamaica", r"jamaica|\bJA\b"),
    ("WI", "Wards Island", r"wards|\bWI\b"),
    ("TI", "Tallman Island", r"tallman|\bTI\b"),
    ("BB", "Bowery Bay", r"bowery|\bBB\b"),
    ("NR", "North River", r"north river|\bNR\b"),
    ("RH", "Red Hook", r"red hook|\bRH\b"),
    ("26W", "26th Ward", r"26th|\b26W\b"),
    ("RK", "Rockaway", r"rockaway"),
]
AREA_NAME = {c: n for c, n, _ in AREAS}

# (kind, work product type from the QA/QC picklist, pattern)
KINDS = [
    ("rip", "Model inputs (drawing readings)", r"\bRIP\b|record drawing|drawing|measurement|reading|reconcil"),
    ("subcatch", "Spreadsheet / database", r"subcatch|water usage|\bDWF\b|population"),
    ("fullpipe", "Hydraulic model", r"full[ -]pipe|\bFP\b"),
    ("capacity", "Calculation", r"capacit"),
    ("report", "Report", r"report|presentation|memo|slides|deck"),
    ("model", "Hydraulic model", r"model"),
]
ID_RE = re.compile(r"\b(?:[A-Z]{1,4}-(?:Reg\s*)?[A-Z]?\d{1,3}[A-Z]{0,2}|R-?\d{1,3}[A-Z]{0,2}|Reg(?:ulator)?\s+\d{1,3}[A-Z]?)\b")


def primary_area(note: str) -> str:
    best = None
    for code, _name, pat in AREAS:
        m = re.search(pat, note, re.I)
        if m and (best is None or m.start() < best[1]):
            best = (code, m.start())
    if not best:
        return "GEN"
    code = best[0]
    if code in ("NC", "NCQ") and re.search(r"brooklyn", note, re.I):
        return "NCB"
    return code


def kind_of(note: str) -> str | None:
    for k, _wpt, pat in KINDS:
        if re.search(pat, note, re.I):
            return k
    return None


def plan(db, project: Project) -> list[dict]:
    noted = set()
    if inspect(db.get_bind()).has_table("qaqc_earlier_time"):  # absent before the first deploy (preview only)
        noted = set(db.scalars(select(QaqcEarlierTime.time_entry_id)
                               .where(QaqcEarlierTime.time_entry_id.is_not(None))).all())
    rows = db.scalars(select(TimeEntry).where(TimeEntry.project_id == project.id, TimeEntry.qaqc_review_id.is_(None))
                      .order_by(TimeEntry.work_date, TimeEntry.id)).all()
    picked = [e for e in rows if QA_RE.search(e.note or "") and e.id not in noted]
    groups: dict[tuple[int, str], list[TimeEntry]] = collections.defaultdict(list)
    for e in picked:
        groups[(e.user_id, primary_area(e.note or ""))].append(e)
    out = []
    for (uid, area), es in groups.items():
        hours_by_kind: dict[str, float] = collections.Counter()
        hours_by_task: dict[int, float] = collections.Counter()
        for e in es:
            hours_by_kind[kind_of(e.note or "") or "model"] += float(e.hours or 0)
            hours_by_task[e.task_id] += float(e.hours or 0)
        kind = max(hours_by_kind, key=hours_by_kind.get)
        wpt = next(w for k, w, _p in KINDS if k == kind)
        notes = " ".join(e.note or "" for e in es)
        sources = []
        if re.search(r"\bRIP\b|record drawing", notes, re.I):
            sources.append("Record (RIP) drawings")
        if re.search(r"model", notes, re.I):
            sources.append("InfoWorks model")
        ids = []
        for m in ID_RE.findall(notes):
            m = re.sub(r"\s+", " ", m.strip())
            if m not in ids:
                ids.append(m)
        first, last = es[0].work_date, es[-1].work_date
        area_txt = AREA_NAME.get(area, "area not named in the notes")
        span = first.strftime("%m/%d/%Y") if first == last else f"{first:%m/%d/%Y} to {last:%m/%d/%Y}"
        out.append({
            "user_id": uid, "area": area, "task_id": max(hours_by_task, key=hours_by_task.get),
            "title": f"{wpt}: {area_txt} (earlier QA/QC time, {span})"[:255],
            "sources": "; ".join(sources),
            "scope": ("Named in the earlier timesheet notes: " + ", ".join(ids[:40])) if ids else "",
            "first": first, "last": last, "entries": es,
            "hours": round(sum(float(e.hours or 0) for e in es), 2),
        })
    out.sort(key=lambda g: (g["first"], g["user_id"], g["area"]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="project name, e.g. LTCP4")
    ap.add_argument("--actor", required=True, help="email of the admin recorded as having opened the records")
    ap.add_argument("--preview", help="write the planned records and entries to this CSV (no changes)")
    ap.add_argument("--apply", action="store_true", help="create the records")
    a = ap.parse_args()
    db = SessionLocal()
    try:
        project = db.scalar(select(Project).where(Project.name == a.project))
        actor = db.scalar(select(User).where(func.lower(User.email) == a.actor.lower()))
        if not project or not actor:
            raise SystemExit("project or actor not found")
        groups = plan(db, project)
        names = {u.id: u.full_name for u in db.scalars(select(User)).all()}
        tasks = {t.id: t.name for t in db.scalars(select(Task).where(Task.project_id == project.id)).all()}
        invoices = {i.id: i.invoice_number for i in db.scalars(select(Invoice)).all()}
        code = service.project_code(project)
        last = db.scalar(select(func.max(QaqcReview.seq)).where(QaqcReview.project_code == code)) or 0
        print(f"{sum(len(g['entries']) for g in groups)} entries, {sum(g['hours'] for g in groups):.2f} h "
              f"-> {len(groups)} records starting QA-{code}-{last + 1:03d}")
        if a.preview:
            with open(a.preview, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["record_no", "reviewer", "area", "task", "title", "sources", "scope", "entries", "hours",
                            "first", "last", "entry_id", "entry_date", "entry_hours", "billed", "invoice", "entry_note"])
                for n, g in enumerate(groups, start=last + 1):
                    rec = f"QA-{code}-{n:03d}"
                    for e in g["entries"]:
                        w.writerow([rec, names.get(g["user_id"]), AREA_NAME.get(g["area"], "General"),
                                    tasks.get(g["task_id"]), g["title"], g["sources"], g["scope"], len(g["entries"]),
                                    g["hours"], g["first"], g["last"], e.id, e.work_date, e.hours, bool(e.billed),
                                    invoices.get(e.invoice_id or 0, ""), e.note])
            print("preview written:", a.preview)
        if not a.apply:
            db.rollback()
            return
        for g in groups:
            task = db.get(Task, g["task_id"])
            sub, created = service.ensure_qaqc_subtask(db, task)
            rec, seq = service.next_record_no(db, code)
            r = QaqcReview(record_no=rec, project_code=code, seq=seq, project_id=project.id, task_id=task.id,
                           subtask_id=sub.id, title=g["title"], version_reviewed="", preparer_user_id=None,
                           reviewer_user_id=g["user_id"], sources=g["sources"], scope=g["scope"],
                           planned_hours=None, status="to_complete", retroactive=True, opened_by_user_id=actor.id,
                           opened_at=datetime.combine(g["first"], datetime.min.time()).replace(hour=12))
            db.add(r)
            db.flush()
            for e in g["entries"]:
                db.add(QaqcEarlierTime(review_id=r.id, time_entry_id=e.id, user_id=e.user_id, work_date=e.work_date,
                                       hours=float(e.hours or 0), note=e.note or "", billed=bool(e.billed),
                                       invoice_ref=invoices.get(e.invoice_id or 0, "")))
            service.log_event(db, r.id, actor.id, "opened",
                              f"{rec} created from {len(g['entries'])} earlier timesheet entries ({g['hours']:g} h, "
                              f"{g['first']:%m/%d/%Y} to {g['last']:%m/%d/%Y}). The earlier time is noted on the "
                              f"record; the time entries were not changed.")
            if created:
                service.log_event(db, r.id, actor.id, "qaqc_subtask",
                                  f"QA/QC subtask '{sub.name}' ({sub.code}) set up on task '{task.name}'")
        db.commit()
        print(f"created {len(groups)} records")
    finally:
        db.close()


if __name__ == "__main__":
    main()
