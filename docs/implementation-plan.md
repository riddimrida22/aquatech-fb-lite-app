# Implementation Plan

## Milestone 1: Foundation + Access Control
- Implement Google OAuth callback and ID token validation.
- Restrict sign-in to `aquatechpc.com` users.
- Auto-create inactive users on first login; admin activation flow.
- Add role + permission model and server-side authorization middleware.
- Build app shell and permission-aware navigation.

## Milestone 2: Project/WBS/Budgets/Rates
- Project model with PM/client rules for non-overhead projects.
- Task/subtask hierarchy and CRUD.
- Subtask budgets (hours + fee) and rollups.
- Bill/cost rate tables and cost profile generator.

## Milestone 3: Time + Timesheets + Approvals
- Enforce Project -> Task -> Subtask linkage on time entry.
- Snapshot applied bill/cost rates on time entries.
- Weekly timesheet generation and edit/submit flow.
- Employee + supervisor e-signatures and approval states.

## Milestone 4: Dashboards + Timeframes
- Date-range query framework (pay period/custom/template).
- Budget vs actual and margin drilldowns.
- Saved timeframe templates.

## Milestone 5: Invoicing
- Invoice-per-project workflow with detailed line generation.
- Client-specific HTML/Jinja template system.
- PDF generation + downloadable archive.

## Milestone 6: Accounting CSV + Month Close
- CSV parser with canonical mapping and alias handling.
- Vendor normalization + dedupe hash.
- Rule engine (exact/regex/keyword/amount range).
- Reimbursable/big-ticket allocation policy checks.
- Month lock and export bundle generation.
