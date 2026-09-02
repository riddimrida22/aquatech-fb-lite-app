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

## Cash management — pay just-in-time (keep your money until it's due)

The calendar dates every **tax** deposit on the **latest legal due date** — never
early. To hold the cash while never risking a late penalty:

- **Schedule ahead, execute on the due date.** On payday, log into **EFTPS** (and
  the NY/NJ portals) and schedule the deposit with an **execution date = the due
  date**. The money leaves your account that day, not before. EFTPS lets you queue
  payments up to a year out.
- **Biggest lever = federal depositor status.** A **monthly** depositor pays by the
  **15th of the following month** (holds the cash ~2–6 weeks); a **semiweekly**
  depositor pays within days of payday. Confirm yours on the IRS deposit-schedule
  notice (mailed each November) and set `FED_DEPOSIT_SCHEDULE`. The calendar
  currently defaults to **semiweekly** (always-safe); switching to monthly, if
  you qualify, is the single biggest float gain.
- **NY (NYS-1)** — remit on the last allowed business day (3–5 days after hitting
  $700 cumulative). **NJ (NJ-500)** — the 15th. Both dated at the latest legal day.
- **401(k): split the two halves.**
  - **Employee deferrals** (withheld from pay) are held in trust → deposit
    **promptly** (~2 business days), never stretched for float.
  - **Employer match** is *company money* → fund it **monthly** (calendar dates it
    on the 15th) — or quarterly/annually. Limits: your **plan document** governs
    the timing; a **safe-harbor** match not funded per-payroll must be in by the
    **end of the following quarter**; and it's only **deductible** if funded by the
    **1120-S deadline + extension**. Recordkeeper: **Human Interest** (confirm the
    plan doc's stated cadence). Config: `K401_MATCH_SCHEDULE`.
- Withheld income/FICA taxes are trust funds too, but the law lets you hold them
  until the deposit due date, so scheduling to the due date is fine.

Never late: a single late federal deposit penalty (2–15%) dwarfs the interest you'd
earn holding the cash, so the reminders fire 2 days ahead and you pre-schedule.

## Using the calendar

1. Import/subscribe to `AqtPM_Payroll_Compliance.ics` in Google Calendar or Outlook
   (each event has a 2-day-ahead reminder).
2. Regenerate after cutover with confirmed config:
   `python -m app.payroll.compliance <out.ics>` (from `backend/`).
3. Later phase: surface the same obligations as an in-app dashboard tile with
   done/pending/overdue status, backed by a `payroll_obligations` table.
