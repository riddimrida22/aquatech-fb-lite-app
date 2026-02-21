# Go-Live Checklist (Screen-by-Screen)

Date baseline: February 21, 2026

## 1) System Preflight (Admin)
1. Run `./scripts/launch_preflight.sh` and confirm no `FAIL`.
2. Run `./scripts/smoke_test_launch.sh` and confirm `PASS`.
3. Confirm Docker services are up (`frontend`, `backend`, `db`).

## 2) Access Screen
1. Sign in using company Google account.
2. Confirm role and session display correctly.
3. Confirm inactive users cannot access protected views.

## 3) People & Rates Screen
1. Confirm all active employees exist and are active.
2. Confirm each active employee has a current bill/cost rate.
3. Confirm no pending users are left unreviewed.

## 4) Projects Screen
1. Confirm project metadata is complete (name/client/PM/start date).
2. Confirm billable/non-billable project settings are correct.
3. Confirm each active project has required tasks/subtasks.
4. Confirm non-billable tasks are correctly flagged where needed.
5. Confirm project expenses load and totals appear correctly.

## 5) Time Screen (Employee Flow)
1. Enter time for project/task/subtask with notes.
2. Edit one entry and confirm save.
3. Delete one test entry and confirm removal.
4. Confirm daily/weekly totals look correct.

## 6) Timesheets Screen (Approval Flow)
1. Generate weekly timesheet for at least one employee.
2. Submit timesheet from employee account.
3. Approve from manager/admin account.
4. Confirm approved status appears in both employee/admin views.

## 7) Accounting -> Invoicing Studio
1. Select date range and project filter.
2. Refresh preview and confirm only expected billable lines appear.
3. Verify notes from time entries show in invoice preview lines.
4. Create invoice and confirm it appears in Saved Invoices.
5. Update payment status manually (paid/partial/sent/void) and verify A/R update.

## 8) Accounting -> Recurring Invoices
1. Create one weekly or monthly schedule.
2. Run `Run Due Schedules Now`.
3. Confirm generated invoices appear and no duplicates are created for same schedule+period.
4. Pause/reactivate a schedule and verify status updates.

## 9) Accounting -> Legacy FreshBooks Import
1. Run preview mode first.
2. Confirm mapping and row counts.
3. Run apply mode.
4. Confirm imported invoices and balances appear in Saved Invoices and A/R.

## 10) Dashboard / Financial Review
1. Confirm project performance numbers populate.
2. Confirm negative values display in accounting format (red parentheses).
3. Confirm A/R aging and top clients render and reconcile with known invoices.

## 11) Final Launch Gate
All items below must be true:
1. `DEV_AUTH_BYPASS=false` and `NEXT_PUBLIC_DEV_AUTH_BYPASS=false`.
2. OAuth values and `SESSION_SECRET` are non-placeholder.
3. Reminder settings are intentionally set (enabled with SMTP, or disabled by choice).
4. At least one full end-to-end test completed: time -> approval -> invoice -> payment status update.
5. Team owner signs off after walkthrough.

## Operational Note
Run the app/database on local/server storage, not from a Google Drive sync directory.  
Use restricted Google Drive only for scheduled encrypted backups and exported reports.
