"""QA/QC review API (Quality Procedure QP-01).

Workflow:  open (reviewer records items + findings)
        -> certified (reviewer's signed-in certification; findings go to the preparer)
        -> closed (every Major/Minor finding back-checked or closed by decision).

Who may do what:
  * any signed-in user: view records, open a record (they become the reviewer unless an
    admin names another reviewer), resolve findings assigned to them or on work they prepared
  * the reviewer: edit Parts 1-3 while open, certify, back-check, close. Certification,
    back-check and closure are the reviewer's own signed-in acts; nobody does them for them
  * MANAGE_PROJECTS (PM/admin): edit any open record, decide disputed findings
  * admin: approve release with open Minor findings (the Principal's approval)
Time entries are linked by the record number in their note (service.link_time_entry).
Staff see only their own linked hours (D-023); admins see everyone's.
"""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..authz import get_current_user, permissions_for_role
from ..db import get_db
from ..models import Project, Subtask, Task, TimeEntry, User
from . import service
from .models import (FINDING_STATUSES, SEVERITIES, QaqcAttachment, QaqcEvent, QaqcFinding, QaqcItem,
                     QaqcReview)

router = APIRouter(prefix="/qaqc", tags=["qaqc"])

MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
CERTIFICATION_TEXT = ("I certify that I performed the review described in this record, that the items listed "
                      "in Part 2 were checked against the sources stated, that Part 3 lists every finding I "
                      "identified, and that I did not prepare the work reviewed.")
CLOSURE_TEXT = ("I certify that I have examined the corrected work identified in this record and that each "
                "Major and Minor finding in Part 3 is verified closed or closed by the recorded decision of "
                "the Project Manager or Principal.")
OPEN_FINDING = ("open", "resolved", "returned")


# ----------------------------------------------------------------- permissions
def _is_pm(u: User) -> bool:
    return "MANAGE_PROJECTS" in permissions_for_role(u.role)


def _is_admin(u: User) -> bool:
    return u.role == "admin"


def _review_or_404(db: Session, review_id: int) -> QaqcReview:
    r = db.get(QaqcReview, review_id)
    if not r:
        raise HTTPException(status_code=404, detail="QA/QC record not found")
    return r


def _require_editable(r: QaqcReview, u: User) -> None:
    if r.status != "open":
        raise HTTPException(status_code=409, detail="The record has been certified; Parts 1-3 can no longer be "
                                                    "changed. Open a new record for further findings.")
    if u.id != r.reviewer_user_id and not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only the reviewer (or a PM/admin) can edit this record.")


def _require_reviewer(r: QaqcReview, u: User, what: str) -> None:
    if u.id != r.reviewer_user_id:
        raise HTTPException(status_code=403, detail=f"Only the named reviewer can {what}.")


# ----------------------------------------------------------------- serializers
def _names(db: Session) -> dict[int, str]:
    return {u.id: u.full_name for u in db.scalars(select(User)).all()}


def _iso(x) -> str | None:
    return x.isoformat() if x else None


def _finding_out(f: QaqcFinding, nm: dict[int, str]) -> dict:
    return {
        "id": f.id, "seq": f.seq, "description": f.description, "evidence": f.evidence,
        "severity": f.severity, "action_required": f.action_required,
        "assigned_user_id": f.assigned_user_id, "assigned_name": nm.get(f.assigned_user_id or 0),
        "status": f.status,
        "resolution_note": f.resolution_note, "resolution_version": f.resolution_version,
        "resolved_by": nm.get(f.resolved_by_user_id or 0), "resolved_at": _iso(f.resolved_at),
        "decision_note": f.decision_note, "decided_by": nm.get(f.decided_by_user_id or 0),
        "decided_at": _iso(f.decided_at),
        "backcheck_note": f.backcheck_note, "verified_by": nm.get(f.verified_by_user_id or 0),
        "verified_at": _iso(f.verified_at), "created_at": _iso(f.created_at),
    }


