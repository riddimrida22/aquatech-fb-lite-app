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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    tasks: Mapped[list["Task"]] = relationship(back_populates="project", cascade="all, delete-orphan")


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
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date, index=True)
    issue_date: Mapped[date] = mapped_column(Date, default=date.today)
    due_date: Mapped[date] = mapped_column(Date, default=date.today)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    source: Mapped[str] = mapped_column(String(32), default="app", index=True)
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
