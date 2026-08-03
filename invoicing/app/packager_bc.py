"""
Package builder for the month-billed Brown & Caldwell family (Stantec JV + JobCon).
Mirrors the HDR packager's flow but keyed on a calendar month and each format's own
per-sub-task prior ledger. Reuses the shared timesheet backup + PDF-export + combine
helpers, so the timesheet packages are identical to HDR's.

  1. resolve month -> [first, last]
  2. pull live hours grouped by sub-task (+ full-week timesheet)
  3. detect the single active sub-task (fail loud on multi-sub-task months)
  4. ledger -> next invoice number + per-sub-task prior history
  5. fill the format's template  (stantec_invoice / jobcon_invoice)
  6. weekly timesheet backups -> combined per-employee PDF + tabbed xlsx
  7. save into the client folder; append the ledger  (only when save_to_real)
"""
from __future__ import annotations
import calendar, os, re, sys, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config, ledger as ledger_mod
import data_source
from hdr_invoice_generator import compute_labor, PriorInvoice, r2
from timesheet_xlsx import ExcelSession
import timesheet_package as tsp

TEST_OUT = os.path.join(config.ROOT, "_test_output")
_STANTEC_SUB_RE = re.compile(r"Sub\s*Task\s*(\d+\.\d+)", re.I)
_JOBCON_SUB_RE = re.compile(r"^(\d+(?:\.\d+)+)")


def _month_range(year: int, month: int) -> tuple[dt.date, dt.date]:
    last = calendar.monthrange(year, month)[1]
    return dt.date(year, month, 1), dt.date(year, month, last)


def _monday(d): return d - dt.timedelta(days=d.weekday())
def _sunday(d): return d + dt.timedelta(days=6 - d.weekday())


def _active_subtask(by_subtask: dict, fmt: str) -> tuple[str, str, dict]:
    """Return (code, raw_task_name, {emp: hours}) for the single sub-task with hours.
    Fail loud if 0 or >1 sub-tasks are active (multi-sub-task months need the split
    handled explicitly rather than silently mis-attributed)."""
    active = {k: v for k, v in by_subtask.items() if any(v.values())}
    if not active:
        raise ValueError("no billable hours for this project/month")
    if len(active) > 1:
        raise ValueError(f"{len(active)} sub-tasks have hours this month "
                         f"({list(active)}). The B&C templates bill one labor block per "
                         f"invoice; split across sub-tasks needs explicit handling.")
    name, hours = next(iter(active.items()))
    rx = _STANTEC_SUB_RE if fmt == "stantec" else _JOBCON_SUB_RE
    m = rx.search(name)
    if not m:
        raise ValueError(f"could not parse a sub-task code from task name {name!r}")
    return m.group(1), name, hours


def _combine_subtasks(by_subtask: dict, fmt: str, prefer_code: str | None = None) -> tuple[str, str, dict]:
    """Merge ALL active sub-tasks into one labor block {emp: total_hours}, for months
    where the client wants a single combined invoice. The invoice's task heading is the
    `prefer_code` sub-task (continuity with prior invoices) if present, else the one with
    the most hours."""
    active = {k: v for k, v in by_subtask.items() if any(v.values())}
    if not active:
        raise ValueError("no billable hours for this project/month")
    merged: dict = {}
    for hrs in active.values():
        for emp, h in hrs.items():
            merged[emp] = round(merged.get(emp, 0.0) + h, 2)
    rx = _STANTEC_SUB_RE if fmt == "stantec" else _JOBCON_SUB_RE
    chosen = None
    if prefer_code:
        for name in active:
            mm = rx.search(name)
            if mm and mm.group(1) == prefer_code:
                chosen = name
                break
    if not chosen:
        chosen = max(active, key=lambda n: sum(active[n].values()))
    m = rx.search(chosen)
    if not m:
        raise ValueError(f"could not parse a sub-task code from task name {chosen!r}")
    return m.group(1), chosen, merged


def _stantec_priors(led: dict, upto: dt.date):
    def mk(rows):
        return [PriorInvoice(dt.date.fromisoformat(d), float(a)) for d, a in rows
                if dt.date.fromisoformat(d) < upto]
    seed = led["seed"]
    p31 = list(seed.get("prior_31", []))
    p32 = list(seed.get("prior_32", []))
    for e in led.get("entries", []):
        (p31 if e["subtask"] == "3.1" else p32).append([e["month"] + "-01", e["labor"]])
    return mk(p31), mk(p32)


