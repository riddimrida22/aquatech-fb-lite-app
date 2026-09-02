"""Payroll data model (Phase 1). Not yet registered with create_all — wiring
into the app + prod migration happens in a later phase after review.

PII (SSN, bank account) is stored ENCRYPTED (app-level, via a KMS/Fernet key in
settings) — never plaintext, never to git. Access is owner-only and audit-logged.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


class PayrollEmployee(Base):
    """Payroll/tax profile for a person (extends the app `users` row)."""

    __tablename__ = "payroll_employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    legal_name: Mapped[str] = mapped_column(String(255))          # as on the W-2
    ssn_enc: Mapped[str | None] = mapped_column(Text, nullable=True)   # ENCRYPTED
    dob: Mapped[date | None] = mapped_column(Date, nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Jurisdiction / sourcing
    work_state: Mapped[str] = mapped_column(String(2), default="NY")
    residence_state: Mapped[str] = mapped_column(String(2), default="NY")
    nyc_resident: Mapped[bool] = mapped_column(Boolean, default=False)

    # Comp + 401k
    pay_rate: Mapped[float] = mapped_column(Float, default=0.0)     # hourly
    is_salary: Mapped[bool] = mapped_column(Boolean, default=False)
    k401_deferral_pct: Mapped[float] = mapped_column(Float, default=0.0)
    k401_is_roth: Mapped[bool] = mapped_column(Boolean, default=False)
    k401_er_match_pct: Mapped[float] = mapped_column(Float, default=0.0)

    # W-4 / IT-2104 / NJ-W4 (drive income-tax withholding) — 2020+ W-4 shape
    fed_filing_status: Mapped[str] = mapped_column(String(16), default="single")  # single|married|hoh
    fed_multiple_jobs: Mapped[bool] = mapped_column(Boolean, default=False)       # W-4 step 2
    fed_dependents_amt: Mapped[float] = mapped_column(Float, default=0.0)         # W-4 step 3
    fed_other_income: Mapped[float] = mapped_column(Float, default=0.0)           # 4a
    fed_deductions: Mapped[float] = mapped_column(Float, default=0.0)             # 4b
    fed_extra_withholding: Mapped[float] = mapped_column(Float, default=0.0)      # 4c
    state_allowances: Mapped[int] = mapped_column(Integer, default=0)             # IT-2104 (NY) / NJ-W4
    state_extra_withholding: Mapped[float] = mapped_column(Float, default=0.0)
    ny_marital: Mapped[str] = mapped_column(String(16), default="single")         # NY: single|married
    # NYC allowances/status can differ from NY State on IT-2104 (line 2 vs line 1).
    nyc_marital: Mapped[str | None] = mapped_column(String(16), nullable=True)    # falls back to ny_marital
    nyc_allowances: Mapped[int | None] = mapped_column(Integer, nullable=True)    # falls back to state_allowances
    nj_rate_table: Mapped[str] = mapped_column(String(1), default="A")            # NJ-W4 wage-chart letter A-E

    # Direct deposit (ENCRYPTED)
    bank_routing_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    bank_account_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    bank_account_type: Mapped[str] = mapped_column(String(16), default="checking")

    hire_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lines: Mapped[list["PayrollLine"]] = relationship(back_populates="employee")


class PayrollRun(Base):
    __tablename__ = "payroll_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    check_date: Mapped[date] = mapped_column(Date, index=True)
    weeks: Mapped[int] = mapped_column(Integer, default=2)
    # draft -> previewed -> approved -> paid  (dual control)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    tax_year: Mapped[int] = mapped_column(Integer, default=2026)
    # Snapshot company totals (JSON) at approval, for audit.
    totals_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lines: Mapped[list["PayrollLine"]] = relationship(back_populates="run")


class PayrollLine(Base):
    """One employee's computed result within a run (the pay stub source)."""

    __tablename__ = "payroll_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("payroll_runs.id"), index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("payroll_employees.id"), index=True)
    hours: Mapped[float] = mapped_column(Float, default=0.0)
    gross: Mapped[float] = mapped_column(Float, default=0.0)
    pretax_401k: Mapped[float] = mapped_column(Float, default=0.0)
    # All withholding + employer lines as JSON (ss, medicare, fed, ny_inc, nyc,
    # ny_sdi, ny_pfl, nj_*, employer.*) — engine output, penny-rounded.
    lines_json: Mapped[str] = mapped_column(Text, default="{}")
    net: Mapped[float] = mapped_column(Float, default=0.0)

    run: Mapped[PayrollRun] = relationship(back_populates="lines")
    employee: Mapped[PayrollEmployee] = relationship(back_populates="lines")


class PayrollYtd(Base):
    """Per-employee, per-year running wage/tax bases — drives caps (SS/FUTA/UI)
    and Paychex-style YTD-cumulative rounding. Updated when a run is marked paid."""

    __tablename__ = "payroll_ytd"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("payroll_employees.id"), index=True)
    tax_year: Mapped[int] = mapped_column(Integer, index=True)
    ytd_gross: Mapped[float] = mapped_column(Float, default=0.0)
    ytd_ss_wages: Mapped[float] = mapped_column(Float, default=0.0)
    ytd_medicare: Mapped[float] = mapped_column(Float, default=0.0)
    ytd_futa_wages: Mapped[float] = mapped_column(Float, default=0.0)
    ytd_ui_wages: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TaxTableVersion(Base):
    """Versioned tax tables by year + jurisdiction (fed/ny/nyc/nj). The annual
    January refresh inserts a new row; historical runs stay reproducible."""

    __tablename__ = "payroll_tax_tables"

    id: Mapped[int] = mapped_column(primary_key=True)
    tax_year: Mapped[int] = mapped_column(Integer, index=True)
    jurisdiction: Mapped[str] = mapped_column(String(16), index=True)  # federal|ny|nyc|nj
    data_json: Mapped[str] = mapped_column(Text)                       # brackets/rates
    source_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
