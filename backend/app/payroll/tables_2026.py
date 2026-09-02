"""2026 payroll tax constants and rates.

Everything here is *data*, versioned by year, so the annual January refresh is a
data change — never a code change. Rates marked DERIVED were reverse-engineered
from the Paychex golden-stub run (2026-08-21) and reproduce it to the penny;
they should still be reconciled against the official 2026 agency publications
before go-live (VERIFY tags).

Company-specific experience rates (employer UI/SDI) are NOT here — they come from
each year's state rate-notice and live in company config, because they differ
per employer. See EMPLOYER_RATE_NOTES.
"""

from __future__ import annotations

YEAR = 2026

# --- Federal FICA / FUTA ---
SS_RATE = 0.062                 # employee and employer each
SS_WAGE_BASE = 181_200         # VERIFY official 2026 SSA figure (placeholder)
MEDICARE_RATE = 0.0145         # employee and employer each
ADDL_MEDICARE_RATE = 0.009     # employee only, on wages over the threshold
ADDL_MEDICARE_THRESHOLD = 200_000
FUTA_RATE = 0.006              # net rate after full state credit (0.6%)
FUTA_WAGE_BASE = 7_000

# --- New York (employee-side) ---
NY_SDI_WEEKLY = 0.60           # statutory max employee DBL contribution / week
NY_PFL_RATE = 0.00432          # DERIVED 2026 (stub: 1.71/396.92, 17.63/4081, ...) — VERIFY
NY_PFL_WAGE_CAP = 91_373.88    # VERIFY 2026 cap (SAWW x 52); no one here is near it

# --- New Jersey (employee-side) ---
NJ_TDI_EE_RATE = 0.0042        # DERIVED (stub: 12.85/3060) — VERIFY official 2026 NJ TDI EE
NJ_UI_EE_RATE = 0.003825       # DERIVED (stub: 11.70/3060) — VERIFY (UI+WF employee split)
NJ_WF_EE_RATE = 0.000425       # DERIVED (stub: 1.30/3060) — "NJ EE Work Dev" — VERIFY
NJ_TDI_EE_WAGE_BASE = 165_400  # VERIFY 2026
NJ_UI_EE_WAGE_BASE = 43_300    # VERIFY 2026
# NJ FLI (family leave) did not appear on the stub for this employee this run;
# add NJ_FLI_EE_RATE + base once confirmed for 2026.

EMPLOYER_RATE_NOTES = """
Employer UI/SDI are EXPERIENCE-RATED (per-employer, from the annual state rate
notice) and wage-base capped, so they live in company config + need the YTD
ledger, not in this file. Golden-stub employer lines to reconcile once configured:
  NY Unemploy 39.10, NY Re-empl Svc (RSF 0.075%) 1.61   (NY UI base ~ VERIFY)
  NJ Disability(ER) 15.30 (~0.50%), NJ Unemploy(ER) 82.08 (~2.6824%), NJ ER Work Dev 3.60
  FUTA 4.33 (0.6% of remaining-under-$7k wages -> needs YTD)
"""

# --- Income-tax tables (Fed Pub 15-T, NY NYS-50-T, NYC, NJ NJ-WT) ---
# TODO(next): percentage-method brackets per filing status + pay frequency.
# Requires each employee's W-4 / IT-2104 / NJ-W4 (the onboarding data) as inputs.
FED_PERCENTAGE_METHOD: dict = {}   # TODO
NY_WITHHOLDING: dict = {}          # TODO
NYC_WITHHOLDING: dict = {}         # TODO
NJ_WITHHOLDING: dict = {}          # TODO
