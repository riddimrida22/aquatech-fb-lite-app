# Aquatech Project Controls + Light Accounting (CPA/QBO Export)
## Developer Handoff Package (SOW + Technical Spec)

**Company:** Aquatech Engineering P.C.  
**Workspace domain:** aquatechpc.com  
**Pay period:** 14 days  
**Pay period anchor (start):** 2026-02-02 (Monday)  
**First pay period:** 2026-02-02 → 2026-02-15

### Objective
Build an internal web app to replace FreshBooks for:
- Subtask-required time entry (Project → Task → Subtask)
- Weekly timesheets with employee and supervisor e-signatures + approval workflow
- Subtask budgets (hours + fee) and near-real-time margin dashboards with drilldowns
- Invoice creation (invoice per project; detailed lines) using client-specific HTML templates → PDF
- Light accounting support: monthly CSV uploads (bank + credit card), rules-based auto-categorization mapped to QuickBooks Online Chart of Accounts, allocate to projects only for reimbursables/big-ticket, and export CPA/QBO-ready month packages.

### Out of scope (MVP)
- Full accounting system of record (double-entry ledger replacement)
- Full bank connections (Plaid/Teller) — CSV only
- Payments processing
- Sales tax/VAT

### Roles & Permissions
Roles: employee, manager, admin.  
Capabilities (server-side enforced):
VIEW_FINANCIALS, MANAGE_PROJECTS, MANAGE_WBS, APPROVE_TIMESHEETS, MANAGE_RATES,
MANAGE_COST_PROFILES, MANAGE_INVOICE_TEMPLATES, MANAGE_ACCOUNTING_RULES,
RUN_MONTH_CLOSE_EXPORT, MANAGE_TIMEFRAMES.

### Key business rules
- Non-overhead projects require Client + PM.
- Time entries require subtask; backend validates subtask belongs to selected project/task.
- Time entries store applied bill/cost rates for instant dashboards (historical stability).
- Budgets live at subtask level (hours + fee), roll up to task/project.
- Dashboards filter by start/end; supports pay periods + custom ranges + optional templates.
- Google Workspace login restricted to aquatechpc.com; auto-create inactive user on first login; admin activates.

### Accounting (light)
- Import monthly checking and credit card CSVs.
- Apply rules (vendor/keywords/amount/account) → QBO account name + flags + optional splits.
- Allocate to projects only for reimbursables or big-ticket items (configurable threshold).
- Month close locks month and generates CPA/QBO export package:
  - Transactions_For_QBO.csv (split lines included)
  - Reimbursables report
  - Exceptions/NeedsReview report
  - Summary

### Milestones (fixed-scope recommended)
1) Foundation + Google SSO + permissions + app shell
2) Projects/WBS/Budgets + Rates + Cost Profiles generator
3) Time entry + Timesheets + e-sign approvals
4) Dashboards + Timeframes (pay periods + custom + templates)
5) Invoices (client templates → PDF)
6) Accounting CSV import + rules + month close exports

