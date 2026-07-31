"""
Stantec / Brown & Caldwell JV sub-consultant invoice generator (contract 1539-REG,
Assignment 014). Same NYCDEP cost-plus template family as HDR, but:

  * bills a single sub-task of Task 3 (historically 3.2 - Jamaica Bay Beneficial Use);
  * the Invoice Summary rolls up sub-tasks 3.1/3.2/3.4/3.5, with a 2-column `Prior`
    sheet (col B = 3.1 cumulative [complete/frozen], col C = 3.2 cumulative);
  * invoice numbers are SBCAQ####, billed to Melissa Carter at Stantec/Brown & Caldwell.

The template is entirely formula-driven (staff x2.14 +10% profit; principal x2.14, 0%
profit; task rollup; % complete; balance), so generation only writes names/hours/rates
into the Task-3 detail block, patches the header, and rewrites the `Prior` sheet. Every
dollar recomputes from the sheet's own formulas — identical approach to the HDR engine.

Validated: the cost-plus math reproduces SBCAQ0005 (Feb 2026) = $12,201.21 to the penny.
"""
from __future__ import annotations
import datetime as dt, os, shutil, sys
from dataclasses import dataclass, field
import openpyxl

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # ROOT (has hdr_invoice_generator)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))                    # app (has config)
# reuse the shared, validated cost-plus math + per-employee metadata helpers
from hdr_invoice_generator import compute_labor, _emp_meta, _copy_row_style, r2, PriorInvoice

# --- Task-3 detail sheet ("Invoice Template_Task# 5") row map ----------------------
# staff block: rows 14-17 (4 template slots) -> SUM row 18; principal: rows 23-24 -> SUM 25
TPL_STAFF_FIRST = 14
TPL_STAFF_SLOTS = 4
TPL_PRIN_FIRST = 23
TPL_PRIN_SLOTS = 2

# Which sub-task the summary's "this invoice" formula is wired to (D29 = task total).
WIRED_SUBTASK = "3.2"


@dataclass
class StantecInputs:
    invoice_number: str                 # e.g. "SBCAQ0006"
    invoice_date: dt.date
    hours_by_emp: dict[str, float]      # this-invoice hours (the active sub-task)
    subtask_label: str                  # A11 on the Task-3 sheet, e.g. "Task 3.2 - Jamaica Bay Beneficial Use"
    period_begin: dt.date               # C20 (support-services period)
    period_end: dt.date                 # E20
    prior_31: list[PriorInvoice] = field(default_factory=list)   # historical 3.1 amounts (col B)
    prior_32: list[PriorInvoice] = field(default_factory=list)   # historical 3.2 amounts (col C)
    this_odc: float = 0.0
    rates: dict[str, float] = field(default_factory=dict)
    authorized_sig: str | None = None
    authorized_by: str = "Bertrand Byrne, CEO"


def _fill_task3(task, inp: "StantecInputs"):
    """Write the STAFF + PRINCIPAL cost-plus blocks. The template's N-column formulas
    (ROUND(H*L,2), OH 114%, profit 10%/0%, task rollup) are left intact and recompute."""
    try:
        import config as _cfg
        order, principals_set = _cfg.STAFF_ORDER, _cfg.PRINCIPALS
    except Exception:
        order, principals_set = [], {"Bertrand Byrne"}

    def _order_key(n):
        return (order.index(n) if n in order else len(order), n)

    staff = sorted([n for n, h in inp.hours_by_emp.items()
                    if n not in principals_set and h], key=_order_key)
    prin = sorted([n for n, h in inp.hours_by_emp.items()
                   if n in principals_set and h], key=_order_key)

    if len(staff) > TPL_STAFF_SLOTS:
        # keep it honest: never silently drop or misplace a person
        raise ValueError(f"Stantec template has {TPL_STAFF_SLOTS} staff slots but "
                         f"{len(staff)} staff have hours: {staff}. Extend the template.")
    if len(prin) > TPL_PRIN_SLOTS:
        raise ValueError(f"Stantec template has {TPL_PRIN_SLOTS} principal slots but "
                         f"{len(prin)} principals have hours: {prin}.")

    task["A11"] = inp.subtask_label

    def _write_block(members, first_row, slots):
        for i in range(slots):
            r = first_row + i
            if i < len(members):
                n = members[i]
                fn, sur, title, _rate = _emp_meta(n, inp)
                rate = inp.rates.get(n) or _rate
                task[f"A{r}"] = fn; task[f"B{r}"] = sur; task[f"D{r}"] = title
                task[f"H{r}"] = inp.hours_by_emp[n]; task[f"L{r}"] = rate
            else:  # blank an unused template slot (leaves the N-formula = ROUND(0,2)=0)
                for col in "ABDH":
                    task[f"{col}{r}"] = None
                task[f"L{r}"] = None

    _write_block(staff, TPL_STAFF_FIRST, TPL_STAFF_SLOTS)
    _write_block(prin, TPL_PRIN_FIRST, TPL_PRIN_SLOTS)

    # direct expenses (row 33 value col L; N35 sums N33:N34)
    if inp.this_odc:
        task["L33"] = inp.this_odc


