"""Printable QA/QC reports (owner 2026-10-06: "the admin must have a feature to print out reports").

Admin only (Bertrand, Ailsa; D-037). Two reports, both printable from the browser (Print, or Save as PDF):
  GET /qaqc/reports/record/{id}   one record in full: Parts 1-5, earlier time, hours, history
  GET /qaqc/reports/summary       records filtered by project, dates, person and status, with open
                                  findings and QA/QC hours by person; ?format=csv for Excel
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime
from html import escape
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..authz import get_current_user
from ..db import get_db
from ..models import Project, Task, TimeEntry, User
from .models import QaqcEarlierTime, QaqcEvent, QaqcFinding, QaqcItem, QaqcReview
from .routes import CERTIFICATION_TEXT, CLOSURE_TEXT, OPEN_FINDING, _is_admin, business_days_between

router = APIRouter(prefix="/qaqc/reports", tags=["qaqc-reports"])

STATUS = {"to_complete": "To complete", "open": "In review", "certified": "Certified", "closed": "Closed",
          "dismissed": "Not a review"}
F_STATUS = {"open": "Open", "resolved": "Resolved, awaiting back-check", "returned": "Returned to preparer",
            "verified": "Verified closed", "closed_by_decision": "Closed by decision"}
SEV = {"major": "Major", "minor": "Minor", "observation": "Observation"}

CSS = """
@page { size: letter; margin: 0.6in; }
* { box-sizing: border-box; }
body { font-family: Calibri, Arial, sans-serif; font-size: 10.5pt; color: #1f2933; margin: 0; padding: 24px; background: #fff; }
.bar { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #21295C;
       padding-bottom: 6px; margin-bottom: 14px; }
.firm { font-weight: 700; color: #21295C; font-size: 12pt; }
.meta { color: #52606d; font-size: 9pt; text-align: right; }
h1 { font-family: Cambria, Georgia, serif; color: #21295C; font-size: 18pt; margin: 0 0 4px; }
h2 { font-family: Cambria, Georgia, serif; color: #21295C; font-size: 12.5pt; margin: 18px 0 6px;
     border-bottom: 1px solid #c9d1db; padding-bottom: 3px; }
.sub { color: #52606d; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #21295C; color: #fff; text-align: left; font-weight: 600; padding: 4px 6px; font-size: 9.5pt; }
td { border-bottom: 1px solid #e1e6ec; padding: 4px 6px; vertical-align: top; }
td.n, th.n { text-align: right; white-space: nowrap; }
.kv td:first-child { color: #52606d; width: 22%; }
.total td { font-weight: 700; border-top: 1px solid #9aa5b1; }
.cert { font-style: italic; margin: 4px 0; }
.muted { color: #52606d; }
.finding { border: 1px solid #e1e6ec; border-radius: 4px; padding: 6px 8px; margin: 6px 0; page-break-inside: avoid; }
.finding p { margin: 3px 0; }
.toolbar { margin-bottom: 16px; }
.toolbar button { font: inherit; padding: 6px 14px; border: 1px solid #21295C; background: #21295C; color: #fff;
                  border-radius: 4px; cursor: pointer; }
@media print { .toolbar { display: none; } body { padding: 0; } }
"""


def _require_admin(u: User) -> None:
    if not _is_admin(u):
        raise HTTPException(status_code=403, detail="QA/QC reports are for admins (Bertrand and Ailsa).")


def _d(x) -> str:
    if not x:
        return ""
    if isinstance(x, datetime):
        return f"{x.month}/{x.day}/{x.year}"
    if isinstance(x, date):
        return f"{x.month}/{x.day}/{x.year}"
    return str(x)


NY = ZoneInfo("America/New_York")


def _dt(x: datetime | None) -> str:
    """Stored times are UTC; show New York time."""
    if not x:
        return ""
    t = x.replace(tzinfo=ZoneInfo("UTC")).astimezone(NY)
    return f"{t.month}/{t.day}/{t.year} {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"


def e(x) -> str:
    return escape("" if x is None else str(x))


def _page(title: str, subtitle: str, body: str, u: User, landscape: bool = False) -> Response:
    now = datetime.utcnow()
    extra = "@page { size: letter landscape; }" if landscape else ""
    html = (f"<!doctype html><html><head><meta charset='utf-8'><title>{e(title)}</title>"
            f"<style>{CSS}{extra}</style></head><body>"
            f"<div class='toolbar'><button onclick='window.print()'>Print or save as PDF</button></div>"
            f"<div class='bar'><span class='firm'>Aquatech Engineering P.C.</span>"
            f"<span class='meta'>Quality Procedure QP-01<br>Printed {_d(now)} by {e(u.full_name)}</span></div>"
            f"<h1>{e(title)}</h1><p class='sub'>{e(subtitle)}</p>{body}</body></html>")
    return Response(content=html, media_type="text/html; charset=utf-8")


def _table(head: list[str], rows: list[list[str]], numeric: set[int] = frozenset(), total: list[str] | None = None) -> str:
    th = "".join(f"<th class='n'>{e(h)}</th>" if i in numeric else f"<th>{e(h)}</th>" for i, h in enumerate(head))
    body = "".join("<tr>" + "".join(f"<td class='n'>{c}</td>" if i in numeric else f"<td>{c}</td>"
                                    for i, c in enumerate(r)) + "</tr>" for r in rows)
    if total:
        body += "<tr class='total'>" + "".join(f"<td class='n'>{c}</td>" if i in numeric else f"<td>{c}</td>"
                                               for i, c in enumerate(total)) + "</tr>"
    return f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>"


def _names(db: Session) -> dict[int, str]:
    return {x.id: x.full_name for x in db.scalars(select(User)).all()}


# ----------------------------------------------------------------- one record
@router.get("/record/{review_id}")
def report_record(review_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> Response:
    _require_admin(u)
    r = db.get(QaqcReview, review_id)
    if not r:
        raise HTTPException(status_code=404, detail="QA/QC record not found")
    nm = _names(db)
    project = db.get(Project, r.project_id)
    task = db.get(Task, r.task_id) if r.task_id else None
    items = db.scalars(select(QaqcItem).where(QaqcItem.review_id == r.id).order_by(QaqcItem.seq)).all()
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id).order_by(QaqcFinding.seq)).all()
    fseq = {f.id: f.seq for f in findings}
    earlier = db.scalars(select(QaqcEarlierTime).where(QaqcEarlierTime.review_id == r.id)
                         .order_by(QaqcEarlierTime.work_date)).all()
    entries = db.scalars(select(TimeEntry).where(TimeEntry.qaqc_review_id == r.id).order_by(TimeEntry.work_date)).all()
    events = db.scalars(select(QaqcEvent).where(QaqcEvent.review_id == r.id).order_by(QaqcEvent.at)).all()

    kv = [("Record number", r.record_no), ("Status", STATUS.get(r.status, r.status) + (" (retroactive)" if r.retroactive else "")),
          ("Project / task", f"{project.name if project else ''}{' / ' + task.name if task else ''}"),
          ("Work product reviewed", r.title), ("Version or date reviewed", r.version_reviewed),
          ("Preparer", nm.get(r.preparer_user_id or 0, "")), ("Reviewer", nm.get(r.reviewer_user_id, "")),
          ("Sources checked against", r.sources), ("Scope of check", r.scope),
          ("Date opened", f"{_d(r.opened_at)} by {nm.get(r.opened_by_user_id or 0, '')}")]
    body = "<h2>Part 1. Review details</h2><table class='kv'>" + "".join(
        f"<tr><td>{e(k)}</td><td>{e(v)}</td></tr>" for k, v in kv) + "</table>"
    if r.status == "dismissed":
        body += (f"<p><strong>Marked as not a review</strong> by {e(nm.get(r.dismissed_by_user_id or 0, ''))} on "
                 f"{_d(r.dismissed_at)}: {e(r.dismissed_reason)}</p>")
    if earlier:
        tot = sum(float(x.hours or 0) for x in earlier)
        body += ("<h2>Earlier QA/QC time (from timesheet notes, already billed)</h2>"
                 "<p class='muted'>Copied from the timesheets as a note; the entries were not moved or changed.</p>"
                 + _table(["Date", "Who", "Hours", "Invoice", "Timesheet note"],
                          [[_d(x.work_date), e(nm.get(x.user_id or 0, "")), f"{float(x.hours or 0):.2f}",
                            e(x.invoice_ref or ("Billed" if x.billed else "")), e(x.note)] for x in earlier],
                          {2}, ["Total", "", f"{tot:.2f}", "", ""]))
    body += "<h2>Part 2. Items checked</h2>"
    body += (_table(["No.", "Item checked", "Source used", "Value in work", "Value in source", "Result"],
                    [[str(i.seq), e(i.item), e(i.source), e(i.value_work), e(i.value_source),
                      f"Finding {fseq.get(i.finding_id or 0, '')}" if i.result == "finding" else "Agrees"] for i in items])
             if items else "<p class='muted'>No items listed.</p>")
    body += "<h2>Part 3. Findings</h2>"
    if not findings:
        body += "<p class='muted'>No findings were recorded.</p>"
    for f in findings:
        body += (f"<div class='finding'><p><strong>Finding {f.seq}</strong>, {SEV.get(f.severity, f.severity)}"
                 f", {F_STATUS.get(f.status, f.status)}, assigned to {e(nm.get(f.assigned_user_id or 0, ''))}</p>"
                 f"<p>{e(f.description)}</p>")
        if f.evidence:
            body += f"<p class='muted'>Evidence: {e(f.evidence)}</p>"
        if f.action_required:
            body += f"<p>Action required: {e(f.action_required)}</p>"
        if f.resolved_at:
            body += (f"<p>Resolution by {e(nm.get(f.resolved_by_user_id or 0, ''))} on {_d(f.resolved_at)}: "
                     f"{e(f.resolution_note)}{' (version ' + e(f.resolution_version) + ')' if f.resolution_version else ''}</p>")
        if f.verified_at:
            body += (f"<p>Back-check by {e(nm.get(f.verified_by_user_id or 0, ''))} on {_d(f.verified_at)}: "
                     f"{'verified closed' if f.status == 'verified' else 'returned'}{'. ' + e(f.backcheck_note) if f.backcheck_note else ''}</p>")
        if f.decided_at:
            body += f"<p>Decision by {e(nm.get(f.decided_by_user_id or 0, ''))} on {_d(f.decided_at)}: {e(f.decision_note)}</p>"
        body += "</div>"
    body += f"<h2>Part 4. Reviewer certification</h2><p class='cert'>{e(CERTIFICATION_TEXT)}</p>"
    body += (f"<p>Signed by <strong>{e(nm.get(r.certified_by_user_id or 0, ''))}</strong> on {_dt(r.certified_at)}.</p>"
             if r.certified_at else "<p class='muted'>Not yet certified.</p>")
    body += f"<h2>Part 5. Back-check and closure</h2><p class='cert'>{e(CLOSURE_TEXT)}</p>"
    body += (f"<p>Closed by <strong>{e(nm.get(r.closed_by_user_id or 0, ''))}</strong> on {_dt(r.closed_at)}. "
             f"Corrected version examined: {e(r.closed_version)}.</p>" if r.closed_at else "<p class='muted'>Not yet closed.</p>")
    if r.release_approved_at:
        body += (f"<p>Release with open Minor findings approved by {e(nm.get(r.release_approved_by_user_id or 0, ''))} "
                 f"on {_d(r.release_approved_at)}: {e(r.release_note)}</p>")
    tot = sum(float(x.hours or 0) for x in entries)
    body += "<h2>Hours charged to this record</h2>" + (
        _table(["Date", "Who", "Hours", "Note"],
               [[_d(x.work_date), e(nm.get(x.user_id, "")), f"{float(x.hours or 0):.2f}", e(x.note)] for x in entries],
               {2}, ["Total", "", f"{tot:.2f}", ""]) if entries else "<p class='muted'>None yet.</p>")
    body += "<h2>Record history</h2>" + _table(
        ["When", "Who", "What"], [[_dt(ev.at), e(nm.get(ev.actor_user_id or 0, "")), e(ev.detail)] for ev in events])
    return _page(f"QA/QC Record {r.record_no}", r.title, body, u)


# ----------------------------------------------------------------- summary
def _summary_rows(db: Session, project_id: int | None, date_from: date | None, date_to: date | None,
                  person_id: int | None, status: str | None):
    q = select(QaqcReview)
    if project_id:
        q = q.where(QaqcReview.project_id == project_id)
    if status in STATUS:
        q = q.where(QaqcReview.status == status)
    if date_from:
        q = q.where(QaqcReview.opened_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        q = q.where(QaqcReview.opened_at <= datetime.combine(date_to, datetime.max.time()))
    rows = db.scalars(q.order_by(QaqcReview.project_code, QaqcReview.seq)).all()
    if person_id:
        rows = [r for r in rows if person_id in (r.reviewer_user_id, r.preparer_user_id)]
    return rows


@router.get("/summary")
def report_summary(project_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
                   person_id: int | None = None, status: str | None = None, format: str = "html",
                   db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> Response:
    _require_admin(u)
    nm = _names(db)
    projects = {p.id: p.name for p in db.scalars(select(Project)).all()}
    reviews = _summary_rows(db, project_id, date_from, date_to, person_id, status)
    ids = [r.id for r in reviews]
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id.in_(ids))).all() if ids else []
    n_items = {}
    for i in (db.scalars(select(QaqcItem).where(QaqcItem.review_id.in_(ids))).all() if ids else []):
        n_items[i.review_id] = n_items.get(i.review_id, 0) + 1
    by_rev: dict[int, list[QaqcFinding]] = {}
    for f in findings:
        by_rev.setdefault(f.review_id, []).append(f)
    entries = db.scalars(select(TimeEntry).where(TimeEntry.qaqc_review_id.in_(ids))).all() if ids else []
    earlier = db.scalars(select(QaqcEarlierTime).where(QaqcEarlierTime.review_id.in_(ids))).all() if ids else []
    hrs: dict[int, float] = {}
    for x in entries:
        hrs[x.qaqc_review_id] = hrs.get(x.qaqc_review_id, 0.0) + float(x.hours or 0)
    ehrs: dict[int, float] = {}
    for x in earlier:
        ehrs[x.review_id] = ehrs.get(x.review_id, 0.0) + float(x.hours or 0)

    def counts(rid: int) -> tuple[int, int, int, int]:
        fs = by_rev.get(rid, [])
        return (sum(1 for f in fs if f.severity == "major"), sum(1 for f in fs if f.severity == "minor"),
                sum(1 for f in fs if f.severity == "observation"),
                sum(1 for f in fs if f.severity != "observation" and f.status in OPEN_FINDING))

    cols = ["Record", "Project", "Work product reviewed", "Reviewer", "Preparer", "Status", "Opened", "Certified",
            "Closed", "Items", "Major", "Minor", "Observations", "Open findings", "Hours charged", "Earlier hours (noted)"]
    data = []
    for r in reviews:
        mj, mn, ob, op = counts(r.id)
        data.append([r.record_no, projects.get(r.project_id, ""), r.title, nm.get(r.reviewer_user_id, ""),
                     nm.get(r.preparer_user_id or 0, ""), STATUS.get(r.status, r.status), _d(r.opened_at),
                     _d(r.certified_at), _d(r.closed_at), n_items.get(r.id, 0), mj, mn, ob, op,
                     round(hrs.get(r.id, 0.0), 2), round(ehrs.get(r.id, 0.0), 2)])

    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        w.writerows(data)
        stamp = datetime.utcnow().strftime("%Y-%m-%d")
        return Response(content=buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="QAQC_Summary_{stamp}.csv"'})

    filt = []
    if project_id:
        filt.append(f"Project: {projects.get(project_id, project_id)}")
    if date_from or date_to:
        filt.append(f"Opened {_d(date_from) or 'any time'} to {_d(date_to) or 'today'}")
    if person_id:
        filt.append(f"Person: {nm.get(person_id, person_id)}")
    if status in STATUS:
        filt.append(f"Status: {STATUS[status]}")
    sub = "; ".join(filt) or "All projects, all dates, all statuses"

    by_status: dict[str, int] = {}
    for r in reviews:
        by_status[r.status] = by_status.get(r.status, 0) + 1
    tot_f = [sum(c) for c in zip(*(counts(r.id) for r in reviews))] if reviews else [0, 0, 0, 0]
    body = "<h2>Summary</h2>" + _table(
        ["Records", "To complete", "In review", "Certified", "Closed", "Not a review", "Major", "Minor",
         "Open findings", "Hours charged", "Earlier hours"],
        [[str(len(reviews)), *(str(by_status.get(s, 0)) for s in ("to_complete", "open", "certified", "closed", "dismissed")),
          str(tot_f[0]), str(tot_f[1]), str(tot_f[3]), f"{sum(hrs.values()):.2f}", f"{sum(ehrs.values()):.2f}"]],
        set(range(11)))
    body += "<h2>Records</h2>" + (_table(
        ["Record", "Work product reviewed", "Reviewer", "Preparer", "Status", "Opened", "Closed", "Items",
         "Findings Maj/Min/Obs", "Open", "Hours", "Earlier hours"],
        [[f"<strong style='white-space:nowrap'>{e(d[0])}</strong><br><span class='muted'>{e(d[1])}</span>", e(d[2]), e(d[3]), e(d[4]), e(d[5]),
          e(d[6]), e(d[8]), str(d[9]), f"{d[10]}/{d[11]}/{d[12]}", str(d[13]), f"{d[14]:.2f}", f"{d[15]:.2f}"] for d in data],
        {7, 9, 10, 11}) if data else "<p class='muted'>No records match.</p>")

    today = date.today()
    open_rows = []
    rv = {r.id: r for r in reviews}
    for f in sorted(findings, key=lambda x: x.created_at):
        r = rv[f.review_id]
        if f.severity == "observation" or f.status not in OPEN_FINDING or r.status != "certified":
            continue
        days = business_days_between((r.certified_at or f.created_at).date(), today)
        open_rows.append([e(r.record_no), str(f.seq), SEV.get(f.severity, f.severity), e(f.description),
                          e(nm.get(f.assigned_user_id or 0, "")), F_STATUS.get(f.status, f.status),
                          f"<strong>{days}</strong>" if days > 10 else str(days)])
    body += "<h2>Open findings</h2>" + (_table(
        ["Record", "No.", "Severity", "Finding", "Assigned to", "Status", "Business days open"], open_rows, {1, 6})
        if open_rows else "<p class='muted'>None.</p>")

    people: dict[int, list[float]] = {}
    for x in entries:
        people.setdefault(x.user_id, [0.0, 0.0])[0] += float(x.hours or 0)
    for x in earlier:
        people.setdefault(x.user_id or 0, [0.0, 0.0])[1] += float(x.hours or 0)
    prow = [[e(nm.get(k, "")), f"{v[0]:.2f}", f"{v[1]:.2f}", f"{v[0] + v[1]:.2f}"]
            for k, v in sorted(people.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))]
    body += "<h2>QA/QC hours by person (records above)</h2>" + (_table(
        ["Person", "Charged to the records", "Earlier time noted (already billed)", "Total"], prow, {1, 2, 3},
        ["Total", f"{sum(v[0] for v in people.values()):.2f}", f"{sum(v[1] for v in people.values()):.2f}",
         f"{sum(v[0] + v[1] for v in people.values()):.2f}"]) if prow else "<p class='muted'>None.</p>")
    return _page("QA/QC Summary Report", sub, body, u, landscape=True)
