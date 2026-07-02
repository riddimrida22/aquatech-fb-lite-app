from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), default="employee")
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AssistantQuery(Base):
    """A question a person asked the 'Ask AqtPM' assistant — per-person search history."""

    __tablename__ = "assistant_queries"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    question: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(16), default="quick")
    answer_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    client_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pm_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    overall_budget_fee: Mapped[float] = mapped_column(Float, default=0.0)
    target_gross_margin_pct: Mapped[float] = mapped_column(Float, default=0.0)
    is_overhead: Mapped[bool] = mapped_column(Boolean, default=False)
    is_billable: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Lifecycle stage. Source of truth — is_active is auto-derived from this.
    # Allowed values: planning | active | paused | completed | cancelled
    lifecycle_status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    completed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Provenance + external-id (FreshBooks project id). Used by sync_projects to upsert.
    # Values: manual | freshbooks_api | csv
    source: Mapped[str] = mapped_column(String(32), default="manual", index=True)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)

    tasks: Mapped[list["Task"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    members: Mapped[list["ProjectMember"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    """Per-project staffing assignment with role.

    role values (canonical): Lead, PM, Engineer, QA/QC, Reviewer, Admin Support, Other
    A user can hold multiple roles on the same project (e.g. Lead + PM) — each is a row.
    """

    __tablename__ = "project_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(64), default="Engineer", index=True)
    allocation_pct: Mapped[float] = mapped_column(Float, default=0.0)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    project: Mapped[Project] = relationship(back_populates="members")

    __table_args__ = (
        UniqueConstraint("project_id", "user_id", "role", name="uq_project_member_proj_user_role"),
    )


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    is_billable: Mapped[bool] = mapped_column(Boolean, default=True)

    project: Mapped[Project] = relationship(back_populates="tasks")
    subtasks: Mapped[list["Subtask"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class Subtask(Base):
    __tablename__ = "subtasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    code: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(255))
    budget_hours: Mapped[float] = mapped_column(Float, default=0.0)
    budget_fee: Mapped[float] = mapped_column(Float, default=0.0)

    task: Mapped[Task] = relationship(back_populates="subtasks")

    __table_args__ = (UniqueConstraint("task_id", "code", name="uq_subtask_task_code"),)


class UserRate(Base):
    __tablename__ = "user_rates"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    effective_date: Mapped[date] = mapped_column(Date, default=date.today)
    bill_rate: Mapped[float] = mapped_column(Float)
    cost_rate: Mapped[float] = mapped_column(Float)


class TimeEntry(Base):
    __tablename__ = "time_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    subtask_id: Mapped[int] = mapped_column(ForeignKey("subtasks.id"), index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    hours: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(Text, default="")
    bill_rate_applied: Mapped[float] = mapped_column(Float)
    cost_rate_applied: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Provenance + external-id (FreshBooks time-entry id). Used by sync_time_entries to upsert.
    # Values: manual | freshbooks_api
    source: Mapped[str] = mapped_column(String(32), default="manual", index=True)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # Per-entry billable flag. For FB-sourced entries, mirrors FB's `billable` field.
    # For manual entries, defaults to True. Drives unbilled-vs-non-billable reporting.
    is_billable: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # FreshBooks' authoritative `billed` flag — True once the entry has been put on an
    # invoice in FB. Source of truth for "earned, not billed" (FB is the billing system
    # of record). Null/False for manual entries (which are excluded from that metric).
    billed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)


class Timesheet(Base):
    __tablename__ = "timesheets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    week_start: Mapped[date] = mapped_column(Date, index=True)
    week_end: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    employee_signed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    supervisor_signed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    __table_args__ = (UniqueConstraint("user_id", "week_start", name="uq_timesheet_user_week"),)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int] = mapped_column(index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    client_name: Mapped[str] = mapped_column(String(255), default="")
    # Provenance: where this row came from. Used by reconciliation engine to
    # distinguish CSV-imported rows from API-pulled rows.
    # Values: csv | csv_freshbooks | freshbooks_api | manual
    source: Mapped[str] = mapped_column(String(32), default="csv", index=True)
    # External-system ID (FreshBooks invoice id like 164410). Populated only for
    # API-sourced rows. Used as the upsert key when re-syncing.
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date, index=True)
    issue_date: Mapped[date] = mapped_column(Date, default=date.today)
    due_date: Mapped[date] = mapped_column(Date, default=date.today)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    subtotal_amount: Mapped[float] = mapped_column(Float, default=0.0)
    amount_paid: Mapped[float] = mapped_column(Float, default=0.0)
    balance_due: Mapped[float] = mapped_column(Float, default=0.0)
    total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    total_profit: Mapped[float] = mapped_column(Float, default=0.0)
    recurring_schedule_id: Mapped[int | None] = mapped_column(ForeignKey("recurring_invoice_schedules.id"), nullable=True, index=True)
    recurring_run_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    payment_link_token: Mapped[str | None] = mapped_column(String(96), nullable=True, unique=True, index=True)
    payment_link_enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    payment_link_expires_at: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    paid_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), index=True)
    source_time_entry_id: Mapped[int | None] = mapped_column(ForeignKey("time_entries.id"), nullable=True, index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    subtask_id: Mapped[int | None] = mapped_column(ForeignKey("subtasks.id"), nullable=True, index=True)
    description: Mapped[str] = mapped_column(String(255), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    hours: Mapped[float] = mapped_column(Float, default=0.0)
    bill_rate: Mapped[float] = mapped_column(Float, default=0.0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)


class ProjectExpense(Base):
    __tablename__ = "project_expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    expense_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    category: Mapped[str] = mapped_column(String(128), default="General")
    description: Mapped[str] = mapped_column(String(255), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    # Provenance: csv | csv_freshbooks | freshbooks_api | manual
    source: Mapped[str] = mapped_column(String(32), default="csv", index=True)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class RecurringInvoiceSchedule(Base):
    __tablename__ = "recurring_invoice_schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    cadence: Mapped[str] = mapped_column(String(16), default="monthly", index=True)  # weekly|monthly
    approved_only: Mapped[bool] = mapped_column(Boolean, default=True)
    due_days: Mapped[int] = mapped_column(default=30)
    next_run_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    last_run_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    auto_send_email: Mapped[bool] = mapped_column(Boolean, default=False)
    recipient_email: Mapped[str] = mapped_column(String(255), default="")
    notes_template: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class BankConnection(Base):
    __tablename__ = "bank_connections"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="plaid", index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    institution_name: Mapped[str] = mapped_column(String(255), default="")
    institution_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    item_id: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True, index=True)
    access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_cursor: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="connected", index=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class BankAccount(Base):
    __tablename__ = "bank_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("bank_connections.id"), index=True)
    account_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    mask: Mapped[str | None] = mapped_column(String(16), nullable=True)
    type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    subtype: Mapped[str | None] = mapped_column(String(64), nullable=True)
    iso_currency_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    current_balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    available_balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_business: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (UniqueConstraint("connection_id", "account_id", name="uq_bank_account_conn_account"),)


class BankTransaction(Base):
    __tablename__ = "bank_transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("bank_connections.id"), index=True)
    account_id: Mapped[str] = mapped_column(String(128), index=True)
    transaction_id: Mapped[str] = mapped_column(String(128), index=True)
    posted_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    merchant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    iso_currency_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    pending: Mapped[bool] = mapped_column(Boolean, default=False)
    is_business: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    category_json: Mapped[str] = mapped_column(Text, default="[]")
    raw_json: Mapped[str] = mapped_column(Text, default="{}")
    # Provenance: csv_chase | csv_fb_expenses | plaid_api | manual
    source: Mapped[str] = mapped_column(String(32), default="csv", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (UniqueConstraint("connection_id", "transaction_id", name="uq_bank_tx_conn_txid"),)


class BankTransactionMatch(Base):
    __tablename__ = "bank_transaction_matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    bank_transaction_id: Mapped[int] = mapped_column(ForeignKey("bank_transactions.id"), index=True, unique=True)
    match_type: Mapped[str] = mapped_column(String(32), default="invoice", index=True)  # invoice|expense|other
    match_entity_id: Mapped[int] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(String(32), default="confirmed", index=True)  # suggested|confirmed|rejected
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class GustoEmployee(Base):
    """Gusto employee mirror. Source of truth is Gusto API — we cache the slice we
    need locally for joins/reports without round-tripping the API every time.
    """

    __tablename__ = "gusto_employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    uuid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    company_uuid: Mapped[str] = mapped_column(String(64), index=True)
    first_name: Mapped[str] = mapped_column(String(128), default="")
    last_name: Mapped[str] = mapped_column(String(128), default="")
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    department: Mapped[str | None] = mapped_column(String(128), nullable=True)
    employment_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payment_method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    terminated: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    aqt_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    raw_json: Mapped[str] = mapped_column(Text, default="{}")


class GustoPayroll(Base):
    """Gusto payroll header. Per-employee line items can be added later as a
    separate gusto_payroll_compensations table; this header alone gives us
    timeline + processed flag + pay period for COGS bucketing.
    """

    __tablename__ = "gusto_payrolls"

    id: Mapped[int] = mapped_column(primary_key=True)
    uuid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    company_uuid: Mapped[str] = mapped_column(String(64), index=True)
    check_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    pay_period_start: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    pay_period_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    processed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    processed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    off_cycle: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_payroll: Mapped[bool] = mapped_column(Boolean, default=False)
    # Totals — populated when we fetch payroll detail with include=compensations
    total_gross_pay: Mapped[float] = mapped_column(Float, default=0.0)
    total_net_pay: Mapped[float] = mapped_column(Float, default=0.0)
    total_employer_taxes: Mapped[float] = mapped_column(Float, default=0.0)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    raw_json: Mapped[str] = mapped_column(Text, default="{}")


class IntegrationToken(Base):
    """OAuth tokens for cloud integrations (FreshBooks, Gusto, etc).

    One row per provider — token rotation overwrites in place. Refresh tokens are
    one-time-use, so on every refresh the new pair is written before the old token
    is used to make any API call.
    """

    __tablename__ = "integration_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    bearer_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    account_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    business_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_sync_status: Mapped[str] = mapped_column(String(255), default="")
    last_sync_summary: Mapped[str] = mapped_column(Text, default="{}")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Loan(Base):
    """A debt instrument: term loan, line of credit, owner loan, SBA, etc.

    Tracks declining principal so balance sheet liabilities can be computed
    and so loan-principal payments are not misclassified as expenses.
    """

    __tablename__ = "loans"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    lender: Mapped[str] = mapped_column(String(255), default="")
    # Type: term_loan | line_of_credit | credit_card | owner_loan | sba | other
    loan_type: Mapped[str] = mapped_column(String(32), default="term_loan", index=True)
    account_last4: Mapped[str | None] = mapped_column(String(16), nullable=True)
    principal_original: Mapped[float] = mapped_column(Float, default=0.0)
    principal_current: Mapped[float] = mapped_column(Float, default=0.0)
    interest_rate_apr: Mapped[float] = mapped_column(Float, default=0.0)
    payment_amount: Mapped[float] = mapped_column(Float, default=0.0)
    # monthly | weekly | biweekly | irregular
    payment_frequency: Mapped[str] = mapped_column(String(16), default="monthly")
    origination_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    maturity_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # match keywords found in BankTransaction.name to auto-suggest mapping
    description_match: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LoanPayment(Base):
    """A single payment made against a loan, split into principal + interest + fees.

    Optionally linked to a BankTransaction so the same row isn't also classified as an expense.
    """

    __tablename__ = "loan_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    loan_id: Mapped[int] = mapped_column(ForeignKey("loans.id"), index=True)
    payment_date: Mapped[date] = mapped_column(Date, index=True)
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)
    principal_amount: Mapped[float] = mapped_column(Float, default=0.0)
    interest_amount: Mapped[float] = mapped_column(Float, default=0.0)
    fees_amount: Mapped[float] = mapped_column(Float, default=0.0)
    bank_transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_transactions.id"), nullable=True, unique=True, index=True
    )
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class BankMerchantRule(Base):
    __tablename__ = "bank_merchant_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    merchant_key: Mapped[str] = mapped_column(String(255), index=True)
    expense_group: Mapped[str] = mapped_column(String(64), default="OH")
    category: Mapped[str] = mapped_column(String(128), default="Uncategorized")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (UniqueConstraint("user_id", "merchant_key", name="uq_bank_merchant_rule_user_key"),)
