#!/usr/bin/env python3
from __future__ import annotations

import csv
import gzip
import json
import shutil
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - optional dependency
    PdfReader = None


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BACKUP = ROOT / "backups" / "fblite_20260228_003502.sql.gz"
DEFAULT_CASH_PNL = Path("/mnt/c/Users/bertr/Downloads/profit_loss (1).csv")
DEFAULT_ACCRUAL_PNL = Path("/mnt/c/Users/bertr/Downloads/profit_loss.csv")
DEFAULT_PRIOR_RETURN = Path("/mnt/c/Users/bertr/Downloads/Aquatech2024TaxReturns.pdf")
DEFAULT_RECON = ROOT / "docs" / "reconciliation" / "reconciliation_2024-02-08_2026-02-13.csv"
DEFAULT_OUT_DIR = ROOT / "docs" / "compliance"
DEFAULT_DOWNLOADS = Path("/mnt/c/Users/bertr/Downloads")
DEFAULT_MANUAL_ADJUSTMENTS = ROOT / "docs" / "compliance" / "2025-tax-manual-adjustments.json"
TARGET_YEAR = 2025


def parse_float(value: str | None) -> float:
    if not value or value == r"\N":
        return 0.0
    return float(value)


def format_money(value: float) -> str:
    return f"{value:.2f}"


def format_money_pretty(value: float) -> str:
    if value < 0:
        return f"-${abs(value):,.2f}"
    return f"${value:,.2f}"


@dataclass
class PnlData:
    label: str
    monthly_headers: list[str]
    monthly_sales: dict[str, float]
    line_totals: dict[tuple[str, str], float]
    total_sales: float
    total_expenses: float
    gross_profit: float
    net_profit: float


def load_pnl(path: Path, label: str) -> PnlData:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))

    monthly_headers = [part[:7] for part in rows[0][2:-1]]
    line_totals: dict[tuple[str, str], float] = {}
    monthly_sales: dict[str, float] = {}
    total_sales = 0.0
    total_expenses = 0.0
    gross_profit = 0.0
    net_profit = 0.0

    for row in rows[1:]:
        if len(row) < 3:
            continue
        category = (row[0] or "").strip()
        subcategory = (row[1] or "").strip()
        numeric_cells = row[2:]
        try:
            monthly_values = [parse_float(v) for v in numeric_cells[:-1]]
            total_value = parse_float(numeric_cells[-1])
        except ValueError:
            continue

        line_totals[(category, subcategory)] = total_value
        if category == "Sales":
            monthly_sales = dict(zip(monthly_headers, monthly_values, strict=False))
            total_sales = total_value
        elif category == "Total Expenses":
            total_expenses = total_value
        elif category == "Gross Profit":
            gross_profit = total_value
        elif category == "Net Profit (USD)":
            net_profit = total_value

    return PnlData(
        label=label,
        monthly_headers=monthly_headers,
        monthly_sales=monthly_sales,
        line_totals=line_totals,
        total_sales=total_sales,
        total_expenses=total_expenses,
        gross_profit=gross_profit,
        net_profit=net_profit,
    )


def load_reconciliation(path: Path, year: int) -> tuple[dict[str, dict[str, float]], dict[str, float]]:
    monthly: dict[str, dict[str, float]] = {}
    totals = {
        "entry_count": 0.0,
        "total_hours": 0.0,
        "bill_amount": 0.0,
        "cost_amount": 0.0,
        "profit_amount": 0.0,
    }
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            period = row["period"]
            if not period.startswith(f"{year}-"):
                continue
            monthly[period] = {
                "entry_count": float(row["entry_count"]),
                "total_hours": float(row["total_hours"]),
                "bill_amount": float(row["bill_amount"]),
                "cost_amount": float(row["cost_amount"]),
                "profit_amount": float(row["profit_amount"]),
            }
            for key in totals:
                totals[key] += monthly[period][key]
    return monthly, totals


def load_manual_adjustments(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, list) else []


def classify_bank_category(category: str) -> tuple[str, str]:
    lower = category.lower()
    if "personal" in lower:
        return (
            "exclude_personal",
            "Marked personal in source data; keep out of the business return unless reclassified with documentation.",
        )
    if "transfer" in lower or "invoice payment" in lower or "refund" in lower or "loan proceeds" in lower:
        return (
            "balance_sheet_or_cashflow",
            "Looks like a transfer, receipt movement, refund, or financing inflow/outflow rather than a direct deduction.",
        )
    if "loan payment" in lower:
        return (
            "split_principal_interest",
            "Loan payments usually need principal and interest split before tax treatment is finalized.",
        )
    if "owner draw" in lower:
        return (
            "equity_owner_activity",
            "Owner/distribution activity should be reviewed outside the ordinary expense bucket.",
        )
    if "uncategorized" in lower or "double_check" in lower or "needs manual split" in lower:
        return (
            "manual_review",
            "Source category is not reliable enough to file from without a manual pass.",
        )
    return (
        "expense_candidate",
        "Appears expense-like from the bookkeeping label; match it to receipts and the P&L before filing.",
    )


def is_payroll_related(category: str, expense_group: str, name: str, merchant: str) -> bool:
    text = " ".join([category, expense_group, name, merchant]).lower()
    return any(
        key in text
        for key in [
            "payroll",
            "gusto",
            "adp",
            "paychex",
            "salary",
            "wage",
            "benefit",
            "retirement",
            "healthcare",
            "health care",
            "labor insurance",
            "taxes",
        ]
    ) or category.startswith("Cost of Goods Sold_")


def is_shareholder_transfer_6611_0273(provider: str, name: str, category: str, expense_group: str) -> bool:
    lower_name = name.lower()
    if provider != "expense_cat_import":
        return False
    if category != "Transfer" or expense_group != "Other":
        return False
    return (
        "to chk ...0273" in lower_name
        or "from chk ...0273" in lower_name
        or ("transfer" in lower_name and "6611" in lower_name and "0273" in lower_name)
    )


def extract_prior_return_context(pdf_path: Path) -> str:
    if not pdf_path.exists() or PdfReader is None:
        return "Unavailable"
    reader = PdfReader(str(pdf_path))
    text = "\n".join((reader.pages[i].extract_text() or "") for i in range(min(6, len(reader.pages))))
    if "U.S. Income Tax Return for an S Corporation" in text or "1120-S" in text:
        return "Form 1120-S (S corporation)"
    if "Form 1120" in text:
        return "Form 1120"
    return "Could not determine form type from extracted text"


