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
from pathlib import Path
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
import httpx
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
    IntegrationToken,
    Loan,
    LoanPayment,
    Project,
    ProjectExpense,
    ProjectMember,
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
from . import freshbooks as fb_integration
from . import gusto as gusto_integration
from . import plaid_integration


# ---------- Reconciliation keyword constants ----------
# Centralized so P&L, cashflow, full-report, and active-opex endpoints stay in sync.

CC_TRANSFER_KEYWORDS = (
    "PAYMENT THANK YOU", "INTERNAL TRANSFER", "EQUITY TRANSFER", "INVESTMENT TRANSFER",
    "ONLINE TRANSFER TO CHK", "ONLINE TRANSFER FROM CHK",
    "PAYMENT TO CHASE CARD", "AUTOMATIC PAYMENT",
    # Wires (to own / foreign-currency-business / brokerage accounts) + Amex card
    # payments — these move money or pay a card, they are NOT operating expenses.
    # (Per user 2026-06-07: 2026 wires are all transfers, not vendor payments.)
    "WIRE TRANSFER", "DOMESTIC WIRE", "INTERNATIONAL WIRE", "AMERICAN EXPRESS ACH",
)

PAYROLL_KEYWORDS = (
    "GUSTO",            # all Gusto wires
    "MATRIX TRUST",     # 401(k) custodian
    "HUMAN INTEREST",   # 401(k) plan administrator
    "NU ERA", "NUERA",  # health insurance benefits
    "NYSIF",            # NY State Workers Comp + disability
)

# Subset of PAYROLL_KEYWORDS that should specifically be added to COGS (benefits/WC),
# not just excluded from OPEX. Currently same set minus pure payroll wires.
BENEFITS_TO_COGS_KEYWORDS = ("NYSIF", "NU ERA", "NUERA", "HUMAN INTEREST")

PERSONAL_OVERRIDE_KEYWORDS = (
    "ALPACADB", "MOOMOO FINANCIAL", "FUTUINC",
    "RH BROKERAGE", "RHS BROKERAGE", "ROBINHOOD",
    "INTERACTIVEBROKERS", "INTERACTIVE BROKER", "PUBLIC.COM",  # brokerage/investing transfers (not OPEX)
    "MANUAL DB-BKRG", "MANUAL CR-BKRG",
    "BERTRAND LOAN REPAYMENT",
)

# Merchant-cash-advance / short-term business financing. The payment is debt
# servicing (principal + baked-in fee), NOT an operating expense — exclude from OPEX.
# (Interest portion is not separately modeled; revisit via Loans if it becomes material.)
FINANCING_EXCLUDE_KEYWORDS = ("FUNDBOX", "FORWARD FIN", "KAPITUS", "ONDECK", "BLUEVINE")

# Personal-account items that ARE business per user directive:
#   1. Computer hardware purchases at major retailers
#   2. Travel — airfare, hotels, taxis, ride-share, transit (per user 2026-05-02:
#      "in 2025 we took many trips that were business expenses, so airfare hotels
#      taxis uber all these charges were opex whether in personal or business account")
PERSONAL_TO_BUSINESS_KEYWORDS = (
    # Computer hardware
    "BEST BUY", "BESTBUY", "BBY*",
    "HP STORE", "HP.COM", "HEWLETT",
    "APPLE STORE", "APPLE.COM/US", "APPLE INC",
    "MICRO CENTER", "MICROCENTER",
    # Airlines + airfare upgrades
    "DELTA AIR", "AMERICAN AIR", "UNITED AIRL", "JETBLUE", "SOUTHWEST",
    "ALASKA AIR", "SPIRIT AIR", "FRONTIER AIR", "ALLEGIANT",
    "AIR FRANCE", "AIR CANADA", "BRITISH AIR", "VIRGIN ATLANTIC",
    "FRENCH BEE", "LUFTHANSA", "KLM", "IBERIA", "TURKISH AIR",
    "EMIRATES", "QATAR", "JAL ", "ANA ", "QANTAS", "SINGAPORE AIR",
    "EASYUPGRADE", "PLUSGRADE",
    # Hotels
    "MARRIOTT", "HILTON", "HYATT", "IHG", "INTERCONTINENTAL",
    "SHERATON", "WESTIN", "RAMADA", "RADISSON", "DOUBLETREE",
    "BEST WESTERN", "HOLIDAY INN", "CROWNE PLAZA", "EMBASSY SUITES",
    "FOUR SEASONS", "RITZ ", "WALDORF", "FAIRMONT", "NOVOTEL", "IBIS ",
    "EXPEDIA", "BOOKING.COM", "HOTELS.COM", "AIRBNB", "VRBO",
    "PRICELINE", "TRAVELOCITY", "ORBITZ", "KAYAK", "TRIVAGO",
    # Ride-share + taxi + transit
    "UBER", "UBR*", "LYFT", "TAXI", "MEDALLION", "CABS",
    "MTA ", "METRO", "LIRR", "PATH", "WMATA", "TFL ", "RATP", "SNCF",
    "AMTRAK", "GREYHOUND", "MEGABUS", "FLIXBUS",
    # Car rental
    "AVIS", "HERTZ", "ENTERPRISE RENT", "BUDGET RENT", "BUDGET CAR",
    "DOLLAR RENT", "NATIONAL CAR", "SIXT", "ZIPCAR", "TURO",
)

PERSONAL_TO_BUSINESS_EXCLUDE_KEYWORDS = (
    "APPLE CASH",       # Apple's P2P payments
    "APPLE.COM/BILL",   # iCloud/Music/etc subscriptions
)

# FreshBooks expense categories (account_id field on csv_fb_expenses rows) that
# represent legit business OPEX. Per user: some FB charges were paid on a
# personal card we don't have linked in AqtPM, so the FB ledger is the only
# record of those expenses. Categories listed here add their amounts to OPEX
# from active (non-superseded) csv_fb_expenses rows.
# Not in this list (intentionally):
#   - Payroll, Cost of Goods Sold, Employee Benefits → already in COGS via Gusto
#   - Personal, Other Expenses, Uncategorized Expenses → ambiguous
#   - Expense Refund → refunds (positive but negate something)
#   - Rent or Lease → mostly Regus, already in OPEX from bank side
FB_CATEGORIES_TO_OPEX = (
    "Travel",
    "Meals & Entertainment",
    "Car & Truck Expenses",
    "Office Expenses & Postage",
    "Utilities",
    "Professional Services",
    "Advertising",
    "Supplies",
    "Education and Training",
    "General Business Admin",
)


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


def _freshbooks_inbox_category(name: str) -> str:
    lowered = name.lower()
    if "revenue_by_client" in lowered or "item_sales" in lowered:
        return "reports"
    if "invoice" in lowered:
        return "invoices"
    if "payment" in lowered:
        return "payments"
    if "expense" in lowered:
        return "expenses"
    if "time" in lowered:
        return "time_entries"
    if "client" in lowered:
        return "clients"
    if "payroll" in lowered:
        return "payroll"
    if "aging" in lowered:
        return "aging"
    if "profit" in lowered or "loss" in lowered:
        return "profit_loss"
    return "other"


def _freshbooks_inbox_preference_score(path: Path) -> tuple[int, int, float]:
    """Pick the best file when several match the same FreshBooks export category.

    Scoring (later items break ties):
      1. Date-range span: wider is better (parsed from filename ``YYYY-MM-DD - YYYY-MM-DD``).
         Falls back to 0 if no parseable date range is in the name.
      2. CSV preferred over XLSX, with a small penalty for ``(1)`` duplicate downloads.
      3. File mtime (most recently modified wins as final tiebreaker).
    """
    name = path.name.lower()
    ext_score = 2 if path.suffix.lower() == ".csv" else 1
    duplicate_name_penalty = -1 if " (1)" in name else 0

    # Parse "YYYY-MM-DD - YYYY-MM-DD" date range from filename if present.
    range_days = 0
    match = re.search(r"(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})", name)
    if match:
        try:
            start_dt = datetime.strptime(match.group(1), "%Y-%m-%d")
            end_dt = datetime.strptime(match.group(2), "%Y-%m-%d")
            if end_dt > start_dt:
                range_days = (end_dt - start_dt).days
        except ValueError:
            range_days = 0

    freshness = path.stat().st_mtime
    return (range_days, ext_score + duplicate_name_penalty, freshness)


def _freshbooks_inbox_files() -> "FreshBooksInboxOut":
    root = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
    if not root.exists():
        return FreshBooksInboxOut(root_path=str(root), exists=False, file_count=0, files=[])

    files = [p for p in sorted(root.iterdir()) if p.is_file() and p.suffix.lower() in {".csv", ".xlsx"}]
    sha_groups: dict[str, list[Path]] = defaultdict(list)
    category_buckets: dict[str, list[Path]] = defaultdict(list)
    hashes: dict[Path, str] = {}
    for path in files:
        digest = hashlib.sha1(path.read_bytes()).hexdigest()
        hashes[path] = digest
        category_buckets[_freshbooks_inbox_category(path.name)].append(path)
        sha_groups[digest].append(path)

    sha_to_primary: dict[str, Path] = {
        digest: max(bucket, key=_freshbooks_inbox_preference_score) for digest, bucket in sha_groups.items()
    }

    preferred_by_category: dict[str, Path] = {}
    for category, bucket in category_buckets.items():
        preferred_by_category[category] = max(bucket, key=_freshbooks_inbox_preference_score)

    out: list[FreshBooksInboxFileOut] = []
    for path in files:
        stat = path.stat()
        digest = hashes[path]
        category = _freshbooks_inbox_category(path.name)
        duplicate_primary = sha_to_primary[digest]
        duplicate_of = duplicate_primary.name if duplicate_primary != path else None
        if category == "payroll":
            recommended_use = duplicate_of is None
        else:
            recommended_use = preferred_by_category.get(category) == path and duplicate_of is None
        reason_parts: list[str] = []
        if duplicate_of:
            reason_parts.append(f"Duplicate of {duplicate_of}")
        elif category == "payroll":
            reason_parts.append("Use alongside other payroll year files for tax-cost transition import")
        elif preferred_by_category.get(category) != path:
            chosen = preferred_by_category.get(category)
            if chosen is not None:
                reason_parts.append(f"Superseded by preferred {category} file: {chosen.name}")
        else:
            reason_parts.append(f"Use for {category} transition import")
        out.append(
            FreshBooksInboxFileOut(
                name=path.name,
                path=str(path),
                category=category,
                size_bytes=int(stat.st_size),
                modified_at=datetime.fromtimestamp(stat.st_mtime),
                sha1_prefix=digest[:12],
                duplicate_of=duplicate_of,
                recommended_use=recommended_use,
                reason="; ".join(reason_parts),
            )
        )

    return FreshBooksInboxOut(root_path=str(root), exists=True, file_count=len(out), files=out)


def _freshbooks_inbox_recommended_paths() -> tuple[Path, dict[str, list[Path]]]:
    root = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
    inbox = _freshbooks_inbox_files()
    recommended: dict[str, list[Path]] = defaultdict(list)
    for file in inbox.files:
        if not file.recommended_use:
            continue
        recommended[file.category].append(Path(file.path))
    return root, recommended


def _freshbooks_inbox_find_exact(name: str) -> Path | None:
    root = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
    candidate = root / name
    return candidate if candidate.exists() and candidate.is_file() else None


def _freshbooks_upload_from_path(path: Path) -> UploadFile:
    return UploadFile(filename=path.name, file=io.BytesIO(path.read_bytes()))


def _normalize_person_name(raw: str | None) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if "@" in value:
        return value.split("@", 1)[0].replace(".", " ").replace("_", " ").title()
    parts = [part for part in re.split(r"\s+", value) if part]
    return " ".join(part.capitalize() for part in parts)


def _is_internal_project_or_client(project_name: str | None, client_name: str | None) -> bool:
    combined = " ".join([str(project_name or ""), str(client_name or "")]).strip().lower()
    internal_markers = [
        "aquatech engineering",
        "internal",
        "operations",
        "business development",
        "administration",
        "overhead",
    ]
    return any(marker in combined for marker in internal_markers)


def _expense_group_for_import(parent_category: str | None, subcategory: str | None, description: str | None) -> str:
    combined = " ".join([str(parent_category or ""), str(subcategory or ""), str(description or "")]).strip().lower()
    if "cost of goods sold" in combined or "subconsult" in combined or "materials" in combined:
        return "COGS"
    if "owner draw" in combined or "loan" in combined or "transfer" in combined:
        return "Other"
    return "OH"


def _ensure_project_stub(
    db: Session,
    *,
    project_name: str,
    client_name: str | None,
    current_user: User,
) -> Project:
    clean_project_name = (project_name or "").strip() or "Imported Project"
    clean_client_name = _normalize_import_client_name(client_name or "Imported Client")
    project = db.scalar(select(Project).where(func.lower(Project.name) == clean_project_name.lower()))
    if not project:
        is_internal = _is_internal_project_or_client(clean_project_name, clean_client_name)
        project = Project(
            name=clean_project_name,
            client_name=clean_client_name,
            pm_user_id=current_user.id,
            is_overhead=is_internal,
            is_billable=not is_internal,
            is_active=True,
        )
        db.add(project)
        db.flush()
    else:
        if (not project.client_name or project.client_name.lower() in {"imported client", "unassigned client"}) and clean_client_name:
            project.client_name = clean_client_name
        if _is_internal_project_or_client(clean_project_name, clean_client_name):
            project.is_overhead = True
            project.is_billable = False
    return project


def _ensure_timesheets_approved_for_range(
    db: Session,
    *,
    current_user: User,
    start: date,
    end: date,
) -> dict[str, int]:
    entries = db.scalars(
        select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    ).all()
    wanted_pairs = {(int(entry.user_id), _week_start(entry.work_date)) for entry in entries}
    created = 0
    updated = 0
    now = datetime.utcnow()
    for user_id, week_start in sorted(wanted_pairs, key=lambda value: (value[0], value[1])):
        week_end = week_start + timedelta(days=6)
        sheet = db.scalar(select(Timesheet).where(and_(Timesheet.user_id == user_id, Timesheet.week_start == week_start)))
        if not sheet:
            sheet = Timesheet(
                user_id=user_id,
                week_start=week_start,
                week_end=week_end,
                status="approved",
                employee_signed_at=now,
                supervisor_signed_at=now,
                approved_by_user_id=current_user.id,
            )
            db.add(sheet)
            created += 1
            continue
        if str(sheet.status or "").strip().lower() != "approved":
            sheet.status = "approved"
            sheet.employee_signed_at = sheet.employee_signed_at or now
            sheet.supervisor_signed_at = now
            sheet.approved_by_user_id = current_user.id
            updated += 1
    return {"created": created, "updated": updated, "weeks_found": len(wanted_pairs)}


async def _import_freshbooks_expenses_to_bank(
    *,
    path: Path,
    apply: bool,
    db: Session,
    current_user: User,
) -> dict[str, object]:
    text = path.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    out_buffer = io.StringIO()
    fieldnames = [
        "date",
        "description",
        "amount",
        "account",
        "transaction_id",
        "merchant_key",
        "category",
        "final_category",
        "expense_group",
        "category_source",
        "source_file",
        "currency",
        "notes",
    ]
    writer = csv.DictWriter(out_buffer, fieldnames=fieldnames)
    writer.writeheader()
    rows_total = 0
    rows_prepared = 0
    for idx, row in enumerate(reader, start=2):
        rows_total += 1
        posted_date = _parse_flexible_date(str(row.get("Date") or "").strip())
        amount = _parse_float(str(row.get("Amount") or "").strip())
        if posted_date is None or amount is None or abs(float(amount)) <= 0.0001:
            continue
        parent_category = str(row.get("Parent Category") or "").strip()
        subcategory = str(row.get("Subcategory") or row.get("Account Sub Type") or "").strip()
        merchant = str(row.get("Merchant") or "").strip()
        description = str(row.get("Description") or "").strip()
        notes = str(row.get("Client") or "").strip()
        # Stable hash — exclude filename + row index so re-imports of newer FB
        # exports don't create duplicate rows for the same logical expense.
        transaction_id = hashlib.sha256(
            f"fb|{posted_date.isoformat()}|{amount:.2f}|{merchant}|{description}".encode("utf-8")
        ).hexdigest()[:40]
        writer.writerow(
            {
                "date": posted_date.isoformat(),
                "description": " | ".join(part for part in [merchant, description] if part),
                "amount": f"{abs(float(amount)):.2f}",
                "account": parent_category or "FreshBooks Expenses",
                "transaction_id": transaction_id,
                "merchant_key": merchant,
                "category": subcategory or parent_category or "Uncategorized",
                "final_category": subcategory or parent_category or "Uncategorized",
                "expense_group": _expense_group_for_import(parent_category, subcategory, description),
                "category_source": "freshbooks",
                "source_file": path.name,
                "currency": str(row.get("Currency") or "USD").strip() or "USD",
                "notes": notes,
            }
        )
        rows_prepared += 1

    if not apply:
        return {
            "ok": True,
            "connection_name": "FreshBooks Expenses",
            "accounts_created": 0,
            "transactions_created": rows_prepared,
            "transactions_updated": 0,
            "rows_total": rows_prepared,
            "rows_skipped": rows_total - rows_prepared,
            "rows_prepared": rows_prepared,
            "rows_total_source": rows_total,
        }

    result = await import_expense_cat_categorized_csv(
        file=UploadFile(filename=path.name, file=io.BytesIO(out_buffer.getvalue().encode("utf-8"))),
        connection_name="FreshBooks Expenses",
        default_is_business=True,
        db=db,
        current_user=current_user,
    )
    payload = result.model_dump()
    payload["rows_prepared"] = rows_prepared
    payload["rows_total_source"] = rows_total
    return payload


def _import_freshbooks_project_expenses(
    *,
    path: Path,
    apply: bool,
    db: Session,
    current_user: User,
) -> dict[str, object]:
    text = path.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    imported = 0
    skipped = 0
    for row in reader:
        project_name = str(row.get("Project") or "").strip()
        client_name = str(row.get("Client") or "").strip()
        if not project_name and not client_name:
            skipped += 1
            continue
        expense_date = _parse_flexible_date(str(row.get("Date") or "").strip())
        amount = _parse_float(str(row.get("Amount") or "").strip())
        if expense_date is None or amount is None or abs(float(amount)) <= 0.0001:
            skipped += 1
            continue
        project = _ensure_project_stub(
            db,
            project_name=project_name or client_name or "Imported Project",
            client_name=client_name or "Imported Client",
            current_user=current_user,
        )
        category = str(row.get("Subcategory") or row.get("Parent Category") or "General").strip() or "General"
        description = str(row.get("Description") or row.get("Merchant") or "").strip()
        existing = db.scalar(
            select(ProjectExpense).where(
                and_(
                    ProjectExpense.project_id == project.id,
                    ProjectExpense.expense_date == expense_date,
                    ProjectExpense.category == category,
                    ProjectExpense.description == description,
                    ProjectExpense.amount == float(amount),
                )
            )
        )
        if existing:
            skipped += 1
            continue
        if apply:
            db.add(
                ProjectExpense(
                    project_id=project.id,
                    expense_date=expense_date,
                    category=category,
                    description=description,
                    amount=float(amount),
                )
            )
        imported += 1
    if apply:
        db.flush()
    return {"imported": imported, "skipped": skipped, "errors": 0}


async def _import_freshbooks_payroll_to_bank(
    *,
    paths: list[Path],
    apply: bool,
    db: Session,
    current_user: User,
) -> dict[str, object]:
    out_buffer = io.StringIO()
    fieldnames = [
        "date",
        "description",
        "amount",
        "account",
        "transaction_id",
        "merchant_key",
        "category",
        "final_category",
        "expense_group",
        "category_source",
        "source_file",
        "currency",
        "notes",
    ]
    writer = csv.DictWriter(out_buffer, fieldnames=fieldnames)
    writer.writeheader()
    rows_total = 0
    rows_prepared = 0
    users_touched: set[str] = set()
    seen_transaction_ids: set[str] = set()

    for path in paths:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.reader(handle))
        current_pay_day: date | None = None
        header: list[str] | None = None
        for row in rows:
            if len(row) >= 2 and str(row[0]).strip() == "Pay day":
                current_pay_day = _parse_flexible_date(str(row[1]).strip())
                header = None
                continue
            if row and row[0] == "Last Name":
                header = row
                continue
            if not header or current_pay_day is None or not row or len(row) != len(header):
                continue
            record = dict(zip(header, row))
            last_name = str(record.get("Last Name") or "").strip()
            first_name = str(record.get("First Name") or "").strip()
            if not last_name or last_name.lower() in {"totals", "payroll totals"}:
                continue
            employer_cost = _parse_float(str(record.get("Employer Cost") or "").strip())
            gross_earnings = _parse_float(str(record.get("Gross Earnings") or "").strip())
            if employer_cost is None or employer_cost <= 0:
                continue
            full_name = " ".join(part for part in [first_name, last_name] if part).strip()
            users_touched.add(full_name)
            email = _resolve_import_email(db, full_name)
            user = db.scalar(select(User).where(func.lower(User.email) == email.lower()))
            if not user:
                user = User(email=email, full_name=full_name or email.split("@")[0], role="employee", is_active=True)
                if apply:
                    db.add(user)
                    db.flush()
            elif full_name and user.full_name != full_name:
                user.full_name = full_name
                user.is_active = True

            transaction_id = hashlib.sha256(
                f"{path.name}|{current_pay_day.isoformat()}|{'|'.join(row)}".encode("utf-8")
            ).hexdigest()[:40]
            if transaction_id in seen_transaction_ids:
                continue
            seen_transaction_ids.add(transaction_id)
            writer.writerow(
                {
                    "date": current_pay_day.isoformat(),
                    "description": f"Payroll | {full_name}",
                    "amount": f"{float(employer_cost):.2f}",
                    "account": "Payroll",
                    "transaction_id": transaction_id,
                    "merchant_key": full_name,
                    "category": "Payroll Taxes And Processing",
                    "final_category": "Payroll Taxes And Processing",
                    "expense_group": "OH",
                    "category_source": "freshbooks_payroll",
                    "source_file": path.name,
                    "currency": "USD",
                    "notes": f"Gross earnings {float(gross_earnings or 0.0):.2f}",
                }
            )
            rows_total += 1
            rows_prepared += 1

    if not apply:
        return {
            "ok": True,
            "connection_name": "FreshBooks Payroll",
            "accounts_created": 0,
            "transactions_created": rows_prepared,
            "transactions_updated": 0,
            "rows_total": rows_prepared,
            "rows_skipped": 0,
            "rows_prepared": rows_prepared,
            "rows_total_source": rows_total,
            "users_touched": len(users_touched),
        }

    result = await import_expense_cat_categorized_csv(
        file=UploadFile(filename="freshbooks_payroll_import.csv", file=io.BytesIO(out_buffer.getvalue().encode("utf-8"))),
        connection_name="FreshBooks Payroll",
        default_is_business=True,
        db=db,
        current_user=current_user,
    )
    payload = result.model_dump()
    payload["rows_prepared"] = rows_prepared
    payload["rows_total_source"] = rows_total
    payload["users_touched"] = len(users_touched)
    return payload


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


PROJECT_LIFECYCLE_STATUSES = ["planning", "active", "paused", "completed", "cancelled"]


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
    lifecycle_status: str = "active"
    completed_date: date | None = None


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


class ProjectStatusUpdate(BaseModel):
    lifecycle_status: str = Field(min_length=1, max_length=32)
    completed_date: date | None = None


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


LOAN_TYPES = ["term_loan", "line_of_credit", "credit_card", "owner_loan", "sba", "other"]
LOAN_FREQUENCIES = ["monthly", "weekly", "biweekly", "quarterly", "irregular"]


class LoanCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    lender: str = Field(default="", max_length=255)
    loan_type: str = Field(default="term_loan")
    account_last4: str | None = Field(default=None, max_length=16)
    principal_original: float = Field(default=0.0, ge=0)
    principal_current: float = Field(default=0.0, ge=0)
    interest_rate_apr: float = Field(default=0.0, ge=0, le=100)
    payment_amount: float = Field(default=0.0, ge=0)
    payment_frequency: str = Field(default="monthly")
    origination_date: date | None = None
    maturity_date: date | None = None
    description_match: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=2000)
    is_active: bool = True


class LoanUpdate(LoanCreate):
    pass


class LoanOut(BaseModel):
    id: int
    name: str
    lender: str
    loan_type: str
    account_last4: str | None
    principal_original: float
    principal_current: float
    interest_rate_apr: float
    payment_amount: float
    payment_frequency: str
    origination_date: date | None
    maturity_date: date | None
    description_match: str
    notes: str
    is_active: bool
    payments_count: int = 0
    payments_total: float = 0.0
    interest_total: float = 0.0
    principal_total: float = 0.0


