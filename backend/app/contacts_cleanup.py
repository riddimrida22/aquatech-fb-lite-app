"""Consolidate duplicate and remove empty BD Contact records.

Contacts (`contacts` table) are the business-development address book. Over time,
imports and manual entry leave behind (a) exact/near duplicates of the same person
and (b) empty shells with no identifying information. This module deduplicates and
prunes them **safely**, preserving every reference:

  * `pursuit_contacts.contact_id`  (NOT NULL, UNIQUE per (pursuit_id, contact_id))
  * `activities.contact_id`        (nullable)

Design goals:
  * **Pure planning, side-effect-free apply.** `plan_cleanup()` computes what would
    change from in-memory rows and is fully unit-testable; `run_cleanup()` loads the
    ORM rows, builds the plan, and (only when `apply=True`) commits it.
  * **Dry-run by default.** Nothing is deleted unless the caller opts in.
  * **Idempotent.** Running it twice is a no-op the second time.
  * **Reference-preserving.** Duplicate links/activities are repointed to the surviving
    (canonical) contact, honoring the (pursuit_id, contact_id) unique constraint.

Matching rules (see DECISIONS.md D-032):
  * Two contacts are the SAME person if they share a non-empty normalized **email**,
    OR share a non-empty normalized **full name** AND normalized **organization**.
  * The **canonical** survivor of a group is the record with the most filled fields,
    tie-broken by the lowest id (oldest). Missing fields on the survivor are filled in
    from the duplicates; distinct notes are concatenated.
  * A contact is **empty** when every text field (full_name, title, organization,
    email, phone, notes) is blank after stripping. Empty contacts are removed; any
    stray links to them are dropped and any activities pointing at them are unlinked.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Activity, Contact, PursuitContact

# Fields that carry identifying information; used for both emptiness and "richness".
_TEXT_FIELDS = ("full_name", "title", "organization", "email", "phone", "notes")


def _clean(value: str | None) -> str:
    return (value or "").strip()


def normalize_email(value: str | None) -> str:
    return _clean(value).lower()


def normalize_text(value: str | None) -> str:
    """Lower-case and collapse internal whitespace for name/org comparison."""
    return re.sub(r"\s+", " ", _clean(value)).lower()


def is_empty_contact(c: Contact) -> bool:
    """True when the contact holds no identifying information at all."""
    return not any(_clean(getattr(c, f)) for f in _TEXT_FIELDS)


def _richness(c: Contact) -> int:
    """How many identifying fields are populated (used to pick the survivor)."""
    return sum(1 for f in _TEXT_FIELDS if _clean(getattr(c, f)))


def _dup_keys(c: Contact) -> list[tuple[str, str]]:
    """The equivalence keys a (non-empty) contact participates in."""
    keys: list[tuple[str, str]] = []
    email = normalize_email(c.email)
    if email:
        keys.append(("email", email))
    name = normalize_text(c.full_name)
    if name:
        keys.append(("name_org", f"{name}|{normalize_text(c.organization)}"))
    return keys


class _UnionFind:
    def __init__(self, ids: list[int]) -> None:
        self._parent = {i: i for i in ids}

    def find(self, i: int) -> int:
        root = i
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[i] != root:  # path compression
            self._parent[i], i = root, self._parent[i]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # keep the smaller id as the root so grouping is deterministic
            lo, hi = (ra, rb) if ra < rb else (rb, ra)
            self._parent[hi] = lo


@dataclass
class MergePlan:
    canonical_id: int
    duplicate_ids: list[int]
    field_updates: dict[str, str]  # fields to write onto the canonical


@dataclass
class CleanupPlan:
    merges: list[MergePlan] = field(default_factory=list)
    empty_ids: list[int] = field(default_factory=list)

    @property
    def duplicate_ids(self) -> list[int]:
        return [d for m in self.merges for d in m.duplicate_ids]

    @property
    def is_noop(self) -> bool:
        return not self.merges and not self.empty_ids


def _choose_canonical(group: list[Contact]) -> Contact:
    # Most-populated wins; oldest (lowest id) breaks ties.
    return sorted(group, key=lambda c: (-_richness(c), c.id))[0]


def _merge_fields(canonical: Contact, dups: list[Contact]) -> dict[str, str]:
    """Compute fields to fill onto the canonical from its duplicates."""
    updates: dict[str, str] = {}

    # Fill blank single-value fields from the first duplicate that has them.
    for f in ("full_name", "title", "organization", "email", "phone"):
        if _clean(getattr(canonical, f)):
            continue
        for d in dups:
            val = _clean(getattr(d, f))
            if val:
                updates[f] = val
                break

    # Prefer a specific org_type over the default "client".
    if _clean(canonical.org_type) in ("", "client"):
        for d in dups:
            ot = _clean(d.org_type)
            if ot and ot != "client":
                updates["org_type"] = ot
                break

    # Union distinct notes (preserve order: canonical first, then duplicates).
    seen: set[str] = set()
    notes: list[str] = []
    for c in [canonical, *dups]:
        n = _clean(c.notes)
        if n and n.lower() not in seen:
            seen.add(n.lower())
            notes.append(n)
    merged_notes = "\n".join(notes)
    if merged_notes != _clean(canonical.notes):
        updates["notes"] = merged_notes

    return updates


def plan_cleanup(contacts: list[Contact]) -> CleanupPlan:
    """Compute the cleanup plan from in-memory contacts. No DB side effects."""
    plan = CleanupPlan()

    empty = [c for c in contacts if is_empty_contact(c)]
    plan.empty_ids = sorted(c.id for c in empty)
    empty_ids = set(plan.empty_ids)

    live = [c for c in contacts if c.id not in empty_ids]
    by_id = {c.id: c for c in live}

    # Union contacts that share any equivalence key.
    uf = _UnionFind([c.id for c in live])
    key_to_id: dict[tuple[str, str], int] = {}
    for c in live:
        for key in _dup_keys(c):
            if key in key_to_id:
                uf.union(key_to_id[key], c.id)
            else:
                key_to_id[key] = c.id

    groups: dict[int, list[Contact]] = defaultdict(list)
    for c in live:
        groups[uf.find(c.id)].append(c)

    for members in groups.values():
        if len(members) < 2:
            continue
        canonical = _choose_canonical(members)
        dups = [m for m in members if m.id != canonical.id]
        plan.merges.append(
            MergePlan(
                canonical_id=canonical.id,
                duplicate_ids=sorted(d.id for d in dups),
                field_updates=_merge_fields(canonical, dups),
            )
        )

    plan.merges.sort(key=lambda m: m.canonical_id)
    return plan


def _repoint_references(db: Session, canonical_id: int, duplicate_ids: list[int]) -> dict[str, int]:
    """Move pursuit links & activities from duplicates onto the canonical contact."""
    stats = {"links_repointed": 0, "links_dropped": 0, "activities_repointed": 0}

    # Pursuits the canonical is already linked to — repointing there would violate
    # the (pursuit_id, contact_id) unique constraint, so drop the duplicate link.
    existing_pursuits = set(
        db.scalars(
            select(PursuitContact.pursuit_id).where(PursuitContact.contact_id == canonical_id)
        ).all()
    )
    for link in db.scalars(
        select(PursuitContact).where(PursuitContact.contact_id.in_(duplicate_ids))
    ).all():
        if link.pursuit_id in existing_pursuits:
            db.delete(link)
            stats["links_dropped"] += 1
        else:
            link.contact_id = canonical_id
            existing_pursuits.add(link.pursuit_id)
            stats["links_repointed"] += 1

    for act in db.scalars(
        select(Activity).where(Activity.contact_id.in_(duplicate_ids))
    ).all():
        act.contact_id = canonical_id
        stats["activities_repointed"] += 1

    return stats


def _drop_empty_references(db: Session, empty_ids: list[int]) -> dict[str, int]:
    """Empty contacts carry no data worth keeping — drop their links, unlink activities."""
    stats = {"links_dropped": 0, "activities_unlinked": 0}
    for link in db.scalars(
        select(PursuitContact).where(PursuitContact.contact_id.in_(empty_ids))
    ).all():
        db.delete(link)
        stats["links_dropped"] += 1
    for act in db.scalars(
        select(Activity).where(Activity.contact_id.in_(empty_ids))
    ).all():
        act.contact_id = None
        stats["activities_unlinked"] += 1
    return stats


def run_cleanup(db: Session, apply: bool = False) -> dict:
    """Plan (and optionally apply) the contact cleanup. Returns a report dict."""
    contacts = db.scalars(select(Contact)).all()
    plan = plan_cleanup(contacts)

    report: dict = {
        "applied": bool(apply),
        "total_contacts": len(contacts),
        "empty_removed": len(plan.empty_ids),
        "duplicate_groups": len(plan.merges),
        "duplicates_removed": len(plan.duplicate_ids),
        "remaining_contacts": len(contacts) - len(plan.empty_ids) - len(plan.duplicate_ids),
        "links_repointed": 0,
        "links_dropped": 0,
        "activities_repointed": 0,
        "activities_unlinked": 0,
        "empty_ids": plan.empty_ids,
        "merges": [
            {
                "canonical_id": m.canonical_id,
                "duplicate_ids": m.duplicate_ids,
                "field_updates": m.field_updates,
            }
            for m in plan.merges
        ],
    }

    if not apply or plan.is_noop:
        return report

    by_id = {c.id: c for c in contacts}

    for m in plan.merges:
        ref = _repoint_references(db, m.canonical_id, m.duplicate_ids)
        report["links_repointed"] += ref["links_repointed"]
        report["links_dropped"] += ref["links_dropped"]
        report["activities_repointed"] += ref["activities_repointed"]
        canonical = by_id[m.canonical_id]
        for f, val in m.field_updates.items():
            setattr(canonical, f, val)
        for dup_id in m.duplicate_ids:
            db.delete(by_id[dup_id])

    if plan.empty_ids:
        ref = _drop_empty_references(db, plan.empty_ids)
        report["links_dropped"] += ref["links_dropped"]
        report["activities_unlinked"] += ref["activities_unlinked"]
        for eid in plan.empty_ids:
            db.delete(by_id[eid])

    db.commit()
    return report