def _jobcon_priors(led: dict, subtask_code: str, upto: dt.date):
    seed = led["seed"]
    rows = list(seed.get("prior_by_subtask", {}).get(subtask_code, []))
    for e in led.get("entries", []):
        if e["subtask"] == subtask_code:
            rows.append([e["month"] + "-01", e["labor"]])
    return [(dt.date.fromisoformat(d), float(a)) for d, a in rows
            if dt.date.fromisoformat(d) < upto]


def list_months(project_key: str, n: int = 12) -> list[dict]:
    """Recent months (newest first) with whether each is already invoiced (ledger)."""
    cfg = config.PROJECTS[project_key]
    led = ledger_mod.load(cfg["ledger"])
    entry_no = {e["month"]: e["invoice_no"] for e in led.entries}
    through = led.data["seed"].get("through_month")
    today = dt.date.today()
    y, mo = today.year, today.month
    out = []
    for _ in range(n):
        key = f"{y:04d}-{mo:02d}"
        done = key in entry_no or (through is not None and key <= through)
        out.append({"id": key, "label": dt.date(y, mo, 1).strftime("%B %Y"),
                    "invoiced": bool(done), "invoice_no": entry_no.get(key)})
        mo -= 1
        if mo == 0:
            mo = 12; y -= 1
    return out


def preview(project_key: str, year: int, month: int, combine: bool = False) -> dict:
    """Live pull + numbers for a month, no files written. Same shape as packager.preview
    so the UI can render either format."""
    cfg = config.PROJECTS[project_key]
    fmt = cfg["format"]
    begin, end = _month_range(year, month)
    month_key = f"{year:04d}-{month:02d}"
    sub = data_source.pull_subtasks(cfg["aqtpm_project_id"], begin, end)
    led = ledger_mod.load(cfg["ledger"])
    existing = next((e for e in led.entries if e.get("month") == month_key), None)
    base = {"project": project_key, "period": [begin.isoformat(), end.isoformat()],
            "already_invoiced": bool(existing),
            "invoice_no": existing["invoice_no"] if existing else led.next_invoice_no(),
            "prior_odc_cumulative": 0.0}
    try:
        if combine:
            code, task_name, hours = _combine_subtasks(sub["by_subtask"], fmt, cfg.get("default_subtask_code"))
        else:
            code, task_name, hours = _active_subtask(sub["by_subtask"], fmt)
    except ValueError as e:
        return {**base, "invoice_hours": {}, "staff_direct_labor": 0.0,
                "principal_direct_labor": 0.0, "this_labor": 0.0,
                "prior_labor_cumulative": 0.0, "timesheet_count": 0, "note": str(e)}
    invoice_hours = {k: v for k, v in hours.items() if v}
    rates = {n: config.resolve_direct_rate(n, sub["bill_rates"].get(n)) for n in invoice_hours}
    calc = compute_labor(invoice_hours, rates, config.PRINCIPALS)
    if fmt == "stantec":
        p31, p32 = _stantec_priors(led.data, begin)
        prior = r2(sum(p.labor_amount for p in p31) + sum(p.labor_amount for p in p32))
    else:
        prior = r2(sum(a for _d, a in _jobcon_priors(led.data, code, begin)))
    # accurate weekly-timesheet count (weeks with billed hours) via the full-week pull
    data = data_source.pull(cfg["aqtpm_project_id"], begin, end, _monday(begin), _sunday(end))
    ts_count = 0
    for full in invoice_hours:
        rows = data["timesheet"].get(full, [])
        for sunday in tsp.sundays_covering(begin, end):
            mon = sunday - dt.timedelta(days=6)
            if any(r["project"] == data["project_name"] and mon <= r["date"] <= sunday
                   and begin <= r["date"] <= end and r["hours"] for r in rows):
                ts_count += 1
    return {**base, "invoice_hours": invoice_hours,
            "staff_direct_labor": calc["staff"]["direct_labor"],
            "principal_direct_labor": calc["principal"]["direct_labor"],
            "this_labor": calc["total_labor"], "prior_labor_cumulative": prior,
            "timesheet_count": ts_count, "active_subtask": code}


