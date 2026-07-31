"""
Invoicing app configuration — the single source of truth for projects, rates, and
contract constants. NOTHING is hardcoded inside generation logic; it all lives here
(or in the ledger / billing-period table) so invoices are fully data-driven.
"""
from __future__ import annotations
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER_DIR = os.path.join(ROOT, "ledger")
PERIODS_CSV = os.path.join(ROOT, "ltcp4_billing_periods_2026.csv")
# Cloud service: invoice templates are BUNDLED here (no G: drive on the server).
TEMPLATES_DIR = os.path.join(ROOT, "templates")

# Company block for the FreshBooks-style invoice (matches the sent HDR invoice).
SIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "signatures")
SUPERVISOR_SIG = os.path.join(SIG_DIR, "_supervisor.png")


def employee_signature(full_name: str) -> str | None:
    """Path to an employee's signature image, or None if not on file."""
    p = os.path.join(SIG_DIR, f"{full_name}.png")
    return p if os.path.exists(p) else None


COMPANY = {
    "name": "Aquatech Engineering P.C.",
    "phone": "9175092423",
    "address": ["15 Bonita Vista Road", "Mount Vernon, NY  10552", "United States"],
    "logo": os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "aquatech_logo.png"),
}

# --- Approved BILLING rates (fixed per person; actual salary may be higher). --------
# Config, not logic. Principal bills labor+OH only (no profit). Effective-dated could
# be added later; for now a flat current map keyed by full name.
RATES = {
    "Zachary Gilliam":  52.26,
    "Stacey Hodge":     51.64,
    "Robert Svadlenka": 61.50,
    "Bertrand Byrne":   97.50,
    "Ailsa Welch":      75.00,
    "Roger Wang":       90.00,   # confirmed 2026-07-04 (derived 211.86 / 2.354; staff)
    "Qizhong Guo":     130.00,   # George Guo, rate table 2026 = 130.00
    "George Guo":      130.00,
}
PRINCIPALS = {"Bertrand Byrne"}
OH_RATE = 1.14
PROFIT_RATE = 0.10

# Invoice job titles (AqtPM only stores role=employee/admin). From the May invoice + rate table.
TITLES = {
    "Zachary Gilliam":  "Data Analyst",
    "Stacey Hodge":     "Engineer",
    "Robert Svadlenka": "Senior Engineer",
    "Bertrand Byrne":   "Chief Engineer/Principal",
    "Roger Wang":       "Senior Engineer",   # confirmed 2026-07-04
    "Ailsa Welch":      "Project Manager",
    "George Guo":       "Civil and Environmental Engineer",
    "Qizhong Guo":      "Civil and Environmental Engineer",
}
# Preferred display order for staff rows; anyone not listed sorts after, alphabetically.
STAFF_ORDER = ["Zachary Gilliam", "Stacey Hodge", "Robert Svadlenka", "Roger Wang",
               "Ailsa Welch", "George Guo", "Qizhong Guo"]

# Loaded-bill-rate multipliers (direct salary -> AqtPM bill_rate_applied), used to
# auto-derive a direct rate from AqtPM when someone isn't in RATES above, so a new
# employee can never silently produce a wrong invoice.
STAFF_MULT = 1.0 + OH_RATE + (1.0 + OH_RATE) * PROFIT_RATE   # 2.354
PRINCIPAL_MULT = 1.0 + OH_RATE                                # 2.14


def resolve_direct_rate(full_name: str, bill_rate_applied: float | None) -> float:
    """Direct salary rate for the invoice: config RATES first (authoritative), else
    unload the AqtPM applied bill rate. Raises if neither is available (fail loud)."""
    if full_name in RATES:
        return RATES[full_name]
    if bill_rate_applied:
        mult = PRINCIPAL_MULT if full_name in PRINCIPALS else STAFF_MULT
        return round(bill_rate_applied / mult, 2)
    raise ValueError(f"No billing rate for {full_name!r} — add to config.RATES "
                     f"or ensure AqtPM has an applied bill rate.")


def loaded_bill_rate(full_name: str, bill_rate_applied: float | None = None) -> float:
    """Authoritative LOADED bill rate = direct salary rate x OH/profit multiplier —
    the same rate the cost-plus sheet bills at. Use this for the FreshBooks-style
    per-line invoice so its lines foot to the official total, instead of trusting
    each time entry's stored bill_rate_applied (which can be a stale/flat rate, e.g.
    a $125 default, and would under-total the invoice)."""
    direct = resolve_direct_rate(full_name, bill_rate_applied)
    mult = PRINCIPAL_MULT if full_name in PRINCIPALS else STAFF_MULT
    return round(direct * mult, 2)

