"""AqtPM in-house payroll engine (Option A — DIY, self-file).

Replaces Paychex: the app computes gross->net + all tax lines; the owner
self-files/remits (EFTPS/NY/NJ) and pushes ACH direct deposits. See
memory `aquatechpm_payroll_app` and docs/PAYROLL.md for the full plan.

Modules:
  tables_2026  - versioned tax rates/constants (data, not code)
  engine       - pure penny-critical calculation (no DB/IO)
  models       - SQLAlchemy tables (employees, runs, lines, tax versions)
  golden/      - real Paychex journals used as penny-accurate test fixtures
"""
