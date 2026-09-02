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

# --- Employer experience-rated taxes (COMPANY-SPECIFIC; from state rate notices) ---
# Wage-base capped -> the engine applies these against YTD-remaining wages.
# Rates marked DERIVED were reverse-engineered from the golden stub (Roger, who is
# under all NJ bases so his rates apply to full gross); confirm all vs the 2026
# NY/NJ employer rate notices before go-live.
NY_UI_WAGE_BASE = 12_800          # VERIFY 2026 NY UI base
NJ_UI_WAGE_BASE = 43_300          # VERIFY 2026 NJ UI/WF base
NJ_TDI_ER_WAGE_BASE = 45_200      # VERIFY 2026 NJ employer TDI base

COMPANY_ER_RATES = {
    "futa": 0.006,                # 0.6% on first $7,000 (federal)
    "ny_ui": 0.0405,              # NY employer UI experience rate — VERIFY (placeholder)
    "ny_rsf": 0.00075,            # NY Re-employment Service Fund 0.075%
    "nj_ui": 0.026824,            # DERIVED (Roger 82.08/3060) — VERIFY notice
    "nj_tdi": 0.0050,             # DERIVED (15.30/3060) — VERIFY
    "nj_wf": 0.001176,            # DERIVED (3.60/3060) — VERIFY
}

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

# --- New York State income tax: NYS-50-T-NYS (1/26) Method II exact calculation ---
# BIWEEKLY only (their pay frequency). net wages = period wages (after 401k) minus
# the Table A biweekly deduction+exemption allowance; then apply the schedule:
# withhold = (net - col3) * col4 + col5.  (col3 == "at least" bound.)
NY_WITHHOLDING: dict = {
    "allowance_biweekly": {  # Table A, index = # exemptions (0..10)
        "single":  [284.60, 323.10, 361.60, 400.10, 438.60, 477.10, 515.60, 554.10, 592.60, 631.10, 669.60],
        "married": [305.80, 344.30, 382.80, 421.30, 459.80, 498.30, 536.80, 575.30, 613.80, 652.30, 690.80],
    },
    "schedule_biweekly": {  # (at_least/col3, rate/col4, add/col5)
        "single": [(0, 0.0390, 0), (327, 0.0440, 12.77), (450, 0.0515, 18.15), (535, 0.0540, 22.54),
                   (3102, 0.0590, 161.15), (3723, 0.0703, 197.81), (4140, 0.0753, 227.15),
                   (6063, 0.0640, 372.04), (8285, 0.1144, 514.19), (10208, 0.0735, 734.27)],
        "married": [(0, 0.0390, 0), (327, 0.0440, 12.77), (450, 0.0515, 18.15), (535, 0.0540, 22.54),
                    (3102, 0.0590, 161.15), (3723, 0.0657, 197.81), (4140, 0.0707, 225.19),
                    (6063, 0.0801, 361.08), (8137, 0.0640, 527.23), (12431, 0.1349, 802.08),
                    (14354, 0.0735, 1061.54), (41444, 0.0765, 3052.65)],
    },
}

# --- NYC resident income tax: NYS-50-T-NYC (1/26) Method II (biweekly) ---
# Low brackets are identical for single/married (only NYC residents withhold this).
_NYC_SCHED = [(0, 0.0205, 0), (308, 0.0280, 6.31), (334, 0.0325, 7.08),
              (577, 0.0395, 14.92), (962, 0.0415, 30.12), (2308, 0.0425, 86.00)]
NYC_WITHHOLDING: dict = {
    "allowance_biweekly": {
        "single":  [192.30, 230.80, 269.30, 307.80, 346.30, 384.80, 423.30, 461.80, 500.30, 538.80, 577.30],
        "married": [211.50, 250.00, 288.50, 327.00, 365.50, 404.00, 442.50, 481.00, 519.50, 558.00, 596.50],
    },
    "schedule_biweekly": {"single": _NYC_SCHED, "married": _NYC_SCHED},
}

# --- New Jersey income tax: NJ-WT percentage method, Rate Table A, BIWEEKLY ---
# taxable = period wages (after 401k, which NJ excludes) minus $38.40 per allowance.
# withhold = (taxable - of_excess_over) * rate + base_add.  Rate-table selection
# (A-E) comes from the NJ-W4 wage chart; default A. VERIFY table per employee.
NJ_WITHHOLDING: dict = {
    "allowance_biweekly": 38.40,
    # Rows: (over/of_excess_over, rate, base_add). Tables A-E from the NJ-W4 wage chart.
    "tables_biweekly": {
        "A": [(0, 0.015, 0.0), (769, 0.020, 12.00), (1346, 0.039, 23.00), (1538, 0.061, 31.00),
              (2885, 0.070, 113.00), (19231, 0.099, 1257.00), (38462, 0.118, 3161.00)],
        "B": [(0, 0.015, 0.0), (769, 0.020, 12.00), (1923, 0.027, 35.00), (2692, 0.039, 55.00),
              (3077, 0.061, 70.00), (5769, 0.070, 235.00), (19231, 0.099, 1177.00), (38462, 0.118, 3081.00)],
        "C": [(0, 0.015, 0.0), (769, 0.023, 11.54), (1538, 0.028, 29.23), (1923, 0.035, 40.00),
              (2308, 0.056, 53.46), (5769, 0.066, 247.31), (19231, 0.099, 1135.77), (38462, 0.118, 3039.62)],
        "D": [(0, 0.015, 0.0), (769, 0.027, 11.54), (1538, 0.034, 32.31), (1923, 0.043, 45.38),
              (2308, 0.056, 61.92), (5769, 0.065, 255.77), (19231, 0.099, 1130.77), (38462, 0.118, 3034.62)],
        "E": [(0, 0.015, 0.0), (769, 0.020, 12.00), (1346, 0.058, 23.00), (3846, 0.065, 168.00),
              (19231, 0.099, 1168.00), (38462, 0.118, 3072.00)],
    },
}
