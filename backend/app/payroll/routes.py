"""Payroll API (owner-only: MANAGE_PAYROLL).

Endpoints for the run workflow (preview -> create -> approve -> pay), employee
onboarding, and pay-stub PDFs. Computation is delegated to the engine/service;
these routes handle persistence, auth (dual-control), and serialization.
"""

from __future__ import annotations

import json
import tempfile
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..authz import get_current_user, require_permission
from ..db import get_db
from ..models import User
from . import crypto, onboarding, service
from .engine import EmployeeInput, EmployeeResult, cents
from .models import PayrollEmployee, PayrollLine, PayrollRun, PayrollYtd
from .stubs import render_stub_pdf

router = APIRouter(prefix="/payroll", tags=["payroll"])
PERM = require_permission("MANAGE_PAYROLL")

# Verified 2026 roster (name, rate, state, nyc, w4) for one-click seeding.
_SAMPLE = [
    ("Byrne, Dr Bertrand", 99.23, "NY", False, {"filing_status": "single"}),
    ("Gilliam, Zachary", 53.00, "NY", False, {"filing_status": "single", "ny_exemptions": 2}),
    ("Hodge, Stacey", 52.50, "NY", True, {"filing_status": "mfj", "ny_marital": "married", "ny_exemptions": 6, "nyc_marital": "single", "nyc_allowances": 0}),
    ("Svadlenka, Robert", 61.50, "NY", False, {"filing_status": "single", "ny_exemptions": 2}),
    ("Wang, Ruoqian", 90.00, "NJ", False, {"filing_status": "single", "extra_per_period": 38.16}),
    ("Welch Gilliam, Ailsa", 78.50, "NY", False, {"filing_status": "single"}),
]


def _f(x) -> float:
    return float(Decimal(str(x or 0)))


# ----------------------------------------------------------------- schemas
class Entry(BaseModel):
    employee_id: int
    hours: float = 0.0
    gross: float | None = None  # override (salary/bonus) if set


class PreviewIn(BaseModel):
    period_start: date
    period_end: date
    check_date: date
    weeks: int = 2
    entries: list[Entry]


class EmployeeIn(BaseModel):
    legal_name: str
    pay_rate: float = 0.0
    work_state: str = "NY"
    nyc_resident: bool = False
    k401_deferral_pct: float = 0.0
    k401_er_match_pct: float = 4.0
    fed_filing_status: str = "single"
    state_allowances: int = 0


# ----------------------------------------------------------------- helpers
def _ytd_gross(db: Session, employee_id: int, tax_year: int) -> float:
    row = db.scalar(select(PayrollYtd).where(PayrollYtd.employee_id == employee_id,
                                             PayrollYtd.tax_year == tax_year))
    return float(row.ytd_gross) if row else 0.0


def _emp_to_input(emp: PayrollEmployee, hours: float, gross: float | None,
                  ytd_gross: float = 0.0) -> EmployeeInput:
    g = Decimal(str(gross)) if gross is not None else Decimal(str(emp.pay_rate)) * Decimal(str(hours))
    w4 = {
        "filing_status": emp.fed_filing_status,
        "step2": emp.fed_multiple_jobs,
        "dependents_annual": emp.fed_dependents_amt,
        "extra_per_period": emp.fed_extra_withholding,
        "ny_marital": emp.ny_marital or "single",
        "ny_exemptions": emp.state_allowances,
        "nyc_marital": emp.nyc_marital or emp.ny_marital or "single",
        "nyc_exemptions": emp.nyc_allowances if emp.nyc_allowances is not None else emp.state_allowances,
        "nj_exemptions": emp.state_allowances if emp.work_state == "NJ" else 0,
        "nj_rate_table": emp.nj_rate_table or "A",
    }
    return EmployeeInput(
        name=emp.legal_name, gross=g,
        pretax_401k=cents(g * Decimal(str(emp.k401_deferral_pct)) / 100),
        state=emp.work_state, nyc_resident=emp.nyc_resident,
        k401_er_match_pct=Decimal(str(emp.k401_er_match_pct)), w4=w4,
        ytd_gross=Decimal(str(ytd_gross)),
    )


def _result_json(r: EmployeeResult, emp_id: int | None = None) -> dict:
    return {
        "employee_id": emp_id, "name": r.name, "gross": _f(r.gross),
        "pretax_401k": _f(r.pretax_401k),
        "taxes": {k: _f(v) for k, v in r.lines.items() if v is not None},
        "employer": {k: _f(v) for k, v in r.employer.items() if v is not None},
        "net": _f(r.net) if r.net is not None else None,
    }


