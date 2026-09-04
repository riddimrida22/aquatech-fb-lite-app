"""Pay-stub PDF renderer (uses PyMuPDF/fitz, already a dependency).

render_stub_pdf(path, meta, result) writes a one-page stub for one employee from
an engine EmployeeResult. Line labels map the engine keys to human wording.
"""

from __future__ import annotations

from decimal import Decimal

import fitz

_LABELS = {
    "ss": "Social Security", "medicare": "Medicare", "fed": "Federal Income Tax",
    "ny_inc": "NY State Income Tax", "nyc": "NYC Resident Tax", "ny_sdi": "NY Disability (SDI)",
    "ny_pfl": "NY Paid Family Leave", "nj_inc": "NJ Income Tax", "nj_sdi": "NJ Disability",
    "nj_ui": "NJ Unemployment", "nj_wf": "NJ Workforce Dev",
}
_ORDER = ["fed", "ss", "medicare", "ny_inc", "nyc", "ny_sdi", "ny_pfl",
          "nj_inc", "nj_sdi", "nj_ui", "nj_wf"]


def _money(x) -> str:
    return f"${Decimal(str(x or 0)):,.2f}"


def render_stub_pdf(path: str, meta: dict, r) -> str:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # US Letter
    x, y = 54, 60
    def line(txt, dy=16, size=10, bold=False, color=(0, 0, 0)):
        nonlocal y
        page.insert_text((x, y), txt, fontsize=size,
                         fontname="helv" if not bold else "hebo", color=color)
        y += dy
    def row(label, val, dy=15, size=9.5, bold=False):
        nonlocal y
        page.insert_text((x + 8, y), label, fontsize=size, fontname="helv" if not bold else "hebo")
        page.insert_text((x + 470, y), val, fontsize=size, fontname="helv" if not bold else "hebo")
        y += dy

    line("Aquatech Engineering P.C.", 20, 15, bold=True)
    line("Payroll Statement", 22, 11, color=(0.3, 0.3, 0.3))
    line(f"Employee: {r.name}", 15, 10, bold=True)
    line(f"Pay period: {meta['period_start']} to {meta['period_end']}    Check date: {meta['check_date']}", 22, 9.5)

    line("Earnings", 16, 11, bold=True)
    hrs = getattr(r, "hours", None)
    rate = getattr(r, "rate", None)
    if hrs is not None and rate is not None:
        row(f"Regular  ({float(hrs):g} hrs @ {_money(rate)}/hr)", _money(r.gross))
    row("Gross pay", _money(r.gross), bold=True)
    y += 8

    line("Taxes withheld", 16, 11, bold=True)
    tax_total = Decimal("0")
    for k in _ORDER:
        v = r.lines.get(k)
        if v is not None and v != 0:
            row(_LABELS.get(k, k), _money(v))
            tax_total += Decimal(str(v))
    row("Total taxes", _money(tax_total), bold=True)
    y += 8

    line("Deductions", 16, 11, bold=True)
    row("401(k) employee contribution", _money(r.pretax_401k))
    y += 8

    page.draw_line(fitz.Point(x, y), fitz.Point(x + 504, y)); y += 18
    row("NET PAY (direct deposit)", _money(r.net), dy=20, size=12, bold=True)

    if r.employer:
        y += 6
        line("Employer contributions (not deducted from pay)", 15, 9, color=(0.4, 0.4, 0.4))
        if r.employer.get("k401_er"):
            row("401(k) employer match", _money(r.employer["k401_er"]), size=9)

    doc.save(path)
    doc.close()
    return path
