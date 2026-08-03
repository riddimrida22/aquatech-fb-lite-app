"""
Package builder — turns (project, billing period) into a complete, ready-to-deliver
invoice package, fully data-driven (no hardcoding):

  1. resolve billing period from the project's period table
  2. pull live hours from AqtPM (invoice hours = exact period; timesheet = full weeks)
  3. ledger -> next invoice number + prior labor/ODC cumulative (auto)
  4. fill the real invoice template  -> invoice xlsx + Summary/Detail/delivery PDFs
  5. build pixel-perfect weekly timesheet PDFs (per employee, per week with hours)
  6. write the whole package into the invoice folder; append the ledger

By default writes to a TEST output dir so validation never touches the real G: folders.
Pass save_to_real=True (from the confirmed UI action) to write into the client folder.
"""
from __future__ import annotations
import os, sys, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # parent (generators)
import config, ledger
import data_source
from hdr_invoice_generator import (InvoiceInputs, PriorInvoice, generate,
                                   load_billing_periods, compute_labor)
from timesheet_xlsx import build_timesheet_xlsx, ExcelSession, DayEntry

TEST_OUT = os.path.join(config.ROOT, "_test_output")


def _monday(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def _sunday(d: dt.date) -> dt.date:
    return d + dt.timedelta(days=6 - d.weekday())


def sundays_covering(begin: dt.date, end: dt.date) -> list[dt.date]:
    s = _sunday(begin)
    out = []
    while s - dt.timedelta(days=6) <= end:
        out.append(s)
        s += dt.timedelta(days=7)
    return out


def _resolve_rates(invoice_hours: dict, bill_rates: dict) -> dict:
    """Direct salary rate per employee: config first, else unload the AqtPM bill rate."""
    return {n: config.resolve_direct_rate(n, bill_rates.get(n)) for n in invoice_hours}


def list_periods(project_key: str) -> list[dict]:
    """Billing periods for a project + which are already invoiced (from the ledger)."""
    cfg = config.PROJECTS[project_key]
    periods = load_billing_periods(cfg["periods_csv"])
    if project_key == "HDR_LTCP4":
        ledger.seed_hdr_ledger(cfg["ledger"])
    L = ledger.load(cfg["ledger"]) if os.path.exists(cfg["ledger"]) else None
    out = []
    for n in sorted(periods):
        b, e = periods[n]
        done = L.has_period(n) if L else None
        out.append({"period_number": n, "begin": b.isoformat(), "end": e.isoformat(),
                    "invoiced": bool(done), "invoice_no": (done or {}).get("invoice_no")})
    return out


def preview(project_key: str, period_number: int) -> dict:
    """Pull live hours + compute the invoice numbers WITHOUT writing any files."""
    cfg = config.PROJECTS[project_key]
    periods = load_billing_periods(cfg["periods_csv"])
    begin, end = periods[period_number]
    data = data_source.pull(cfg["aqtpm_project_id"], begin, end, _monday(begin), _sunday(end))
    invoice_hours = {k: v for k, v in data["invoice_hours"].items() if v}
    if project_key == "HDR_LTCP4":
        ledger.seed_hdr_ledger(cfg["ledger"])
    L = ledger.load(cfg["ledger"])
    rates = _resolve_rates(invoice_hours, data.get("bill_rates", {}))
    calc = compute_labor(invoice_hours, rates, config.PRINCIPALS)
    weeks = sundays_covering(begin, end)
    billed = data["project_name"]
    # count timesheet backups that would be produced (weeks with billed hours only)
    ts_count = 0
    for full in invoice_hours:
        rows = data["timesheet"].get(full, [])
        for sunday in weeks:
            mon = sunday - dt.timedelta(days=6)
            if any(r["project"] == billed and mon <= r["date"] <= sunday
                   and begin <= r["date"] <= end and r["hours"] for r in rows):
                ts_count += 1
    return {
        "project": project_key, "period_number": period_number,
        "period": [begin.isoformat(), end.isoformat()],
        "already_invoiced": bool(L.has_period(period_number)),
        "invoice_no": L.next_invoice_no(),
        "invoice_hours": invoice_hours,
        "staff_direct_labor": calc["staff"]["direct_labor"],
        "principal_direct_labor": calc["principal"]["direct_labor"],
        "this_labor": calc["total_labor"],
        "prior_labor_cumulative": L.prior_labor_cumulative(),
        "prior_odc_cumulative": L.prior_odc_cumulative(),
        "timesheet_count": ts_count,
    }


def _make_divider(pdf_path: str, title: str) -> str:
    """A simple centered-title divider page (matches the sent package's TIMESHEETS/Other)."""
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(pdf_path, pagesize=letter)
    w, h = letter
    c.setFont("Helvetica-Bold", 20)
    c.drawCentredString(w / 2, h - 90, title)
    c.showPage(); c.save()
    return pdf_path


def _merge_pdfs(out_path: str, parts: list[str]) -> str:
    import fitz
    doc = fitz.open()
    for p in parts:
        if p and os.path.exists(p):
            with fitz.open(p) as src:
                doc.insert_pdf(src)
    doc.save(out_path); doc.close()
    return out_path


def build_package(project_key: str, period_number: int, *,
                  invoice_date: dt.date | None = None, this_odc: float = 0.0,
                  invoice_number: str | None = None,
                  save_to_real: bool = False, out_override: str | None = None,
                  make_pdfs: bool = True) -> dict:
    cfg = config.PROJECTS[project_key]
    periods = load_billing_periods(cfg["periods_csv"])
    if period_number not in periods:
        raise ValueError(f"period {period_number} not in {cfg['periods_csv']}")
    begin, end = periods[period_number]
    invoice_date = invoice_date or dt.date.today()

    # 1) live data (timesheet over full weeks covering the period)
    ts_begin = _monday(begin)
    ts_end = _sunday(end)
    data = data_source.pull(cfg["aqtpm_project_id"], begin, end, ts_begin, ts_end)
    invoice_hours = {k: v for k, v in data["invoice_hours"].items() if v}

    # 2) ledger -> numbering + prior cumulative
    if project_key == "HDR_LTCP4":
        ledger.seed_hdr_ledger(cfg["ledger"])
    L = ledger.load(cfg["ledger"])
    # Re-issuable: if this period was already invoiced (client change / correction spotted),
    # keep the same invoice number and overwrite; otherwise take the next number.
    existing = L.has_period(period_number)
    reissue = bool(existing)
    invoice_no = invoice_number or (existing["invoice_no"] if existing else L.next_invoice_no())
    # Prior cumulative = ledger seed (billed through the seed period) + each intermediate
    # period's this-invoice labor. Matches the real invoices' running "billed previously"
    # (which is NOT a naive sum of all FreshBooks invoices). Verified vs real May.
    seed = L.data["seed"]
    seed_end = dt.date.fromisoformat(seed["through_period_end"])
    prior_labor = float(seed["prior_labor_cumulative"])
    prior_odc = float(seed["prior_odc_cumulative"])
    for pn, (pb, pe) in periods.items():
        if pe <= seed_end or pn >= period_number:
            continue                                    # already in seed / not prior
        idata = data_source.pull(cfg["aqtpm_project_id"], pb, pe)
        ih = {k: v for k, v in idata["invoice_hours"].items() if v}
        ir = _resolve_rates(ih, idata.get("bill_rates", {}))
        prior_labor += compute_labor(ih, ir, config.PRINCIPALS)["total_labor"]
    prior_labor = round(prior_labor, 2)
    rates = _resolve_rates(invoice_hours, data.get("bill_rates", {}))

    # 3) output folder
    month_name = end.strftime("%B")
    year = end.year
    folder = cfg["out_folder_fmt"].format(month_name=month_name, year=year)
    root = out_override or (cfg["out_root"] if save_to_real else TEST_OUT)
    outdir = os.path.join(root, folder)
    os.makedirs(outdir, exist_ok=True)

    # 4) invoice xlsx from the real template
    stamp = invoice_date.strftime("%m%d%Y")
    inv_xlsx = os.path.join(outdir,
        f"HDR Sub-Consultant Invoicing_Aquatech {month_name} {year} {stamp}.xlsx")
    inp = InvoiceInputs(
        period_number=period_number, invoice_number=invoice_no, invoice_date=invoice_date,
        hours_by_emp=invoice_hours,
        prior_invoices=[PriorInvoice(dt.date.fromisoformat(L.data["seed"]["through_period_end"]), prior_labor)],
        prior_odc_cumulative=prior_odc, this_odc=this_odc, rates=rates,
        authorized_sig=config.SUPERVISOR_SIG if os.path.exists(config.SUPERVISOR_SIG) else None,
    )
    res = generate(cfg["template_xlsx"], inv_xlsx, inp, periods)

    files = {"invoice_xlsx": inv_xlsx}
    # collect PDF export jobs: (xlsx, pdf, sheet_names_or_None) — run in ONE Excel session
    pdf_jobs: list[tuple[str, str, list[str] | None]] = []
    if make_pdfs:
        # ONE export of both invoice sheets in order -> [Summary, Detail] as a single
        # 2-page PDF. Exporting them as two separate jobs makes LibreOffice re-render both
        # sheets each time (it ignores the per-sheet hide when both have print ranges),
        # which duplicated the first two pages. Excel and LibreOffice both render the two
        # sheets correctly in one job.
        invoice_pdf = os.path.join(outdir, f"Invoice {month_name} {year} {stamp}.pdf")
        pdf_jobs += [(inv_xlsx, invoice_pdf, ["Invoice Summary", "Invoice Template_Task# 5"])]
        files.update(invoice_pdf=invoice_pdf)

    # 5) weekly timesheet backups. Include a week ONLY if the employee has BILLED-project
    #    (LTCP4) hours on an in-period day that week — this is the backup for the hours
    #    actually billed. Confirmed against the real May package: Robert has 3 weeks
    #    (5/10, 5/17, 5/31), NOT the week of 5/24 where he worked only JBCON.
    billed_project = data["project_name"]
    all_weeks = sundays_covering(begin, end)
    ts_files = []
    # order employees like the invoice detail: staff first (config order), principal last
    def _emp_key(n):
        is_prin = 1 if n in config.PRINCIPALS else 0
        idx = config.STAFF_ORDER.index(n) if n in config.STAFF_ORDER else len(config.STAFF_ORDER)
        return (is_prin, idx, n)
    for full in sorted(invoice_hours, key=_emp_key):
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
            sup_sig = config.SUPERVISOR_SIG if os.path.exists(config.SUPERVISOR_SIG) else None
            # Prefer the employee's REAL timekeeping workbook (perfect format + logged
            # hours); fall back to reconstruction only if the workbook/week is missing.
            import timesheet_from_workbook as tfw
            # ALL projects the employee worked this week (Mon..Sun), from AqtPM/FreshBooks
            # — the timesheet shows every project; only LTCP4 is outlined for this invoice.
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
                                     emp_signature=config.employee_signature(full),
                                     sup_signature=sup_sig)
            entry_source = "workbook" if wb_res else "reconstructed"
            entry = {"employee": full, "week": wk_i, "week_ending": sunday.isoformat(),
                     "xlsx": ts_xlsx, "source": entry_source}
            if make_pdfs:
                ts_pdf = ts_xlsx[:-5] + ".pdf"
                pdf_jobs.append((ts_xlsx, ts_pdf, None))
                entry["pdf"] = ts_pdf
            ts_files.append(entry)

    # run ALL Excel pdf exports in a single Excel session (fast + robust)
    if pdf_jobs:
        with ExcelSession() as sess:
            for xlsx_p, pdf_p, sheets in pdf_jobs:
                sess.export(xlsx_p, pdf_p, sheets)

    # FreshBooks-style invoice + combined deliverable PDF
    if make_pdfs:
        import fb_invoice, data_source as _ds
        fb_lines = _ds.pull_fb_lines(cfg["aqtpm_project_id"], begin, end)["lines"]
        # Bill each line at the authoritative LOADED rate (direct x OH/profit), the same
        # rate the cost-plus sheet uses — NOT the per-entry stored bill_rate_applied,
        # which can be a stale/flat rate (e.g. a $125 default) that under-totals the
        # invoice and forces a big reconciliation into one line. With correct rates the
        # lines foot to the official total on their own.
        for _l in fb_lines:
            _lr = config.loaded_bill_rate(_l["person"])
            _l["rate"] = _lr
            _l["amount"] = round(float(_l["hours"]) * _lr, 2)
        fb_pdf = os.path.join(outdir, f"FreshBooks Invoice {month_name} {year} {stamp}.pdf")
        # authoritative total = the cost-plus spreadsheet total (aggregate rounding);
        # the FB invoice is reconciled to it so both documents show the same cents.
        _target = round(compute_labor(invoice_hours, rates, config.PRINCIPALS)["total_labor"]
                        + this_odc, 2)
        fb_invoice.build_fb_invoice(
            fb_pdf, invoice_number=invoice_no, issue_date=invoice_date,
            due_date=invoice_date + dt.timedelta(days=cfg.get("fb_due_days", 60)),
            billed_to=cfg.get("fb_billed_to", []), company=config.COMPANY,
            lines=fb_lines, project_label=data["project_name"],
            line_task=cfg.get("fb_line_task", ""), amount_due=_target)
        files["freshbooks_invoice_pdf"] = fb_pdf

        # divider pages + merge into one client deliverable, in the sent page order
        div_ts = _make_divider(os.path.join(outdir, "_div_timesheets.pdf"), "TIMESHEETS")
        div_other = _make_divider(os.path.join(outdir, "_div_other.pdf"), "Other")
        ts_pdfs = [t["pdf"] for t in ts_files if t.get("pdf")]
        combined = os.path.join(outdir, f"HDR Invoice {month_name} {year} {stamp}.pdf")
        _merge_pdfs(combined, [invoice_pdf, div_ts, *ts_pdfs, div_other, fb_pdf])
        for d in (div_ts, div_other):
            try: os.remove(d)
            except OSError: pass
        files["combined_pdf"] = combined

        # combine per-week timesheet backups into one PDF + one tabbed workbook per
        # employee (staff first, principal last); remove the individual per-week files.
        import combine_timesheets as _ct
        emp_order = list(dict.fromkeys(t["employee"] for t in ts_files))
        try:
            _ct.combine_folder(outdir, order=emp_order)
        except Exception as _e:
            # Post-processing nicety (per-employee tabbed workbooks) — the combined
            # PDF + all deliverables are already written, so never fail the package.
            print(f"[packager] combine_timesheets skipped: {_e}", flush=True)

    calc = compute_labor(invoice_hours, rates, config.PRINCIPALS)
    manifest = {
        "project": project_key, "period_number": period_number,
        "period": [begin.isoformat(), end.isoformat()],
        "invoice_no": invoice_no, "invoice_date": invoice_date.isoformat(),
        "invoice_hours": invoice_hours,
        "this_labor": calc["total_labor"], "this_odc": this_odc,
        "this_total": round(calc["total_labor"] + this_odc, 2),
        "prior_labor_cumulative": prior_labor, "prior_odc_cumulative": prior_odc,
        "outdir": outdir, "files": files, "timesheets": ts_files,
        "saved_to_real": save_to_real,
    }

    # 6) record in the ledger ONLY when writing the real package — update in place on a
    #    re-issue (correction) so the number/prior stay consistent; append if new.
    if save_to_real:
        rec = {"invoice_no": invoice_no, "period_number": period_number,
               "period_begin": begin.isoformat(), "period_end": end.isoformat(),
               "invoice_date": invoice_date.isoformat(),
               "labor": calc["total_labor"], "odc": this_odc,
               "hours_by_emp": invoice_hours}
        if reissue:
            for i, e in enumerate(L.entries):
                if e.get("period_number") == period_number:
                    L.entries[i] = rec
                    break
        else:
            L.append(rec)
        L.save()
    return manifest