class LoanPaymentCreate(BaseModel):
    payment_date: date
    total_amount: float = Field(ge=0)
    principal_amount: float = Field(default=0.0, ge=0)
    interest_amount: float = Field(default=0.0, ge=0)
    fees_amount: float = Field(default=0.0, ge=0)
    bank_transaction_id: int | None = None
    notes: str = Field(default="", max_length=2000)


class LoanPaymentOut(BaseModel):
    id: int
    loan_id: int
    payment_date: date
    total_amount: float
    principal_amount: float
    interest_amount: float
    fees_amount: float
    bank_transaction_id: int | None
    notes: str


PROJECT_MEMBER_ROLES = ["Lead", "PM", "Engineer", "QA/QC", "Reviewer", "Admin Support", "Other"]


class ProjectMemberCreate(BaseModel):
    user_id: int
    role: str = Field(default="Engineer", min_length=1, max_length=64)
    allocation_pct: float = Field(default=0.0, ge=0, le=100)
    start_date: date | None = None
    end_date: date | None = None
    notes: str = Field(default="", max_length=2000)


class ProjectMemberUpdate(BaseModel):
    role: str = Field(default="Engineer", min_length=1, max_length=64)
    allocation_pct: float = Field(default=0.0, ge=0, le=100)
    start_date: date | None = None
    end_date: date | None = None
    notes: str = Field(default="", max_length=2000)


class ProjectMemberOut(BaseModel):
    id: int
    project_id: int
    user_id: int
    user_name: str
    user_email: str
    role: str
    allocation_pct: float
    start_date: date | None
    end_date: date | None
    notes: str


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
    id: int | None
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
    has_record: bool = True


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


class FreshBooksInboxFileOut(BaseModel):
    name: str
    path: str
    category: str
    size_bytes: int
    modified_at: datetime
    sha1_prefix: str
    duplicate_of: str | None = None
    recommended_use: bool = True
    reason: str = ""


class FreshBooksInboxOut(BaseModel):
    root_path: str
    exists: bool
    file_count: int
    files: list[FreshBooksInboxFileOut]


class FreshBooksTransitionStepOut(BaseModel):
    step: str
    ok: bool = True
    used_files: list[str] = Field(default_factory=list)
    imported: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    detail: dict[str, object] = Field(default_factory=dict)


class FreshBooksTransitionRunOut(BaseModel):
    apply: bool
    root_path: str
    steps: list[FreshBooksTransitionStepOut]
    totals: dict[str, int]


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
    aliases: list[str] = Field(default_factory=lambda: ["Imported Client", "Historical Legacy Client", "Unmapped Imported Work"])


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


class LegacyPaymentImportRowOut(BaseModel):
    row_number: int
    invoice_number: str
    payment_date: str | None
    amount: float | None
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
# --- Consulting chart of accounts (APPROVED 2026-06-12) -----------------------
# Maps every expense category (existing labels + new finer ones) to:
#   section: "COGS" (cost of delivering services = all labor + burden + direct
#            project costs), "INDIRECT" (operating overhead), or "OTHER" (below
#            the operating line — excluded from gross/net margin).
#   group:   the P&L rollup parent. INDIRECT rolls up under Admin / Marketing / BD.
# Firm rule: ALL labor (wages + employer taxes + retirement/401k + benefits) = COGS.
# Used by the P&L to roll up Revenue - COGS = Gross Profit; - Indirect = Net Income.
CHART_OF_ACCOUNTS: dict[str, tuple[str, str]] = {
    # COGS — cost of delivering work
    "Labor": ("COGS", "Direct Labor"),
    "Direct Labor": ("COGS", "Direct Labor"),
    "Payroll Taxes And Processing": ("COGS", "Labor Burden"),
    "Employer Payroll Taxes": ("COGS", "Labor Burden"),
    "Retirement / 401(k)": ("COGS", "Labor Burden"),
    "Benefits & Health": ("COGS", "Labor Burden"),
    "Workers' Comp": ("COGS", "Labor Burden"),
    "Subconsultants": ("COGS", "Direct Project Costs"),
    "Materials": ("COGS", "Direct Project Costs"),
    "Field Services": ("COGS", "Direct Project Costs"),
    "Permits And Fees": ("COGS", "Direct Project Costs"),
    "Equipment Rental": ("COGS", "Direct Project Costs"),
    "Reimbursables": ("COGS", "Direct Project Costs"),
    # INDIRECT — Admin / G&A
    "Rent": ("INDIRECT", "Admin / G&A"),
    "Utilities": ("INDIRECT", "Admin / G&A"),
    "Rent & Utilities": ("INDIRECT", "Admin / G&A"),
    "Software And Subscriptions": ("INDIRECT", "Admin / G&A"),
    "Software & Subscriptions": ("INDIRECT", "Admin / G&A"),
    "Insurance": ("INDIRECT", "Admin / G&A"),
    "Telecom & Internet": ("INDIRECT", "Admin / G&A"),
    "Office Supplies": ("INDIRECT", "Admin / G&A"),
    "Office & Postage": ("INDIRECT", "Admin / G&A"),
    "Professional Services": ("INDIRECT", "Admin / G&A"),
    "Bank Fees": ("INDIRECT", "Admin / G&A"),
    "Bank & Merchant Fees": ("INDIRECT", "Admin / G&A"),
    "Dues, Licenses & Education": ("INDIRECT", "Admin / G&A"),
    "Computer Hardware & Equipment": ("INDIRECT", "Admin / G&A"),
    # INDIRECT — Marketing
    "Marketing & Advertising": ("INDIRECT", "Marketing"),
    "Advertising": ("INDIRECT", "Marketing"),
    "Website": ("INDIRECT", "Marketing"),
    "Marketing Materials": ("INDIRECT", "Marketing"),
    # INDIRECT — Business Development
    "Travel": ("INDIRECT", "Business Development"),
    "BD Travel": ("INDIRECT", "Business Development"),
    "Meals": ("INDIRECT", "Business Development"),
    "Client Meals": ("INDIRECT", "Business Development"),
    "Conferences & Events": ("INDIRECT", "Business Development"),
    "Memberships": ("INDIRECT", "Business Development"),
    # Exact labels emitted by the keyword classifier (_OPEX_BUCKET_RULES) — keep in sync
    "Travel & Transport": ("INDIRECT", "Business Development"),
    "Meals & Entertainment": ("INDIRECT", "Business Development"),
    "Office Supplies & Postage": ("INDIRECT", "Admin / G&A"),
    "Computer Hardware & Equipment ": ("INDIRECT", "Admin / G&A"),
    "Dues, Licenses & Education": ("INDIRECT", "Admin / G&A"),
    "Marketing & Advertising": ("INDIRECT", "Marketing"),
    "Other / Uncategorized": ("INDIRECT", "⚠ Needs review (manual)"),
    "⚠ Needs review (manual)": ("INDIRECT", "⚠ Needs review (manual)"),
    # OTHER — below the operating line (excluded from margin)
    "Interest Expense": ("OTHER", "Interest"),
    "Taxes": ("OTHER", "Income Taxes"),
    "Loan Payment": ("OTHER", "Financing"),
    "Loan Principal": ("OTHER", "Financing"),
    "Transfer": ("OTHER", "Transfer"),
    "Equity Transfer In/Out (...6611 / ...0273)": ("OTHER", "Transfer"),
    "Owner Draw": ("OTHER", "Owner Draw"),
    "Uncategorized": ("OTHER", "Uncategorized"),
}
# Ordered display structure for the P&L / categorization UI.
COA_INDIRECT_GROUPS = ["Admin / G&A", "Marketing", "Business Development"]
COA_COGS_GROUPS = ["Direct Labor", "Labor Burden", "Direct Project Costs"]


def coa_section(category: str | None) -> tuple[str, str]:
    """Map a stored expense category to (section, rollup_group). Unknown business
    categories default to a visible review bucket, never silently into a real line."""
    if not category:
        return ("OTHER", "Uncategorized")
    return CHART_OF_ACCOUNTS.get(category.strip(), ("INDIRECT", "⚠ Needs review (manual)"))


DATE_COLUMNS = ["Date", "Posted Date", "Posting Date", "Transaction Date"]
DESC_COLUMNS = ["Description", "Transaction Description", "Memo", "Details", "Payee", "Name"]
AMOUNT_COLUMNS = ["Amount"]
DEBIT_COLUMNS = ["Debit", "Withdrawal", "Charge"]
CREDIT_COLUMNS = ["Credit", "Deposit", "Payment"]
TIME_DATE_COLUMNS = ["Date", "Entry Date", "Logged Date", "Start Date", "Date of Service"]
TIME_EMPLOYEE_COLUMNS = ["Team Member", "Team member", "Staff", "Employee", "User", "Email", "Team Member Email"]
TIME_CLIENT_COLUMNS = ["Client", "Client Name", "Customer", "Organization"]
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
INVOICE_ISSUE_DATE_COLUMNS = ["Date Issued", "Invoice Date", "Issued Date", "Issue Date", "Date"]
INVOICE_DUE_DATE_COLUMNS = ["Date Due", "Due Date", "Due"]
INVOICE_STATUS_COLUMNS = ["Status", "Invoice Status", "Payment Status"]
INVOICE_TOTAL_COLUMNS = ["Total", "Amount", "Invoice Total", "Total Amount", "Grand Total"]
INVOICE_LINE_TOTAL_COLUMNS = ["Line Total", "Line Subtotal"]
INVOICE_PAID_COLUMNS = ["Paid", "Amount Paid", "Payments", "Paid Amount"]
INVOICE_BALANCE_COLUMNS = ["Balance", "Balance Due", "Amount Due", "Due Amount"]
PAYMENT_DATE_COLUMNS = ["Date", "Payment Date", "Received Date"]
PAYMENT_INVOICE_NO_COLUMNS = ["Number", "Invoice #", "Invoice Number", "Payment for"]
PAYMENT_AMOUNT_COLUMNS = ["Amount", "Payment Amount", "Paid Amount"]
APPROVED_STATUS_VALUES = {"approved", "yes", "true", "1", "locked", "billed", "closed"}
COMPLETED_TIMESHEET_STATUS_VALUES = {"submitted", "approved", "locked", "billed", "closed"}
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
    _start_fb_time_sync_worker()


_fb_time_sync_scheduler = None  # type: ignore[var-annotated]


def _start_fb_time_sync_worker() -> None:
    """Pull FreshBooks time entries every 10 minutes so timesheets stay fresh.

    No-ops gracefully if FreshBooks isn't connected. Errors are swallowed (logged
    via print) so a transient FB outage doesn't kill the scheduler thread.
    """
    global _fb_time_sync_scheduler
    if _fb_time_sync_scheduler is not None:
        return
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        print("[fb_time_sync] apscheduler not installed — auto-sync disabled")
        return

    def _tick() -> None:
        from . import freshbooks as fb_mod
        try:
            with SessionLocal() as db:
                tok = fb_mod.load_token(db)
                if tok is None or not tok.account_id or not tok.business_id:
                    return  # FB not connected; quiet no-op
                result = fb_mod.sync_time_only(db)
                te = result.get("time_entries", {})
                outcomes = te.get("by_outcome") if isinstance(te, dict) else None
                print(f"[fb_time_sync] tick: time_entries by_outcome={outcomes}", flush=True)
        except Exception as exc:  # noqa: BLE001 — scheduler thread must not die
            print(f"[fb_time_sync] tick failed: {exc!r}", flush=True)

    sched = BackgroundScheduler(daemon=True)
    sched.add_job(_tick, "interval", minutes=10, id="fb_time_sync", coalesce=True, max_instances=1,
                  next_run_time=datetime.utcnow() + timedelta(seconds=30))
    sched.start()
    _fb_time_sync_scheduler = sched
    print("[fb_time_sync] scheduler started — interval 10 min, first tick in 30s", flush=True)


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
    return {"ok": True, "app": "aqtpm", "users": user_count}


@app.get("/health")
def healthcheck(db: Session = Depends(get_db)) -> dict[str, object]:
    user_count = db.scalar(select(func.count(User.id))) or 0
    return {"ok": True, "app": "aqtpm", "users": user_count}


