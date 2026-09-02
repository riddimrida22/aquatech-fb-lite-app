"""Employee onboarding from the Paychex `workers` API.

Pulls the roster (name, work state, DOB, hire date, SSN) and upserts encrypted
PayrollEmployee records, best-effort linking each to an app User. The dollar
endpoints (payrolls/checks) are not authorized, so 401(k)% and W-4 are NOT here —
employees set those via self-service (/payroll/me/tax-profile).

`import_workers` takes a plain list so it is testable without live Paychex;
`fetch_paychex_workers` does the live pull (prod, where Paychex is configured).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import paychex
from ..models import User
from . import crypto
from .models import PayrollEmployee


def _parse_date(s) -> date | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(str(s)[:len(fmt) + 2], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except ValueError:
        return None


def map_worker(w: dict) -> dict:
    """Paychex worker JSON -> PayrollEmployee-ish dict (pure, no DB)."""
    nm = w.get("name") or {}
    fam = (nm.get("familyName") or "").strip()
    giv = (nm.get("givenName") or "").strip()
    legal = ", ".join(p for p in (fam, giv) if p) or (w.get("legalName") or "Unknown")
    legal_id = w.get("legalId") or {}
    return {
        "legal_name": legal,
        "given": giv, "family": fam,
        "work_state": (w.get("workState") or "NY").upper()[:2],
        "dob": _parse_date(w.get("birthDate")),
        "hire_date": _parse_date(w.get("hireDate")),
        "ssn": legal_id.get("legalIdValue") if str(legal_id.get("legalIdType", "")).upper().startswith("SSN") or legal_id.get("legalIdValue") else None,
        "paychex_worker_id": w.get("workerId") or w.get("employeeId"),
    }


def _match_employee(db: Session, m: dict) -> PayrollEmployee | None:
    fam, giv = m["family"].lower(), m["given"].lower()
    for e in db.scalars(select(PayrollEmployee)):
        ln = e.legal_name.lower()
        if fam and giv and fam in ln and giv in ln:
            return e
    return None


def _match_user(db: Session, m: dict) -> User | None:
    fam, giv = m["family"].lower(), m["given"].lower()
    for u in db.scalars(select(User)):
        fn = (u.full_name or "").lower()
        if fam and giv and fam in fn and giv in fn:
            return u
    return None


def fetch_paychex_workers() -> list[dict]:
    if not paychex.is_configured():
        raise RuntimeError("Paychex is not configured on this environment")
    company = paychex.primary_company()
    if not company:
        raise RuntimeError("No Paychex company available (check scopes)")
    sc, data = paychex.api_get(f"/companies/{company.get('companyId')}/workers")
    if sc != 200:
        raise RuntimeError(f"Paychex workers returned HTTP {sc}")
    return data.get("content") if isinstance(data, dict) else (data or [])


def import_workers(db: Session, workers: list[dict], dry_run: bool = False) -> dict:
    """Upsert encrypted PayrollEmployee records from mapped workers; link users."""
    results = []
    created = updated = linked = 0
    for w in workers:
        m = map_worker(w)
        emp = _match_employee(db, m)
        action = "update" if emp else "create"
        if not dry_run:
            if not emp:
                emp = PayrollEmployee(legal_name=m["legal_name"], is_active=True)
                db.add(emp)
            emp.work_state = m["work_state"]
            if m["dob"]:
                emp.dob = m["dob"]
            if m["hire_date"]:
                emp.hire_date = m["hire_date"]
            if m["ssn"]:
                emp.ssn_enc = crypto.encrypt(m["ssn"])
            user = _match_user(db, m)
            if user and not emp.user_id:
                emp.user_id = user.id
                linked += 1
            db.flush()
        created += action == "create"
        updated += action == "update"
        results.append({
            "legal_name": m["legal_name"], "work_state": m["work_state"],
            "ssn_last4": (m["ssn"] or "")[-4:] if m["ssn"] else None,
            "dob": str(m["dob"]) if m["dob"] else None,
            "hire_date": str(m["hire_date"]) if m["hire_date"] else None,
            "action": action,
        })
    if not dry_run:
        db.commit()
    return {"dry_run": dry_run, "created": created, "updated": updated,
            "users_linked": linked, "workers": results,
            "note": "SSN stored encrypted (last-4 only shown). 401k/W-4 set by staff self-service."}