def _run_result_from_entries(db: Session, body: PreviewIn) -> tuple[service.RunResult, list[int]]:
    ids = [e.employee_id for e in body.entries]
    emps = {e.id: e for e in db.scalars(select(PayrollEmployee).where(PayrollEmployee.id.in_(ids)))}
    inputs, order = [], []
    for entry in body.entries:
        emp = emps.get(entry.employee_id)
        if not emp:
            raise HTTPException(404, f"employee {entry.employee_id} not found")
        inputs.append(_emp_to_input(emp, entry.hours, entry.gross,
                                    ytd_gross=_ytd_gross(db, emp.id, body.check_date.year)))
        order.append(emp.id)
    run = service.compute_run(body.period_start, body.period_end, body.check_date,
                              inputs, weeks=body.weeks)
    return run, order


# ----------------------------------------------------------------- employees
@router.get("/employees")
def list_employees(db: Session = Depends(get_db), _: User = Depends(PERM)):
    rows = db.scalars(select(PayrollEmployee).where(PayrollEmployee.is_active == True)).all()  # noqa: E712
    return [{"id": e.id, "legal_name": e.legal_name, "pay_rate": e.pay_rate,
             "work_state": e.work_state, "nyc_resident": e.nyc_resident,
             "k401_deferral_pct": e.k401_deferral_pct, "k401_er_match_pct": e.k401_er_match_pct,
             "fed_filing_status": e.fed_filing_status, "state_allowances": e.state_allowances,
             "ssn_last4": crypto.last4(e.ssn_enc), "user_id": e.user_id,
             "linked": e.user_id is not None}
            for e in rows]


@router.post("/employees")
def create_employee(body: EmployeeIn, db: Session = Depends(get_db), _: User = Depends(PERM)):
    e = PayrollEmployee(**body.model_dump())
    db.add(e); db.commit(); db.refresh(e)
    return {"id": e.id}


class EmployeeUpdate(BaseModel):
    legal_name: str | None = None
    pay_rate: float | None = None
    is_salary: bool | None = None
    work_state: str | None = None
    nyc_resident: bool | None = None
    k401_deferral_pct: float | None = None
    k401_is_roth: bool | None = None
    k401_er_match_pct: float | None = None
    fed_filing_status: str | None = None
    fed_multiple_jobs: bool | None = None
    fed_dependents_amt: float | None = None
    fed_extra_withholding: float | None = None
    state_allowances: int | None = None
    ny_marital: str | None = None
    nyc_marital: str | None = None
    nyc_allowances: int | None = None
    nj_rate_table: str | None = None
    is_active: bool | None = None


@router.get("/employees/{emp_id}")
def get_employee(emp_id: int, db: Session = Depends(get_db), _: User = Depends(PERM)):
    e = db.get(PayrollEmployee, emp_id)
    if not e:
        raise HTTPException(404, "employee not found")
    return {
        "id": e.id, "legal_name": e.legal_name, "pay_rate": e.pay_rate, "is_salary": e.is_salary,
        "work_state": e.work_state, "nyc_resident": e.nyc_resident,
        "k401_deferral_pct": e.k401_deferral_pct, "k401_is_roth": e.k401_is_roth,
        "k401_er_match_pct": e.k401_er_match_pct,
        "fed_filing_status": e.fed_filing_status, "fed_multiple_jobs": e.fed_multiple_jobs,
        "fed_dependents_amt": e.fed_dependents_amt, "fed_extra_withholding": e.fed_extra_withholding,
        "state_allowances": e.state_allowances, "ny_marital": e.ny_marital,
        "nyc_marital": e.nyc_marital, "nyc_allowances": e.nyc_allowances,
        "nj_rate_table": e.nj_rate_table, "is_active": e.is_active,
        "ssn_last4": crypto.last4(e.ssn_enc), "linked": e.user_id is not None,
    }