@app.get("/transition/freshbooks/inbox", response_model=FreshBooksInboxOut)
def freshbooks_transition_inbox(
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> FreshBooksInboxOut:
    return _freshbooks_inbox_files()


@app.post("/transition/freshbooks/import", response_model=FreshBooksTransitionRunOut)
async def freshbooks_transition_import(
    apply: bool = Query(default=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> FreshBooksTransitionRunOut:
    root, recommended = _freshbooks_inbox_recommended_paths()
    if not root.exists():
        raise HTTPException(status_code=404, detail="Configured FreshBooks inbox folder does not exist")

    steps: list[FreshBooksTransitionStepOut] = []

    clients_path = _freshbooks_inbox_find_exact("clients.csv")
    if clients_path:
        with clients_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            row_count = 0
            organizations = set()
            contacts = 0
            for row in reader:
                row_count += 1
                org = str(row.get("Organization") or "").strip()
                first_name = str(row.get("First Name") or "").strip()
                last_name = str(row.get("Last Name") or "").strip()
                if org:
                    organizations.add(_normalize_import_client_name(org))
                if first_name or last_name:
                    contacts += 1
            steps.append(
                FreshBooksTransitionStepOut(
                    step="clients_scan",
                    used_files=[clients_path.name],
                    imported=len(organizations),
                    detail={"rows": row_count, "organizations": len(organizations), "contacts": contacts},
                )
            )

    time_paths = recommended.get("time_entries", [])
    time_import_min: date | None = None
    time_import_max: date | None = None
    if time_paths:
        for path in time_paths:
            payload = await freshbooks_time_import(
                apply=apply,
                file=_freshbooks_upload_from_path(path),
                mapping_overrides=None,
                db=db,
                current_user=current_user,
            )
            min_date_raw = payload.get("min_imported_date")
            max_date_raw = payload.get("max_imported_date")
            if isinstance(min_date_raw, str) and min_date_raw:
                parsed = date.fromisoformat(min_date_raw)
                time_import_min = parsed if time_import_min is None else min(time_import_min, parsed)
            if isinstance(max_date_raw, str) and max_date_raw:
                parsed = date.fromisoformat(max_date_raw)
                time_import_max = parsed if time_import_max is None else max(time_import_max, parsed)
            steps.append(
                FreshBooksTransitionStepOut(
                    step="time_import",
                    used_files=[path.name],
                    imported=int(payload.get("imported", 0)),
                    skipped=int(payload.get("skipped", 0)),
                    errors=int(payload.get("errors", 0)),
                    detail={
                        "rows": int(payload.get("count", 0)),
                        "non_approved_skipped": int(payload.get("non_approved_skipped", 0)),
                        "min_imported_date": payload.get("min_imported_date"),
                        "max_imported_date": payload.get("max_imported_date"),
                    },
                )
            )

    if apply and time_import_min and time_import_max:
        timesheet_result = _ensure_timesheets_approved_for_range(
            db,
            current_user=current_user,
            start=time_import_min,
            end=time_import_max,
        )
        db.commit()
        steps.append(
            FreshBooksTransitionStepOut(
                step="timesheet_backfill",
                used_files=[],
                imported=int(timesheet_result["created"]),
                updated=int(timesheet_result["updated"]),
                detail=timesheet_result,
            )
        )

    invoice_paths = recommended.get("invoices", [])
    payments_paths = recommended.get("payments", [])
    if invoice_paths:
        primary_invoice = invoice_paths[0]
        payments_upload = _freshbooks_upload_from_path(payments_paths[0]) if payments_paths else None
        payload = await import_legacy_invoices(
            apply=apply,
            file=_freshbooks_upload_from_path(primary_invoice),
            payments_file=payments_upload,
            mapping_overrides=None,
            db=db,
            current_user=current_user,
        )
        steps.append(
            FreshBooksTransitionStepOut(
                step="invoice_import",
                used_files=[primary_invoice.name] + ([payments_paths[0].name] if payments_paths else []),
                imported=int(payload.get("imported", 0)),
                updated=int(payload.get("updated", 0)),
                skipped=int(payload.get("skipped", 0)),
                errors=int(payload.get("errors", 0)),
                detail={
                    "rows": int(payload.get("count", 0)),
                    "line_item_mode": bool(payload.get("line_item_mode", False)),
                    "payments_matched_invoices": int(payload.get("payments_matched_invoices", 0)),
                },
            )
        )

    expense_paths = recommended.get("expenses", [])
    if expense_paths:
        expense_payload = await _import_freshbooks_expenses_to_bank(
            path=expense_paths[0],
            apply=apply,
            db=db,
            current_user=current_user,
        )
        steps.append(
            FreshBooksTransitionStepOut(
                step="expense_import",
                used_files=[expense_paths[0].name],
                imported=int(expense_payload.get("transactions_created", 0)),
                updated=int(expense_payload.get("transactions_updated", 0)),
                skipped=int(expense_payload.get("rows_skipped", 0)),
                detail=expense_payload,
            )
        )

    expense_details_path = _freshbooks_inbox_find_exact("expense_details.csv")
    if expense_details_path:
        project_expense_payload = _import_freshbooks_project_expenses(
            path=expense_details_path,
            apply=apply,
            db=db,
            current_user=current_user,
        )
        if apply:
            db.commit()
        steps.append(
            FreshBooksTransitionStepOut(
                step="project_expense_import",
                used_files=[expense_details_path.name],
                imported=int(project_expense_payload.get("imported", 0)),
                skipped=int(project_expense_payload.get("skipped", 0)),
                errors=int(project_expense_payload.get("errors", 0)),
                detail=project_expense_payload,
            )
        )

    payroll_paths = recommended.get("payroll", [])
    if payroll_paths:
        payroll_payload = await _import_freshbooks_payroll_to_bank(
            paths=payroll_paths,
            apply=apply,
            db=db,
            current_user=current_user,
        )
        steps.append(
            FreshBooksTransitionStepOut(
                step="payroll_import",
                used_files=[path.name for path in payroll_paths],
                imported=int(payroll_payload.get("transactions_created", 0)),
                updated=int(payroll_payload.get("transactions_updated", 0)),
                skipped=int(payroll_payload.get("rows_skipped", 0)),
                detail=payroll_payload,
            )
        )

    report_files = []
    for category in ["profit_loss", "aging", "reports"]:
        report_files.extend(path.name for path in recommended.get(category, []))
    if report_files:
        steps.append(
            FreshBooksTransitionStepOut(
                step="reports_detected",
                used_files=report_files,
                imported=len(report_files),
                detail={"note": "Reference reports are available in the inbox for benchmarking and validation."},
            )
        )

    totals = {
        "imported": sum(step.imported for step in steps),
        "updated": sum(step.updated for step in steps),
        "skipped": sum(step.skipped for step in steps),
        "errors": sum(step.errors for step in steps),
    }
    if apply:
        _log_audit_event(
            db=db,
            entity_type="transition",
            entity_id=0,
            action="import_freshbooks_inbox",
            actor_user_id=current_user.id,
            payload={
                "root_path": str(root),
                "steps": [step.model_dump() for step in steps],
                "totals": totals,
            },
        )
        db.commit()

    return FreshBooksTransitionRunOut(
        apply=apply,
        root_path=str(root),
        steps=steps,
        totals=totals,
    )


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


# Categories that represent inter-account transfers / non-expense flows.
# These need CPA adjudication (loan vs distribution vs reimbursement vs contribution etc.)
# and are excluded from tax-summary totals.
TRANSFER_CATEGORY_KEYWORDS = (
    "transfer",
    "owner draw",
    "owner contribution",
    "loan payment",
    "due to",
    "due from",
    "shareholder",
    "internal",
    "equity",
    "investment",
)


def _is_transfer_category(category: str | None) -> bool:
    if not category:
        return False
    c = str(category).strip().lower()
    return any(kw in c for kw in TRANSFER_CATEGORY_KEYWORDS)


def _parse_gusto_payroll_journal(text: str) -> dict[str, object]:
    """Parse a Gusto 'Payroll Journal Report' CSV into structured data.

    The CSV has a multi-section layout:
      - Header rows (title, company, address)
      - 'Per Employee Summary' block: one row per employee with annual totals
      - Repeated 'Employee Earnings' blocks per pay period:
          - 'Payroll period', 'Pay day' lines
          - Header row, then employee rows, then 'Payroll Totals'

    All money columns are summed under treatment="COGS" for an engineering
    consulting business (employees are the product; their full loaded cost is COGS).
    """
    rows = list(csv.reader(io.StringIO(text)))
    # Identify the canonical column header (the row beginning with "Last Name","First Name",...)
    header: list[str] | None = None
    for row in rows:
        if len(row) > 5 and row[0].strip() == "Last Name" and row[1].strip() == "First Name":
            header = [c.strip() for c in row]
            break
    if header is None:
        return {"periods": [], "employees": {}, "totals": {}, "error": "Could not find header row"}

    # Indexes we care about
    def idx(*candidates: str) -> int:
        for c in candidates:
            if c in header:
                return header.index(c)
        return -1

    i_last = idx("Last Name")
    i_first = idx("First Name")
    i_hours = idx("Regular (Hours)")
    i_gross = idx("Gross Earnings")
    i_employee_taxes = idx("Employee Taxes")
    i_employer_taxes = idx("Employer Taxes")
    i_401k_co = idx("Human Interest Traditional 401(k) (Company Contribution)")
    i_net = idx("Net Pay")
    i_check = idx("Check Amount")
    i_employer_cost = idx("Employer Cost")

    def fnum(s: str) -> float:
        try:
            v = (s or "").strip().replace(",", "").replace("$", "")
            return float(v) if v else 0.0
        except ValueError:
            return 0.0

    periods: list[dict[str, object]] = []
    cur_period: dict[str, object] | None = None
    employees: dict[str, dict[str, float]] = {}
    in_per_employee_summary = False
    seen_first_header = False

    for row in rows:
        if not row:
            continue
        first = (row[0] or "").strip() if row else ""
        if first == "Per Employee Summary by Employee" or first.startswith("Per Employee Summary"):
            in_per_employee_summary = True
            continue
        if first == "Employee Earnings":
            in_per_employee_summary = False
            continue
        if first == "Payroll period" and len(row) > 1:
            # Push previous period
            if cur_period:
                periods.append(cur_period)
            cur_period = {
                "period": (row[1] or "").strip(),
                "pay_day": "",
                "rows": [],
                "totals": {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0},
            }
            continue
        if first == "Pay day" and len(row) > 1 and cur_period:
            cur_period["pay_day"] = (row[1] or "").strip()
            continue
        if first in {"Last Name"}:
            seen_first_header = True
            continue
        # Data row?
        if not seen_first_header:
            continue
        last = (row[i_last] if i_last >= 0 and i_last < len(row) else "").strip()
        if not last:
            continue
        # Skip totals rows (we re-compute)
        if last in {"Totals", "Payroll Totals"}:
            continue
        first_name = (row[i_first] if i_first >= 0 and i_first < len(row) else "").strip()
        emp_key = f"{last}, {first_name}".strip(", ")
        gross = fnum(row[i_gross]) if i_gross >= 0 and i_gross < len(row) else 0.0
        employer_taxes = fnum(row[i_employer_taxes]) if i_employer_taxes >= 0 and i_employer_taxes < len(row) else 0.0
        co_401k = fnum(row[i_401k_co]) if i_401k_co >= 0 and i_401k_co < len(row) else 0.0
        net_pay = fnum(row[i_net]) if i_net >= 0 and i_net < len(row) else 0.0
        check_amt = fnum(row[i_check]) if i_check >= 0 and i_check < len(row) else 0.0
        employer_cost = fnum(row[i_employer_cost]) if i_employer_cost >= 0 and i_employer_cost < len(row) else 0.0
        hours = fnum(row[i_hours]) if i_hours >= 0 and i_hours < len(row) else 0.0

        if in_per_employee_summary:
            ents = employees.setdefault(emp_key, {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0, "periods": 0})
            ents["gross"] = gross
            ents["employer_taxes"] = employer_taxes
            ents["employer_401k"] = co_401k
            ents["employer_cost"] = employer_cost
            ents["net_pay"] = net_pay
            ents["hours"] = hours
        else:
            if cur_period is None:
                continue
            cur_period["rows"].append(
                {
                    "employee": emp_key,
                    "hours": hours,
                    "gross": gross,
                    "employer_taxes": employer_taxes,
                    "employer_401k": co_401k,
                    "net_pay": net_pay,
                    "check_amount": check_amt,
                    "employer_cost": employer_cost,
                }
            )
            t = cur_period["totals"]
            t["gross"] += gross
            t["employer_taxes"] += employer_taxes
            t["employer_401k"] += co_401k
            t["employer_cost"] += employer_cost
            t["net_pay"] += net_pay
            t["hours"] += hours

    if cur_period:
        periods.append(cur_period)

    # YTD totals
    ytd = {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0, "period_count": len(periods)}
    for p in periods:
        for k in ("gross", "employer_taxes", "employer_401k", "employer_cost", "net_pay", "hours"):
            ytd[k] += p["totals"][k]

    return {"periods": periods, "employees": employees, "totals": ytd}


_PAYCHEX_EARNING_TYPES = {
    "Regular", "Hourly", "Overtime", "Salary", "Bonus", "Holiday",
    "Vacation", "Sick", "PTO", "Commission", "Double Time",
}
_PAYCHEX_MERGED_NUM = re.compile(r"^\s*([\d,]+\.\d{2})")


def _parse_paychex_payroll_journal(data: bytes) -> dict[str, object]:
    """Parse a Paychex 'Payroll Journal' PDF into the same structured shape as
    :func:`_parse_gusto_payroll_journal` so the accounting layer treats both
    payroll sources identically.

    Paychex reports the employer payroll-tax burden only at the COMPANY TOTALS
    level (``TOTAL EMPLOYER LIABILITY``), not per employee, so per-employee
    employer taxes are allocated pro-rata by gross earnings. Employer 401(k)
    match (``401k ER``) and gross/net/hours ARE per-employee.

    For an engineering consulting business the full Employer Cost
    (gross + employer taxes + employer 401(k)) is COGS — same treatment as Gusto.

    Returns ``{"periods": [...], "employees": {...}, "totals": {...}}``. On a
    non-Paychex/unparseable PDF returns empty collections with an ``error`` key
    (never raises) so callers can skip the file gracefully.
    """
    try:
        import fitz  # PyMuPDF — pypdf returns empty text on these (malformed) PDFs
    except Exception as exc:  # pragma: no cover - dependency guard
        return {"periods": [], "employees": {}, "totals": {}, "error": f"PyMuPDF unavailable: {exc}"}

    def _num(s: str) -> float | None:
        s = (s or "").strip().replace(",", "").replace("$", "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None

    try:
        doc = fitz.open(stream=data, filetype="pdf")
        lines: list[str] = []
        for page in doc:
            for ln in page.get_text().splitlines():
                lines.append(ln.rstrip())
    except Exception as exc:
        return {"periods": [], "employees": {}, "totals": {}, "error": f"PDF read failed: {exc}"}

    blob = "\n".join(lines).upper()
    if "PAYROLL JOURNAL" not in blob or "PYRJRN" not in blob:
        return {"periods": [], "employees": {}, "totals": {}, "error": "not a Paychex Payroll Journal"}

    periods: list[dict] = []
    by_period: dict[str, dict] = {}
    cur: dict | None = None
    in_company = False
    pending_name: str | None = None

    def newp(key: str) -> dict:
        p = {
            "period": key, "pay_day": "", "rows": [],
            "totals": {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0,
                       "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0},
        }
        by_period[key] = p
        periods.append(p)
        return p

    i, n = 0, len(lines)
    while i < n:
        ln = lines[i].strip()

        if ln == "Period Start - End Date":
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            key = lines[j].strip() if j < n else ""
            if key:
                cur = by_period.get(key) or newp(key)
                in_company = False
            i = j + 1
            continue

        if ln == "Check Date":
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            val = lines[j].strip() if j < n else ""
            # The first Check Date after a period header is the real one. Multi-period
            # reports append a forward-looking TIMESHEET section carrying the NEXT
            # period's check date *before* the next period header, so honour only the
            # first value per period (never overwrite) to avoid an off-by-one shift
            # that would push each run's pay-date a cycle into the future.
            if cur is not None and val and not cur["pay_day"] and re.match(r"\d{2}/\d{2}/\d{2,4}", val):
                cur["pay_day"] = val
            i = j + 1
            continue

        if ln.startswith("COMPANY TOTAL"):
            in_company = True
            pending_name = None

        if in_company and ln.startswith("TOTAL EMPLOYER LIABILITY") and cur is not None:
            m = re.search(r"([\d,]+\.\d{2})", ln)
            if m:
                cur["totals"]["employer_taxes"] = _num(m.group(1)) or 0.0
            else:
                j = i + 1
                while j < n and not lines[j].strip():
                    j += 1
                cur["totals"]["employer_taxes"] = (_num(lines[j]) or 0.0) if j < n else 0.0

        if ln == "401k ER" and cur is not None:
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            val = _num(lines[j]) if j < n else None
            if val is not None:
                if in_company:
                    cur["totals"]["employer_401k"] = val
                elif cur["rows"]:
                    cur["rows"][-1]["employer_401k"] = val
            i = j + 1
            continue

        # Employee name = the line immediately before an earning-type line
        if not in_company and i + 1 < n and lines[i + 1].strip() in _PAYCHEX_EARNING_TYPES:
            if ln and "EMPLOYEE TOTAL" not in ln and "COMPANY" not in ln:
                pending_name = ln

        if ln.endswith("EMPLOYEE TOTAL") and cur is not None and not in_company:
            # Consume EXACTLY 5 values: hours, earnings, withholdings, deductions, net.
            # (Compact report variants put the next employee's name right after the
            # net line — over-reading would skip that employee.)
            seq: list[str] = []
            j = i + 1
            while j < n and len(seq) < 5:
                raw = lines[j].strip()
                if raw == "":
                    j += 1
                    continue
                seq.append(raw)
                j += 1
            hours = _num(seq[0]) if len(seq) > 0 else 0.0
            gross = _num(seq[1]) if len(seq) > 1 else 0.0
            withh = _num(seq[2]) if len(seq) > 2 else 0.0
            ded = None
            net = None
            if len(seq) > 3:
                m = _PAYCHEX_MERGED_NUM.match(seq[3])
                ded = _num(m.group(1)) if m else _num(seq[3])
            if len(seq) > 4:
                net = _num(seq[4])
            cur["rows"].append({
                "employee": (pending_name or "?").strip(),
                "hours": hours or 0.0, "gross": gross or 0.0,
                "withholdings": withh or 0.0, "deductions": ded or 0.0,
                "net_pay": net or 0.0, "employer_401k": 0.0,
                "employer_taxes": 0.0, "employer_cost": 0.0,
            })
            pending_name = None
            i = j
            continue

        if in_company and ln == "COMPANY TOTAL" and cur is not None:
            seq = []
            j = i + 1
            while j < n and len(seq) < 2:
                raw = lines[j].strip()
                if raw == "":
                    j += 1
                    continue
                seq.append(raw)
                j += 1
            cur["totals"]["hours"] = (_num(seq[0]) or 0.0) if len(seq) > 0 else 0.0
            cur["totals"]["gross"] = (_num(seq[1]) or 0.0) if len(seq) > 1 else 0.0
            i = j
            continue

        i += 1

    # Finalize: allocate employer taxes pro-rata, compute employer_cost, roll up.
    employees: dict[str, dict] = {}
    ytd = {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0,
           "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0, "period_count": 0}
    warnings: list[str] = []
    for p in periods:
        t = p["totals"]
        emp_gross = sum(r["gross"] for r in p["rows"]) or 0.0
        if not t["gross"]:
            t["gross"] = emp_gross
        elif emp_gross and abs(emp_gross - t["gross"]) > 0.05:
            warnings.append(
                f"{p['period']}: employee gross sum {emp_gross:.2f} != company gross {t['gross']:.2f}"
            )
        emp_tax_total = t["employer_taxes"]
        for r in p["rows"]:
            share = (r["gross"] / emp_gross) if emp_gross else 0.0
            r["employer_taxes"] = round(emp_tax_total * share, 2)
            r["employer_cost"] = round(r["gross"] + r["employer_taxes"] + r["employer_401k"], 2)
        t["net_pay"] = round(sum(r["net_pay"] for r in p["rows"]), 2)
        t["employer_cost"] = round(t["gross"] + t["employer_taxes"] + t["employer_401k"], 2)
        for k in ("gross", "employer_taxes", "employer_401k", "employer_cost", "net_pay", "hours"):
            ytd[k] += t[k]
        for r in p["rows"]:
            e = employees.setdefault(r["employee"], {"gross": 0.0, "employer_taxes": 0.0,
                "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0, "periods": 0})
            for k in ("gross", "employer_taxes", "employer_401k", "employer_cost", "net_pay", "hours"):
                e[k] += r[k]
            e["periods"] += 1
    ytd["period_count"] = len(periods)
    out: dict[str, object] = {"periods": periods, "employees": employees, "totals": ytd}
    if warnings:
        out["warning"] = "; ".join(warnings)
    return out


def _payroll_year_label_from_parsed(parsed: dict) -> str:
    """Best-effort 4-digit year for a parsed payroll dict (uses first period's
    pay_day, then period-end date). Falls back to 'unknown'."""
    for p in parsed.get("periods", []):
        for src in (str(p.get("pay_day") or ""), str(p.get("period") or "").split(" - ")[-1]):
            m = re.search(r"\d{1,2}/\d{1,2}/(\d{2,4})", src)
            if m:
                y = m.group(1)
                return y if len(y) == 4 else f"20{y}"
    return "unknown"


def _iter_parsed_payroll(inbox: Path):
    """Yield ``(filename, year_label, parsed)`` for every payroll journal in the
    transition inbox, dispatching by format:

    * ``*payroll-summary*.csv`` -> Gusto (legacy; kept for historical data)
    * ``*.pdf`` that is a Paychex Payroll Journal -> Paychex (content-sniffed;
      non-payroll PDFs in the inbox are skipped silently)

    ``parsed`` always has the uniform ``{periods, employees, totals}`` shape.
    """
    if not inbox.exists():
        return
    for path in sorted(inbox.glob("*payroll-summary*.csv")):
        try:
            parsed = _parse_gusto_payroll_journal(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            parsed = {"periods": [], "employees": {}, "totals": {}, "error": str(exc)[:200]}
        m = re.search(r"(\d{4})-\d{2}-\d{2}-to-\d{4}-", path.name)
        yield path.name, (m.group(1) if m else path.stem), parsed
    for path in sorted(inbox.glob("*.pdf")):
        try:
            parsed = _parse_paychex_payroll_journal(path.read_bytes())
        except Exception:
            continue
        if not parsed.get("periods"):
            continue  # not a Paychex Payroll Journal (or unparseable) — skip
        yield path.name, _payroll_year_label_from_parsed(parsed), parsed


# =====================================================================
# Loans + accounting (P&L, Cash Flow, Balance Sheet) endpoints
# =====================================================================

def _to_loan_out(db: Session, loan: Loan) -> LoanOut:
    payments = db.scalars(select(LoanPayment).where(LoanPayment.loan_id == loan.id)).all()
    return LoanOut(
        id=loan.id,
        name=loan.name,
        lender=loan.lender or "",
        loan_type=loan.loan_type or "term_loan",
        account_last4=loan.account_last4,
        principal_original=float(loan.principal_original or 0.0),
        principal_current=float(loan.principal_current or 0.0),
        interest_rate_apr=float(loan.interest_rate_apr or 0.0),
        payment_amount=float(loan.payment_amount or 0.0),
        payment_frequency=loan.payment_frequency or "monthly",
        origination_date=loan.origination_date,
        maturity_date=loan.maturity_date,
        description_match=loan.description_match or "",
        notes=loan.notes or "",
        is_active=bool(loan.is_active),
        payments_count=len(payments),
        payments_total=sum((p.total_amount or 0) for p in payments),
        interest_total=sum((p.interest_amount or 0) for p in payments),
        principal_total=sum((p.principal_amount or 0) for p in payments),
    )


# ============================================================================
# Bookkeeping — tax-remediation actions and per-transaction tax overrides
# Added 2026-05-11 to surface the CPA-remediation work in the app UI.
# Backed by tables `bookkeeping_action_log` and `bookkeeping_tx_overrides`
# (created by scripts/perform_bookkeeping_remediation.py at first run).
# ============================================================================

@app.get("/bookkeeping/actions")
def list_bookkeeping_actions(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """Return all bookkeeping action-log entries grouped by category, plus summary."""
    from sqlalchemy import text
    try:
        rows = db.execute(text(
            "SELECT id, action_key, action_date, category, title, description, "
            "dollar_impact, status, artifact_refs, created_at "
            "FROM bookkeeping_action_log ORDER BY id"
        )).fetchall()
    except Exception:
        # Table doesn't exist yet — return empty shell so the UI renders gracefully
        return {"actions": [], "summary": {"total": 0, "completed": 0, "pending": 0,
                "total_impact": 0.0, "categories": {}}, "overrides_count": 0}

    actions = []
    by_cat: dict[str, dict] = {}
    completed = pending = 0
    total_impact = 0.0
    for r in rows:
        d = dict(r._mapping)
        actions.append(d)
        cat = d["category"]
        by_cat.setdefault(cat, {"count": 0, "impact": 0.0})
        by_cat[cat]["count"] += 1
        by_cat[cat]["impact"] += float(d.get("dollar_impact") or 0)
        if d["status"] == "completed":
            completed += 1
        else:
            pending += 1
        total_impact += float(d.get("dollar_impact") or 0)

    try:
        n_overrides = db.execute(text(
            "SELECT COUNT(*) FROM bookkeeping_tx_overrides"
        )).scalar() or 0
    except Exception:
        n_overrides = 0

    return {
        "actions": actions,
        "summary": {
            "total": len(actions),
            "completed": completed,
            "pending": pending,
            "total_impact": total_impact,
            "categories": by_cat,
        },
        "overrides_count": int(n_overrides),
    }


@app.get("/bookkeeping/overrides")
def list_bookkeeping_overrides(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[dict]:
    """Return all per-transaction tax-classification overrides with linked transaction details."""
    from sqlalchemy import text
    try:
        rows = db.execute(text(
            "SELECT o.id, o.bank_transaction_id, o.override_classification, o.override_notes, "
            "o.loan_id, o.action_key, o.created_at, "
            "bt.posted_date, bt.amount, bt.name "
            "FROM bookkeeping_tx_overrides o "
            "LEFT JOIN bank_transactions bt ON bt.id = o.bank_transaction_id "
            "ORDER BY bt.posted_date DESC NULLS LAST, o.id DESC"
        )).fetchall()
    except Exception:
        return []
    return [dict(r._mapping) for r in rows]


@app.get("/loans", response_model=list[LoanOut])
def list_loans(
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[LoanOut]:
    q = select(Loan).order_by(Loan.is_active.desc(), Loan.name.asc())
    if not include_inactive:
        q = q.where(Loan.is_active.is_(True))
    return [_to_loan_out(db, l) for l in db.scalars(q).all()]


@app.post("/loans", response_model=LoanOut)
def create_loan(
    payload: LoanCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> LoanOut:
    if payload.loan_type not in LOAN_TYPES:
        raise HTTPException(status_code=400, detail=f"loan_type must be one of {LOAN_TYPES}")
    if payload.payment_frequency not in LOAN_FREQUENCIES:
        raise HTTPException(status_code=400, detail=f"payment_frequency must be one of {LOAN_FREQUENCIES}")
    name = payload.name.strip()
    if db.scalar(select(Loan).where(func.lower(Loan.name) == name.lower())):
        raise HTTPException(status_code=400, detail="Loan name already exists")
    loan = Loan(
        name=name,
        lender=payload.lender.strip(),
        loan_type=payload.loan_type,
        account_last4=payload.account_last4,
        principal_original=payload.principal_original,
        principal_current=payload.principal_current or payload.principal_original,
        interest_rate_apr=payload.interest_rate_apr,
        payment_amount=payload.payment_amount,
        payment_frequency=payload.payment_frequency,
        origination_date=payload.origination_date,
        maturity_date=payload.maturity_date,
        description_match=payload.description_match.strip(),
        notes=payload.notes.strip(),
        is_active=payload.is_active,
    )
    db.add(loan)
    db.flush()
    _log_audit_event(
        db=db, entity_type="loan", entity_id=loan.id, action="create",
        actor_user_id=actor.id, payload={"name": loan.name, "lender": loan.lender},
    )
    db.commit()
    db.refresh(loan)
    return _to_loan_out(db, loan)


@app.put("/loans/{loan_id}", response_model=LoanOut)
def update_loan(
    loan_id: int,
    payload: LoanUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> LoanOut:
    loan = db.get(Loan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="Loan not found")
    if payload.loan_type not in LOAN_TYPES:
        raise HTTPException(status_code=400, detail=f"loan_type must be one of {LOAN_TYPES}")
    if payload.payment_frequency not in LOAN_FREQUENCIES:
        raise HTTPException(status_code=400, detail=f"payment_frequency must be one of {LOAN_FREQUENCIES}")
    loan.name = payload.name.strip()
    loan.lender = payload.lender.strip()
    loan.loan_type = payload.loan_type
    loan.account_last4 = payload.account_last4
    loan.principal_original = payload.principal_original
    loan.principal_current = payload.principal_current
    loan.interest_rate_apr = payload.interest_rate_apr
    loan.payment_amount = payload.payment_amount
    loan.payment_frequency = payload.payment_frequency
    loan.origination_date = payload.origination_date
    loan.maturity_date = payload.maturity_date
    loan.description_match = payload.description_match.strip()
    loan.notes = payload.notes.strip()
    loan.is_active = payload.is_active
    _log_audit_event(
        db=db, entity_type="loan", entity_id=loan.id, action="update",
        actor_user_id=actor.id, payload={"name": loan.name},
    )
    db.commit()
    db.refresh(loan)
    return _to_loan_out(db, loan)


@app.delete("/loans/{loan_id}")
def delete_loan(
    loan_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    loan = db.get(Loan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="Loan not found")
    name = loan.name
    # Refuse deletion if there are payments — soft-delete via is_active instead
    has_payments = db.scalar(select(LoanPayment).where(LoanPayment.loan_id == loan_id))
    if has_payments:
        raise HTTPException(
            status_code=400,
            detail=f"Loan '{name}' has payments; mark inactive instead of deleting.",
        )
    db.delete(loan)
    _log_audit_event(
        db=db, entity_type="loan", entity_id=loan_id, action="delete",
        actor_user_id=actor.id, payload={"name": name},
    )
    db.commit()
    return {"status": "deleted"}


@app.get("/loans/{loan_id}/payments", response_model=list[LoanPaymentOut])
def list_loan_payments(
    loan_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[LoanPaymentOut]:
    if not db.get(Loan, loan_id):
        raise HTTPException(status_code=404, detail="Loan not found")
    rows = db.scalars(
        select(LoanPayment)
        .where(LoanPayment.loan_id == loan_id)
        .order_by(LoanPayment.payment_date.desc())
    ).all()
    return [
        LoanPaymentOut(
            id=p.id,
            loan_id=p.loan_id,
            payment_date=p.payment_date,
            total_amount=p.total_amount,
            principal_amount=p.principal_amount,
            interest_amount=p.interest_amount,
            fees_amount=p.fees_amount,
            bank_transaction_id=p.bank_transaction_id,
            notes=p.notes or "",
        )
        for p in rows
    ]


@app.post("/loans/{loan_id}/payments", response_model=LoanPaymentOut)
def add_loan_payment(
    loan_id: int,
    payload: LoanPaymentCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> LoanPaymentOut:
    loan = db.get(Loan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="Loan not found")
    # Auto-fill split: if user only provides total, treat all as principal (interest must be entered manually).
    total = float(payload.total_amount or 0)
    principal = float(payload.principal_amount or 0)
    interest = float(payload.interest_amount or 0)
    fees = float(payload.fees_amount or 0)
    if principal == 0 and interest == 0 and fees == 0 and total > 0:
        principal = total
    pmt = LoanPayment(
        loan_id=loan_id,
        payment_date=payload.payment_date,
        total_amount=total,
        principal_amount=principal,
        interest_amount=interest,
        fees_amount=fees,
        bank_transaction_id=payload.bank_transaction_id,
        notes=payload.notes or "",
    )
    db.add(pmt)
    # Decrement principal_current
    loan.principal_current = max(0.0, float(loan.principal_current or 0) - principal)
    db.flush()
    _log_audit_event(
        db=db, entity_type="loan_payment", entity_id=pmt.id, action="create",
        actor_user_id=actor.id,
        payload={"loan_id": loan_id, "total": total, "principal": principal, "interest": interest},
    )
    db.commit()
    db.refresh(pmt)
    return LoanPaymentOut(
        id=pmt.id, loan_id=pmt.loan_id, payment_date=pmt.payment_date,
        total_amount=pmt.total_amount, principal_amount=pmt.principal_amount,
        interest_amount=pmt.interest_amount, fees_amount=pmt.fees_amount,
        bank_transaction_id=pmt.bank_transaction_id, notes=pmt.notes or "",
    )


@app.delete("/loans/{loan_id}/payments/{payment_id}")
def delete_loan_payment(
    loan_id: int,
    payment_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    pmt = db.get(LoanPayment, payment_id)
    if not pmt or pmt.loan_id != loan_id:
        raise HTTPException(status_code=404, detail="Payment not found")
    loan = db.get(Loan, loan_id)
    if loan:
        loan.principal_current = float(loan.principal_current or 0) + float(pmt.principal_amount or 0)
    db.delete(pmt)
    _log_audit_event(
        db=db, entity_type="loan_payment", entity_id=payment_id, action="delete",
        actor_user_id=actor.id, payload={"loan_id": loan_id},
    )
    db.commit()
    return {"status": "deleted"}


# ----- Accounting summaries -----

# Keyword → FreshBooks-style OPEX bucket. First match wins; order matters
# (specific buckets before generic). Used to break the OPEX line into categories.
_OPEX_BUCKET_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Software & Subscriptions", ("MICROSOFT", "ADOBE", "GOOGLE", "GSUITE", "ZOOM", "SLACK", "DROPBOX",
        "GITHUB", "AUTODESK", "BLUEBEAM", "ESRI", "INTUIT", "QUICKBOOKS", "DOCUSIGN", "NOTION", "ATLASSIAN",
        "OPENAI", "ANTHROPIC", "CANVA", "GODADDY", "SQUARESPACE", "WIX", "MAILCHIMP", "ZAPIER", "AWS",
        "AMAZON WEB", "DIGITALOCEAN", "HEROKU", "NETLIFY", "VERCEL", "SUBSCRIPTION", "APPLE.COM/BILL", "ICLOUD")),
    ("Computer Hardware & Equipment", ("BEST BUY", "BESTBUY", "APPLE STORE", "B&H PHOTO", "BHPHOTO", "DELL",
        "HP ", "HEWLETT", "LENOVO", "NEWEGG", "MICRO CENTER", "MICROCENTER", "CDW")),
    ("Insurance", ("INSURANCE", "HISCOX", "HARTFORD", "GEICO", "STATE FARM", "NYSIF", "LIBERTY MUTUAL",
        "TRAVELERS", "CHUBB", "BERKSHIRE", "PROGRESSIVE", "METLIFE")),
    ("Telecom & Internet", ("VERIZON", "AT&T", "ATT ", "T-MOBILE", "TMOBILE", "SPECTRUM", "COMCAST", "XFINITY",
        "OPTIMUM", "RCN", "EARTHLINK", "GOOGLE FIBER", "INTERNET")),
    ("Rent & Utilities", ("RENT", "WEWORK", "REGUS", "CON ED", "CONED", "CONSOLIDATED EDISON", "NATIONAL GRID",
        "PSEG", "UTILITY", "LANDLORD", "PROPERTY MGMT", "MANAGEMENT OFFICE")),
    ("Travel & Transport", ("AIRLINE", "AIR LINE", "DELTA AIR", "UNITED AIR", "AMERICAN AIR", "JETBLUE",
        "SOUTHWEST", "AMTRAK", "UBER", "LYFT", "TAXI", "MTA", "METROCARD", "HOTEL", "MARRIOTT", "HILTON",
        "HYATT", "AIRBNB", "EXPEDIA", "AVIS", "HERTZ", "ENTERPRISE RENT", "PARKING", "TOLL", "E-ZPASS", "EZPASS")),
    ("Meals & Entertainment", ("RESTAURANT", "CAFE", "COFFEE", "STARBUCKS", "DUNKIN", "DOORDASH", "UBER EATS",
        "GRUBHUB", "SEAMLESS", "DINER", "PIZZA", "BAR ", "GRILL", "DELI", "CATERING")),
    ("Office Supplies & Postage", ("STAPLES", "OFFICE DEPOT", "OFFICEMAX", "AMAZON", "AMZN", "USPS", "FEDEX",
        "UPS ", "UPS STORE", "POSTAGE", "SHIPPING", "W.B. MASON", "WB MASON", "ULINE")),
    ("Professional Services", ("LEGAL", "ATTORNEY", "LAW ", "ACCOUNT", "CPA", "BOOKKEEP", "PAYROLL SERVICE",
        "CONSULT", "ADP", "PAYCHEX", "GUSTO FEE", "NOTARY", "ENGINEER")),
    ("Dues, Licenses & Education", ("LICENSE", "PERMIT", "DUES", "MEMBERSHIP", "ASCE", "NSPE", "PE LICENSE",
        "STATE OF NY", "DEPT OF STATE", "COURSE", "TRAINING", "SEMINAR", "CONFERENCE", "UDEMY", "COURSERA")),
    ("Marketing & Advertising", ("ADVERTIS", "GOOGLE ADS", "FACEBOOK", "META PLATFORMS", "LINKEDIN", "MARKETING",
        "PRINTING", "VISTAPRINT", "FIVERR", "UPWORK")),
    ("Bank & Merchant Fees", ("BANK FEE", "SERVICE FEE", "SERVICE CHARGE", "WIRE FEE", "OVERDRAFT", "NSF FEE",
        "MONTHLY FEE", "MAINTENANCE FEE", "STRIPE", "SQUARE INC", "PAYPAL FEE", "MERCHANT FEE", "ANALYSIS CHARGE")),
)


# Collapse Plaid PFC slugs (GENERAL_SERVICES) and raw FreshBooks category names
# into the same canonical buckets so the breakdown doesn't fragment into synonyms.
_OPEX_LABEL_SYNONYMS: dict[str, str] = {
    "utilities": "Rent & Utilities",
    "office rent": "Rent & Utilities",
    "rent": "Rent & Utilities",
    "bank fees": "Bank & Merchant Fees",
    "bank fees & service charges": "Bank & Merchant Fees",
    "travel": "Travel & Transport",
    "transportation": "Travel & Transport",
    "business travel & lodging": "Travel & Transport",
    "car & truck expenses": "Travel & Transport",
    "office expenses & postage": "Office Supplies & Postage",
    "office expenses": "Office Supplies & Postage",
    "supplies": "Office Supplies & Postage",
    "entertainment": "Meals & Entertainment",
    "food and drink": "Meals & Entertainment",
    "general services": "Professional Services",
    "business operations expense": "Other / Uncategorized",
    "uncategorized": "Other / Uncategorized",
    "general": "Other / Uncategorized",
    "double check manual": "⚠ Needs review (manual)",
    "general merchandise": "Office Supplies & Postage",
}


def _normalize_opex_label(raw: str | None) -> str:
    if not raw:
        return "Other / Uncategorized"
    clean = str(raw).replace("_", " ").strip()
    key = clean.lower()
    if key in _OPEX_LABEL_SYNONYMS:
        return _OPEX_LABEL_SYNONYMS[key]
    # Title-case but keep short joiners lowercase for readability.
    return " ".join(w if w in ("and", "or", "of", "&") else w.capitalize() for w in clean.split())


def _opex_category_bucket(name_upper: str, plaid_cat: str | None) -> str:
    """Classify an OPEX transaction into a FreshBooks-style category for the P&L breakdown."""
    for label, kws in _OPEX_BUCKET_RULES:
        if any(k in name_upper for k in kws):
            return label
    return _normalize_opex_label(plaid_cat)


def _accounting_period(start_iso: str | None, end_iso: str | None) -> tuple[date, date]:
    today = date.today()
    if end_iso:
        end = datetime.strptime(end_iso, "%Y-%m-%d").date()
    else:
        end = today
    if start_iso:
        start = datetime.strptime(start_iso, "%Y-%m-%d").date()
    else:
        start = date(end.year, 1, 1)
    if start > end:
        raise HTTPException(status_code=400, detail="start must be on/before end")
    return start, end


def _parse_fundbox_ledger(path: Path) -> list[dict]:
    """Parse a Fundbox 'Transaction History' CSV export — the lender's authoritative
    ledger. Columns: Year, Month, Day, Date, Type, Draw ID, Description,
    Direct Draw, Direct Draw Repayment, Fees, Discount. Returns one dict per row
    with a real ``date`` plus numeric draw/repayment/fees/discount. Returns ``[]``
    for any non-Fundbox CSV (sniffed via the header), so it is safe to point at the
    whole inbox (Gusto ``*payroll-summary*.csv`` files are ignored)."""
    import csv as _csv
    try:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            rdr = _csv.DictReader(fh)
            cols = rdr.fieldnames or []
            if "Direct Draw" not in cols or "Draw ID" not in cols:
                return []

            def _n(s: str) -> float:
                s = (s or "").replace("$", "").replace(",", "").strip()
                try:
                    return float(s)
                except ValueError:
                    return 0.0

            rows: list[dict] = []
            for r in rdr:
                try:
                    d = date(int(r["Year"]), int(r["Month"]), int(r["Day"]))
                except (TypeError, ValueError, KeyError):
                    continue
                rows.append({
                    "date": d,
                    "draw": _n(r.get("Direct Draw")),
                    "repayment": _n(r.get("Direct Draw Repayment")),
                    "fees": _n(r.get("Fees")),
                    "discount": _n(r.get("Discount")),
                })
            return rows
    except (OSError, UnicodeDecodeError):
        return []


def _fundbox_ledger_cost(start: date, end: date) -> tuple[float, float, float]:
    """Authoritative Fundbox financing cost over ``[start, end]`` from the ledger in
    the transition inbox. Returns ``(fees, discount, principal_repaid)``.

    Fundbox is paid sometimes from checking and sometimes on the company credit card
    (to earn points), so bank-derived loan payments are noisy and incomplete — they
    book repayment principal as "interest" and miss the card-paid runs. The lender's
    own ledger records every draw/repayment/fee regardless of how it was paid, so it
    is the single source of truth for the Fundbox cost (fees + discount)."""
    inbox = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
    if not inbox.exists():
        return 0.0, 0.0, 0.0
    fees = discount = principal = 0.0
    for p in sorted(inbox.iterdir()):
        if not p.is_file() or p.suffix.lower() != ".csv":
            continue
        for r in _parse_fundbox_ledger(p):
            if start <= r["date"] <= end:
                fees += r["fees"]
                discount += r["discount"]
                principal += r["repayment"]
    return round(fees, 2), round(discount, 2), round(principal, 2)


@app.get("/accounting/pl")
def accounting_pl(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Profit & Loss for the period.

    - Revenue: sum of paid invoice amounts (cash basis) within issue_date in period.
    - COGS: Gusto employer cost (gross + employer taxes + 401k match) within payroll period.
    - Operating Expenses (OPEX): bank transactions in period tagged with expense_group OH/Other,
      EXCLUDING anything mapped to a LoanPayment (those are not expenses).
    - Interest expense: sum of LoanPayment.interest_amount in period.
    - Net income = Revenue - COGS - OPEX - Interest.
    """
    s, e = _accounting_period(start, end)

    # Revenue (cash basis): paid invoices with paid_date in period
    revenue = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.amount_paid), 0.0))
        .where(Invoice.paid_date.isnot(None), Invoice.paid_date >= s, Invoice.paid_date <= e)
    ) or 0.0)

    # Accrual revenue: invoices issued in period (alternate). Exclude DRAFTS —
    # a draft is not billed work; FreshBooks excludes them from invoiced totals too.
    revenue_accrual = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.subtotal_amount), 0.0))
        .where(Invoice.issue_date >= s, Invoice.issue_date <= e,
               func.lower(func.coalesce(Invoice.status, "")) != "draft")
    ) or 0.0)

    # COGS from Gusto journal (canonical). Re-parse the inbox.
    # Use pay_day (when the expense actually hits) — that's the canonical date for
    # cash-basis accounting and matches what the IRS expects for payroll tax timing.
    cogs = 0.0
    payroll_breakdown = {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0}
    try:
        inbox = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
        if inbox.exists():
            for _fname, _year, parsed in _iter_parsed_payroll(inbox):
                for period in parsed.get("periods", []):
                    # Try pay_day first (preferred), fall back to period-end date
                    pd_str = (period.get("pay_day") or "").strip()
                    pd: date | None = None
                    if pd_str:
                        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
                            try:
                                pd = datetime.strptime(pd_str, fmt).date()
                                break
                            except ValueError:
                                continue
                    if pd is None:
                        # Fall back to parsing the end of "MM/DD/YYYY - MM/DD/YYYY"
                        per_str = (period.get("period") or "").strip()
                        if " - " in per_str:
                            end_str = per_str.split(" - ")[-1].strip()
                            for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
                                try:
                                    pd = datetime.strptime(end_str, fmt).date()
                                    break
                                except ValueError:
                                    continue
                    if pd is None or pd < s or pd > e:
                        continue
                    t = period.get("totals", {})
                    cogs += float(t.get("employer_cost", 0))
                    payroll_breakdown["gross"] += float(t.get("gross", 0))
                    payroll_breakdown["employer_taxes"] += float(t.get("employer_taxes", 0))
                    payroll_breakdown["employer_401k"] += float(t.get("employer_401k", 0))
    except Exception:
        # If parsing fails, leave COGS at 0 — UI will show note
        pass

    # Benefits-to-COGS: per user, NYSIF (workers comp + disability) and Nu Era
    # (health insurance for one employee) are per-employee benefit costs that
    # belong in COGS, not OPEX. Pull bank outflows matching those merchants.
    benefits_cogs = 0.0
    benefits_keywords_for_cogs = BENEFITS_TO_COGS_KEYWORDS
    superseded_for_benefits = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True),
            BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_for_benefits),
        )
    ).all():
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in benefits_keywords_for_cogs):
            benefits_cogs += -float(tx.amount or 0)
    cogs += benefits_cogs

    # OPEX from bank/CC outflows in period
    # Exclude transactions linked to a LoanPayment (those are debt servicing not expense)
    linked_tx_ids = {p.bank_transaction_id for p in db.scalars(select(LoanPayment)).all() if p.bank_transaction_id}
    # Sources retagged as superseded (by reconciliation engine) are archived,
    # not live — exclude from P&L. API sources are canonical (per user directive).
    superseded_sources = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    # Build name-keyword exclusions from active loans' description_match patterns.
    # This catches loan payments that aren't yet linked via LoanPayment.bank_transaction_id
    # (e.g. when LoanPayments are modeled as monthly aggregates while Plaid pulls dailies).
    loan_keywords: list[str] = []
    for ln in db.scalars(select(Loan)).all():  # include paid-off loans too (descriptions still match historical txs)
        for pat in (ln.description_match or "").split("|"):
            pat = pat.strip().upper()
            if pat:
                loan_keywords.append(pat)
    opex = 0.0
    opex_by_cat: dict[str, float] = defaultdict(float)
    # Consulting chart-of-accounts rollups. INDIRECT spend rolls up by group
    # (Admin / Marketing / Business Development). Transactions whose assigned category
    # is a COGS account (subconsultants, materials, direct project costs) route to COGS,
    # not OPEX; OTHER categories (transfers/owner draws/financing) are excluded from the
    # operating margin entirely. Authoritative source = each tx's assigned category
    # (_tx_category_from_json); the keyword classifier is only a fallback for uncategorized.
    opex_by_group: dict[str, float] = defaultdict(float)
    cogs_from_tx = 0.0
    cogs_tx_by_group: dict[str, float] = defaultdict(float)
    interest_in_loans = 0.0
    cc_payments = 0.0
    # Internal-transfer + CC-payment keywords. These move money between user-owned
    # accounts (or personal account 0273) — they are NOT operating expenses.
    cc_transfers_keywords = CC_TRANSFER_KEYWORDS
    # Payroll-related keywords. These are already counted via Gusto journal in COGS.
    # Plaid categorizes Gusto wires as TRANSFER_OUT_ACCOUNT_TRANSFER (not "payroll"),
    # so the existing category-based filter doesn't catch them.
    # Per-employee benefits + workers-comp insurance are also COGS-side per the
    # user (Nu Era = health insurance for Svadlenka; NYSIF = workers comp). They
    # should ideally be added to the COGS line; for now we just exclude them
    # from OPEX so they don't double-count.
    payroll_keywords = PAYROLL_KEYWORDS
    # Zelle-to-staff: per user directive, sometimes salaries are paid via Zelle even
    # though payroll is processed in Gusto. Those Zelle outflows duplicate the
    # Gusto journal already in COGS, so exclude when the memo contains a staff
    # member's first or last name. We collect the name tokens up front for fast
    # substring matching.
    staff_name_tokens: set[str] = set()
    for u in db.scalars(select(User).where(User.is_active.is_(True))).all():
        for tok in (u.full_name or "").upper().split():
            tok = tok.strip()
            if len(tok) >= 3:  # ignore single-letter middle initials
                staff_name_tokens.add(tok)
    # Personal-account items that are actually business (per user directive):
    #   1. Computer hardware purchases at major electronics retailers
    #   2. Travel — airfare, hotels, taxis, ride-share, transit (2025+)
    # Tightened: APPLE CASH (P2P) and APPLE.COM/BILL (iCloud subs) carved out.
    personal_to_business_keywords = PERSONAL_TO_BUSINESS_KEYWORDS
    # Patterns that look like "personal_to_business" but should NOT promote (carve-out)
    personal_to_business_exclude = (
        "APPLE CASH",          # Apple's peer-to-peer payments
        "APPLE.COM/BILL",      # iCloud/Music/etc subscriptions
    )
    # Outflows that LOOK like business but are actually personal (Alpaca trading,
    # Robinhood transfers, owner draws, etc) — exclude even on business accounts.
    personal_overrides = PERSONAL_OVERRIDE_KEYWORDS
    # Two-pass query:
    #   Pass 1: business-tagged outflows (the normal OPEX universe)
    #   Pass 2: personal-tagged outflows that match business-hardware keywords
    #           (Best Buy, HP, Apple, etc) — promote to OPEX per user directive
    business_outflows = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True),
            BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_sources),
        )
    ).all()
    personal_outflows = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(False),
            BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_sources),
        )
    ).all()
    for tx in business_outflows:
        if tx.id in linked_tx_ids:
            continue  # already accounted for as loan payment, not expense
        try:
            cats = json.loads(tx.category_json or "[]")
        except Exception:
            cats = []
        cat_lower = " ".join(str(c).lower() for c in cats)
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in cc_transfers_keywords):
            continue  # internal transfers are not expenses
        if any(k in nm_upper for k in payroll_keywords):
            continue  # payroll-related (Gusto, 401k custodian) — already in COGS
        if any(k in nm_upper for k in loan_keywords):
            continue  # loan principal/interest — already counted via LoanPayment lines
        if any(k in nm_upper for k in personal_overrides):
            continue  # personal trading/transfers misposted to business account
        if any(k in nm_upper for k in FINANCING_EXCLUDE_KEYWORDS):
            continue  # MCA / short-term business financing — debt servicing, not OPEX
        # Zelle to individuals: per user (2026-06-07) these are personal or staff-pay
        # already counted in COGS — either way not OPEX. (Was staff-name-only.)
        if "ZELLE" in nm_upper:
            continue
        if "payroll" in cat_lower and "tax" not in cat_lower:
            continue
        amt = -float(tx.amount or 0)
        _grp, _cat = _tx_category_from_json(tx)  # assigned category wins; keyword = fallback
        cat = _cat or _opex_category_bucket(nm_upper, cats[0] if cats else None)
        section, group = coa_section(cat)
        if section == "COGS":  # subconsultants / materials / direct project costs
            cogs_from_tx += amt
            cogs_tx_by_group[group] += amt
        elif section == "OTHER":  # transfers / owner draws / financing — not an expense
            continue
        else:
            opex += amt
            opex_by_cat[cat] += amt
            opex_by_group[group] += amt
    # Pass 2: hardware/travel purchases on personal account that are actually business
    for tx in personal_outflows:
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in personal_to_business_exclude):
            continue  # carved-out: not a computer purchase
        if any(k in nm_upper for k in personal_to_business_keywords):
            amt = -float(tx.amount or 0)
            try:
                pcats = json.loads(tx.category_json or "[]")
            except Exception:
                pcats = []
            _pgrp, _pcat = _tx_category_from_json(tx)
            cat = _pcat or _opex_category_bucket(nm_upper, pcats[0] if pcats else None)
            section, group = coa_section(cat)
            if section == "COGS":
                cogs_from_tx += amt
                cogs_tx_by_group[group] += amt
            elif section != "OTHER":
                opex += amt
                opex_by_cat[cat] += amt
                opex_by_group[group] += amt

    # Pass 3: FB-only business expenses (paid on a personal card not linked to AqtPM,
    # so the bank-side rows we have don't see them). Pull from active csv_fb_expenses
    # rows where the FB category (stored in account_id) is a recognized OPEX bucket.
    # csv_fb_expenses amounts are positive (FB ledger sign convention), so we add
    # them directly to OPEX.
    fb_only_opex = 0.0
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.source == "csv_fb_expenses",   # active, not superseded
            BankTransaction.amount > 0,
            BankTransaction.account_id.in_(FB_CATEGORIES_TO_OPEX),
        )
    ).all():
        # Skip personal-overrides (Manual DB-Bkrg etc in case they ended up here)
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in personal_overrides):
            continue
        amt = float(tx.amount or 0)
        # FB rows carry their curated FreshBooks category in account_id — normalize it
        # into the canonical bucket set (falls back to the keyword classifier on the name).
        raw_fb = (tx.account_id or "").strip()
        fb_label = _normalize_opex_label(raw_fb) if raw_fb else _opex_category_bucket(nm_upper, None)
        section, group = coa_section(fb_label)
        if section == "COGS":
            cogs_from_tx += amt
            cogs_tx_by_group[group] += amt
        elif section != "OTHER":
            opex += amt
            opex_by_cat[fb_label] += amt
            opex_by_group[group] += amt

    # Interest + fees from LoanPayment records — but EXCLUDE Fundbox. Fundbox is
    # paid sometimes from checking, sometimes on the company credit card (for the
    # points), so its bank-derived loan payments are noisy: they book repayment
    # principal as "interest" and miss the card-paid runs entirely. We take the real
    # Fundbox cost from its authoritative ledger instead (see below).
    fundbox_loan_ids = [
        r[0] for r in db.execute(
            select(Loan.id).where(func.lower(Loan.name).like("%fundbox%"))
        ).all()
    ]
    _lp_where = [LoanPayment.payment_date >= s, LoanPayment.payment_date <= e]
    if fundbox_loan_ids:
        _lp_where.append(~LoanPayment.loan_id.in_(fundbox_loan_ids))
    interest_expense = float(db.scalar(
        select(func.coalesce(func.sum(LoanPayment.interest_amount), 0.0)).where(*_lp_where)
    ) or 0.0)
    fees_expense = float(db.scalar(
        select(func.coalesce(func.sum(LoanPayment.fees_amount), 0.0)).where(*_lp_where)
    ) or 0.0)
    # Authoritative Fundbox financing cost (fees + discount) from the ledger —
    # method-agnostic (checking OR credit card), replacing the excluded bank-derived
    # Fundbox interest above. Principal repayments are debt servicing, not expense.
    _fb_fees, _fb_discount, _fb_principal = _fundbox_ledger_cost(s, e)
    fundbox_financing_cost = round(_fb_fees + _fb_discount, 2)
    fees_expense += fundbox_financing_cost

    # Direct-project costs categorized on transactions (subconsultants, materials, field
    # services) join the loaded-labor COGS computed from the payroll journal above.
    cogs += cogs_from_tx
    gross_profit_cash = revenue - cogs
    gross_profit_accrual = revenue_accrual - cogs
    net_income_cash = revenue - cogs - opex - interest_expense - fees_expense
    net_income_accrual = revenue_accrual - cogs - opex - interest_expense - fees_expense

    def _margin(num: float, den: float) -> float:
        return round(num / den, 4) if den else 0.0

    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "revenue_cash": revenue,
        "revenue_accrual": revenue_accrual,
        "cogs": cogs,
        "cogs_breakdown": {
            # Loaded labor (gross + employer taxes + 401(k)) + benefits + categorized
            # direct-project costs (subconsultants / materials / field services).
            "gross_wages": round(payroll_breakdown["gross"], 2),
            "employer_payroll_taxes": round(payroll_breakdown["employer_taxes"], 2),
            "employer_401k_match": round(payroll_breakdown["employer_401k"], 2),
            "benefits_workers_comp": round(benefits_cogs, 2),
            "direct_project_costs": round(cogs_from_tx, 2),
            "total_employer_cost": round(cogs - benefits_cogs - cogs_from_tx, 2),
        },
        "cogs_direct_project_by_group": [
            {"group": g, "amount": round(v, 2)}
            for g, v in sorted(cogs_tx_by_group.items(), key=lambda kv: kv[1], reverse=True)
            if round(v, 2) != 0
        ],
        "payroll_breakdown": payroll_breakdown,
        "gross_profit_cash": round(gross_profit_cash, 2),
        "gross_profit_accrual": round(gross_profit_accrual, 2),
        "gross_margin_cash": _margin(gross_profit_cash, revenue),
        "gross_margin_accrual": _margin(gross_profit_accrual, revenue_accrual),
        "opex": opex,
        "opex_breakdown": [
            {"category": k, "amount": round(v, 2)}
            for k, v in sorted(opex_by_cat.items(), key=lambda kv: kv[1], reverse=True)
            if round(v, 2) != 0
        ],
        "opex_by_group": [
            {"group": g, "amount": round(v, 2)}
            for g, v in sorted(opex_by_group.items(), key=lambda kv: kv[1], reverse=True)
            if round(v, 2) != 0
        ],
        "interest_expense": interest_expense,
        "fees_expense": fees_expense,
        "fundbox_financing_cost": fundbox_financing_cost,
        "net_income_cash": net_income_cash,
        "net_income_accrual": net_income_accrual,
        "net_margin_cash": _margin(net_income_cash, revenue),
        "net_margin_accrual": _margin(net_income_accrual, revenue_accrual),
        "notes": [
            "Revenue (cash) = paid invoices in period; Revenue (accrual) = invoices issued in period.",
            "COGS = Gusto employer cost (gross + employer taxes + 401(k) match) + Benefits/Workers Comp (NYSIF + Nu Era).",
            "OPEX excludes transactions linked to a Loan Payment (those reduce balance-sheet debt, not P&L).",
            "Interest expense + Fees come from LoanPayment splits.",
        ],
    }


@app.get("/accounting/cashflow")
def accounting_cashflow(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Cash flow statement (simplified, cash basis).

    Operating: cash in from invoices paid - cash out for OPEX - cash out for COGS (payroll cash).
    Investing: 0 (placeholder).
    Financing: loan proceeds in - loan payments out (full amount) + owner contributions - distributions.
    """
    s, e = _accounting_period(start, end)

    # Operating IN
    cash_in_invoices = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.amount_paid), 0.0))
        .where(Invoice.paid_date.isnot(None), Invoice.paid_date >= s, Invoice.paid_date <= e)
    ) or 0.0)

    # Operating OUT — re-use PL helpers (call accounting_pl logic inline-light)
    # For simplicity: sum negative bank transactions in business accounts, excluding loan-mapped + transfers.
    linked_tx_ids = {p.bank_transaction_id for p in db.scalars(select(LoanPayment)).all() if p.bank_transaction_id}
    superseded_sources = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    # Loan keyword exclusions (in case some loan txs aren't yet linked via LoanPayment.bank_transaction_id)
    loan_keywords_cf: list[str] = []
    for ln in db.scalars(select(Loan)).all():  # include paid-off loans too (descriptions still match historical txs)
        for pat in (ln.description_match or "").split("|"):
            pat = pat.strip().upper()
            if pat:
                loan_keywords_cf.append(pat)
    payroll_keywords_cf = PAYROLL_KEYWORDS
    personal_overrides_cf = PERSONAL_OVERRIDE_KEYWORDS
    cash_out_opex = 0.0
    cash_out_payroll = 0.0  # real wages/taxes paid (Gusto/Paychex) — operating cash out
    cc_transfers_keywords = CC_TRANSFER_KEYWORDS
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s, BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True), BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_sources),
        )
    ).all():
        if tx.id in linked_tx_ids:
            continue
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in cc_transfers_keywords):
            continue
        if any(k in nm_upper for k in loan_keywords_cf):
            continue
        if any(k in nm_upper for k in personal_overrides_cf):
            continue
        # Payroll IS an operating cash outflow (unlike the P&L, which sources COGS
        # from the Gusto journal). Capture it separately so the operating section
        # reflects real cash paid to employees.
        if any(k in nm_upper for k in payroll_keywords_cf):
            cash_out_payroll += -float(tx.amount or 0)
            continue
        cash_out_opex += -float(tx.amount or 0)

    # Financing
    loan_payments = db.scalars(
        select(LoanPayment).where(LoanPayment.payment_date >= s, LoanPayment.payment_date <= e)
    ).all()
    loan_payments_total = sum(float(p.total_amount or 0) for p in loan_payments)

    # Bank-level inflow breakdown (for transparency: where the money actually came in)
    inflow_breakdown = {
        "client_direct": 0.0,        # RTP + wire + Stripe (real client payments to bank)
        "boc_factoring": 0.0,        # BOC Capital advances against factored invoices
        "fundbox_draw": 0.0,         # FundBox LOC draws
        "owner_contribution": 0.0,   # Online transfers from 0273 + Zelle from BertrandAlbert
        "cc_payment_thank_you": 0.0, # Internal CC credit
        "other": 0.0,
    }
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s, BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True), BankTransaction.amount > 0,
            ~BankTransaction.source.in_([*superseded_sources, "csv_fb_expenses"]),
        )
    ).all():
        nm = (tx.name or "").upper()
        amt = float(tx.amount or 0)
        if "BOC CAPITAL" in nm:
            inflow_breakdown["boc_factoring"] += amt
        elif "FUNDBOX" in nm:
            inflow_breakdown["fundbox_draw"] += amt
        elif "ONLINE TRANSFER FROM CHK" in nm or "ZELLE PAYMENT FROM BERTRAND" in nm:
            inflow_breakdown["owner_contribution"] += amt
        elif "PAYMENT THANK YOU" in nm:
            inflow_breakdown["cc_payment_thank_you"] += amt
        elif "REAL TIME PAYMENT" in nm or "FEDWIRE" in nm or "STRIPE" in nm:
            inflow_breakdown["client_direct"] += amt
        else:
            inflow_breakdown["other"] += amt

    # Financing inflows = BOC + FundBox draws (owner contributions shown under owner, below)
    financing_in = inflow_breakdown["boc_factoring"] + inflow_breakdown["fundbox_draw"]
    financing_net = financing_in - loan_payments_total

    # Owner / equity cash flows: net cash drawn to the owner's personal account (...0273).
    # Distributions out reduce cash; contributions in add cash. Same detection as
    # business-health (account-transfer pattern only; exclude intl wires + the 0273 leg).
    owner_txns = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s, BankTransaction.posted_date <= e,
            ~BankTransaction.source.in_(superseded_sources),
            BankTransaction.name.ilike("%transfer%0273%"),
            ~BankTransaction.name.ilike("%wire%"),
            BankTransaction.account_id != "Chase0273_Activity",
        )
    ).all()
    distributions_out = sum(-float(t.amount or 0) for t in owner_txns if float(t.amount or 0) < 0)
    contributions_in = sum(float(t.amount or 0) for t in owner_txns if float(t.amount or 0) > 0)
    owner_net = contributions_in - distributions_out  # +ve = net cash in from owner

    operating_net = cash_in_invoices - cash_out_opex - cash_out_payroll
    net_change = operating_net + financing_net + owner_net

    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "operating": {
            "cash_in_invoices": round(cash_in_invoices, 2),
            "cash_out_opex": round(cash_out_opex, 2),
            "cash_out_payroll": round(cash_out_payroll, 2),
            "cash_out_opex_and_payroll": round(cash_out_opex + cash_out_payroll, 2),
            "net": round(operating_net, 2),
        },
        "investing": {"capex": 0.0, "net": 0.0, "note": "Capex not tracked yet."},
        "financing": {
            "loan_proceeds_boc": round(inflow_breakdown["boc_factoring"], 2),
            "loan_proceeds_fundbox": round(inflow_breakdown["fundbox_draw"], 2),
            "loan_payments_total": round(loan_payments_total, 2),
            "net": round(financing_net, 2),
            "note": "BOC + Fundbox draws in, all loan payments out (incl. Forward MCA daily holdbacks).",
        },
        "owner": {
            "contributions_in": round(contributions_in, 2),
            "distributions_out": round(distributions_out, 2),
            "net": round(owner_net, 2),
            "note": "S-corp owner draws to personal ...0273 (out) and capital put back (in).",
        },
        "inflow_breakdown": inflow_breakdown,
        "net_change_in_cash": round(net_change, 2),
    }


