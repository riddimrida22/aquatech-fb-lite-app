import csv
import calendar
import hashlib
import io
import json
import re
import secrets
import smtplib
import threading
import time
from urllib.parse import urlencode
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import requests
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, Response
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, exists, false, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from .authz import get_current_user, permissions_for_role, require_permission
from .db import SessionLocal, get_db, init_db
from .models import (
    AuditEvent,
    BankAccount,
    BankConnection,
    BankMerchantRule,
    BankTransaction,
    BankTransactionMatch,
    Invoice,
    InvoiceLine,
    Project,
    ProjectExpense,
    RecurringInvoiceSchedule,
    Subtask,
    Task,
    TimeEntry,
    Timesheet,
    User,
    UserRate,
)
from .settings import get_settings
from .timeframes import pay_period_for


settings = get_settings()
app = FastAPI(title="AquatechPM")
cors_origin_regex = (
    r"^https?://(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$"
    if settings.CORS_ALLOW_INTERNAL_REGEX
    else None
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SESSION_SECRET,
    same_site=settings.SESSION_SAME_SITE,
    https_only=settings.SESSION_HTTPS_ONLY,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN, "http://localhost:3000"],
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HIDDEN_PROJECT_NAMES = {"no project", "imported project"}
NO_SUBTASK_CODE = "NO-SUBTASK"
NO_SUBTASK_NAME = "No Sub-Task"


def _is_hidden_project_name(name: str | None) -> bool:
    normalized = (name or "").strip().lower()
    return normalized in HIDDEN_PROJECT_NAMES


class DevBootstrapRequest(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)


class DevLoginRequest(BaseModel):
    email: EmailStr


class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    is_active: bool
    start_date: date | None
    permissions: list[str]


class UserUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    start_date: date | None = None
    is_active: bool = True
    role: str | None = None


class AuditEventOut(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    action: str
    actor_user_id: int | None
    actor_user_email: str | None = None
    payload_json: str
    created_at: datetime


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    client_name: str | None = Field(default=None, max_length=255)
    pm_user_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    overall_budget_fee: float = Field(default=0, ge=0)
    target_gross_margin_pct: float = Field(default=0, ge=0, le=100)
    is_overhead: bool = False
    is_billable: bool = True


class ProjectOut(BaseModel):
    id: int
    name: str
    client_name: str | None
    pm_user_id: int | None
    start_date: date | None
    end_date: date | None
    overall_budget_fee: float
    target_gross_margin_pct: float
    is_overhead: bool
    is_billable: bool
    is_active: bool


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    client_name: str | None = Field(default=None, max_length=255)
    pm_user_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    overall_budget_fee: float = Field(default=0, ge=0)
    target_gross_margin_pct: float = Field(default=0, ge=0, le=100)
    is_overhead: bool = False
    is_billable: bool = True
    is_active: bool = True


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    is_billable: bool | None = None


class TaskUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    is_billable: bool = True


class ProjectExpenseCreate(BaseModel):
    expense_date: date
    category: str = Field(default="General", min_length=1, max_length=128)
    description: str = Field(default="", max_length=255)
    amount: float = Field(gt=0)


class ProjectExpenseOut(BaseModel):
    id: int
    project_id: int
    expense_date: date
    category: str
    description: str
    amount: float


class SubtaskCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    budget_hours: float = Field(ge=0)
    budget_fee: float = Field(ge=0)


class SubtaskUpdate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    budget_hours: float = Field(ge=0)
    budget_fee: float = Field(ge=0)


class TimeEntryCreate(BaseModel):
    project_id: int
    task_id: int
    subtask_id: int
    work_date: date
    hours: float = Field(gt=0, le=24)
    note: str = ""


class TimeEntryUpdate(BaseModel):
    project_id: int
    task_id: int
    subtask_id: int
    work_date: date
    hours: float = Field(gt=0, le=24)
    note: str = ""


class RateUpsert(BaseModel):
    user_id: int
    effective_date: date
    bill_rate: float = Field(gt=0)
    cost_rate: float = Field(gt=0)


class LatestRateOut(BaseModel):
    user_id: int
    effective_date: date
    bill_rate: float
    cost_rate: float


class TimeEntryOut(BaseModel):
    id: int
    user_id: int
    project_id: int
    task_id: int
    subtask_id: int
    user_email: str | None = None
    user_full_name: str | None = None
    project_name: str | None = None
    task_name: str | None = None
    subtask_code: str | None = None
    subtask_name: str | None = None
    work_date: date
    hours: float
    note: str
    bill_rate_applied: float
    cost_rate_applied: float


class TimesheetOut(BaseModel):
    id: int
    user_id: int
    week_start: date
    week_end: date
    status: str
    employee_signed_at: datetime | None
    supervisor_signed_at: datetime | None
    total_hours: float


class TimesheetAdminOut(TimesheetOut):
    user_email: str
    user_full_name: str


class AccountingPreviewRow(BaseModel):
    posted_date: str
    description: str
    amount: float
    direction: str
    account_id: str
    vendor_norm: str
    dedupe_hash: str


class BankConnectionOut(BaseModel):
    id: int
    provider: str
    institution_name: str
    institution_id: str | None
    status: str
    last_synced_at: datetime | None
    created_at: datetime
    account_count: int = 0
    transaction_count: int = 0


class BankAccountOut(BaseModel):
    id: int
    connection_id: int
    account_id: str
    name: str
    mask: str | None
    type: str | None
    subtype: str | None
    is_business: bool
    current_balance: float | None
    available_balance: float | None
    iso_currency_code: str | None


class BankAccountClassificationRequest(BaseModel):
    is_business: bool


class BankTransactionClassificationRequest(BaseModel):
    is_business: bool


class BankTransactionCategoryRequest(BaseModel):
    expense_group: str = Field(default="OH", min_length=1, max_length=64)
    category: str = Field(default="Uncategorized", min_length=1, max_length=128)
    learn_for_merchant: bool = True


class PlaidSandboxConnectRequest(BaseModel):
    institution_id: str = "ins_109508"
    initial_products: list[str] = Field(default_factory=lambda: ["transactions"])


class PlaidSandboxConnectOut(BaseModel):
    ok: bool
    connection_id: int
    institution_name: str
    accounts: int


class PlaidLinkTokenOut(BaseModel):
    link_token: str
    expiration: str


class PlaidLinkTokenRequest(BaseModel):
    connection_id: int | None = None


class PlaidPublicTokenExchangeRequest(BaseModel):
    public_token: str


class BankSyncOut(BaseModel):
    ok: bool
    connection_id: int
    added: int
    modified: int
    removed: int
    has_more: bool
    reauth_required: bool = False
    reauth_detail: str | None = None


class BankReconciliationQueueRow(BaseModel):
    bank_transaction_id: int
    connection_id: int
    account_id: str
    account_name: str | None
    posted_date: date | None
    description: str
    amount: float
    merchant_name: str | None
    pending: bool
    is_business: bool
    expense_group: str | None = None
    category: str | None = None
    suggested_invoice_id: int | None = None
    suggested_invoice_number: str | None = None
    suggested_invoice_client: str | None = None
    suggested_confidence: float | None = None


class BankReconciliationQueueOut(BaseModel):
    rows: list[BankReconciliationQueueRow]
    total: int
    limit: int
    offset: int


class BankReconciliationMatchRequest(BaseModel):
    bank_transaction_id: int
    match_type: str = Field(default="invoice", pattern="^(invoice|expense|other)$")
    match_entity_id: int = Field(gt=0)
    status: str = Field(default="confirmed", pattern="^(suggested|confirmed|rejected)$")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    notes: str = ""


class BankImportExpenseCatOut(BaseModel):
    ok: bool
    connection_id: int
    connection_name: str
    accounts_created: int
    transactions_created: int
    transactions_updated: int
    rows_total: int
    rows_skipped: int


class BankImportedPlaidReconcileOut(BaseModel):
    ok: bool
    imported_candidates: int
    plaid_candidates: int
    matched_duplicates: int
    remaining_unmatched_imported: int


class BankCategoryRecommendationOut(BaseModel):
    ok: bool
    reviewed: int
    updated: int
    skipped_manual: int
    skipped_already_categorized: int
    skipped_no_match: int


class BankCategoryGroupOut(BaseModel):
    group: str
    categories: list[str]


class BankCategorySummaryRow(BaseModel):
    expense_group: str
    category: str
    transaction_count: int
    amount_abs: float


class BankExpenseSummaryRow(BaseModel):
    dimension: str
    label: str
    transaction_count: int
    amount_abs: float


class BankTransactionPostExpenseRequest(BaseModel):
    project_id: int = Field(gt=0)
    category: str = Field(default="Bank Import", min_length=1, max_length=128)
    description: str = Field(default="", max_length=255)
    expense_date: date | None = None


class TimeImportRowOut(BaseModel):
    row_number: int
    work_date: str | None
    employee_email: str | None
    project_name: str | None
    task_name: str | None
    subtask_name: str | None
    hours: float | None
    note: str
    status: str
    reason: str | None = None


class InvoicePreviewLineOut(BaseModel):
    user_id: int
    project_id: int
    task_id: int
    subtask_id: int
    work_date: date
    employee: str
    project: str
    task: str
    subtask: str
    hours: float
    bill_rate: float
    amount: float
    note: str
    source_time_entry_id: int


class InvoicePreviewOut(BaseModel):
    start: date
    end: date
    approved_only: bool
    project_id: int | None
    client_name: str
    line_count: int
    total_hours: float
    subtotal_amount: float
    total_cost: float
    total_profit: float
    logo_url: str
    lines: list[InvoicePreviewLineOut]


class InvoiceCreateRequest(BaseModel):
    start: date
    end: date
    project_id: int | None = None
    approved_only: bool = True
    issue_date: date | None = None
    due_date: date | None = None
    notes: str = ""


class InvoicePaymentUpdateRequest(BaseModel):
    amount_paid: float = Field(ge=0)
    paid_date: date | None = None
    status: str | None = None


class InvoicePaymentLinkCreateRequest(BaseModel):
    expires_in_days: int = Field(default=14, ge=1, le=120)


class InvoiceClientReconcileRequest(BaseModel):
    canonical_client_name: str = Field(min_length=1, max_length=255)
    aliases: list[str] = Field(default_factory=lambda: ["Imported Client", "Legacy Client"])


class InvoiceClientReconcileOut(BaseModel):
    canonical_client_name: str
    aliases: list[str]
    invoices_updated: int
    projects_updated: int


class InvoicePaymentLinkOut(BaseModel):
    invoice_id: int
    invoice_number: str
    payment_link_url: str
    token: str
    expires_at: date
    enabled: bool


class PublicInvoicePaymentViewOut(BaseModel):
    invoice_number: str
    client_name: str
    issue_date: date
    due_date: date
    status: str
    subtotal_amount: float
    amount_paid: float
    balance_due: float
    notes: str
    payment_link_expires_at: date | None
    can_pay: bool


class PublicInvoicePaymentRequest(BaseModel):
    amount: float = Field(gt=0)
    payer_email: EmailStr | None = None
    note: str = ""


class RecurringInvoiceScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = None
    cadence: str = Field(default="monthly")
    approved_only: bool = True
    due_days: int = Field(default=30, ge=1, le=120)
    next_run_date: date
    auto_send_email: bool = False
    recipient_email: EmailStr | None = None
    notes_template: str = ""
    is_active: bool = True


class RecurringInvoiceScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    project_id: int | None = None
    cadence: str | None = None
    approved_only: bool | None = None
    due_days: int | None = Field(default=None, ge=1, le=120)
    next_run_date: date | None = None
    auto_send_email: bool | None = None
    recipient_email: EmailStr | None = None
    notes_template: str | None = None
    is_active: bool | None = None


class RecurringInvoiceScheduleOut(BaseModel):
    id: int
    name: str
    project_id: int | None
    cadence: str
    approved_only: bool
    due_days: int
    next_run_date: date
    last_run_date: date | None
    auto_send_email: bool
    recipient_email: str
    notes_template: str
    is_active: bool
    created_at: datetime


class RecurringInvoiceRunResult(BaseModel):
    run_date: date
    schedules_considered: int
    invoices_created: int
    skipped_no_billable_entries: int
    skipped_existing_for_period: int
    errors: int
    invoice_ids: list[int]


class LegacyInvoiceImportRowOut(BaseModel):
    row_number: int
    invoice_number: str
    client_name: str
    issue_date: str | None
    due_date: str | None
    total_amount: float | None
    amount_paid: float | None
    balance_due: float | None
    status: str
    reason: str | None = None


class InvoiceLineOut(BaseModel):
    id: int
    user_id: int | None = None
    project_id: int | None = None
    task_id: int | None = None
    subtask_id: int | None = None
    work_date: date
    employee: str
    project: str
    task: str
    subtask: str
    description: str
    hours: float
    bill_rate: float
    cost_rate: float = 0.0
    amount: float
    note: str
    source_time_entry_id: int | None = None


class InvoiceOut(BaseModel):
    id: int
    invoice_number: str
    status: str
    source: str
    project_id: int | None
    client_name: str
    start_date: date
    end_date: date
    issue_date: date
    due_date: date
    subtotal_amount: float
    amount_paid: float
    balance_due: float
    total_cost: float
    total_profit: float
    recurring_schedule_id: int | None = None
    recurring_run_date: date | None = None
    payment_link_enabled: bool = False
    payment_link_expires_at: date | None = None
    payment_link_url: str | None = None
    paid_date: date | None = None
    notes: str
    logo_url: str
    line_count: int
    lines: list[InvoiceLineOut] = []


class InvoiceTaskSummaryRowOut(BaseModel):
    task: str
    previously_billed: float
    this_invoice: float
    billed_to_date: float
    contract_maximum: float
    contract_balance_remaining: float
    pct_complete_this_invoice: float
    pct_complete_to_date: float


class InvoiceAppendixEntryOut(BaseModel):
    time_entry_id: int
    work_date: date
    project: str
    task: str
    subtask: str
    note: str
    hours: float
    is_invoiced: bool


class InvoiceAppendixWeekOut(BaseModel):
    user_id: int
    employee: str
    email: str
    week_start: date
    week_end: date
    total_hours: float
    invoiced_hours: float
    entries: list[InvoiceAppendixEntryOut]


class InvoiceRenderContextOut(BaseModel):
    invoice_id: int
    invoice_number: str
    summary_rows: list[InvoiceTaskSummaryRowOut]
    appendix_weeks: list[InvoiceAppendixWeekOut]


NOISE_WORDS = {"POS", "ONLINE", "PAYMENT", "DEBIT", "CREDIT", "CARD", "PURCHASE"}
DEFAULT_EXPENSE_CATEGORY_MAP: dict[str, list[str]] = {
    "COGS": [
        "Labor",
        "Subconsultants",
        "Materials",
        "Field Services",
        "Permits And Fees",
        "Equipment Rental",
    ],
    "OH": [
        "Payroll Taxes And Processing",
        "Software And Subscriptions",
        "Office Supplies",
        "Insurance",
        "Travel",
        "Meals",
        "Rent",
        "Utilities",
        "Professional Services",
        "Bank Fees",
        "Interest Expense",
        "Taxes",
    ],
    "Other": [
        "Loan Payment",
        "Transfer",
        "Equity Transfer In/Out (...6611 / ...0273)",
        "Owner Draw",
        "Uncategorized",
    ],
}
BANK_CATEGORY_KEYWORD_RULES: list[tuple[list[str], tuple[str, str, float]]] = [
    (["adobe", "microsoft", "google workspace", "quickbooks", "xero", "dropbox", "github", "notion", "slack", "zoom", "atlassian"], ("OH", "Software And Subscriptions", 0.94)),
    (["insurance", "liability", "workers comp", "umbrella policy"], ("OH", "Insurance", 0.93)),
    (["hotel", "airbnb", "delta", "united", "american airlines", "uber", "lyft", "hertz", "enterprise"], ("OH", "Travel", 0.9)),
    (["restaurant", "cafe", "coffee", "lunch", "dinner", "doordash", "ubereats", "grubhub"], ("OH", "Meals", 0.86)),
    (["office depot", "staples", "amazon business", "printer", "ink", "paper"], ("OH", "Office Supplies", 0.9)),
    (["verizon", "att", "t mobile", "comcast", "pseg", "water", "electric"], ("OH", "Utilities", 0.9)),
    (["payroll", "gusto", "adp", "paychex"], ("OH", "Payroll Taxes And Processing", 0.95)),
    (["interest", "finance charge"], ("OH", "Interest Expense", 0.92)),
    (["bank fee", "service fee", "wire fee", "overdraft"], ("OH", "Bank Fees", 0.93)),
    (["permit", "inspection fee", "municipal fee", "filing fee"], ("COGS", "Permits And Fees", 0.9)),
    (["equipment rental", "rental", "home depot", "lowes", "grainger"], ("COGS", "Equipment Rental", 0.88)),
    (["material", "supply house", "build", "construction supply"], ("COGS", "Materials", 0.82)),
    (["consulting", "subcontract", "subconsultant"], ("COGS", "Subconsultants", 0.89)),
    (["ach transfer", "transfer", "internal transfer", "zelle", "venmo"], ("Other", "Equity Transfer In/Out (...6611 / ...0273)", 0.9)),
    (["owner draw", "draw"], ("Other", "Owner Draw", 0.94)),
    (["loan payment", "principal payment"], ("Other", "Loan Payment", 0.92)),
]
DATE_COLUMNS = ["Date", "Posted Date", "Posting Date", "Transaction Date"]
DESC_COLUMNS = ["Description", "Transaction Description", "Memo", "Details", "Payee", "Name"]
AMOUNT_COLUMNS = ["Amount"]
DEBIT_COLUMNS = ["Debit", "Withdrawal", "Charge"]
CREDIT_COLUMNS = ["Credit", "Deposit", "Payment"]
TIME_DATE_COLUMNS = ["Date", "Entry Date", "Logged Date", "Start Date", "Date of Service"]
TIME_EMPLOYEE_COLUMNS = ["Team Member", "Team member", "Staff", "Employee", "User", "Email", "Team Member Email"]
TIME_PROJECT_COLUMNS = ["Project", "Project Name", "Client + Project", "Client", "Project/Client"]
TIME_TASK_COLUMNS = ["Service", "Service Name", "Task", "Category"]
TIME_SUBTASK_COLUMNS = ["Subtask", "Activity", "Item", "Sub Service", "Sub-service"]
TIME_HOURS_COLUMNS = ["Hours", "Time", "Duration", "Duration (h:mm)", "Duration (decimal)"]
TIME_NOTE_COLUMNS = ["Note", "Notes", "Description", "Details", "Internal Notes"]
TIME_BILL_RATE_COLUMNS = ["Bill Rate", "Billable Rate", "Rate", "Hourly Rate", "Billable Hourly Rate"]
TIME_COST_RATE_COLUMNS = ["Cost Rate", "Cost", "Internal Cost Rate"]
TIME_STATUS_COLUMNS = ["Approval Status", "Status", "Approved", "Timesheet Status"]
INVOICE_NO_COLUMNS = ["Invoice #", "Invoice Number", "Invoice No", "Number", "Invoice"]
INVOICE_CLIENT_COLUMNS = ["Client", "Client Name", "Customer", "Company"]
INVOICE_ISSUE_DATE_COLUMNS = ["Invoice Date", "Issued Date", "Date"]
INVOICE_DUE_DATE_COLUMNS = ["Due Date", "Due"]
INVOICE_STATUS_COLUMNS = ["Status", "Invoice Status", "Payment Status"]
INVOICE_TOTAL_COLUMNS = ["Total", "Amount", "Invoice Total", "Total Amount", "Grand Total"]
INVOICE_PAID_COLUMNS = ["Paid", "Amount Paid", "Payments", "Paid Amount"]
INVOICE_BALANCE_COLUMNS = ["Balance", "Balance Due", "Amount Due", "Due Amount"]
APPROVED_STATUS_VALUES = {"approved", "yes", "true", "1", "locked", "billed", "closed"}
NON_APPROVED_STATUS_VALUES = {
    "unapproved",
    "not approved",
    "pending",
    "draft",
    "rejected",
    "no",
    "false",
    "0",
}
DEFAULT_STAFF_USERS = [
    {"email": "bertrand.byrne@aquatechpc.com", "full_name": "Bertrand Byrne"},
    {"email": "courtney.byrne@aquatechpc.com", "full_name": "Courtney Byrne"},
    {"email": "ailsa.welch@aquatechpc.com", "full_name": "Ailsa Welch"},
    {"email": "zachary.gilliam@aquatechpc.com", "full_name": "Zachary Gilliam"},
    {"email": "stacey.hodge@aquatechpc.com", "full_name": "Stacey Hodge"},
    {"email": "robert.svadlenka@aquatechpc.com", "full_name": "Robert Svadlenka"},
]
_reminder_thread_started = False
_recurring_thread_started = False


@app.on_event("startup")
def startup() -> None:
    init_db()
    _ensure_default_subtasks_for_all_tasks()
    _start_timesheet_reminder_worker()
    _start_recurring_invoice_worker()


def _ensure_default_subtasks_for_all_tasks() -> None:
    with SessionLocal() as db:
        tasks = db.scalars(select(Task)).all()
        created = 0
        for task in tasks:
            _, did_create = _ensure_default_subtask_for_task(db, task)
            if did_create:
                created += 1
        if created > 0:
            db.commit()


@app.get("/")
def health(db: Session = Depends(get_db)) -> dict[str, object]:
    user_count = db.scalar(select(func.count(User.id))) or 0
    return {"ok": True, "app": "aquatechpm", "users": user_count}


@app.get("/health")
def healthcheck(db: Session = Depends(get_db)) -> dict[str, object]:
    user_count = db.scalar(select(func.count(User.id))) or 0
    return {"ok": True, "app": "aquatechpm", "users": user_count}


def _plaid_base_url() -> str:
    env = (settings.PLAID_ENV or "sandbox").strip().lower()
    if env == "production":
        return "https://production.plaid.com"
    if env == "development":
        return "https://development.plaid.com"
    return "https://sandbox.plaid.com"


def _plaid_products() -> list[str]:
    values = [v.strip() for v in (settings.PLAID_PRODUCTS or "transactions").split(",")]
    return [v for v in values if v] or ["transactions"]


def _plaid_country_codes() -> list[str]:
    values = [v.strip().upper() for v in (settings.PLAID_COUNTRY_CODES or "US").split(",")]
    return [v for v in values if v] or ["US"]


def _plaid_post(path: str, payload: dict[str, object], timeout: int = 30) -> dict[str, object]:
    if not settings.PLAID_CLIENT_ID or not settings.PLAID_SECRET:
        raise HTTPException(status_code=400, detail="Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.")
    body = {"client_id": settings.PLAID_CLIENT_ID, "secret": settings.PLAID_SECRET, **payload}
    resp = requests.post(f"{_plaid_base_url()}{path}", json=body, timeout=timeout)
    if resp.status_code >= 300:
        try:
            err = resp.json()
            code = str(err.get("error_code") or "").strip()
            message = str(err.get("error_message") or "").strip()
            if code == "INVALID_PRODUCT":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Plaid production access is missing the requested product. "
                        "Enable the Transactions product in Plaid Dashboard (Request products), then retry."
                    ),
                )
            if code == "INVALID_API_KEYS":
                raise HTTPException(
                    status_code=400,
                    detail="Invalid Plaid client ID/secret for the selected environment. Verify production keys in .env and restart services.",
                )
            if code in {"ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN"}:
                compact = f"{code}: {message}".strip(": ").strip()
                raise HTTPException(status_code=409, detail=f"Plaid re-authentication required. {compact}")
            compact = f"{code}: {message}".strip(": ").strip()
            if compact:
                raise HTTPException(status_code=502, detail=f"Plaid API error {resp.status_code}: {compact}")
        except ValueError:
            pass
        detail = resp.text[:400]
        raise HTTPException(status_code=502, detail=f"Plaid API error {resp.status_code}: {detail}")
    return resp.json()


def _parse_optional_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _truncate_text(value: str | None, max_len: int) -> str:
    txt = (value or "").strip()
    return txt[:max_len] if len(txt) > max_len else txt


def _parse_json_obj(raw: str | None) -> dict[str, object]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _merchant_rule_key(merchant_name: str | None, description: str | None) -> str:
    base = (merchant_name or "").strip()
    if not base:
        base = (description or "").strip()
    normalized = re.sub(r"[^a-z0-9]+", " ", base.lower()).strip()
    return _truncate_text(normalized, 255)


