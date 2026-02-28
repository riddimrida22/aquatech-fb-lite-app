# AquatechPM Day-1 Operations Runbook (2026-02-27)

## Purpose
This runbook is for launch-day admins to verify the app is healthy and perform routine daily workflows with minimal risk.

## 1. Quick Health Check (2 minutes)
1. Open `https://app.aquatechpc.com/health`.
2. Confirm response includes: `"ok": true` and `"app": "aquatechpm"`.
3. Log into the app and confirm dashboard loads without error.

## 2. Bank Workflow (Settings)
### 2.1 Bank Connections
1. Go to `Settings` -> `Bank Connections`.
2. Confirm expected connections are listed.
3. For Plaid connections, click `Sync Now` once.
4. Confirm account count and transaction count update.

### 2.2 Bank Transactions
1. Go to `Settings` -> `Bank Transactions`.
2. If Plaid is connected, click `Reconcile CSV vs Plaid Duplicates`.
3. Click `Apply Smart Category Recommendations`.
4. Use filters (`Connection`, `Group`, `Sort`) to review exceptions.
5. Use `Post To Project Expense` only after selecting the correct project.

## 3. Timesheet Workflow (Daily)
1. Open `Timesheets`.
2. Confirm current week is selected.
3. For admins: switch employee selector and verify period does not change unexpectedly.
4. Confirm totals look correct before submit/approve actions.

## 4. Invoicing Workflow (Weekly)
1. Open `Invoices` -> `Studio`.
2. Generate preview for target period.
3. Confirm line totals and client/project mapping.
4. Create invoice and validate it appears under `Saved Invoices`.

## 5. Reports Sanity (Weekly)
1. Open `Reports` -> `Financial`.
2. Confirm budget/revenue/cost/profit cards populate.
3. Open `Reports` -> `Timesheets` and confirm counts are non-zero as expected.

## 6. Known Operational Guardrails
- Do not connect personal accounts in Plaid for production bookkeeping.
- Keep business/personal account classification accurate.
- If bank queue appears inflated, run duplicate reconciliation before manual categorization.
- If smart categorization errors, capture exact timestamp and action label for log tracing.

## 7. Smoke Test Endpoints
- `GET /health` via `https://app.aquatechpc.com/health`
- API route passthrough: `https://app.aquatechpc.com/api/health`

## 8. Escalation Triggers
Escalate immediately if any occur:
- Repeated `500` on bank sync/reconciliation actions.
- Google sign-in callback hangs for more than 30 seconds.
- Timesheet period or totals change unexpectedly when switching employee.
- Invoices fail to create with validated preview lines.