def _owner_actual_payroll(start: date, end: date) -> dict[str, float]:
    """Bertrand's ACTUAL W-2 payroll run in the period (from the Gusto/Paychex
    journals) — distinct from the reasonable-comp TARGET. Surfaces the real
    401(k) deferral vs the allowable so the dashboard shows reality, not a
    projection. Filters to Bertrand (matches 'Bertrand' and the truncated
    'Dr Bertran'), excluding Courtney Byrne."""
    def _pd(v: object) -> date | None:
        sv = str(v or "").strip()
        for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
            try:
                return datetime.strptime(sv, fmt).date()
            except ValueError:
                continue
        return None

    gross = match = 0.0
    try:
        inbox = Path(get_settings().FRESHBOOKS_TRANSITION_DIR).expanduser()
        if inbox.exists():
            for _fn, _yr, parsed in _iter_parsed_payroll(inbox):
                for p in parsed.get("periods", []):
                    pd = _pd(p.get("pay_day"))
                    if pd is None or pd < start or pd > end:
                        continue
                    for r in p.get("rows", []):
                        nm = (r.get("employee") or "").lower()
                        if "byrne" in nm and "bertran" in nm and "courtney" not in nm:
                            gross += float(r.get("gross") or 0)
                            match += float(r.get("employer_401k") or 0)
    except Exception:
        pass
    # Owner defers 80% of gross; 2026 allowable incl. ages 60-63 super catch-up = $35,750.
    defer = min(gross * 0.80, 35750.0)
    return {
        "gross_paid": round(gross, 2),
        "employer_match": round(match, 2),
        "deferral_est": round(defer, 2),
        "allowable_401k": 35750.0,
        "remaining_401k": round(max(0.0, 35750.0 - defer), 2),
    }