# --- Project registry --------------------------------------------------------------
# One entry per billable prime/contract. Drives the picker + all downstream generation.
#   aqtpm_project_id : the AqtPM Project.id to pull hours from
#   prime            : who the invoice is billed to
#   invoice_prefix   : invoice-number prefix; next number auto-increments from the ledger
#   periods_csv      : billing-period schedule (begin/end per period #)
#   template_xlsx    : the real client invoice template to fill (formula-driven)
#   out_root         : G: folder where monthly packages are saved
#   labor_max/odc_max/po : contract constants that live on the invoice
PROJECTS = {
    "HDR_LTCP4": {
        "label": "LTCP4 (HDR)",
        "aqtpm_project_id": 4,
        "prime": "Henningson, Durham & Richardson Architecture and Engineering, P.C.",
        "invoice_prefix": "HDRAQ",
        "periods_csv": PERIODS_CSV,
        "template_xlsx": os.path.join(TEMPLATES_DIR, "HDR_template.xlsx"),
        "out_root": r"G:\Shared drives\Aquatech_Admin\Invoicing\HDR",
        "out_folder_fmt": "HDR Invoice {month_name} {year}",
        "labor_max": 1277886.72,
        "odc_max": 8200.0,
        "po": "PO# 1000100113624",
        # FreshBooks-style invoice header
        "fb_billed_to": ["HDR LTCP", "HDR"],
        "fb_due_days": 60,
        "fb_line_task": "Task 1-Compile and Verify InfoWorks Models",
        "ledger": os.path.join(LEDGER_DIR, "hdr_ltcp4.json"),
        # how to find this project's invoices in AqtPM's FreshBooks-synced records
        "fb_match": {"client_ilike": "HDR", "number_like": "%DRAQ%"},
        # employees who appear on this project's timesheet backups
        "timesheet_employees": [
            ("Zachary", "Gilliam"),
            ("Robert", "Svadlenka"),
            ("Bertrand", "Byrne"),
        ],
    },
    "STANTEC": {
        "label": "BWT Design Assistance (Stantec/B&C JV)",
        "format": "stantec",                     # NYCDEP cost-plus template, multi-subtask summary
        "aqtpm_project_id": 2,
        "prime": "Stantec/Brown and Caldwell",
        "invoice_prefix": "SBCAQ",
        "bill_period": "month",                  # bills by calendar month (no period CSV)
        "template_xlsx": os.path.join(TEMPLATES_DIR, "STANTEC_template.xlsx"),
        "out_root": r"G:\Shared drives\Aquatech_Admin\Invoicing\Stantec B&C JV",
        "out_folder_fmt": "{mon} {year} Stantec BC JV",       # e.g. "Mar 2026 Stantec BC JV"
        "inv_name_fmt": "Stantec B&C JV Sub-Consultant Invoicing_Aquatech {month_name} {year} {stamp}.xlsx",
        "contract_start": "2025-01-23",          # C20 support-services period begin
        "default_subtask_label": "Task 3.2 - Jamaica Bay Beneficial Use",
        "ledger": os.path.join(LEDGER_DIR, "stantec_bcjv.json"),
        "timesheet_employees": [("Ailsa", "Welch"), ("Robert", "Svadlenka"), ("Bertrand", "Byrne")],
    },
    "JBCON": {
        "label": "BWT 1608-JobCon (Brown & Caldwell)",
        "format": "jobcon",                      # B&C's own multi-tab workbook
        "aqtpm_project_id": 13,
        "prime": "Brown and Caldwell",
        "invoice_prefix": "BACAQ",
        "bill_period": "month",
        "template_xlsx": os.path.join(TEMPLATES_DIR, "JBCON_template.xlsx"),
        "out_root": r"G:\Shared drives\Aquatech_Admin\Invoicing\Brown and Caldwell",
        "out_folder_fmt": "{month_name} {year}",              # e.g. "July 2026"
        "inv_name_fmt": "BWT-1608-JBCON_Aquatech Subinvoice {month_name} {year}.xlsx",
        "recipients": ["NYPayables@brwncald.com", "Julie Whitlock <jwhitlock@brwncald.com>"],
        "cc": ["Bertrand Byrne"],
        "default_subtask_code": "2.01.003",
        "ledger": os.path.join(LEDGER_DIR, "jobcon_bc.json"),
        "timesheet_employees": [("Ailsa", "Welch"), ("Robert", "Svadlenka"), ("Bertrand", "Byrne")],
    },
}

# --- SSH data source (prod Postgres via existing deploy key) ------------------------
SSH_KEY = "~/.ssh/aquatech_deploy_key"
SSH_HOST = "bertrand_byrne@35.186.187.114"
DOCKER_BACKEND = "aquatechpm_backend_1"
