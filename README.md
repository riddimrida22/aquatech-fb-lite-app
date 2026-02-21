# Aquatech FB-Lite

Internal web app for Aquatech Project Controls + Light Accounting based on the handoff package.

## Easiest Way To Run (Windows)
1. Open this folder in Windows Explorer:
- `C:\Users\bertr\Documents\Projects\Codex\aquatech-fb-lite-app`
2. Double-click: `Start_Aquatech_App.bat`
3. Wait for it to finish starting. Your browser opens automatically.

To stop the app later, double-click: `Stop_Aquatech_App.bat`

If you only want to reopen the app page in browser, double-click: `Open_Aquatech_App.bat`


## Desktop Shortcut (One Time)
1. Double-click `Create_Desktop_Shortcut.bat` in this folder.
2. A desktop icon named **Aquatech FB-Lite** will be created.
3. Double-click that desktop icon anytime to start the app.

## Important First-Time Requirement
- Docker Desktop must be installed and running before you click start.

## Launch Configuration (Required)
1. Copy `.env.example` to `.env`
- `cp .env.example .env`
2. Set real values in `.env` for:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET` (long random string)
- `POSTGRES_PASSWORD` and `DATABASE_URL` (matching password)
3. For production launch, keep:
- `DEV_AUTH_BYPASS=false`
- `NEXT_PUBLIC_DEV_AUTH_BYPASS=false`
4. Optional reminders (weekday 3 PM):
- Set `TIMESHEET_REMINDER_ENABLED=true`
- Configure `SMTP_HOST`, `SMTP_FROM_EMAIL`, and SMTP auth values.
5. Run preflight:
- `./scripts/launch_preflight.sh`

## What Is Implemented
- Google OAuth sign-in flow with domain restriction (`aquatechpc.com`) and server session auth.
- Dev session auth flow with bootstrap admin (optional, when `DEV_AUTH_BYPASS=true`).
- Role/permission-enforced backend routes.
- User activation workflow (new users start inactive).
- Projects, tasks, subtasks (WBS) with required non-overhead project validation.
- User rates and time entries with Project -> Task -> Subtask validation.
- Weekly timesheet generation, submit, and manager/admin approval.
- Project margin dashboard endpoint for date ranges.
- Accounting CSV import preview endpoint using canonical mapping logic and dedupe hash.
- Recurring invoice schedules (weekly/monthly), manual run, and automatic daily runner.
- Secure invoice payment links with public payment page and payment posting (feature can remain disabled for bank-first workflow).

## Included Handoff Docs
- `handoff-docs/SOW_Technical_Spec.md`
- `handoff-docs/Architecture_Overview.md`
- `handoff-docs/CSV_Import_Mapping.md`

## First-Run Workflow In The App
1. Configure Google OAuth env vars in `.env`:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (must match Google Cloud OAuth redirect exactly)
2. Use **Sign In With Google** in the app.
3. First admin can still be created via **Bootstrap Admin** when `DEV_AUTH_BYPASS=true`.
4. New Google users are created as inactive employees; admin activates them in `People & Rates`.
5. Configure rates, create projects/WBS, enter time, generate and approve timesheets.

## One-Command Smoke Test
Run from this folder after the app is up:
- `./scripts/smoke_test.sh`

Launch-mode smoke test (works with `DEV_AUTH_BYPASS=false`):
- `./scripts/smoke_test_launch.sh`

Screen-by-screen launch checklist:
- `docs/GO_LIVE_CHECKLIST_2026-02-21.md`

Optional overrides:
- `BASE_URL=http://localhost:8000`
- `ADMIN_EMAIL=bertrand.byrne@aquatechpc.com`
- `ADMIN_NAME="Bertrand Byrne"`
- `ACCOUNT_ID=OPERATING-001`

## Current Gap To Production
- Invoice template/PDF generation and month-close export packaging are not fully implemented yet.
- No automated recurring invoice schedule/reminder workflow yet.
- No native ACH/card payment collection workflow in-app yet.
