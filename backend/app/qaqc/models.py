"""QA/QC data model (Quality Procedure QP-01).

A review is one QA/QC record (QA-<project code>-<seq>). Parts of the paper form map to:
  Part 1 review details  -> QaqcReview columns
  Part 2 items checked   -> QaqcItem
  Part 3 findings        -> QaqcFinding (resolution + back-check live on the finding)
  Part 4 certification   -> QaqcReview.certified_* (reviewer's signed-in action)
  Part 5 closure         -> QaqcReview.closed_* / release_approved_*
Every state change is written to QaqcEvent, so the record carries its own audit trail.
Attachments (mark-ups, screenshots) are stored in the DB so they survive deploys and are
captured by the nightly Postgres backup, like the BD library.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base

# to_complete: retroactive record created from earlier timesheet notes, waiting for its reviewer to
# fill it in (preparer not yet named). dismissed: the reviewer recorded that the time was not a review
# of someone else's work (kept, with the reason, for the audit trail).
REVIEW_STATUSES = ("to_complete", "open", "certified", "closed", "dismissed")
SEVERITIES = ("major", "minor", "observation")
# open -> resolved -> verified (closed) | returned (back to the preparer) ; or closed_by_decision
FINDING_STATUSES = ("open", "resolved", "returned", "verified", "closed_by_decision")


class QaqcReview(Base):
    __tablename__ = "qaqc_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    record_no: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    project_code: Mapped[str] = mapped_column(String(24), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=1)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    subtask_id: Mapped[int | None] = mapped_column(ForeignKey("subtasks.id"), nullable=True)  # the QA/QC subtask
    title: Mapped[str] = mapped_column(String(255))                       # work product reviewed
    version_reviewed: Mapped[str] = mapped_column(String(255), default="")
    preparer_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    reviewer_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    sources: Mapped[str] = mapped_column(Text, default="")                 # what it is checked against
    scope: Mapped[str] = mapped_column(Text, default="")                   # all, or sample and how chosen
    planned_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    opened_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    certified_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    certified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    certification_text: Mapped[str] = mapped_column(Text, default="")
    closed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_version: Mapped[str] = mapped_column(String(255), default="")  # corrected version examined
    closure_text: Mapped[str] = mapped_column(Text, default="")
    release_approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    release_approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    release_note: Mapped[str] = mapped_column(Text, default="")
    retroactive: Mapped[bool] = mapped_column(Boolean, default=False)   # created from earlier timesheet notes
    dismissed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dismissed_reason: Mapped[str] = mapped_column(Text, default="")


class QaqcEarlierTime(Base):
    """Earlier QA/QC time noted on a retroactive record (owner 2026-10-06: the time is already billed,
    so it is not moved or linked; the entry is copied here as a note). time_entry_id is a reference
    for traceability only; the time entry itself is never changed."""
    __tablename__ = "qaqc_earlier_time"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("qaqc_reviews.id"), index=True)
    time_entry_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    work_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    hours: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(Text, default="")
    billed: Mapped[bool] = mapped_column(Boolean, default=False)
    invoice_ref: Mapped[str] = mapped_column(String(64), default="")


class QaqcItem(Base):
    """Part 2: one item checked against one stated source."""
    __tablename__ = "qaqc_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("qaqc_reviews.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=1)
    item: Mapped[str] = mapped_column(Text, default="")          # element, location
    source: Mapped[str] = mapped_column(Text, default="")        # document, sheet, date
    value_work: Mapped[str] = mapped_column(String(255), default="")
    value_source: Mapped[str] = mapped_column(String(255), default="")
    result: Mapped[str] = mapped_column(String(16), default="agrees")  # agrees | finding
    finding_id: Mapped[int | None] = mapped_column(ForeignKey("qaqc_findings.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class QaqcFinding(Base):
    """Part 3: a finding, its resolution by the preparer and the reviewer's back-check."""
    __tablename__ = "qaqc_findings"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("qaqc_reviews.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=1)
    description: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(16), default="minor")
    action_required: Mapped[str] = mapped_column(Text, default="")
    assigned_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="open", index=True)
    resolution_note: Mapped[str] = mapped_column(Text, default="")
    resolution_version: Mapped[str] = mapped_column(String(255), default="")
    resolved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[str] = mapped_column(Text, default="")
    decided_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    backcheck_note: Mapped[str] = mapped_column(Text, default="")
    verified_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class QaqcAttachment(Base):
    __tablename__ = "qaqc_attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("qaqc_reviews.id"), index=True)
    finding_id: Mapped[int | None] = mapped_column(ForeignKey("qaqc_findings.id"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(255), default="")
    content_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    uploaded_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class QaqcEvent(Base):
    """Audit trail of the record: who did what, when."""
    __tablename__ = "qaqc_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("qaqc_reviews.id"), index=True)
    finding_id: Mapped[int | None] = mapped_column(ForeignKey("qaqc_findings.id"), nullable=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(48))
    detail: Mapped[str] = mapped_column(Text, default="")
    at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
