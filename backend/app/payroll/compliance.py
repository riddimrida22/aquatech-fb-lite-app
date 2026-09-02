"""Payroll compliance calendar — every federal / NY / NYC / NJ / 401k deadline,
expanded into concrete dated obligations with advance reminders, and exportable
as an .ics calendar you can subscribe to (Google/Outlook fire the reminders).

HONEST SCOPE: this computes and reminds based on ENCODED rules. It is decision
support, not a legal guarantee. Verify the config flags below (esp. federal
depositor status) and have a CPA review. While AqtPM is still on Paychex, Paychex
handles these — this goes live at cutover.

Rules encoded for a small NY-based S-corp with a NJ employee (2026). VERIFY tags
mark rules/thresholds to confirm against official agency instructions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

# ---------------------------------------------------------------- config
# CONFIRM these before going live — they change the deadlines.
FED_DEPOSIT_SCHEDULE = "semiweekly"   # "semiweekly" | "monthly". Default to the
#   STRICTER semiweekly (early is always compliant; late = penalty). Determined
#   by the lookback-period 941 taxes: >$50k -> semiweekly. VERIFY from IRS notice.
NJ_WH_DEPOSIT = "monthly"             # Roger ~$3k/yr NJ WH -> monthly (by 15th). VERIFY
NY_NYS1_THRESHOLD = 700.0             # NY: remit (NYS-1) within 5 business days once
#   cumulative withholding since last remittance reaches $700. VERIFY 3 vs 5 days.
K401_DEPOSIT_BIZ_DAYS = 2             # 401k deferrals are EMPLOYEE money held in
#   trust -> deposit PROMPTLY (fiduciary duty). Do NOT stretch to the 7-day DOL
#   safe-harbor limit to hold float; just-in-time applies to *your* taxes, not this.

# CASH MANAGEMENT (just-in-time): all *tax* deposits below are dated on the LATEST
# legal due date. On payday, SCHEDULE the payment in EFTPS / the state portal with
# an execution date = the due date -> cash stays in your account until then and you
# never risk being late. Never pay early; never late. Biggest float lever = federal
# DEPOSITOR STATUS: monthly (pay by the 15th of the following month, holds ~2-6 wks)
# vs semiweekly (a few days). Confirm from the IRS notice; set FED_DEPOSIT_SCHEDULE.
MCTMT_APPLIES = False                 # NY MCTMT employer tax applies only if MCTD
#   quarterly payroll > $312,500. AqtPM ~ $81k/qtr -> EXEMPT. Re-check if headcount grows.
HAS_NJ = True                         # Roger Wang
FILES_1099 = False                    # all W-2 currently; set True if any contractor
PLAN_5500_REQUIRED = True             # 401k plan -> Form 5500-EZ/SF (VERIFY which; assets/participants)
K401_MATCH_SCHEDULE = "monthly"       # EMPLOYER match funding cadence: "per_payroll"|"monthly"|
#   "quarterly". Company money -> flexible. Limits: (1) plan document's stated timing GOVERNS;
#   (2) safe-harbor match not funded per-payroll must be in by end of the FOLLOWING quarter;
#   (3) deduct only if funded by the 1120-S deadline + extension. Recordkeeper: Human Interest.

# Biweekly pay schedule anchor: a known real check date; paydays every 14 days.
PAY_ANCHOR = date(2026, 8, 21)        # Friday, from the golden-stub run
PAY_INTERVAL_DAYS = 14

REMINDER_LEAD_DAYS = 2                # calendar alarm fires this many days before

# US federal holidays 2026-2027 (deposits/filings roll to next business day).
_HOLIDAYS = {
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 5, 25),
    date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7), date(2026, 10, 12),
    date(2026, 11, 11), date(2026, 11, 26), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 5, 31),
    date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6), date(2027, 10, 11),
    date(2027, 11, 11), date(2027, 11, 25), date(2027, 12, 24), date(2027, 12, 31),
}


def _is_biz(d: date) -> bool:
    return d.weekday() < 5 and d not in _HOLIDAYS


def next_biz(d: date) -> date:
    while not _is_biz(d):
        d += timedelta(days=1)
    return d


def add_biz_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if _is_biz(d):
            n -= 1
    return d


@dataclass
class Obligation:
    due: date
    title: str
    jurisdiction: str          # Federal | NY | NYC | NJ | 401k | Corp | Insurance
    category: str              # deposit | filing | payroll | renewal
    detail: str
    reminder_days: int = REMINDER_LEAD_DAYS


def paydays(start: date, end: date) -> list[date]:
    """Biweekly paydays within [start, end]."""
    days, d = [], PAY_ANCHOR
    while d > start:
        d -= timedelta(days=PAY_INTERVAL_DAYS)
    while d <= end:
        if d >= start:
            days.append(d)
        d += timedelta(days=PAY_INTERVAL_DAYS)
    return days


def _semiweekly_fed_due(payday: date) -> date:
    # Wed/Thu/Fri payday -> deposit by next Wednesday; Sat-Tue -> by next Friday.
    wd = payday.weekday()  # Mon=0..Sun=6
    if wd in (2, 3, 4):    # Wed/Thu/Fri
        target = 2         # Wednesday
    else:                  # Sat/Sun/Mon/Tue
        target = 4         # Friday
    d = payday + timedelta(days=1)
    while d.weekday() != target:
        d += timedelta(days=1)
    return next_biz(d)


def _quarter_ends(year: int):
    return [date(year, 3, 31), date(year, 6, 30), date(year, 9, 30), date(year, 12, 31)]


def generate(start: date, end: date) -> list[Obligation]:
    obs: list[Obligation] = []

    # ---- per-payday obligations ----
    for pd in paydays(start, end):
        obs.append(Obligation(pd, "Run payroll (biweekly)", "Federal", "payroll",
                              "Compute & approve run; push ACH direct deposits."))
        if FED_DEPOSIT_SCHEDULE == "semiweekly":
            obs.append(Obligation(_semiweekly_fed_due(pd),
                                  "Federal 941 tax deposit (EFTPS)", "Federal", "deposit",
                                  "Deposit withheld fed income tax + both halves FICA via EFTPS "
                                  "(semiweekly: Wed/Thu/Fri payday -> next Wed; else next Fri). "
                                  "SCHEDULE in EFTPS on payday to execute on THIS date - hold cash "
                                  "until due, never early, never late."))
        obs.append(Obligation(add_biz_days(pd, 5),
                              "NY withholding remittance (NYS-1)", "NY", "deposit",
                              f"Remit NY (incl. NYC resident) withholding via NYS-1 within 5 business "
                              f"days once cumulative >= ${NY_NYS1_THRESHOLD:.0f}. VERIFY 3 vs 5 days."))
        obs.append(Obligation(add_biz_days(pd, K401_DEPOSIT_BIZ_DAYS),
                              "401(k) employee deferral deposit", "401k", "deposit",
                              "Send EMPLOYEE deferrals to the recordkeeper (Human Interest) PROMPTLY "
                              "- employee money held in trust; do NOT stretch for float."))
        if K401_MATCH_SCHEDULE == "per_payroll":
            obs.append(Obligation(add_biz_days(pd, K401_DEPOSIT_BIZ_DAYS),
                                  "401(k) EMPLOYER match funding (per payroll)", "401k", "deposit",
                                  "Fund the employer match with this run (company money)."))

    # ---- monthly ----
    y = start.year
    while y <= end.year:
        for m in range(1, 13):
            due = next_biz(date(y, m, 15))
            if start <= due <= end:
                if FED_DEPOSIT_SCHEDULE == "monthly":
                    obs.append(Obligation(due, "Federal 941 tax deposit (monthly, EFTPS)",
                                          "Federal", "deposit",
                                          "Monthly depositor: deposit prior month's 941 taxes by the 15th."))
                if HAS_NJ and NJ_WH_DEPOSIT == "monthly":
                    obs.append(Obligation(due, "NJ withholding deposit (NJ-500)", "NJ", "deposit",
                                          "Remit prior month's NJ gross income tax withheld (monthly filer)."))
                if K401_MATCH_SCHEDULE == "monthly":
                    obs.append(Obligation(due, "401(k) EMPLOYER match funding (monthly)", "401k", "deposit",
                                          "Fund the employer match for the prior month (company money - flexible). "
                                          "Plan document governs timing; safe-harbor match: by end of following "
                                          "quarter; deductible if funded by the 1120-S deadline + extension."))
        y += 1

    # ---- quarterly ----
    def _in(d: date) -> bool:
        return start <= d <= end

    for yr in range(start.year, end.year + 1):
        for qend in _quarter_ends(yr):
            q = (qend.month - 1) // 3 + 1
            # Federal 941 + NY NYS-45: last day of month after quarter end.
            due_end_next = next_biz(_last_of_next_month(qend))
            if _in(due_end_next):
                obs.append(Obligation(due_end_next, f"Form 941 (Q{q}) - federal quarterly return",
                                      "Federal", "filing", "Employer's quarterly federal tax return."))
                obs.append(Obligation(due_end_next, f"NYS-45 (Q{q}) - NY WH/UI/wage report",
                                      "NY", "filing", "NY combined withholding + UI + wage reporting."))
                if MCTMT_APPLIES:
                    obs.append(Obligation(due_end_next, f"MCTMT (Q{q})", "NY", "filing",
                                          "Metropolitan Commuter Transportation Mobility Tax (employer)."))
                obs.append(Obligation(due_end_next, f"FUTA deposit check (Q{q})", "Federal", "deposit",
                                      "Deposit FUTA (Form 940 tax) if accumulated liability > $500 this quarter."))
            if HAS_NJ:
                nj_due = next_biz(_nth_of_next_month(qend, 30))
                if _in(nj_due):
                    obs.append(Obligation(nj_due, f"NJ-927 + WR-30 (Q{q}) - NJ quarterly", "NJ", "filing",
                                          "NJ employer's quarterly return (WH + UI/DI) and wage report (30th)."))
            if K401_MATCH_SCHEDULE == "quarterly":
                # safe-harbor match: fund by end of the FOLLOWING quarter
                match_due = next_biz(_last_of_next_month(_quarter_ends(qend.year + (q == 4))[q % 4]))
                if _in(match_due):
                    obs.append(Obligation(match_due, f"401(k) EMPLOYER match funding (Q{q})", "401k", "deposit",
                                          "Fund the employer match for the quarter (company money; safe-harbor "
                                          "match must be in by end of the following quarter)."))

    # ---- annual ----
    for yr in range(start.year, end.year + 1):
        jan31 = next_biz(date(yr, 1, 31))
        if start <= jan31 <= end:
            obs.append(Obligation(jan31, "W-2 to employees + W-2/W-3 to SSA", "Federal", "filing",
                                  "Furnish W-2s to employees and file W-2/W-3 with SSA (BSO EFW2)."))
            obs.append(Obligation(jan31, "Form 940 (FUTA) annual return", "Federal", "filing",
                                  "Employer's annual federal unemployment (FUTA) tax return."))
            obs.append(Obligation(jan31, "Form 941 (Q4) + NYS-45 (Q4)", "Federal", "filing",
                                  "Q4 federal + NY quarterly returns (also due end of January)."))
            if FILES_1099:
                obs.append(Obligation(jan31, "1099-NEC to contractors + IRS", "Federal", "filing",
                                      "File 1099-NEC for any non-employee compensation."))
        feb15 = next_biz(date(yr, 2, 15))
        if start <= feb15 <= end and HAS_NJ:
            obs.append(Obligation(feb15, "NJ-W-3 annual reconciliation + W-2s", "NJ", "filing",
                                  "NJ annual withholding reconciliation."))
        mar15 = next_biz(date(yr, 3, 15))
        if start <= mar15 <= end:
            obs.append(Obligation(mar15, "Form 1120-S (S-corp return)", "Corp", "filing",
                                  "S-corporation income tax return (or extend with 7004)."))
        if PLAN_5500_REQUIRED:
            jul31 = next_biz(date(yr, 7, 31))
            if start <= jul31 <= end:
                obs.append(Obligation(jul31, "Form 5500-EZ/5500-SF (401k plan)", "401k", "filing",
                                      "Annual retirement-plan return (calendar plan year). VERIFY which form."))

    return sorted(obs, key=lambda o: (o.due, o.jurisdiction, o.title))


def _last_of_next_month(qend: date) -> date:
    # last day of the month AFTER the quarter-end month (941/NYS-45 due date)
    m = qend.month + 1
    y = qend.year + (m > 12)
    m = (m - 1) % 12 + 1
    nm = m + 1
    ny = y + (nm > 12)
    nm = (nm - 1) % 12 + 1
    return date(ny, nm, 1) - timedelta(days=1)


def _nth_of_next_month(qend: date, day: int) -> date:
    m = qend.month + 1
    y = qend.year + (m > 12)
    m = (m - 1) % 12 + 1
    return date(y, m, day)


# ---------------------------------------------------------------- ICS export
def to_ics(obs: list[Obligation], calname: str = "AqtPM Payroll Compliance") -> str:
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AqtPM//Payroll Compliance//EN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH", f"X-WR-CALNAME:{esc(calname)}"]
    for i, o in enumerate(obs):
        d = o.due.strftime("%Y%m%d")
        dtend = (o.due + timedelta(days=1)).strftime("%Y%m%d")
        uid = f"aqtpm-payroll-{o.due.isoformat()}-{i}@aquatechpc.com"
        lines += [
            "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:20260902T000000Z",
            f"DTSTART;VALUE=DATE:{d}", f"DTEND;VALUE=DATE:{dtend}",
            f"SUMMARY:[{esc(o.jurisdiction)}] {esc(o.title)}",
            f"DESCRIPTION:{esc(o.detail)} (category: {o.category})",
            "BEGIN:VALARM", "ACTION:DISPLAY", f"TRIGGER:-P{o.reminder_days}D",
            f"DESCRIPTION:{esc(o.title)} due {o.due.isoformat()}", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


if __name__ == "__main__":
    import sys
    start = date(2026, 9, 1)
    end = date(2027, 12, 31)
    obs = generate(start, end)
    out = sys.argv[1] if len(sys.argv) > 1 else "AqtPM_Payroll_Compliance.ics"
    with open(out, "w", encoding="utf-8") as f:
        f.write(to_ics(obs))
    print(f"{len(obs)} obligations {start} -> {end}  ->  {out}")
    for o in obs[:40]:
        print(f"  {o.due}  [{o.jurisdiction:8}] {o.title}")