@app.get("/accounting/business-health")
def accounting_business_health(
    start: str | None = None,
    end: str | None = None,
    basis: str = "cash",
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Clean "how is the business actually doing" view that separates:
      (1) real business revenue from borrowed cash (financing draws are NOT revenue);
      (2) the cost of that financing (interest + fees);
      (3) a clean P&L waterfall to net income (COGS + indirect breakdown);
      (4) shareholder distributions/contributions (S-corp, sole owner — equity, NOT
          P&L), kept strictly below the line.
    Reuses /accounting/pl + /accounting/cashflow and adds owner-distribution + debt."""
    s, e = _accounting_period(start, end)
    pl = accounting_pl(start=start, end=end, db=db, _=_)
    cf = accounting_cashflow(start=start, end=end, db=db, _=_)
    inb = cf.get("inflow_breakdown", {}) if isinstance(cf, dict) else {}

    boc_in = float(inb.get("boc_factoring", 0.0) or 0.0)
    fundbox_in = float(inb.get("fundbox_draw", 0.0) or 0.0)
    contributions_in = float(inb.get("owner_contribution", 0.0) or 0.0)

    # Shareholder distributions = net cash drawn to the owner's PERSONAL Chase
    # account (...0273). S-corp, sole shareholder: money out beyond W-2 salary is a
    # DISTRIBUTION (reduces equity) — NOT an expense and NOT a loan. Money in = a
    # capital contribution. Read the ...0273 transfer legs (recorded on the other
    # accounts) and net the two directions.
    superseded_sources = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    txns = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            ~BankTransaction.source.in_(superseded_sources),
            # Match the account-transfer pattern ONLY. Exclude international wires
            # (their reference numbers contain "0273") and rows recorded ON the 0273
            # account itself — both are false positives that inflate the draw figure.
            BankTransaction.name.ilike("%transfer%0273%"),
            ~BankTransaction.name.ilike("%wire%"),
            BankTransaction.account_id != "Chase0273_Activity",
        )
    ).all()
    dist_out = sum(-float(t.amount or 0) for t in txns if float(t.amount or 0) < 0)
    contrib_0273 = sum(float(t.amount or 0) for t in txns if float(t.amount or 0) > 0)

    # External debt outstanding (exclude shareholder-loan lines — those are equity-ish
    # for a sole-shareholder S-corp and shown under "shareholder" instead).
    debt_lines = []
    for l in db.scalars(select(Loan)).all():
        bal = float(getattr(l, "principal_current", 0.0) or 0.0)
        nm = l.name or ""
        if bal > 0 and "shareholder" not in nm.lower():
            debt_lines.append({"name": nm, "balance": round(bal, 2)})
    debt_total = round(sum(d["balance"] for d in debt_lines), 2)

    interest = float(pl.get("interest_expense", 0.0) or 0.0)
    fees = float(pl.get("fees_expense", 0.0) or 0.0)
    financing_cost = round(interest + fees, 2)
    accrual = (basis or "cash").strip().lower() == "accrual"
    _sfx = "accrual" if accrual else "cash"
    revenue = float(pl.get(f"revenue_{_sfx}", 0.0) or 0.0)
    cogs = float(pl.get("cogs", 0.0) or 0.0)
    gross_profit = float(pl.get(f"gross_profit_{_sfx}", revenue - cogs) or 0.0)
    gross_margin = pl.get(f"gross_margin_{_sfx}", 0.0)
    opex = float(pl.get("opex", 0.0) or 0.0)
    net_income = float(pl.get(f"net_income_{_sfx}", 0.0) or 0.0)
    net_margin = pl.get(f"net_margin_{_sfx}", 0.0)

    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "basis": _sfx,
        "cash_in": {
            "business_revenue": round(revenue, 2),
            "borrowed_boc": round(boc_in, 2),
            "borrowed_fundbox": round(fundbox_in, 2),
            "borrowed_total": round(boc_in + fundbox_in, 2),
            "owner_contributions": round(contributions_in, 2),
        },
        "financing_cost": {
            "interest": round(interest, 2),
            "fees": round(fees, 2),
            "total": financing_cost,
            "note": "Cost of the borrowed money (BOC 3%/yr + 1%/draw, Fundbox fees, Forward MCA).",
        },
        "waterfall": {
            "revenue": round(revenue, 2),
            "cogs": round(cogs, 2),
            "cogs_breakdown": pl.get("cogs_breakdown", {}),
            "gross_profit": round(gross_profit, 2),
            "gross_margin": gross_margin,
            "indirect_total": round(opex, 2),
            "indirect_by_group": pl.get("opex_by_group", []),
            "operating_income": round(gross_profit - opex, 2),
            "financing_cost": financing_cost,
            "net_income": round(net_income, 2),
            "net_margin": net_margin,
        },
        "shareholder": {
            "distributions_out": round(dist_out, 2),
            "contributions_in": round(contrib_0273, 2),
            "net_distributions": round(dist_out - contrib_0273, 2),
            "note": "S-corp, sole shareholder: distributions reduce equity — not an expense, not a loan.",
        },
        "owner_payroll": _owner_actual_payroll(s, e),
        "debt_outstanding": {"lines": debt_lines, "total": debt_total},
    }


# DEP direct SALARY rates (Aquatech_Updated_LTCP_Rates_2026). Used for the
# reasonable-comp "earned vs paid" reconciliation. Wang/Courtney are estimates.
SALARY_RATES = {
    "bertrand": 99.23, "courtney": 35.0, "gilliam": 53.0, "zachary": 53.0,
    "hodge": 52.50, "stacey": 52.50, "svadlenka": 61.50, "robert": 61.50,
    "welch": 78.50, "ailsa": 78.50, "guo": 130.0, "qizhong": 130.0,
    "wang": 100.0, "roger": 100.0,
}


def _salary_rate_for(name: str) -> float:
    nl = (name or "").lower()
    for k, v in SALARY_RATES.items():
        if k in nl:
            return v
    return 0.0


@app.get("/accounting/comp-reconciliation")
def accounting_comp_reconciliation(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Earned (timesheet hours x DEP salary rate) vs paid (payroll W-2) per
    person — surfaces reasonable-comp gaps (owner underpaying via distributions)
    and owed wages (e.g. Ailsa). Period-aware."""
    from collections import defaultdict as _dd
    s, e = _accounting_period(start, end)

    def _pd(v: object):
        sv = str(v or "").strip()
        for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
            try:
                return datetime.strptime(sv, fmt).date()
            except ValueError:
                continue
        return None

    hrs = _dd(lambda: [0.0, 0.0])  # user_id -> [billable, nonbillable]
    for te in db.scalars(select(TimeEntry).where(TimeEntry.work_date >= s, TimeEntry.work_date <= e)).all():
        h = float(te.hours or 0)
        if te.is_billable:
            hrs[te.user_id][0] += h
        else:
            hrs[te.user_id][1] += h

    paid = _dd(float)  # payroll "Last, First" (lower) -> gross in period
    try:
        inbox = Path(get_settings().FRESHBOOKS_TRANSITION_DIR).expanduser()
        if inbox.exists():
            for _fn, _yr, parsed in _iter_parsed_payroll(inbox):
                for p in parsed.get("periods", []):
                    d = _pd(p.get("pay_day"))
                    if d is None or d < s or d > e:
                        continue
                    for r in p.get("rows", []):
                        paid[(r.get("employee") or "").lower()] += float(r.get("gross") or 0)
    except Exception:
        pass

    def paid_for(full_name: str) -> float:
        toks = [t for t in (full_name or "").lower().replace(".", "").split() if len(t) >= 3]
        if not toks:
            return 0.0
        first, last = toks[0], toks[-1]
        return sum(v for k, v in paid.items() if last in k and first[:4] in k)

    rows = []
    for u in db.scalars(select(User)).all():
        b, nb = hrs.get(u.id, [0.0, 0.0])
        if b + nb <= 0:
            continue
        rate = _salary_rate_for(u.full_name or "")
        earned = (b + nb) * rate
        pd_paid = paid_for(u.full_name or "")
        rows.append({
            "name": u.full_name, "billable": round(b, 1), "nonbillable": round(nb, 1),
            "total_hours": round(b + nb, 1), "rate": rate,
            "earned": round(earned, 2), "paid": round(pd_paid, 2), "gap": round(earned - pd_paid, 2),
        })
    rows.sort(key=lambda r: -r["gap"])
    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "rows": rows,
        "total_earned": round(sum(r["earned"] for r in rows), 2),
        "total_paid": round(sum(r["paid"] for r in rows), 2),
        "total_gap": round(sum(r["gap"] for r in rows), 2),
    }


@app.get("/accounting/balance-sheet")
def accounting_balance_sheet(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Balance sheet snapshot. Liabilities are Σ Loan.principal_current.
    Cash assets come from BankAccount.current_balance where available.
    AR = Σ Invoice.balance_due where balance_due > 0.
    Equity is the plug (assets − liabilities).
    """
    cash = float(db.scalar(
        select(func.coalesce(func.sum(BankAccount.current_balance), 0.0))
        .where(BankAccount.is_business.is_(True))
    ) or 0.0)
    ar = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.balance_due), 0.0))
        .where(Invoice.balance_due > 0)
        .where(Invoice.status.notin_(["void", "draft", "written_off"]))
    ) or 0.0)
    loans_principal = float(db.scalar(
        select(func.coalesce(func.sum(Loan.principal_current), 0.0))
        .where(Loan.is_active.is_(True))
    ) or 0.0)
    total_assets = cash + ar
    total_liabilities = loans_principal
    equity = total_assets - total_liabilities
    return {
        "as_of": date.today().isoformat(),
        "assets": {
            "cash": cash,
            "accounts_receivable": ar,
            "total": total_assets,
        },
        "liabilities": {
            "loans_outstanding": loans_principal,
            "total": total_liabilities,
        },
        "equity": equity,
        "notes": [
            "Cash from BankAccount.current_balance where set; many imported accounts may show 0.",
            "AR = sum of unpaid invoice balances.",
            "Liabilities = current loan principal balances. Add loans in the Loans tab to populate.",
            "Equity is computed as Assets − Liabilities (plug).",
        ],
    }


@app.get("/payroll/journal/summary")
def payroll_journal_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Parse all payroll journals in the FB inbox and return a per-year summary.

    Sources: legacy Gusto ``*payroll-summary*.csv`` files and Paychex
    ``Payroll Journal`` PDFs (auto-detected). For an engineering consulting
    business: every dollar of Employer Cost is COGS.
    """
    _ = current_user, db
    inbox = Path(settings.FRESHBOOKS_TRANSITION_DIR).expanduser()
    if not inbox.exists():
        raise HTTPException(status_code=404, detail=f"Inbox folder not found: {inbox}")

    out: dict[str, object] = {"by_year": {}, "all_periods": [], "all_employees": {}, "yearly_ytd": {}}

    def _zero() -> dict[str, float]:
        return {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0,
                "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0}

    _year_emps: dict[str, set] = {}
    # NOTE: a single year can have MULTIPLE source files (e.g. 2026 = Gusto CSV
    # through the switch + Paychex PDF after). Accumulate across files per year —
    # do NOT overwrite, or one source's totals get dropped from the summary.
    for fname, year_label, parsed in _iter_parsed_payroll(inbox):
        if parsed.get("error") and not parsed.get("periods"):
            by = out["by_year"].setdefault(year_label, {"file": "", "period_count": 0, "employee_count": 0, "totals": _zero()})
            by["error"] = str(parsed["error"])[:200]
            continue
        by = out["by_year"].setdefault(year_label, {"file": "", "period_count": 0, "employee_count": 0, "totals": _zero()})
        by["file"] = f'{by["file"]}, {fname}'.strip(", ") if by["file"] else fname
        by["period_count"] += len(parsed["periods"])
        ye = _year_emps.setdefault(year_label, set())
        ye.update(parsed["employees"].keys())
        by["employee_count"] = len(ye)
        for k in by["totals"]:
            by["totals"][k] += float(parsed["totals"].get(k, 0) or 0)
        if parsed.get("warning"):
            by["warning"] = f'{by.get("warning", "")}; {parsed["warning"]}'.strip("; ")
        # yearly_ytd: sum across all files for the year
        ytd = out["yearly_ytd"].setdefault(year_label, _zero())
        for k in ytd:
            ytd[k] += float(parsed["totals"].get(k, 0) or 0)
        for emp, vals in parsed["employees"].items():
            cur = out["all_employees"].setdefault(
                emp, {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0, "by_year": {}}
            )
            for k in ("gross", "employer_taxes", "employer_401k", "employer_cost", "net_pay", "hours"):
                cur[k] += float(vals.get(k, 0) or 0)
            eby = cur["by_year"].setdefault(year_label, _zero())
            for k in ("gross", "employer_taxes", "employer_401k", "employer_cost", "net_pay", "hours"):
                eby[k] += float(vals.get(k, 0) or 0)
        for p in parsed["periods"]:
            out["all_periods"].append({**p, "year": year_label, "file": fname})

    # Grand total across years
    grand = {"gross": 0.0, "employer_taxes": 0.0, "employer_401k": 0.0, "employer_cost": 0.0, "net_pay": 0.0, "hours": 0.0}
    for y, vals in out["yearly_ytd"].items():
        for k in grand:
            grand[k] += vals.get(k, 0.0)
    out["grand_total"] = grand
    out["treatment_note"] = (
        "Engineering consulting business — entire Employer Cost (gross wages + employer taxes + "
        "employer 401(k) match) is COGS. Employee tax withholdings and employee 401(k) deductions are "
        "already inside Gross, not separate company expense."
    )
    return out


def _bank_tx_source_file(tx: BankTransaction) -> str:
    try:
        return str((json.loads(tx.raw_json or "{}").get("source_file") or "")).lower()
    except Exception:
        return ""


def _bank_tx_origin(tx: BankTransaction) -> str:
    """Returns 'freshbooks' for FB-Expenses-Export rows, 'chase' for Chase rows, 'other' otherwise."""
    sf = _bank_tx_source_file(tx)
    if "freshbooks" in sf and ("expense" in sf or "expenses" in sf):
        return "freshbooks"
    if "chase" in sf:
        return "chase"
    return "other"


@app.get("/bank/dedup/analysis")
def bank_dedup_analysis(
    date_tolerance_days: int = Query(default=3, ge=0, le=30),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Detects FB Expenses-source rows that duplicate Chase-source rows.

    Match rule: same absolute amount (within $0.01) AND posted_date within
    +/- `date_tolerance_days`. FB-side rows are treated as duplicates when matched
    (Chase is the source-of-truth for cash flow). Unmatched FB rows are likely
    personal-paid-business expenses that haven't been reimbursed yet.
    """
    _ = current_user
    txs = db.scalars(select(BankTransaction)).all()
    fb_rows: list[BankTransaction] = []
    chase_rows: list[BankTransaction] = []
    for tx in txs:
        origin = _bank_tx_origin(tx)
        if origin == "freshbooks":
            fb_rows.append(tx)
        elif origin == "chase":
            chase_rows.append(tx)

    # Build a lookup of chase rows by absolute amount for fast O(N+M) match.
    chase_by_amt: dict[float, list[BankTransaction]] = {}
    for tx in chase_rows:
        if tx.posted_date is None:
            continue
        chase_by_amt.setdefault(round(abs(float(tx.amount or 0)), 2), []).append(tx)

    matched: list[dict[str, object]] = []
    unmatched: list[dict[str, object]] = []
    matched_amount = 0.0
    unmatched_amount = 0.0
    for fb in fb_rows:
        if fb.posted_date is None:
            continue
        fb_amt = round(abs(float(fb.amount or 0)), 2)
        candidates = chase_by_amt.get(fb_amt, [])
        best_match: BankTransaction | None = None
        best_delta = date_tolerance_days + 1
        for ch in candidates:
            if ch.posted_date is None:
                continue
            delta = abs((ch.posted_date - fb.posted_date).days)
            if delta < best_delta:
                best_delta = delta
                best_match = ch
        if best_match and best_delta <= date_tolerance_days:
            matched.append(
                {
                    "fb_id": fb.id,
                    "chase_id": best_match.id,
                    "fb_date": fb.posted_date.isoformat(),
                    "chase_date": best_match.posted_date.isoformat() if best_match.posted_date else None,
                    "amount_abs": fb_amt,
                    "fb_description": (fb.name or "")[:200],
                    "chase_description": (best_match.name or "")[:200],
                    "date_delta_days": best_delta,
                }
            )
            matched_amount += fb_amt
        else:
            _, fb_category = _tx_category_from_json(fb)
            unmatched.append(
                {
                    "fb_id": fb.id,
                    "posted_date": fb.posted_date.isoformat(),
                    "amount_abs": fb_amt,
                    "amount": float(fb.amount or 0),
                    "description": (fb.name or "")[:200],
                    "merchant": fb.merchant_name,
                    "category": fb_category,
                }
            )
            unmatched_amount += fb_amt

    # Sort unmatched by amount desc
    unmatched.sort(key=lambda r: -float(r["amount_abs"]))
    matched.sort(key=lambda r: -float(r["amount_abs"]))

    return {
        "fb_count": len(fb_rows),
        "chase_count": len(chase_rows),
        "matched_count": len(matched),
        "matched_total": matched_amount,
        "unmatched_count": len(unmatched),
        "unmatched_total": unmatched_amount,
        "tolerance_days": date_tolerance_days,
        "matched_sample": matched[:50],
        "unmatched": unmatched[:200],
    }


@app.get("/bank/transfers/pending")
def bank_transfers_pending(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Returns transfer-bucket bank transactions awaiting CPA adjudication, plus a
    per-year rollforward summary. Transfers are not tax-summary expenses; they
    move funds between accounts and require classification (loan / distribution /
    contribution / reimbursement / payroll / contractor / personal).
    """
    _ = current_user
    txs = db.scalars(select(BankTransaction)).all()
    transfer_txs: list[BankTransaction] = []
    for tx in txs:
        _, category = _tx_category_from_json(tx)
        if _is_transfer_category(category):
            transfer_txs.append(tx)

    # Per-year rollforward by account
    by_year_account: dict[tuple[int, str], dict[str, float]] = {}
    by_category: dict[str, dict[str, float]] = {}
    for tx in transfer_txs:
        if not tx.posted_date:
            continue
        year = tx.posted_date.year
        acct = tx.account_id or "?"
        amt = float(tx.amount or 0)
        key = (year, acct)
        bucket = by_year_account.setdefault(key, {"count": 0.0, "out": 0.0, "in": 0.0, "net": 0.0})
        bucket["count"] += 1
        if amt < 0:
            bucket["out"] += abs(amt)
        else:
            bucket["in"] += amt
        bucket["net"] += amt

        _, category = _tx_category_from_json(tx)
        cat_key = category or "Unclassified"
        cb = by_category.setdefault(cat_key, {"count": 0.0, "abs": 0.0, "net": 0.0})
        cb["count"] += 1
        cb["abs"] += abs(amt)
        cb["net"] += amt

    rollforward = [
        {
            "year": k[0],
            "account": k[1],
            "transaction_count": int(v["count"]),
            "outflow": v["out"],
            "inflow": v["in"],
            "net": v["net"],
        }
        for k, v in sorted(by_year_account.items())
    ]

    category_summary = [
        {
            "category": c,
            "transaction_count": int(v["count"]),
            "abs_amount": v["abs"],
            "net_amount": v["net"],
        }
        for c, v in sorted(by_category.items(), key=lambda kv: -kv[1]["abs"])
    ]

    # Recent transactions (limit 200 for UI)
    transfer_txs_sorted = sorted(
        transfer_txs,
        key=lambda t: (t.posted_date or date.min, abs(float(t.amount or 0))),
        reverse=True,
    )
    items = []
    for tx in transfer_txs_sorted[:200]:
        _, category = _tx_category_from_json(tx)
        items.append(
            {
                "id": tx.id,
                "posted_date": tx.posted_date.isoformat() if tx.posted_date else None,
                "account": tx.account_id,
                "amount": float(tx.amount or 0),
                "description": (tx.name or "")[:300],
                "merchant": tx.merchant_name,
                "category": category,
                "needs_review": True,  # all transfers need review by definition
            }
        )

    return {
        "total_count": len(transfer_txs),
        "rollforward_by_year_account": rollforward,
        "by_category": category_summary,
        "items": items,
    }


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
        expense_group = _truncate_text(str(row.get("expense_group") or ""), 64)
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
            "expense_group": expense_group,
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

    email = payload.email.lower().strip()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if not user:
        user = User(
            email=email,
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
    email = payload.email.lower().strip()
    domain = email.split("@")[-1]
    if domain != settings.ALLOWED_GOOGLE_DOMAIN.lower():
        raise HTTPException(status_code=400, detail="Email domain is not allowed")

    user = db.scalar(select(User).where(func.lower(User.email) == email))
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


@app.patch("/projects/{project_id}/status", response_model=ProjectOut)
def update_project_status(
    project_id: int,
    payload: ProjectStatusUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectOut:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    new_status = payload.lifecycle_status.strip().lower()
    if new_status not in PROJECT_LIFECYCLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"lifecycle_status must be one of: {', '.join(PROJECT_LIFECYCLE_STATUSES)}",
        )
    project.lifecycle_status = new_status
    # Derived flag: only "active" lifecycle keeps is_active=True
    project.is_active = new_status == "active"
    if new_status == "completed":
        project.completed_date = payload.completed_date or project.completed_date or date.today()
    elif new_status == "active":
        project.completed_date = None
    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project.id,
        action="lifecycle_status",
        actor_user_id=actor.id,
        payload={
            "lifecycle_status": new_status,
            "completed_date": project.completed_date.isoformat() if project.completed_date else None,
        },
    )
    db.commit()
    db.refresh(project)
    return _to_project_out(project)


def _to_project_member_out(db: Session, m: ProjectMember) -> ProjectMemberOut:
    user = db.get(User, m.user_id)
    return ProjectMemberOut(
        id=m.id,
        project_id=m.project_id,
        user_id=m.user_id,
        user_name=user.full_name if user else f"(deleted user {m.user_id})",
        user_email=user.email if user else "",
        role=m.role,
        allocation_pct=m.allocation_pct,
        start_date=m.start_date,
        end_date=m.end_date,
        notes=m.notes or "",
    )


@app.get("/projects/{project_id}/members", response_model=list[ProjectMemberOut])
def list_project_members(
    project_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ProjectMemberOut]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = (
        db.scalars(
            select(ProjectMember)
            .where(ProjectMember.project_id == project_id)
            .order_by(ProjectMember.role.asc(), ProjectMember.created_at.asc())
        ).all()
    )
    return [_to_project_member_out(db, m) for m in rows]


@app.post("/projects/{project_id}/members", response_model=ProjectMemberOut)
def add_project_member(
    project_id: int,
    payload: ProjectMemberCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectMemberOut:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    user = db.get(User, payload.user_id)
    if not user:
        raise HTTPException(status_code=400, detail="user_id does not exist")
    role = payload.role.strip()
    if not role:
        raise HTTPException(status_code=400, detail="Role required")
    existing = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == payload.user_id,
            ProjectMember.role == role,
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail=f"{user.full_name} already has role '{role}' on this project")
    m = ProjectMember(
        project_id=project_id,
        user_id=payload.user_id,
        role=role,
        allocation_pct=payload.allocation_pct,
        start_date=payload.start_date,
        end_date=payload.end_date,
        notes=payload.notes or "",
    )
    db.add(m)
    db.flush()
    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project_id,
        action="member_added",
        actor_user_id=actor.id,
        payload={"user_id": user.id, "user_name": user.full_name, "role": role},
    )
    db.commit()
    db.refresh(m)
    return _to_project_member_out(db, m)


@app.put("/projects/{project_id}/members/{member_id}", response_model=ProjectMemberOut)
def update_project_member(
    project_id: int,
    member_id: int,
    payload: ProjectMemberUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> ProjectMemberOut:
    m = db.get(ProjectMember, member_id)
    if not m or m.project_id != project_id:
        raise HTTPException(status_code=404, detail="Member not found on project")
    role = payload.role.strip()
    if not role:
        raise HTTPException(status_code=400, detail="Role required")
    m.role = role
    m.allocation_pct = payload.allocation_pct
    m.start_date = payload.start_date
    m.end_date = payload.end_date
    m.notes = payload.notes or ""
    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project_id,
        action="member_updated",
        actor_user_id=actor.id,
        payload={"member_id": member_id, "user_id": m.user_id, "role": role},
    )
    db.commit()
    db.refresh(m)
    return _to_project_member_out(db, m)


@app.delete("/projects/{project_id}/members/{member_id}")
def remove_project_member(
    project_id: int,
    member_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    m = db.get(ProjectMember, member_id)
    if not m or m.project_id != project_id:
        raise HTTPException(status_code=404, detail="Member not found on project")
    db.delete(m)
    _log_audit_event(
        db=db,
        entity_type="project",
        entity_id=project_id,
        action="member_removed",
        actor_user_id=actor.id,
        payload={"member_id": member_id, "user_id": m.user_id, "role": m.role},
    )
    db.commit()
    return {"status": "removed"}


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
    team: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TimeEntryOut]:
    target_user_id = current_user.id
    perms = permissions_for_role(current_user.role)
    # team=true → all users' entries (company-wide), for managers/finance. Used by the
    # dashboard "month hours" metric so it reflects the whole team, not just the viewer.
    company_wide = bool(team) and bool(
        {"MANAGE_USERS", "APPROVE_TIMESHEETS", "VIEW_FINANCIALS"} & set(perms)
    )
    if user_id is not None and user_id != current_user.id:
        if "MANAGE_USERS" not in perms and "APPROVE_TIMESHEETS" not in perms:
            raise HTTPException(status_code=403, detail="Missing permission to view another user's entries")
        target_user_id = user_id
    elif user_id is not None:
        target_user_id = user_id

    q = select(TimeEntry).where(and_(TimeEntry.work_date >= start, TimeEntry.work_date <= end))
    if not company_wide:
        q = q.where(TimeEntry.user_id == target_user_id)
    q = q.order_by(TimeEntry.work_date.asc(), TimeEntry.id.asc())
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
    note: str = Query(default="", max_length=2000),
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
            "note": note.strip(),
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
    include_pending: bool = True,
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
    normalized_status_filter = (status_filter or "").strip().lower()
    existing_pairs = {(int(ts.user_id), ts.week_start) for ts in sheets}
    user_ids = sorted({ts.user_id for ts in sheets})

    pending_rows: list[TimesheetAdminOut] = []
    if include_pending and normalized_status_filter in {"", "unsubmitted"}:
        entry_query = select(TimeEntry.user_id, TimeEntry.work_date)
        if start:
            entry_query = entry_query.where(TimeEntry.work_date >= start)
        if end:
            entry_query = entry_query.where(TimeEntry.work_date <= end)
        if user_id:
            entry_query = entry_query.where(TimeEntry.user_id == user_id)

        pending_pairs: set[tuple[int, date]] = set()
        for entry_user_id, work_date in db.execute(entry_query).all():
            ws = _week_start(work_date)
            we = ws + timedelta(days=6)
            if start and ws < start:
                continue
            if end and we > end:
                continue
            key = (int(entry_user_id), ws)
            if key in existing_pairs or key in pending_pairs:
                continue
            pending_pairs.add(key)

        if pending_pairs:
            user_ids.extend(uid for uid, _ in pending_pairs)

    users = db.scalars(select(User).where(User.id.in_(sorted(set(user_ids))) if user_ids else false())).all()
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
                has_record=True,
            )
        )

    if include_pending and normalized_status_filter in {"", "unsubmitted"}:
        pending_pairs = sorted(
            {
                (int(entry_user_id), _week_start(work_date))
                for entry_user_id, work_date in db.execute(entry_query).all()
                if (int(entry_user_id), _week_start(work_date)) not in existing_pairs
            },
            key=lambda pair: (pair[1], pair[0]),
            reverse=True,
        )
        seen_pending: set[tuple[int, date]] = set()
        for pending_user_id, ws in pending_pairs:
            if (pending_user_id, ws) in seen_pending:
                continue
            we = ws + timedelta(days=6)
            if start and ws < start:
                continue
            if end and we > end:
                continue
            seen_pending.add((pending_user_id, ws))
            user_row = user_map.get(pending_user_id)
            pending_rows.append(
                TimesheetAdminOut(
                    id=None,
                    user_id=pending_user_id,
                    week_start=ws,
                    week_end=we,
                    status="unsubmitted",
                    employee_signed_at=None,
                    supervisor_signed_at=None,
                    total_hours=_timesheet_hours(db, pending_user_id, ws, we),
                    user_email=user_row.email if user_row else "",
                    user_full_name=user_row.full_name if user_row else "",
                    has_record=False,
                )
            )

    out.extend(pending_rows)
    out.sort(key=lambda row: (row.week_start, row.user_full_name.lower(), row.user_id), reverse=True)
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
    # Revenue = actual BILLED invoices (real historical rates baked in) + unbilled WIP at
    # current rates. This matches FreshBooks' Profitability (billed + unbilled − costs) and
    # avoids mis-pricing historical hours that were billed at older (e.g. 2025) rates.
    billed_by_project: dict[int, float] = defaultdict(float)
    for inv in db.scalars(
        select(Invoice).where(
            Invoice.project_id.isnot(None),
            Invoice.status.notin_(["void", "draft", "written_off"]),
            Invoice.issue_date >= start,
            Invoice.issue_date <= end,
        )
    ).all():
        billed_by_project[int(inv.project_id)] += float(inv.subtotal_amount or 0.0)

    actual_by_project: dict[int, dict[str, float]] = {}
    for te in entries:
        project_ref = project_by_id.get(te.project_id)
        task_ref = task_by_id.get(te.task_id)
        is_billable = bool(project_ref.is_billable if project_ref else False) and bool(task_ref.is_billable if task_ref else False)
        row = actual_by_project.setdefault(te.project_id, {"actual_hours": 0.0, "actual_revenue": 0.0, "actual_cost": 0.0, "unbilled_wip": 0.0})
        row["actual_hours"] += float(te.hours)
        row["actual_cost"] += float(te.hours * te.cost_rate_applied)
        # Unbilled WIP: billable, FB-synced, not yet on an invoice → value at current rate.
        if is_billable and te.source == "freshbooks_api" and not bool(getattr(te, "billed", False)):
            row["unbilled_wip"] += float(te.hours * te.bill_rate_applied)
    # revenue = billed invoices + unbilled WIP
    for pid, row in actual_by_project.items():
        row["actual_revenue"] = billed_by_project.get(pid, 0.0) + row["unbilled_wip"]
    # projects with invoices but no time entries in range
    for pid, amt in billed_by_project.items():
        if pid not in actual_by_project:
            actual_by_project[pid] = {"actual_hours": 0.0, "actual_revenue": amt, "actual_cost": 0.0, "unbilled_wip": 0.0}

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
    by_project_rows = _unbilled_since_last_invoice_by_client_project(db)
    return {"as_of": date.today().isoformat(), "by_client": rows, "by_client_project": by_project_rows}