if __name__ == "__main__":
    import io, json, sys as _sys
    _sys.stdout = io.TextIOWrapper(_sys.stdout.buffer, encoding="utf-8")
    m = build_package("HDR_LTCP4", 5, invoice_date=dt.date(2026, 6, 2),
                      save_to_real=False, make_pdfs=True)
    print("=== Full May package (period 5) → TEST output, live data, no hardcode ===")
    print(f"  invoice_no   : {m['invoice_no']}   (auto from ledger)")
    print(f"  period       : {m['period'][0]} → {m['period'][1]}")
    print(f"  hours        : {m['invoice_hours']}")
    print(f"  this total   : ${m['this_total']:,.2f}   (expect $25,052.21)")
    print(f"  prior cum    : ${m['prior_labor_cumulative']:,.2f}")
    print(f"  outdir       : {m['outdir']}")
    print(f"  invoice files: {list(m['files'].keys())}")
    print(f"  timesheets   : {len(m['timesheets'])} PDFs")
    for t in m["timesheets"]:
        print(f"     wk{t['week']} {t['employee']} (ending {t['week_ending']})")
    ok = abs(m["this_total"] - 25052.21) < 0.005
    print("  >>> PENNY-EXACT + FULL PACKAGE GENERATED" if ok else "  >>> MISMATCH")
