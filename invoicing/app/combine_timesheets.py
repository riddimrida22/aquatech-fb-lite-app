"""
Combine the per-week timesheet backups into one file per employee for the period:
  - PDF:  merge that employee's weekly timesheet PDFs -> "<Name> Timesheets.pdf"
  - Excel: one workbook with a tab per week          -> "<Name> Timesheets.xlsx"
then remove the individual per-week files. The invoice + FreshBooks backup are untouched.

Excel combining uses Excel COM (Worksheet.Copy across workbooks) so signatures/format
carry over intact — openpyxl can't move images between workbooks.
"""
from __future__ import annotations
import glob, os, re
import fitz

_PAT = re.compile(r"^Week (\d+) (.+) TIMESHEET\.(pdf|xlsx)$", re.IGNORECASE)


def _group(folder: str, ext: str) -> dict[str, list[tuple[int, str]]]:
    out: dict[str, list[tuple[int, str]]] = {}
    for f in glob.glob(os.path.join(folder, f"Week * TIMESHEET.{ext}")):
        m = _PAT.match(os.path.basename(f))
        if m:
            out.setdefault(m.group(2), []).append((int(m.group(1)), f))
    for emp in out:
        out[emp].sort()
    return out


def combine_folder(folder: str, order: list[str] | None = None) -> dict:
    """order = employee full names in the sequence to keep (staff first, principal last)."""
    pdf_groups = _group(folder, "pdf")
    xlsx_groups = _group(folder, "xlsx")
    emps = order or sorted(pdf_groups)
    emps = [e for e in emps if e in pdf_groups or e in xlsx_groups]

    made = {"pdf": [], "xlsx": []}
    # --- combined PDFs (pymupdf) ---
    for emp in emps:
        items = pdf_groups.get(emp, [])
        if not items:
            continue
        out = os.path.join(folder, f"{emp} Timesheets.pdf")
        doc = fitz.open()
        for _wk, f in items:
            with fitz.open(f) as s:
                doc.insert_pdf(s)
        doc.save(out); doc.close()
        made["pdf"].append(out)

    # --- combined Excel with a tab per week (Excel COM) ---
    if any(xlsx_groups.values()):
        import win32com.client.dynamic as dyn
        excel = dyn.Dispatch("Excel.Application")
        excel.Visible = False; excel.DisplayAlerts = False
        try:
            for emp in emps:
                items = xlsx_groups.get(emp, [])
                if not items:
                    continue
                # Non-fatal per employee: the combined PDFs above are the real
                # deliverable; a tabbed-workbook hiccup must never fail the package.
                try:
                    combined = excel.Workbooks.Add()
                    for wk, f in items:
                        src = excel.Workbooks.Open(os.path.abspath(f))
                        src.Worksheets(1).Copy(After=combined.Worksheets(combined.Worksheets.Count))
                        ws = combined.Worksheets(combined.Worksheets.Count)
                        ws.Visible = True                # copied sheet must be visible,
                        ws.Name = f"Week {wk}"           # else deleting the default leaves 0 visible
                        src.Close(False)
                    # delete the default empty sheet only once real sheets exist
                    if combined.Worksheets.Count > 1:
                        combined.Worksheets(1).Delete()
                    out = os.path.abspath(os.path.join(folder, f"{emp} Timesheets.xlsx"))
                    combined.SaveAs(out, 51)             # 51 = xlsx
                    combined.Close(False)
                    made["xlsx"].append(out)
                except Exception as _e:
                    print(f"[combine_timesheets] skipped tabbed workbook for {emp}: {_e}", flush=True)
                    try:
                        combined.Close(False)
                    except Exception:
                        pass
        finally:
            excel.Quit()

    # --- remove the individual per-week files ---
    removed = 0
    for ext in ("pdf", "xlsx"):
        for f in glob.glob(os.path.join(folder, f"Week * TIMESHEET.{ext}")):
            if _PAT.match(os.path.basename(f)):
                os.remove(f); removed += 1
    return {"employees": emps, "combined_pdf": len(made["pdf"]),
            "combined_xlsx": len(made["xlsx"]), "removed_individual": removed}


if __name__ == "__main__":
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    folder = r"G:\Shared drives\Aquatech_Admin\Invoicing\HDR\HDR Invoice June 2026"
    # staff first, principal last
    order = ["Zachary Gilliam", "Stacey Hodge", "Robert Svadlenka", "Roger Wang",
             "Ailsa Welch", "Bertrand Byrne"]
    print(combine_folder(folder, order))