@router.put("/employees/{emp_id}")
def update_employee(emp_id: int, body: EmployeeUpdate, db: Session = Depends(get_db), _: User = Depends(PERM)):
    e = db.get(PayrollEmployee, emp_id)
    if not e:
        raise HTTPException(404, "employee not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(e, k, v)
    db.commit()
    return {"ok": True, "id": e.id}


@router.post("/employees/seed-sample")
def seed_sample(db: Session = Depends(get_db), _: User = Depends(PERM)):
    existing = {e.legal_name for e in db.scalars(select(PayrollEmployee))}
    created = 0
    for name, rate, st, nyc, w4 in _SAMPLE:
        if name in existing:
            continue
        db.add(PayrollEmployee(
            legal_name=name, pay_rate=rate, work_state=st, nyc_resident=nyc,
            k401_deferral_pct=0.0, k401_er_match_pct=4.0,
            fed_filing_status=w4.get("filing_status", "single"),
            fed_extra_withholding=w4.get("extra_per_period", 0.0),
            state_allowances=w4.get("ny_exemptions", 0),
            ny_marital=w4.get("ny_marital", "single"),
            nyc_marital=w4.get("nyc_marital"), nyc_allowances=w4.get("nyc_allowances"),
            is_active=True))
        created += 1
    db.commit()
    return {"created": created, "note": "PII (SSN/bank) not set; onboard via Paychex workers API later"}


# ----------------------------------------------------------------- onboarding (Paychex)
class ImportIn(BaseModel):
    workers: list[dict]
    dry_run: bool = False


@router.get("/onboard/paychex/preview")
def onboard_preview(db: Session = Depends(get_db), _: User = Depends(PERM)):
    """Dry-run: what the Paychex workers API would import (SSN shown as last-4 only)."""
    try:
        workers = onboarding.fetch_paychex_workers()
    except Exception as ex:
        raise HTTPException(400, f"Paychex fetch failed: {ex}")
    return onboarding.import_workers(db, workers, dry_run=True)


@router.post("/onboard/paychex")
def onboard_paychex(db: Session = Depends(get_db), _: User = Depends(PERM)):
    """Import employees from Paychex (encrypts SSN, links users). Owner-only."""
    try:
        workers = onboarding.fetch_paychex_workers()
    except Exception as ex:
        raise HTTPException(400, f"Paychex fetch failed: {ex}")
    return onboarding.import_workers(db, workers, dry_run=False)


@router.post("/onboard/import")
def onboard_import(body: ImportIn, db: Session = Depends(get_db), _: User = Depends(PERM)):
    """Import from a supplied workers payload (same shape as the Paychex API) —
    for migration from an export, or testing without a live Paychex connection."""
    return onboarding.import_workers(db, body.workers, dry_run=body.dry_run)


# ----------------------------------------------------------------- reconciliation
@router.post("/reconcile")
def reconcile_endpoint(file: UploadFile = File(...), db: Session = Depends(get_db),
                       _: User = Depends(PERM)):
    """Upload a Paychex journal PDF *or* the reports .zip; get the engine-vs-Paychex diff."""
    import zipfile
    from . import reconcile as recon
    data = file.file.read()
    name = (file.filename or "").lower()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        if name.endswith(".zip") or data[:2] == b"PK":
            try:
                zf = zipfile.ZipFile(__import__("io").BytesIO(data))
                pdfname = next((n for n in zf.namelist() if "PYRJRN" in n.upper() and n.lower().endswith(".pdf")),
                              next((n for n in zf.namelist() if n.lower().endswith(".pdf")), None))
                if not pdfname:
                    raise HTTPException(400, "No PYRJRN PDF found in the zip")
                tf.write(zf.read(pdfname))
            except zipfile.BadZipFile:
                raise HTTPException(400, "Uploaded file is not a valid zip")
        else:
            tf.write(data)
        path = tf.name
    try:
        return recon.reconcile(path, db)
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(400, f"Reconciliation failed: {ex}")


# ----------------------------------------------------------------- YTD ledger
class YtdSeed(BaseModel):
    employee_id: int
    ytd_gross: float
    tax_year: int = 2026


@router.get("/ytd")
def list_ytd(tax_year: int = 2026, db: Session = Depends(get_db), _: User = Depends(PERM)):
    rows = db.scalars(select(PayrollYtd).where(PayrollYtd.tax_year == tax_year)).all()
    return [{"employee_id": r.employee_id, "ytd_gross": r.ytd_gross} for r in rows]


@router.post("/ytd/seed")
def seed_ytd(items: list[YtdSeed], db: Session = Depends(get_db), _: User = Depends(PERM)):
    """Set each employee's starting YTD (from their last Paychex stub) for a mid-year
    cutover, so wage-base caps (FUTA, SS, NY/NJ UI) compute correctly."""
    n = 0
    for it in items:
        row = db.scalar(select(PayrollYtd).where(PayrollYtd.employee_id == it.employee_id,
                                                 PayrollYtd.tax_year == it.tax_year))
        if not row:
            row = PayrollYtd(employee_id=it.employee_id, tax_year=it.tax_year, ytd_gross=0.0)
            db.add(row)
        row.ytd_gross = it.ytd_gross
        n += 1
    db.commit()
    return {"seeded": n}


# ----------------------------------------------------------------- staff self-service
class TaxProfileIn(BaseModel):
    k401_deferral_pct: float = 0.0
    k401_is_roth: bool = False
    fed_filing_status: str = "single"      # single | mfj | hoh
    fed_multiple_jobs: bool = False         # W-4 Step 2 checkbox
    fed_dependents_amt: float = 0.0         # W-4 Step 3 (annual $)
    fed_extra_withholding: float = 0.0      # W-4 Step 4c (per pay period)
    state_allowances: int = 0               # IT-2104 / NJ-W4 allowances


def _my_employee(db: Session, user: User):
    e = db.scalar(select(PayrollEmployee).where(PayrollEmployee.user_id == user.id))
    if e:
        return e
    # best-effort auto-link an unlinked record by name (first + last token match)
    fn = (user.full_name or "").lower().split()
    if fn:
        for cand in db.scalars(select(PayrollEmployee).where(PayrollEmployee.user_id.is_(None))):
            ln = cand.legal_name.lower()
            if fn[0] in ln and fn[-1] in ln:
                cand.user_id = user.id
                db.commit()
                return cand
    return None


@router.get("/me/tax-profile")
def my_tax_profile(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Any employee: view their own 401(k) + W-4 settings."""
    e = _my_employee(db, user)
    if not e:
        return {"linked": False}
    return {"linked": True, "id": e.id, "legal_name": e.legal_name, "work_state": e.work_state,
            "nyc_resident": e.nyc_resident, "pay_rate": e.pay_rate,
            "k401_deferral_pct": e.k401_deferral_pct, "k401_is_roth": e.k401_is_roth,
            "k401_er_match_pct": e.k401_er_match_pct,
            "fed_filing_status": e.fed_filing_status, "fed_multiple_jobs": e.fed_multiple_jobs,
            "fed_dependents_amt": e.fed_dependents_amt, "fed_extra_withholding": e.fed_extra_withholding,
            "state_allowances": e.state_allowances}


@router.put("/me/tax-profile")
def update_my_tax_profile(body: TaxProfileIn, db: Session = Depends(get_db),
                          user: User = Depends(get_current_user)):
    """Any employee: update ONLY their own 401(k) deferral + W-4/state elections."""
    e = _my_employee(db, user)
    if not e:
        raise HTTPException(404, "No payroll record is linked to your account yet. Ask the owner to link you.")
    for k, v in body.model_dump().items():
        setattr(e, k, v)
    db.commit()
    return {"ok": True, "id": e.id}


@router.post("/employees/{emp_id}/link")
def link_employee_user(emp_id: int, user_id: int, db: Session = Depends(get_db), _: User = Depends(PERM)):
    """Owner: link a payroll record to an app user (enables that person's self-service)."""
    e = db.get(PayrollEmployee, emp_id)
    if not e:
        raise HTTPException(404, "employee not found")
    e.user_id = user_id
    db.commit()
    return {"ok": True, "employee_id": emp_id, "user_id": user_id}


# ----------------------------------------------------------------- run workflow
@router.post("/preview")
def preview(body: PreviewIn, db: Session = Depends(get_db), _: User = Depends(PERM)):
    run, order = _run_result_from_entries(db, body)
    jl = service.build_journal(run)
    d, c, ok = service.journal_balances(jl)
    return {
        "employees": [_result_json(r, eid) for r, eid in zip(run.results, order)],
        "totals": {"gross": _f(run.gross), "ee_withholdings": _f(run.ee_withholdings),
                   "k401_ee": _f(run.ee_401k), "k401_er": _f(run.er_401k),
                   "employer_taxes": _f(run.employer_taxes), "net": _f(run.net)},
        "journal": [{"account": l.account, "debit": _f(l.debit), "credit": _f(l.credit)} for l in jl],
        "journal_balanced": ok,
    }


@router.post("/runs")
def create_run(body: PreviewIn, db: Session = Depends(get_db), user: User = Depends(PERM)):
    run_result, order = _run_result_from_entries(db, body)
    run = PayrollRun(period_start=body.period_start, period_end=body.period_end,
                     check_date=body.check_date, weeks=body.weeks, status="draft",
                     created_by=user.id, tax_year=body.check_date.year)
    db.add(run); db.flush()
    for r, eid in zip(run_result.results, order):
        db.add(PayrollLine(run_id=run.id, employee_id=eid, gross=_f(r.gross),
                           pretax_401k=_f(r.pretax_401k),
                           lines_json=json.dumps({k: _f(v) for k, v in r.lines.items() if v is not None}),
                           net=_f(r.net) if r.net is not None else 0.0))
    db.commit()
    return {"id": run.id, "status": run.status}


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), _: User = Depends(PERM)):
    rows = db.scalars(select(PayrollRun).order_by(PayrollRun.check_date.desc())).all()
    return [{"id": r.id, "period_start": str(r.period_start), "period_end": str(r.period_end),
             "check_date": str(r.check_date), "status": r.status,
             "net": json.loads(r.totals_json).get("net") if r.totals_json else None} for r in rows]


@router.get("/runs/{run_id}")
def run_detail(run_id: int, db: Session = Depends(get_db), _: User = Depends(PERM)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(404, "run not found")
    lines = db.scalars(select(PayrollLine).where(PayrollLine.run_id == run_id)).all()
    emps = {e.id: e.legal_name for e in db.scalars(select(PayrollEmployee))}
    return {
        "id": run.id, "status": run.status, "period_start": str(run.period_start),
        "period_end": str(run.period_end), "check_date": str(run.check_date),
        "created_by": run.created_by, "approved_by": run.approved_by,
        "totals": json.loads(run.totals_json) if run.totals_json else None,
        "lines": [{"employee_id": l.employee_id, "name": emps.get(l.employee_id, "?"),
                   "gross": l.gross, "pretax_401k": l.pretax_401k,
                   "taxes": json.loads(l.lines_json), "net": l.net} for l in lines],
    }


@router.post("/runs/{run_id}/approve")
def approve(run_id: int, db: Session = Depends(get_db), user: User = Depends(PERM)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(404, "run not found")
    try:
        service.approve_run(db, run, approver_id=user.id)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    db.commit()
    return {"id": run.id, "status": run.status}


@router.post("/runs/{run_id}/pay")
def pay(run_id: int, db: Session = Depends(get_db), user: User = Depends(PERM)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(404, "run not found")
    # rebuild the RunResult from stored lines to post the journal
    lines = db.scalars(select(PayrollLine).where(PayrollLine.run_id == run_id)).all()
    emps = {e.id: e for e in db.scalars(select(PayrollEmployee))}
    inputs, order = [], []
    for l in lines:
        emp = emps[l.employee_id]
        inputs.append(_emp_to_input(emp, hours=0.0, gross=l.gross,
                                    ytd_gross=_ytd_gross(db, l.employee_id, run.tax_year)))
        order.append(l.employee_id)
    rr = service.compute_run(run.period_start, run.period_end, run.check_date, inputs, weeks=run.weeks)
    for r, eid in zip(rr.results, order):
        r.employee_id = eid
    try:
        journal = service.mark_paid(db, run, rr)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    db.commit()
    return {"id": run.id, "status": run.status,
            "journal": [{"account": j.account, "debit": _f(j.debit), "credit": _f(j.credit)} for j in journal]}


@router.get("/runs/{run_id}/stub/{employee_id}")
def stub(run_id: int, employee_id: int, db: Session = Depends(get_db), _: User = Depends(PERM)):
    run = db.get(PayrollRun, run_id)
    line = db.scalar(select(PayrollLine).where(PayrollLine.run_id == run_id,
                                               PayrollLine.employee_id == employee_id))
    emp = db.get(PayrollEmployee, employee_id)
    if not (run and line and emp):
        raise HTTPException(404, "not found")
    from .engine import compute_employee
    res = compute_employee(_emp_to_input(emp, hours=0.0, gross=line.gross))
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        path = tf.name
    render_stub_pdf(path, {"period_start": str(run.period_start), "period_end": str(run.period_end),
                           "check_date": str(run.check_date)}, res)
    data = open(path, "rb").read()
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="paystub_{employee_id}.pdf"'})