def _fill_prior(prior, inp: "StantecInputs"):
    """Rewrite the 2-column Prior sheet: col B = 3.1 history, col C = 3.2 history.
    Total row (12) sums each column; kept in place so Summary C28/C29 stay valid."""
    # clear existing data rows 6..(total-1) in B and C
    total_row = 12
    for r in range(6, total_row):
        prior[f"A{r}"] = None; prior[f"B{r}"] = None; prior[f"C{r}"] = None
    slots = total_row - 6                       # 6 rows available (6..11)
    if len(inp.prior_31) > slots or len(inp.prior_32) > slots:
        raise ValueError("Stantec Prior sheet has 6 rows/column; add rows to the template.")

    def _write(col, entries):
        for i, pi in enumerate(entries):
            r = 6 + i
            d = pi.date
            prior[f"A{r}"] = dt.datetime(d.year, d.month, d.day)
            prior[f"{col}{r}"] = pi.labor_amount

    _write("B", inp.prior_31)
    _write("C", inp.prior_32)
    prior["B12"] = "=SUM(B5:B11)"
    prior["C12"] = "=SUM(C5:C11)"


def generate(template_xlsx: str, out_xlsx: str, inp: StantecInputs) -> dict:
    if WIRED_SUBTASK not in inp.subtask_label.replace(" ", ""):
        raise ValueError(
            f"Stantec summary is wired so 'this invoice' (D29) = the Task-3 detail total, "
            f"i.e. sub-task {WIRED_SUBTASK}. The active sub-task is {inp.subtask_label!r}. "
            f"Re-point the Invoice Summary before billing a different sub-task.")

    shutil.copyfile(template_xlsx, out_xlsx)
    wb = openpyxl.load_workbook(out_xlsx, data_only=False)
    summ = wb["Invoice Summary"]
    task = wb["Invoice Template_Task# 5"]
    prior = wb["Prior"]

    # header (everything else on the summary is a formula and recomputes)
    summ["G11"] = inp.invoice_date.strftime("%m/%d/%y")
    summ["G12"] = inp.invoice_number
    summ["C20"] = dt.datetime(inp.period_begin.year, inp.period_begin.month, inp.period_begin.day)
    summ["E20"] = dt.datetime(inp.period_end.year, inp.period_end.month, inp.period_end.day)
    summ["D28"] = 0                         # sub-task 3.1 this-invoice (complete; no work)

    _fill_task3(task, inp)
    _fill_prior(prior, inp)

    # authorized signature above the "Authorized Signature" line (F41)
    if inp.authorized_sig and os.path.exists(inp.authorized_sig):
        from openpyxl.drawing.image import Image as XLImage
        from openpyxl.drawing.spreadsheet_drawing import OneCellAnchor, AnchorMarker
        from openpyxl.drawing.xdr import XDRPositiveSize2D
        from openpyxl.utils.units import pixels_to_EMU
        from PIL import Image as PILImage
        _im = PILImage.open(inp.authorized_sig); _h = 34; _w = _h * (_im.width / _im.height)
        _img = XLImage(inp.authorized_sig)
        _img.anchor = OneCellAnchor(
            _from=AnchorMarker(col=5, colOff=pixels_to_EMU(15), row=38, rowOff=pixels_to_EMU(2)),
            ext=XDRPositiveSize2D(pixels_to_EMU(_w), pixels_to_EMU(_h)))
        summ.add_image(_img)

    wb.save(out_xlsx)

    try:
        import config as _cfg
        principals = _cfg.PRINCIPALS
    except Exception:
        principals = {"Bertrand Byrne"}
    calc = compute_labor(inp.hours_by_emp, inp.rates or None, principals)
    return dict(out=out_xlsx, this_labor=calc["total_labor"], this_odc=inp.this_odc,
                this_total=r2(calc["total_labor"] + inp.this_odc),
                prior_32_cum=r2(sum(p.labor_amount for p in inp.prior_32)),
                prior_31_cum=r2(sum(p.labor_amount for p in inp.prior_31)), calc=calc)


if __name__ == "__main__":
    # VALIDATION: regenerate SBCAQ0005 (Feb 2026) and confirm $12,201.21 to the penny.
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import config as cfg
    TPL = r"G:\Shared drives\Aquatech_Admin\Invoicing\Stantec B&C JV\Feb 2026 Stantec BC JV\Stantec B&C JV Sub-Consultant Invoicing_Aquatech February 2026 02232025 v1.xlsx"
    OUT = os.path.join(cfg.ROOT, "_test_stantec_SBCAQ0005.xlsx")
    inp = StantecInputs(
        invoice_number="SBCAQ0005", invoice_date=dt.date(2026, 2, 23),
        hours_by_emp={"Ailsa Welch": 16, "Robert Svadlenka": 10, "Bertrand Byrne": 38},
        subtask_label="Task 3.2 - Jamaica Bay Beneficial Use",
        period_begin=dt.date(2025, 1, 23), period_end=dt.date(2026, 2, 19),
        prior_31=[PriorInvoice(dt.date(2025, 10, 1), 27326.73), PriorInvoice(dt.date(2025, 11, 1), 31692.33)],
        prior_32=[PriorInvoice(dt.date(2025, 12, 1), 35550.75), PriorInvoice(dt.date(2026, 1, 1), 20739.17)],
        rates=dict(cfg.RATES),
    )
    res = generate(TPL, OUT, inp)
    EXPECT = 12201.21
    ok = abs(res["this_total"] - EXPECT) < 0.005
    print("=== Stantec generator — regenerate SBCAQ0005 (Feb 2026) ===")
    print(f"  staff  direct labor : ${res['calc']['staff']['direct_labor']:,.2f}")
    print(f"  princ  direct labor : ${res['calc']['principal']['direct_labor']:,.2f}")
    print(f"  THIS-INVOICE total  : ${res['this_total']:,.2f}   expected ${EXPECT:,.2f}")
    print(f"  prior 3.2 cum       : ${res['prior_32_cum']:,.2f}   (expect 56,289.92)")
    print(f"  wrote               : {res['out']}")
    print("  >>> PENNY-EXACT MATCH TO SBCAQ0005" if ok else "  >>> MISMATCH")