@app.get("/reports/unbilled-hours")
def unbilled_hours_report(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    """Two views of time entries that have NOT been billed yet:

    - **Unbilled (billable)** — entries flagged is_billable=True on billable
      projects that aren't on any non-void/non-draft invoice line. Counts toward
      "work-in-progress to bill."
    - **Non-billable** — entries flagged is_billable=False. Broken out by period
      (current month + year-to-date) so overhead/admin time is visible separately.

    Unbilled rule: TimeEntry.id NOT IN (SELECT InvoiceLine.source_time_entry_id
    WHERE Invoice.status NOT IN ('void','draft')).
    """
    invoiced_ids = {
        int(v) for v in db.scalars(
            select(InvoiceLine.source_time_entry_id)
            .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
            .where(and_(
                InvoiceLine.source_time_entry_id.is_not(None),
                Invoice.status.notin_(["void", "draft"]),
            ))
        ).all()
        if v is not None
    }

    users = {u.id: u for u in db.scalars(select(User)).all()}
    projects = {p.id: p for p in db.scalars(select(Project)).all()}

    today = date.today()
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)

    # Aggregators — keyed by (user_id) or (project_id)
    bill_emp_hrs: dict[int, float] = defaultdict(float)
    bill_emp_val: dict[int, float] = defaultdict(float)
    bill_prj_hrs: dict[int, float] = defaultdict(float)
    bill_prj_val: dict[int, float] = defaultdict(float)
    bill_tot_hrs = 0.0
    bill_tot_val = 0.0

    # Non-billable aggregators — split by period
    nb_month_emp: dict[int, float] = defaultdict(float)
    nb_month_prj: dict[int, float] = defaultdict(float)
    nb_ytd_emp: dict[int, float] = defaultdict(float)
    nb_ytd_prj: dict[int, float] = defaultdict(float)
    nb_month_total = 0.0
    nb_ytd_total = 0.0

    for te in db.scalars(select(TimeEntry)).all():
        if te.id in invoiced_ids:
            continue
        proj = projects.get(te.project_id)
        if proj is None:
            continue
        hours = float(te.hours or 0.0)
        rate = float(te.bill_rate_applied or 0.0)
        value = hours * rate

        is_billable_entry = bool(te.is_billable) and not proj.is_overhead and bool(proj.is_billable)
        # FB-synced billable entries already on an FB invoice (billed=True) aren't unbilled.
        # Manual entries have no FB flag (billed=False) and pass through here.
        if is_billable_entry and te.source == "freshbooks_api" and bool(getattr(te, "billed", False)):
            continue

        # Billable bucket: per-entry is_billable=True AND project is billable & not overhead
        if is_billable_entry:
            bill_emp_hrs[int(te.user_id)] += hours
            bill_emp_val[int(te.user_id)] += value
            bill_prj_hrs[int(te.project_id)] += hours
            bill_prj_val[int(te.project_id)] += value
            bill_tot_hrs += hours
            bill_tot_val += value
        else:
            # Non-billable bucket — include overhead projects + non-billable entries
            if te.work_date >= year_start:
                nb_ytd_emp[int(te.user_id)] += hours
                nb_ytd_prj[int(te.project_id)] += hours
                nb_ytd_total += hours
                if te.work_date >= month_start:
                    nb_month_emp[int(te.user_id)] += hours
                    nb_month_prj[int(te.project_id)] += hours
                    nb_month_total += hours

    def _employee_rows(emp_hrs: dict[int, float], emp_val: dict[int, float] | None = None) -> list[dict[str, object]]:
        rows = []
        for uid, hrs in emp_hrs.items():
            if hrs < 0.001:
                continue
            u = users.get(uid)
            row: dict[str, object] = {
                "user_id": uid,
                "name": u.full_name if u else f"user_{uid}",
                "email": u.email if u else "",
                "hours": round(hrs, 2),
            }
            if emp_val is not None:
                row["value"] = round(emp_val.get(uid, 0.0), 2)
            rows.append(row)
        rows.sort(key=lambda r: float(r["hours"]), reverse=True)  # type: ignore[arg-type]
        return rows

    def _project_rows(prj_hrs: dict[int, float], prj_val: dict[int, float] | None = None) -> list[dict[str, object]]:
        rows = []
        for pid, hrs in prj_hrs.items():
            if hrs < 0.001:
                continue
            p = projects.get(pid)
            row: dict[str, object] = {
                "project_id": pid,
                "project_name": p.name if p else f"project_{pid}",
                "client_name": p.client_name if p else "",
                "hours": round(hrs, 2),
            }
            if prj_val is not None:
                row["value"] = round(prj_val.get(pid, 0.0), 2)
            rows.append(row)
        rows.sort(key=lambda r: float(r["hours"]), reverse=True)  # type: ignore[arg-type]
        return rows

    return {
        "as_of": today.isoformat(),
        "billable": {
            "totals": {
                "hours": round(bill_tot_hrs, 2),
                "value": round(bill_tot_val, 2),
            },
            "by_employee": _employee_rows(bill_emp_hrs, bill_emp_val),
            "by_project": _project_rows(bill_prj_hrs, bill_prj_val),
        },
        "non_billable": {
            "current_month": {
                "period_start": month_start.isoformat(),
                "period_end": today.isoformat(),
                "label": today.strftime("%B %Y"),
                "totals": {"hours": round(nb_month_total, 2)},
                "by_employee": _employee_rows(nb_month_emp),
                "by_project": _project_rows(nb_month_prj),
            },
            "ytd": {
                "period_start": year_start.isoformat(),
                "period_end": today.isoformat(),
                "label": f"YTD {today.year}",
                "totals": {"hours": round(nb_ytd_total, 2)},
                "by_employee": _employee_rows(nb_ytd_emp),
                "by_project": _project_rows(nb_ytd_prj),
            },
        },
    }


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
    candidate_invoices = db.scalars(select(Invoice).where(Invoice.status.notin_(["void", "draft", "written_off"]))).all()
    invoices = [i for i in candidate_invoices if _invoice_open_balance(i) > 0.0001]
    total_invoiced = float(sum(float(i.subtotal_amount or 0.0) for i in candidate_invoices))
    total_paid_to_date = float(sum(float(i.amount_paid or 0.0) for i in candidate_invoices))
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
        key = _canonical_client_name(i.client_name)
        row = by_client.setdefault(key, {"client_name": key, "invoice_count": 0, "outstanding": 0.0, "overdue": 0.0})
        row["invoice_count"] = int(row["invoice_count"]) + 1
        row["outstanding"] = float(row["outstanding"]) + bal
        if i.due_date and i.due_date < today:
            row["overdue"] = float(row["overdue"]) + bal

    top_clients = sorted(by_client.values(), key=lambda r: float(r["outstanding"]), reverse=True)[:10]
    return {
        "as_of": today.isoformat(),
        "invoice_count_total": len(candidate_invoices),
        "total_invoiced": total_invoiced,
        "total_paid_to_date": total_paid_to_date,
        "invoice_count_open": len(invoices),
        "total_outstanding": total_outstanding,
        "overdue_invoice_count": len(overdue),
        "overdue_total": overdue_total,
        "aging": aging,
        "top_clients": top_clients,
    }


@app.get("/reports/invoice-revenue-status")
def invoice_revenue_status(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    summary = ar_summary(db=db, _=_)
    unbilled_rows = _unbilled_since_last_invoice_by_client(db)
    unbilled_project_rows = _unbilled_since_last_invoice_by_client_project(db)
    unbilled_total = float(sum(float(r.get("unbilled", 0.0)) for r in unbilled_rows))
    # Period-scoped FLOWS (distinct from the lifetime/current balances below):
    #   invoiced_period  = subtotals of invoices issued in the period (accrual)
    #   collected_period = payments received in the period (cash)
    s, e = _accounting_period(start, end)
    invoiced_period = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.subtotal_amount), 0.0))
        .where(Invoice.issue_date.isnot(None), Invoice.issue_date >= s, Invoice.issue_date <= e,
               func.lower(func.coalesce(Invoice.status, "")) != "draft")
    ) or 0.0)
    collected_period = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.amount_paid), 0.0))
        .where(Invoice.paid_date.isnot(None), Invoice.paid_date >= s, Invoice.paid_date <= e)
    ) or 0.0)
    # BOC-financed receivables: BOC advances ~70% against these invoices (a recourse
    # LOAN per BOC's loan statements, not a client payment). The client still owes the
    # full amount, but the firm's NET receivable is the ~30% reserve. We expose AR net
    # of the BOC advances (matches FreshBooks' "outstanding") WITHOUT booking loan
    # proceeds as revenue. Financed set per Bertrand 2026-06; extend as new invoices
    # are financed.
    BOC_FINANCED = ("HDRAQ-013B", "HDRAQ13-A", "HDRAQ-014", "HDRAQ-015", "WSMV009")
    boc_advances = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.balance_due * 0.70), 0.0))
        .where(Invoice.invoice_number.in_(BOC_FINANCED))
    ) or 0.0)
    _total_out = float(summary.get("total_outstanding", 0.0))
    return {
        "as_of": date.today().isoformat(),
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "invoiced_period": invoiced_period,
        "collected_period": collected_period,
        "boc_financed_advances": round(boc_advances, 2),
        "outstanding_net_of_boc": round(_total_out - boc_advances, 2),
        "invoice_count_total": int(summary.get("invoice_count_total", 0)),
        "invoice_count_open": int(summary.get("invoice_count_open", 0)),
        "total_invoiced": float(summary.get("total_invoiced", 0.0)),
        "total_paid_to_date": float(summary.get("total_paid_to_date", 0.0)),
        "total_outstanding": float(summary.get("total_outstanding", 0.0)),
        "overdue_invoice_count": int(summary.get("overdue_invoice_count", 0)),
        "overdue_total": float(summary.get("overdue_total", 0.0)),
        "aging": summary.get("aging", {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "90_plus": 0.0}),
        "earned_not_billed_total": unbilled_total,
        "unbilled_by_client": unbilled_rows,
        "unbilled_by_client_project": unbilled_project_rows,
        "top_clients": summary.get("top_clients", []),
    }


