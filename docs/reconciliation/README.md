# Reconciliation Report (Step 1 Signoff)

This report validates imported data completeness and monthly totals.

## Outputs
- `reconciliation_<start>_<end>.json`
- `reconciliation_<start>_<end>.csv`

## Option A: Use API (recommended when app is running)
1. Get available data range:
   - `GET /reports/reconciliation-range`
2. Get JSON report:
   - `GET /reports/reconciliation?start=YYYY-MM-DD&end=YYYY-MM-DD`
3. Download CSV:
   - `GET /reports/reconciliation.csv?start=YYYY-MM-DD&end=YYYY-MM-DD`

These endpoints require a user with `VIEW_FINANCIALS`.

## Option B: Generate directly from DB (script)
From `backend/`:

```bash
PYTHONPATH=. DATABASE_URL='postgresql+psycopg://postgres:postgres@localhost:5432/fblite' \
~/.venv_tuflow/bin/python scripts/reconciliation_report.py
```

If running inside Docker Compose and database is in service `db`, use:

```bash
PYTHONPATH=. DATABASE_URL='postgresql+psycopg://postgres:postgres@db:5432/fblite' \
python scripts/reconciliation_report.py
```

## What the report includes
- Entity snapshot:
  - users, projects, tasks, subtasks, rates, time entry totals
- Monthly rollup:
  - entry count
  - unique users/projects/tasks/subtasks
  - total hours
  - bill/cost/profit totals
  - integrity checks:
    - orphan references (user/project/task/subtask)
    - zero/negative applied rates