def build_package(project_key: str, year: int, month: int, *,
                  invoice_date: dt.date | None = None, this_odc: float = 0.0,
                  save_to_real: bool = False, out_override: str | None = None,
                  make_pdfs: bool = True, combine: bool = False) -> dict:
    cfg = config.PROJECTS[project_key]
    fmt = cfg["format"]
    begin, end = _month_range(year, month)
    invoice_date = invoice_date or dt.date.today()
    month_key = f"{year:04d}-{month:02d}"

    # 1-2) live hours by sub-task + full-week timesheet
    sub = data_source.pull_subtasks(cfg["aqtpm_project_id"], begin, end)
    if combine:
        code, task_name, hours = _combine_subtasks(sub["by_subtask"], fmt, cfg.get("default_subtask_code"))
    else:
        code, task_name, hours = _active_subtask(sub["by_subtask"], fmt)
    invoice_hours = {k: v for k, v in hours.items() if v}
    data = data_source.pull(cfg["aqtpm_project_id"], begin, end, _monday(begin), _sunday(end))
    rates = {n: config.resolve_direct_rate(n, sub["bill_rates"].get(n)) for n in invoice_hours}

    # 3) ledger -> numbering + prior
    led = ledger_mod.load(cfg["ledger"])
    existing = next((e for e in led.entries if e.get("month") == month_key), None)
    invoice_no = existing["invoice_no"] if existing else led.next_invoice_no()

    # 4) output folder + name
    folder = cfg["out_folder_fmt"].format(mon=end.strftime("%b"), month_name=end.strftime("%B"), year=year)
    root = out_override or (cfg["out_root"] if save_to_real else TEST_OUT)
    outdir = os.path.join(root, folder)
    os.makedirs(outdir, exist_ok=True)
    stamp = invoice_date.strftime("%m%d%Y")
    inv_xlsx = os.path.join(outdir, cfg["inv_name_fmt"].format(
        month_name=end.strftime("%B"), year=year, stamp=stamp))

    # 5) fill the format-specific template
    if fmt == "stantec":
        import stantec_invoice as si
        p31, p32 = _stantec_priors(led.data, begin)
        inp = si.StantecInputs(
            invoice_number=invoice_no, invoice_date=invoice_date, hours_by_emp=invoice_hours,
            subtask_label=cfg["default_subtask_label"],
            period_begin=dt.date.fromisoformat(cfg["contract_start"]), period_end=end,
            prior_31=p31, prior_32=p32, this_odc=this_odc, rates=rates,
            authorized_sig=config.SUPERVISOR_SIG if os.path.exists(config.SUPERVISOR_SIG) else None)
        gen = si.generate(cfg["template_xlsx"], inv_xlsx, inp)
        detail_sheets = ["Invoice Template_Task# 5"]
        summary_sheets = ["Invoice Summary"]
    elif fmt == "jobcon":
        import jobcon_invoice as ji
        priors = _jobcon_priors(led.data, code, begin)
        inp = ji.JobConInputs(
            invoice_number=invoice_no, invoice_date=invoice_date,
            period_begin=begin, period_end=end, hours_by_emp=invoice_hours,
            active_subtask_code=code, prior_by_month=priors, this_odc=this_odc, rates=rates)
        gen = ji.generate(cfg["template_xlsx"], inv_xlsx, inp)
        # B&C workbook is the whole deliverable; export the client-facing tabs
        summary_sheets = ["1-Invoice Cover Sheet", "2-Work Summary", "3-Summary Billing Report"]
        detail_sheets = ["4a-Labor Summary"]
    else:
        raise ValueError(f"unknown format {fmt!r}")

    calc = compute_labor(invoice_hours, rates, config.PRINCIPALS)
    this_total = r2(calc["total_labor"] + this_odc)

    files = {"invoice_xlsx": inv_xlsx}
    pdf_jobs: list = []
    client_sheets = cfg.get("client_sheets")
    invoice_pdf = None
    client_parts: list = []
    if make_pdfs:
        if client_sheets:            # jobcon: each client tab isolated, merged IN ORDER
            invoice_pdf = os.path.join(outdir, f"Invoice {end.strftime('%B')} {year} {stamp}.pdf")
            files["invoice_pdf"] = invoice_pdf
            for _si, _sh in enumerate(client_sheets):
                _pp = os.path.join(outdir, f"_client_{_si}.pdf")
                pdf_jobs.append((inv_xlsx, _pp, [_sh]))
                client_parts.append(_pp)
        else:                        # stantec: keep the separate summary/detail pages
            summary_pdf = os.path.join(outdir, f"Summary {end.strftime('%B')} {year} {stamp}.pdf")
            detail_pdf = os.path.join(outdir, f"Detail {end.strftime('%B')} {year} {stamp}.pdf")
            pdf_jobs += [(inv_xlsx, summary_pdf, summary_sheets), (inv_xlsx, detail_pdf, detail_sheets)]
            files.update(summary_pdf=summary_pdf, detail_pdf=detail_pdf)

    # 6) weekly timesheet backups (shared helper — identical to HDR)
    ts_files, ts_pdf_jobs = tsp.build_weekly_timesheets(
        outdir, invoice_hours, data, begin, end, make_pdfs=make_pdfs)
    pdf_jobs += ts_pdf_jobs

    if pdf_jobs:
        with ExcelSession() as sess:
            for xlsx_p, pdf_p, sheets in pdf_jobs:
                sess.export(xlsx_p, pdf_p, sheets)

    # assemble the client invoice pages in the required order (each was exported isolated)
    if make_pdfs and client_parts and invoice_pdf:
        from packager import _merge_pdfs as _mp
        _mp(invoice_pdf, [p for p in client_parts if os.path.exists(p)])
        for _pp in client_parts:
            try: os.remove(_pp)
            except OSError: pass

    emp_order = list(dict.fromkeys(t["employee"] for t in ts_files))
    if make_pdfs and ts_files:
        import combine_timesheets as _ct
        _ct.combine_folder(outdir, order=emp_order)

    # 7) combined client deliverable — invoice pages -> Timesheets -> Other Material ->
    #    FreshBooks-style detail — matching the prior June submission. Reuses HDR's
    #    divider/merge helpers + FB detail. Only for formats that define client_sheets.
    if make_pdfs and client_sheets and invoice_pdf:
        import fb_invoice
        from packager import _make_divider, _merge_pdfs
        fb_lines = data_source.pull_fb_lines(cfg["aqtpm_project_id"], begin, end)["lines"]
        for _l in fb_lines:
            _lr = config.loaded_bill_rate(_l["person"])
            _l["rate"] = _lr
            _l["amount"] = round(float(_l["hours"]) * _lr, 2)
        fb_pdf = os.path.join(outdir, f"FreshBooks Invoice {end.strftime('%B')} {year} {stamp}.pdf")
        fb_invoice.build_fb_invoice(
            fb_pdf, invoice_number=invoice_no, issue_date=invoice_date,
            due_date=invoice_date + dt.timedelta(days=cfg.get("fb_due_days", 60)),
            billed_to=cfg.get("fb_billed_to", []), company=config.COMPANY,
            lines=fb_lines, project_label=data["project_name"],
            line_task=cfg.get("fb_line_task", ""), amount_due=this_total)
        files["freshbooks_invoice_pdf"] = fb_pdf
        ts_pdfs = [os.path.join(outdir, f"{e} Timesheets.pdf") for e in emp_order
                   if os.path.exists(os.path.join(outdir, f"{e} Timesheets.pdf"))]
        div_ts = _make_divider(os.path.join(outdir, "_div_ts.pdf"), "Timesheets")
        div_other = _make_divider(os.path.join(outdir, "_div_other.pdf"), "Other Material")
        combined = os.path.join(outdir, cfg["inv_name_fmt"].format(
            month_name=end.strftime("%B"), year=year, stamp=stamp).replace(".xlsx", ".pdf"))
        _merge_pdfs(combined, [invoice_pdf, div_ts, *ts_pdfs, div_other, fb_pdf])
        for _d in (div_ts, div_other):
            try: os.remove(_d)
            except OSError: pass
        files["combined_pdf"] = combined
    manifest = {
        "project": project_key, "format": fmt, "month": month_key,
        "period": [begin.isoformat(), end.isoformat()], "invoice_no": invoice_no,
        "invoice_date": invoice_date.isoformat(), "active_subtask": code,
        "aqtpm_task": task_name, "invoice_hours": invoice_hours,
        "this_labor": calc["total_labor"], "this_odc": this_odc, "this_total": this_total,
        "outdir": outdir, "files": files, "timesheets": ts_files, "saved_to_real": save_to_real,
    }

    # 7) record in the ledger only when writing the real package
    if save_to_real:
        rec = {"invoice_no": invoice_no, "month": month_key, "subtask": code,
               "period_begin": begin.isoformat(), "period_end": end.isoformat(),
               "invoice_date": invoice_date.isoformat(), "labor": calc["total_labor"],
               "odc": this_odc, "hours_by_emp": invoice_hours}
        if existing:
            for i, e in enumerate(led.entries):
                if e.get("month") == month_key:
                    led.entries[i] = rec
                    break
        else:
            led.append(rec)
        led.save()
    return manifest


if __name__ == "__main__":
    import io, json
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    key = sys.argv[1] if len(sys.argv) > 1 else "JBCON"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    mo = int(sys.argv[3]) if len(sys.argv) > 3 else 7
    m = build_package(key, yr, mo, save_to_real=False, make_pdfs=True)
    print(f"=== {key} {yr}-{mo:02d} → TEST output (live data) ===")
    print(f"  invoice_no   : {m['invoice_no']}")
    print(f"  active subtask: {m['active_subtask']}   ({m['aqtpm_task']})")
    print(f"  hours        : {m['invoice_hours']}")
    print(f"  this total   : ${m['this_total']:,.2f}")
    print(f"  outdir       : {m['outdir']}")
    print(f"  files        : {list(m['files'].keys())}")
    print(f"  timesheets   : {len(m['timesheets'])}")