def _normalize_bank_text(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _token_similarity(a: str, b: str) -> float:
    a_tokens = {t for t in a.split() if t}
    b_tokens = {t for t in b.split() if t}
    if not a_tokens or not b_tokens:
        return 0.0
    overlap = len(a_tokens & b_tokens)
    return overlap / float(max(len(a_tokens), len(b_tokens)))


def _contains_phrase(text: str, phrase: str) -> bool:
    if not phrase:
        return False
    normalized_phrase = _normalize_bank_text(phrase)
    if not normalized_phrase:
        return False
    return normalized_phrase in text


def _recommend_bank_category(
    tx: BankTransaction,
    merchant_rules: dict[str, tuple[str, str]],
    account_mask: str | None = None,
) -> tuple[str, str, float, str] | None:
    normalized_merchant = _normalize_bank_text(tx.merchant_name)
    normalized_name = _normalize_bank_text(tx.name)
    combined = f"{normalized_merchant} {normalized_name}".strip()
    if not combined:
        return None

    # Aquatech-specific transfer rule:
    # transfers between accounts ending 6611 and 0273 are treated as internal.
    transfer_markers = ("transfer", "ach", "internal transfer", "zelle", "venmo")
    has_transfer_marker = any(marker in combined for marker in transfer_markers)
    has_6611 = "6611" in combined or (account_mask or "") == "6611"
    has_0273 = "0273" in combined or (account_mask or "") == "0273"
    if has_transfer_marker and has_6611 and has_0273:
        return "Other", "Equity Transfer In/Out (...6611 / ...0273)", 0.995, "rule:aq_equity_transfer_6611_0273"

    rule_key = _merchant_rule_key(tx.merchant_name, tx.name)
    learned = merchant_rules.get(rule_key)
    if learned:
        return learned[0], learned[1], 0.98, "merchant_rule"

    for phrases, recommendation in BANK_CATEGORY_KEYWORD_RULES:
        for phrase in phrases:
            if _contains_phrase(combined, phrase):
                expense_group, category, confidence = recommendation
                return expense_group, category, confidence, f"keyword:{phrase}"
    return None


def _matched_bank_transaction_ids(db: Session) -> set[int]:
    return {int(v) for v in db.scalars(select(BankTransactionMatch.bank_transaction_id)).all() if v is not None}


def _tx_category_from_json(tx: BankTransaction) -> tuple[str | None, str | None]:
    category = None
    try:
        parsed = json.loads(tx.category_json or "[]")
        if isinstance(parsed, list) and parsed:
            category = str(parsed[0] or "").strip() or None
    except Exception:
        category = None
    raw_obj = _parse_json_obj(tx.raw_json)
    expense_group = str(raw_obj.get("expense_group") or "").strip() or None
    return expense_group, category


def _apply_merchant_rule_to_tx(
    tx: BankTransaction,
    raw_payload: dict[str, object],
    rules_by_key: dict[str, tuple[str, str]],
) -> None:
    rule_key = _merchant_rule_key(tx.merchant_name, tx.name)
    if not rule_key:
        return
    rule = rules_by_key.get(rule_key)
    if not rule:
        return
    current_raw = _parse_json_obj(tx.raw_json)
    if str(current_raw.get("category_source") or "").strip().lower() == "manual":
        return
    expense_group, category = rule
    tx.category_json = json.dumps([category])
    merged = {**raw_payload, **current_raw}
    merged["expense_group"] = expense_group
    merged["category"] = category
    merged["category_source"] = "merchant_rule"
    tx.raw_json = json.dumps(merged)


def _refresh_plaid_accounts(connection: BankConnection, db: Session) -> int:
    payload = _plaid_post("/accounts/balance/get", {"access_token": connection.access_token})
    accounts = payload.get("accounts", []) if isinstance(payload.get("accounts"), list) else []
    now = datetime.utcnow()
    upserted = 0
    for raw in accounts:
        if not isinstance(raw, dict):
            continue
        account_id = _truncate_text(str(raw.get("account_id") or "").strip(), 128)
        if not account_id:
            continue
        bal = raw.get("balances") if isinstance(raw.get("balances"), dict) else {}
        row = db.scalar(
            select(BankAccount).where(
                BankAccount.connection_id == connection.id,
                BankAccount.account_id == account_id,
            )
        )
        if not row:
            row = BankAccount(connection_id=connection.id, account_id=account_id)
            db.add(row)
        row.name = _truncate_text(str(raw.get("name") or ""), 255)
        row.mask = _truncate_text(str(raw.get("mask") or ""), 16) or None
        row.type = _truncate_text(str(raw.get("type") or ""), 64) or None
        row.subtype = _truncate_text(str(raw.get("subtype") or ""), 64) or None
        row.iso_currency_code = _truncate_text(str(raw.get("iso_currency_code") or ""), 16) or None
        row.current_balance = float(bal.get("current")) if bal.get("current") is not None else None
        row.available_balance = float(bal.get("available")) if bal.get("available") is not None else None
        if row.is_business is None:
            row.is_business = True
        row.last_synced_at = now
        upserted += 1
    return upserted


def _sync_plaid_transactions(connection: BankConnection, db: Session) -> tuple[int, int, int, bool]:
    cursor = connection.sync_cursor or ""
    account_business_map = {
        a.account_id: bool(a.is_business)
        for a in db.scalars(select(BankAccount).where(BankAccount.connection_id == connection.id)).all()
    }
    added_count = 0
    modified_count = 0
    removed_count = 0
    rules_by_key = {
        r.merchant_key: (r.expense_group, r.category)
        for r in db.scalars(select(BankMerchantRule).where(BankMerchantRule.user_id == connection.user_id)).all()
    }
    has_more = True
    while has_more:
        payload = _plaid_post("/transactions/sync", {"access_token": connection.access_token, "cursor": cursor})
        added = payload.get("added", []) if isinstance(payload.get("added"), list) else []
        modified = payload.get("modified", []) if isinstance(payload.get("modified"), list) else []
        removed = payload.get("removed", []) if isinstance(payload.get("removed"), list) else []
        for raw in added:
            if not isinstance(raw, dict):
                continue
            tx_id = _truncate_text(str(raw.get("transaction_id") or "").strip(), 128)
            if not tx_id:
                continue
            row = db.scalar(
                select(BankTransaction).where(
                    BankTransaction.connection_id == connection.id,
                    BankTransaction.transaction_id == tx_id,
                )
            )
            if not row:
                row = BankTransaction(connection_id=connection.id, transaction_id=tx_id, account_id=_truncate_text(str(raw.get("account_id") or ""), 128))
                db.add(row)
            row.account_id = _truncate_text(str(raw.get("account_id") or ""), 128)
            if row.is_business is None:
                row.is_business = bool(account_business_map.get(row.account_id, True))
            row.posted_date = _parse_optional_date(str(raw.get("date") or ""))
            row.name = _truncate_text(str(raw.get("name") or ""), 255)
            row.merchant_name = _truncate_text(str(raw.get("merchant_name") or ""), 255) or None
            row.amount = float(raw.get("amount") or 0)
            row.iso_currency_code = _truncate_text(str(raw.get("iso_currency_code") or ""), 16) or None
            row.pending = bool(raw.get("pending") or False)
            row.category_json = json.dumps(raw.get("category") or [])
            row.raw_json = json.dumps(raw)
            _apply_merchant_rule_to_tx(row, raw if isinstance(raw, dict) else {}, rules_by_key)
            added_count += 1
        for raw in modified:
            if not isinstance(raw, dict):
                continue
            tx_id = _truncate_text(str(raw.get("transaction_id") or "").strip(), 128)
            if not tx_id:
                continue
            row = db.scalar(
                select(BankTransaction).where(
                    BankTransaction.connection_id == connection.id,
                    BankTransaction.transaction_id == tx_id,
                )
            )
            if not row:
                row = BankTransaction(connection_id=connection.id, transaction_id=tx_id, account_id=_truncate_text(str(raw.get("account_id") or ""), 128))
                db.add(row)
            row.account_id = _truncate_text(str(raw.get("account_id") or ""), 128)
            if row.is_business is None:
                row.is_business = bool(account_business_map.get(row.account_id, True))
            row.posted_date = _parse_optional_date(str(raw.get("date") or ""))
            row.name = _truncate_text(str(raw.get("name") or ""), 255)
            row.merchant_name = _truncate_text(str(raw.get("merchant_name") or ""), 255) or None
            row.amount = float(raw.get("amount") or 0)
            row.iso_currency_code = _truncate_text(str(raw.get("iso_currency_code") or ""), 16) or None
            row.pending = bool(raw.get("pending") or False)
            row.category_json = json.dumps(raw.get("category") or [])
            row.raw_json = json.dumps(raw)
            _apply_merchant_rule_to_tx(row, raw if isinstance(raw, dict) else {}, rules_by_key)
            modified_count += 1
        for raw in removed:
            if not isinstance(raw, dict):
                continue
            tx_id = str(raw.get("transaction_id") or "").strip()
            if not tx_id:
                continue
            row = db.scalar(
                select(BankTransaction).where(
                    BankTransaction.connection_id == connection.id,
                    BankTransaction.transaction_id == tx_id,
                )
            )
            if row:
                db.delete(row)
                removed_count += 1
        has_more = bool(payload.get("has_more") or False)
        cursor = str(payload.get("next_cursor") or cursor)
        # Persist each page before the next Plaid call so we never hold
        # an open transaction idle while waiting on network I/O.
        connection.sync_cursor = cursor
        connection.last_synced_at = datetime.utcnow()
        db.commit()
        connection = db.get(BankConnection, connection.id) or connection
    return added_count, modified_count, removed_count, has_more


def _upsert_plaid_connection_from_access_token(access_token: str, user_id: int, db: Session) -> BankConnection:
    item = _plaid_post("/item/get", {"access_token": access_token})
    item_payload = item.get("item") if isinstance(item.get("item"), dict) else {}
    item_id = str(item_payload.get("item_id") or "")
    institution_id = str(item_payload.get("institution_id") or "") or None
    institution_name = institution_id or "Plaid Institution"
    if institution_id:
        try:
            inst = _plaid_post("/institutions/get_by_id", {"institution_id": institution_id, "country_codes": _plaid_country_codes()})
            institution_name = str((inst.get("institution") or {}).get("name") or institution_name)
        except Exception:
            pass
    row = db.scalar(select(BankConnection).where(BankConnection.item_id == item_id)) if item_id else None
    if not row:
        row = BankConnection(
            provider="plaid",
            user_id=user_id,
            institution_name=institution_name,
            institution_id=institution_id,
            item_id=item_id or None,
            access_token=access_token,
            status="connected",
        )
        db.add(row)
        db.flush()
    else:
        row.user_id = user_id
        row.institution_name = institution_name
        row.institution_id = institution_id
        row.access_token = access_token
        row.status = "connected"
    return row


@app.get("/bank/connections", response_model=list[BankConnectionOut])
def list_bank_connections(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankConnectionOut]:
    _ = current_user
    rows = db.scalars(select(BankConnection).order_by(BankConnection.created_at.desc())).all()
    out: list[BankConnectionOut] = []
    for row in rows:
        account_count = db.scalar(select(func.count(BankAccount.id)).where(BankAccount.connection_id == row.id)) or 0
        transaction_count = db.scalar(select(func.count(BankTransaction.id)).where(BankTransaction.connection_id == row.id)) or 0
        out.append(
            BankConnectionOut(
                id=row.id,
                provider=row.provider,
                institution_name=row.institution_name,
                institution_id=row.institution_id,
                status=row.status,
                last_synced_at=row.last_synced_at,
                created_at=row.created_at,
                account_count=int(account_count),
                transaction_count=int(transaction_count),
            )
        )
    return out


@app.get("/bank/accounts", response_model=list[BankAccountOut])
def list_bank_accounts(
    connection_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankAccountOut]:
    _ = current_user
    stmt = select(BankAccount).order_by(BankAccount.connection_id.asc(), BankAccount.name.asc(), BankAccount.id.asc())
    if connection_id is not None:
        stmt = stmt.where(BankAccount.connection_id == connection_id)
    rows = db.scalars(stmt).all()
    return [
        BankAccountOut(
            id=row.id,
            connection_id=row.connection_id,
            account_id=row.account_id,
            name=row.name,
            mask=row.mask,
            type=row.type,
            subtype=row.subtype,
            is_business=bool(row.is_business),
            current_balance=row.current_balance,
            available_balance=row.available_balance,
            iso_currency_code=row.iso_currency_code,
        )
        for row in rows
    ]


@app.post("/bank/accounts/{bank_account_id}/classification", response_model=dict[str, bool])
def classify_bank_account(
    bank_account_id: int,
    payload: BankAccountClassificationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, bool]:
    row = db.get(BankAccount, bank_account_id)
    if not row:
        raise HTTPException(status_code=404, detail="Bank account not found.")
    row.is_business = bool(payload.is_business)
    tx_rows = db.scalars(
        select(BankTransaction).where(
            BankTransaction.connection_id == row.connection_id,
            BankTransaction.account_id == row.account_id,
        )
    ).all()
    for tx in tx_rows:
        tx.is_business = bool(payload.is_business)
    _log_audit_event(
        db=db,
        entity_type="bank_account",
        entity_id=row.id,
        action="classify_bank_account",
        actor_user_id=current_user.id,
        payload={
            "connection_id": row.connection_id,
            "account_id": row.account_id,
            "is_business": bool(payload.is_business),
            "updated_transactions": len(tx_rows),
        },
    )
    db.commit()
    return {"ok": True}


@app.post("/bank/transactions/{bank_transaction_id}/classification", response_model=dict[str, bool])
def classify_bank_transaction(
    bank_transaction_id: int,
    payload: BankTransactionClassificationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, bool]:
    row = db.get(BankTransaction, bank_transaction_id)
    if not row:
        raise HTTPException(status_code=404, detail="Bank transaction not found.")
    row.is_business = bool(payload.is_business)
    _log_audit_event(
        db=db,
        entity_type="bank_transaction",
        entity_id=row.id,
        action="classify_bank_transaction",
        actor_user_id=current_user.id,
        payload={
            "connection_id": row.connection_id,
            "account_id": row.account_id,
            "is_business": bool(payload.is_business),
        },
    )
    db.commit()
    return {"ok": True}


@app.get("/bank/categories", response_model=list[BankCategoryGroupOut])
def list_bank_categories(
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankCategoryGroupOut]:
    _ = current_user
    return [BankCategoryGroupOut(group=k, categories=v) for k, v in DEFAULT_EXPENSE_CATEGORY_MAP.items()]


@app.get("/bank/categories/summary", response_model=list[BankCategorySummaryRow])
def bank_category_summary(
    include_personal: bool = Query(default=False),
    unmatched_only: bool = Query(default=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankCategorySummaryRow]:
    _ = current_user
    stmt = select(BankTransaction)
    if not include_personal:
        stmt = stmt.where(BankTransaction.is_business.is_(True))
    if unmatched_only:
        stmt = stmt.where(~exists(select(BankTransactionMatch.id).where(BankTransactionMatch.bank_transaction_id == BankTransaction.id)))
    tx_rows = db.scalars(stmt).all()

    agg: dict[tuple[str, str], dict[str, float]] = {}
    for tx in tx_rows:
        expense_group, category = _tx_category_from_json(tx)
        g = (expense_group or "Unassigned").strip() or "Unassigned"
        c = (category or "Uncategorized").strip() or "Uncategorized"
        key = (g, c)
        if key not in agg:
            agg[key] = {"count": 0.0, "abs": 0.0}
        agg[key]["count"] += 1
        agg[key]["abs"] += abs(float(tx.amount or 0.0))

    rows = [
        BankCategorySummaryRow(
            expense_group=k[0],
            category=k[1],
            transaction_count=int(v["count"]),
            amount_abs=float(v["abs"]),
        )
        for k, v in agg.items()
    ]
    rows.sort(key=lambda r: r.amount_abs, reverse=True)
    return rows


@app.get("/bank/summary", response_model=list[BankExpenseSummaryRow])
def bank_expense_summary(
    group_by: str = Query(default="category", pattern="^(category|merchant|expense_group)$"),
    include_personal: bool = Query(default=False),
    unmatched_only: bool = Query(default=True),
    limit: int = Query(default=20, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankExpenseSummaryRow]:
    _ = current_user
    stmt = select(BankTransaction)
    if not include_personal:
        stmt = stmt.where(BankTransaction.is_business.is_(True))
    if unmatched_only:
        stmt = stmt.where(~exists(select(BankTransactionMatch.id).where(BankTransactionMatch.bank_transaction_id == BankTransaction.id)))
    tx_rows = db.scalars(stmt).all()

    agg: dict[str, dict[str, float]] = {}
    for tx in tx_rows:
        expense_group, category = _tx_category_from_json(tx)
        if group_by == "merchant":
            label = (tx.merchant_name or "").strip() or _merchant_rule_key(None, tx.name) or "Unknown Merchant"
        elif group_by == "expense_group":
            label = (expense_group or "Unassigned").strip() or "Unassigned"
        else:
            label = (category or "Uncategorized").strip() or "Uncategorized"
        if label not in agg:
            agg[label] = {"count": 0.0, "abs": 0.0}
        agg[label]["count"] += 1
        agg[label]["abs"] += abs(float(tx.amount or 0.0))

    rows = [
        BankExpenseSummaryRow(
            dimension=group_by,
            label=label,
            transaction_count=int(v["count"]),
            amount_abs=float(v["abs"]),
        )
        for label, v in agg.items()
    ]
    rows.sort(key=lambda r: r.amount_abs, reverse=True)
    return rows[:limit]


@app.post("/bank/transactions/{bank_transaction_id}/categorize", response_model=dict[str, bool])
def categorize_bank_transaction(
    bank_transaction_id: int,
    payload: BankTransactionCategoryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, bool]:
    tx = db.get(BankTransaction, bank_transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Bank transaction not found.")
    expense_group = _truncate_text(payload.expense_group, 64) or "OH"
    category = _truncate_text(payload.category, 128) or "Uncategorized"
    tx.category_json = json.dumps([category])
    raw_obj = _parse_json_obj(tx.raw_json)
    raw_obj["expense_group"] = expense_group
    raw_obj["category"] = category
    raw_obj["category_source"] = "manual"
    tx.raw_json = json.dumps(raw_obj)

    merchant_key = _merchant_rule_key(tx.merchant_name, tx.name)
    if payload.learn_for_merchant and merchant_key:
        rule = db.scalar(
            select(BankMerchantRule).where(
                BankMerchantRule.user_id == current_user.id,
                BankMerchantRule.merchant_key == merchant_key,
            )
        )
        if not rule:
            rule = BankMerchantRule(
                user_id=current_user.id,
                merchant_key=merchant_key,
                expense_group=expense_group,
                category=category,
            )
            db.add(rule)
        else:
            rule.expense_group = expense_group
            rule.category = category
            rule.updated_at = datetime.utcnow()
        # Apply learned merchant rule to existing unmatched business transactions with same merchant pattern.
        candidate_rows = db.scalars(
            select(BankTransaction)
            .join(BankConnection, BankConnection.id == BankTransaction.connection_id)
            .where(BankConnection.user_id == current_user.id, BankTransaction.is_business.is_(True))
        ).all()
        matched_ids = {
            m.bank_transaction_id for m in db.scalars(select(BankTransactionMatch)).all() if m.bank_transaction_id is not None
        }
        for candidate in candidate_rows:
            if candidate.id in matched_ids:
                continue
            if _merchant_rule_key(candidate.merchant_name, candidate.name) != merchant_key:
                continue
            candidate.category_json = json.dumps([category])
            c_raw = _parse_json_obj(candidate.raw_json)
            if str(c_raw.get("category_source") or "").strip().lower() == "manual":
                continue
            c_raw["expense_group"] = expense_group
            c_raw["category"] = category
            c_raw["category_source"] = "merchant_rule"
            candidate.raw_json = json.dumps(c_raw)
    _log_audit_event(
        db=db,
        entity_type="bank_transaction",
        entity_id=tx.id,
        action="categorize_bank_transaction",
        actor_user_id=current_user.id,
        payload={
            "expense_group": expense_group,
            "category": category,
            "learn_for_merchant": bool(payload.learn_for_merchant),
            "merchant_key": merchant_key,
        },
    )
    db.commit()
    return {"ok": True}


@app.post("/bank/import/expense-cat-categorized", response_model=BankImportExpenseCatOut)
async def import_expense_cat_categorized_csv(
    file: UploadFile = File(...),
    connection_name: str = Form(default="Expense_CAT Import"),
    default_is_business: bool = Form(default=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> BankImportExpenseCatOut:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="CSV file is empty.")
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV header row is missing.")

    required_any = {"date", "description", "amount"}
    normalized_fields = {str(f or "").strip().lower() for f in reader.fieldnames}
    if not required_any.issubset(normalized_fields):
        raise HTTPException(status_code=400, detail="CSV must include date, description, and amount columns.")

    connection_name_clean = (connection_name or "Expense_CAT Import").strip() or "Expense_CAT Import"
    conn_row = db.scalar(
        select(BankConnection).where(
            BankConnection.provider == "expense_cat_import",
            BankConnection.institution_name == connection_name_clean,
            BankConnection.user_id == current_user.id,
        )
    )
    if not conn_row:
        conn_row = BankConnection(
            provider="expense_cat_import",
            user_id=current_user.id,
            institution_name=connection_name_clean,
            institution_id=None,
            item_id=None,
            access_token=None,
            status="connected",
        )
        db.add(conn_row)
        db.flush()

    created_accounts = 0
    created_tx = 0
    updated_tx = 0
    rows_total = 0
    rows_skipped = 0
    rules_by_key = {
        r.merchant_key: (r.expense_group, r.category)
        for r in db.scalars(select(BankMerchantRule).where(BankMerchantRule.user_id == current_user.id)).all()
    }

    account_cache: dict[str, BankAccount] = {}
    for row in reader:
        rows_total += 1
        date_raw = str(row.get("date") or "").strip()
        desc_raw = str(row.get("description") or "").strip()
        amount_raw = str(row.get("amount") or "").strip()
        if not date_raw or not desc_raw or not amount_raw:
            rows_skipped += 1
            continue
        try:
            amount = float(amount_raw)
        except ValueError:
            rows_skipped += 1
            continue
        posted_date = _parse_optional_date(date_raw)
        if posted_date is None:
            rows_skipped += 1
            continue

        account_id = _truncate_text(str(row.get("account") or "Expense_CAT_Imported"), 128) or "Expense_CAT_Imported"
        acct = account_cache.get(account_id)
        if acct is None:
            acct = db.scalar(
                select(BankAccount).where(
                    BankAccount.connection_id == conn_row.id,
                    BankAccount.account_id == account_id,
                )
            )
            if not acct:
                acct = BankAccount(
                    connection_id=conn_row.id,
                    account_id=account_id,
                    name=account_id,
                    is_business=bool(default_is_business),
                )
                db.add(acct)
                db.flush()
                created_accounts += 1
            account_cache[account_id] = acct

        transaction_id = _truncate_text(str(row.get("transaction_id") or ""), 128)
        if not transaction_id:
            dedupe_raw = f"{account_id}|{posted_date.isoformat()}|{desc_raw}|{amount:.2f}"
            transaction_id = hashlib.sha256(dedupe_raw.encode("utf-8")).hexdigest()[:40]

        tx = db.scalar(
            select(BankTransaction).where(
                BankTransaction.connection_id == conn_row.id,
                BankTransaction.transaction_id == transaction_id,
            )
        )
        category = _truncate_text(str(row.get("final_category") or row.get("category") or ""), 180)
        merchant = _truncate_text(str(row.get("merchant_key") or ""), 255) or None
        needs_review_raw = str(row.get("needs_review") or "").strip().lower()
        needs_review = needs_review_raw in {"1", "true", "yes", "y"}
        category_arr = [category] if category else []
        raw_payload = {
            "source": "expense_cat",
            "source_file": row.get("source_file"),
            "transaction_id": row.get("transaction_id"),
            "date": date_raw,
            "description": desc_raw,
            "merchant_key": row.get("merchant_key"),
            "account": account_id,
            "amount": amount,
            "is_expense": row.get("is_expense"),
            "expense_amount": row.get("expense_amount"),
            "category": row.get("category"),
            "final_category": row.get("final_category"),
            "confidence": row.get("confidence"),
            "category_source": row.get("category_source"),
            "needs_review": needs_review,
            "notes": row.get("notes"),
        }

        if not tx:
            tx = BankTransaction(
                connection_id=conn_row.id,
                account_id=account_id,
                transaction_id=transaction_id,
            )
            db.add(tx)
            created_tx += 1
        else:
            updated_tx += 1
        tx.posted_date = posted_date
        tx.name = _truncate_text(desc_raw, 255)
        tx.merchant_name = merchant
        tx.amount = float(amount)
        tx.iso_currency_code = str(row.get("currency") or "USD").strip() or "USD"
        tx.pending = False
        tx.is_business = bool(acct.is_business)
        tx.category_json = json.dumps(category_arr)
        tx.raw_json = json.dumps(raw_payload)
        _apply_merchant_rule_to_tx(tx, raw_payload, rules_by_key)

    conn_row.last_synced_at = datetime.utcnow()
    _log_audit_event(
        db=db,
        entity_type="bank_connection",
        entity_id=conn_row.id,
        action="import_expense_cat_categorized",
        actor_user_id=current_user.id,
        payload={
            "connection_name": connection_name_clean,
            "default_is_business": bool(default_is_business),
            "rows_total": rows_total,
            "rows_skipped": rows_skipped,
            "accounts_created": created_accounts,
            "transactions_created": created_tx,
            "transactions_updated": updated_tx,
        },
    )
    db.commit()
    return BankImportExpenseCatOut(
        ok=True,
        connection_id=conn_row.id,
        connection_name=connection_name_clean,
        accounts_created=created_accounts,
        transactions_created=created_tx,
        transactions_updated=updated_tx,
        rows_total=rows_total,
        rows_skipped=rows_skipped,
    )


@app.post("/bank/reconciliation/reconcile-imported", response_model=BankImportedPlaidReconcileOut)
def reconcile_imported_vs_plaid_duplicates(
    max_days_apart: int = Query(default=3, ge=0, le=7),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> BankImportedPlaidReconcileOut:
    matched_tx_ids = _matched_bank_transaction_ids(db)
    base_stmt = (
        select(BankTransaction)
        .join(BankConnection, BankConnection.id == BankTransaction.connection_id)
        .where(BankConnection.user_id == current_user.id, BankTransaction.is_business.is_(True), BankTransaction.pending.is_(False))
    )
    imported_rows = [
        t
        for t in db.scalars(base_stmt.where(BankConnection.provider == "expense_cat_import")).all()
        if t.id not in matched_tx_ids and t.posted_date is not None
    ]
    plaid_rows = [
        t
        for t in db.scalars(base_stmt.where(BankConnection.provider == "plaid")).all()
        if t.id not in matched_tx_ids and t.posted_date is not None
    ]
    if not imported_rows or not plaid_rows:
        return BankImportedPlaidReconcileOut(
            ok=True,
            imported_candidates=len(imported_rows),
            plaid_candidates=len(plaid_rows),
            matched_duplicates=0,
            remaining_unmatched_imported=len(imported_rows),
        )

    plaid_by_cents: dict[int, list[BankTransaction]] = defaultdict(list)
    for row in plaid_rows:
        cents = int(round(abs(float(row.amount or 0.0)) * 100))
        plaid_by_cents[cents].append(row)
    for rows in plaid_by_cents.values():
        rows.sort(key=lambda r: (r.posted_date or date.min, r.id), reverse=True)

    used_plaid_ids: set[int] = set()
    matched_count = 0
    for imported in sorted(imported_rows, key=lambda r: (r.posted_date or date.min, r.id), reverse=True):
        cents = int(round(abs(float(imported.amount or 0.0)) * 100))
        candidates = plaid_by_cents.get(cents, [])
        if not candidates:
            continue
        imported_date = imported.posted_date
        if not imported_date:
            continue
        imported_text = _normalize_bank_text(imported.merchant_name or imported.name)
        best: tuple[BankTransaction, float] | None = None
        for candidate in candidates:
            if candidate.id in used_plaid_ids:
                continue
            candidate_date = candidate.posted_date
            if not candidate_date:
                continue
            day_gap = abs((imported_date - candidate_date).days)
            if day_gap > max_days_apart:
                continue
            candidate_text = _normalize_bank_text(candidate.merchant_name or candidate.name)
            text_score = _token_similarity(imported_text, candidate_text)
            date_score = 1.0 - (day_gap / max(1, max_days_apart + 1))
            score = (text_score * 0.7) + (date_score * 0.3)
            if imported_text and candidate_text and imported_text == candidate_text:
                score += 0.15
            if not best or score > best[1]:
                best = (candidate, score)
        if not best:
            continue
        candidate, score = best
        if score < 0.45:
            continue
        db.add(
            BankTransactionMatch(
                bank_transaction_id=imported.id,
                match_type="other",
                match_entity_id=candidate.id,
                status="confirmed",
                confidence=min(1.0, max(0.0, score)),
                notes=f"Auto-duplicate of Plaid tx {candidate.id}",
                created_by_user_id=current_user.id,
            )
        )
        used_plaid_ids.add(candidate.id)
        matched_count += 1
    db.commit()
    return BankImportedPlaidReconcileOut(
        ok=True,
        imported_candidates=len(imported_rows),
        plaid_candidates=len(plaid_rows),
        matched_duplicates=matched_count,
        remaining_unmatched_imported=max(0, len(imported_rows) - matched_count),
    )


@app.post("/bank/reconciliation/apply-category-recommendations", response_model=BankCategoryRecommendationOut)
def apply_bank_category_recommendations(
    min_confidence: float = Query(default=0.8, ge=0.5, le=1.0),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> BankCategoryRecommendationOut:
    matched_tx_ids = _matched_bank_transaction_ids(db)
    merchant_rules = {
        r.merchant_key: (r.expense_group, r.category)
        for r in db.scalars(select(BankMerchantRule).where(BankMerchantRule.user_id == current_user.id)).all()
    }
    account_rows = db.scalars(
        select(BankAccount)
        .join(BankConnection, BankConnection.id == BankAccount.connection_id)
        .where(BankConnection.user_id == current_user.id)
    ).all()
    account_mask_by_key = {
        (a.connection_id, a.account_id): (str(a.mask or "").strip() or None)
        for a in account_rows
    }
    tx_rows = db.scalars(
        select(BankTransaction)
        .join(BankConnection, BankConnection.id == BankTransaction.connection_id)
        .where(
            BankConnection.user_id == current_user.id,
            BankTransaction.is_business.is_(True),
            BankTransaction.pending.is_(False),
        )
    ).all()

    reviewed = 0
    updated = 0
    skipped_manual = 0
    skipped_already = 0
    skipped_no_match = 0

    for tx in tx_rows:
        if tx.id in matched_tx_ids:
            continue
        reviewed += 1
        raw = _parse_json_obj(tx.raw_json)
        source = str(raw.get("category_source") or "").strip().lower()
        expense_group, category = _tx_category_from_json(tx)
        has_meaningful_category = bool((category or "").strip()) and (category or "").strip().lower() != "uncategorized"
        if source == "manual":
            skipped_manual += 1
            continue
        if has_meaningful_category and source in {"merchant_rule", "manual", "expense_cat", "heuristic_recommendation"}:
            skipped_already += 1
            continue

        recommendation = _recommend_bank_category(
            tx,
            merchant_rules,
            account_mask=account_mask_by_key.get((tx.connection_id, tx.account_id)),
        )
        if not recommendation:
            skipped_no_match += 1
            continue
        rec_group, rec_category, rec_confidence, rec_reason = recommendation
        if rec_confidence < min_confidence:
            skipped_no_match += 1
            continue

        tx.category_json = json.dumps([rec_category])
        merged_raw = {**raw}
        merged_raw["expense_group"] = rec_group
        merged_raw["category"] = rec_category
        merged_raw["category_source"] = (
            "heuristic_recommendation"
            if rec_reason.startswith("keyword:") or rec_reason.startswith("rule:")
            else "merchant_rule"
        )
        merged_raw["category_confidence"] = round(rec_confidence, 4)
        merged_raw["category_reason"] = rec_reason
        tx.raw_json = json.dumps(merged_raw)
        updated += 1

    _log_audit_event(
        db=db,
        entity_type="bank_connection",
        entity_id=0,
        action="apply_bank_category_recommendations",
        actor_user_id=current_user.id,
        payload={
            "min_confidence": min_confidence,
            "reviewed": reviewed,
            "updated": updated,
            "skipped_manual": skipped_manual,
            "skipped_already_categorized": skipped_already,
            "skipped_no_match": skipped_no_match,
        },
    )
    db.commit()
    return BankCategoryRecommendationOut(
        ok=True,
        reviewed=reviewed,
        updated=updated,
        skipped_manual=skipped_manual,
        skipped_already_categorized=skipped_already,
        skipped_no_match=skipped_no_match,
    )


@app.post("/bank/plaid/sandbox/connect", response_model=PlaidSandboxConnectOut)
def plaid_sandbox_connect(
    payload: PlaidSandboxConnectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> PlaidSandboxConnectOut:
    try:
        create_payload: dict[str, object] = {
            "institution_id": payload.institution_id,
            "initial_products": payload.initial_products or _plaid_products(),
            "options": {"webhook": "https://example.invalid/plaid/webhook"},
        }
        sandbox_resp = _plaid_post("/sandbox/public_token/create", create_payload)
        public_token = str(sandbox_resp.get("public_token") or "")
        if not public_token:
            raise HTTPException(status_code=502, detail="Plaid sandbox did not return public_token.")
        exchange = _plaid_post("/item/public_token/exchange", {"public_token": public_token})
        access_token = str(exchange.get("access_token") or "")
        if not access_token:
            raise HTTPException(status_code=502, detail="Plaid token exchange failed.")
        row = _upsert_plaid_connection_from_access_token(access_token, current_user.id, db)
        db.commit()
        accounts = _refresh_plaid_accounts(row, db)
        _sync_plaid_transactions(row, db)
        db.commit()
        return PlaidSandboxConnectOut(ok=True, connection_id=row.id, institution_name=row.institution_name, accounts=accounts)
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Temporary database timeout during Plaid sync. Please retry.")


@app.post("/bank/plaid/link-token", response_model=PlaidLinkTokenOut)
def create_plaid_link_token(
    payload: PlaidLinkTokenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> PlaidLinkTokenOut:
    request_payload: dict[str, object] = {
        "user": {"client_user_id": str(current_user.id)},
        "client_name": "AquatechPM",
        "products": _plaid_products(),
        "country_codes": _plaid_country_codes(),
        "language": "en",
    }

    if payload.connection_id is not None:
        row = db.get(BankConnection, payload.connection_id)
        if not row:
            raise HTTPException(status_code=404, detail="Bank connection not found.")
        if row.provider != "plaid":
            raise HTTPException(status_code=400, detail="Unsupported provider.")
        if not row.access_token:
            raise HTTPException(status_code=400, detail="Connection has no access token.")
        request_payload["access_token"] = row.access_token

    resp = _plaid_post("/link/token/create", request_payload)
    link_token = str(resp.get("link_token") or "")
    expiration = str(resp.get("expiration") or "")
    if not link_token:
        raise HTTPException(status_code=502, detail="Plaid did not return link_token.")
    return PlaidLinkTokenOut(link_token=link_token, expiration=expiration)


@app.post("/bank/plaid/exchange-public-token", response_model=PlaidSandboxConnectOut)
def plaid_exchange_public_token(
    payload: PlaidPublicTokenExchangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> PlaidSandboxConnectOut:
    try:
        exchange = _plaid_post("/item/public_token/exchange", {"public_token": payload.public_token})
        access_token = str(exchange.get("access_token") or "")
        if not access_token:
            raise HTTPException(status_code=502, detail="Plaid token exchange failed.")
        row = _upsert_plaid_connection_from_access_token(access_token, current_user.id, db)
        db.commit()
        accounts = _refresh_plaid_accounts(row, db)
        _sync_plaid_transactions(row, db)
        db.commit()
        return PlaidSandboxConnectOut(ok=True, connection_id=row.id, institution_name=row.institution_name, accounts=accounts)
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Temporary database timeout during Plaid sync. Please retry.")


@app.post("/bank/connections/{connection_id}/sync", response_model=BankSyncOut)
def sync_bank_connection(
    connection_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> BankSyncOut:
    _ = current_user
    try:
        row = db.get(BankConnection, connection_id)
        if not row:
            raise HTTPException(status_code=404, detail="Bank connection not found.")
        if row.provider != "plaid":
            raise HTTPException(status_code=400, detail="Unsupported provider.")
        if not row.access_token:
            raise HTTPException(status_code=400, detail="Connection has no access token.")
        db.commit()
        _refresh_plaid_accounts(row, db)
        added, modified, removed, has_more = _sync_plaid_transactions(row, db)
        row.status = "connected"
        db.commit()
        return BankSyncOut(
            ok=True,
            connection_id=row.id,
            added=added,
            modified=modified,
            removed=removed,
            has_more=has_more,
        )
    except HTTPException as exc:
        if exc.status_code == 409:
            row = db.get(BankConnection, connection_id)
            if row:
                row.status = "reauth_required"
                db.commit()
            return BankSyncOut(
                ok=False,
                connection_id=connection_id,
                added=0,
                modified=0,
                removed=0,
                has_more=False,
                reauth_required=True,
                reauth_detail=str(exc.detail),
            )
        raise
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Temporary database timeout during bank sync. Please retry.")


def _build_bank_reconciliation_rows(
    db: Session,
    limit: int,
    offset: int,
    include_personal: bool,
) -> tuple[list[BankReconciliationQueueRow], int]:
    matched_tx_ids = select(BankTransactionMatch.bank_transaction_id)
    base_stmt = select(BankTransaction).where(~BankTransaction.id.in_(matched_tx_ids))
    if not include_personal:
        base_stmt = base_stmt.where(BankTransaction.is_business.is_(True))
    total = int(db.scalar(select(func.count()).select_from(base_stmt.subquery())) or 0)
    tx_rows = db.scalars(
        base_stmt.order_by(BankTransaction.posted_date.desc().nullslast(), BankTransaction.id.desc()).offset(offset).limit(limit)
    ).all()
    invoices = db.scalars(select(Invoice).where(Invoice.status.in_(["sent", "partial", "paid"]))).all()
    account_rows = db.scalars(select(BankAccount)).all()
    account_name_by_key = {(a.connection_id, a.account_id): a.name for a in account_rows}
    out: list[BankReconciliationQueueRow] = []
    for tx in tx_rows:
        expense_group, category = _tx_category_from_json(tx)
        suggested_invoice: Invoice | None = None
        confidence = None
        if not tx.pending:
            best_score = -1.0
            for inv in invoices:
                if inv.subtotal_amount <= 0:
                    continue
                amt_diff = abs(float(tx.amount) - float(inv.subtotal_amount))
                if amt_diff > 0.01:
                    continue
                score = 0.75
                if tx.posted_date and inv.issue_date and abs((tx.posted_date - inv.issue_date).days) <= 14:
                    score += 0.15
                if tx.merchant_name and inv.client_name and tx.merchant_name.lower() in inv.client_name.lower():
                    score += 0.1
                if score > best_score:
                    best_score = score
                    suggested_invoice = inv
            if suggested_invoice:
                confidence = min(1.0, best_score)
        out.append(
            BankReconciliationQueueRow(
                bank_transaction_id=tx.id,
                connection_id=tx.connection_id,
                account_id=tx.account_id,
                account_name=account_name_by_key.get((tx.connection_id, tx.account_id)),
                posted_date=tx.posted_date,
                description=tx.name,
                amount=tx.amount,
                merchant_name=tx.merchant_name,
                pending=tx.pending,
                is_business=bool(tx.is_business),
                expense_group=expense_group,
                category=category,
                suggested_invoice_id=suggested_invoice.id if suggested_invoice else None,
                suggested_invoice_number=suggested_invoice.invoice_number if suggested_invoice else None,
                suggested_invoice_client=suggested_invoice.client_name if suggested_invoice else None,
                suggested_confidence=confidence,
            )
        )
    return out, total


@app.get("/bank/reconciliation/queue", response_model=list[BankReconciliationQueueRow])
def bank_reconciliation_queue(
    limit: int = Query(default=50, ge=1, le=500),
    include_personal: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[BankReconciliationQueueRow]:
    _ = current_user
    out, _total = _build_bank_reconciliation_rows(db=db, limit=limit, offset=0, include_personal=include_personal)
    return out


@app.get("/bank/reconciliation/queue-page", response_model=BankReconciliationQueueOut)
def bank_reconciliation_queue_page(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    include_personal: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> BankReconciliationQueueOut:
    _ = current_user
    rows, total = _build_bank_reconciliation_rows(db=db, limit=limit, offset=offset, include_personal=include_personal)
    return BankReconciliationQueueOut(rows=rows, total=total, limit=limit, offset=offset)


@app.post("/bank/reconciliation/match", response_model=dict[str, bool])
def create_bank_reconciliation_match(
    payload: BankReconciliationMatchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, bool]:
    tx = db.get(BankTransaction, payload.bank_transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Bank transaction not found.")
    existing = db.scalar(select(BankTransactionMatch).where(BankTransactionMatch.bank_transaction_id == tx.id))
    if not existing:
        existing = BankTransactionMatch(
            bank_transaction_id=tx.id,
            match_type=payload.match_type,
            match_entity_id=payload.match_entity_id,
            status=payload.status,
            confidence=payload.confidence,
            notes=payload.notes,
            created_by_user_id=current_user.id,
        )
        db.add(existing)
    else:
        existing.match_type = payload.match_type
        existing.match_entity_id = payload.match_entity_id
        existing.status = payload.status
        existing.confidence = payload.confidence
        existing.notes = payload.notes
        existing.created_by_user_id = current_user.id
    db.commit()
    return {"ok": True}


@app.post("/bank/transactions/{bank_transaction_id}/post-expense", response_model=ProjectExpenseOut)
def post_bank_transaction_to_project_expense(
    bank_transaction_id: int,
    payload: BankTransactionPostExpenseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> ProjectExpenseOut:
    tx = db.get(BankTransaction, bank_transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Bank transaction not found.")
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    existing_match = db.scalar(select(BankTransactionMatch).where(BankTransactionMatch.bank_transaction_id == tx.id))
    if existing_match and existing_match.match_type == "expense":
        raise HTTPException(status_code=400, detail="Transaction is already posted as a project expense.")
    if existing_match and existing_match.match_type != "expense":
        raise HTTPException(status_code=400, detail="Transaction already matched. Clear that match first.")

    expense_amount = abs(float(tx.amount or 0.0))
    if expense_amount <= 0:
        raise HTTPException(status_code=400, detail="Only non-zero transactions can be posted as expenses.")
    expense_date = payload.expense_date or tx.posted_date or datetime.utcnow().date()
    description = (payload.description or "").strip() or tx.name
    exp = ProjectExpense(
        project_id=project.id,
        expense_date=expense_date,
        category=payload.category,
        description=_truncate_text(description, 255),
        amount=expense_amount,
    )
    db.add(exp)
    db.flush()

    match = BankTransactionMatch(
        bank_transaction_id=tx.id,
        match_type="expense",
        match_entity_id=exp.id,
        status="confirmed",
        confidence=1.0,
        notes=f"Posted to project {project.name}",
        created_by_user_id=current_user.id,
    )
    db.add(match)
    _log_audit_event(
        db=db,
        entity_type="bank_transaction",
        entity_id=tx.id,
        action="post_bank_tx_to_project_expense",
        actor_user_id=current_user.id,
        payload={
            "project_id": project.id,
            "project_name": project.name,
            "project_expense_id": exp.id,
            "expense_amount": expense_amount,
        },
    )
    db.commit()
    return ProjectExpenseOut(
        id=exp.id,
        project_id=exp.project_id,
        expense_date=exp.expense_date,
        category=exp.category,
        description=exp.description,
        amount=exp.amount,
    )


@app.get("/auth/google/login")
def google_login(request: Request) -> RedirectResponse:
    if settings.GOOGLE_CLIENT_ID == "REPLACE_ME" or settings.GOOGLE_CLIENT_SECRET == "REPLACE_ME":
        raise HTTPException(status_code=500, detail="Google OAuth is not configured on the server")

    state = secrets.token_urlsafe(24)
    request.session["google_oauth_state"] = state
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "hd": settings.ALLOWED_GOOGLE_DOMAIN,
        "prompt": "select_account",
    }
    auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    return RedirectResponse(url=auth_url)


@app.get("/auth/google/callback")
def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if error:
        return _oauth_redirect("google_error", error)
    if not code:
        return _oauth_redirect("google_error", "missing_code")

    expected_state = request.session.pop("google_oauth_state", None)
    if not expected_state or state != expected_state:
        return _oauth_redirect("google_error", "invalid_state")

    if settings.GOOGLE_CLIENT_ID == "REPLACE_ME" or settings.GOOGLE_CLIENT_SECRET == "REPLACE_ME":
        return _oauth_redirect("google_error", "oauth_not_configured")

    try:
        token_resp = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": settings.GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        if token_resp.status_code != 200:
            detail = f"token_exchange_failed_{token_resp.status_code}"
            try:
                payload = token_resp.json()
                err = str(payload.get("error", "")).strip()
                desc = str(payload.get("error_description", "")).strip()
                if err or desc:
                    compact = f"{err}:{desc}" if desc else err
                    compact = re.sub(r"[^a-zA-Z0-9_.:@-]+", "_", compact)[:180]
                    detail = f"{detail}_{compact}"
            except Exception:
                pass
            return _oauth_redirect("google_error", detail)
        token_payload = token_resp.json()
        raw_id_token = token_payload.get("id_token")
        if not raw_id_token:
            return _oauth_redirect("google_error", "missing_id_token")
    except Exception as exc:
        detail = re.sub(r"[^a-zA-Z0-9_.:@-]+", "_", f"{type(exc).__name__}:{exc}")[:180]
        return _oauth_redirect("google_error", f"oauth_token_step_failed_{detail}")

    claims: dict[str, object] = {}
    verify_error_detail = ""
    try:
        claims = id_token.verify_oauth2_token(raw_id_token, GoogleAuthRequest(), settings.GOOGLE_CLIENT_ID)
    except Exception as exc:
        verify_error_detail = re.sub(r"[^a-zA-Z0-9_.:@-]+", "_", f"{type(exc).__name__}:{exc}")[:160]
        # Fallback verifier if google-auth cert retrieval/validation fails in runtime environment.
        try:
            info_resp = requests.get(
                "https://oauth2.googleapis.com/tokeninfo",
                params={"id_token": raw_id_token},
                timeout=15,
            )
            if info_resp.status_code == 200:
                info = info_resp.json()
                aud = str(info.get("aud", "")).strip()
                iss = str(info.get("iss", "")).strip()
                if aud != settings.GOOGLE_CLIENT_ID:
                    return _oauth_redirect("google_error", "oauth_verify_failed_audience_mismatch")
                if iss not in {"https://accounts.google.com", "accounts.google.com"}:
                    return _oauth_redirect("google_error", "oauth_verify_failed_issuer_mismatch")
                claims = info
            else:
                detail = re.sub(r"[^a-zA-Z0-9_.:@-]+", "_", info_resp.text)[:140]
                return _oauth_redirect("google_error", f"oauth_verify_failed_tokeninfo_{info_resp.status_code}_{detail}")
        except Exception as fallback_exc:
            fb = re.sub(r"[^a-zA-Z0-9_.:@-]+", "_", f"{type(fallback_exc).__name__}:{fallback_exc}")[:140]
            return _oauth_redirect("google_error", f"oauth_verify_failed_{verify_error_detail}_fallback_{fb}")

    email = str(claims.get("email", "")).lower().strip()
    email_verified_raw = claims.get("email_verified")
    email_verified = (
        bool(email_verified_raw)
        if isinstance(email_verified_raw, bool)
        else str(email_verified_raw).lower() == "true"
    )
    full_name = str(claims.get("name", "")).strip()

    if not email or not email_verified:
        return _oauth_redirect("google_error", "unverified_email")
    if email.split("@")[-1] != settings.ALLOWED_GOOGLE_DOMAIN.lower():
        return _oauth_redirect("google_error", "domain_not_allowed")

    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(
            email=email,
            full_name=full_name or email.split("@")[0],
            role="employee",
            is_active=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif full_name and user.full_name != full_name:
        user.full_name = full_name
        db.commit()

    if not user.is_active:
        request.session.clear()
        return _oauth_redirect("google_error", "inactive_user")

    request.session["user_id"] = user.id
    return _oauth_redirect("ok", "signed_in")


@app.post("/auth/dev/bootstrap-admin", response_model=UserOut)
def dev_bootstrap_admin(payload: DevBootstrapRequest, request: Request, db: Session = Depends(get_db)) -> UserOut:
    if not settings.DEV_AUTH_BYPASS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Dev auth bypass disabled")
    domain = payload.email.split("@")[-1].lower()
    if domain != settings.ALLOWED_GOOGLE_DOMAIN.lower():
        raise HTTPException(status_code=400, detail="Email domain is not allowed")

    existing_admin = db.scalar(select(func.count(User.id)).where(and_(User.role == "admin", User.is_active.is_(True))))
    if existing_admin:
        raise HTTPException(status_code=409, detail="An active admin already exists")

    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if not user:
        user = User(
            email=payload.email.lower(),
            full_name=payload.full_name,
            role="admin",
            is_active=True,
        )
        db.add(user)
    else:
        user.role = "admin"
        user.full_name = payload.full_name
        user.is_active = True

    db.commit()
    db.refresh(user)
    request.session["user_id"] = user.id
    return _to_user_out(user)


@app.post("/auth/dev/login", response_model=UserOut)
def dev_login(payload: DevLoginRequest, request: Request, db: Session = Depends(get_db)) -> UserOut:
    if not settings.DEV_AUTH_BYPASS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Dev auth bypass disabled")
    email = payload.email.lower()
    domain = email.split("@")[-1]
    if domain != settings.ALLOWED_GOOGLE_DOMAIN.lower():
        raise HTTPException(status_code=400, detail="Email domain is not allowed")

    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(email=email, full_name=email.split("@")[0], role="employee", is_active=False)
        db.add(user)
        db.commit()
        db.refresh(user)

    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is inactive. Ask an admin to activate your account.")

    request.session["user_id"] = user.id
    return _to_user_out(user)


@app.post("/auth/logout")
def logout(request: Request) -> dict[str, bool]:
    request.session.clear()
    return {"ok": True}


@app.get("/auth/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)) -> UserOut:
    return _to_user_out(current_user)


@app.get("/users/pending", response_model=list[UserOut])
def pending_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_USERS")),
) -> list[UserOut]:
    users = db.scalars(select(User).where(User.is_active.is_(False)).order_by(User.created_at.asc())).all()
    return [_to_user_out(u) for u in users]


@app.post("/users/{user_id}/activate", response_model=UserOut)
def activate_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_USERS")),
) -> UserOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_active = True
    db.commit()
    db.refresh(user)
    return _to_user_out(user)


@app.get("/users", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_USERS")),
) -> list[UserOut]:
    users = db.scalars(select(User).order_by(User.email.asc())).all()
    return [_to_user_out(u) for u in users]


@app.get("/audit/events", response_model=list[AuditEventOut])
def list_audit_events(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    entity_type: str | None = Query(default=None),
    action: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_USERS")),
) -> list[AuditEventOut]:
    q = select(AuditEvent)
    if entity_type and entity_type.strip():
        q = q.where(AuditEvent.entity_type == entity_type.strip())
    if action and action.strip():
        q = q.where(AuditEvent.action == action.strip())
    rows = db.scalars(q.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).offset(offset).limit(limit)).all()
    actor_ids = sorted({int(r.actor_user_id) for r in rows if r.actor_user_id is not None})
    actor_email_by_id: dict[int, str] = {}
    if actor_ids:
        users = db.scalars(select(User).where(User.id.in_(actor_ids))).all()
        actor_email_by_id = {u.id: u.email for u in users}
    return [
        AuditEventOut(
            id=r.id,
            entity_type=r.entity_type,
            entity_id=r.entity_id,
            action=r.action,
            actor_user_id=r.actor_user_id,
            actor_user_email=actor_email_by_id.get(int(r.actor_user_id)) if r.actor_user_id is not None else None,
            payload_json=r.payload_json or "{}",
            created_at=r.created_at,
        )
        for r in rows
    ]


@app.put("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_USERS")),
) -> UserOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    role = (payload.role or user.role).strip().lower()
    if role not in {"admin", "manager", "employee"}:
        raise HTTPException(status_code=400, detail="role must be admin, manager, or employee")
    user.full_name = payload.full_name.strip()
    user.start_date = payload.start_date
    user.is_active = payload.is_active
    user.role = role
    _log_audit_event(
        db=db,
        entity_type="user",
        entity_id=user.id,
        action="update_user",
        actor_user_id=current_user.id,
        payload={
            "full_name": user.full_name,
            "start_date": user.start_date.isoformat() if user.start_date else None,
            "is_active": user.is_active,
            "role": user.role,
        },
    )
    db.commit()
    db.refresh(user)
    return _to_user_out(user)


@app.post("/users/provision-default-staff")
def provision_default_staff(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_USERS")),
) -> dict[str, object]:
    created = 0
    updated = 0
    kept_admin = 0
    users_out: list[dict[str, object]] = []
    for row in DEFAULT_STAFF_USERS:
        email = row["email"].lower()
        user = db.scalar(select(User).where(User.email == email))
        if not user:
            user = User(
                email=email,
                full_name=row["full_name"],
                role="employee",
                is_active=True,
            )
            db.add(user)
            created += 1
        else:
            user.full_name = row["full_name"]
            user.is_active = True
            if user.role != "admin":
                user.role = "employee"
            else:
                kept_admin += 1
            updated += 1
        users_out.append({"email": email, "full_name": row["full_name"]})
    db.commit()
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "kept_admin": kept_admin,
        "users": users_out,
    }


@app.get("/timeframes/pay-period")
def pay_period(date_str: str) -> dict[str, str]:
    d = date.fromisoformat(date_str)
    s, e = pay_period_for(d)
    return {"start": s.isoformat(), "end": e.isoformat()}


@app.post("/projects", response_model=ProjectOut)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectOut:
    if not payload.is_overhead:
        if not payload.client_name or not payload.pm_user_id:
            raise HTTPException(status_code=400, detail="Non-overhead projects require client_name and pm_user_id")
    if not payload.start_date or not payload.end_date:
        raise HTTPException(status_code=400, detail="Project start_date and end_date are required")
    if payload.start_date and payload.end_date and payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="Project end_date cannot be before start_date")
    if payload.overall_budget_fee <= 0:
        raise HTTPException(status_code=400, detail="Project overall_budget_fee must be greater than 0")

    if payload.pm_user_id and not db.get(User, payload.pm_user_id):
        raise HTTPException(status_code=400, detail="pm_user_id does not exist")
    duplicate = db.scalar(select(Project).where(func.lower(Project.name) == payload.name.strip().lower()))
    if duplicate:
        raise HTTPException(status_code=400, detail="Project name already exists")

    project = Project(
        name=payload.name.strip(),
        client_name=payload.client_name.strip() if payload.client_name else None,
        pm_user_id=payload.pm_user_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        overall_budget_fee=payload.overall_budget_fee,
        target_gross_margin_pct=payload.target_gross_margin_pct,
        is_overhead=payload.is_overhead,
        is_billable=payload.is_billable,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return _to_project_out(project)


@app.get("/projects", response_model=list[ProjectOut])
def list_projects(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ProjectOut]:
    q = select(Project).order_by(Project.created_at.desc())
    if not include_inactive:
        q = q.where(Project.is_active.is_(True))
    projects = [p for p in db.scalars(q).all() if not _is_hidden_project_name(p.name)]
    return [_to_project_out(p) for p in projects]


@app.put("/projects/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectOut:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not payload.is_overhead:
        if not payload.client_name or not payload.pm_user_id:
            raise HTTPException(status_code=400, detail="Non-overhead projects require client_name and pm_user_id")
    if payload.start_date and payload.end_date and payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="Project end_date cannot be before start_date")
    if payload.is_active and (not payload.start_date or not payload.end_date):
        raise HTTPException(status_code=400, detail="Active projects require start_date and end_date")
    if payload.is_active and payload.overall_budget_fee <= 0:
        raise HTTPException(status_code=400, detail="Active projects require overall_budget_fee greater than 0")
    if payload.pm_user_id and not db.get(User, payload.pm_user_id):
        raise HTTPException(status_code=400, detail="pm_user_id does not exist")
    duplicate = db.scalar(
        select(Project).where(and_(func.lower(Project.name) == payload.name.strip().lower(), Project.id != project_id))
    )
    if duplicate:
        raise HTTPException(status_code=400, detail="Project name already exists")
    budget_fee_sum = _sum_subtask_budget_fee_for_project(db, project_id)
    if payload.overall_budget_fee < budget_fee_sum:
        raise HTTPException(
            status_code=400,
            detail=f"Overall budget fee cannot be less than current WBS budget total ({budget_fee_sum:.2f})",
        )

    project.name = payload.name.strip()
    project.client_name = payload.client_name.strip() if payload.client_name else None
    project.pm_user_id = payload.pm_user_id
    project.start_date = payload.start_date
    project.end_date = payload.end_date
    project.overall_budget_fee = payload.overall_budget_fee
    project.target_gross_margin_pct = payload.target_gross_margin_pct
    project.is_overhead = payload.is_overhead
    project.is_billable = payload.is_billable
    project.is_active = payload.is_active
    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project.id,
        action="update_project",
        actor_user_id=_.id,
        payload={
            "name": project.name,
            "client_name": project.client_name,
            "pm_user_id": project.pm_user_id,
            "start_date": project.start_date.isoformat() if project.start_date else None,
            "end_date": project.end_date.isoformat() if project.end_date else None,
            "overall_budget_fee": project.overall_budget_fee,
            "target_gross_margin_pct": project.target_gross_margin_pct,
            "is_overhead": project.is_overhead,
            "is_billable": project.is_billable,
            "is_active": project.is_active,
        },
    )
    db.commit()
    db.refresh(project)
    return _to_project_out(project)


@app.post("/projects/{project_id}/tasks")
def create_task(
    project_id: int,
    payload: TaskCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_WBS")),
) -> dict[str, int | str]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    task_is_billable = payload.is_billable if payload.is_billable is not None else bool(project.is_billable)
    task = Task(project_id=project_id, name=payload.name.strip(), is_billable=task_is_billable)
    db.add(task)
    db.flush()
    _ensure_default_subtask_for_task(db, task)
    db.commit()
    db.refresh(task)
    return {"id": task.id, "name": task.name, "project_id": project_id, "is_billable": task.is_billable}


@app.put("/tasks/{task_id}")
def update_task(
    task_id: int,
    payload: TaskUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_WBS")),
) -> dict[str, int | str]:
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.name = payload.name.strip()
    task.is_billable = payload.is_billable
    _log_audit_event(
        db=db,
        entity_type="task",
        entity_id=task.id,
        action="update_task",
        actor_user_id=_.id,
        payload={"name": task.name, "project_id": task.project_id, "is_billable": task.is_billable},
    )
    db.commit()
    db.refresh(task)
    return {"id": task.id, "name": task.name, "project_id": task.project_id, "is_billable": task.is_billable}


@app.post("/tasks/{task_id}/subtasks")
def create_subtask(
    task_id: int,
    payload: SubtaskCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_WBS")),
) -> dict[str, int | str | float]:
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.get(Project, task.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.overall_budget_fee > 0:
        existing = _sum_subtask_budget_fee_for_project(db, task.project_id)
        if existing + payload.budget_fee > project.overall_budget_fee:
            raise HTTPException(
                status_code=400,
                detail=f"Subtask budget fee exceeds project overall budget ({project.overall_budget_fee:.2f})",
            )
    subtask = Subtask(
        task_id=task_id,
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        budget_hours=payload.budget_hours,
        budget_fee=payload.budget_fee,
    )
    db.add(subtask)
    db.flush()
    _log_audit_event(
        db=db,
        entity_type="subtask",
        entity_id=subtask.id,
        action="create_subtask",
        actor_user_id=_.id,
        payload={
            "task_id": task.id,
            "project_id": task.project_id,
            "code": payload.code.strip().upper(),
            "name": payload.name.strip(),
            "budget_hours": payload.budget_hours,
            "budget_fee": payload.budget_fee,
        },
    )
    db.commit()
    db.refresh(subtask)
    return {
        "id": subtask.id,
        "task_id": task_id,
        "code": subtask.code,
        "name": subtask.name,
        "budget_hours": subtask.budget_hours,
        "budget_fee": subtask.budget_fee,
    }


@app.put("/subtasks/{subtask_id}")
def update_subtask(
    subtask_id: int,
    payload: SubtaskUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_WBS")),
) -> dict[str, int | str | float]:
    subtask = db.get(Subtask, subtask_id)
    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")
    task = db.get(Task, subtask.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.get(Project, task.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.overall_budget_fee > 0:
        existing_minus_current = _sum_subtask_budget_fee_for_project(db, task.project_id) - float(subtask.budget_fee or 0.0)
        if existing_minus_current + payload.budget_fee > project.overall_budget_fee:
            raise HTTPException(
                status_code=400,
                detail=f"Subtask budget fee exceeds project overall budget ({project.overall_budget_fee:.2f})",
            )
    subtask.code = payload.code.strip().upper()
    subtask.name = payload.name.strip()
    subtask.budget_hours = payload.budget_hours
    subtask.budget_fee = payload.budget_fee
    _log_audit_event(
        db=db,
        entity_type="subtask",
        entity_id=subtask.id,
        action="update_subtask",
        actor_user_id=_.id,
        payload={
            "task_id": task.id,
            "project_id": task.project_id,
            "code": subtask.code,
            "name": subtask.name,
            "budget_hours": subtask.budget_hours,
            "budget_fee": subtask.budget_fee,
        },
    )
    db.commit()
    db.refresh(subtask)
    return {
        "id": subtask.id,
        "task_id": subtask.task_id,
        "code": subtask.code,
        "name": subtask.name,
        "budget_hours": subtask.budget_hours,
        "budget_fee": subtask.budget_fee,
    }


@app.get("/projects/{project_id}/wbs")
def get_wbs(
    project_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, object]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    tasks = db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.id.asc())).all()
    created_default_subtask = False
    for task in tasks:
        _, created = _ensure_default_subtask_for_task(db, task)
        created_default_subtask = created_default_subtask or created
    if created_default_subtask:
        db.commit()

    task_ids = [t.id for t in tasks]
    subtasks = db.scalars(select(Subtask).where(Subtask.task_id.in_(task_ids) if task_ids else false())).all()

    subtasks_by_task: dict[int, list[Subtask]] = {}
    for sub in subtasks:
        subtasks_by_task.setdefault(sub.task_id, []).append(sub)

    budget_hours = sum(sub.budget_hours for sub in subtasks)
    budget_fee = sum(sub.budget_fee for sub in subtasks)

    return {
        "project": _to_project_out(project).model_dump(),
        "budget_hours": budget_hours,
        "budget_fee": budget_fee,
        "tasks": [
            {
                "id": task.id,
                "name": task.name,
                "is_billable": task.is_billable,
                "subtasks": [
                    {
                        "id": sub.id,
                        "code": sub.code,
                        "name": sub.name,
                        "budget_hours": sub.budget_hours,
                        "budget_fee": sub.budget_fee,
                    }
                    for sub in subtasks_by_task.get(task.id, [])
                ],
            }
            for task in tasks
        ],
    }


@app.post("/projects/{project_id}/seed-standard-wbs")
def seed_standard_wbs(
    project_id: int,
    target_tasks: int = Query(default=10, ge=1, le=50),
    target_subtasks: int = Query(default=4, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_WBS")),
) -> dict[str, object]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    tasks = db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.id.asc())).all()
    existing_task_names = {t.name.strip().lower() for t in tasks}
    added_tasks = 0
    added_subtasks = 0
    next_task_idx = 1
    while len(tasks) < target_tasks:
        candidate = f"Task-{next_task_idx}"
        next_task_idx += 1
        if candidate.strip().lower() in existing_task_names:
            continue
        task = Task(project_id=project_id, name=candidate, is_billable=bool(project.is_billable))
        db.add(task)
        db.flush()
        tasks.append(task)
        existing_task_names.add(candidate.strip().lower())
        added_tasks += 1

    for task in tasks:
        subtasks = db.scalars(select(Subtask).where(Subtask.task_id == task.id).order_by(Subtask.id.asc())).all()
        existing_subtask_names = {s.name.strip().lower() for s in subtasks}
        existing_codes = {s.code.strip().upper() for s in subtasks}
        next_sub_idx = 1
        while len(subtasks) < target_subtasks:
            sub_name = f"Subtask-{next_sub_idx}"
            sub_code = f"S{next_sub_idx:02d}"
            next_sub_idx += 1
            if sub_name.strip().lower() in existing_subtask_names or sub_code.strip().upper() in existing_codes:
                continue
            subtask = Subtask(task_id=task.id, code=sub_code, name=sub_name, budget_hours=0.0, budget_fee=0.0)
            db.add(subtask)
            db.flush()
            subtasks.append(subtask)
            existing_subtask_names.add(sub_name.strip().lower())
            existing_codes.add(sub_code.strip().upper())
            added_subtasks += 1

    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project_id,
        action="seed_standard_wbs",
        actor_user_id=current_user.id,
        payload={
            "project_id": project_id,
            "target_tasks": target_tasks,
            "target_subtasks": target_subtasks,
            "added_tasks": added_tasks,
            "added_subtasks": added_subtasks,
        },
    )
    db.commit()
    return {
        "ok": True,
        "project_id": project_id,
        "added_tasks": added_tasks,
        "added_subtasks": added_subtasks,
        "target_tasks": target_tasks,
        "target_subtasks": target_subtasks,
    }


@app.post("/projects/{project_id}/expenses", response_model=ProjectExpenseOut)
def create_project_expense(
    project_id: int,
    payload: ProjectExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectExpenseOut:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    exp = ProjectExpense(
        project_id=project_id,
        expense_date=payload.expense_date,
        category=payload.category.strip(),
        description=payload.description.strip(),
        amount=float(payload.amount),
    )
    db.add(exp)
    _log_audit_event(
        db=db,
        entity_type="project_expense",
        entity_id=0,
        action="create_project_expense",
        actor_user_id=current_user.id,
        payload={
            "project_id": project_id,
            "expense_date": payload.expense_date.isoformat(),
            "category": payload.category.strip(),
            "amount": float(payload.amount),
        },
    )
    db.commit()
    db.refresh(exp)
    return ProjectExpenseOut(
        id=exp.id,
        project_id=exp.project_id,
        expense_date=exp.expense_date,
        category=exp.category,
        description=exp.description,
        amount=float(exp.amount),
    )


@app.get("/projects/{project_id}/expenses", response_model=list[ProjectExpenseOut])
def list_project_expenses(
    project_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ProjectExpenseOut]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = db.scalars(
        select(ProjectExpense)
        .where(ProjectExpense.project_id == project_id)
        .order_by(ProjectExpense.expense_date.desc(), ProjectExpense.id.desc())
    ).all()
    return [
        ProjectExpenseOut(
            id=r.id,
            project_id=r.project_id,
            expense_date=r.expense_date,
            category=r.category,
            description=r.description,
            amount=float(r.amount),
        )
        for r in rows
    ]


@app.post("/rates")
def upsert_rate(
    payload: RateUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_RATES")),
) -> dict[str, object]:
    bill_rate = _normalize_rate_4dp(payload.bill_rate, "bill_rate")
    cost_rate = _normalize_rate_4dp(payload.cost_rate, "cost_rate")
    user = db.get(User, payload.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    rate = db.scalar(
        select(UserRate).where(and_(UserRate.user_id == payload.user_id, UserRate.effective_date == payload.effective_date))
    )
    if not rate:
        rate = UserRate(
            user_id=payload.user_id,
            effective_date=payload.effective_date,
            bill_rate=bill_rate,
            cost_rate=cost_rate,
        )
        db.add(rate)
    else:
        rate.bill_rate = bill_rate
        rate.cost_rate = cost_rate

    _log_audit_event(
        db=db,
        entity_type="user_rate",
        entity_id=payload.user_id,
        action="upsert_rate",
        actor_user_id=current_user.id,
        payload={
            "user_id": payload.user_id,
            "effective_date": payload.effective_date.isoformat(),
            "bill_rate": bill_rate,
            "cost_rate": cost_rate,
        },
    )
    db.commit()
    return {
        "ok": True,
        "user_id": payload.user_id,
        "effective_date": payload.effective_date.isoformat(),
        "bill_rate": bill_rate,
        "cost_rate": cost_rate,
    }


@app.get("/rates/latest", response_model=list[LatestRateOut])
def latest_rates(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_RATES")),
) -> list[LatestRateOut]:
    rates = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.desc(), UserRate.id.desc())).all()
    latest_by_user: dict[int, UserRate] = {}
    for r in rates:
        if r.user_id not in latest_by_user:
            latest_by_user[r.user_id] = r
    return [
        LatestRateOut(
            user_id=r.user_id,
            effective_date=r.effective_date,
            bill_rate=float(r.bill_rate),
            cost_rate=float(r.cost_rate),
        )
        for r in latest_by_user.values()
    ]


@app.post("/rates/reapply-to-entries")
def reapply_rates_to_entries(
    start: date,
    end: date,
    user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_RATES")),
) -> dict[str, object]:
    if end < start:
        raise HTTPException(status_code=400, detail="end date must be on or after start date")
    if user_id is not None and not db.get(User, user_id):
        raise HTTPException(status_code=404, detail="User not found")

    entries_q = select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    if user_id is not None:
        entries_q = entries_q.where(TimeEntry.user_id == user_id)
    entries = db.scalars(entries_q.order_by(TimeEntry.user_id.asc(), TimeEntry.work_date.asc(), TimeEntry.id.asc())).all()

    rates = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.asc(), UserRate.id.asc())).all()
    rates_by_user: dict[int, list[UserRate]] = defaultdict(list)
    for r in rates:
        rates_by_user[r.user_id].append(r)

    updated = 0
    unchanged = 0
    skipped_no_rate = 0
    for entry in entries:
        user_rates = rates_by_user.get(entry.user_id, [])
        applicable: UserRate | None = None
        for r in reversed(user_rates):
            if r.effective_date <= entry.work_date:
                applicable = r
                break
        if not applicable:
            skipped_no_rate += 1
            continue

        new_bill = float(applicable.bill_rate)
        new_cost = float(applicable.cost_rate)
        if float(entry.bill_rate_applied) == new_bill and float(entry.cost_rate_applied) == new_cost:
            unchanged += 1
            continue

        entry.bill_rate_applied = new_bill
        entry.cost_rate_applied = new_cost
        updated += 1

    _log_audit_event(
        db=db,
        entity_type="time_entry",
        entity_id=0,
        action="reapply_rates_to_entries",
        actor_user_id=current_user.id,
        payload={
            "start": start.isoformat(),
            "end": end.isoformat(),
            "user_id": user_id,
            "entry_count": len(entries),
            "updated": updated,
            "unchanged": unchanged,
            "skipped_no_rate": skipped_no_rate,
        },
    )
    db.commit()
    return {
        "ok": True,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "user_id": user_id,
        "entry_count": len(entries),
        "updated": updated,
        "unchanged": unchanged,
        "skipped_no_rate": skipped_no_rate,
    }


@app.post("/time-entries", response_model=TimeEntryOut)
def create_time_entry(
    payload: TimeEntryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TimeEntryOut:
    task = db.get(Task, payload.task_id)
    subtask = db.get(Subtask, payload.subtask_id)
    if not task or not subtask:
        raise HTTPException(status_code=400, detail="Task/subtask not found")
    if task.project_id != payload.project_id or subtask.task_id != payload.task_id:
        raise HTTPException(status_code=400, detail="Invalid Project -> Task -> Subtask mapping")

    rate = db.scalar(
        select(UserRate)
        .where(and_(UserRate.user_id == current_user.id, UserRate.effective_date <= payload.work_date))
        .order_by(UserRate.effective_date.desc())
    )
    if not rate:
        raise HTTPException(status_code=400, detail="No rate configured for user")

    entry = TimeEntry(
        user_id=current_user.id,
        project_id=payload.project_id,
        task_id=payload.task_id,
        subtask_id=payload.subtask_id,
        work_date=payload.work_date,
        hours=payload.hours,
        note=payload.note.strip(),
        bill_rate_applied=rate.bill_rate,
        cost_rate_applied=rate.cost_rate,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _to_time_entry_out(entry)


@app.get("/time-entries", response_model=list[TimeEntryOut])
def list_time_entries(
    start: date,
    end: date,
    user_id: int | None = None,
    project_id: int | None = None,
    task_id: int | None = None,
    subtask_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TimeEntryOut]:
    target_user_id = current_user.id
    if user_id is not None and user_id != current_user.id:
        perms = permissions_for_role(current_user.role)
        if "MANAGE_USERS" not in perms and "APPROVE_TIMESHEETS" not in perms:
            raise HTTPException(status_code=403, detail="Missing permission to view another user's entries")
        target_user_id = user_id
    elif user_id is not None:
        target_user_id = user_id

    q = (
        select(TimeEntry)
        .where(and_(TimeEntry.user_id == target_user_id, TimeEntry.work_date >= start, TimeEntry.work_date <= end))
        .order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())
    )
    if project_id is not None:
        q = q.where(TimeEntry.project_id == project_id)
    if task_id is not None:
        q = q.where(TimeEntry.task_id == task_id)
    if subtask_id is not None:
        q = q.where(TimeEntry.subtask_id == subtask_id)

    rows = db.scalars(q).all()
    user_map, project_map, task_map, subtask_map = _load_time_entry_reference_maps(db, rows)
    return [
        _to_time_entry_out_with_refs(
            r,
            users_by_id=user_map,
            projects_by_id=project_map,
            tasks_by_id=task_map,
            subtasks_by_id=subtask_map,
        )
        for r in rows
    ]


@app.get("/time-entries/export.csv")
def export_time_entries_csv(
    start: date,
    end: date,
    user_id: int,
    project_id: int | None = None,
    task_id: int | None = None,
    subtask_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    target_user_id = current_user.id
    if user_id != current_user.id:
        perms = permissions_for_role(current_user.role)
        if "MANAGE_USERS" not in perms and "APPROVE_TIMESHEETS" not in perms:
            raise HTTPException(status_code=403, detail="Missing permission to export another user's entries")
        target_user_id = user_id
    else:
        target_user_id = user_id

    q = (
        select(TimeEntry)
        .where(and_(TimeEntry.user_id == target_user_id, TimeEntry.work_date >= start, TimeEntry.work_date <= end))
        .order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())
    )
    if project_id is not None:
        q = q.where(TimeEntry.project_id == project_id)
    if task_id is not None:
        q = q.where(TimeEntry.task_id == task_id)
    if subtask_id is not None:
        q = q.where(TimeEntry.subtask_id == subtask_id)

    rows = db.scalars(q).all()
    user_map, project_map, task_map, subtask_map = _load_time_entry_reference_maps(db, rows)
    out_rows = [
        _to_time_entry_out_with_refs(
            r,
            users_by_id=user_map,
            projects_by_id=project_map,
            tasks_by_id=task_map,
            subtasks_by_id=subtask_map,
        )
        for r in rows
    ]

    buff = io.StringIO()
    writer = csv.writer(buff)
    writer.writerow(
        [
            "date",
            "employee_email",
            "employee_name",
            "project",
            "task",
            "subtask_code",
            "subtask",
            "hours",
            "bill_rate",
            "cost_rate",
            "revenue",
            "cost",
            "profit",
            "note",
        ]
    )
    for r in out_rows:
        project_ref = project_map.get(r.project_id)
        task_ref = task_map.get(r.task_id)
        is_billable = bool(project_ref.is_billable if project_ref else False) and bool(task_ref.is_billable if task_ref else False)
        revenue = float(r.hours * r.bill_rate_applied) if is_billable else 0.0
        cost = float(r.hours * r.cost_rate_applied)
        profit = revenue - cost
        writer.writerow(
            [
                r.work_date.isoformat(),
                r.user_email or "",
                r.user_full_name or "",
                r.project_name or "",
                r.task_name or "",
                r.subtask_code or "",
                r.subtask_name or "",
                f"{float(r.hours):.2f}",
                f"{float(r.bill_rate_applied):.2f}",
                f"{float(r.cost_rate_applied):.2f}",
                f"{revenue:.2f}",
                f"{cost:.2f}",
                f"{profit:.2f}",
                r.note or "",
            ]
        )

    filename = f"time_entries_{target_user_id}_{start.isoformat()}_{end.isoformat()}.csv"
    return Response(
        content=buff.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.put("/time-entries/{entry_id}", response_model=TimeEntryOut)
def update_time_entry(
    entry_id: int,
    payload: TimeEntryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TimeEntryOut:
    entry = db.get(TimeEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Time entry not found")
    if entry.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Cannot edit another user's time entry")

    task = db.get(Task, payload.task_id)
    subtask = db.get(Subtask, payload.subtask_id)
    if not task or not subtask:
        raise HTTPException(status_code=400, detail="Task/subtask not found")
    if task.project_id != payload.project_id or subtask.task_id != payload.task_id:
        raise HTTPException(status_code=400, detail="Invalid Project -> Task -> Subtask mapping")

    rate = db.scalar(
        select(UserRate)
        .where(and_(UserRate.user_id == current_user.id, UserRate.effective_date <= payload.work_date))
        .order_by(UserRate.effective_date.desc())
    )
    if not rate:
        raise HTTPException(status_code=400, detail="No rate configured for user")

    entry.project_id = payload.project_id
    entry.task_id = payload.task_id
    entry.subtask_id = payload.subtask_id
    entry.work_date = payload.work_date
    entry.hours = payload.hours
    entry.note = payload.note.strip()
    entry.bill_rate_applied = rate.bill_rate
    entry.cost_rate_applied = rate.cost_rate

    db.commit()
    db.refresh(entry)
    return _to_time_entry_out(entry)


@app.delete("/time-entries/{entry_id}")
def delete_time_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    entry = db.get(TimeEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Time entry not found")
    if entry.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Cannot delete another user's time entry")
    db.delete(entry)
    db.commit()
    return {"ok": True, "id": entry_id}


@app.post("/timesheets/generate", response_model=TimesheetOut)
def generate_timesheet(
    week_start: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TimesheetOut:
    ws = week_start or _week_start(date.today())
    we = ws + timedelta(days=6)

    ts = db.scalar(select(Timesheet).where(and_(Timesheet.user_id == current_user.id, Timesheet.week_start == ws)))
    if not ts:
        ts = Timesheet(user_id=current_user.id, week_start=ws, week_end=we)
        db.add(ts)
        db.commit()
        db.refresh(ts)

    total_hours = _timesheet_hours(db, current_user.id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.post("/timesheets/generate-range")
def generate_timesheets_for_range(
    start: date,
    end: date,
    user_id: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> dict[str, object]:
    if end < start:
        raise HTTPException(status_code=400, detail="end date must be on or after start date")
    if user_id is not None and not db.get(User, user_id):
        raise HTTPException(status_code=404, detail="User not found")

    q = select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    if user_id is not None:
        q = q.where(TimeEntry.user_id == user_id)
    entries = db.scalars(q).all()

    wanted_pairs: set[tuple[int, date]] = set()
    for e in entries:
        wanted_pairs.add((e.user_id, _week_start(e.work_date)))

    created = 0
    existing = 0
    for uid, ws in sorted(wanted_pairs, key=lambda x: (x[0], x[1])):
        ts = db.scalar(select(Timesheet).where(and_(Timesheet.user_id == uid, Timesheet.week_start == ws)))
        if ts:
            existing += 1
            continue
        db.add(Timesheet(user_id=uid, week_start=ws, week_end=ws + timedelta(days=6)))
        created += 1

    if created > 0:
        db.commit()
    return {
        "ok": True,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "user_id": user_id,
        "weeks_found": len(wanted_pairs),
        "created": created,
        "existing": existing,
    }


@app.post("/timesheets/ensure", response_model=TimesheetOut)
def ensure_timesheet_for_user_week(
    user_id: int,
    week_start: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> TimesheetOut:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    ws = _week_start(week_start)
    we = ws + timedelta(days=6)
    ts = db.scalar(select(Timesheet).where(and_(Timesheet.user_id == user_id, Timesheet.week_start == ws)))
    if not ts:
        ts = Timesheet(user_id=user_id, week_start=ws, week_end=we)
        db.add(ts)
        db.commit()
        db.refresh(ts)
    total_hours = _timesheet_hours(db, user_id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.post("/timesheets/{timesheet_id}/submit", response_model=TimesheetOut)
def submit_timesheet(
    timesheet_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TimesheetOut:
    ts = db.get(Timesheet, timesheet_id)
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    if ts.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Cannot submit another user's timesheet")
    if ts.status not in {"draft", "rejected"}:
        raise HTTPException(status_code=400, detail="Timesheet cannot be submitted in current state")

    ts.status = "submitted"
    ts.employee_signed_at = datetime.utcnow()
    db.commit()
    db.refresh(ts)

    total_hours = _timesheet_hours(db, current_user.id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.post("/timesheets/{timesheet_id}/submit-admin", response_model=TimesheetOut)
def submit_timesheet_admin(
    timesheet_id: int,
    db: Session = Depends(get_db),
    approver: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> TimesheetOut:
    ts = db.get(Timesheet, timesheet_id)
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    if ts.status not in {"draft", "rejected"}:
        raise HTTPException(status_code=400, detail="Timesheet cannot be submitted in current state")

    ts.status = "submitted"
    if not ts.employee_signed_at:
        ts.employee_signed_at = datetime.utcnow()
    _log_audit_event(
        db=db,
        entity_type="timesheet",
        entity_id=ts.id,
        action="submit_timesheet_admin",
        actor_user_id=approver.id,
        payload={
            "timesheet_id": ts.id,
            "user_id": ts.user_id,
            "week_start": ts.week_start.isoformat(),
            "week_end": ts.week_end.isoformat(),
            "status": ts.status,
        },
    )
    db.commit()
    db.refresh(ts)

    total_hours = _timesheet_hours(db, ts.user_id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.post("/timesheets/{timesheet_id}/approve", response_model=TimesheetOut)
def approve_timesheet(
    timesheet_id: int,
    db: Session = Depends(get_db),
    approver: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> TimesheetOut:
    ts = db.get(Timesheet, timesheet_id)
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    if ts.status != "submitted":
        raise HTTPException(status_code=400, detail="Timesheet must be submitted first")

    ts.status = "approved"
    ts.supervisor_signed_at = datetime.utcnow()
    ts.approved_by_user_id = approver.id
    _log_audit_event(
        db=db,
        entity_type="timesheet",
        entity_id=ts.id,
        action="approve_timesheet",
        actor_user_id=approver.id,
        payload={
            "timesheet_id": ts.id,
            "user_id": ts.user_id,
            "week_start": ts.week_start.isoformat(),
            "week_end": ts.week_end.isoformat(),
            "status": ts.status,
        },
    )
    db.commit()
    db.refresh(ts)

    total_hours = _timesheet_hours(db, ts.user_id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.post("/timesheets/{timesheet_id}/return", response_model=TimesheetOut)
def return_timesheet(
    timesheet_id: int,
    db: Session = Depends(get_db),
    approver: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> TimesheetOut:
    ts = db.get(Timesheet, timesheet_id)
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    if ts.status not in {"submitted", "approved"}:
        raise HTTPException(status_code=400, detail="Only submitted or approved timesheets can be returned")

    ts.status = "rejected"
    ts.supervisor_signed_at = None
    ts.approved_by_user_id = None
    _log_audit_event(
        db=db,
        entity_type="timesheet",
        entity_id=ts.id,
        action="return_timesheet",
        actor_user_id=approver.id,
        payload={
            "timesheet_id": ts.id,
            "user_id": ts.user_id,
            "week_start": ts.week_start.isoformat(),
            "week_end": ts.week_end.isoformat(),
            "status": ts.status,
        },
    )
    db.commit()
    db.refresh(ts)

    total_hours = _timesheet_hours(db, ts.user_id, ts.week_start, ts.week_end)
    return _to_timesheet_out(ts, total_hours)


@app.get("/timesheets/mine", response_model=list[TimesheetOut])
def my_timesheets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TimesheetOut]:
    sheets = db.scalars(select(Timesheet).where(Timesheet.user_id == current_user.id).order_by(Timesheet.week_start.desc())).all()
    return [_to_timesheet_out(ts, _timesheet_hours(db, current_user.id, ts.week_start, ts.week_end)) for ts in sheets]


@app.get("/timesheets/all", response_model=list[TimesheetAdminOut])
def all_timesheets(
    start: date | None = None,
    end: date | None = None,
    user_id: int | None = None,
    status_filter: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> list[TimesheetAdminOut]:
    q = select(Timesheet).order_by(Timesheet.week_start.desc(), Timesheet.id.desc())
    if start:
        q = q.where(Timesheet.week_start >= start)
    if end:
        q = q.where(Timesheet.week_end <= end)
    if user_id:
        q = q.where(Timesheet.user_id == user_id)
    if status_filter:
        q = q.where(Timesheet.status == status_filter)

    sheets = db.scalars(q).all()
    user_ids = sorted({ts.user_id for ts in sheets})
    users = db.scalars(select(User).where(User.id.in_(user_ids) if user_ids else false())).all()
    user_map = {u.id: u for u in users}

    out: list[TimesheetAdminOut] = []
    for ts in sheets:
        u = user_map.get(ts.user_id)
        total = _timesheet_hours(db, ts.user_id, ts.week_start, ts.week_end)
        row = _to_timesheet_out(ts, total)
        out.append(
            TimesheetAdminOut(
                **row.model_dump(),
                user_email=u.email if u else "",
                user_full_name=u.full_name if u else "",
            )
        )
    return out


@app.get("/dashboards/project-margin")
def project_margin(
    start: date,
    end: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    projects = db.scalars(select(Project).order_by(Project.id.asc())).all()
    project_by_id = {p.id: p for p in projects}
    task_rows = db.scalars(select(Task)).all()
    task_by_id = {t.id: t for t in task_rows}

    subtasks = db.scalars(select(Subtask)).all()
    budget_by_project: dict[int, dict[str, float]] = {}
    for sub in subtasks:
        project_id = task_by_id[sub.task_id].project_id
        entry = budget_by_project.setdefault(project_id, {"budget_hours": 0.0, "budget_fee": 0.0})
        entry["budget_hours"] += float(sub.budget_hours)
        entry["budget_fee"] += float(sub.budget_fee)

    entries = db.scalars(
        select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    ).all()
    expenses = db.scalars(
        select(ProjectExpense).where(and_(ProjectExpense.expense_date >= start, ProjectExpense.expense_date <= end))
    ).all()
    expenses = db.scalars(
        select(ProjectExpense).where(and_(ProjectExpense.expense_date >= start, ProjectExpense.expense_date <= end))
    ).all()
    actual_by_project: dict[int, dict[str, float]] = {}
    for te in entries:
        project_ref = project_by_id.get(te.project_id)
        task_ref = task_by_id.get(te.task_id)
        is_billable = bool(project_ref.is_billable if project_ref else False) and bool(task_ref.is_billable if task_ref else False)
        row = actual_by_project.setdefault(te.project_id, {"actual_hours": 0.0, "actual_revenue": 0.0, "actual_cost": 0.0})
        row["actual_hours"] += float(te.hours)
        row["actual_revenue"] += float(te.hours * te.bill_rate_applied) if is_billable else 0.0
        row["actual_cost"] += float(te.hours * te.cost_rate_applied)

    rows = []
    for p in projects:
        budget = budget_by_project.get(p.id, {"budget_hours": 0.0, "budget_fee": 0.0})
        actual = actual_by_project.get(p.id, {"actual_hours": 0.0, "actual_revenue": 0.0, "actual_cost": 0.0})
        margin = actual["actual_revenue"] - actual["actual_cost"]
        rows.append(
            {
                "project_id": p.id,
                "project_name": p.name,
                "overall_budget_fee": float(p.overall_budget_fee or 0.0),
                "target_gross_margin_pct": float(p.target_gross_margin_pct or 0.0),
                **budget,
                **actual,
                "actual_margin": margin,
            }
        )

    return {"start": start.isoformat(), "end": end.isoformat(), "projects": rows}


@app.get("/reports/project-performance")
def project_performance(
    start: date,
    end: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    rows = _project_performance_rows(db, start, end)
    return {"start": start.isoformat(), "end": end.isoformat(), "projects": rows}


@app.get("/reports/project-performance-range")
def project_performance_range(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    min_date = db.scalar(select(func.min(TimeEntry.work_date)))
    max_date = db.scalar(select(func.max(TimeEntry.work_date)))
    today = date.today()
    return {
        "start": (min_date or today).isoformat(),
        "end": (max_date or today).isoformat(),
        "has_data": bool(min_date and max_date),
    }


@app.get("/reports/unbilled-since-last-invoice")
def unbilled_since_last_invoice(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    rows = _unbilled_since_last_invoice_by_client(db)
    return {"as_of": date.today().isoformat(), "by_client": rows}


@app.get("/reports/project-performance.csv")
def project_performance_csv(
    start: date,
    end: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> Response:
    rows = _project_performance_rows(db, start, end)
    buff = io.StringIO()
    writer = csv.writer(buff)
    writer.writerow(
        [
            "project_id",
            "project_name",
            "overall_budget_fee",
            "wbs_budget_fee",
            "actual_revenue",
            "actual_cost",
            "actual_profit",
            "margin_pct",
            "target_gross_margin_pct",
            "target_profit",
            "target_profit_gap",
            "target_margin_gap_pct",
        ]
    )
    for p in rows:
        writer.writerow(
            [
                p["project_id"],
                p["project_name"],
                f"{float(p['overall_budget_fee']):.2f}",
                f"{float(p['budget_fee']):.2f}",
                f"{float(p['actual_revenue']):.2f}",
                f"{float(p['actual_cost']):.2f}",
                f"{float(p['actual_profit']):.2f}",
                f"{float(p['margin_pct']):.2f}",
                f"{float(p['target_gross_margin_pct']):.2f}",
                f"{float(p['target_profit']):.2f}",
                f"{float(p['target_profit_gap']):.2f}",
                f"{float(p['target_margin_gap_pct']):.2f}",
            ]
        )
    filename = f"project_performance_{start.isoformat()}_{end.isoformat()}.csv"
    return Response(
        content=buff.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/timesheets/summary.csv")
def timesheets_summary_csv(
    start: date,
    end: date,
    mode: str = Query(default="weekly"),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("APPROVE_TIMESHEETS")),
) -> Response:
    if mode not in {"weekly", "monthly"}:
        raise HTTPException(status_code=400, detail="mode must be weekly or monthly")
    sheets = db.scalars(
        select(Timesheet).where(and_(Timesheet.week_start >= start, Timesheet.week_end <= end)).order_by(Timesheet.week_start.asc())
    ).all()
    users = db.scalars(select(User)).all()
    user_map = {u.id: u for u in users}

    grouped: dict[tuple[str, int, str], dict[str, float | str | int]] = {}
    for ts in sheets:
        period = ts.week_start.isoformat() if mode == "weekly" else ts.week_start.strftime("%Y-%m")
        key = (period, ts.user_id, ts.status)
        if key not in grouped:
            u = user_map.get(ts.user_id)
            grouped[key] = {
                "period": period,
                "user_id": ts.user_id,
                "email": u.email if u else "",
                "name": u.full_name if u else "",
                "status": ts.status,
                "timesheet_count": 0.0,
                "total_hours": 0.0,
            }
        grouped[key]["timesheet_count"] = float(grouped[key]["timesheet_count"]) + 1.0
        grouped[key]["total_hours"] = float(grouped[key]["total_hours"]) + _timesheet_hours(
            db, ts.user_id, ts.week_start, ts.week_end
        )

    rows = list(grouped.values())
    rows.sort(key=lambda r: (str(r["period"]), str(r["email"]), str(r["status"])))

    buff = io.StringIO()
    writer = csv.writer(buff)
    writer.writerow(["period", "user_id", "email", "name", "status", "timesheet_count", "total_hours"])
    for r in rows:
        writer.writerow(
            [
                r["period"],
                int(r["user_id"]),
                r["email"],
                r["name"],
                r["status"],
                int(float(r["timesheet_count"])),
                f"{float(r['total_hours']):.2f}",
            ]
        )
    filename = f"timesheets_summary_{mode}_{start.isoformat()}_{end.isoformat()}.csv"
    return Response(
        content=buff.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/reports/reconciliation-range")
def reconciliation_range(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    min_date = db.scalar(select(func.min(TimeEntry.work_date)))
    max_date = db.scalar(select(func.max(TimeEntry.work_date)))
    today = date.today()
    return {
        "start": (min_date or today).isoformat(),
        "end": (max_date or today).isoformat(),
        "has_data": bool(min_date and max_date),
    }


@app.get("/reports/reconciliation")
def reconciliation_report(
    start: date,
    end: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    snapshot, monthly_rows = _reconciliation_rows(db, start, end)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "snapshot": snapshot,
        "monthly": monthly_rows,
    }


@app.get("/reports/reconciliation.csv")
def reconciliation_report_csv(
    start: date,
    end: date,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> Response:
    _, monthly_rows = _reconciliation_rows(db, start, end)
    buff = io.StringIO()
    writer = csv.writer(buff)
    writer.writerow(
        [
            "period",
            "entry_count",
            "unique_users",
            "unique_projects",
            "unique_tasks",
            "unique_subtasks",
            "total_hours",
            "bill_amount",
            "cost_amount",
            "profit_amount",
            "orphan_user_refs",
            "orphan_project_refs",
            "orphan_task_refs",
            "orphan_subtask_refs",
            "zero_or_negative_rate_entries",
        ]
    )
    for r in monthly_rows:
        writer.writerow(
            [
                r["period"],
                int(r["entry_count"]),
                int(r["unique_users"]),
                int(r["unique_projects"]),
                int(r["unique_tasks"]),
                int(r["unique_subtasks"]),
                f"{float(r['total_hours']):.2f}",
                f"{float(r['bill_amount']):.2f}",
                f"{float(r['cost_amount']):.2f}",
                f"{float(r['profit_amount']):.2f}",
                int(r["orphan_user_refs"]),
                int(r["orphan_project_refs"]),
                int(r["orphan_task_refs"]),
                int(r["orphan_subtask_refs"]),
                int(r["zero_or_negative_rate_entries"]),
            ]
        )
    filename = f"reconciliation_{start.isoformat()}_{end.isoformat()}.csv"
    return Response(
        content=buff.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/reports/ar-summary")
def ar_summary(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    def _invoice_open_balance(inv: Invoice) -> float:
        subtotal = float(inv.subtotal_amount or 0.0)
        paid = float(inv.amount_paid or 0.0)
        stored = float(inv.balance_due or 0.0)
        derived = max(0.0, subtotal - paid)
        return max(stored, derived)

    today = date.today()
    candidate_invoices = db.scalars(select(Invoice).where(Invoice.status.notin_(["void", "draft"]))).all()
    invoices = [i for i in candidate_invoices if _invoice_open_balance(i) > 0.0001]
    total_outstanding = float(sum(_invoice_open_balance(i) for i in invoices))
    overdue = [i for i in invoices if i.due_date and i.due_date < today]
    overdue_total = float(sum(_invoice_open_balance(i) for i in overdue))

    aging = {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "90_plus": 0.0}
    by_client: dict[str, dict[str, float | str | int]] = {}
    for i in invoices:
        bal = _invoice_open_balance(i)
        if not i.due_date:
            aging["current"] += bal
        else:
            age = (today - i.due_date).days
            if age <= 0:
                aging["current"] += bal
            elif age <= 30:
                aging["1_30"] += bal
            elif age <= 60:
                aging["31_60"] += bal
            elif age <= 90:
                aging["61_90"] += bal
            else:
                aging["90_plus"] += bal
        key = (i.client_name or "Unknown Client").strip() or "Unknown Client"
        row = by_client.setdefault(key, {"client_name": key, "invoice_count": 0, "outstanding": 0.0, "overdue": 0.0})
        row["invoice_count"] = int(row["invoice_count"]) + 1
        row["outstanding"] = float(row["outstanding"]) + bal
        if i.due_date and i.due_date < today:
            row["overdue"] = float(row["overdue"]) + bal

    top_clients = sorted(by_client.values(), key=lambda r: float(r["outstanding"]), reverse=True)[:10]
    return {
        "as_of": today.isoformat(),
        "invoice_count_open": len(invoices),
        "total_outstanding": total_outstanding,
        "overdue_invoice_count": len(overdue),
        "overdue_total": overdue_total,
        "aging": aging,
        "top_clients": top_clients,
    }


@app.get("/invoices/recurring/schedules", response_model=list[RecurringInvoiceScheduleOut])
def list_recurring_invoice_schedules(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[RecurringInvoiceScheduleOut]:
    rows = db.scalars(
        select(RecurringInvoiceSchedule).order_by(RecurringInvoiceSchedule.is_active.desc(), RecurringInvoiceSchedule.id.desc())
    ).all()
    return [_to_recurring_schedule_out(r) for r in rows]


@app.post("/invoices/recurring/schedules", response_model=RecurringInvoiceScheduleOut)
def create_recurring_invoice_schedule(
    payload: RecurringInvoiceScheduleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> RecurringInvoiceScheduleOut:
    cadence = _normalize_recurrence_cadence(payload.cadence)
    if payload.project_id is not None and not db.get(Project, payload.project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    schedule = RecurringInvoiceSchedule(
        name=payload.name.strip(),
        project_id=payload.project_id,
        cadence=cadence,
        approved_only=payload.approved_only,
        due_days=int(payload.due_days),
        next_run_date=payload.next_run_date,
        auto_send_email=payload.auto_send_email,
        recipient_email=(str(payload.recipient_email).strip().lower() if payload.recipient_email else ""),
        notes_template=payload.notes_template.strip(),
        is_active=payload.is_active,
    )
    db.add(schedule)
    db.flush()
    _log_audit_event(
        db=db,
        entity_type="recurring_invoice_schedule",
        entity_id=schedule.id,
        action="create_recurring_invoice_schedule",
        actor_user_id=current_user.id,
        payload={
            "name": schedule.name,
            "project_id": schedule.project_id,
            "cadence": schedule.cadence,
            "next_run_date": schedule.next_run_date.isoformat(),
            "is_active": schedule.is_active,
        },
    )
    db.commit()
    db.refresh(schedule)
    return _to_recurring_schedule_out(schedule)


@app.put("/invoices/recurring/schedules/{schedule_id}", response_model=RecurringInvoiceScheduleOut)
def update_recurring_invoice_schedule(
    schedule_id: int,
    payload: RecurringInvoiceScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> RecurringInvoiceScheduleOut:
    schedule = db.get(RecurringInvoiceSchedule, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Recurring invoice schedule not found")
    if payload.project_id is not None and not db.get(Project, payload.project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    if payload.name is not None:
        schedule.name = payload.name.strip()
    if payload.project_id is not None:
        schedule.project_id = payload.project_id
    if payload.cadence is not None:
        schedule.cadence = _normalize_recurrence_cadence(payload.cadence)
    if payload.approved_only is not None:
        schedule.approved_only = payload.approved_only
    if payload.due_days is not None:
        schedule.due_days = int(payload.due_days)
    if payload.next_run_date is not None:
        schedule.next_run_date = payload.next_run_date
    if payload.auto_send_email is not None:
        schedule.auto_send_email = payload.auto_send_email
    if payload.recipient_email is not None:
        schedule.recipient_email = str(payload.recipient_email).strip().lower()
    if payload.notes_template is not None:
        schedule.notes_template = payload.notes_template.strip()
    if payload.is_active is not None:
        schedule.is_active = payload.is_active
    _log_audit_event(
        db=db,
        entity_type="recurring_invoice_schedule",
        entity_id=schedule.id,
        action="update_recurring_invoice_schedule",
        actor_user_id=current_user.id,
        payload={
            "name": schedule.name,
            "project_id": schedule.project_id,
            "cadence": schedule.cadence,
            "next_run_date": schedule.next_run_date.isoformat(),
            "is_active": schedule.is_active,
        },
    )
    db.commit()
    db.refresh(schedule)
    return _to_recurring_schedule_out(schedule)


@app.post("/invoices/recurring/run", response_model=RecurringInvoiceRunResult)
def run_recurring_invoices_now(
    run_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> RecurringInvoiceRunResult:
    return _run_recurring_invoices(db, run_date or date.today(), actor_user_id=current_user.id)


@app.get("/invoices/preview", response_model=InvoicePreviewOut)
def invoice_preview(
    start: date,
    end: date,
    project_id: int | None = None,
    approved_only: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> InvoicePreviewOut:
    if project_id is None:
        raise HTTPException(status_code=400, detail="Select a project to preview an invoice.")
    lines, client_name, total_cost = _invoice_preview_rows(db, start, end, project_id, approved_only)
    subtotal = float(sum(line.amount for line in lines))
    total_hours = float(sum(line.hours for line in lines))
    return InvoicePreviewOut(
        start=start,
        end=end,
        approved_only=approved_only,
        project_id=project_id,
        client_name=client_name,
        line_count=len(lines),
        total_hours=total_hours,
        subtotal_amount=subtotal,
        total_cost=total_cost,
        total_profit=float(subtotal - total_cost),
        logo_url="/Aqt_Logo.png",
        lines=lines,
    )


@app.post("/invoices", response_model=InvoiceOut)
def create_invoice(
    payload: InvoiceCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> InvoiceOut:
    if payload.end < payload.start:
        raise HTTPException(status_code=400, detail="end must be on or after start")
    if payload.project_id is None:
        raise HTTPException(status_code=400, detail="Select a project before creating an invoice.")
    lines, client_name, total_cost = _invoice_preview_rows(
        db,
        payload.start,
        payload.end,
        payload.project_id,
        payload.approved_only,
    )
    if len(lines) == 0:
        raise HTTPException(status_code=400, detail="No billable entries found in selected period/filters")

    subtotal = float(sum(line.amount for line in lines))
    issue_date = payload.issue_date or date.today()
    due_date = payload.due_date or (issue_date + timedelta(days=30))
    invoice = Invoice(
        invoice_number=_next_invoice_number(db, project_id=payload.project_id, client_name=client_name),
        project_id=payload.project_id,
        client_name=client_name,
        start_date=payload.start,
        end_date=payload.end,
        issue_date=issue_date,
        due_date=due_date,
        status="draft",
        source="app",
        subtotal_amount=subtotal,
        amount_paid=0.0,
        balance_due=subtotal,
        total_cost=total_cost,
        total_profit=float(subtotal - total_cost),
        notes=payload.notes.strip(),
    )
    db.add(invoice)
    db.flush()
    for line in lines:
        db.add(
            InvoiceLine(
                invoice_id=invoice.id,
                source_time_entry_id=line.source_time_entry_id,
                work_date=line.work_date,
                user_id=line.user_id,
                project_id=line.project_id,
                task_id=line.task_id,
                subtask_id=line.subtask_id,
                description=f"{line.employee} | {line.project} | {line.task} | {line.subtask}",
                note=line.note,
                hours=line.hours,
                bill_rate=line.bill_rate,
                amount=line.amount,
            )
        )

    _log_audit_event(
        db=db,
        entity_type="invoice",
        entity_id=invoice.id,
        action="create_invoice",
        actor_user_id=current_user.id,
        payload={
            "invoice_number": invoice.invoice_number,
            "project_id": invoice.project_id,
            "client_name": invoice.client_name,
            "start_date": invoice.start_date.isoformat(),
            "end_date": invoice.end_date.isoformat(),
            "line_count": len(lines),
            "subtotal_amount": invoice.subtotal_amount,
        },
    )
    db.commit()
    db.refresh(invoice)
    return _invoice_out(db, invoice, include_lines=True)


@app.get("/invoices", response_model=list[InvoiceOut])
def list_invoices(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> list[InvoiceOut]:
    rows = db.scalars(select(Invoice).order_by(Invoice.created_at.desc(), Invoice.id.desc())).all()
    return [_invoice_out(db, inv, include_lines=False) for inv in rows]


@app.get("/invoices/{invoice_id}", response_model=InvoiceOut)
def get_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> InvoiceOut:
    inv = db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _invoice_out(db, inv, include_lines=True)


@app.get("/invoices/{invoice_id}/render-context", response_model=InvoiceRenderContextOut)
def get_invoice_render_context(
    invoice_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> InvoiceRenderContextOut:
    inv = db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    db_lines = db.scalars(select(InvoiceLine).where(InvoiceLine.invoice_id == inv.id).order_by(InvoiceLine.work_date.asc(), InvoiceLine.id.asc())).all()
    if not db_lines:
        return InvoiceRenderContextOut(
            invoice_id=inv.id,
            invoice_number=inv.invoice_number,
            summary_rows=[],
            appendix_weeks=[],
        )

    task_ids = sorted({int(l.task_id) for l in db_lines if l.task_id is not None})
    project_ids = sorted({int(l.project_id) for l in db_lines if l.project_id is not None})
    task_map = {t.id: t for t in db.scalars(select(Task).where(Task.id.in_(task_ids) if task_ids else false())).all()}
    project_map = {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids) if project_ids else false())).all()}

    budget_by_task: dict[int, float] = {}
    if task_ids:
        subtasks = db.scalars(select(Subtask).where(Subtask.task_id.in_(task_ids))).all()
        for s in subtasks:
            budget_by_task[s.task_id] = float(budget_by_task.get(s.task_id, 0.0)) + float(s.budget_fee or 0.0)

    by_task_this: dict[tuple[int | None, str], float] = {}
    for l in db_lines:
        task_name = task_map.get(int(l.task_id)).name if l.task_id is not None and task_map.get(int(l.task_id)) else (l.description or "Task")
        key = (int(l.task_id) if l.task_id is not None else None, task_name)
        by_task_this[key] = float(by_task_this.get(key, 0.0)) + float(l.amount or 0.0)

    previous_by_task: dict[tuple[int | None, str], float] = defaultdict(float)
    if inv.project_id is not None:
        prev_lines = db.execute(
            select(InvoiceLine, Invoice)
            .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
            .where(
                and_(
                    Invoice.project_id == inv.project_id,
                    Invoice.status.notin_(["void", "draft"]),
                    InvoiceLine.task_id.is_not(None),
                    InvoiceLine.invoice_id != inv.id,
                )
            )
        ).all()
        for line_obj, prev_inv in prev_lines:
            if prev_inv.issue_date > inv.issue_date or (prev_inv.issue_date == inv.issue_date and prev_inv.id >= inv.id):
                continue
            task_name = task_map.get(int(line_obj.task_id)).name if line_obj.task_id is not None and task_map.get(int(line_obj.task_id)) else (line_obj.description or "Task")
            key = (int(line_obj.task_id) if line_obj.task_id is not None else None, task_name)
            previous_by_task[key] += float(line_obj.amount or 0.0)

    summary_rows: list[InvoiceTaskSummaryRowOut] = []
    for key, this_amount in sorted(by_task_this.items(), key=lambda x: x[0][1].lower()):
        task_id, task_label = key
        prev = float(previous_by_task.get(key, 0.0))
        to_date = prev + float(this_amount)
        contract_maximum = float(budget_by_task.get(task_id, 0.0)) if task_id is not None else 0.0
        if contract_maximum <= 0 and inv.project_id is not None:
            contract_maximum = float(project_map.get(inv.project_id).overall_budget_fee if project_map.get(inv.project_id) else 0.0)
        balance = contract_maximum - to_date if contract_maximum > 0 else 0.0
        pct_this = (float(this_amount) / contract_maximum * 100.0) if contract_maximum > 0 else 0.0
        pct_to_date = (to_date / contract_maximum * 100.0) if contract_maximum > 0 else 0.0
        summary_rows.append(
            InvoiceTaskSummaryRowOut(
                task=task_label,
                previously_billed=prev,
                this_invoice=float(this_amount),
                billed_to_date=to_date,
                contract_maximum=contract_maximum,
                contract_balance_remaining=balance,
                pct_complete_this_invoice=pct_this,
                pct_complete_to_date=pct_to_date,
            )
        )

    source_ids = sorted({int(l.source_time_entry_id) for l in db_lines if l.source_time_entry_id is not None})
    source_entries = db.scalars(select(TimeEntry).where(TimeEntry.id.in_(source_ids) if source_ids else false())).all()
    source_map = {e.id: e for e in source_entries}
    invoiced_entry_ids = set(source_map.keys())
    week_keys: set[tuple[int, date]] = set()
    for e in source_entries:
        week_keys.add((int(e.user_id), _week_start(e.work_date)))

    appendix_weeks: list[InvoiceAppendixWeekOut] = []
    for user_id, week_start in sorted(week_keys, key=lambda x: (x[1], x[0])):
        week_end = week_start + timedelta(days=6)
        week_entries = db.scalars(
            select(TimeEntry)
            .where(and_(TimeEntry.user_id == user_id, TimeEntry.work_date >= week_start, TimeEntry.work_date <= week_end))
            .order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())
        ).all()
        users_by_id, projects_by_id, tasks_by_id, subtasks_by_id = _load_time_entry_reference_maps(db, week_entries)
        row_entries: list[InvoiceAppendixEntryOut] = []
        total_hours = 0.0
        invoiced_hours = 0.0
        for te in week_entries:
            out = _to_time_entry_out_with_refs(
                te,
                users_by_id=users_by_id,
                projects_by_id=projects_by_id,
                tasks_by_id=tasks_by_id,
                subtasks_by_id=subtasks_by_id,
            )
            is_inv = int(te.id) in invoiced_entry_ids
            h = float(out.hours or 0.0)
            total_hours += h
            if is_inv:
                invoiced_hours += h
            row_entries.append(
                InvoiceAppendixEntryOut(
                    time_entry_id=te.id,
                    work_date=out.work_date,
                    project=out.project_name or f"Project {out.project_id}",
                    task=out.task_name or f"Task {out.task_id}",
                    subtask=out.subtask_name or out.subtask_code or f"Subtask {out.subtask_id}",
                    note=out.note or "",
                    hours=h,
                    is_invoiced=is_inv,
                )
            )
        if row_entries:
            user_ref = users_by_id.get(user_id)
            appendix_weeks.append(
                InvoiceAppendixWeekOut(
                    user_id=user_id,
                    employee=(user_ref.full_name if user_ref else f"User {user_id}"),
                    email=(user_ref.email if user_ref else ""),
                    week_start=week_start,
                    week_end=week_end,
                    total_hours=total_hours,
                    invoiced_hours=invoiced_hours,
                    entries=row_entries,
                )
            )

    return InvoiceRenderContextOut(
        invoice_id=inv.id,
        invoice_number=inv.invoice_number,
        summary_rows=summary_rows,
        appendix_weeks=appendix_weeks,
    )


@app.post("/invoices/{invoice_id}/payment-link", response_model=InvoicePaymentLinkOut)
def create_invoice_payment_link(
    invoice_id: int,
    payload: InvoicePaymentLinkCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> InvoicePaymentLinkOut:
    _payment_links_disabled_http_error(public_route=False)
    inv = db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "void":
        raise HTTPException(status_code=400, detail="Cannot create payment link for void invoice")
    expires_days = int(payload.expires_in_days or settings.PAYMENT_LINK_DEFAULT_EXPIRY_DAYS)
    token = secrets.token_urlsafe(24)
    inv.payment_link_token = token
    inv.payment_link_enabled = True
    inv.payment_link_expires_at = date.today() + timedelta(days=expires_days)
    _log_audit_event(
        db=db,
        entity_type="invoice",
        entity_id=inv.id,
        action="create_payment_link",
        actor_user_id=current_user.id,
        payload={"invoice_number": inv.invoice_number, "expires_at": inv.payment_link_expires_at.isoformat()},
    )
    db.commit()
    return InvoicePaymentLinkOut(
        invoice_id=inv.id,
        invoice_number=inv.invoice_number,
        payment_link_url=_payment_link_url(token),
        token=token,
        expires_at=inv.payment_link_expires_at,
        enabled=True,
    )


@app.get("/public/pay/{token}", response_model=PublicInvoicePaymentViewOut)
def public_invoice_payment_view(
    token: str,
    db: Session = Depends(get_db),
) -> PublicInvoicePaymentViewOut:
    _payment_links_disabled_http_error(public_route=True)
    inv = db.scalar(select(Invoice).where(Invoice.payment_link_token == token))
    if not inv:
        raise HTTPException(status_code=404, detail="Payment link not found")
    today = date.today()
    return PublicInvoicePaymentViewOut(
        invoice_number=inv.invoice_number,
        client_name=inv.client_name,
        issue_date=inv.issue_date,
        due_date=inv.due_date,
        status=inv.status,
        subtotal_amount=float(inv.subtotal_amount or 0.0),
        amount_paid=float(inv.amount_paid or 0.0),
        balance_due=float(inv.balance_due or 0.0),
        notes=inv.notes or "",
        payment_link_expires_at=inv.payment_link_expires_at,
        can_pay=_is_payment_link_valid(inv, today),
    )


@app.post("/public/pay/{token}", response_model=PublicInvoicePaymentViewOut)
def public_invoice_payment_submit(
    token: str,
    payload: PublicInvoicePaymentRequest,
    db: Session = Depends(get_db),
) -> PublicInvoicePaymentViewOut:
    _payment_links_disabled_http_error(public_route=True)
    inv = db.scalar(select(Invoice).where(Invoice.payment_link_token == token))
    if not inv:
        raise HTTPException(status_code=404, detail="Payment link not found")
    today = date.today()
    if not _is_payment_link_valid(inv, today):
        raise HTTPException(status_code=400, detail="Payment link is not valid for this invoice")
    amount = float(payload.amount)
    if amount > float(inv.balance_due or 0.0) + 0.0001:
        raise HTTPException(status_code=400, detail="Payment amount exceeds outstanding balance")
    inv.amount_paid = float(inv.amount_paid or 0.0) + amount
    inv.balance_due = max(0.0, float(inv.subtotal_amount or 0.0) - float(inv.amount_paid or 0.0))
    if inv.balance_due <= 0.0001:
        inv.balance_due = 0.0
        inv.status = "paid"
        if not inv.paid_date:
            inv.paid_date = today
        inv.payment_link_enabled = False
    else:
        inv.status = "partial"
    _log_audit_event(
        db=db,
        entity_type="invoice",
        entity_id=inv.id,
        action="public_payment_submit",
        actor_user_id=None,
        payload={
            "invoice_number": inv.invoice_number,
            "amount": amount,
            "payer_email": (str(payload.payer_email).strip().lower() if payload.payer_email else ""),
            "note": (payload.note or "").strip(),
            "remaining_balance": float(inv.balance_due or 0.0),
        },
    )
    db.commit()
    return PublicInvoicePaymentViewOut(
        invoice_number=inv.invoice_number,
        client_name=inv.client_name,
        issue_date=inv.issue_date,
        due_date=inv.due_date,
        status=inv.status,
        subtotal_amount=float(inv.subtotal_amount or 0.0),
        amount_paid=float(inv.amount_paid or 0.0),
        balance_due=float(inv.balance_due or 0.0),
        notes=inv.notes or "",
        payment_link_expires_at=inv.payment_link_expires_at,
        can_pay=_is_payment_link_valid(inv, today),
    )


@app.put("/invoices/{invoice_id}/payment", response_model=InvoiceOut)
def update_invoice_payment(
    invoice_id: int,
    payload: InvoicePaymentUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> InvoiceOut:
    inv = db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    paid = float(payload.amount_paid or 0.0)
    subtotal = float(inv.subtotal_amount or 0.0)
    balance = max(subtotal - paid, 0.0)
    inv.amount_paid = paid
    inv.balance_due = balance
    inv.paid_date = payload.paid_date

    desired = (payload.status or "").strip().lower()
    if desired in {"draft", "sent", "partial", "paid", "void"}:
        inv.status = desired
    else:
        if balance <= 0.0001 and subtotal > 0:
            inv.status = "paid"
            if not inv.paid_date:
                inv.paid_date = date.today()
        elif paid > 0:
            inv.status = "partial"
        else:
            inv.status = "sent" if inv.status != "draft" else inv.status

    _log_audit_event(
        db=db,
        entity_type="invoice",
        entity_id=inv.id,
        action="update_invoice_payment",
        actor_user_id=current_user.id,
        payload={
            "amount_paid": inv.amount_paid,
            "balance_due": inv.balance_due,
            "status": inv.status,
            "paid_date": inv.paid_date.isoformat() if inv.paid_date else None,
        },
    )
    db.commit()
    db.refresh(inv)
    return _invoice_out(db, inv, include_lines=True)


@app.post("/invoices/reconcile-client-labels", response_model=InvoiceClientReconcileOut)
def reconcile_invoice_client_labels(
    payload: InvoiceClientReconcileRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> InvoiceClientReconcileOut:
    canonical = (payload.canonical_client_name or "").strip()
    if not canonical:
        raise HTTPException(status_code=400, detail="canonical_client_name is required")

    alias_values = []
    alias_seen: set[str] = set()
    for raw in payload.aliases:
        clean = str(raw or "").strip()
        if not clean:
            continue
        low = clean.lower()
        if low == canonical.lower() or low in alias_seen:
            continue
        alias_seen.add(low)
        alias_values.append(clean)
    if len(alias_values) == 0:
        raise HTTPException(status_code=400, detail="Provide at least one alias different from canonical_client_name")

    aliases_lower = {v.lower() for v in alias_values}
    invoices = db.scalars(
        select(Invoice).where(func.lower(func.trim(Invoice.client_name)).in_(aliases_lower))
    ).all()
    projects = db.scalars(
        select(Project).where(func.lower(func.trim(Project.client_name)).in_(aliases_lower))
    ).all()

    for inv in invoices:
        inv.client_name = canonical
    for proj in projects:
        proj.client_name = canonical

    event_entity_id = int(invoices[0].id) if invoices else (int(projects[0].id) if projects else 0)
    _log_audit_event(
        db=db,
        entity_type="invoice",
        entity_id=event_entity_id,
        action="reconcile_invoice_client_labels",
        actor_user_id=current_user.id,
        payload={
            "canonical_client_name": canonical,
            "aliases": alias_values,
            "invoices_updated": len(invoices),
            "projects_updated": len(projects),
        },
    )
    db.commit()

    return InvoiceClientReconcileOut(
        canonical_client_name=canonical,
        aliases=alias_values,
        invoices_updated=len(invoices),
        projects_updated=len(projects),
    )


@app.post("/invoices/import/freshbooks")
async def import_legacy_invoices(
    apply: bool = False,
    file: UploadFile = File(...),
    mapping_overrides: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="CSV file is empty")
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    overrides = _parse_mapping_overrides(mapping_overrides)
    no_cols = _time_cols("invoice_number", INVOICE_NO_COLUMNS, overrides)
    client_cols = _time_cols("client_name", INVOICE_CLIENT_COLUMNS, overrides)
    issue_cols = _time_cols("issue_date", INVOICE_ISSUE_DATE_COLUMNS, overrides)
    due_cols = _time_cols("due_date", INVOICE_DUE_DATE_COLUMNS, overrides)
    status_cols = _time_cols("status", INVOICE_STATUS_COLUMNS, overrides)
    total_cols = _time_cols("total_amount", INVOICE_TOTAL_COLUMNS, overrides)
    paid_cols = _time_cols("amount_paid", INVOICE_PAID_COLUMNS, overrides)
    balance_cols = _time_cols("balance_due", INVOICE_BALANCE_COLUMNS, overrides)

    imported = 0
    updated = 0
    skipped = 0
    errors = 0
    rows_out: list[LegacyInvoiceImportRowOut] = []

    for row_index, row in enumerate(reader, start=2):
        invoice_number = (_first_value(row, no_cols) or "").strip()
        client_name = (_first_value(row, client_cols) or "Legacy Client").strip()
        issue_date = _parse_flexible_date(_first_value(row, issue_cols)) or date.today()
        due_date = _parse_flexible_date(_first_value(row, due_cols)) or (issue_date + timedelta(days=30))
        status = _normalize_invoice_status(_first_value(row, status_cols))
        total_amount = _parse_float(_first_value(row, total_cols))
        amount_paid = _parse_float(_first_value(row, paid_cols))
        balance_due = _parse_float(_first_value(row, balance_cols))

        if total_amount is None and balance_due is None and amount_paid is None:
            rows_out.append(
                LegacyInvoiceImportRowOut(
                    row_number=row_index,
                    invoice_number=invoice_number or "",
                    client_name=client_name,
                    issue_date=issue_date.isoformat() if issue_date else None,
                    due_date=due_date.isoformat() if due_date else None,
                    total_amount=None,
                    amount_paid=None,
                    balance_due=None,
                    status="error",
                    reason="Missing amount fields (total/paid/balance)",
                )
            )
            errors += 1
            continue
        if total_amount is None:
            total_amount = float((amount_paid or 0.0) + (balance_due or 0.0))
        if amount_paid is None:
            amount_paid = max(float(total_amount) - float(balance_due or 0.0), 0.0)
        if balance_due is None:
            balance_due = max(float(total_amount) - float(amount_paid or 0.0), 0.0)
        amount_paid = max(float(amount_paid or 0.0), 0.0)
        balance_due = max(float(balance_due or 0.0), 0.0)
        status = _status_from_amounts(
            status=status,
            total_amount=float(total_amount),
            amount_paid=amount_paid,
            balance_due=balance_due,
        )

        if not invoice_number:
            seed = f"{client_name}|{issue_date.isoformat()}|{due_date.isoformat()}|{row_index}|{float(total_amount):.2f}"
            invoice_number = f"LEG-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:10].upper()}"

        existing = db.scalar(select(Invoice).where(Invoice.invoice_number == invoice_number))
        operation = "updated" if existing else "imported"
        if not apply:
            rows_out.append(
                LegacyInvoiceImportRowOut(
                    row_number=row_index,
                    invoice_number=invoice_number,
                    client_name=client_name,
                    issue_date=issue_date.isoformat(),
                    due_date=due_date.isoformat(),
                    total_amount=float(total_amount),
                    amount_paid=float(amount_paid),
                    balance_due=float(balance_due),
                    status="ready",
                    reason=operation,
                )
            )
            continue

        if not existing:
            existing = Invoice(
                invoice_number=invoice_number,
                project_id=None,
                client_name=client_name,
                start_date=issue_date,
                end_date=issue_date,
                issue_date=issue_date,
                due_date=due_date,
                status=status,
                source="freshbooks_legacy",
                subtotal_amount=float(total_amount),
                amount_paid=amount_paid,
                balance_due=balance_due,
                total_cost=0.0,
                total_profit=float(total_amount),
                paid_date=issue_date if status == "paid" else None,
                notes="Imported from FreshBooks legacy invoices",
            )
            db.add(existing)
            db.flush()
            db.add(
                InvoiceLine(
                    invoice_id=existing.id,
                    source_time_entry_id=None,
                    work_date=issue_date,
                    user_id=None,
                    project_id=None,
                    task_id=None,
                    subtask_id=None,
                    description="Legacy imported invoice total",
                    note="Imported from FreshBooks legacy invoices",
                    hours=1.0,
                    bill_rate=float(total_amount),
                    amount=float(total_amount),
                )
            )
            imported += 1
        else:
            existing.client_name = client_name
            existing.issue_date = issue_date
            existing.due_date = due_date
            existing.status = status
            existing.source = "freshbooks_legacy"
            existing.subtotal_amount = float(total_amount)
            existing.amount_paid = amount_paid
            existing.balance_due = balance_due
            existing.paid_date = issue_date if status == "paid" else None
            has_lines = db.scalar(select(func.count(InvoiceLine.id)).where(InvoiceLine.invoice_id == existing.id)) or 0
            if int(has_lines) == 0:
                db.add(
                    InvoiceLine(
                        invoice_id=existing.id,
                        source_time_entry_id=None,
                        work_date=issue_date,
                        user_id=None,
                        project_id=None,
                        task_id=None,
                        subtask_id=None,
                        description="Legacy imported invoice total",
                        note="Imported from FreshBooks legacy invoices",
                        hours=1.0,
                        bill_rate=float(total_amount),
                        amount=float(total_amount),
                    )
                )
            updated += 1

        rows_out.append(
            LegacyInvoiceImportRowOut(
                row_number=row_index,
                invoice_number=invoice_number,
                client_name=client_name,
                issue_date=issue_date.isoformat(),
                due_date=due_date.isoformat(),
                total_amount=float(total_amount),
                amount_paid=amount_paid,
                balance_due=balance_due,
                status=operation,
                reason=None,
            )
        )

    if apply:
        _log_audit_event(
            db=db,
            entity_type="invoice",
            entity_id=0,
            action="import_legacy_invoices",
            actor_user_id=current_user.id,
            payload={"imported": imported, "updated": updated, "errors": errors},
        )
        db.commit()

    return {
        "apply": apply,
        "count": len(rows_out),
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "rows": [r.model_dump() for r in rows_out],
    }


def _reconciliation_rows(db: Session, start: date, end: date) -> tuple[dict[str, object], list[dict[str, object]]]:
    users = db.scalars(select(User)).all()
    projects = db.scalars(select(Project)).all()
    tasks = db.scalars(select(Task)).all()
    subtasks = db.scalars(select(Subtask)).all()
    rates = db.scalars(select(UserRate)).all()

    users_by_id = {u.id: u for u in users}
    projects_by_id = {p.id: p for p in projects}
    tasks_by_id = {t.id: t for t in tasks}
    subtasks_by_id = {s.id: s for s in subtasks}

    entries = db.scalars(
        select(TimeEntry)
        .where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
        .order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())
    ).all()

    monthly: dict[str, dict[str, object]] = {}
    for te in entries:
        period = te.work_date.strftime("%Y-%m")
        row = monthly.setdefault(
            period,
            {
                "period": period,
                "entry_count": 0,
                "user_ids": set(),
                "project_ids": set(),
                "task_ids": set(),
                "subtask_ids": set(),
                "total_hours": 0.0,
                "bill_amount": 0.0,
                "cost_amount": 0.0,
                "orphan_user_refs": 0,
                "orphan_project_refs": 0,
                "orphan_task_refs": 0,
                "orphan_subtask_refs": 0,
                "zero_or_negative_rate_entries": 0,
            },
        )
        row["entry_count"] = int(row["entry_count"]) + 1
        row["user_ids"].add(te.user_id)  # type: ignore[union-attr]
        row["project_ids"].add(te.project_id)  # type: ignore[union-attr]
        row["task_ids"].add(te.task_id)  # type: ignore[union-attr]
        row["subtask_ids"].add(te.subtask_id)  # type: ignore[union-attr]
        row["total_hours"] = float(row["total_hours"]) + float(te.hours)
        project_ref = projects_by_id.get(te.project_id)
        task_ref = tasks_by_id.get(te.task_id)
        is_billable = bool(project_ref.is_billable if project_ref else False) and bool(task_ref.is_billable if task_ref else False)
        row["bill_amount"] = float(row["bill_amount"]) + (float(te.hours * te.bill_rate_applied) if is_billable else 0.0)
        row["cost_amount"] = float(row["cost_amount"]) + float(te.hours * te.cost_rate_applied)

        if te.user_id not in users_by_id:
            row["orphan_user_refs"] = int(row["orphan_user_refs"]) + 1
        if te.project_id not in projects_by_id:
            row["orphan_project_refs"] = int(row["orphan_project_refs"]) + 1
        if te.task_id not in tasks_by_id:
            row["orphan_task_refs"] = int(row["orphan_task_refs"]) + 1
        if te.subtask_id not in subtasks_by_id:
            row["orphan_subtask_refs"] = int(row["orphan_subtask_refs"]) + 1
        if te.bill_rate_applied <= 0 or te.cost_rate_applied <= 0:
            row["zero_or_negative_rate_entries"] = int(row["zero_or_negative_rate_entries"]) + 1

    monthly_rows: list[dict[str, object]] = []
    for period in sorted(monthly):
        r = monthly[period]
        monthly_rows.append(
            {
                "period": period,
                "entry_count": int(r["entry_count"]),
                "unique_users": len(r["user_ids"]),  # type: ignore[arg-type]
                "unique_projects": len(r["project_ids"]),  # type: ignore[arg-type]
                "unique_tasks": len(r["task_ids"]),  # type: ignore[arg-type]
                "unique_subtasks": len(r["subtask_ids"]),  # type: ignore[arg-type]
                "total_hours": float(r["total_hours"]),
                "bill_amount": float(r["bill_amount"]),
                "cost_amount": float(r["cost_amount"]),
                "profit_amount": float(r["bill_amount"]) - float(r["cost_amount"]),
                "orphan_user_refs": int(r["orphan_user_refs"]),
                "orphan_project_refs": int(r["orphan_project_refs"]),
                "orphan_task_refs": int(r["orphan_task_refs"]),
                "orphan_subtask_refs": int(r["orphan_subtask_refs"]),
                "zero_or_negative_rate_entries": int(r["zero_or_negative_rate_entries"]),
            }
        )

    snapshot = {
        "users_total": len(users),
        "users_active": sum(1 for u in users if u.is_active),
        "projects_total": len(projects),
        "projects_active": sum(1 for p in projects if p.is_active),
        "projects_overhead": sum(1 for p in projects if p.is_overhead),
        "tasks_total": len(tasks),
        "subtasks_total": len(subtasks),
        "rates_total": len(rates),
        "time_entries_in_range": len(entries),
        "time_entries_min_date": min((e.work_date for e in entries), default=None),
        "time_entries_max_date": max((e.work_date for e in entries), default=None),
        "hours_in_range": float(sum(float(e.hours) for e in entries)),
        "bill_amount_in_range": float(
            sum(
                (float(e.hours * e.bill_rate_applied) if bool(projects_by_id.get(e.project_id).is_billable if projects_by_id.get(e.project_id) else False) and bool(tasks_by_id.get(e.task_id).is_billable if tasks_by_id.get(e.task_id) else False) else 0.0)
                for e in entries
            )
        ),
        "cost_amount_in_range": float(sum(float(e.hours * e.cost_rate_applied) for e in entries)),
    }
    snapshot["profit_amount_in_range"] = float(snapshot["bill_amount_in_range"]) - float(snapshot["cost_amount_in_range"])
    return snapshot, monthly_rows


def _project_performance_rows(db: Session, start: date, end: date) -> list[dict[str, object]]:
    projects = [p for p in db.scalars(select(Project).order_by(Project.id.asc())).all() if not _is_hidden_project_name(p.name)]
    projects_by_id = {p.id: p for p in projects}
    users = db.scalars(select(User)).all()
    users_by_id = {u.id: u for u in users}
    tasks = db.scalars(select(Task)).all()
    tasks_by_id = {t.id: t for t in tasks}
    subtasks = db.scalars(select(Subtask)).all()
    subtasks_by_id = {s.id: s for s in subtasks}

    budget_by_project: dict[int, dict[str, float]] = defaultdict(lambda: {"budget_hours": 0.0, "budget_fee": 0.0})
    for sub in subtasks:
        task = tasks_by_id.get(sub.task_id)
        if not task:
            continue
        b = budget_by_project[task.project_id]
        b["budget_hours"] += float(sub.budget_hours)
        b["budget_fee"] += float(sub.budget_fee)

    entries = db.scalars(
        select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    ).all()
    expenses = db.scalars(
        select(ProjectExpense).where(and_(ProjectExpense.expense_date >= start, ProjectExpense.expense_date <= end))
    ).all()

    by_project: dict[int, dict[str, object]] = {}
    for p in projects:
        by_project[p.id] = {
            "project_id": p.id,
            "project_name": p.name,
            "budget_hours": budget_by_project[p.id]["budget_hours"],
            "budget_fee": budget_by_project[p.id]["budget_fee"],
            "overall_budget_fee": float(p.overall_budget_fee or 0.0),
            "target_gross_margin_pct": float(p.target_gross_margin_pct or 0.0),
            "actual_hours": 0.0,
            "actual_revenue": 0.0,
            "actual_cost": 0.0,
            "expense_cost": 0.0,
            "actual_profit": 0.0,
            "margin_pct": 0.0,
            "target_profit": 0.0,
            "target_profit_gap": 0.0,
            "target_margin_gap_pct": 0.0,
            "by_employee": {},
            "by_task": {},
            "by_subtask": {},
        }

    for te in entries:
        project = by_project.get(te.project_id)
        if not project:
            continue
        project_ref = projects_by_id.get(te.project_id)
        task_ref = tasks_by_id.get(te.task_id)
        is_billable = bool(project_ref.is_billable if project_ref else False) and bool(task_ref.is_billable if task_ref else False)
        revenue = float(te.hours * te.bill_rate_applied) if is_billable else 0.0
        cost = float(te.hours * te.cost_rate_applied)
        profit = revenue - cost

        project["actual_hours"] = float(project["actual_hours"]) + float(te.hours)
        project["actual_revenue"] = float(project["actual_revenue"]) + revenue
        project["actual_cost"] = float(project["actual_cost"]) + cost
        project["actual_profit"] = float(project["actual_profit"]) + profit

        emp_key = te.user_id
        by_emp = project["by_employee"]
        if emp_key not in by_emp:
            u = users_by_id.get(te.user_id)
            by_emp[emp_key] = {
                "user_id": te.user_id,
                "email": u.email if u else "",
                "name": u.full_name if u else "",
                "hours": 0.0,
                "revenue": 0.0,
                "cost": 0.0,
                "profit": 0.0,
            }
        by_emp[emp_key]["hours"] += float(te.hours)
        by_emp[emp_key]["revenue"] += revenue
        by_emp[emp_key]["cost"] += cost
        by_emp[emp_key]["profit"] += profit

        task_key = te.task_id
        by_task = project["by_task"]
        if task_key not in by_task:
            t = tasks_by_id.get(te.task_id)
            by_task[task_key] = {
                "task_id": te.task_id,
                "task_name": t.name if t else "",
                "hours": 0.0,
                "revenue": 0.0,
                "cost": 0.0,
                "profit": 0.0,
            }
        by_task[task_key]["hours"] += float(te.hours)
        by_task[task_key]["revenue"] += revenue
        by_task[task_key]["cost"] += cost
        by_task[task_key]["profit"] += profit

        sub_key = te.subtask_id
        by_subtask = project["by_subtask"]
        if sub_key not in by_subtask:
            s = subtasks_by_id.get(te.subtask_id)
            by_subtask[sub_key] = {
                "subtask_id": te.subtask_id,
                "subtask_code": s.code if s else "",
                "subtask_name": s.name if s else "",
                "hours": 0.0,
                "revenue": 0.0,
                "cost": 0.0,
                "profit": 0.0,
            }
        by_subtask[sub_key]["hours"] += float(te.hours)
        by_subtask[sub_key]["revenue"] += revenue
        by_subtask[sub_key]["cost"] += cost
        by_subtask[sub_key]["profit"] += profit

    for ex in expenses:
        project = by_project.get(ex.project_id)
        if not project:
            continue
        ex_cost = float(ex.amount or 0.0)
        project["expense_cost"] = float(project["expense_cost"]) + ex_cost
        project["actual_cost"] = float(project["actual_cost"]) + ex_cost
        project["actual_profit"] = float(project["actual_profit"]) - ex_cost

    rows: list[dict[str, object]] = []
    for p in projects:
        row = by_project[p.id]
        revenue = float(row["actual_revenue"])
        row["margin_pct"] = (float(row["actual_profit"]) / revenue * 100.0) if revenue > 0 else 0.0
        target_gross_margin_pct = float(row["target_gross_margin_pct"])
        row["project_is_billable"] = bool(p.is_billable)
        if not bool(p.is_billable):
            row["target_profit"] = 0.0
            row["target_profit_gap"] = 0.0
            row["target_margin_gap_pct"] = 0.0
        else:
            # Align target profit with the selected reporting period so gap sign matches on-target status.
            row["target_profit"] = revenue * target_gross_margin_pct / 100.0
            row["target_profit_gap"] = float(row["actual_profit"]) - float(row["target_profit"])
            row["target_margin_gap_pct"] = float(row["margin_pct"]) - target_gross_margin_pct
        row["by_employee"] = sorted(row["by_employee"].values(), key=lambda x: x["email"])
        row["by_task"] = sorted(row["by_task"].values(), key=lambda x: x["task_name"])
        row["by_subtask"] = sorted(row["by_subtask"].values(), key=lambda x: x["subtask_code"])
        rows.append(row)

    return rows


def _unbilled_since_last_invoice_by_client(db: Session) -> list[dict[str, object]]:
    projects = [p for p in db.scalars(select(Project).order_by(Project.id.asc())).all() if not _is_hidden_project_name(p.name)]
    projects_by_id = {p.id: p for p in projects}
    tasks = db.scalars(select(Task)).all()
    tasks_by_id = {t.id: t for t in tasks}

    invoiced_time_entry_ids = {
        int(v)
        for v in db.scalars(
            select(InvoiceLine.source_time_entry_id)
            .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
            .where(
                and_(
                    InvoiceLine.source_time_entry_id.is_not(None),
                    Invoice.status.notin_(["void", "draft"]),
                )
            )
        ).all()
        if v is not None
    }

    last_invoice_end_by_project: dict[int, date] = {}
    invoiced_projects = db.scalars(
        select(Invoice).where(
            and_(
                Invoice.project_id.is_not(None),
                Invoice.status.notin_(["void", "draft"]),
            )
        )
    ).all()
    for inv in invoiced_projects:
        if inv.project_id is None:
            continue
        cur = last_invoice_end_by_project.get(int(inv.project_id))
        cutoff = inv.end_date
        if cur is None or cutoff > cur:
            last_invoice_end_by_project[int(inv.project_id)] = cutoff

    by_project_unbilled: dict[int, float] = defaultdict(float)
    for te in db.scalars(select(TimeEntry)).all():
        project_ref = projects_by_id.get(te.project_id)
        if not project_ref:
            continue
        task_ref = tasks_by_id.get(te.task_id)
        is_billable = bool(project_ref.is_billable) and bool(task_ref.is_billable if task_ref else False)
        if not is_billable:
            continue
        if te.id in invoiced_time_entry_ids:
            continue
        cutoff = last_invoice_end_by_project.get(int(te.project_id))
        if cutoff is not None and te.work_date <= cutoff:
            continue
        by_project_unbilled[te.project_id] += float(te.hours * te.bill_rate_applied)

    by_client: dict[str, dict[str, object]] = {}
    for project_id, amount in by_project_unbilled.items():
        if amount <= 0.0001:
            continue
        project_ref = projects_by_id.get(project_id)
        if not project_ref:
            continue
        client_name = (project_ref.client_name or "Unassigned Client").strip() or "Unassigned Client"
        row = by_client.setdefault(client_name, {"client_name": client_name, "unbilled": 0.0, "project_count": 0})
        row["unbilled"] = float(row["unbilled"]) + float(amount)
        row["project_count"] = int(row["project_count"]) + 1

    return sorted(by_client.values(), key=lambda r: float(r["unbilled"]), reverse=True)


@app.post("/accounting/import-preview")
async def accounting_import_preview(
    account_id: str,
    file: UploadFile = File(...),
    _: User = Depends(require_permission("MANAGE_ACCOUNTING_RULES")),
) -> dict[str, object]:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows: list[AccountingPreviewRow] = []

    for row in reader:
        posted_date = _first_value(row, DATE_COLUMNS)
        description = _first_value(row, DESC_COLUMNS)

        amount, direction = _extract_amount_direction(row)
        vendor_norm = _normalize_vendor(description)
        dedupe_hash = hashlib.sha256(
            f"{account_id}|{posted_date}|{direction}|{Decimal(str(amount)):.2f}|{vendor_norm}".encode("utf-8")
        ).hexdigest()

        rows.append(
            AccountingPreviewRow(
                posted_date=posted_date,
                description=description,
                amount=amount,
                direction=direction,
                account_id=account_id,
                vendor_norm=vendor_norm,
                dedupe_hash=dedupe_hash,
            )
        )

    return {"rows": [r.model_dump() for r in rows], "count": len(rows)}


@app.post("/time-import/freshbooks")
async def freshbooks_time_import(
    apply: bool = False,
    file: UploadFile = File(...),
    mapping_overrides: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_USERS")),
) -> dict[str, object]:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    overrides = _parse_mapping_overrides(mapping_overrides)
    date_cols = _time_cols("date", TIME_DATE_COLUMNS, overrides)
    employee_cols = _time_cols("employee", TIME_EMPLOYEE_COLUMNS, overrides)
    project_cols = _time_cols("project", TIME_PROJECT_COLUMNS, overrides)
    task_cols = _time_cols("task", TIME_TASK_COLUMNS, overrides)
    subtask_cols = _time_cols("subtask", TIME_SUBTASK_COLUMNS, overrides)
    hours_cols = _time_cols("hours", TIME_HOURS_COLUMNS, overrides)
    note_cols = _time_cols("note", TIME_NOTE_COLUMNS, overrides)
    bill_cols = _time_cols("bill_rate", TIME_BILL_RATE_COLUMNS, overrides)
    cost_cols = _time_cols("cost_rate", TIME_COST_RATE_COLUMNS, overrides)
    status_cols = _time_cols("status", TIME_STATUS_COLUMNS, overrides)

    users_cache: dict[str, User] = {}
    projects_cache: dict[str, Project] = {}
    tasks_cache: dict[tuple[int, str], Task] = {}
    subtasks_cache: dict[tuple[int, str], Subtask] = {}
    imported = 0
    skipped = 0
    errors = 0
    non_approved = 0
    min_imported_date: date | None = None
    max_imported_date: date | None = None
    rows_out: list[TimeImportRowOut] = []

    for row_index, row in enumerate(reader, start=2):
        work_date_raw = _first_value(row, date_cols)
        employee_raw = _first_value(row, employee_cols)
        project_name = _first_value(row, project_cols) or "Imported Project"
        task_name = _first_value(row, task_cols) or "General"
        subtask_name = _first_value(row, subtask_cols) or task_name
        note = _first_value(row, note_cols)
        approval_status_raw = _first_value(row, status_cols)

        parsed_date = _parse_flexible_date(work_date_raw)
        parsed_hours = _extract_time_hours(row, hours_cols)
        employee_email = _resolve_import_email(db, employee_raw)

        if parsed_date is None:
            rows_out.append(
                TimeImportRowOut(
                    row_number=row_index,
                    work_date=None,
                    employee_email=employee_email,
                    project_name=project_name,
                    task_name=task_name,
                    subtask_name=subtask_name,
                    hours=parsed_hours,
                    note=note,
                    status="error",
                    reason="Invalid or missing date",
                )
            )
            errors += 1
            continue

        if not parsed_hours or parsed_hours <= 0:
            rows_out.append(
                TimeImportRowOut(
                    row_number=row_index,
                    work_date=parsed_date.isoformat(),
                    employee_email=employee_email,
                    project_name=project_name,
                    task_name=task_name,
                    subtask_name=subtask_name,
                    hours=parsed_hours,
                    note=note,
                    status="error",
                    reason="Invalid or missing hours",
                )
            )
            errors += 1
            continue

        if not _is_approved_import_status(approval_status_raw):
            rows_out.append(
                TimeImportRowOut(
                    row_number=row_index,
                    work_date=parsed_date.isoformat(),
                    employee_email=employee_email,
                    project_name=project_name,
                    task_name=task_name,
                    subtask_name=subtask_name,
                    hours=parsed_hours,
                    note=note,
                    status="skipped",
                    reason=f"Not approved ({approval_status_raw})",
                )
            )
            skipped += 1
            non_approved += 1
            continue

        if not apply:
            rows_out.append(
                TimeImportRowOut(
                    row_number=row_index,
                    work_date=parsed_date.isoformat(),
                    employee_email=employee_email,
                    project_name=project_name,
                    task_name=task_name,
                    subtask_name=subtask_name,
                    hours=parsed_hours,
                    note=note,
                    status="ready",
                )
            )
            continue

        user = users_cache.get(employee_email)
        if not user:
            user = db.scalar(select(User).where(User.email == employee_email))
            if not user:
                user = User(email=employee_email, full_name=employee_email.split("@")[0], role="employee", is_active=True)
                db.add(user)
                db.flush()
            elif not user.is_active:
                user.is_active = True
            users_cache[employee_email] = user

        project = projects_cache.get(project_name.lower())
        if not project:
            project = db.scalar(select(Project).where(func.lower(Project.name) == project_name.lower()))
            if not project:
                project = Project(
                    name=project_name.strip(),
                    client_name="Imported Client",
                    pm_user_id=current_user.id,
                    is_overhead=False,
                    is_active=True,
                )
                db.add(project)
                db.flush()
            projects_cache[project_name.lower()] = project

        task_key = (project.id, task_name.lower())
        task = tasks_cache.get(task_key)
        if not task:
            task = db.scalar(
                select(Task).where(and_(Task.project_id == project.id, func.lower(Task.name) == task_name.lower()))
            )
            if not task:
                task = Task(project_id=project.id, name=task_name.strip(), is_billable=bool(project.is_billable))
                db.add(task)
                db.flush()
            tasks_cache[task_key] = task

        subtask_key = (task.id, subtask_name.lower())
        subtask = subtasks_cache.get(subtask_key)
        if not subtask:
            subtask = db.scalar(
                select(Subtask).where(and_(Subtask.task_id == task.id, func.lower(Subtask.name) == subtask_name.lower()))
            )
            if not subtask:
                code = f"IMP-{hashlib.sha1(subtask_name.lower().encode('utf-8')).hexdigest()[:6].upper()}"
                subtask = Subtask(task_id=task.id, code=code, name=subtask_name.strip(), budget_hours=0.0, budget_fee=0.0)
                db.add(subtask)
                db.flush()
            subtasks_cache[subtask_key] = subtask

        normalized_note = _normalize_note_for_compare(note)
        source_hash = _import_row_fingerprint(
            user_id=user.id,
            project_id=project.id,
            task_id=task.id,
            subtask_id=subtask.id,
            work_date=parsed_date,
            hours=parsed_hours,
            note=normalized_note,
        )
        source_marker = _import_marker(source_hash)
        scoped_entries = db.scalars(
            select(TimeEntry).where(
                and_(
                    TimeEntry.user_id == user.id,
                    TimeEntry.project_id == project.id,
                    TimeEntry.task_id == task.id,
                    TimeEntry.subtask_id == subtask.id,
                    TimeEntry.work_date == parsed_date,
                )
            )
        ).all()
        day_entries = db.scalars(
            select(TimeEntry).where(
                and_(
                    TimeEntry.user_id == user.id,
                    TimeEntry.work_date == parsed_date,
                )
            )
        ).all()
        day_project_ids = sorted({int(e.project_id) for e in day_entries if e.project_id is not None})
        day_projects_by_id: dict[int, Project] = {}
        if day_project_ids:
            day_projects_by_id = {
                p.id: p
                for p in db.scalars(select(Project).where(Project.id.in_(day_project_ids) if day_project_ids else false())).all()
            }

        def _is_placeholder_project(entry: TimeEntry) -> bool:
            p = day_projects_by_id.get(int(entry.project_id)) if entry.project_id is not None else None
            pname = (p.name if p else "").strip().lower()
            return pname in {"no project", "imported project"} or pname.startswith("no project")

        already_imported = any(source_marker in (e.note or "") for e in scoped_entries)
        has_exact_content_match = any(
            abs(float(e.hours) - float(parsed_hours)) < 1e-9
            and _normalize_note_for_compare(_strip_import_marker(e.note or "")) == normalized_note
            for e in scoped_entries
        )
        stale_conflicting_entries = [
            e
            for e in day_entries
            if (
                e.project_id != project.id
                or e.task_id != task.id
                or e.subtask_id != subtask.id
            )
            and _has_import_marker(e.note or "")
            and abs(float(e.hours) - float(parsed_hours)) < 1e-9
            and _normalize_note_for_compare(_strip_import_marker(e.note or "")) == normalized_note
        ]
        stale_placeholder_entries = [e for e in stale_conflicting_entries if _is_placeholder_project(e)]

        if already_imported or has_exact_content_match:
            if stale_conflicting_entries:
                for e in stale_conflicting_entries:
                    db.delete(e)
                imported += 1
                min_imported_date = parsed_date if min_imported_date is None else min(min_imported_date, parsed_date)
                max_imported_date = parsed_date if max_imported_date is None else max(max_imported_date, parsed_date)
                rows_out.append(
                    TimeImportRowOut(
                        row_number=row_index,
                        work_date=parsed_date.isoformat(),
                        employee_email=employee_email,
                        project_name=project_name,
                        task_name=task_name,
                        subtask_name=subtask_name,
                        hours=parsed_hours,
                        note=note,
                        status="imported",
                        reason=(
                            f"Removed {len(stale_conflicting_entries)} stale conflicting import entr"
                            f"{'y' if len(stale_conflicting_entries)==1 else 'ies'}"
                            + (
                                f" ({len(stale_placeholder_entries)} placeholder)"
                                if stale_placeholder_entries
                                else ""
                            )
                        ),
                    )
                )
                continue
            rows_out.append(
                TimeImportRowOut(
                    row_number=row_index,
                    work_date=parsed_date.isoformat(),
                    employee_email=employee_email,
                    project_name=project_name,
                    task_name=task_name,
                    subtask_name=subtask_name,
                    hours=parsed_hours,
                    note=note,
                    status="skipped",
                    reason="Duplicate existing entry",
                )
            )
            skipped += 1
            continue

        bill_rate = _parse_float(_first_value(row, bill_cols))
        cost_rate = _parse_float(_first_value(row, cost_cols))
        if bill_rate is None or cost_rate is None:
            existing_rate = db.scalar(
                select(UserRate)
                .where(and_(UserRate.user_id == user.id, UserRate.effective_date <= parsed_date))
                .order_by(UserRate.effective_date.desc())
            )
            if existing_rate:
                bill_rate = _normalize_rate_4dp(float(existing_rate.bill_rate), "bill_rate")
                cost_rate = _normalize_rate_4dp(float(existing_rate.cost_rate), "cost_rate")
            else:
                bill_rate = bill_rate if bill_rate is not None else 125.0
                cost_rate = cost_rate if cost_rate is not None else round(float(bill_rate) * 0.4, 2)
                bill_rate = _normalize_rate_4dp(float(bill_rate), "bill_rate")
                cost_rate = _normalize_rate_4dp(float(cost_rate), "cost_rate")
                new_rate = UserRate(
                    user_id=user.id,
                    effective_date=parsed_date,
                    bill_rate=bill_rate,
                    cost_rate=cost_rate,
                )
                db.add(new_rate)
                db.flush()
        else:
            bill_rate = _normalize_rate_4dp(float(bill_rate), "bill_rate")
            cost_rate = _normalize_rate_4dp(float(cost_rate), "cost_rate")

        move_candidates = [
            e
            for e in day_entries
            if _has_import_marker(e.note or "")
            and abs(float(e.hours) - float(parsed_hours)) < 1e-9
            and _normalize_note_for_compare(_strip_import_marker(e.note or "")) == normalized_note
        ]
        if len(move_candidates) == 1:
            existing = move_candidates[0]
            if (
                existing.project_id != project.id
                or existing.task_id != task.id
                or existing.subtask_id != subtask.id
                or abs(float(existing.bill_rate_applied or 0.0) - float(bill_rate)) > 1e-9
                or abs(float(existing.cost_rate_applied or 0.0) - float(cost_rate)) > 1e-9
            ):
                old_project_id = existing.project_id
                old_task_id = existing.task_id
                old_subtask_id = existing.subtask_id
                existing.project_id = project.id
                existing.task_id = task.id
                existing.subtask_id = subtask.id
                existing.bill_rate_applied = float(bill_rate)
                existing.cost_rate_applied = float(cost_rate)
                source_note = note.strip()
                existing.note = (
                    f"{source_note} {source_marker} [IMPORT UPDATE: reassigned from "
                    f"project_id={old_project_id}, task_id={old_task_id}, subtask_id={old_subtask_id}]"
                ).strip()
                imported += 1
                min_imported_date = parsed_date if min_imported_date is None else min(min_imported_date, parsed_date)
                max_imported_date = parsed_date if max_imported_date is None else max(max_imported_date, parsed_date)
                rows_out.append(
                    TimeImportRowOut(
                        row_number=row_index,
                        work_date=parsed_date.isoformat(),
                        employee_email=employee_email,
                        project_name=project_name,
                        task_name=task_name,
                        subtask_name=subtask_name,
                        hours=float(parsed_hours),
                        note=note,
                        status="imported",
                        reason=f"Updated prior imported entry #{existing.id} to corrected project/task/subtask",
                    )
                )
                continue

        is_change_update = len(scoped_entries) > 0
        if is_change_update:
            existing_total = sum(float(e.hours) for e in scoped_entries)
            prior_versions = len(scoped_entries)
            source_note = note.strip()
            note_text = (
                f"[IMPORT UPDATE] [FB:{source_hash}] Existing total before import: {existing_total:.2f}h "
                f"across {prior_versions} prior entr{'y' if prior_versions == 1 else 'ies'}."
            )
            if source_note:
                note_text += f" Source note: {source_note}"
        else:
            source_note = note.strip()
            note_text = f"{source_note} [FB:{source_hash}]".strip()

        entry = TimeEntry(
            user_id=user.id,
            project_id=project.id,
            task_id=task.id,
            subtask_id=subtask.id,
            work_date=parsed_date,
            hours=float(parsed_hours),
            note=note_text,
            bill_rate_applied=float(bill_rate),
            cost_rate_applied=float(cost_rate),
        )
        db.add(entry)
        imported += 1
        min_imported_date = parsed_date if min_imported_date is None else min(min_imported_date, parsed_date)
        max_imported_date = parsed_date if max_imported_date is None else max(max_imported_date, parsed_date)
        rows_out.append(
            TimeImportRowOut(
                row_number=row_index,
                work_date=parsed_date.isoformat(),
                employee_email=employee_email,
                project_name=project_name,
                task_name=task_name,
                subtask_name=subtask_name,
                hours=float(parsed_hours),
                note=note,
                status="imported",
            )
        )

    if apply:
        db.commit()

    return {
        "apply": apply,
        "count": len(rows_out),
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "non_approved_skipped": non_approved,
        "min_imported_date": min_imported_date.isoformat() if min_imported_date else None,
        "max_imported_date": max_imported_date.isoformat() if max_imported_date else None,
        "rows": [r.model_dump() for r in rows_out],
    }


def _invoice_preview_rows(
    db: Session,
    start: date,
    end: date,
    project_id: int | None,
    approved_only: bool,
) -> tuple[list[InvoicePreviewLineOut], str, float]:
    if end < start:
        raise HTTPException(status_code=400, detail="end must be on or after start")
    q = select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    if project_id is not None:
        q = q.where(TimeEntry.project_id == project_id)
    entries = db.scalars(q.order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())).all()

    if entries:
        task_ids = sorted({e.task_id for e in entries})
        project_ids = sorted({e.project_id for e in entries})
        task_map = {t.id: t for t in db.scalars(select(Task).where(Task.id.in_(task_ids) if task_ids else false())).all()}
        project_map = {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(project_ids) if project_ids else false())).all()}
        entries = [
            e
            for e in entries
            if bool(project_map.get(e.project_id).is_billable if project_map.get(e.project_id) else False)
            and bool(task_map.get(e.task_id).is_billable if task_map.get(e.task_id) else False)
        ]

    if approved_only and entries:
        user_ids = sorted({e.user_id for e in entries})
        timesheets = db.scalars(
            select(Timesheet).where(and_(Timesheet.user_id.in_(user_ids), Timesheet.status == "approved"))
        ).all()
        approved_weeks = {(ts.user_id, ts.week_start) for ts in timesheets}
        entries = [e for e in entries if (e.user_id, _week_start(e.work_date)) in approved_weeks]

    user_map, project_map, task_map, subtask_map = _load_time_entry_reference_maps(db, entries)
    lines: list[InvoicePreviewLineOut] = []
    total_cost = 0.0
    for te in entries:
        out = _to_time_entry_out_with_refs(
            te,
            users_by_id=user_map,
            projects_by_id=project_map,
            tasks_by_id=task_map,
            subtasks_by_id=subtask_map,
        )
        amount = float((out.hours or 0.0) * (out.bill_rate_applied or 0.0))
        total_cost += float((out.hours or 0.0) * (out.cost_rate_applied or 0.0))
        lines.append(
            InvoicePreviewLineOut(
                user_id=out.user_id,
                project_id=out.project_id,
                task_id=out.task_id,
                subtask_id=out.subtask_id,
                work_date=out.work_date,
                employee=out.user_full_name or out.user_email or f"User {out.user_id}",
                project=out.project_name or f"Project {out.project_id}",
                task=out.task_name or f"Task {out.task_id}",
                subtask=out.subtask_name or out.subtask_code or f"Subtask {out.subtask_id}",
                hours=float(out.hours),
                bill_rate=float(out.bill_rate_applied),
                amount=amount,
                note=(out.note or "").strip(),
                source_time_entry_id=out.id,
            )
        )

    if project_id is not None:
        project = db.get(Project, project_id)
        client_name = (project.client_name or "AquatechPM Client") if project else "AquatechPM Client"
    else:
        client_name = "AquatechPM Client"
    return lines, client_name, float(total_cost)


def _next_invoice_number(db: Session, project_id: int | None = None, client_name: str | None = None) -> str:
    project = db.get(Project, project_id) if project_id is not None else None
    haystack = " ".join(
        [
            (project.name if project else "") or "",
            (project.client_name if project else "") or "",
            client_name or "",
        ]
    ).lower()

    if "hdr" in haystack or "henningson" in haystack or "durham" in haystack:
        pattern = re.compile(r"^HDRAQ[- ]?(\d+)[A-Za-z]?$", re.IGNORECASE)
        formatter = lambda n: f"HDRAQ{n:04d}"
    elif "stantec" in haystack or "brown" in haystack or "caldwell" in haystack or "sbc" in haystack:
        pattern = re.compile(r"^SBCAQ[- ]?(\d+)[A-Za-z]?$", re.IGNORECASE)
        formatter = lambda n: f"SBCAQ-{n:04d}"
    else:
        pattern = re.compile(r"^INV-(\d+)$", re.IGNORECASE)
        formatter = lambda n: f"INV-{n:04d}"

    max_no = 0
    all_numbers = db.scalars(select(Invoice.invoice_number)).all()
    for raw in all_numbers:
        value = str(raw or "").strip()
        m = pattern.match(value)
        if not m:
            continue
        try:
            max_no = max(max_no, int(m.group(1)))
        except Exception:
            continue

    next_no = max_no + 1
    candidate = formatter(next_no)
    while db.scalar(select(func.count(Invoice.id)).where(Invoice.invoice_number == candidate)):
        next_no += 1
        candidate = formatter(next_no)
    return candidate


def _invoice_out(db: Session, invoice: Invoice, include_lines: bool) -> InvoiceOut:
    lines: list[InvoiceLineOut] = []
    if include_lines:
        db_lines = db.scalars(
            select(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id).order_by(InvoiceLine.work_date.asc(), InvoiceLine.id.asc())
        ).all()
        users_by_id = {}
        projects_by_id = {}
        tasks_by_id = {}
        subtasks_by_id = {}
        source_ids = [l.source_time_entry_id for l in db_lines if l.source_time_entry_id]
        source_map: dict[int, TimeEntry] = {}
        if source_ids:
            src = db.scalars(select(TimeEntry).where(TimeEntry.id.in_(source_ids))).all()
            source_map = {s.id: s for s in src}
            users_by_id, projects_by_id, tasks_by_id, subtasks_by_id = _load_time_entry_reference_maps(db, src)
        for l in db_lines:
            src = source_map.get(int(l.source_time_entry_id)) if l.source_time_entry_id else None
            legacy_description = (l.description or "").strip()
            legacy_employee = ""
            legacy_task = "Legacy Service"
            if legacy_description:
                # FreshBooks legacy lines often look like:
                # "(Task Name) Employee Name – Jan 22, 2026"
                if ")" in legacy_description and legacy_description.startswith("("):
                    try:
                        left, right = legacy_description.split(")", 1)
                        parsed_task = left[1:].strip()
                        if parsed_task:
                            legacy_task = parsed_task
                        right = right.strip()
                        if "–" in right:
                            legacy_employee = right.split("–", 1)[0].strip()
                        elif "-" in right:
                            legacy_employee = right.split("-", 1)[0].strip()
                        else:
                            legacy_employee = right
                    except Exception:
                        legacy_employee = ""
                if not legacy_employee and "–" in legacy_description:
                    legacy_employee = legacy_description.split("–", 1)[0].strip()
                if not legacy_employee and "-" in legacy_description:
                    legacy_employee = legacy_description.split("-", 1)[0].strip()
            src_out = (
                _to_time_entry_out_with_refs(
                    src,
                    users_by_id=users_by_id,
                    projects_by_id=projects_by_id,
                    tasks_by_id=tasks_by_id,
                    subtasks_by_id=subtasks_by_id,
                )
                if src
                else None
            )
            lines.append(
                InvoiceLineOut(
                    id=l.id,
                    user_id=l.user_id,
                    project_id=l.project_id,
                    task_id=l.task_id,
                    subtask_id=l.subtask_id,
                    work_date=l.work_date,
                    employee=(src_out.user_full_name or src_out.user_email or f"User {src_out.user_id}") if src_out else (legacy_employee or "Legacy Import"),
                    project=(src_out.project_name or f"Project {src_out.project_id}") if src_out else (invoice.client_name or "Legacy Import"),
                    task=(src_out.task_name or f"Task {src_out.task_id}") if src_out else legacy_task,
                    subtask=(src_out.subtask_name or src_out.subtask_code or f"Subtask {src_out.subtask_id}") if src_out else "",
                    description=l.description,
                    hours=float(l.hours or 0.0),
                    bill_rate=float(l.bill_rate or 0.0),
                    cost_rate=float(src_out.cost_rate_applied if src_out else 0.0),
                    amount=float(l.amount or 0.0),
                    note=(l.note or ""),
                    source_time_entry_id=l.source_time_entry_id,
                )
            )
    return InvoiceOut(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        status=invoice.status,
        source=invoice.source or "app",
        project_id=invoice.project_id,
        client_name=invoice.client_name or "",
        start_date=invoice.start_date,
        end_date=invoice.end_date,
        issue_date=invoice.issue_date,
        due_date=invoice.due_date,
        subtotal_amount=float(invoice.subtotal_amount or 0.0),
        amount_paid=float(invoice.amount_paid or 0.0),
        balance_due=float(invoice.balance_due or 0.0),
        total_cost=float(invoice.total_cost or 0.0),
        total_profit=float(invoice.total_profit or 0.0),
        recurring_schedule_id=invoice.recurring_schedule_id,
        recurring_run_date=invoice.recurring_run_date,
        payment_link_enabled=bool(invoice.payment_link_enabled),
        payment_link_expires_at=invoice.payment_link_expires_at,
        payment_link_url=_payment_link_url(invoice.payment_link_token) if invoice.payment_link_token else None,
        paid_date=invoice.paid_date,
        notes=invoice.notes or "",
        logo_url="/Aqt_Logo.png",
        line_count=len(lines) if include_lines else int(
            db.scalar(select(func.count(InvoiceLine.id)).where(InvoiceLine.invoice_id == invoice.id)) or 0
        ),
        lines=lines,
    )


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _ensure_default_subtask_for_task(db: Session, task: Task) -> tuple[Subtask, bool]:
    existing = db.scalar(
        select(Subtask).where(
            and_(
                Subtask.task_id == task.id,
                or_(Subtask.code == NO_SUBTASK_CODE, Subtask.name == NO_SUBTASK_NAME),
            )
        )
    )
    if existing:
        return existing, False

    default_subtask = Subtask(
        task_id=task.id,
        code=NO_SUBTASK_CODE,
        name=NO_SUBTASK_NAME,
        budget_hours=0.0,
        budget_fee=0.0,
    )
    db.add(default_subtask)
    db.flush()
    return default_subtask, True


def _sum_subtask_budget_fee_for_project(db: Session, project_id: int) -> float:
    value = db.scalar(
        select(func.sum(Subtask.budget_fee))
        .select_from(Subtask)
        .join(Task, Task.id == Subtask.task_id)
        .where(Task.project_id == project_id)
    )
    return float(value or 0.0)


def _log_audit_event(
    db: Session,
    entity_type: str,
    entity_id: int,
    action: str,
    actor_user_id: int | None,
    payload: dict[str, object],
) -> None:
    evt = AuditEvent(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        actor_user_id=actor_user_id,
        payload_json=json.dumps(payload, default=str),
    )
    db.add(evt)


def _timesheet_hours(db: Session, user_id: int, start: date, end: date) -> float:
    value = db.scalar(
        select(func.sum(TimeEntry.hours)).where(
            and_(TimeEntry.user_id == user_id, TimeEntry.work_date >= start, TimeEntry.work_date <= end)
        )
    )
    return float(value or 0.0)


def _to_user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        start_date=user.start_date,
        permissions=sorted(permissions_for_role(user.role)),
    )


def _to_project_out(project: Project) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        client_name=project.client_name,
        pm_user_id=project.pm_user_id,
        start_date=project.start_date,
        end_date=project.end_date,
        overall_budget_fee=float(project.overall_budget_fee or 0.0),
        target_gross_margin_pct=float(project.target_gross_margin_pct or 0.0),
        is_overhead=project.is_overhead,
        is_billable=project.is_billable,
        is_active=project.is_active,
    )


def _to_time_entry_out(entry: TimeEntry) -> TimeEntryOut:
    return _to_time_entry_out_with_refs(entry)


def _load_time_entry_reference_maps(
    db: Session, entries: list[TimeEntry]
) -> tuple[dict[int, User], dict[int, Project], dict[int, Task], dict[int, Subtask]]:
    if not entries:
        return {}, {}, {}, {}
    user_ids = sorted({e.user_id for e in entries})
    project_ids = sorted({e.project_id for e in entries})
    task_ids = sorted({e.task_id for e in entries})
    subtask_ids = sorted({e.subtask_id for e in entries})
    users = db.scalars(select(User).where(User.id.in_(user_ids) if user_ids else false())).all()
    projects = db.scalars(select(Project).where(Project.id.in_(project_ids) if project_ids else false())).all()
    tasks = db.scalars(select(Task).where(Task.id.in_(task_ids) if task_ids else false())).all()
    subtasks = db.scalars(select(Subtask).where(Subtask.id.in_(subtask_ids) if subtask_ids else false())).all()
    return (
        {u.id: u for u in users},
        {p.id: p for p in projects},
        {t.id: t for t in tasks},
        {s.id: s for s in subtasks},
    )


def _to_time_entry_out_with_refs(
    entry: TimeEntry,
    users_by_id: dict[int, User] | None = None,
    projects_by_id: dict[int, Project] | None = None,
    tasks_by_id: dict[int, Task] | None = None,
    subtasks_by_id: dict[int, Subtask] | None = None,
) -> TimeEntryOut:
    u = users_by_id.get(entry.user_id) if users_by_id else None
    p = projects_by_id.get(entry.project_id) if projects_by_id else None
    t = tasks_by_id.get(entry.task_id) if tasks_by_id else None
    s = subtasks_by_id.get(entry.subtask_id) if subtasks_by_id else None
    return TimeEntryOut(
        id=entry.id,
        user_id=entry.user_id,
        project_id=entry.project_id,
        task_id=entry.task_id,
        subtask_id=entry.subtask_id,
        user_email=u.email if u else None,
        user_full_name=u.full_name if u else None,
        project_name=p.name if p else None,
        task_name=t.name if t else None,
        subtask_code=s.code if s else None,
        subtask_name=s.name if s else None,
        work_date=entry.work_date,
        hours=entry.hours,
        note=entry.note,
        bill_rate_applied=entry.bill_rate_applied,
        cost_rate_applied=entry.cost_rate_applied,
    )


def _to_timesheet_out(ts: Timesheet, total_hours: float) -> TimesheetOut:
    return TimesheetOut(
        id=ts.id,
        user_id=ts.user_id,
        week_start=ts.week_start,
        week_end=ts.week_end,
        status=ts.status,
        employee_signed_at=ts.employee_signed_at,
        supervisor_signed_at=ts.supervisor_signed_at,
        total_hours=total_hours,
    )


def _first_value(row: dict[str, str], candidates: list[str]) -> str:
    for key in candidates:
        value = row.get(key)
        if value is not None and value.strip() != "":
            return value.strip()
    return ""


def _parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    stripped = value.strip().replace(",", "").replace("$", "")
    if stripped.startswith("(") and stripped.endswith(")"):
        stripped = f"-{stripped[1:-1]}"
    if stripped == "":
        return None
    return float(stripped)


def _oauth_redirect(status_value: str, detail: str) -> RedirectResponse:
    base = settings.FRONTEND_ORIGIN.rstrip("/")
    query = urlencode({"auth_status": status_value, "auth_detail": detail})
    return RedirectResponse(url=f"{base}/?{query}")


def _extract_amount_direction(row: dict[str, str]) -> tuple[float, str]:
    amount_raw = _first_value(row, AMOUNT_COLUMNS)
    if amount_raw:
        amount = float(amount_raw.replace(",", ""))
        if amount < 0:
            return abs(amount), "debit"
        return amount, "credit"

    debit = _parse_float(_first_value(row, DEBIT_COLUMNS)) or 0.0
    credit = _parse_float(_first_value(row, CREDIT_COLUMNS)) or 0.0
    if debit > 0:
        return float(debit), "debit"
    if credit > 0:
        return float(credit), "credit"
    return 0.0, "debit"


def _parse_flexible_date(value: str) -> date | None:
    if not value:
        return None
    v = value.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%m-%d-%Y", "%m-%d-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def _parse_duration_to_hours(value: str) -> float | None:
    if not value:
        return None
    v = value.strip().lower()
    if ":" in v:
        parts = v.split(":")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            h = int(parts[0])
            m = int(parts[1])
            s = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else 0
            return h + (m / 60.0) + (s / 3600.0)
    m = re.match(r"^\s*(\d+)\s*h(?:\s*(\d+)\s*m)?\s*$", v)
    if m:
        h = int(m.group(1))
        mins = int(m.group(2) or "0")
        return h + (mins / 60.0)
    try:
        return float(v.replace(",", ""))
    except ValueError:
        return None


def _extract_time_hours(row: dict[str, str], candidates: list[str]) -> float | None:
    raw = _first_value(row, candidates)
    return _parse_duration_to_hours(raw)


def _normalize_note_for_compare(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _strip_import_marker(value: str) -> str:
    cleaned = re.sub(r"\s*\[FB:[0-9a-f]{40}\]\s*", " ", value or "", flags=re.IGNORECASE)
    return " ".join(cleaned.split()).strip()


def _has_import_marker(value: str) -> bool:
    return bool(re.search(r"\[FB:[0-9a-f]{40}\]", value or "", flags=re.IGNORECASE))


def _import_marker(source_hash: str) -> str:
    return f"[FB:{source_hash}]"


def _import_row_fingerprint(
    *,
    user_id: int,
    project_id: int,
    task_id: int,
    subtask_id: int,
    work_date: date,
    hours: float,
    note: str,
) -> str:
    payload = "|".join(
        [
            str(user_id),
            str(project_id),
            str(task_id),
            str(subtask_id),
            work_date.isoformat(),
            f"{float(hours):.4f}",
            note,
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _normalize_rate_4dp(value: float, field_name: str) -> float:
    dec = Decimal(str(value))
    if dec.as_tuple().exponent < -4:
        raise HTTPException(status_code=400, detail=f"{field_name} must have at most 4 decimal places")
    return float(dec.quantize(Decimal("0.0001")))


def _is_approved_import_status(raw: str) -> bool:
    val = raw.strip().lower()
    if not val:
        return True
    if val in APPROVED_STATUS_VALUES:
        return True
    if val in NON_APPROVED_STATUS_VALUES:
        return False
    if "not approved" in val or "unapproved" in val:
        return False
    # Unknown values should not block imports; only explicit non-approved markers should.
    return True


def _normalize_invoice_status(raw: str) -> str:
    val = (raw or "").strip().lower()
    if val in {"paid", "settled", "closed"}:
        return "paid"
    if val in {"partial", "partially paid", "part-paid"}:
        return "partial"
    if val in {"void", "cancelled", "canceled"}:
        return "void"
    if val in {"draft"}:
        return "draft"
    if val in {"sent", "open", "unpaid", "outstanding", ""}:
        return "sent"
    return "sent"


def _status_from_amounts(*, status: str, total_amount: float, amount_paid: float, balance_due: float) -> str:
    normalized = (status or "").strip().lower()
    if normalized == "void":
        return "void"
    if balance_due <= 0.0001 and total_amount > 0.0001:
        return "paid"
    if amount_paid > 0.0001:
        return "partial"
    if normalized == "draft":
        return "draft"
    return "sent"


def _payment_link_url(token: str) -> str:
    base = settings.FRONTEND_ORIGIN.rstrip("/")
    return f"{base}/pay/{token}"


def _payment_links_disabled_http_error(public_route: bool = False) -> None:
    if settings.PAYMENT_LINKS_ENABLED:
        return
    if public_route:
        raise HTTPException(status_code=404, detail="Not found")
    raise HTTPException(status_code=403, detail="Payment links are disabled")


def _is_payment_link_valid(invoice: Invoice, today: date) -> bool:
    if not invoice.payment_link_enabled or not invoice.payment_link_token:
        return False
    if invoice.status == "void":
        return False
    if float(invoice.balance_due or 0.0) <= 0:
        return False
    if invoice.payment_link_expires_at and invoice.payment_link_expires_at < today:
        return False
    return True


def _normalize_recurrence_cadence(raw: str) -> str:
    val = (raw or "").strip().lower()
    if val not in {"weekly", "monthly"}:
        raise HTTPException(status_code=400, detail="cadence must be one of: weekly, monthly")
    return val


def _to_recurring_schedule_out(s: RecurringInvoiceSchedule) -> RecurringInvoiceScheduleOut:
    return RecurringInvoiceScheduleOut(
        id=s.id,
        name=s.name,
        project_id=s.project_id,
        cadence=s.cadence,
        approved_only=s.approved_only,
        due_days=int(s.due_days or 30),
        next_run_date=s.next_run_date,
        last_run_date=s.last_run_date,
        auto_send_email=s.auto_send_email,
        recipient_email=s.recipient_email or "",
        notes_template=s.notes_template or "",
        is_active=s.is_active,
        created_at=s.created_at,
    )


def _send_timesheet_reminder_email(to_email: str, full_name: str) -> None:
    if not settings.SMTP_HOST or not settings.SMTP_FROM_EMAIL:
        return
    msg = EmailMessage()
    msg["Subject"] = "Daily Reminder: Please Complete Today's Timesheet"
    msg["From"] = settings.SMTP_FROM_EMAIL
    msg["To"] = to_email
    msg.set_content(
        (
            f"Hi {full_name or to_email},\n\n"
            "This is your daily reminder to complete today's timesheet entries before end of day.\n"
            f"Open the app here: {settings.FRONTEND_ORIGIN}\n\n"
            "Thanks,\nAquatechPM"
        )
    )
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=20) as smtp:
        if settings.SMTP_USE_TLS:
            smtp.starttls()
        if settings.SMTP_USERNAME:
            smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


def _run_timesheet_reminder_cycle() -> None:
    if not settings.TIMESHEET_REMINDER_ENABLED:
        return
    tz = ZoneInfo(settings.TIMESHEET_REMINDER_TIMEZONE)
    now_local = datetime.now(tz)
    # Workdays only (Mon-Fri) and at/after configured reminder time.
    if now_local.weekday() >= 5:
        return
    if (now_local.hour, now_local.minute) < (settings.TIMESHEET_REMINDER_HOUR_LOCAL, settings.TIMESHEET_REMINDER_MINUTE_LOCAL):
        return
    if (now_local.hour, now_local.minute) > (settings.TIMESHEET_REMINDER_HOUR_LOCAL, settings.TIMESHEET_REMINDER_MINUTE_LOCAL + 9):
        return
    today_local = now_local.date().isoformat()

    with SessionLocal() as db:
        users = db.scalars(
            select(User).where(and_(User.is_active.is_(True), User.role != "admin"))
        ).all()
        for u in users:
            already = db.scalar(
                select(AuditEvent).where(
                    and_(
                        AuditEvent.entity_type == "timesheet_reminder",
                        AuditEvent.entity_id == u.id,
                        AuditEvent.action == "daily_timesheet_reminder",
                        AuditEvent.payload_json.like(f'%\"local_date\": \"{today_local}\"%'),
                    )
                )
            )
            if already:
                continue
            try:
                _send_timesheet_reminder_email(u.email, u.full_name)
                _log_audit_event(
                    db=db,
                    entity_type="timesheet_reminder",
                    entity_id=u.id,
                    action="daily_timesheet_reminder",
                    actor_user_id=None,
                    payload={"local_date": today_local, "timezone": settings.TIMESHEET_REMINDER_TIMEZONE, "email": u.email},
                )
                db.commit()
            except Exception:
                db.rollback()


def _timesheet_reminder_worker() -> None:
    while True:
        try:
            _run_timesheet_reminder_cycle()
        except Exception:
            pass
        time.sleep(60)


def _start_timesheet_reminder_worker() -> None:
    global _reminder_thread_started
    if _reminder_thread_started or not settings.TIMESHEET_REMINDER_ENABLED:
        return
    t = threading.Thread(target=_timesheet_reminder_worker, name="timesheet-reminder-worker", daemon=True)
    t.start()
    _reminder_thread_started = True


def _add_months(d: date, months: int) -> date:
    target_month = d.month - 1 + months
    year = d.year + (target_month // 12)
    month = (target_month % 12) + 1
    last_day = calendar.monthrange(year, month)[1]
    day = min(d.day, last_day)
    return date(year, month, day)


def _next_schedule_run_date(current: date, cadence: str) -> date:
    return current + timedelta(days=7) if cadence == "weekly" else _add_months(current, 1)


def _billing_period_for_run(run_date: date, cadence: str) -> tuple[date, date]:
    if cadence == "weekly":
        end = run_date - timedelta(days=1)
        start = end - timedelta(days=6)
        return start, end
    first_current = run_date.replace(day=1)
    end = first_current - timedelta(days=1)
    start = end.replace(day=1)
    return start, end


def _advance_schedule_past_run_date(next_run_date: date, cadence: str, run_date: date) -> date:
    advanced = next_run_date
    while advanced <= run_date:
        advanced = _next_schedule_run_date(advanced, cadence)
    return advanced


def _send_invoice_created_email(recipient_email: str, invoice: Invoice) -> None:
    if not recipient_email or not settings.SMTP_HOST or not settings.SMTP_FROM_EMAIL:
        return
    msg = EmailMessage()
    msg["Subject"] = f"Recurring Invoice Generated: {invoice.invoice_number}"
    msg["From"] = settings.SMTP_FROM_EMAIL
    msg["To"] = recipient_email
    msg.set_content(
        (
            f"Invoice {invoice.invoice_number} was generated.\n"
            f"Client: {invoice.client_name}\n"
            f"Period: {invoice.start_date.isoformat()} to {invoice.end_date.isoformat()}\n"
            f"Subtotal: {float(invoice.subtotal_amount or 0.0):.2f}\n"
            f"Status: {invoice.status}\n"
        )
    )
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=20) as smtp:
        if settings.SMTP_USE_TLS:
            smtp.starttls()
        if settings.SMTP_USERNAME:
            smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


def _run_recurring_invoices(db: Session, run_date: date, actor_user_id: int | None) -> RecurringInvoiceRunResult:
    schedules = db.scalars(
        select(RecurringInvoiceSchedule).where(
            and_(RecurringInvoiceSchedule.is_active.is_(True), RecurringInvoiceSchedule.next_run_date <= run_date)
        ).order_by(RecurringInvoiceSchedule.next_run_date.asc(), RecurringInvoiceSchedule.id.asc())
    ).all()

    considered = 0
    created = 0
    skipped_no_billable_entries = 0
    skipped_existing_for_period = 0
    errors = 0
    invoice_ids: list[int] = []

    for schedule in schedules:
        considered += 1
        try:
            start_date, end_date = _billing_period_for_run(run_date, schedule.cadence)
            existing = db.scalar(
                select(Invoice).where(
                    and_(
                        Invoice.source == "recurring",
                        Invoice.recurring_schedule_id == schedule.id,
                        Invoice.start_date == start_date,
                        Invoice.end_date == end_date,
                    )
                )
            )
            if existing:
                skipped_existing_for_period += 1
                schedule.last_run_date = run_date
                schedule.next_run_date = _advance_schedule_past_run_date(schedule.next_run_date, schedule.cadence, run_date)
                db.commit()
                continue

            lines, client_name, total_cost = _invoice_preview_rows(
                db=db,
                start=start_date,
                end=end_date,
                project_id=schedule.project_id,
                approved_only=bool(schedule.approved_only),
            )
            if len(lines) == 0:
                skipped_no_billable_entries += 1
                schedule.last_run_date = run_date
                schedule.next_run_date = _advance_schedule_past_run_date(schedule.next_run_date, schedule.cadence, run_date)
                db.commit()
                continue

            subtotal = float(sum(line.amount for line in lines))
            invoice = Invoice(
                invoice_number=_next_invoice_number(db, project_id=schedule.project_id, client_name=client_name),
                project_id=schedule.project_id,
                client_name=client_name,
                start_date=start_date,
                end_date=end_date,
                issue_date=run_date,
                due_date=run_date + timedelta(days=int(schedule.due_days or 30)),
                status="sent",
                source="recurring",
                subtotal_amount=subtotal,
                amount_paid=0.0,
                balance_due=subtotal,
                total_cost=total_cost,
                total_profit=float(subtotal - total_cost),
                recurring_schedule_id=schedule.id,
                recurring_run_date=run_date,
                notes=(schedule.notes_template or "").strip(),
            )
            db.add(invoice)
            db.flush()
            for line in lines:
                db.add(
                    InvoiceLine(
                        invoice_id=invoice.id,
                        source_time_entry_id=line.source_time_entry_id,
                        work_date=line.work_date,
                        user_id=line.user_id,
                        project_id=line.project_id,
                        task_id=line.task_id,
                        subtask_id=line.subtask_id,
                        description=f"{line.employee} | {line.project} | {line.task} | {line.subtask}",
                        note=line.note,
                        hours=line.hours,
                        bill_rate=line.bill_rate,
                        amount=line.amount,
                    )
                )
            schedule.last_run_date = run_date
            schedule.next_run_date = _advance_schedule_past_run_date(schedule.next_run_date, schedule.cadence, run_date)
            _log_audit_event(
                db=db,
                entity_type="invoice",
                entity_id=invoice.id,
                action="create_invoice_recurring",
                actor_user_id=actor_user_id,
                payload={
                    "invoice_number": invoice.invoice_number,
                    "schedule_id": schedule.id,
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "line_count": len(lines),
                    "subtotal_amount": invoice.subtotal_amount,
                },
            )
            db.commit()
            created += 1
            invoice_ids.append(invoice.id)
            if schedule.auto_send_email and schedule.recipient_email:
                try:
                    _send_invoice_created_email(schedule.recipient_email, invoice)
                except Exception:
                    pass
        except Exception:
            db.rollback()
            errors += 1

    return RecurringInvoiceRunResult(
        run_date=run_date,
        schedules_considered=considered,
        invoices_created=created,
        skipped_no_billable_entries=skipped_no_billable_entries,
        skipped_existing_for_period=skipped_existing_for_period,
        errors=errors,
        invoice_ids=invoice_ids,
    )


def _run_recurring_invoice_cycle() -> None:
    if not settings.RECURRING_INVOICE_ENABLED:
        return
    tz = ZoneInfo(settings.RECURRING_INVOICE_TIMEZONE)
    now_local = datetime.now(tz)
    if now_local.weekday() >= 5:
        return
    if (now_local.hour, now_local.minute) < (settings.RECURRING_INVOICE_RUN_HOUR_LOCAL, settings.RECURRING_INVOICE_RUN_MINUTE_LOCAL):
        return
    if (now_local.hour, now_local.minute) > (settings.RECURRING_INVOICE_RUN_HOUR_LOCAL, settings.RECURRING_INVOICE_RUN_MINUTE_LOCAL + 9):
        return
    today_local = now_local.date().isoformat()
    with SessionLocal() as db:
        already = db.scalar(
            select(AuditEvent).where(
                and_(
                    AuditEvent.entity_type == "recurring_invoice_runner",
                    AuditEvent.entity_id == 0,
                    AuditEvent.action == "daily_run",
                    AuditEvent.payload_json.like(f'%\"local_date\": \"{today_local}\"%'),
                )
            )
        )
        if already:
            return
        res = _run_recurring_invoices(db=db, run_date=now_local.date(), actor_user_id=None)
        _log_audit_event(
            db=db,
            entity_type="recurring_invoice_runner",
            entity_id=0,
            action="daily_run",
            actor_user_id=None,
            payload={
                "local_date": today_local,
                "timezone": settings.RECURRING_INVOICE_TIMEZONE,
                "created": res.invoices_created,
                "considered": res.schedules_considered,
            },
        )
        db.commit()


def _recurring_invoice_worker() -> None:
    while True:
        try:
            _run_recurring_invoice_cycle()
        except Exception:
            pass
        time.sleep(60)


def _start_recurring_invoice_worker() -> None:
    global _recurring_thread_started
    if _recurring_thread_started or not settings.RECURRING_INVOICE_ENABLED:
        return
    t = threading.Thread(target=_recurring_invoice_worker, name="recurring-invoice-worker", daemon=True)
    t.start()
    _recurring_thread_started = True


def _parse_mapping_overrides(raw: str | None) -> dict[str, list[str]]:
    if not raw or raw.strip() == "":
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid mapping_overrides JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="mapping_overrides must be a JSON object")
    out: dict[str, list[str]] = {}
    for k, v in parsed.items():
        if isinstance(v, str):
            out[str(k)] = [v]
        elif isinstance(v, list):
            vals = [str(x) for x in v if str(x).strip() != ""]
            out[str(k)] = vals
        else:
            raise HTTPException(status_code=400, detail=f"mapping_overrides[{k}] must be string or array")
    return out


def _time_cols(key: str, defaults: list[str], overrides: dict[str, list[str]]) -> list[str]:
    custom = overrides.get(key, [])
    merged = [c for c in custom if c not in defaults] + defaults
    return merged


def _resolve_import_email(db: Session, raw: str) -> str:
    v = raw.strip().lower()
    if "@" in v:
        return v
    slug = re.sub(r"[^a-z0-9]+", ".", v).strip(".")
    if not slug:
        slug = "imported.user"
    name_match = db.scalar(select(User).where(func.lower(User.full_name) == raw.strip().lower()))
    if name_match:
        return name_match.email
    slug_match = db.scalar(select(User).where(func.lower(User.email).like(f"{slug}@%")))
    if slug_match:
        return slug_match.email
    fuzzy_slug_match = db.scalar(select(User).where(func.lower(User.email).like(f"{slug}.%@%")))
    if fuzzy_slug_match:
        return fuzzy_slug_match.email
    return f"{slug}.placeholder@aquatechpc.com"


def _normalize_vendor(description: str) -> str:
    cleaned = re.sub(r"[^A-Z0-9 ]+", " ", description.upper())
    words = [w for w in cleaned.split() if w not in NOISE_WORDS]
    return " ".join(words)
