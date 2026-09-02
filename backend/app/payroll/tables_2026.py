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

# --- Federal income tax: Pub 15-T (2026) percentage method, automated systems ---
# Source: IRS Pub 15-T (2026), Worksheet 1A + Annual Percentage Method tables
# (reflects OBBBA / P.L. 119-21). Rows: (lower_bound, base_tax, rate, exceeds).
# "single" schedule also serves Married Filing Separately.
PAY_PERIODS = {"weekly": 52, "biweekly": 26, "semimonthly": 24, "monthly": 12}

# Worksheet 1A line 1g standard-deduction adjustment (Step 2 box UNCHECKED).
# Step 2 checked -> 0 for all.
FED_STD_ADJUST = {"single": 8600, "mfs": 8600, "mfj": 12900, "hoh": 12900}

FED_PERCENTAGE_METHOD: dict = {
    "standard": {  # Step 2 box NOT checked
        "single": [(0, 0, 0.0, 0), (7500, 0, 0.10, 7500), (19900, 1240, 0.12, 19900),
                   (57900, 5800, 0.22, 57900), (113200, 17966, 0.24, 113200),
                   (209275, 41024, 0.32, 209275), (263725, 58448, 0.35, 263725),
                   (648100, 192979.25, 0.37, 648100)],
        "mfj": [(0, 0, 0.0, 0), (19300, 0, 0.10, 19300), (44100, 2480, 0.12, 44100),
                (120100, 11600, 0.22, 120100), (230700, 35932, 0.24, 230700),
                (422850, 82048, 0.32, 422850), (531750, 116896, 0.35, 531750),
                (788000, 206583.50, 0.37, 788000)],
        "hoh": [(0, 0, 0.0, 0), (15550, 0, 0.10, 15550), (33250, 1770, 0.12, 33250),
                (83000, 7740, 0.22, 83000), (121250, 16155, 0.24, 121250),
                (217300, 39207, 0.32, 217300), (271750, 56631, 0.35, 271750),
                (656150, 191171, 0.37, 656150)],
    },
    "checkbox": {  # Form W-4 Step 2 checkbox CHECKED
        "single": [(0, 0, 0.0, 0), (8050, 0, 0.10, 8050), (14250, 620, 0.12, 14250),
                   (33250, 2900, 0.22, 33250), (60900, 8983, 0.24, 60900),
                   (108938, 20512, 0.32, 108938), (136163, 29224, 0.35, 136163),
                   (328350, 96489.63, 0.37, 328350)],
        "mfj": [(0, 0, 0.0, 0), (16100, 0, 0.10, 16100), (28500, 1240, 0.12, 28500),
                (66500, 5800, 0.22, 66500), (121800, 17966, 0.24, 121800),
                (217875, 41024, 0.32, 217875), (272325, 58448, 0.35, 272325),
                (400450, 103291.75, 0.37, 400450)],
        "hoh": [(0, 0, 0.0, 0), (12075, 0, 0.10, 12075), (20925, 885, 0.12, 20925),
                (45800, 3870, 0.22, 45800), (64925, 8077.50, 0.24, 64925),
                (112950, 19603.50, 0.32, 112950), (140175, 28315.50, 0.35, 140175),
                (332375, 95585.50, 0.37, 332375)],
    },
}

# State income tax — TODO next: NY (NYS-50-T + NYC) and NJ (NJ-WT) tables + IT-2104/NJ-W4.
NY_WITHHOLDING: dict = {}
NYC_WITHHOLDING: dict = {}
NJ_WITHHOLDING: dict = {}