def _review_summary(db: Session, r: QaqcReview, nm: dict[int, str], projects: dict[int, str]) -> dict:
    fs = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id)).all()
    n_items = db.scalar(select(func.count(QaqcItem.id)).where(QaqcItem.review_id == r.id)) or 0
    return {
        "id": r.id, "record_no": r.record_no, "project_id": r.project_id,
        "project_name": projects.get(r.project_id), "task_id": r.task_id,
        "title": r.title, "status": r.status,
        "preparer_name": nm.get(r.preparer_user_id or 0), "reviewer_name": nm.get(r.reviewer_user_id),
        "preparer_user_id": r.preparer_user_id, "reviewer_user_id": r.reviewer_user_id,
        "opened_at": _iso(r.opened_at), "certified_at": _iso(r.certified_at), "closed_at": _iso(r.closed_at),
        "items": int(n_items), "findings": len(fs),
        "open_major": sum(1 for f in fs if f.severity == "major" and f.status in OPEN_FINDING),
        "open_minor": sum(1 for f in fs if f.severity == "minor" and f.status in OPEN_FINDING),
        "awaiting_backcheck": sum(1 for f in fs if f.status == "resolved"),
    }


# ----------------------------------------------------------------- reference data
@router.get("/meta")
def qaqc_meta(db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> dict:
    users = db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.full_name)).all()
    projects = db.scalars(select(Project).where(Project.is_overhead.is_(False))
                          .order_by(Project.is_active.desc(), Project.name)).all()
    return {
        "me": {"id": u.id, "name": u.full_name, "is_pm": _is_pm(u), "is_admin": _is_admin(u)},
        "users": [{"id": x.id, "name": x.full_name} for x in users
                  if not any(t in (x.full_name or "").lower() for t in ("test employee", "(qa)"))],
        "projects": [{"id": p.id, "name": p.name, "active": bool(p.is_active), "code": service.project_code(p)}
                     for p in projects],
        "severities": list(SEVERITIES), "finding_statuses": list(FINDING_STATUSES),
        "certification_text": CERTIFICATION_TEXT, "closure_text": CLOSURE_TEXT,
    }


@router.get("/projects/{project_id}/tasks")
def qaqc_project_tasks(project_id: int, db: Session = Depends(get_db),
                       _: User = Depends(get_current_user)) -> list[dict]:
    tasks = db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.id)).all()
    out = []
    for t in tasks:
        q = service.qaqc_subtasks_for_task(db, t.id)
        out.append({"id": t.id, "name": t.name,
                    "qaqc_subtask": ({"id": q[0].id, "code": q[0].code, "name": q[0].name} if q else None)})
    return out


@router.get("/open-records")
def qaqc_open_records(project_id: int, db: Session = Depends(get_db),
                      _: User = Depends(get_current_user)) -> list[dict]:
    """Records time can still be charged to (not closed), for the timesheet picker."""
    rows = db.scalars(select(QaqcReview).where(QaqcReview.project_id == project_id,
                                               QaqcReview.status != "closed")
                      .order_by(QaqcReview.seq.desc())).all()
    return [{"id": r.id, "record_no": r.record_no, "title": r.title, "task_id": r.task_id,
             "status": r.status} for r in rows]


class SubtaskFlagIn(BaseModel):
    is_qaqc: bool


@router.put("/subtasks/{subtask_id}/flag")
def qaqc_flag_subtask(subtask_id: int, payload: SubtaskFlagIn, db: Session = Depends(get_db),
                      u: User = Depends(get_current_user)) -> dict:
    """Mark an existing subtask (e.g. a fee-sheet QA/QC line) as a QA/QC subtask."""
    if not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only a PM/admin can change subtask settings.")
    s = db.get(Subtask, subtask_id)
    if not s:
        raise HTTPException(status_code=404, detail="Subtask not found")
    s.is_qaqc = payload.is_qaqc
    db.commit()
    return {"id": s.id, "is_qaqc": s.is_qaqc}


