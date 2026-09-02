"""Payroll run workflow: create -> preview -> approve -> pay.

Pure computation + a thin DB lifecycle. `compute_run` wraps the engine and
aggregates a whole run (per-employee lines + company totals + employer
liabilities). The lifecycle helpers persist via SQLAlchemy when given a Session;
they enforce dual-control (a run must be approved by someone before it can be paid)
and, on pay, emit balanced finance journals and advance the YTD ledger.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from .engine import EmployeeInput, EmployeeResult, cents, compute_employee


@dataclass
class RunResult:
    period_start: date
    period_end: date
    check_date: date
    weeks: int
    results: list[EmployeeResult]
    # Employer-side taxes not derived by the engine yet (FUTA/UI need YTD + rates);
    # callers may inject them for a complete journal.
    employer_extra: dict[str, Decimal] = field(default_factory=dict)

    def _sum_line(self, key: str) -> Decimal:
        return sum((r.lines.get(key) or Decimal("0") for r in self.results), Decimal("0"))

    @property
    def gross(self) -> Decimal:
        return sum((r.gross for r in self.results), Decimal("0"))

    @property
    def ee_401k(self) -> Decimal:
        return sum((r.pretax_401k for r in self.results), Decimal("0"))

    @property
    def er_401k(self) -> Decimal:
        return sum((r.employer.get("k401_er") or Decimal("0") for r in self.results), Decimal("0"))

    @property
    def net(self) -> Decimal:
        return sum((r.net or Decimal("0") for r in self.results), Decimal("0"))

    @property
    def ee_withholdings(self) -> Decimal:
        # every employee-side tax line (excludes the 401k deferral)
        total = Decimal("0")
        for r in self.results:
            for k, v in r.lines.items():
                if v is not None:
                    total += v
        return total

    @property
    def employer_taxes(self) -> Decimal:
        base = sum((v for r in self.results for k, v in r.employer.items()
                    if k in ("ss", "medicare") and v is not None), Decimal("0"))
        return base + sum(self.employer_extra.values(), Decimal("0"))


def compute_run(period_start: date, period_end: date, check_date: date,
                employees: list[EmployeeInput], weeks: int = 2,
                employer_extra: dict[str, Decimal] | None = None) -> RunResult:
    periods = 52 // max(weeks, 1)  # biweekly(2)->26, weekly(1)->52
    for e in employees:
        e.weeks = weeks
        e.w4.setdefault("periods", periods)
    results = [compute_employee(e) for e in employees]
    return RunResult(period_start, period_end, check_date, weeks, results,
                     employer_extra or {})


# ----------------------------------------------------------------- journals
@dataclass
class JournalLine:
    account: str
    debit: Decimal = Decimal("0")
    credit: Decimal = Decimal("0")


def build_journal(run: RunResult) -> list[JournalLine]:
    """Balanced double-entry journal for one payroll run (accrual + cash on pay)."""
    ee_tax = run.ee_withholdings          # employee-withheld taxes
    lines = [
        JournalLine("Salaries & Wages Expense", debit=cents(run.gross)),
        JournalLine("Employer Payroll Tax Expense", debit=cents(run.employer_taxes)),
        JournalLine("401(k) Employer Match Expense", debit=cents(run.er_401k)),
        JournalLine("Cash - Operating (net direct deposits)", credit=cents(run.net)),
        JournalLine("Employee Tax Withholdings Payable", credit=cents(ee_tax)),
        JournalLine("401(k) Payable (employee + employer)", credit=cents(run.ee_401k + run.er_401k)),
        JournalLine("Employer Payroll Taxes Payable", credit=cents(run.employer_taxes)),
    ]
    return lines


def journal_balances(lines: list[JournalLine]) -> tuple[Decimal, Decimal, bool]:
    d = sum((l.debit for l in lines), Decimal("0"))
    c = sum((l.credit for l in lines), Decimal("0"))
    return d, c, d == c


# ----------------------------------------------------------------- DB lifecycle
def _emp_input_from_row(emp, hours: float, gross: Decimal | None = None) -> EmployeeInput:
    g = gross if gross is not None else Decimal(str(emp.pay_rate)) * Decimal(str(hours))
    return EmployeeInput(
        name=emp.legal_name, gross=g,
        pretax_401k=cents(g * Decimal(str(emp.k401_deferral_pct)) / 100),
        state=emp.work_state, nyc_resident=emp.nyc_resident,
        w4={"filing_status": emp.fed_filing_status, "step2": emp.fed_multiple_jobs,
            "dependents_annual": emp.fed_dependents_amt, "extra_per_period": emp.fed_extra_withholding,
            "ny_marital": ("married" if emp.fed_filing_status == "mfj" else "single"),
            "ny_exemptions": emp.state_allowances},
    )


def create_run(db, period_start: date, period_end: date, check_date: date,
               created_by: int, weeks: int = 2, tax_year: int = 2026):
    from .models import PayrollRun
    run = PayrollRun(period_start=period_start, period_end=period_end, check_date=check_date,
                     weeks=weeks, status="draft", created_by=created_by, tax_year=tax_year)
    db.add(run); db.flush()
    return run


def approve_run(db, run, approver_id: int, require_separate_approver: bool = False) -> None:
    """Approve a run. Separation-of-duties is OPTIONAL: small firms often have a
    single admin (the owner), so by default the creator may approve. Firms with
    2+ admins can require a distinct approver by passing require_separate_approver."""
    if require_separate_approver and run.created_by is not None and approver_id == run.created_by:
        raise ValueError("separation-of-duties: approver must differ from the run's creator")
    run.status = "approved"
    run.approved_by = approver_id
    run.approved_at = datetime.utcnow()
    db.flush()


def mark_paid(db, run, run_result: RunResult) -> list[JournalLine]:
    """Post the finance journal, snapshot totals, advance YTD, set status=paid."""
    if run.status != "approved":
        raise ValueError("run must be approved before it can be paid")
    from .models import PayrollYtd
    journal = build_journal(run_result)
    _d, _c, ok = journal_balances(journal)
    if not ok:
        raise ValueError(f"journal does not balance: debits {_d} != credits {_c}")
    run.totals_json = json.dumps({
        "gross": str(run_result.gross), "net": str(run_result.net),
        "ee_withholdings": str(run_result.ee_withholdings),
        "employer_taxes": str(run_result.employer_taxes),
        "k401_ee": str(run_result.ee_401k), "k401_er": str(run_result.er_401k),
        "journal": [{"account": l.account, "debit": str(l.debit), "credit": str(l.credit)} for l in journal],
    })
    run.status = "paid"
    # advance YTD ledger
    for r in run_result.results:
        row = PayrollYtd(employee_id=getattr(r, "employee_id", 0) or 0, tax_year=run.tax_year,
                         ytd_gross=float(r.gross))
        db.add(row)
    db.flush()
    return journal
