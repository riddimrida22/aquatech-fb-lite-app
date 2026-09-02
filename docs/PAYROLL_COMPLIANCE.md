# AqtPM Payroll Compliance Calendar

Every recurring payroll obligation for a NY-based S-corp with a NJ employee.
Generated concretely (with advance reminders) by `backend/app/payroll/compliance.py`
→ `AqtPM_Payroll_Compliance.ics` (subscribe in Google/Outlook; alarms fire 2 days
ahead). **182 dated obligations Sep 2026 → early 2028.**

> **Honest scope.** This encodes the rules and reminds you — it is decision
> support, **not a legal guarantee**. Deadlines depend on the config flags below
> (esp. federal depositor status) and rules change yearly. **While AqtPM is still
> on Paychex, Paychex handles all of this** — the calendar goes live at cutover.
> Have a CPA review before self-filing.

## Obligation matrix

| Obligation | Freq | Deadline rule | Jurisdiction | How |
|---|---|---|---|---|
| **Run payroll** | Biweekly | Each check date | — | AqtPM engine → ACH |
| **Federal 941 deposit** | Per payday (semiweekly)* | Wed/Thu/Fri payday → next Wed; Sat–Tue → next Fri | Federal | EFTPS |
| **NY withholding (NYS-1)** | Per payday | Within 5 biz days once cumulative ≥ $700* | NY (+NYC) | NY Online Services |
| **NJ withholding (NJ-500)** | Monthly* | By the 15th | NJ | NJ portal |
| **401(k) deferral deposit** | Per payday | Within 7 biz days (DOL safe harbor) | 401k | Recordkeeper |
| **Form 941** | Quarterly | Last day of month after quarter end | Federal | IRS |
| **NYS-45** (WH+UI+wages) | Quarterly | Same | NY | NY Online Services |
| **NJ-927 + WR-30** | Quarterly | 30th of month after quarter | NJ | NJ portal |
| **FUTA deposit** | Quarterly | End of next month if accrued > $500 | Federal | EFTPS |
| **Form 940** (FUTA return) | Annual | Jan 31 | Federal | IRS |
| **W-2 to employees + W-2/W-3 to SSA** | Annual | Jan 31 | Federal | SSA BSO (EFW2) |
| **1099-NEC** (if any contractor) | Annual | Jan 31 | Federal | IRS |
| **NJ-W-3** reconciliation | Annual | Feb 15 | NJ | NJ portal |
| **Form 1120-S** (S-corp) | Annual | Mar 15 (or extend) | Corp | IRS |
| **Form 5500-EZ/SF** (401k) | Annual | Jul 31* | 401k | DOL/IRS |

\* = **confirm** (see below). NYC resident tax is withheld/remitted **through** NY
(NYS-1 / NYS-45) — no separate NYC employer filing.

## Confirm before go-live (these change the deadlines / close gaps)

1. **Federal depositor status** — monthly vs **semiweekly** (from lookback-period
   941 taxes; >$50k → semiweekly). Calendar defaults to semiweekly (stricter =
   always safe). Confirm from the IRS notice. *(config: `FED_DEPOSIT_SCHEDULE`)*
2. **NY NYS-1 timing** — 3 vs 5 business days (depends on prior-year size /
   PrompTax enrollment). *(config: `NY_NYS1_THRESHOLD` + timing)*
3. **NJ withholding deposit frequency** — monthly vs weekly (weekly if prior-year
   NJ WH ≥ $10k; Roger ~$3k → monthly). *(config: `NJ_WH_DEPOSIT`)*
4. **Form 5500** — which variant (EZ vs SF) and whether required this year.
5. **MCTMT** — employer tax applies only if MCTD quarterly payroll > $312,500;
   AqtPM ~$81k/qtr → **exempt** now. Re-check if headcount grows. *(config: `MCTMT_APPLIES`)*

## Compliance gaps a calendar alone won't catch (verify these exist)

- **State registrations** — NY & NJ withholding + UI accounts (have them via Paychex).
- **Insurance** — NY **Workers' Comp** + **DBL** (disability) + **PFL** carrier;
  NJ Workers' Comp. Annual policies; deductions run through payroll.
- **New-hire reporting** — NY & NJ, within 20 days of hire (event-based, not on
  the fixed calendar).
- **EFTPS + state e-file enrollment** — enroll the company before first self-deposit.
- **W-4 / IT-2104 / NJ-W4 on file** for every employee.

## Using the calendar

1. Import/subscribe to `AqtPM_Payroll_Compliance.ics` in Google Calendar or Outlook
   (each event has a 2-day-ahead reminder).
2. Regenerate after cutover with confirmed config:
   `python -m app.payroll.compliance <out.ics>` (from `backend/`).
3. Later phase: surface the same obligations as an in-app dashboard tile with
   done/pending/overdue status, backed by a `payroll_obligations` table.
