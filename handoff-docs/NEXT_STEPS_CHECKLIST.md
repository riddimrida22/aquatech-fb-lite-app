# Aquatech Next Steps Checklist

## 1) Data Recovery and Validation
- Confirm all approved FreshBooks CSV files imported successfully.
- Verify users, projects, WBS, rates, and time entries are complete.
- Generate historical timesheets for imported periods where needed.

## 2) 2026 Rate Override Policy
- Set final employee rates with `effective_date = 2026-01-01`.
- Reapply rates to entries for `2026-01-01` through `2026-12-31`.
- Confirm pre-2026 entries are unchanged.

## 3) Timesheets UX Polish
- Finish FreshBooks-style weekly table and day drilldown behavior.
- Refine filters and default period behavior for easier navigation.

## 4) Project Performance Accuracy
- Optionally enforce each project `start_date` as a reporting cutoff.
- Validate budget/margin/profit calculations against known checks.

## 5) CSV Import Robustness
- Add reusable mapping presets for different CSV layouts.
- Improve import audit output (imported/skipped/errors with reasons).

## 6) Security and Operations
- Move Google client secrets out of `docker-compose.yml` into env file(s).
- Add Postgres backup and restore scripts for the Docker volume.
- Add one-click health check script for frontend/backend/db.

## 7) Final UI Pass
- Clean up labels, spacing, and table readability.
- Improve dashboard cards and drilldowns across desktop/mobile.

## 8) Release Readiness
- Create smoke-test checklist for admin and employee workflows.
- Add baseline test script for login/import/rates/timesheets/reports.
