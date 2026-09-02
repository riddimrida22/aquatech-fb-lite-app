# AqtPM In-House Payroll (Option A — DIY, self-file)

Replaces Paychex. The app computes gross→net + every tax line; the owner
self-files/remits (EFTPS, NY, NJ) and pushes ACH direct deposits himself.
Goal: eliminate Paychex fees (~$1,800/yr, rising) + FreshBooks (~$1,400–2,000/yr).

## Scope
- **6 W-2 staff** (Courtney Byrne removed 2026-09): Bertrand, Zachary Gilliam,
  Stacey Hodge (NYC), Robert Svadlenka, **Roger Wang (NJ)**, Ailsa Welch Gilliam.
- Jurisdictions: **Federal + NY + NYC + NJ**. S-corp owner W-2 (Bertrand),
  per-person 401k (Bertrand defers 80%), $0 health for 2026.

## What's built (Phase 1)
- `payroll/engine.py` — pure, penny-critical calc. Per-employee per-tax cent
  rounding, then summed. 401k does **not** reduce FICA wages.
- `payroll/tables_2026.py` — versioned rates (data, not code).
- `payroll/models.py` — employees (tax profile + encrypted PII), runs, lines,
  YTD ledger, versioned tax tables. *(not yet registered with create_all)*
- `payroll/golden/run_2026-08-21.json` — real Paychex journal as the truth source.
- `payroll/check_golden.py` — line-by-line validator.

## Validation status
`python -m app.payroll.check_golden` → **32 PASS / 1 FAIL** against the real
2026-08-21 Paychex run (6 employees, $12,506.80 gross). All rate-based taxes tie
to the penny: Social Security, Medicare (5/6), NY SDI, NY PFL, NJ TDI/UI/WF, plus
company subtotals, gross, and 401k.

The 1 diff (Bertrand Medicare 5.75 vs 5.76) revealed that **Paychex uses
YTD-cumulative rounding** (tax on YTD wages − tax already withheld), not
per-period rounding. Matching that + all wage-base-capped taxes needs the YTD
ledger (next).

## Method facts (reverse-engineered from the stub — verify vs official 2026)
- SS 6.2% (base $181,200 VERIFY), Medicare 1.45%, FUTA 0.6%/$7,000.
- NY SDI $0.60/wk; NY PFL 0.432%.
- NJ EE: TDI 0.42%, UI 0.3825%, WF 0.0425%.
- Employer UI/SDI (NY + NJ) are **experience-rated per employer** → company
  config from the annual state rate notice; not national constants.

## Next steps
1. **Seed the YTD ledger** from the cumulative Paychex report → exact FICA
   (cumulative rounding) + capped taxes (FUTA, NY/NJ UI, SS cap).
2. **Income-tax tables + W-4 onboarding** — Pub 15-T (fed), NYS-50-T (NY), NYC,
   NJ-WT; collect each employee's W-4 / IT-2104 / NJ-W4 → fed/ny/nyc/nj + net.
3. **Company employer rates** from NY/NJ rate notices → employer UI/SDI lines.
4. Run workflow + pay stubs + `finance` journals; then ACH; then parallel-run
   vs Paychex to the penny; then cut over.

See memory `aquatechpm_payroll_app` for the full decision log and baseline.
