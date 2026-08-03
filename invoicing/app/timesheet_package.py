"""
Shared weekly-timesheet backup builder — the exact logic the HDR packager uses,
extracted so Stantec/JobCon packages produce identical timesheet backups without
duplicating (or destabilising) the validated HDR path.

Include a week for an employee ONLY if they logged BILLED-project hours on an in-period
day that week; the timesheet shows EVERY project worked that week, with only the billed
project's line outlined. Prefers the employee's real timekeeping workbook, falling back
to reconstruction if the workbook/week is missing.
"""
from __future__ import annotations
import os, datetime as dt
import config
from timesheet_xlsx import build_timesheet_xlsx, DayEntry


def _sunday(d: dt.date) -> dt.date:
    return d + dt.timedelta(days=6 - d.weekday())


def sundays_covering(begin: dt.date, end: dt.date) -> list[dt.date]:
    s = _sunday(begin)
    out = []
    while s - dt.timedelta(days=6) <= end:
        out.append(s)
        s += dt.timedelta(days=7)
    return out


def emp_sort_key(n: str):
    """Staff first (config order), principal last — matches the invoice detail order."""
    is_prin = 1 if n in config.PRINCIPALS else 0
    idx = config.STAFF_ORDER.index(n) if n in config.STAFF_ORDER else len(config.STAFF_ORDER)
    return (is_prin, idx, n)


def build_weekly_timesheets(outdir: str, invoice_hours: dict, data: dict,
                            begin: dt.date, end: dt.date, *, make_pdfs: bool):
    """Returns (ts_files, pdf_jobs). pdf_jobs = list of (xlsx, pdf, sheets|None) for a
    single batched Excel export by the caller."""
    import timesheet_from_workbook as tfw
    billed_project = data["project_name"]
    all_weeks = sundays_covering(begin, end)
    sup_sig = config.SUPERVISOR_SIG if os.path.exists(config.SUPERVISOR_SIG) else None
    ts_files, pdf_jobs = [], []

    for full in sorted(invoice_hours, key=emp_sort_key):
        first = full.split()[0]
        last = " ".join(full.split()[1:])
        emp_rows = data["timesheet"].get(full, [])
        wk_i = 0
        for sunday in all_weeks:
            mon = sunday - dt.timedelta(days=6)
            has_billed = any(r["project"] == billed_project and mon <= r["date"] <= sunday
                             and begin <= r["date"] <= end and r["hours"] for r in emp_rows)
            if not has_billed:
                continue
            wk_i += 1
            wk_entries = [DayEntry(r["project"], r["date"], r["hours"], r["note"])
                          for r in emp_rows if mon <= r["date"] <= sunday]
            ts_xlsx = os.path.join(outdir, f"Week {wk_i} {first} {last} TIMESHEET.xlsx")
            project_hours: dict = {}
            for r in emp_rows:
                if mon <= r["date"] <= sunday and r["hours"]:
                    project_hours.setdefault(r["project"], {})
                    project_hours[r["project"]][r["date"]] = (
                        project_hours[r["project"]].get(r["date"], 0) + r["hours"])
            wb_res = tfw.build_from_workbook(full, sunday, ts_xlsx,
                                             emp_signature=config.employee_signature(full),
                                             sup_signature=sup_sig, project_hours=project_hours)
            if wb_res is None:
                build_timesheet_xlsx(ts_xlsx, employee_first=first, employee_last=last,
                                     week_ending=sunday, entries=wk_entries,
                                     billed_project=billed_project,
                                     emp_signature=config.employee_signature(full),
                                     sup_signature=sup_sig)
            entry = {"employee": full, "week": wk_i, "week_ending": sunday.isoformat(),
                     "xlsx": ts_xlsx, "source": "workbook" if wb_res else "reconstructed"}
            if make_pdfs:
                ts_pdf = ts_xlsx[:-5] + ".pdf"
                pdf_jobs.append((ts_xlsx, ts_pdf, None))
                entry["pdf"] = ts_pdf
            ts_files.append(entry)
    return ts_files, pdf_jobs
