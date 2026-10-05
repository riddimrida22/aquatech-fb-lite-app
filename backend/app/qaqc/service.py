"""QA/QC helpers shared by the routes and the time-entry endpoints in main.py."""

from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Project, Subtask, Task, TimeEntry
from .models import QaqcEvent, QaqcReview

# A record number anywhere in a timesheet note, e.g. "QA-LTCP04-014: weir crest of JA 1-8".
RECORD_RE = re.compile(r"\bQA-([A-Z0-9][A-Z0-9-]{0,22}?)-(\d{3,4})\b", re.I)
QAQC_SUBTASK_CODE = "QAQC"
QAQC_SUBTASK_NAME = "QA/QC"


def project_code(project: Project) -> str:
    """Short code used in record numbers, from the project name before any " - " qualifier.
    One word keeps its letters/digits/hyphens and pads a single trailing digit after letters
    (LTCP4 -> LTCP04, 1539-REG -> 1539-REG). Several words become initials, keeping short
    all-caps words and the leading number of any word with digits
    (Mount Vernon Flood Study -> MVFS, BWT 1608-Jobcon -> BWT1608, Brentwood Brook -> BB)."""
    base = (project.name or "").split(" - ")[0].strip()
    words = [w for w in re.split(r"\s+", base) if re.search(r"[A-Za-z0-9]", w)]
    if len(words) <= 1:
        code = re.sub(r"[^A-Za-z0-9-]", "", base).upper().strip("-")[:20]
        m = re.fullmatch(r"([A-Z]+)(\d)", code)
        if m:
            code = f"{m.group(1)}0{m.group(2)}"
    else:
        parts = []
        for w in words:
            digits = re.match(r"\D*?(\d+)", w)
            if re.search(r"\d", w) and digits:
                parts.append(digits.group(1))
            elif w.isupper() and len(re.sub(r"[^A-Z]", "", w)) <= 5:
                parts.append(re.sub(r"[^A-Z]", "", w))
            else:
                parts.append(re.sub(r"[^A-Za-z]", "", w)[:1].upper())
        code = "".join(parts)[:12]
    return code or f"P{project.id}"


def next_record_no(db: Session, code: str) -> tuple[str, int]:
    last = db.scalar(select(func.max(QaqcReview.seq)).where(QaqcReview.project_code == code)) or 0
    seq = int(last) + 1
    return f"QA-{code}-{seq:03d}", seq


def qaqc_subtasks_for_task(db: Session, task_id: int) -> list[Subtask]:
    return list(db.scalars(select(Subtask).where(Subtask.task_id == task_id,
                                                 Subtask.is_qaqc.is_(True))).all())


def ensure_qaqc_subtask(db: Session, task: Task) -> tuple[Subtask, bool]:
    """The task's QA/QC subtask, creating "QA/QC" (code QAQC) if the task has none.
    Bill rates are set per project/task order, never per subtask, so a new subtask
    bills exactly like the task's other subtasks."""
    existing = qaqc_subtasks_for_task(db, task.id)
    if existing:
        return existing[0], False
    by_code = db.scalar(select(Subtask).where(Subtask.task_id == task.id,
                                              func.upper(Subtask.code) == QAQC_SUBTASK_CODE))
    if by_code:
        by_code.is_qaqc = True
        return by_code, True
    sub = Subtask(task_id=task.id, code=QAQC_SUBTASK_CODE, name=QAQC_SUBTASK_NAME,
                  budget_hours=0.0, budget_fee=0.0, is_qaqc=True)
    db.add(sub)
    db.flush()
    return sub, True


def link_time_entry(db: Session, entry: TimeEntry) -> None:
    """Point a time entry at the QA/QC record named in its note (same project only).
    Called on every create/update, so editing the note re-links or unlinks."""
    entry.qaqc_review_id = None
    m = RECORD_RE.search(entry.note or "")
    if not m:
        return
    rec = f"QA-{m.group(1).upper()}-{int(m.group(2)):03d}"
    review = db.scalar(select(QaqcReview).where(QaqcReview.record_no == rec,
                                                QaqcReview.project_id == entry.project_id))
    if review:
        entry.qaqc_review_id = review.id


def log_event(db: Session, review_id: int, actor_id: int | None, action: str,
              detail: str = "", finding_id: int | None = None) -> None:
    db.add(QaqcEvent(review_id=review_id, finding_id=finding_id, actor_user_id=actor_id,
                     action=action, detail=detail[:4000]))