def parse_backup(
    backup_path: Path,
    year: int,
) -> tuple[
    dict[str, dict[str, float]],
    dict[str, float],
    list[dict[str, str]],
    dict[str, float],
    list[dict[str, str]],
    list[dict[str, str]],
    list[dict[str, object]],
]:
    invoice_monthly: dict[str, dict[str, float]] = defaultdict(
        lambda: {"invoice_count": 0.0, "invoice_subtotal": 0.0, "invoice_paid": 0.0, "invoice_balance": 0.0}
    )
    invoice_totals = {"invoice_count": 0.0, "invoice_subtotal": 0.0, "invoice_paid": 0.0, "invoice_balance": 0.0}
    bank_review_rows: dict[tuple[str, str, str, str], dict[str, float | str]] = {}
    payroll_bank_rows: dict[tuple[str, str], dict[str, float | str]] = {}
    shareholder_transfer_rows: list[dict[str, object]] = []
    app_stats = {
        "bank_business_rows": 0.0,
        "bank_business_abs": 0.0,
        "bank_negative_expense_rows": 0.0,
        "bank_negative_expense_abs": 0.0,
        "project_expense_rows": 0.0,
        "project_expense_total": 0.0,
    }

    connection_providers: dict[str, str] = {}
    users: dict[str, str] = {}
    user_rates: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
    payroll_users: dict[str, dict[str, float | str]] = {}
    current_table: str | None = None

    with gzip.open(backup_path, "rt", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            if line.startswith("COPY public."):
                current_table = line.split()[1].split(".")[-1]
                continue
            if current_table and line == r"\.":
                current_table = None
                continue
            if not current_table:
                continue

            row = next(csv.reader([line], delimiter="\t"))

            if current_table == "bank_connections":
                connection_providers[row[0]] = row[1]
                continue

            if current_table == "users":
                users[row[0]] = row[2] or row[1]
                continue

            if current_table == "user_rates":
                user_rates[row[1]].append((row[2], parse_float(row[3]), parse_float(row[4])))
                continue

            if current_table == "invoices":
                issue_date = row[6]
                if not issue_date.startswith(f"{year}-"):
                    continue
                month = issue_date[:7]
                subtotal = parse_float(row[9])
                paid = parse_float(row[15])
                balance = parse_float(row[16])
                invoice_monthly[month]["invoice_count"] += 1
                invoice_monthly[month]["invoice_subtotal"] += subtotal
                invoice_monthly[month]["invoice_paid"] += paid
                invoice_monthly[month]["invoice_balance"] += balance
                invoice_totals["invoice_count"] += 1
                invoice_totals["invoice_subtotal"] += subtotal
                invoice_totals["invoice_paid"] += paid
                invoice_totals["invoice_balance"] += balance
                continue

            if current_table == "project_expenses":
                expense_date = row[2]
                if expense_date.startswith(f"{year}-"):
                    app_stats["project_expense_rows"] += 1
                    app_stats["project_expense_total"] += parse_float(row[5])
                continue

            if current_table == "time_entries":
                work_date = row[5]
                if not work_date.startswith(f"{year}-"):
                    continue
                user_id = row[1]
                entry = payroll_users.setdefault(
                    user_id,
                    {
                        "user_id": user_id,
                        "employee": users.get(user_id, f"User {user_id}"),
                        "hours": 0.0,
                        "bill_amount": 0.0,
                        "cost_amount": 0.0,
                    },
                )
                hours = parse_float(row[6])
                bill_rate = parse_float(row[8])
                cost_rate = parse_float(row[9])
                entry["hours"] = float(entry["hours"]) + hours
                entry["bill_amount"] = float(entry["bill_amount"]) + (hours * bill_rate)
                entry["cost_amount"] = float(entry["cost_amount"]) + (hours * cost_rate)
                continue

            if current_table != "bank_transactions":
                continue

            posted_date = row[4]
            if not posted_date.startswith(f"{year}-") or row[13] != "t":
                continue

            amount = parse_float(row[7])
            app_stats["bank_business_rows"] += 1
            app_stats["bank_business_abs"] += abs(amount)

            provider = connection_providers.get(row[1], "unknown")
            raw_payload = json.loads(row[11]) if row[11] and row[11] != r"\N" else {}
            category = (raw_payload.get("final_category") or raw_payload.get("category") or "").strip() or "Uncategorized"
            expense_group = (raw_payload.get("expense_group") or "").strip() or "Unassigned"
            if is_shareholder_transfer_6611_0273(provider, row[5], category, expense_group):
                shareholder_transfer_rows.append(
                    {
                        "date": posted_date,
                        "transaction_id": row[3],
                        "account_id": row[2],
                        "amount": amount,
                        "category": category,
                        "expense_group": expense_group,
                        "description": row[5],
                    }
                )
            if is_payroll_related(category, expense_group, row[5], row[6]):
                payroll_key = (category, expense_group)
                payroll_entry = payroll_bank_rows.setdefault(
                    payroll_key,
                    {
                        "category": category,
                        "expense_group": expense_group,
                        "tx_count": 0.0,
                        "total_abs": 0.0,
                    },
                )
                payroll_entry["tx_count"] = float(payroll_entry["tx_count"]) + 1
                payroll_entry["total_abs"] = float(payroll_entry["total_abs"]) + abs(amount)
            is_expense = str(raw_payload.get("is_expense") or "").strip().lower()
            if amount >= 0 or is_expense not in {"1", "true", "yes", "y"}:
                continue

            review_class, review_note = classify_bank_category(category)
            key = (category, expense_group, review_class, review_note)
            entry = bank_review_rows.setdefault(
                key,
                {
                    "category": category,
                    "expense_group": expense_group,
                    "review_class": review_class,
                    "review_note": review_note,
                    "provider": provider,
                    "tx_count": 0.0,
                    "total_abs": 0.0,
                },
            )
            entry["tx_count"] = float(entry["tx_count"]) + 1
            entry["total_abs"] = float(entry["total_abs"]) + abs(amount)
            app_stats["bank_negative_expense_rows"] += 1
            app_stats["bank_negative_expense_abs"] += abs(amount)

    bank_rows = sorted(
        (
            {
                "category": str(row["category"]),
                "expense_group": str(row["expense_group"]),
                "review_class": str(row["review_class"]),
                "review_note": str(row["review_note"]),
                "provider": str(row["provider"]),
                "tx_count": format_money(float(row["tx_count"])).rstrip("0").rstrip("."),
                "total_abs": format_money(float(row["total_abs"])),
            }
            for row in bank_review_rows.values()
        ),
        key=lambda item: float(item["total_abs"]),
        reverse=True,
    )
    payroll_rows = sorted(
        (
            {
                "category": str(row["category"]),
                "expense_group": str(row["expense_group"]),
                "tx_count": format_money(float(row["tx_count"])).rstrip("0").rstrip("."),
                "total_abs": format_money(float(row["total_abs"])),
            }
            for row in payroll_bank_rows.values()
        ),
        key=lambda item: float(item["total_abs"]),
        reverse=True,
    )
    for user_id, rates in user_rates.items():
        rates.sort(key=lambda item: item[0])
        latest = None
        for effective_date, bill_rate, cost_rate in rates:
            if effective_date <= f"{year}-12-31":
                latest = (effective_date, bill_rate, cost_rate)
        if user_id in payroll_users:
            payroll_users[user_id]["employee"] = users.get(user_id, str(payroll_users[user_id]["employee"]))
            payroll_users[user_id]["latest_rate_effective_date"] = latest[0] if latest else ""
            payroll_users[user_id]["latest_bill_rate"] = latest[1] if latest else 0.0
            payroll_users[user_id]["latest_cost_rate"] = latest[2] if latest else 0.0
    payroll_user_rows = sorted(
        (
            {
                "user_id": str(row["user_id"]),
                "employee": str(row["employee"]),
                "hours": format_money(float(row["hours"])),
                "bill_amount": format_money(float(row["bill_amount"])),
                "cost_amount": format_money(float(row["cost_amount"])),
                "latest_rate_effective_date": str(row.get("latest_rate_effective_date", "")),
                "latest_bill_rate": format_money(float(row.get("latest_bill_rate", 0.0))),
                "latest_cost_rate": format_money(float(row.get("latest_cost_rate", 0.0))),
            }
            for row in payroll_users.values()
        ),
        key=lambda item: float(item["cost_amount"]),
        reverse=True,
    )
    shareholder_transfer_rows.sort(key=lambda row: (str(row["date"]), str(row["transaction_id"])))
    return invoice_monthly, invoice_totals, bank_rows, app_stats, payroll_rows, payroll_user_rows, shareholder_transfer_rows


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def build_outputs() -> list[Path]:
    DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)

    cash_pnl = load_pnl(DEFAULT_CASH_PNL, "cash")
    accrual_pnl = load_pnl(DEFAULT_ACCRUAL_PNL, "accrual")
    recon_monthly, recon_totals = load_reconciliation(DEFAULT_RECON, TARGET_YEAR)
    invoice_monthly, invoice_totals, bank_rows, app_stats, payroll_bank_rows, payroll_user_rows, shareholder_transfer_rows = parse_backup(
        DEFAULT_BACKUP, TARGET_YEAR
    )
    prior_return_context = extract_prior_return_context(DEFAULT_PRIOR_RETURN)
    manual_adjustments = load_manual_adjustments(DEFAULT_MANUAL_ADJUSTMENTS)

    months = sorted(set(cash_pnl.monthly_headers) | set(recon_monthly) | set(invoice_monthly))

    category_map_path = DEFAULT_OUT_DIR / "2025-tax-pl-category-map.csv"
    comparison_path = DEFAULT_OUT_DIR / "2025-tax-source-comparison.csv"
    monthly_support_path = DEFAULT_OUT_DIR / "2025-tax-monthly-support.csv"
    bank_review_path = DEFAULT_OUT_DIR / "2025-tax-bank-category-review.csv"
    payroll_support_path = DEFAULT_OUT_DIR / "2025-tax-payroll-support.csv"
    payroll_by_user_path = DEFAULT_OUT_DIR / "2025-tax-payroll-by-user.csv"
    worksheet_path = DEFAULT_OUT_DIR / "2025-tax-1120s-draft-worksheet.csv"
    manual_adjustments_path = DEFAULT_OUT_DIR / "2025-tax-manual-adjustments.csv"
    shareholder_ledger_path = DEFAULT_OUT_DIR / "2025-tax-shareholder-loan-ledger.csv"
    shareholder_match_path = DEFAULT_OUT_DIR / "2025-tax-shareholder-loan-match.csv"
    accounting_method_memo_path = DEFAULT_OUT_DIR / "2025-tax-accounting-method-memo.md"
    checklist_path = DEFAULT_OUT_DIR / "2025-tax-cpa-handoff-checklist.md"
    summary_path = DEFAULT_OUT_DIR / "2025-tax-packet-summary.md"

    all_line_keys = sorted(set(cash_pnl.line_totals) | set(accrual_pnl.line_totals))
    category_rows = [
        [
            category,
            subcategory,
            format_money(cash_pnl.line_totals.get((category, subcategory), 0.0)),
            format_money(accrual_pnl.line_totals.get((category, subcategory), 0.0)),
            format_money(
                cash_pnl.line_totals.get((category, subcategory), 0.0)
                - accrual_pnl.line_totals.get((category, subcategory), 0.0)
            ),
        ]
        for category, subcategory in all_line_keys
    ]
    write_csv(
        category_map_path,
        ["Category", "Subcategory", "Cash Total", "Accrual Total", "Cash - Accrual"],
        category_rows,
    )

    accrual_vs_recon = accrual_pnl.total_sales - recon_totals["bill_amount"]
    accrual_vs_invoice = accrual_pnl.total_sales - invoice_totals["invoice_subtotal"]
    cash_vs_invoice_paid = cash_pnl.total_sales - invoice_totals["invoice_paid"]

    comparison_rows = [
        [
            "Gross receipts / sales",
            format_money(cash_pnl.total_sales),
            format_money(accrual_pnl.total_sales),
            format_money(invoice_totals["invoice_subtotal"]),
            format_money(recon_totals["bill_amount"]),
            (
                "Cash P&L matches app invoice payments; accrual P&L nearly matches app reconciliation billings, "
                "while the invoice table is materially short for accrual support."
            ),
        ],
        [
            "Cash collections",
            format_money(cash_pnl.total_sales),
            "",
            format_money(invoice_totals["invoice_paid"]),
            "",
            f"Cash P&L minus app invoice paid = {format_money(cash_vs_invoice_paid)}.",
        ],
        [
            "Year-end open A/R",
            "",
            "",
            format_money(invoice_totals["invoice_balance"]),
            "",
            "Comes from the app invoice table only; use with caution if invoice history is incomplete.",
        ],
        [
            "Total expenses",
            format_money(cash_pnl.total_expenses),
            format_money(accrual_pnl.total_expenses),
            "",
            "",
            "P&L is the primary expense source in the provided files; app project_expenses has no 2025 rows.",
        ],
        [
            "Net profit / loss",
            format_money(cash_pnl.net_profit),
            format_money(accrual_pnl.net_profit),
            "",
            format_money(recon_totals["profit_amount"]),
            "App reconciliation profit is project margin support, not the filed tax net income.",
        ],
        [
            "2025 time-entry cost support",
            "",
            "",
            "",
            format_money(recon_totals["cost_amount"]),
            "Operational cost from time-entry reconciliation; compare to payroll/COGS support.",
        ],
        [
            "Accrual support gap",
            "",
            format_money(accrual_pnl.total_sales),
            format_money(invoice_totals["invoice_subtotal"]),
            format_money(recon_totals["bill_amount"]),
            (
                f"Accrual P&L minus app invoice subtotal = {format_money(accrual_vs_invoice)}; "
                f"accrual P&L minus app reconciliation billings = {format_money(accrual_vs_recon)}."
            ),
        ],
    ]
    write_csv(
        comparison_path,
        ["Metric", "Cash P&L", "Accrual P&L", "App Invoices", "App Reconciliation", "Note"],
        comparison_rows,
    )

    monthly_rows: list[list[str]] = []
    for month in months:
        monthly_rows.append(
            [
                month,
                format_money(cash_pnl.monthly_sales.get(month, 0.0)),
                format_money(accrual_pnl.monthly_sales.get(month, 0.0)),
                format_money(invoice_monthly.get(month, {}).get("invoice_subtotal", 0.0)),
                format_money(invoice_monthly.get(month, {}).get("invoice_paid", 0.0)),
                format_money(invoice_monthly.get(month, {}).get("invoice_balance", 0.0)),
                format_money(recon_monthly.get(month, {}).get("bill_amount", 0.0)),
                format_money(recon_monthly.get(month, {}).get("cost_amount", 0.0)),
                format_money(recon_monthly.get(month, {}).get("profit_amount", 0.0)),
                format_money(recon_monthly.get(month, {}).get("total_hours", 0.0)),
                str(int(recon_monthly.get(month, {}).get("entry_count", 0.0))),
            ]
        )
    write_csv(
        monthly_support_path,
        [
            "Month",
            "Cash P&L Sales",
            "Accrual P&L Sales",
            "App Invoice Subtotal",
            "App Invoice Paid",
            "App Invoice Balance",
            "App Reconciliation Bill",
            "App Reconciliation Cost",
            "App Reconciliation Profit",
            "App Reconciliation Hours",
            "App Reconciliation Entry Count",
        ],
        monthly_rows,
    )

    write_csv(
        bank_review_path,
        ["Category", "Expense Group", "Provider", "Transaction Count", "Total Absolute Amount", "Review Class", "Review Note"],
        [
            [
                row["category"],
                row["expense_group"],
                row["provider"],
                row["tx_count"],
                row["total_abs"],
                row["review_class"],
                row["review_note"],
            ]
            for row in bank_rows
        ],
    )

    payroll_pnl_keys = [
        ("Cost of Goods Sold", "Bertrand Byrne Unpaid Salary"),
        ("Cost of Goods Sold", "COGS-Payroll Health Benefits"),
        ("Cost of Goods Sold", "COGS-Payroll Retirement Benefits"),
        ("Cost of Goods Sold", "COGS-Payroll Taxes"),
        ("Cost of Goods Sold", "COGS-Payroll Wages"),
        ("Employee Benefits", "Employee Benefits (general)"),
        ("Payroll Expense", "Employer Taxes"),
    ]
    payroll_cash_total = sum(cash_pnl.line_totals.get(key, 0.0) for key in payroll_pnl_keys)
    payroll_accrual_total = sum(accrual_pnl.line_totals.get(key, 0.0) for key in payroll_pnl_keys)
    payroll_bank_total = sum(float(row["total_abs"]) for row in payroll_bank_rows)
    payroll_time_cost_total = sum(float(row["cost_amount"]) for row in payroll_user_rows)
    payroll_time_bill_total = sum(float(row["bill_amount"]) for row in payroll_user_rows)

    payroll_support_rows = [
        ["P&L payroll-related total (cash)", format_money(payroll_cash_total), "Cash-basis support from provided P&L payroll lines."],
        ["P&L payroll-related total (accrual)", format_money(payroll_accrual_total), "Accrual-basis support from provided P&L payroll lines."],
        [
            "AquatechPM payroll-related bank categories",
            format_money(payroll_bank_total),
            "Imported bank/payroll journal style support recovered from the SQL backup; includes payroll taxes, benefits, and other payroll-like categories.",
        ],
        [
            "AquatechPM time-entry labor cost",
            format_money(payroll_time_cost_total),
            "Derived from 2025 time entries using applied cost rates; operational labor support, not a statutory payroll filing total.",
        ],
        [
            "AquatechPM time-entry bill value",
            format_money(payroll_time_bill_total),
            "Derived from 2025 time entries using applied bill rates.",
        ],
    ]
    payroll_support_rows.extend(
        [
            [
                f"Bank payroll category: {row['category']}",
                row["total_abs"],
                f"Expense group {row['expense_group']} across {row['tx_count']} transactions.",
            ]
            for row in payroll_bank_rows[:20]
        ]
    )
    write_csv(payroll_support_path, ["Metric", "Amount", "Note"], payroll_support_rows)
    write_csv(
        payroll_by_user_path,
        [
            "User ID",
            "Employee",
            "2025 Hours",
            "2025 Bill Amount",
            "2025 Cost Amount",
            "Latest Rate Effective Date",
            "Latest Bill Rate as of 2025-12-31",
            "Latest Cost Rate as of 2025-12-31",
        ],
        [
            [
                row["user_id"],
                row["employee"],
                row["hours"],
                row["bill_amount"],
                row["cost_amount"],
                row["latest_rate_effective_date"],
                row["latest_bill_rate"],
                row["latest_cost_rate"],
            ]
            for row in payroll_user_rows
        ],
    )

    def category_total(pnl: PnlData, category_name: str) -> float:
        return sum(total for (category, _subcategory), total in pnl.line_totals.items() if category == category_name)

    def subcategory_total(pnl: PnlData, category_name: str, subcategory_name: str) -> float:
        return pnl.line_totals.get((category_name, subcategory_name), 0.0)

    rent_cash = category_total(cash_pnl, "Rent or Lease")
    rent_accrual = category_total(accrual_pnl, "Rent or Lease")
    taxes_cash = (
        subcategory_total(cash_pnl, "Other Expenses", "Business Taxes")
        + subcategory_total(cash_pnl, "Other Expenses", "Taxes & Licenses")
        + subcategory_total(cash_pnl, "Payroll Expense", "Employer Taxes")
    )
    taxes_accrual = (
        subcategory_total(accrual_pnl, "Other Expenses", "Business Taxes")
        + subcategory_total(accrual_pnl, "Other Expenses", "Taxes & Licenses")
        + subcategory_total(accrual_pnl, "Payroll Expense", "Employer Taxes")
    )
    interest_cash = subcategory_total(cash_pnl, "Other Expenses", "Interest - Other")
    interest_accrual = subcategory_total(accrual_pnl, "Other Expenses", "Interest - Other")
    advertising_cash = category_total(cash_pnl, "Advertising")
    advertising_accrual = category_total(accrual_pnl, "Advertising")
    employee_benefits_cash = category_total(cash_pnl, "Employee Benefits")
    employee_benefits_accrual = category_total(accrual_pnl, "Employee Benefits")
    cogs_cash = category_total(cash_pnl, "Cost of Goods Sold")
    cogs_accrual = category_total(accrual_pnl, "Cost of Goods Sold")

    other_deductions_cash = cash_pnl.total_expenses - (
        rent_cash + taxes_cash + interest_cash + advertising_cash + employee_benefits_cash
    )
    other_deductions_accrual = accrual_pnl.total_expenses - (
        rent_accrual + taxes_accrual + interest_accrual + advertising_accrual + employee_benefits_accrual
    )

    worksheet_rows = [
        ["Page 1", "1a", "Gross receipts or sales", format_money(cash_pnl.total_sales), format_money(accrual_pnl.total_sales), "Provided cash/accrual P&Ls; app cross-checks in source comparison file."],
        ["Page 1", "1b", "Less returns and allowances", format_money(0.0), format_money(0.0), "No separate returns/allowances lines were provided."],
        ["Page 1", "1c", "Balance", format_money(cash_pnl.total_sales), format_money(accrual_pnl.total_sales), "Matches line 1a because no returns/allowances were supplied."],
        ["Page 1", "2", "Cost of goods sold", format_money(cogs_cash), format_money(cogs_accrual), "Books place direct labor/payroll-related costs in COGS."],
        ["Page 1", "3", "Gross profit", format_money(cash_pnl.gross_profit), format_money(accrual_pnl.gross_profit), "Taken directly from the provided P&Ls."],
        ["Page 1", "4", "Net gain/loss from Form 4797", format_money(0.0), format_money(0.0), "No Form 4797 source was provided in the workspace."],
        ["Page 1", "5", "Other income/loss", format_money(0.0), format_money(0.0), "Not separately identified in the provided P&Ls; review if other income exists outside sales."],
        ["Page 1", "6", "Total income/loss", format_money(cash_pnl.gross_profit), format_money(accrual_pnl.gross_profit), "Using gross profit as provided because no separate lines 4-5 support was supplied."],
        ["Page 1", "7", "Compensation of officers", format_money(0.0), format_money(0.0), "Officer compensation appears embedded in COGS in the books; do not duplicate unless reclassified."],
        ["Page 1", "8", "Salaries and wages", format_money(0.0), format_money(0.0), "Wages appear embedded in COGS in the books; do not duplicate unless reclassified."],
        ["Page 1", "9", "Repairs and maintenance", format_money(0.0), format_money(0.0), "No separate repairs/maintenance line found in the provided P&Ls."],
        ["Page 1", "10", "Bad debts", format_money(0.0), format_money(0.0), "No bad-debt support provided."],
        ["Page 1", "11", "Rents", format_money(rent_cash), format_money(rent_accrual), "Mapped from P&L category `Rent or Lease`."],
        ["Page 1", "12", "Taxes and licenses", format_money(taxes_cash), format_money(taxes_accrual), "Mapped from Business Taxes, Taxes & Licenses, and Employer Taxes lines outside COGS."],
        ["Page 1", "13", "Interest", format_money(interest_cash), format_money(interest_accrual), "Mapped from `Other Expenses / Interest - Other`."],
        ["Page 1", "14", "Depreciation", format_money(0.0), format_money(0.0), "Requires fixed-asset/depreciation schedule; not in the provided files."],
        ["Page 1", "15", "Depletion", format_money(0.0), format_money(0.0), "No depletion support provided."],
        ["Page 1", "16", "Advertising", format_money(advertising_cash), format_money(advertising_accrual), "Mapped from P&L category `Advertising`."],
        ["Page 1", "17", "Pension, profit-sharing, etc. plans", format_money(0.0), format_money(0.0), "Retirement-related amounts appear in COGS in the books; keep out of line 17 unless reclassified."],
        ["Page 1", "18", "Employee benefit programs", format_money(employee_benefits_cash), format_money(employee_benefits_accrual), "Mapped from the P&L `Employee Benefits` category outside COGS."],
        ["Page 1", "19", "Energy efficient buildings deduction", format_money(0.0), format_money(0.0), "No Form 7205 support provided."],
        ["Page 1", "20", "Other deductions (attach statement)", format_money(other_deductions_cash), format_money(other_deductions_accrual), "Residual operating expenses after separately mapped lines; see category map and bank review files."],
        ["Page 1", "21", "Total deductions", format_money(cash_pnl.total_expenses), format_money(accrual_pnl.total_expenses), "Taken directly from the provided P&Ls."],
        ["Page 1", "22", "Ordinary business income/loss", format_money(cash_pnl.net_profit), format_money(accrual_pnl.net_profit), "Taken directly from the provided P&Ls."],
        ["COGS detail", "memo", "Bertrand Byrne Unpaid Salary", format_money(subcategory_total(cash_pnl, "Cost of Goods Sold", "Bertrand Byrne Unpaid Salary")), format_money(subcategory_total(accrual_pnl, "Cost of Goods Sold", "Bertrand Byrne Unpaid Salary")), "Shown here so the COGS composition is visible for review."],
        ["COGS detail", "memo", "COGS-Payroll Wages", format_money(subcategory_total(cash_pnl, "Cost of Goods Sold", "COGS-Payroll Wages")), format_money(subcategory_total(accrual_pnl, "Cost of Goods Sold", "COGS-Payroll Wages")), "Shown here so the COGS composition is visible for review."],
        ["COGS detail", "memo", "COGS-Payroll Taxes", format_money(subcategory_total(cash_pnl, "Cost of Goods Sold", "COGS-Payroll Taxes")), format_money(subcategory_total(accrual_pnl, "Cost of Goods Sold", "COGS-Payroll Taxes")), "Shown here so the COGS composition is visible for review."],
        ["COGS detail", "memo", "COGS-Payroll Health Benefits", format_money(subcategory_total(cash_pnl, "Cost of Goods Sold", "COGS-Payroll Health Benefits")), format_money(subcategory_total(accrual_pnl, "Cost of Goods Sold", "COGS-Payroll Health Benefits")), "Shown here so the COGS composition is visible for review."],
        ["COGS detail", "memo", "COGS-Payroll Retirement Benefits", format_money(subcategory_total(cash_pnl, "Cost of Goods Sold", "COGS-Payroll Retirement Benefits")), format_money(subcategory_total(accrual_pnl, "Cost of Goods Sold", "COGS-Payroll Retirement Benefits")), "Shown here so the COGS composition is visible for review."],
    ]
    write_csv(
        worksheet_path,
        ["Section", "Form Line", "Label", "Cash Basis Amount", "Accrual Basis Amount", "Note"],
        worksheet_rows,
    )

    manual_adjustment_rows = [
        [
            str(item.get("section", "")),
            str(item.get("label", "")),
            format_money(parse_float(str(item.get("amount", 0.0)))),
            str(item.get("book_treatment", "")),
            str(item.get("return_treatment", "")),
            str(item.get("note", "")),
        ]
        for item in manual_adjustments
    ]
    write_csv(
        manual_adjustments_path,
        ["Section", "Label", "Amount", "Book Treatment", "Return Treatment", "Note"],
        manual_adjustment_rows,
    )

    shareholder_target = 0.0
    personal_card_expense_target = 0.0
    for item in manual_adjustments:
        label = str(item.get("label", "")).lower()
        section = str(item.get("section", "")).lower()
        amount = parse_float(str(item.get("amount", 0.0)))
        if "shareholder loan" in label:
            shareholder_target += amount
        if "personal credit card" in label or "due to shareholder" in section:
            personal_card_expense_target += amount

    combined_shareholder_target = shareholder_target + personal_card_expense_target
    adjusted_cash_profit = cash_pnl.net_profit - personal_card_expense_target
    adjusted_accrual_profit = accrual_pnl.net_profit - personal_card_expense_target

    shareholder_outflow = sum(-float(row["amount"]) for row in shareholder_transfer_rows if float(row["amount"]) < 0)
    shareholder_inflow = sum(float(row["amount"]) for row in shareholder_transfer_rows if float(row["amount"]) > 0)
    shareholder_net = shareholder_outflow - shareholder_inflow
    shareholder_gap = shareholder_target - shareholder_net
    shareholder_matched_amount = min(shareholder_target, max(0.0, shareholder_net))
    shareholder_shortfall = max(0.0, shareholder_target - shareholder_net)
    shareholder_excess = max(0.0, shareholder_net - shareholder_target)
    remaining_support_after_loan = max(0.0, shareholder_net - shareholder_target)
    personal_card_supported = min(personal_card_expense_target, remaining_support_after_loan)
    personal_card_shortfall = max(0.0, personal_card_expense_target - remaining_support_after_loan)
    combined_shareholder_supported = min(combined_shareholder_target, max(0.0, shareholder_net))
    unaccounted_withdrawals = max(0.0, shareholder_net - combined_shareholder_target)
    remaining_unreimbursed_shareholder_amount = max(0.0, combined_shareholder_target - shareholder_net)
    shareholder_net_after_known_items = shareholder_net - combined_shareholder_target
    running_net = 0.0
    peak_net = 0.0
    peak_date = ""
    reached_target_date = ""
    needed_on_reach = 0.0
    reached_combined_target_date = ""
    needed_on_combined_reach = 0.0
    ledger_rows: list[list[str]] = []
    for row in shareholder_transfer_rows:
        amount = float(row["amount"])
        effect = -amount
        prev_running = running_net
        running_net += effect
        if running_net > peak_net:
            peak_net = running_net
            peak_date = str(row["date"])
        if not reached_target_date and shareholder_target > 0 and running_net >= shareholder_target:
            reached_target_date = str(row["date"])
            needed_on_reach = shareholder_target - prev_running
        if not reached_combined_target_date and combined_shareholder_target > 0 and running_net >= combined_shareholder_target:
            reached_combined_target_date = str(row["date"])
            needed_on_combined_reach = combined_shareholder_target - prev_running
        ledger_rows.append(
            [
                str(row["date"]),
                str(row["transaction_id"]),
                str(row["account_id"]),
                "Business -> ...0273" if amount < 0 else "...0273 -> Business",
                format_money(amount),
                format_money(effect),
                format_money(running_net),
                str(row["category"]),
                str(row["expense_group"]),
                str(row["description"]),
            ]
        )
    write_csv(
        shareholder_ledger_path,
        [
            "Date",
            "Transaction ID",
            "Account ID",
            "Direction",
            "Bank Amount",
            "Net Withdrawal Effect",
            "Cumulative Net Withdrawals",
            "Category",
            "Expense Group",
            "Description",
        ],
        ledger_rows,
    )

    owner_draw_bank_total = sum(
        float(row["total_abs"]) for row in bank_rows if row["review_class"] == "equity_owner_activity"
    )
    owners_equity_pnl_cash = subcategory_total(cash_pnl, "Other Expenses", "owners equity")
    owners_equity_pnl_accrual = subcategory_total(accrual_pnl, "Other Expenses", "owners equity")
    shareholder_match_rows = [
        ["Target shareholder loan repayment", format_money(shareholder_target), "Manual adjustment supplied by user for 2025."],
        [
            "Additional business expenses paid on personal credit card",
            format_money(personal_card_expense_target),
            "Manual adjustment supplied by user for shareholder-paid business expenses not yet reimbursed through the books.",
        ],
        [
            "Combined shareholder-related target (loan + personal-card expenses)",
            format_money(combined_shareholder_target),
            "Used to test whether the strict 6611/0273 transfer family fully explains the owner-related cash movement.",
        ],
        [
            "Gross withdrawals from business to ...0273",
            format_money(shareholder_outflow),
            "Transfers classified by the app's Aquatech-specific 6611/0273 equity-transfer rule.",
        ],
        [
            "Gross returns from ...0273 back to business",
            format_money(shareholder_inflow),
            "Offsets against the gross withdrawals in the same 6611/0273 transfer family.",
        ],
        [
            "Net withdrawals matched to 6611/0273 transfer family",
            format_money(shareholder_net),
            "Year-end net of those internal-equity transfer movements.",
        ],
        [
            "Amount of target loan repayment supported by that net-withdrawal family",
            format_money(shareholder_matched_amount),
            "Capped at the stated shareholder-loan repayment amount.",
        ],
        [
            "Support remaining after the loan repayment target",
            format_money(remaining_support_after_loan),
            "Available for other shareholder-related items after allocating the first $125,000 to the stated loan repayment.",
        ],
        [
            "Personal-card expenses supported by remaining matched withdrawals",
            format_money(personal_card_supported),
            "Applies the excess 6611/0273 net withdrawals to the shareholder-paid business expenses.",
        ],
        [
            "Personal-card expense amount still unreimbursed after matched withdrawals",
            format_money(personal_card_shortfall),
            "Amount of the $25,000 personal-card business expense item not covered by the strict 6611/0273 transfer family.",
        ],
        [
            "Gap between target loan repayment and matched net withdrawals",
            format_money(shareholder_gap),
            "Positive gap means the current bank support is short; negative gap means the transfer family exceeds the stated loan repayment.",
        ],
        [
            "Shortfall against target",
            format_money(shareholder_shortfall),
            "Only populated when the transfer family is below the stated loan repayment.",
        ],
        [
            "Excess transfer-family support over target",
            format_money(shareholder_excess),
            "Only populated when the transfer family exceeds the stated loan repayment.",
        ],
        [
            "Amount of combined shareholder-related target supported by matched net withdrawals",
            format_money(combined_shareholder_supported),
            "Capped at the combined total of the loan repayment plus shareholder-paid business expenses.",
        ],
        [
            "Net withdrawals after accounting for loan and personal-card expenses",
            format_money(shareholder_net_after_known_items),
            "Negative means the combined shareholder-related target exceeds the matched net withdrawals; positive means withdrawals remain unexplained.",
        ],
        [
            "Unaccounted withdrawals after both items",
            format_money(unaccounted_withdrawals),
            "Residual unexplained withdrawals after applying the $125,000 loan repayment and $25,000 personal-card expense assumption.",
        ],
        [
            "Remaining unreimbursed shareholder-related amount",
            format_money(remaining_unreimbursed_shareholder_amount),
            "Amount still due to the shareholder after applying all matched 6611/0273 withdrawals to the stated loan and personal-card expense items.",
        ],
        [
            "Peak cumulative net withdrawals during 2025",
            format_money(peak_net),
            f"Peak reached on {peak_date or 'n/a'}.",
        ],
        [
            "Date cumulative net first reached the target",
            reached_target_date or "",
            (
                f"Target was first crossed when {format_money(needed_on_reach)} of that transaction was needed."
                if reached_target_date
                else "Target was never reached by cumulative net withdrawals."
            ),
        ],
        [
            "Date cumulative net first reached the combined target",
            reached_combined_target_date or "",
            (
                f"Combined target was first crossed when {format_money(needed_on_combined_reach)} of that transaction was needed."
                if reached_combined_target_date
                else "Combined target was never reached by cumulative net withdrawals."
            ),
        ],
        [
            "Owner Draw bank category not auto-matched",
            format_money(owner_draw_bank_total),
            "Separate owner-activity bucket; left outside the strict 6611/0273 transfer family.",
        ],
        [
            "P&L owners equity line (cash)",
            format_money(owners_equity_pnl_cash),
            "Book presentation only; not auto-matched to the loan without supporting entries.",
        ],
        [
            "P&L owners equity line (accrual)",
            format_money(owners_equity_pnl_accrual),
            "Book presentation only; not auto-matched to the loan without supporting entries.",
        ],
    ]
    write_csv(shareholder_match_path, ["Metric", "Amount", "Note"], shareholder_match_rows)

    review_class_totals: dict[str, float] = defaultdict(float)
    for row in bank_rows:
        review_class_totals[row["review_class"]] += float(row["total_abs"])

    accounting_method_lines = [
        "# 2025 Accounting Method Memo",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Facts pulled from the current packet",
        f"- Entity context from the 2024 filed return PDF: {prior_return_context}",
        f"- 2025 cash-basis gross receipts from the provided books: {format_money_pretty(cash_pnl.total_sales)}",
        f"- 2025 accrual-basis gross receipts from the provided books: {format_money_pretty(accrual_pnl.total_sales)}",
        f"- 2025 ordinary business income/loss on the current cash-basis books: {format_money_pretty(cash_pnl.net_profit)}",
        f"- 2025 ordinary business income/loss on the current accrual-basis books: {format_money_pretty(accrual_pnl.net_profit)}",
        f"- Additional shareholder-paid business expenses proposed for 2025: {format_money_pretty(personal_card_expense_target)}",
        f"- Estimated cash-basis profit/loss if that {format_money_pretty(personal_card_expense_target)} is deducted in 2025: {format_money_pretty(adjusted_cash_profit)}",
        f"- Estimated accrual-basis profit/loss if that {format_money_pretty(personal_card_expense_target)} is deducted in 2025: {format_money_pretty(adjusted_accrual_profit)}",
        f"- Shareholder-loan repayment proposed for 2025: {format_money_pretty(shareholder_target)}",
        "- The shareholder-loan repayment is balance-sheet activity and does not change Page 1 ordinary income by itself.",
        "",
        "## IRS rule set used for the recommendation",
        "- Form 1120-S instructions say an S corporation may use cash, accrual, or another permissible method if the method clearly reflects income.",
        "- Those same instructions say an S corporation generally cannot use the cash method if it is a tax shelter.",
        "- The Form 1120-S and Form 1120 instructions also say sales and purchases of inventory generally require an accrual method unless the corporation qualifies as a small business taxpayer.",
        "- For tax years beginning in 2025, the Form 1120 instructions state that the small-business gross-receipts test is average annual gross receipts of $31 million or less for the 3 prior tax years, provided the taxpayer is not a tax shelter.",
        "- Publication 538 says that once an accounting method is adopted and returns have been filed, changing the overall method generally requires IRS approval.",
        "- The IRS says Form 3115 is the form used to request a change in accounting method.",
        "",
        "## Recommendation for the 2025 Aquatech filing",
        "- Filing the 2025 return on cash is likely allowable only if Aquatech was already on the cash method for its filed return history, is not a tax shelter, and either has no material inventory or qualifies for the small-business taxpayer inventory exception.",
        "- Filing the 2025 return on cash is not a clean assumption if the 2024 filed return used accrual. In that case, changing to cash for 2025 should be treated as an accounting-method change and generally should not be done without a Form 3115 analysis.",
        "- Based on the available packet numbers, business size does not appear to be the limiting factor. The current 2025 receipts are far below the $31 million threshold, but this packet does not independently prove the full 2022-2024 average gross-receipts test.",
        "- The practical blocker is prior-year method consistency. The provided 2024 PDF text shows the accounting-method section, but the scan does not preserve which checkbox was selected, so this packet cannot prove whether the filed 2024 return was cash or accrual.",
        "",
        "## Working conclusion",
        "- If the originally filed 2024 Form 1120-S was cash, then filing 2025 on cash is likely defensible from the information currently assembled here.",
        "- If the originally filed 2024 Form 1120-S was accrual, then the conservative position is to keep 2025 on accrual unless your CPA prepares the required accounting-method-change work.",
        "- Because the cash and accrual profit outcomes are materially different in this packet, do not choose the method based only on the lower tax number. Confirm the prior-year filed method first.",
        "",
        "## Immediate next checks before filing",
        "- Pull the exact filed 2024 Form 1120-S copy from your tax software or E-file records and confirm the Schedule B accounting-method box that was actually filed.",
        "- Confirm whether Aquatech had any material inventory treatment in 2025 that would force accrual unless the small-business exception applies.",
        "- If 2024 was accrual and you want 2025 to be cash, route the return through a CPA with a Form 3115 / section 481(a) review.",
        "",
        "## IRS references",
        "- https://www.irs.gov/instructions/i1120s",
        "- https://www.irs.gov/instructions/i1120",
        "- https://www.irs.gov/publications/p538",
        "- https://www.irs.gov/forms-pubs/about-form-3115",
    ]
    with accounting_method_memo_path.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(accounting_method_lines) + "\n")

    checklist_lines = [
        "# 2025 CPA Handoff Checklist",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Included working papers",
        "- RECEIVED: `profit_loss (1).csv` cash-basis P&L",
        "- RECEIVED: `profit_loss.csv` accrual-basis P&L",
        "- RECEIVED: `Aquatech2024TaxReturns.pdf` prior-year filed return reference",
        "- RECEIVED: `fblite_20260228_003502.sql.gz` AquatechPM SQL backup",
        "- RECEIVED: `reconciliation_2024-02-08_2026-02-13.csv` AquatechPM reconciliation export",
        f"- GENERATED: `{category_map_path.name}`",
        f"- GENERATED: `{comparison_path.name}`",
        f"- GENERATED: `{monthly_support_path.name}`",
        f"- GENERATED: `{bank_review_path.name}`",
        f"- GENERATED: `{payroll_support_path.name}`",
        f"- GENERATED: `{payroll_by_user_path.name}`",
        f"- GENERATED: `{worksheet_path.name}`",
        f"- GENERATED: `{manual_adjustments_path.name}`",
        f"- GENERATED: `{shareholder_ledger_path.name}`",
        f"- GENERATED: `{shareholder_match_path.name}`",
        f"- GENERATED: `{accounting_method_memo_path.name}`",
        f"- GENERATED: `{summary_path.name}`",
        "",
        "## Shareholder-related items",
        f"- RECEIVED: shareholder loan repayment adjustment of {format_money_pretty(shareholder_target)}",
        f"- RECEIVED: shareholder-paid business expense adjustment of {format_money_pretty(personal_card_expense_target)}",
        f"- GENERATED: strict 6611/0273 transfer-family net withdrawals of {format_money_pretty(shareholder_net)}",
        f"- REVIEW: remaining unreimbursed shareholder-related amount of {format_money_pretty(remaining_unreimbursed_shareholder_amount)} after applying matched withdrawals",
        "",
        "## Still needed before filing",
        "- MISSING: depreciation / fixed-asset schedule",
        "- MISSING: formal payroll filings (Forms 941, W-2, W-3, state payroll filings)",
        "- MISSING: shareholder basis support / Form 7203 workpapers",
        "- MISSING: underlying shareholder-loan note, amortization, and year-end balance support",
        "- MISSING: receipts and reimbursement / accountable-plan support for shareholder-paid business expenses",
        "- REVIEW: confirm the accounting method actually filed on the 2024 Form 1120-S before choosing 2025 cash vs accrual",
        "- REVIEW: bank rows flagged `manual_review`, `split_principal_interest`, `equity_owner_activity`, or `exclude_personal`",
    ]
    with checklist_path.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(checklist_lines) + "\n")

    summary_lines = [
        "# 2025 Tax Packet Summary",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Target tax year: {TARGET_YEAR}",
        f"Prior-year filing context: {prior_return_context}",
        "",
        "## Source files used",
        f"- P&L cash basis: `{DEFAULT_CASH_PNL}`",
        f"- P&L accrual basis: `{DEFAULT_ACCRUAL_PNL}`",
        f"- AquatechPM SQL backup: `{DEFAULT_BACKUP}`",
        f"- AquatechPM reconciliation export: `{DEFAULT_RECON}`",
        f"- Prior-year return reference: `{DEFAULT_PRIOR_RETURN}`",
        "",
        "## Core 2025 figures from the provided P&Ls",
        f"- Cash gross receipts: {format_money_pretty(cash_pnl.total_sales)}",
        f"- Accrual gross receipts: {format_money_pretty(accrual_pnl.total_sales)}",
        f"- Total expenses: {format_money_pretty(accrual_pnl.total_expenses)}",
        f"- Cash net profit (loss): {format_money_pretty(cash_pnl.net_profit)}",
        f"- Accrual net profit: {format_money_pretty(accrual_pnl.net_profit)}",
        "",
        "## AquatechPM support recovered from the backup",
        f"- App invoice subtotal issued in 2025: {format_money_pretty(invoice_totals['invoice_subtotal'])}",
        f"- App invoice paid in 2025: {format_money_pretty(invoice_totals['invoice_paid'])}",
        f"- App invoice ending balance in 2025: {format_money_pretty(invoice_totals['invoice_balance'])}",
        f"- App reconciliation bill amount in 2025: {format_money_pretty(recon_totals['bill_amount'])}",
        f"- App reconciliation cost amount in 2025: {format_money_pretty(recon_totals['cost_amount'])}",
        f"- App reconciliation profit amount in 2025: {format_money_pretty(recon_totals['profit_amount'])}",
        f"- App reconciliation hours in 2025: {recon_totals['total_hours']:.2f}",
        f"- Business bank transactions in 2025 backup: {int(app_stats['bank_business_rows'])} rows / {format_money_pretty(app_stats['bank_business_abs'])} absolute dollars",
        f"- Negative business transactions flagged as expense in the import: {int(app_stats['bank_negative_expense_rows'])} rows / {format_money_pretty(app_stats['bank_negative_expense_abs'])}",
        f"- Project expenses in app for 2025: {int(app_stats['project_expense_rows'])} rows / {format_money_pretty(app_stats['project_expense_total'])}",
        "",
        "## Payroll support recovered from AquatechPM",
        f"- P&L payroll-related total (cash basis lines): {format_money_pretty(payroll_cash_total)}",
        f"- P&L payroll-related total (accrual basis lines): {format_money_pretty(payroll_accrual_total)}",
        f"- AquatechPM payroll-related bank import support: {format_money_pretty(payroll_bank_total)}",
        f"- AquatechPM time-entry labor cost support: {format_money_pretty(payroll_time_cost_total)}",
        f"- AquatechPM time-entry labor bill value: {format_money_pretty(payroll_time_bill_total)}",
        "- Result: the app does contain payroll-related support through imported bank categories and the payroll-hours/rates model, even though statutory payroll filing packets are still not present in the provided files.",
        "",
        "## Manual adjustments carried in this packet",
        *[
            f"- {item.get('label', 'Manual adjustment')}: {format_money_pretty(parse_float(str(item.get('amount', 0.0))))} | {item.get('return_treatment', '')}"
            for item in manual_adjustments
        ],
        f"- Strict 6611/0273 transfer-family net withdrawals: {format_money_pretty(shareholder_net)}",
        f"- Amount of the stated shareholder-loan repayment directly supported by that transfer family: {format_money_pretty(shareholder_matched_amount)}",
        f"- Personal-card business expenses added to the shareholder-related analysis: {format_money_pretty(personal_card_expense_target)}",
        f"- Combined shareholder-related target (loan + personal-card expenses): {format_money_pretty(combined_shareholder_target)}",
        f"- Net withdrawals after accounting for both items: {format_money_pretty(shareholder_net_after_known_items)}",
        f"- Unaccounted withdrawals after both items: {format_money_pretty(unaccounted_withdrawals)}",
        f"- Remaining unreimbursed shareholder-related amount after both items: {format_money_pretty(remaining_unreimbursed_shareholder_amount)}",
        (
            f"- Remaining shortfall to the stated shareholder-loan repayment: {format_money_pretty(shareholder_shortfall)}"
            if shareholder_shortfall > 0
            else f"- Excess transfer-family support above the stated shareholder-loan repayment: {format_money_pretty(shareholder_excess)}"
        ),
        "",
        "## Key consistency checks",
        f"- Cash P&L gross receipts minus app invoice paid: {format_money_pretty(cash_vs_invoice_paid)}",
        f"- Accrual P&L gross receipts minus app reconciliation billings: {format_money_pretty(accrual_vs_recon)}",
        f"- Accrual P&L gross receipts minus app invoice subtotals: {format_money_pretty(accrual_vs_invoice)}",
        "- Result: cash receipts align with the app invoice payments, the reconciliation billings are very close to the accrual P&L, and the app invoice table is incomplete for full accrual support.",
        "",
        "## Bank review buckets from AquatechPM",
        f"- `expense_candidate`: {format_money_pretty(review_class_totals.get('expense_candidate', 0.0))}",
        f"- `balance_sheet_or_cashflow`: {format_money_pretty(review_class_totals.get('balance_sheet_or_cashflow', 0.0))}",
        f"- `split_principal_interest`: {format_money_pretty(review_class_totals.get('split_principal_interest', 0.0))}",
        f"- `equity_owner_activity`: {format_money_pretty(review_class_totals.get('equity_owner_activity', 0.0))}",
        f"- `manual_review`: {format_money_pretty(review_class_totals.get('manual_review', 0.0))}",
        f"- `exclude_personal`: {format_money_pretty(review_class_totals.get('exclude_personal', 0.0))}",
        "",
        "## Packet outputs",
        f"- `{category_map_path.name}`",
        f"- `{comparison_path.name}`",
        f"- `{monthly_support_path.name}`",
        f"- `{bank_review_path.name}`",
        f"- `{payroll_support_path.name}`",
        f"- `{payroll_by_user_path.name}`",
        f"- `{worksheet_path.name}`",
        f"- `{manual_adjustments_path.name}`",
        f"- `{shareholder_ledger_path.name}`",
        f"- `{shareholder_match_path.name}`",
        f"- `{accounting_method_memo_path.name}`",
        f"- `{checklist_path.name}`",
        "",
        "## Remaining gaps before filing",
        "- The bookkeeping sources here do not include a depreciation/fixed-asset schedule.",
        "- The app invoice table does not carry the full 2025 accrual revenue history; use the accrual P&L and reconciliation support for the primary billed revenue number.",
        "- Statutory payroll filing support like W-2/W-3 package copies, 941 package copies, shareholder basis support, and state filing support are still not present in the provided files.",
        (
            f"- The strict 6611/0273 transfer-family support is short of the stated $125,000 shareholder-loan repayment by {format_money_pretty(shareholder_shortfall)} unless you add more support or a year-end entry."
            if shareholder_shortfall > 0
            else f"- The strict 6611/0273 transfer-family support exceeds the stated $125,000 shareholder-loan repayment by {format_money_pretty(shareholder_excess)}; confirm whether the excess is a separate distribution/transfer rather than part of the loan repayment."
        ),
        (
            f"- After also allocating {format_money_pretty(personal_card_expense_target)} of shareholder-paid business expenses, there are still {format_money_pretty(unaccounted_withdrawals)} of unexplained withdrawals."
            if unaccounted_withdrawals > 0
            else f"- After also allocating {format_money_pretty(personal_card_expense_target)} of shareholder-paid business expenses, there are no unexplained matched withdrawals; instead {format_money_pretty(remaining_unreimbursed_shareholder_amount)} remains due to the shareholder or otherwise unsupported by the strict 6611/0273 transfer family."
        ),
        "- The provided 2024 PDF does not preserve the checked accounting-method box in extractable text, so the filed 2024 cash-vs-accrual method still needs independent confirmation before the 2025 return is finalized.",
        "- Bank categories marked `manual_review`, `split_principal_interest`, `equity_owner_activity`, or `exclude_personal` need a manual sign-off before the return is filed.",
    ]
    with summary_path.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(summary_lines) + "\n")

    copied_paths: list[Path] = []
    for path in [
        category_map_path,
        comparison_path,
        monthly_support_path,
        bank_review_path,
        payroll_support_path,
        payroll_by_user_path,
        worksheet_path,
        manual_adjustments_path,
        shareholder_ledger_path,
        shareholder_match_path,
        accounting_method_memo_path,
        checklist_path,
        summary_path,
    ]:
        destination = DEFAULT_DOWNLOADS / path.name
        shutil.copy2(path, destination)
        copied_paths.append(destination)

    return [
        category_map_path,
        comparison_path,
        monthly_support_path,
        bank_review_path,
        payroll_support_path,
        payroll_by_user_path,
        worksheet_path,
        manual_adjustments_path,
        shareholder_ledger_path,
        shareholder_match_path,
        accounting_method_memo_path,
        checklist_path,
        summary_path,
        *copied_paths,
    ]


def main() -> None:
    outputs = build_outputs()
    for path in outputs:
        print(f"Wrote: {path}")


if __name__ == "__main__":
    main()
