# 2025 Tax Expense Documentation Guide

Use the AquatechPM Expense_CAT workspace and the accounting/reconciliation APIs to assemble the expense detail your accountant needs for the 2025 returns. The sections below track the flows that were already imported via the Expense_CAT project (see `frontend/app/page.tsx` and `backend/app/main.py`) and show which outputs feed the tax narrative.

## 0. Generated packet outputs
- Run `backend/scripts/generate_2025_tax_packet.py` from the repo root with `.env_py/bin/python` to regenerate the 2025 packet from the SQL backup, reconciliation export, the two 2025 P&L CSVs in Downloads, and the prior-year return PDF.
- The script writes these working papers into `docs/compliance` and also copies them to `C:\Users\bertr\Downloads`:
  - `2025-tax-packet-summary.md`
  - `2025-tax-source-comparison.csv`
  - `2025-tax-monthly-support.csv`
  - `2025-tax-bank-category-review.csv`
  - `2025-tax-payroll-support.csv`
  - `2025-tax-payroll-by-user.csv`
  - `2025-tax-1120s-draft-worksheet.csv`
  - `2025-tax-manual-adjustments.csv`
  - `2025-tax-shareholder-loan-ledger.csv`
  - `2025-tax-shareholder-loan-match.csv`
  - `2025-tax-accounting-method-memo.md`
  - `2025-tax-cpa-handoff-checklist.md`
  - `2025-draft-1120S-NOT-FOR-FILING.xlsx`
  - `2025-draft-1120S-NOT-FOR-FILING.md`
  - `2025-tax-pl-category-map.csv`
- Treat those packet files as the current front door for the 2025 return; the sections below explain the underlying source flows that feed them.

## 1. Confirm the Expense_CAT upload
- Open the Reconciliation queue in the UI (Settings → Bank → Queue) or call `GET /bank/reconciliation/queue` to review the imported rows. Each row follows the `BankReconciliationQueueRow` shape and lists posted date, merchant, amount, category/expense group, and any suggested invoice context.
- The CSV picker on the front end posts to `POST /bank/import/expense-cat-categorized` with `connection_name=Expense_CAT Import` and `default_is_business`. The handler lives at `backend/app/main.py:1486` and ensures the transactions are tagged as business when `default_is_business=true`.
- Toggle the `include_personal` query parameter if you need to separate personal transactions that snuck into the import; the backend filters on `BankTransaction.is_business` when `include_personal=false`.

## 2. Summarize categories for tax schedules
- Use `GET /bank/summary` with `group_by=category`, `expense_group`, or `merchant` to generate the totals that will populate Schedule C (or corporate equivalents). The response is a list of `BankExpenseSummaryRow` records showing `dimension`, `label`, `transaction_count`, and `amount_abs`. Adjust `unmatched_only`, `limit`, and `include_personal` to widen the scope or include already reconciled items.
- Review the UI “Expense Mix” highlights (same data surfaced in `frontend/app/page.tsx`) to confirm that large buckets match the imported CSV categories. If you reclassify a transaction, the same endpoint is used when the UI posts to `/bank/transactions/{bank_transaction_id}/categorize`.
- When you assign a transaction to a project, call `POST /bank/transactions/{bank_transaction_id}/post-expense` to copy it into the `ProjectExpense` table, which makes it easier to show how project costs funnel into taxable overhead.

## 3. Tie manual or project expenses into the packet
- Export project-level expenses via `GET /projects/{project_id}/expenses`. Each `ProjectExpenseOut` row exposes `expense_date`, `category`, `description`, and `amount`, so you can break down overhead or client-support spend for documentation.
- Add items that never hit the bank feed (petty cash, contractor stipends, etc.) through `POST /projects/{project_id}/expenses` with a payload such as `{"expense_date":"2025-02-15","category":"Contractor","description":"Subconsultant","amount":1234.56}`.

## 4. Produce the reconciliation report
- The reconciliation report (see `backend/scripts/reconciliation_report.py`) aggregates hours, bills, costs, and integrity checks. Use `GET /reports/reconciliation-range` to determine the available span, then download the raw data with `GET /reports/reconciliation` and the CSV with `GET /reports/reconciliation.csv` (both require `VIEW_FINANCIALS`).
- Running `backend/scripts/reconciliation_report.py` writes the same JSON/CSV files into `docs/reconciliation` with filenames like `reconciliation_2024-02-08_2026-02-13.*`. The script uses `_reconciliation_rows` from `backend/app/main.py`, so it mirrors the API output and can be scheduled after each data freeze for the 2025 tax packet.

## 5. Supplement with related reports
- Use `GET /reports/ar-summary` to capture open invoice balances and overdue amounts, which explain revenue recognition timing. Combine that with `GET /reports/payroll-hours` or `GET /time-entries/export.csv` for labor cost support when needed.
- Keep an eye on `/bank/reconciliation/match` and `/bank/reconciliation/reconcile-imported` if you suspect duplicates between Expense_CAT and Plaid; clearing those prevents inflated expense totals.

## 6. Deliverables for the accountant
1. Bank summary by expense category (`/bank/summary`) tied to the Expense_CAT bucket names, with notes about any personal transactions excluded.
2. Project expense exports (`/projects/{project_id}/expenses`) showing each occurrence with its category and description.
3. Reconciliation CSV/JSON covering the 2025 calendar year for the overall hours, bill, cost, profit, and integrity checks (`/reports/reconciliation` or `backend/scripts/reconciliation_report.py`).
4. Optional: invoice revenue status, accounts receivable summary, and payroll/time-entry exports if they factor into taxable income.
5. Classification audit trail from `/audit/events` (filter by `categorize_bank_transaction`) in case you need to explain late-stage reclassifications to the CPA.

## 7. Next steps
- Resolve any “needs_review” flags before finalizing the exports, rerun `/bank/summary` to lock the totals, and archive the CSV dump alongside the receipts you already imported.
- Keep the reconciliation script outputs in `docs/reconciliation`, update them whenever you make material changes, and cross-check them against `C:\Users\bertr\Downloads\Aquatech2024TaxReturns.pdf` so the new totals stay aligned with last year’s filing.