# ----------------------------------------------------------------- records
@router.get("/reviews")
def qaqc_list(project_id: int | None = None, status: str | None = None, mine: bool = False,
              db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> list[dict]:
    q = select(QaqcReview)
    if project_id:
        q = q.where(QaqcReview.project_id == project_id)
    if status in ("open", "certified", "closed"):
        q = q.where(QaqcReview.status == status)
    rows = db.scalars(q.order_by(QaqcReview.opened_at.desc())).all()
    if mine:
        assigned = set(db.scalars(select(QaqcFinding.review_id)
                                  .where(QaqcFinding.assigned_user_id == u.id)).all())
        rows = [r for r in rows if u.id in (r.reviewer_user_id, r.preparer_user_id) or r.id in assigned]
    nm = _names(db)
    projects = {p.id: p.name for p in db.scalars(select(Project)).all()}
    return [_review_summary(db, r, nm, projects) for r in rows]


class ReviewIn(BaseModel):
    project_id: int
    task_id: int
    title: str = Field(min_length=3, max_length=255)
    version_reviewed: str = ""
    preparer_user_id: int | None = None
    reviewer_user_id: int | None = None
    sources: str = ""
    scope: str = ""
    planned_hours: float | None = None


def _check_people(preparer_id: int | None, reviewer_id: int) -> None:
    if preparer_id and preparer_id == reviewer_id:
        raise HTTPException(status_code=400, detail="The reviewer cannot be the preparer of the work (QP-01).")


@router.post("/reviews")
def qaqc_create(payload: ReviewIn, db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> dict:
    project = db.get(Project, payload.project_id)
    task = db.get(Task, payload.task_id)
    if not project or not task or task.project_id != project.id:
        raise HTTPException(status_code=400, detail="Pick a project and one of its tasks.")
    reviewer_id = payload.reviewer_user_id or u.id
    if reviewer_id != u.id and not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only a PM/admin can open a record for another reviewer.")
    _check_people(payload.preparer_user_id, reviewer_id)
    sub, created = service.ensure_qaqc_subtask(db, task)
    code = service.project_code(project)
    rec, seq = service.next_record_no(db, code)
    r = QaqcReview(record_no=rec, project_code=code, seq=seq, project_id=project.id, task_id=task.id,
                   subtask_id=sub.id, title=payload.title.strip(), version_reviewed=payload.version_reviewed.strip(),
                   preparer_user_id=payload.preparer_user_id, reviewer_user_id=reviewer_id,
                   sources=payload.sources.strip(), scope=payload.scope.strip(),
                   planned_hours=payload.planned_hours, status="open", opened_by_user_id=u.id)
    db.add(r)
    db.flush()
    service.log_event(db, r.id, u.id, "opened", f"{rec} opened: {r.title}")
    if created:
        service.log_event(db, r.id, u.id, "qaqc_subtask",
                          f"QA/QC subtask '{sub.name}' ({sub.code}) set up on task '{task.name}'")
    db.commit()
    return qaqc_get(r.id, db, u)


@router.get("/reviews/{review_id}")
def qaqc_get(review_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    nm = _names(db)
    project = db.get(Project, r.project_id)
    task = db.get(Task, r.task_id) if r.task_id else None
    sub = db.get(Subtask, r.subtask_id) if r.subtask_id else None
    items = db.scalars(select(QaqcItem).where(QaqcItem.review_id == r.id).order_by(QaqcItem.seq)).all()
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id).order_by(QaqcFinding.seq)).all()
    atts = db.scalars(select(QaqcAttachment).where(QaqcAttachment.review_id == r.id)
                      .order_by(QaqcAttachment.created_at)).all()
    events = db.scalars(select(QaqcEvent).where(QaqcEvent.review_id == r.id).order_by(QaqcEvent.at)).all()
    te_q = select(TimeEntry).where(TimeEntry.qaqc_review_id == r.id)
    see_all = _is_pm(u)
    if not see_all:
        te_q = te_q.where(TimeEntry.user_id == u.id)
    entries = db.scalars(te_q.order_by(TimeEntry.work_date)).all()
    fby = {f.id: f.seq for f in findings}
    return {
        "review": {
            **_review_summary(db, r, nm, {r.project_id: project.name if project else ""}),
            "project_code": r.project_code, "task_name": task.name if task else None,
            "subtask": ({"id": sub.id, "code": sub.code, "name": sub.name} if sub else None),
            "version_reviewed": r.version_reviewed, "sources": r.sources, "scope": r.scope,
            "planned_hours": r.planned_hours,
            "opened_by": nm.get(r.opened_by_user_id or 0),
            "certified_by": nm.get(r.certified_by_user_id or 0), "certification_text": r.certification_text,
            "closed_by": nm.get(r.closed_by_user_id or 0), "closed_version": r.closed_version,
            "closure_text": r.closure_text,
            "release_approved_by": nm.get(r.release_approved_by_user_id or 0),
            "release_approved_at": _iso(r.release_approved_at), "release_note": r.release_note,
        },
        "items": [{"id": i.id, "seq": i.seq, "item": i.item, "source": i.source, "value_work": i.value_work,
                   "value_source": i.value_source, "result": i.result, "finding_id": i.finding_id,
                   "finding_seq": fby.get(i.finding_id or 0)} for i in items],
        "findings": [_finding_out(f, nm) for f in findings],
        "attachments": [{"id": a.id, "finding_id": a.finding_id, "finding_seq": fby.get(a.finding_id or 0),
                         "filename": a.filename, "size_bytes": a.size_bytes,
                         "uploaded_by": nm.get(a.uploaded_by_user_id or 0), "created_at": _iso(a.created_at)}
                        for a in atts],
        "events": [{"at": _iso(e.at), "who": nm.get(e.actor_user_id or 0), "action": e.action, "detail": e.detail,
                    "finding_seq": fby.get(e.finding_id or 0)} for e in events],
        "time": {
            "scope": "all" if see_all else "mine",
            "hours": round(sum(float(e.hours or 0) for e in entries), 2),
            "entries": [{"id": e.id, "work_date": _iso(e.work_date), "who": nm.get(e.user_id),
                         "hours": float(e.hours or 0), "note": e.note} for e in entries],
        },
        "permissions": {
            "can_edit": r.status == "open" and (u.id == r.reviewer_user_id or _is_pm(u)),
            "is_reviewer": u.id == r.reviewer_user_id,
            "is_preparer": u.id == r.preparer_user_id,
            "is_pm": _is_pm(u), "is_admin": _is_admin(u), "me": u.id,
        },
    }


@router.put("/reviews/{review_id}")
def qaqc_update(review_id: int, payload: ReviewIn, db: Session = Depends(get_db),
                u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    reviewer_id = payload.reviewer_user_id or r.reviewer_user_id
    if reviewer_id != r.reviewer_user_id and not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only a PM/admin can change the reviewer.")
    _check_people(payload.preparer_user_id, reviewer_id)
    if payload.task_id != r.task_id:
        task = db.get(Task, payload.task_id)
        if not task or task.project_id != r.project_id:
            raise HTTPException(status_code=400, detail="The task must belong to the record's project.")
        sub, _c = service.ensure_qaqc_subtask(db, task)
        r.task_id, r.subtask_id = task.id, sub.id
    r.title = payload.title.strip()
    r.version_reviewed = payload.version_reviewed.strip()
    r.preparer_user_id = payload.preparer_user_id
    r.reviewer_user_id = reviewer_id
    r.sources, r.scope, r.planned_hours = payload.sources.strip(), payload.scope.strip(), payload.planned_hours
    service.log_event(db, r.id, u.id, "details_updated", "Part 1 updated")
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- Part 2 items
class ItemIn(BaseModel):
    item: str = ""
    source: str = ""
    value_work: str = ""
    value_source: str = ""
    result: str = "agrees"
    finding_id: int | None = None


def _apply_item(db: Session, r: QaqcReview, it: QaqcItem, p: ItemIn) -> None:
    if p.result not in ("agrees", "finding"):
        raise HTTPException(status_code=400, detail="Result must be Agrees or Finding.")
    if p.finding_id:
        f = db.get(QaqcFinding, p.finding_id)
        if not f or f.review_id != r.id:
            raise HTTPException(status_code=400, detail="That finding is not on this record.")
    it.item, it.source = p.item.strip(), p.source.strip()
    it.value_work, it.value_source = p.value_work.strip()[:255], p.value_source.strip()[:255]
    it.result = p.result
    it.finding_id = p.finding_id if p.result == "finding" else None


@router.post("/reviews/{review_id}/items")
def qaqc_add_item(review_id: int, payload: ItemIn, db: Session = Depends(get_db),
                  u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    seq = (db.scalar(select(func.max(QaqcItem.seq)).where(QaqcItem.review_id == r.id)) or 0) + 1
    it = QaqcItem(review_id=r.id, seq=seq)
    _apply_item(db, r, it, payload)
    db.add(it)
    db.commit()
    return qaqc_get(r.id, db, u)


@router.put("/reviews/{review_id}/items/{item_id}")
def qaqc_update_item(review_id: int, item_id: int, payload: ItemIn, db: Session = Depends(get_db),
                     u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    it = db.get(QaqcItem, item_id)
    if not it or it.review_id != r.id:
        raise HTTPException(status_code=404, detail="Item not found")
    _apply_item(db, r, it, payload)
    db.commit()
    return qaqc_get(r.id, db, u)


@router.delete("/reviews/{review_id}/items/{item_id}")
def qaqc_delete_item(review_id: int, item_id: int, db: Session = Depends(get_db),
                     u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    it = db.get(QaqcItem, item_id)
    if not it or it.review_id != r.id:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(it)
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- Part 3 findings
class FindingIn(BaseModel):
    description: str = Field(min_length=3)
    evidence: str = ""
    severity: str = "minor"
    action_required: str = ""
    assigned_user_id: int | None = None


def _apply_finding(f: QaqcFinding, p: FindingIn) -> None:
    if p.severity not in SEVERITIES:
        raise HTTPException(status_code=400, detail="Severity must be Major, Minor or Observation.")
    f.description, f.evidence = p.description.strip(), p.evidence.strip()
    f.severity, f.action_required = p.severity, p.action_required.strip()
    f.assigned_user_id = p.assigned_user_id


@router.post("/reviews/{review_id}/findings")
def qaqc_add_finding(review_id: int, payload: FindingIn, db: Session = Depends(get_db),
                     u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    seq = (db.scalar(select(func.max(QaqcFinding.seq)).where(QaqcFinding.review_id == r.id)) or 0) + 1
    f = QaqcFinding(review_id=r.id, seq=seq, status="open",
                    assigned_user_id=payload.assigned_user_id or r.preparer_user_id)
    _apply_finding(f, payload)
    if not payload.assigned_user_id:
        f.assigned_user_id = r.preparer_user_id
    db.add(f)
    db.flush()
    service.log_event(db, r.id, u.id, "finding_added", f"Finding {seq} ({f.severity}): {f.description[:200]}", f.id)
    db.commit()
    return qaqc_get(r.id, db, u)


@router.put("/reviews/{review_id}/findings/{finding_id}")
def qaqc_update_finding(review_id: int, finding_id: int, payload: FindingIn, db: Session = Depends(get_db),
                        u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    f = db.get(QaqcFinding, finding_id)
    if not f or f.review_id != r.id:
        raise HTTPException(status_code=404, detail="Finding not found")
    _apply_finding(f, payload)
    db.commit()
    return qaqc_get(r.id, db, u)


@router.delete("/reviews/{review_id}/findings/{finding_id}")
def qaqc_delete_finding(review_id: int, finding_id: int, db: Session = Depends(get_db),
                        u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    _require_editable(r, u)
    f = db.get(QaqcFinding, finding_id)
    if not f or f.review_id != r.id:
        raise HTTPException(status_code=404, detail="Finding not found")
    for it in db.scalars(select(QaqcItem).where(QaqcItem.finding_id == f.id)).all():
        it.finding_id, it.result = None, "agrees"
    for a in db.scalars(select(QaqcAttachment).where(QaqcAttachment.finding_id == f.id)).all():
        a.finding_id = None
    for e in db.scalars(select(QaqcEvent).where(QaqcEvent.finding_id == f.id)).all():
        e.finding_id = None
    service.log_event(db, r.id, u.id, "finding_removed", f"Finding {f.seq} removed before certification")
    db.delete(f)
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- Part 4 certification
@router.post("/reviews/{review_id}/certify")
def qaqc_certify(review_id: int, db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    if r.status != "open":
        raise HTTPException(status_code=409, detail="This record is already certified.")
    _require_reviewer(r, u, "certify the review")
    if u.id == r.preparer_user_id:
        raise HTTPException(status_code=400, detail="The reviewer cannot be the preparer of the work.")
    n_items = db.scalar(select(func.count(QaqcItem.id)).where(QaqcItem.review_id == r.id)) or 0
    if not n_items:
        raise HTTPException(status_code=400, detail="List at least one item checked (Part 2) before certifying.")
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id)).all()
    if any(f.severity != "observation" for f in findings) and not r.preparer_user_id:
        raise HTTPException(status_code=400, detail="Name the preparer (Part 1) so findings can be resolved.")
    r.status = "certified"
    r.certified_by_user_id, r.certified_at = u.id, datetime.utcnow()
    r.certification_text = CERTIFICATION_TEXT
    # Observations need no correction (QP-01 section 4): they never hold the record open.
    for f in findings:
        if f.severity == "observation" and f.status == "open":
            f.status = "closed_by_decision"
            f.decision_note = "Observation: no correction required."
            f.decided_by_user_id, f.decided_at = u.id, r.certified_at
    service.log_event(db, r.id, u.id, "certified",
                      f"Certified by the reviewer: {n_items} item{'s' if n_items != 1 else ''} checked, "
                      f"{len(findings)} finding{'s' if len(findings) != 1 else ''}")
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- resolution / decision / back-check
class ResolveIn(BaseModel):
    note: str = Field(min_length=3)
    version: str = ""


def _finding_for(db: Session, r: QaqcReview, finding_id: int) -> QaqcFinding:
    f = db.get(QaqcFinding, finding_id)
    if not f or f.review_id != r.id:
        raise HTTPException(status_code=404, detail="Finding not found")
    if r.status != "certified":
        raise HTTPException(status_code=409, detail="Findings are worked only after certification and before "
                                                    "closure.")
    return f


@router.post("/reviews/{review_id}/findings/{finding_id}/resolve")
def qaqc_resolve(review_id: int, finding_id: int, payload: ResolveIn, db: Session = Depends(get_db),
                 u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    f = _finding_for(db, r, finding_id)
    if u.id not in (f.assigned_user_id, r.preparer_user_id) and not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only the person assigned (or the preparer) can record the "
                                                    "resolution.")
    if f.status not in ("open", "returned"):
        raise HTTPException(status_code=409, detail="This finding is not awaiting resolution.")
    f.status = "resolved"
    f.resolution_note, f.resolution_version = payload.note.strip(), payload.version.strip()
    f.resolved_by_user_id, f.resolved_at = u.id, datetime.utcnow()
    service.log_event(db, r.id, u.id, "resolved", f"Finding {f.seq} resolved: {f.resolution_note[:300]}", f.id)
    db.commit()
    return qaqc_get(r.id, db, u)


class DecideIn(BaseModel):
    note: str = Field(min_length=3)


@router.post("/reviews/{review_id}/findings/{finding_id}/decide")
def qaqc_decide(review_id: int, finding_id: int, payload: DecideIn, db: Session = Depends(get_db),
                u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    f = _finding_for(db, r, finding_id)
    if not _is_pm(u):
        raise HTTPException(status_code=403, detail="Only the Project Manager or Principal can decide a finding.")
    if f.status in ("verified", "closed_by_decision"):
        raise HTTPException(status_code=409, detail="This finding is already closed.")
    f.status = "closed_by_decision"
    f.decision_note = payload.note.strip()
    f.decided_by_user_id, f.decided_at = u.id, datetime.utcnow()
    service.log_event(db, r.id, u.id, "decided", f"Finding {f.seq} closed by decision: {f.decision_note[:300]}", f.id)
    db.commit()
    return qaqc_get(r.id, db, u)


class BackcheckIn(BaseModel):
    verified: bool
    note: str = ""


@router.post("/reviews/{review_id}/findings/{finding_id}/backcheck")
def qaqc_backcheck(review_id: int, finding_id: int, payload: BackcheckIn, db: Session = Depends(get_db),
                   u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    f = _finding_for(db, r, finding_id)
    _require_reviewer(r, u, "back-check a finding")
    if f.status != "resolved":
        raise HTTPException(status_code=409, detail="Only a resolved finding can be back-checked.")
    if not payload.verified and len(payload.note.strip()) < 3:
        raise HTTPException(status_code=400, detail="Say what is still wrong when returning a finding.")
    f.backcheck_note = payload.note.strip()
    f.verified_by_user_id, f.verified_at = u.id, datetime.utcnow()
    f.status = "verified" if payload.verified else "returned"
    service.log_event(db, r.id, u.id, "verified" if payload.verified else "returned",
                      f"Finding {f.seq} {'verified closed' if payload.verified else 'returned'}"
                      + (f": {f.backcheck_note[:300]}" if f.backcheck_note else ""), f.id)
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- Part 5 closure / release
class CloseIn(BaseModel):
    version_examined: str = Field(min_length=1)


@router.post("/reviews/{review_id}/close")
def qaqc_close(review_id: int, payload: CloseIn, db: Session = Depends(get_db),
               u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    if r.status != "certified":
        raise HTTPException(status_code=409, detail="Only a certified, open record can be closed.")
    _require_reviewer(r, u, "close the record")
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id)).all()
    blocking = [f.seq for f in findings if f.severity in ("major", "minor")
                and f.status not in ("verified", "closed_by_decision")]
    if blocking:
        raise HTTPException(status_code=409, detail="These findings are not yet verified closed: "
                                                    + ", ".join(str(s) for s in blocking))
    r.status = "closed"
    r.closed_by_user_id, r.closed_at = u.id, datetime.utcnow()
    r.closed_version, r.closure_text = payload.version_examined.strip(), CLOSURE_TEXT
    service.log_event(db, r.id, u.id, "closed", f"Closed by the reviewer; corrected version examined: "
                                               f"{r.closed_version}")
    db.commit()
    return qaqc_get(r.id, db, u)


class ReleaseIn(BaseModel):
    note: str = Field(min_length=3)


@router.post("/reviews/{review_id}/approve-release")
def qaqc_approve_release(review_id: int, payload: ReleaseIn, db: Session = Depends(get_db),
                         u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    if not _is_admin(u):
        raise HTTPException(status_code=403, detail="Only the Principal can approve release with open findings.")
    findings = db.scalars(select(QaqcFinding).where(QaqcFinding.review_id == r.id)).all()
    if any(f.severity == "major" and f.status not in ("verified", "closed_by_decision") for f in findings):
        raise HTTPException(status_code=409, detail="No release while a Major finding is open (QP-01 5.7).")
    r.release_approved_by_user_id, r.release_approved_at = u.id, datetime.utcnow()
    r.release_note = payload.note.strip()
    service.log_event(db, r.id, u.id, "release_approved", f"Release with open Minor findings approved: "
                                                         f"{r.release_note[:300]}")
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- attachments
@router.post("/reviews/{review_id}/attachments")
async def qaqc_upload(review_id: int, file: UploadFile = File(...), finding_id: str = Form(""),
                      db: Session = Depends(get_db), u: User = Depends(get_current_user)) -> dict:
    r = _review_or_404(db, review_id)
    if r.status == "closed":
        raise HTTPException(status_code=409, detail="The record is closed.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 25 MB limit.")
    fid = int(finding_id) if finding_id.strip().isdigit() else None
    if fid:
        f = db.get(QaqcFinding, fid)
        if not f or f.review_id != r.id:
            raise HTTPException(status_code=400, detail="That finding is not on this record.")
    a = QaqcAttachment(review_id=r.id, finding_id=fid, filename=(file.filename or "file")[:255],
                       content_type=(file.content_type or "application/octet-stream")[:128],
                       size_bytes=len(raw), content=raw, uploaded_by_user_id=u.id)
    db.add(a)
    db.flush()
    service.log_event(db, r.id, u.id, "attachment", f"Attached {a.filename}", fid)
    db.commit()
    return qaqc_get(r.id, db, u)


@router.get("/attachments/{attachment_id}")
def qaqc_download(attachment_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    a = db.get(QaqcAttachment, attachment_id)
    if not a or a.content is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    safe = (a.filename or "attachment").replace('"', "").replace("\n", "")
    return Response(content=a.content, media_type=a.content_type or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"'})


@router.delete("/attachments/{attachment_id}")
def qaqc_delete_attachment(attachment_id: int, db: Session = Depends(get_db),
                           u: User = Depends(get_current_user)) -> dict:
    a = db.get(QaqcAttachment, attachment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Attachment not found")
    r = _review_or_404(db, a.review_id)
    if r.status != "open" or (u.id != a.uploaded_by_user_id and not _is_pm(u)):
        raise HTTPException(status_code=403, detail="Attachments can be removed only by the uploader while the "
                                                    "record is open.")
    service.log_event(db, r.id, u.id, "attachment_removed", f"Removed {a.filename}")
    db.delete(a)
    db.commit()
    return qaqc_get(r.id, db, u)


# ----------------------------------------------------------------- findings log
@router.get("/findings/open")
def qaqc_open_findings(project_id: int | None = None, db: Session = Depends(get_db),
                       _: User = Depends(get_current_user)) -> list[dict]:
    """The findings log (QP-01 section 7): every finding not yet closed, oldest first."""
    q = (select(QaqcFinding, QaqcReview).join(QaqcReview, QaqcReview.id == QaqcFinding.review_id)
         .where(QaqcFinding.status.in_(OPEN_FINDING), QaqcFinding.severity != "observation",
                QaqcReview.status == "certified"))
    if project_id:
        q = q.where(QaqcReview.project_id == project_id)
    nm = _names(db)
    today = date.today()
    out = []
    for f, r in db.execute(q.order_by(QaqcFinding.created_at)).all():
        raised = (r.certified_at or f.created_at).date()
        out.append({"review_id": r.id, "record_no": r.record_no, "title": r.title, "finding_id": f.id,
                    "seq": f.seq, "severity": f.severity, "status": f.status, "description": f.description,
                    "assigned_name": nm.get(f.assigned_user_id or 0), "raised": raised.isoformat(),
                    "business_days_open": business_days_between(raised, today)})
    return out


def business_days_between(a: date, b: date) -> int:
    if b <= a:
        return 0
    days = (b - a).days
    weeks, rem = divmod(days, 7)
    n = weeks * 5
    for i in range(1, rem + 1):
        if (a.weekday() + i) % 7 < 5:
            n += 1
    return n