@app.get("/reports/payroll-hours")
def payroll_hours_report(
    start_from: date = Query(default=date(2024, 1, 1)),
    period_end: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("VIEW_FINANCIALS")),
) -> dict[str, object]:
    today = date.today()
    _, current_end = pay_period_for(today)
    selected_end = period_end or current_end
    selected_start = selected_end - timedelta(days=13)

    first_start, first_end = pay_period_for(start_from)
    if first_start < start_from:
        first_start = first_start + timedelta(days=14)
        first_end = first_end + timedelta(days=14)

    entries = db.scalars(
        select(TimeEntry).where(and_(TimeEntry.work_date >= first_start, TimeEntry.work_date <= current_end))
    ).all()
    active_users = db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.full_name.asc(), User.email.asc())).all()
    rates = db.scalars(select(UserRate).order_by(UserRate.user_id.asc(), UserRate.effective_date.asc())).all()
    rates_by_user: dict[int, list[UserRate]] = defaultdict(list)
    for rate in rates:
        rates_by_user[int(rate.user_id)].append(rate)

    period_hours_total: dict[date, float] = defaultdict(float)
    period_hours_by_user: dict[tuple[date, int], float] = defaultdict(float)
    for te in entries:
        _, pend = pay_period_for(te.work_date)
        period_hours_total[pend] += float(te.hours)
        period_hours_by_user[(pend, int(te.user_id))] += float(te.hours)

    periods: list[dict[str, object]] = []
    pend = first_end
    while pend <= current_end:
        pstart = pend - timedelta(days=13)
        periods.append(
            {
                "period_start": pstart.isoformat(),
                "period_end": pend.isoformat(),
                "label": f"{pstart.isoformat()} to {pend.isoformat()}",
                "total_hours": float(period_hours_total.get(pend, 0.0)),
                "employee_count": int(
                    len({uid for (period_key, uid), hrs in period_hours_by_user.items() if period_key == pend and hrs > 0.0001})
                ),
            }
        )
        pend += timedelta(days=14)

    rows: list[dict[str, object]] = []
    for user in active_users:
        latest_rate = _latest_rate_for_date(rates_by_user.get(int(user.id), []), selected_end)
        rows.append(
            {
                "user_id": int(user.id),
                "employee": user.full_name or user.email,
                "email": user.email,
                "hours": float(period_hours_by_user.get((selected_end, int(user.id)), 0.0)),
                "cost_rate": float(latest_rate.cost_rate) if latest_rate else None,
                "bill_rate": float(latest_rate.bill_rate) if latest_rate else None,
            }
        )
    rows.sort(key=lambda r: str(r["employee"]).lower())

    return {
        "as_of": today.isoformat(),
        "current_period_start": (current_end - timedelta(days=13)).isoformat(),
        "current_period_end": current_end.isoformat(),
        "selected_period_start": selected_start.isoformat(),
        "selected_period_end": selected_end.isoformat(),
        "periods": periods,
        "rows": rows,
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
    payments_file: UploadFile | None = File(default=None),
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
    line_total_cols = _time_cols("line_total", INVOICE_LINE_TOTAL_COLUMNS, overrides)
    paid_cols = _time_cols("amount_paid", INVOICE_PAID_COLUMNS, overrides)
    balance_cols = _time_cols("balance_due", INVOICE_BALANCE_COLUMNS, overrides)

    imported = 0
    updated = 0
    skipped = 0
    errors = 0
    rows_out: list[LegacyInvoiceImportRowOut] = []

    # Aggregate line-item exports to invoice-level rows.
    agg_by_invoice: dict[str, dict[str, object]] = {}
    line_item_mode = False
    for row_index, row in enumerate(reader, start=2):
        invoice_number_raw = (_first_value(row, no_cols) or "").strip()
        line_total = _parse_float(_first_value(row, line_total_cols))
        total_amount = _parse_float(_first_value(row, total_cols))
        row_amount = line_total if line_total is not None else total_amount
        if line_total is not None:
            line_item_mode = True

        issue_date = _parse_flexible_date(_first_value(row, issue_cols))
        due_date = _parse_flexible_date(_first_value(row, due_cols))
        status = _normalize_invoice_status(_first_value(row, status_cols))
        amount_paid = _parse_float(_first_value(row, paid_cols))
        balance_due = _parse_float(_first_value(row, balance_cols))
        client_name = _normalize_import_client_name((_first_value(row, client_cols) or "Unassigned Client").strip())

        seed = f"{client_name}|{issue_date}|{due_date}|{row_index}"
        invoice_number = invoice_number_raw or f"LEG-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:10].upper()}"
        agg = agg_by_invoice.setdefault(
            invoice_number,
            {
                "row_number": row_index,
                "invoice_number": invoice_number,
                "client_name": client_name,
                "issue_date": issue_date,
                "due_date": due_date,
                "status": status,
                "total_amount": 0.0 if row_amount is not None else None,
                "amount_paid": amount_paid,
                "balance_due": balance_due,
            },
        )
        if issue_date and (agg["issue_date"] is None):
            agg["issue_date"] = issue_date
        if due_date and (agg["due_date"] is None):
            agg["due_date"] = due_date
        if str(agg.get("client_name") or "").strip() in {"", "Unassigned Client"}:
            agg["client_name"] = client_name
        if status == "paid":
            agg["status"] = "paid"
        elif str(agg.get("status") or "") not in {"paid", "partial"} and status:
            agg["status"] = status
        if row_amount is not None:
            base_total = float(agg["total_amount"] or 0.0)
            agg["total_amount"] = base_total + float(row_amount)
        if amount_paid is not None:
            prev_paid = agg.get("amount_paid")
            agg["amount_paid"] = max(float(prev_paid or 0.0), float(amount_paid))
        if balance_due is not None:
            prev_balance = agg.get("balance_due")
            agg["balance_due"] = max(float(prev_balance or 0.0), float(balance_due))

    # Optional payments sidecar file (exported payments_collected CSV).
    payment_amount_by_invoice: dict[str, float] = {}
    payment_date_by_invoice: dict[str, date] = {}
    payment_rows_count = 0
    if payments_file is not None:
        raw_payments = await payments_file.read()
        if raw_payments:
            payment_reader = csv.DictReader(io.StringIO(raw_payments.decode("utf-8-sig")))
            payment_date_cols = _time_cols("payment_date", PAYMENT_DATE_COLUMNS, overrides)
            payment_no_cols = _time_cols("payment_invoice_number", PAYMENT_INVOICE_NO_COLUMNS, overrides)
            payment_amount_cols = _time_cols("payment_amount", PAYMENT_AMOUNT_COLUMNS, overrides)
            for prow in payment_reader:
                payment_rows_count += 1
                inv_no = (_first_value(prow, payment_no_cols) or "").strip()
                if not inv_no:
                    continue
                pay_amount = _parse_float(_first_value(prow, payment_amount_cols))
                pay_date = _parse_flexible_date(_first_value(prow, payment_date_cols))
                if pay_amount is None or pay_amount <= 0:
                    continue
                payment_amount_by_invoice[inv_no] = float(payment_amount_by_invoice.get(inv_no, 0.0)) + float(pay_amount)
                if pay_date:
                    cur = payment_date_by_invoice.get(inv_no)
                    if cur is None or pay_date > cur:
                        payment_date_by_invoice[inv_no] = pay_date

    payments_matched_invoices = 0
    for invoice_number, agg in agg_by_invoice.items():
        issue_date = agg.get("issue_date") or date.today()
        due_date = agg.get("due_date") or (issue_date + timedelta(days=30))
        total_amount = agg.get("total_amount")
        amount_paid = agg.get("amount_paid")
        balance_due = agg.get("balance_due")

        if total_amount is None:
            if amount_paid is None and balance_due is None:
                rows_out.append(
                    LegacyInvoiceImportRowOut(
                        row_number=int(agg["row_number"]),
                        invoice_number=str(invoice_number),
                        client_name=str(agg["client_name"]),
                        issue_date=issue_date.isoformat() if issue_date else None,
                        due_date=due_date.isoformat() if due_date else None,
                        total_amount=None,
                        amount_paid=None,
                        balance_due=None,
                        status="error",
                        reason="Missing amount fields (total/line total/paid/balance)",
                    )
                )
                errors += 1
                continue
            total_amount = float((amount_paid or 0.0) + (balance_due or 0.0))

        if invoice_number in payment_amount_by_invoice:
            amount_paid = float(payment_amount_by_invoice[invoice_number])
            payments_matched_invoices += 1
        if amount_paid is None and balance_due is None:
            amount_paid = 0.0
        elif amount_paid is None:
            amount_paid = max(float(total_amount) - float(balance_due or 0.0), 0.0)
        if balance_due is None:
            balance_due = max(float(total_amount) - float(amount_paid or 0.0), 0.0)

        amount_paid = max(float(amount_paid or 0.0), 0.0)
        balance_due = max(float(balance_due or 0.0), 0.0)
        status = _status_from_amounts(
            status=str(agg.get("status") or "sent"),
            total_amount=float(total_amount),
            amount_paid=amount_paid,
            balance_due=balance_due,
        )
        client_name = _normalize_import_client_name(str(agg.get("client_name") or "Unassigned Client"))
        project_id_inferred = _infer_project_id_for_client_name(db, client_name)
        paid_date_from_payments = payment_date_by_invoice.get(invoice_number)

        existing = db.scalar(select(Invoice).where(Invoice.invoice_number == invoice_number))
        operation = "updated" if existing else "imported"
        if not apply:
            rows_out.append(
                LegacyInvoiceImportRowOut(
                    row_number=int(agg["row_number"]),
                    invoice_number=str(invoice_number),
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
                invoice_number=str(invoice_number),
                project_id=project_id_inferred,
                client_name=client_name,
                start_date=issue_date,
                end_date=issue_date,
                issue_date=issue_date,
                due_date=due_date,
                status=status,
                source="freshbooks",
                subtotal_amount=float(total_amount),
                amount_paid=amount_paid,
                balance_due=balance_due,
                total_cost=0.0,
                total_profit=float(total_amount),
                paid_date=(paid_date_from_payments or issue_date) if amount_paid > 0.0001 else None,
                notes="Imported from FreshBooks invoices",
            )
            db.add(existing)
            db.flush()
            db.add(
                InvoiceLine(
                    invoice_id=existing.id,
                    source_time_entry_id=None,
                    work_date=issue_date,
                    user_id=None,
                    project_id=existing.project_id,
                    task_id=None,
                    subtask_id=None,
                    description="Legacy imported invoice total",
                    note="Imported from FreshBooks invoices",
                    hours=1.0,
                    bill_rate=float(total_amount),
                    amount=float(total_amount),
                )
            )
            imported += 1
        else:
            existing.project_id = existing.project_id if existing.project_id is not None else project_id_inferred
            existing.client_name = client_name
            existing.start_date = issue_date
            existing.end_date = issue_date
            existing.issue_date = issue_date
            existing.due_date = due_date
            existing.status = status
            existing.source = "freshbooks"
            existing.subtotal_amount = float(total_amount)
            existing.amount_paid = amount_paid
            existing.balance_due = balance_due
            existing.paid_date = (paid_date_from_payments or existing.paid_date or issue_date) if amount_paid > 0.0001 else None
            has_lines = db.scalar(select(func.count(InvoiceLine.id)).where(InvoiceLine.invoice_id == existing.id)) or 0
            if int(has_lines) == 0:
                db.add(
                    InvoiceLine(
                        invoice_id=existing.id,
                        source_time_entry_id=None,
                        work_date=issue_date,
                        user_id=None,
                        project_id=existing.project_id,
                        task_id=None,
                        subtask_id=None,
                        description="Legacy imported invoice total",
                        note="Imported from FreshBooks invoices",
                        hours=1.0,
                        bill_rate=float(total_amount),
                        amount=float(total_amount),
                    )
                )
            updated += 1

        rows_out.append(
            LegacyInvoiceImportRowOut(
                row_number=int(agg["row_number"]),
                invoice_number=str(invoice_number),
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
            payload={
                "imported": imported,
                "updated": updated,
                "errors": errors,
                "line_item_mode": line_item_mode,
                "payment_rows": payment_rows_count,
                "payments_matched_invoices": payments_matched_invoices,
            },
        )
        db.commit()

    return {
        "apply": apply,
        "count": len(rows_out),
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "line_item_mode": line_item_mode,
        "payment_rows": payment_rows_count,
        "payments_matched_invoices": payments_matched_invoices,
        "rows": [r.model_dump() for r in rows_out],
    }


@app.post("/invoices/import/freshbooks-payments")
async def import_legacy_payments(
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
    payment_date_cols = _time_cols("payment_date", PAYMENT_DATE_COLUMNS, overrides)
    payment_no_cols = _time_cols("payment_invoice_number", PAYMENT_INVOICE_NO_COLUMNS, overrides)
    payment_amount_cols = _time_cols("payment_amount", PAYMENT_AMOUNT_COLUMNS, overrides)

    aggregated: dict[str, dict[str, object]] = {}
    rows_out: list[LegacyPaymentImportRowOut] = []
    row_errors = 0
    for row_index, row in enumerate(reader, start=2):
        invoice_number = (_first_value(row, payment_no_cols) or "").strip()
        amount = _parse_float(_first_value(row, payment_amount_cols))
        payment_date = _parse_flexible_date(_first_value(row, payment_date_cols))
        if not invoice_number:
            rows_out.append(
                LegacyPaymentImportRowOut(
                    row_number=row_index,
                    invoice_number="",
                    payment_date=payment_date.isoformat() if payment_date else None,
                    amount=amount,
                    status="error",
                    reason="Missing invoice number",
                )
            )
            row_errors += 1
            continue
        if amount is None or amount <= 0:
            rows_out.append(
                LegacyPaymentImportRowOut(
                    row_number=row_index,
                    invoice_number=invoice_number,
                    payment_date=payment_date.isoformat() if payment_date else None,
                    amount=amount,
                    status="error",
                    reason="Missing or non-positive payment amount",
                )
            )
            row_errors += 1
            continue
        agg = aggregated.setdefault(invoice_number, {"amount": 0.0, "payment_date": payment_date, "row_number": row_index})
        agg["amount"] = float(agg["amount"]) + float(amount)
        if payment_date:
            cur = agg.get("payment_date")
            if cur is None or payment_date > cur:
                agg["payment_date"] = payment_date

    matched = 0
    unmatched = 0
    updated = 0
    for invoice_number, agg in aggregated.items():
        amount = float(agg["amount"])
        payment_date = agg.get("payment_date")
        inv = db.scalar(select(Invoice).where(Invoice.invoice_number == invoice_number))
        if not inv:
            unmatched += 1
            rows_out.append(
                LegacyPaymentImportRowOut(
                    row_number=int(agg["row_number"]),
                    invoice_number=invoice_number,
                    payment_date=payment_date.isoformat() if payment_date else None,
                    amount=amount,
                    status="unmatched",
                    reason="Invoice not found",
                )
            )
            continue
        matched += 1
        new_paid = max(0.0, amount)
        new_balance = max(float(inv.subtotal_amount or 0.0) - new_paid, 0.0)
        new_status = _status_from_amounts(
            status=str(inv.status or "sent"),
            total_amount=float(inv.subtotal_amount or 0.0),
            amount_paid=new_paid,
            balance_due=new_balance,
        )
        if apply:
            inv.amount_paid = new_paid
            inv.balance_due = new_balance
            inv.status = new_status
            inv.paid_date = payment_date if new_paid > 0.0001 else None
            updated += 1
        rows_out.append(
            LegacyPaymentImportRowOut(
                row_number=int(agg["row_number"]),
                invoice_number=invoice_number,
                payment_date=payment_date.isoformat() if payment_date else None,
                amount=amount,
                status="ready" if not apply else "updated",
                reason=None,
            )
        )

    if apply:
        _log_audit_event(
            db=db,
            entity_type="invoice",
            entity_id=0,
            action="import_legacy_payments",
            actor_user_id=current_user.id,
            payload={
                "updated": updated,
                "matched": matched,
                "unmatched": unmatched,
                "row_errors": row_errors,
            },
        )
        db.commit()

    return {
        "apply": apply,
        "count": len(aggregated),
        "updated": updated,
        "matched": matched,
        "unmatched": unmatched,
        "errors": row_errors,
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
        # Unbilled WIP (billable, FB-synced, not yet invoiced) valued at current rate.
        if is_billable and te.source == "freshbooks_api" and not bool(getattr(te, "billed", False)):
            project["unbilled_wip"] = float(project.get("unbilled_wip", 0.0)) + revenue

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

    # Project cost = LABOR only (hours × cost rate), matching FreshBooks Profitability.
    # Company-wide expenses (the FB expense import) live in the P&L OpEx, NOT in project
    # cost — keep expense_cost as an informational field but exclude it from cost/profit.
    for ex in expenses:
        project = by_project.get(ex.project_id)
        if not project:
            continue
        project["expense_cost"] = float(project["expense_cost"]) + float(ex.amount or 0.0)

    # Billed revenue per project from actual invoices (real historical rates baked in).
    billed_by_project: dict[int, float] = defaultdict(float)
    for inv in db.scalars(
        select(Invoice).where(
            Invoice.project_id.isnot(None),
            Invoice.status.notin_(["void", "draft", "written_off"]),
            Invoice.issue_date >= start,
            Invoice.issue_date <= end,
        )
    ).all():
        billed_by_project[int(inv.project_id)] += float(inv.subtotal_amount or 0.0)

    rows: list[dict[str, object]] = []
    for p in projects:
        row = by_project[p.id]
        # Revenue = billed invoices + unbilled WIP — matches FreshBooks Profitability and
        # avoids pricing historical (e.g. 2025) hours at current rates. by_employee/by_task
        # stay at hours×rate as a productivity view.
        if bool(p.is_billable):
            row["actual_revenue"] = billed_by_project.get(p.id, 0.0) + float(row.get("unbilled_wip", 0.0))
            row["actual_profit"] = float(row["actual_revenue"]) - float(row["actual_cost"])
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


def _unbilled_since_last_invoice_by_client_project(db: Session) -> list[dict[str, object]]:
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

    time_entries = db.scalars(select(TimeEntry)).all()
    user_ids = sorted({te.user_id for te in time_entries})
    week_starts = sorted({_week_start(te.work_date) for te in time_entries})
    timesheet_status_by_week: dict[tuple[int, date], str] = {}
    if user_ids and week_starts:
        timesheets = db.scalars(
            select(Timesheet).where(and_(Timesheet.user_id.in_(user_ids), Timesheet.week_start.in_(week_starts)))
        ).all()
        timesheet_status_by_week = {
            (int(ts.user_id), ts.week_start): str(ts.status or "").strip().lower()
            for ts in timesheets
        }

    by_project_unbilled: dict[int, float] = defaultdict(float)
    by_project_hours: dict[int, float] = defaultdict(float)
    for te in time_entries:
        project_ref = projects_by_id.get(te.project_id)
        if not project_ref:
            continue
        task_ref = tasks_by_id.get(te.task_id)
        # Billable requires the project, the task, AND the entry's own flag (which mirrors
        # FreshBooks' per-entry `billable`). A billable project can still have non-billable
        # entries, so all three must hold.
        is_billable = (
            bool(project_ref.is_billable)
            and bool(task_ref.is_billable if task_ref else False)
            and bool(getattr(te, "is_billable", True))
        )
        if not is_billable:
            continue
        if te.id in invoiced_time_entry_ids:
            continue
        # FB-synced entries use FreshBooks' authoritative `billed` flag (True once on an FB
        # invoice). Manual entries have no FB flag, so fall back to the per-project
        # last-invoice-date cutoff. This keeps the FB-of-record result while still
        # supporting time entered directly in the app.
        if te.source == "freshbooks_api":
            if bool(getattr(te, "billed", False)):
                continue
        else:
            cutoff = last_invoice_end_by_project.get(int(te.project_id))
            if cutoff is not None and te.work_date <= cutoff:
                continue
        week_status = timesheet_status_by_week.get((int(te.user_id), _week_start(te.work_date)))
        if week_status and week_status not in COMPLETED_TIMESHEET_STATUS_VALUES:
            continue
        by_project_unbilled[te.project_id] += float(te.hours * te.bill_rate_applied)
        by_project_hours[te.project_id] += float(te.hours)

    rows: list[dict[str, object]] = []
    for project_id, amount in by_project_unbilled.items():
        if amount <= 0.0001:
            continue
        project_ref = projects_by_id.get(project_id)
        if not project_ref:
            continue
        client_name = _canonical_client_name(project_ref.client_name)
        rows.append(
            {
                "client_name": client_name,
                "project_id": int(project_ref.id),
                "project_name": project_ref.name,
                "work_hours": float(by_project_hours.get(project_id, 0.0)),
                "unbilled": float(amount),
            }
        )
    return sorted(rows, key=lambda r: float(r["unbilled"]), reverse=True)


def _unbilled_since_last_invoice_by_client(db: Session) -> list[dict[str, object]]:
    by_project_rows = _unbilled_since_last_invoice_by_client_project(db)
    by_client: dict[str, dict[str, object]] = {}
    for row in by_project_rows:
        client_name = str(row.get("client_name") or "Unassigned Client")
        agg = by_client.setdefault(client_name, {"client_name": client_name, "unbilled": 0.0, "project_count": 0, "work_hours": 0.0})
        agg["unbilled"] = float(agg["unbilled"]) + float(row.get("unbilled", 0.0))
        agg["project_count"] = int(agg["project_count"]) + 1
        agg["work_hours"] = float(agg["work_hours"]) + float(row.get("work_hours", 0.0))
    return sorted(by_client.values(), key=lambda r: float(r["unbilled"]), reverse=True)


def _canonical_client_name(name: str | None) -> str:
    clean = str(name or "").strip()
    if not clean:
        return "Unassigned Client"
    lower = clean.lower()
    if lower in {"imported client", "legacy client", "unmapped imported work", "historical legacy client"}:
        return "Unassigned Client"
    if lower == "hdr":
        return "HDR"
    if lower == "woodard and curran":
        return "Woodard & Curran"
    if lower == "nycdep-bepa":
        return "NYCDEP-BEPA"
    if lower == "stantecjv":
        return "Stantec + Brown & Caldwell"
    return clean


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
    client_cols = _time_cols("client_name", TIME_CLIENT_COLUMNS, overrides)
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
        client_name = _normalize_import_client_name(_first_value(row, client_cols) or "Imported Client")
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
            if (
                str(project_name or "").strip().lower() in {"no project", "imported project"}
                and str(task_name or "").strip().lower() in {"no service", "general"}
                and str(subtask_name or "").strip().lower() in {"no service", "general"}
            ):
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
                        reason="Placeholder zero-hour row",
                    )
                )
                skipped += 1
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
                user = User(
                    email=employee_email,
                    full_name=_normalize_person_name(employee_raw) or employee_email.split("@")[0],
                    role="employee",
                    is_active=True,
                )
                db.add(user)
                db.flush()
            elif not user.is_active:
                user.is_active = True
            if employee_raw and _normalize_person_name(employee_raw) and user.full_name != _normalize_person_name(employee_raw):
                user.full_name = _normalize_person_name(employee_raw)
            users_cache[employee_email] = user

        project = projects_cache.get(project_name.lower())
        if not project:
            project = db.scalar(select(Project).where(func.lower(Project.name) == project_name.lower()))
            if not project:
                is_internal = _is_internal_project_or_client(project_name, client_name)
                project = Project(
                    name=project_name.strip(),
                    client_name=client_name,
                    pm_user_id=current_user.id,
                    is_overhead=is_internal,
                    is_billable=not is_internal,
                    is_active=True,
                )
                db.add(project)
                db.flush()
            elif (not project.client_name or project.client_name.lower() in {"imported client", "unassigned client"}) and client_name:
                project.client_name = client_name
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
        lifecycle_status=getattr(project, "lifecycle_status", None) or "active",
        completed_date=getattr(project, "completed_date", None),
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


def _latest_rate_for_date(rates: list[UserRate], as_of: date) -> UserRate | None:
    for r in reversed(rates):
        if r.effective_date <= as_of:
            return r
    return rates[-1] if rates else None


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
    if val in {"overdue", "past due", "past-due", "late"}:
        return "overdue"
    if val in {"viewed", "opened", "seen"}:
        return "viewed"
    if val in {"sent", "open", "unpaid", "outstanding", ""}:
        return "sent"
    return "sent"


def _normalize_import_client_name(raw: str) -> str:
    clean = (raw or "").strip()
    lower = clean.lower()
    alias_map = {
        "woodard and curran": "Woodard & Curran",
        "bepa": "NYCDEP-BEPA",
        "stantecjv": "Stantec + Brown & Caldwell",
        "hdr": "HDR",
        "imported client": "Unassigned Client",
        "legacy client": "Unassigned Client",
        "historical legacy client": "Unassigned Client",
        "unmapped imported work": "Unassigned Client",
    }
    if lower in alias_map:
        return alias_map[lower]
    return clean or "Unassigned Client"


def _infer_project_id_for_client_name(db: Session, client_name: str) -> int | None:
    normalized = _normalize_import_client_name(client_name)
    projects = db.scalars(
        select(Project).where(and_(func.lower(Project.client_name) == normalized.lower(), Project.is_active.is_(True)))
    ).all()
    if len(projects) == 1:
        return int(projects[0].id)
    return None


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


# =====================================================================
# FreshBooks OAuth + sync endpoints
# =====================================================================

@app.get("/auth/freshbooks/start")
def freshbooks_oauth_start(
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> RedirectResponse:
    """Kick off the FreshBooks OAuth dance — redirects user to FB consent screen."""
    s = get_settings()
    if not s.FRESHBOOKS_CLIENT_ID:
        raise HTTPException(status_code=500, detail="FRESHBOOKS_CLIENT_ID not configured in .env")
    return RedirectResponse(fb_integration.authorize_url(state="aqtpm"))


@app.get("/auth/freshbooks/callback")
def freshbooks_oauth_callback(
    code: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    """Receive the OAuth code and exchange it for tokens.

    NOTE: FreshBooks requires HTTPS for the redirect URI on registration. For local
    dev without a TLS cert, the user manually flips https->http in the browser when
    redirected back here. Either way, we get the `code` query param and complete
    the token exchange.
    """
    if error:
        return Response(
            content=f"<h1>FreshBooks authorization failed</h1><p>{error}</p>",
            media_type="text/html",
            status_code=400,
        )
    if not code:
        raise HTTPException(status_code=400, detail="missing 'code' query parameter")
    try:
        token_resp = fb_integration.exchange_code(code)
    except httpx.HTTPStatusError as e:
        return Response(
            content=f"<h1>Token exchange failed</h1><pre>{e.response.text}</pre>",
            media_type="text/html",
            status_code=502,
        )
    except Exception as e:  # pragma: no cover - defensive
        return Response(
            content=f"<h1>Token exchange error</h1><pre>{e}</pre>",
            media_type="text/html",
            status_code=502,
        )
    fb_integration.store_tokens(db, token_resp, notes="Connected via /auth/freshbooks/callback")
    db.commit()
    # Redirect back to the frontend Imports page
    s = get_settings()
    front = s.FRONTEND_ORIGIN.rstrip("/")
    return RedirectResponse(f"{front}/?fb_connected=1#imports")


@app.get("/admin/freshbooks/status")
def freshbooks_status(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    row = fb_integration.load_token(db)
    if not row:
        return {"connected": False}
    return {
        "connected": True,
        "account_id": row.account_id,
        "business_id": row.business_id,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "last_sync_status": row.last_sync_status,
        "last_sync_summary": json.loads(row.last_sync_summary or "{}"),
        "notes": row.notes,
    }


@app.post("/admin/freshbooks/sync")
def freshbooks_sync(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Run a read-only sync of clients, invoices, expenses from FreshBooks."""
    try:
        summary = fb_integration.sync_summary(db)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"FreshBooks API error: {e.response.text}")
    return summary


@app.post("/admin/freshbooks/disconnect")
def freshbooks_disconnect(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    row = fb_integration.load_token(db)
    if row:
        db.delete(row)
        db.commit()
    return {"status": "disconnected"}


# =====================================================================
# Gusto OAuth + sync endpoints
# =====================================================================

@app.get("/auth/gusto/start")
def gusto_oauth_start(
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> RedirectResponse:
    s = get_settings()
    if not s.GUSTO_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GUSTO_CLIENT_ID not configured in .env")
    return RedirectResponse(gusto_integration.authorize_url(state="aqtpm"))


@app.get("/auth/gusto/callback")
def gusto_oauth_callback(
    code: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    if error:
        return Response(
            content=f"<h1>Gusto authorization failed</h1><p>{error}</p>",
            media_type="text/html",
            status_code=400,
        )
    if not code:
        raise HTTPException(status_code=400, detail="missing 'code' query parameter")
    try:
        token_resp = gusto_integration.exchange_code(code)
    except httpx.HTTPStatusError as e:
        return Response(
            content=f"<h1>Token exchange failed</h1><pre>{e.response.text}</pre>",
            media_type="text/html",
            status_code=502,
        )
    except Exception as e:
        return Response(
            content=f"<h1>Token exchange error</h1><pre>{e}</pre>",
            media_type="text/html",
            status_code=502,
        )
    gusto_integration.store_tokens(db, token_resp, notes="Connected via /auth/gusto/callback")
    db.commit()
    s = get_settings()
    front = s.FRONTEND_ORIGIN.rstrip("/")
    return RedirectResponse(f"{front}/?gusto_connected=1#imports")


@app.get("/admin/gusto/status")
def gusto_status(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    row = gusto_integration.load_token(db)
    if not row:
        return {"connected": False}
    return {
        "connected": True,
        "account_id": row.account_id,
        "business_id": row.business_id,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "last_sync_status": row.last_sync_status,
        "last_sync_summary": json.loads(row.last_sync_summary or "{}"),
        "notes": row.notes,
    }


@app.post("/admin/gusto/sync")
def gusto_sync(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    try:
        summary = gusto_integration.sync_summary(db)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Gusto API error: {e.response.text}")
    return summary


@app.post("/admin/gusto/disconnect")
def gusto_disconnect(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    row = gusto_integration.load_token(db)
    if row:
        db.delete(row)
        db.commit()
    return {"status": "disconnected"}


# =====================================================================
# Plaid Link + transactions sync endpoints
# =====================================================================

@app.post("/admin/plaid/link-token")
def plaid_create_link_token(
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    s = get_settings()
    if not s.PLAID_CLIENT_ID or not s.PLAID_SECRET:
        raise HTTPException(status_code=500, detail="PLAID_CLIENT_ID / PLAID_SECRET not configured in .env")
    try:
        token = plaid_integration.create_link_token()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Plaid error: {e.response.text}")
    return {"link_token": token}


class PlaidExchangePayload(BaseModel):
    public_token: str


@app.post("/admin/plaid/exchange")
def plaid_exchange(
    payload: PlaidExchangePayload,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    """Called by the frontend after Plaid Link returns a public_token."""
    try:
        resp = plaid_integration.exchange_public_token(payload.public_token)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Plaid error: {e.response.text}")
    plaid_integration.store_access_token(db, resp, notes="Linked via Plaid Link UI")
    db.commit()
    return {"status": "linked"}


@app.get("/admin/plaid/status")
def plaid_status(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    row = plaid_integration.load_token(db)
    if not row:
        return {"connected": False}
    return {
        "connected": True,
        "account_id": row.account_id,
        "business_id": row.business_id,
        "expires_at": None,    # Plaid access_tokens don't expire
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "last_sync_status": row.last_sync_status,
        "last_sync_summary": json.loads(row.last_sync_summary or "{}"),
        "notes": row.notes,
    }


@app.post("/admin/plaid/sync")
def plaid_sync(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    try:
        return plaid_integration.sync_summary(db)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Plaid error: {e.response.text}")


@app.post("/admin/plaid/disconnect")
def plaid_disconnect(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, str]:
    row = plaid_integration.load_token(db)
    if row:
        db.delete(row)
        db.commit()
    return {"status": "disconnected"}


# ----------------------------------------------------------------------------
# Reconciliation engine (v2.0): expose CSV vs API drift so the user can clean up.
# ----------------------------------------------------------------------------


@app.get("/admin/reconcile/preview")
def reconcile_preview(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Summarize CSV-vs-API drift for the three operational tables.

    Returns:
      - source distribution per table
      - bank-transaction overlap window (where csv_chase and plaid_api both exist)
      - candidate duplicates (same date + amount within ±$0.01) in that overlap window
    """
    out: dict[str, object] = {}

    # --- Source distribution ---
    def _dist(table_model) -> list[dict[str, object]]:
        rows = db.execute(
            select(table_model.source, func.count()).group_by(table_model.source)
        ).all()
        return [{"source": s or "(unknown)", "count": int(c)} for s, c in rows]

    out["invoices"] = {"by_source": _dist(Invoice)}
    out["project_expenses"] = {"by_source": _dist(ProjectExpense)}
    out["bank_transactions"] = {"by_source": _dist(BankTransaction)}

    # --- Overlap window for bank transactions ---
    csv_min, csv_max = db.execute(
        select(func.min(BankTransaction.posted_date), func.max(BankTransaction.posted_date))
        .where(BankTransaction.source == "csv_chase")
    ).one()
    plaid_min, plaid_max = db.execute(
        select(func.min(BankTransaction.posted_date), func.max(BankTransaction.posted_date))
        .where(BankTransaction.source == "plaid_api")
    ).one()
    overlap_start = max(d for d in (csv_min, plaid_min) if d is not None) if csv_min and plaid_min else None
    overlap_end = min(d for d in (csv_max, plaid_max) if d is not None) if csv_max and plaid_max else None
    out["bank_transactions"]["csv_chase_range"] = [str(csv_min) if csv_min else None, str(csv_max) if csv_max else None]
    out["bank_transactions"]["plaid_api_range"] = [str(plaid_min) if plaid_min else None, str(plaid_max) if plaid_max else None]
    out["bank_transactions"]["overlap_window"] = [
        str(overlap_start) if overlap_start else None,
        str(overlap_end) if overlap_end else None,
    ]

    # --- Candidate duplicates: same posted_date + amount across sources ---
    duplicates: list[dict[str, object]] = []
    if overlap_start and overlap_end:
        # Round amount to 2 decimals to absorb minor float jitter
        plaid_rows = db.execute(
            select(BankTransaction.posted_date, BankTransaction.amount, BankTransaction.name, BankTransaction.id)
            .where(
                BankTransaction.source == "plaid_api",
                BankTransaction.posted_date >= overlap_start,
                BankTransaction.posted_date <= overlap_end,
            )
        ).all()
        # Index csv_chase rows by (date, rounded amount)
        csv_rows = db.execute(
            select(BankTransaction.posted_date, BankTransaction.amount, BankTransaction.name, BankTransaction.id)
            .where(
                BankTransaction.source == "csv_chase",
                BankTransaction.posted_date >= overlap_start,
                BankTransaction.posted_date <= overlap_end,
            )
        ).all()
        csv_by_key: dict[tuple, list[tuple]] = {}
        for d, a, n, i in csv_rows:
            key = (d, round(float(a or 0.0), 2))
            csv_by_key.setdefault(key, []).append((d, a, n, i))
        matched_csv_ids: set[int] = set()
        for d, a, n, i in plaid_rows:
            key = (d, round(float(a or 0.0), 2))
            cands = csv_by_key.get(key) or []
            # Pop the first un-matched CSV row at this key
            for c in cands:
                if c[3] in matched_csv_ids:
                    continue
                matched_csv_ids.add(c[3])
                duplicates.append({
                    "date": str(d),
                    "amount": float(a or 0.0),
                    "plaid_id": int(i),
                    "plaid_name": n,
                    "csv_id": int(c[3]),
                    "csv_name": c[2],
                })
                break
    out["bank_transactions"]["duplicate_candidates_count"] = len(duplicates)
    out["bank_transactions"]["duplicate_candidates_sample"] = duplicates[:25]
    if overlap_start and overlap_end:
        # How many csv_chase rows fall inside overlap (these are the dedup target population)
        csv_in_overlap = db.scalar(
            select(func.count())
            .select_from(BankTransaction)
            .where(
                BankTransaction.source == "csv_chase",
                BankTransaction.posted_date >= overlap_start,
                BankTransaction.posted_date <= overlap_end,
            )
        )
        plaid_in_overlap = db.scalar(
            select(func.count())
            .select_from(BankTransaction)
            .where(
                BankTransaction.source == "plaid_api",
                BankTransaction.posted_date >= overlap_start,
                BankTransaction.posted_date <= overlap_end,
            )
        )
        out["bank_transactions"]["csv_in_overlap"] = int(csv_in_overlap or 0)
        out["bank_transactions"]["plaid_in_overlap"] = int(plaid_in_overlap or 0)

    return out


@app.get("/admin/reconcile/full-report")
def reconcile_full_report(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Comprehensive reconciliation: walks every business outflow YTD and explains
    where it lands (OPEX, COGS-related, loan, transfer, brokerage, etc.) so the
    user can spot misclassifications quickly.
    """
    s, e = _accounting_period(start, end)

    # Build all the same exclusion sets the P&L code uses
    superseded_sources = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    cc_transfers_keywords = CC_TRANSFER_KEYWORDS
    payroll_keywords = PAYROLL_KEYWORDS
    personal_overrides = PERSONAL_OVERRIDE_KEYWORDS
    personal_to_business_keywords = PERSONAL_TO_BUSINESS_KEYWORDS
    personal_to_business_exclude = PERSONAL_TO_BUSINESS_EXCLUDE_KEYWORDS

    loan_keywords: list[str] = []
    for ln in db.scalars(select(Loan)).all():  # include paid-off loans too (descriptions still match historical txs)
        for pat in (ln.description_match or "").split("|"):
            pat = pat.strip().upper()
            if pat:
                loan_keywords.append(pat)

    staff_name_tokens: set[str] = set()
    for u in db.scalars(select(User).where(User.is_active.is_(True))).all():
        for tok in (u.full_name or "").upper().split():
            if len(tok) >= 3:
                staff_name_tokens.add(tok)

    linked_tx_ids = {p.bank_transaction_id for p in db.scalars(select(LoanPayment)).all() if p.bank_transaction_id}

    # Classify every business + personal-hardware outflow
    buckets: dict[str, dict[str, object]] = {
        "opex_active": {"label": "Active OPEX (counted)", "count": 0, "total": 0.0, "samples": []},
        "fb_only_opex": {"label": "FB-only OPEX (paid on unlinked card)", "count": 0, "total": 0.0, "samples": []},
        "loan_linked": {"label": "Loan payment (linked LoanPayment row)", "count": 0, "total": 0.0, "samples": []},
        "loan_keyword": {"label": "Loan payment (matched by name keyword)", "count": 0, "total": 0.0, "samples": []},
        "transfer": {"label": "Internal transfer / CC payment", "count": 0, "total": 0.0, "samples": []},
        "payroll": {"label": "Payroll / benefits / WC (already in COGS)", "count": 0, "total": 0.0, "samples": []},
        "zelle_staff": {"label": "Zelle to staff (salary, already in COGS)", "count": 0, "total": 0.0, "samples": []},
        "personal_override": {"label": "Personal (brokerage, owner draws)", "count": 0, "total": 0.0, "samples": []},
        "superseded": {"label": "Superseded (deduped CSV)", "count": 0, "total": 0.0, "samples": []},
        "personal_hw_to_opex": {"label": "Personal hardware promoted to OPEX", "count": 0, "total": 0.0, "samples": []},
    }

    def classify(tx: BankTransaction, on_business: bool) -> str:
        nm = (tx.name or "").upper()
        if tx.source in superseded_sources:
            return "superseded"
        if not on_business:
            # Personal account: only "personal hardware" can promote
            if any(k in nm for k in personal_to_business_exclude):
                return "skip"
            if any(k in nm for k in personal_to_business_keywords):
                return "personal_hw_to_opex"
            return "skip"
        # Business account
        if tx.id in linked_tx_ids:
            return "loan_linked"
        if any(k in nm for k in cc_transfers_keywords):
            return "transfer"
        if any(k in nm for k in payroll_keywords):
            return "payroll"
        if any(k in nm for k in loan_keywords):
            return "loan_keyword"
        if any(k in nm for k in personal_overrides):
            return "personal_override"
        if "ZELLE" in nm and any(t in nm for t in staff_name_tokens):
            return "zelle_staff"
        return "opex_active"

    business_outflows = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True),
            BankTransaction.amount < 0,
        )
    ).all()
    personal_outflows = db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(False),
            BankTransaction.amount < 0,
        )
    ).all()
    for tx in business_outflows:
        bucket = classify(tx, on_business=True)
        if bucket == "skip":
            continue
        b = buckets[bucket]
        b["count"] += 1  # type: ignore[operator]
        b["total"] += -float(tx.amount or 0)  # type: ignore[operator]
        if len(b["samples"]) < 5:  # type: ignore[arg-type]
            b["samples"].append({  # type: ignore[union-attr]
                "id": int(tx.id),
                "date": str(tx.posted_date),
                "name": (tx.name or "")[:80],
                "amount": float(tx.amount or 0),
                "source": tx.source,
            })
    for tx in personal_outflows:
        bucket = classify(tx, on_business=False)
        if bucket == "skip":
            continue
        b = buckets[bucket]
        b["count"] += 1  # type: ignore[operator]
        b["total"] += -float(tx.amount or 0)  # type: ignore[operator]
        if len(b["samples"]) < 5:
            b["samples"].append({
                "id": int(tx.id),
                "date": str(tx.posted_date),
                "name": (tx.name or "")[:80],
                "amount": float(tx.amount or 0),
                "source": tx.source,
            })

    # Pass 3: FB-only OPEX (csv_fb_expenses rows in business categories, paid on
    # an unlinked card so the bank-side rows don't see them)
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.source == "csv_fb_expenses",
            BankTransaction.amount > 0,
            BankTransaction.account_id.in_(FB_CATEGORIES_TO_OPEX),
        )
    ).all():
        nm_upper = (tx.name or "").upper()
        if any(k in nm_upper for k in PERSONAL_OVERRIDE_KEYWORDS):
            continue
        b = buckets["fb_only_opex"]
        b["count"] += 1  # type: ignore[operator]
        b["total"] += float(tx.amount or 0)  # type: ignore[operator]
        if len(b["samples"]) < 5:
            b["samples"].append({
                "id": int(tx.id),
                "date": str(tx.posted_date),
                "name": (tx.name or "")[:80],
                "amount": float(tx.amount or 0),
                "source": tx.source,
            })

    # Inflow side: paid invoices vs bank inflows
    revenue_cash = float(db.scalar(
        select(func.coalesce(func.sum(Invoice.amount_paid), 0.0))
        .where(Invoice.paid_date.isnot(None), Invoice.paid_date >= s, Invoice.paid_date <= e)
    ) or 0.0)
    inflow_cats = {
        "boc_factoring": 0.0, "owner_contrib_transfer": 0.0, "owner_contrib_zelle": 0.0,
        "client_rtp": 0.0, "client_wire": 0.0, "cc_payment_thank_you": 0.0,
        "fundbox_draw": 0.0, "stripe": 0.0, "other": 0.0,
    }
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s, BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True), BankTransaction.amount > 0,
            ~BankTransaction.source.in_([*superseded_sources, "csv_fb_expenses"]),
        )
    ).all():
        nm = (tx.name or "").upper()
        amt = float(tx.amount or 0)
        if "BOC CAPITAL" in nm:
            inflow_cats["boc_factoring"] += amt
        elif "ONLINE TRANSFER FROM CHK" in nm:
            inflow_cats["owner_contrib_transfer"] += amt
        elif "ZELLE PAYMENT FROM BERTRAND" in nm:
            inflow_cats["owner_contrib_zelle"] += amt
        elif "PAYMENT THANK YOU" in nm:
            inflow_cats["cc_payment_thank_you"] += amt
        elif "REAL TIME PAYMENT" in nm:
            inflow_cats["client_rtp"] += amt
        elif "FEDWIRE" in nm:
            inflow_cats["client_wire"] += amt
        elif "FUNDBOX" in nm:
            inflow_cats["fundbox_draw"] += amt
        elif "STRIPE" in nm:
            inflow_cats["stripe"] += amt
        else:
            inflow_cats["other"] += amt

    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "outflow_buckets": buckets,
        "revenue_cash_invoices": revenue_cash,
        "inflow_categorization": inflow_cats,
        "user_notes": [
            "Per user (2026-05-02): BOC Capital $24,636 deposit on 2026-01-20 was misposted to personal brokerage; treated as financing not revenue.",
            "Per user: Alpaca charges (ALPACADB) excluded from OPEX; refund pending from Alpaca.",
            "Per user: Computer purchases at Best Buy / HP / Apple Store / Apple.com/US are legit business OPEX even when on personal account 0273.",
            "Per user: Salaries sometimes paid via Zelle, but payroll itself runs through Gusto (so already in COGS via Gusto journal).",
            "Per user: Nu Era = health insurance for R. Svadlenka. NYSIF = workers comp + disability. Both currently excluded from OPEX; should be added to COGS in slice 4.",
            "Per user: 'Manual DB-Bkrg' / 'Manual CR-Bkrg' / Robinhood / 'Bertrand Loan Repayment' patterns are personal brokerage transfers or owner draws — excluded from OPEX.",
        ],
    }


@app.get("/admin/reconcile/active-opex")
def reconcile_active_opex(
    start: str | None = None,
    end: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Return every transaction currently feeding the P&L OPEX line, sorted
    largest-first, so the user can review item by item.
    """
    s, e = _accounting_period(start, end)

    # Replicate the exclusion sets from the P&L code
    superseded_sources = ("csv_chase_superseded", "csv_fb_expenses_superseded", "csv_chase_card")
    cc_transfers_keywords = CC_TRANSFER_KEYWORDS
    payroll_keywords = PAYROLL_KEYWORDS
    personal_overrides = PERSONAL_OVERRIDE_KEYWORDS
    personal_to_business_keywords = PERSONAL_TO_BUSINESS_KEYWORDS
    personal_to_business_exclude = PERSONAL_TO_BUSINESS_EXCLUDE_KEYWORDS
    loan_keywords: list[str] = []
    for ln in db.scalars(select(Loan)).all():  # include paid-off loans too (descriptions still match historical txs)
        for pat in (ln.description_match or "").split("|"):
            pat = pat.strip().upper()
            if pat:
                loan_keywords.append(pat)
    staff_name_tokens: set[str] = set()
    for u in db.scalars(select(User).where(User.is_active.is_(True))).all():
        for tok in (u.full_name or "").upper().split():
            if len(tok) >= 3:
                staff_name_tokens.add(tok)
    linked_tx_ids = {p.bank_transaction_id for p in db.scalars(select(LoanPayment)).all() if p.bank_transaction_id}

    items: list[dict[str, object]] = []
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(True),
            BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_sources),
        )
    ).all():
        nm = (tx.name or "").upper()
        if tx.id in linked_tx_ids: continue
        if any(k in nm for k in cc_transfers_keywords): continue
        if any(k in nm for k in payroll_keywords): continue
        if any(k in nm for k in loan_keywords): continue
        if any(k in nm for k in personal_overrides): continue
        if "ZELLE" in nm and any(t in nm for t in staff_name_tokens): continue
        items.append({
            "id": int(tx.id),
            "date": str(tx.posted_date),
            "amount": -float(tx.amount or 0),  # express as positive expense
            "name": tx.name or "",
            "source": tx.source,
            "promoted_from_personal": False,
        })
    # Pass 2: personal hardware promoted to OPEX
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.is_business.is_(False),
            BankTransaction.amount < 0,
            ~BankTransaction.source.in_(superseded_sources),
        )
    ).all():
        nm = (tx.name or "").upper()
        if any(k in nm for k in personal_to_business_exclude): continue
        if not any(k in nm for k in personal_to_business_keywords): continue
        items.append({
            "id": int(tx.id),
            "date": str(tx.posted_date),
            "amount": -float(tx.amount or 0),
            "name": tx.name or "",
            "source": tx.source,
            "promoted_from_personal": True,
        })

    # Pass 3: FB-only OPEX (csv_fb_expenses rows in business categories)
    for tx in db.scalars(
        select(BankTransaction).where(
            BankTransaction.posted_date.isnot(None),
            BankTransaction.posted_date >= s,
            BankTransaction.posted_date <= e,
            BankTransaction.source == "csv_fb_expenses",
            BankTransaction.amount > 0,
            BankTransaction.account_id.in_(FB_CATEGORIES_TO_OPEX),
        )
    ).all():
        nm = (tx.name or "").upper()
        if any(k in nm for k in personal_overrides): continue
        items.append({
            "id": int(tx.id),
            "date": str(tx.posted_date),
            "amount": float(tx.amount or 0),
            "name": tx.name or "",
            "source": f"csv_fb_expenses ({tx.account_id})",
            "promoted_from_personal": True,  # treat same as the hardware/travel promotion
        })

    items.sort(key=lambda x: -x["amount"])  # type: ignore[arg-type,operator]
    return {
        "period": {"start": s.isoformat(), "end": e.isoformat()},
        "count": len(items),
        "total": sum(i["amount"] for i in items),  # type: ignore[arg-type]
        "items": items,
    }


@app.post("/admin/reconcile/dedupe-fb-vs-bank")
def reconcile_dedupe_fb_vs_bank(
    apply: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Cross-source dedupe: csv_fb_expenses (FB's manual ledger, signs flipped to
    positive expense values) vs canonical bank rows (csv_chase / plaid_api,
    signed amounts). Match strategy: same posted_date + same ABS(amount).

    Per user directive: when FB disagrees with the bank, the bank wins.
    Matched FB rows get retagged 'csv_fb_expenses_superseded' so they stop
    contributing to OPEX without being deleted.

    Pass `?apply=true` to retag. Default is dry-run.
    """
    bank_rows = db.execute(
        select(BankTransaction.id, BankTransaction.posted_date, BankTransaction.amount)
        .where(BankTransaction.source.in_(["csv_chase", "plaid_api"]))
    ).all()
    bank_keys: dict[tuple, int] = {}
    for _id, d, a in bank_rows:
        key = (d, round(abs(float(a or 0.0)), 2))
        bank_keys[key] = bank_keys.get(key, 0) + 1

    fb_rows = db.execute(
        select(BankTransaction)
        .where(BankTransaction.source == "csv_fb_expenses")
    ).scalars().all()
    retagged = 0
    sample: list[dict[str, object]] = []
    for r in fb_rows:
        key = (r.posted_date, round(abs(float(r.amount or 0.0)), 2))
        if bank_keys.get(key, 0) > 0:
            bank_keys[key] -= 1
            if apply:
                r.source = "csv_fb_expenses_superseded"
            retagged += 1
            if len(sample) < 8:
                sample.append({
                    "fb_id": int(r.id),
                    "date": str(r.posted_date),
                    "amount": float(r.amount or 0.0),
                    "name": (r.name or "")[:60],
                })
    if apply:
        db.commit()
    return {
        "status": "applied" if apply else "preview",
        "retagged": retagged,
        "sample_first_8": sample,
    }


@app.post("/admin/reconcile/dedupe-bank")
def reconcile_dedupe_bank(
    apply: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_PROJECTS")),
) -> dict[str, object]:
    """Soft-deduplicate bank_transactions: for csv_chase rows that match a plaid_api
    row (same date + amount) within the overlap window, retag the csv row as
    'csv_chase_superseded' so it stops contributing to P&L without being lost.

    Pass `?apply=true` to actually retag. Default is dry-run (preview only).
    """
    csv_min, csv_max = db.execute(
        select(func.min(BankTransaction.posted_date), func.max(BankTransaction.posted_date))
        .where(BankTransaction.source == "csv_chase")
    ).one()
    plaid_min, plaid_max = db.execute(
        select(func.min(BankTransaction.posted_date), func.max(BankTransaction.posted_date))
        .where(BankTransaction.source == "plaid_api")
    ).one()
    if not (csv_min and plaid_min and csv_max and plaid_max):
        return {"status": "no-overlap", "retagged": 0}
    overlap_start = max(csv_min, plaid_min)
    overlap_end = min(csv_max, plaid_max)
    if overlap_start > overlap_end:
        return {"status": "no-overlap", "retagged": 0}

    plaid_rows = db.execute(
        select(BankTransaction.posted_date, BankTransaction.amount)
        .where(
            BankTransaction.source == "plaid_api",
            BankTransaction.posted_date >= overlap_start,
            BankTransaction.posted_date <= overlap_end,
        )
    ).all()
    plaid_keys: dict[tuple, int] = {}
    for d, a in plaid_rows:
        key = (d, round(float(a or 0.0), 2))
        plaid_keys[key] = plaid_keys.get(key, 0) + 1

    csv_rows = db.execute(
        select(BankTransaction)
        .where(
            BankTransaction.source == "csv_chase",
            BankTransaction.posted_date >= overlap_start,
            BankTransaction.posted_date <= overlap_end,
        )
    ).scalars().all()
    retagged = 0
    for r in csv_rows:
        key = (r.posted_date, round(float(r.amount or 0.0), 2))
        if plaid_keys.get(key, 0) > 0:
            plaid_keys[key] -= 1  # consume one so each plaid row only supersedes one csv row
            if apply:
                r.source = "csv_chase_superseded"
            retagged += 1
    if apply:
        db.commit()
    return {
        "status": "applied" if apply else "preview",
        "overlap_window": [str(overlap_start), str(overlap_end)],
        "retagged": retagged,
    }
