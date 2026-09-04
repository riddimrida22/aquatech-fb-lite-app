"""Pay-stub PDF renderer (PyMuPDF/fitz) in the Paychex-style layout.

render_stub_pdf(path, data) writes a one-page statement for one employee with
the Aquatech logo, an earnings/taxes/deductions/employer-contributions layout,
and CURRENT + YTD columns. `data` is a plain dict (see routes.stub for how it is
assembled from a run line + the YTD ledger)."""

from __future__ import annotations

import os

import fitz

_LOGO = os.path.join(os.path.dirname(__file__), "assets", "aquatech_logo.png")
GREEN = (0.13, 0.45, 0.49)
GREY = (0.35, 0.35, 0.35)
LINE = (0.8, 0.8, 0.8)

# tax-line label + display order (only non-zero lines are shown)
TAXROWS = [
    ("ss", "Social Security"), ("medicare", "Medicare"), ("fed", "Federal Income Tax"),
    ("ny_inc", "NY State Income Tax"), ("nyc", "NYC Resident Tax"), ("nj_inc", "NJ Income Tax"),
    ("ny_sdi", "NY Disability (SDI)"), ("ny_pfl", "NY Paid Family Leave"),
    ("nj_sdi", "NJ Disability"), ("nj_ui", "NJ Unemployment"),
    ("nj_wf", "NJ Workforce"), ("nj_fli", "NJ Family Leave"),
]


def _money(x) -> str:
    return f"${float(x or 0):,.2f}"


def render_stub_pdf(path: str, data: dict) -> str:
    emp = data.get("employee", {})
    per = data.get("period", {})
    cur = data.get("current", {})
    ytd = data.get("ytd", {})
    ctax = cur.get("tax", {}) or {}
    ytax = ytd.get("tax", {}) or {}
    filing = data.get("filing", {}) or {}

    doc = fitz.open()
    pg = doc.new_page(width=612, height=792)

    def T(x, y, s, size=9, bold=False, color=(0, 0, 0)):
        pg.insert_text((x, y), str(s), fontsize=size, fontname="hebo" if bold else "helv", color=color)

    def R(xr, y, s, size=9, bold=False, color=(0, 0, 0)):
        w = fitz.get_text_length(str(s), fontname="hebo" if bold else "helv", fontsize=size)
        pg.insert_text((xr - w, y), str(s), fontsize=size, fontname="hebo" if bold else "helv", color=color)

    def hdr(y, label):
        pg.draw_rect(fitz.Rect(40, y - 10, 572, y + 4), color=None, fill=(0.93, 0.95, 0.95))
        T(46, y, label, 9, True, GREEN)
        R(500, y, "Current", 8, True, GREY)
        R(566, y, "YTD", 8, True, GREY)

    # --- header: logo + company ---
    if os.path.exists(_LOGO):
        try:
            pg.insert_image(fitz.Rect(40, 34, 115, 57), filename=_LOGO, keep_proportion=True)
        except Exception:
            pass
    T(360, 44, "Aquatech Engineering P.C.", 10, True)
    T(360, 58, "15 Bonita Vista Rd", 8, color=GREY)
    T(360, 70, "Mount Vernon, NY 10552", 8, color=GREY)
    T(40, 100, "Payroll Statement", 13, True, GREEN)

    # --- employee + check info ---
    y = 120
    T(46, y, emp.get("name", ""), 10, True)
    for i, al in enumerate((emp.get("address_lines") or [])[:2]):
        T(46, y + 13 + i * 11, al, 8, color=GREY)
    T(330, y, "Pay Period:", 8, True); T(415, y, f'{per.get("start","")} - {per.get("end","")}', 8)
    T(330, y + 13, "Check Date:", 8, True); T(415, y + 13, per.get("check_date", ""), 8)
    if per.get("pay_method"):
        T(330, y + 24, "Pay Method:", 8, True); T(415, y + 24, per["pay_method"], 8)
    pg.draw_rect(fitz.Rect(330, y + 34, 572, y + 66), color=GREEN, width=1)
    T(338, y + 48, "NET PAY", 9, True, GREEN); T(338, y + 60, "this period", 7, color=GREY)
    R(500, y + 52, _money(cur.get("net")), 11, True)
    R(566, y + 52, "YTD " + _money(ytd.get("net")), 7, color=GREY)
    y += 86

    # --- earnings ---
    hdr(y, "EARNINGS"); y += 16
    rate = data.get("rate"); hrs = data.get("hours")
    if rate is not None and hrs is not None:
        T(46, y, "Regular", 9)
        T(250, y, f"{float(hrs):g} hrs", 9, color=GREY)
        T(320, y, f"@ {_money(rate)}/hr", 9, color=GREY)
    else:
        T(46, y, "Regular", 9)
    R(500, y, _money(cur.get("gross")), 9); R(566, y, _money(ytd.get("gross")), 9, color=GREY); y += 14
    pg.draw_line(fitz.Point(46, y - 5), fitz.Point(566, y - 5), color=LINE, width=0.5)
    T(46, y, "Gross Earnings", 9, True)
    R(500, y, _money(cur.get("gross")), 9, True); R(566, y, _money(ytd.get("gross")), 9, True, GREY); y += 22

    # --- taxes withheld ---
    hdr(y, "TAXES WITHHELD"); y += 16
    tc = ty = 0.0
    for k, lbl in TAXROWS:
        cv = ctax.get(k)
        if not cv:
            continue
        yv = ytax.get(k, cv); tc += float(cv); ty += float(yv or 0)
        fs = filing.get("fed") if k == "fed" else (filing.get("state") if k in ("ny_inc", "nj_inc") else "")
        T(46, y, lbl, 9)
        if fs:
            T(250, y, fs, 8, color=GREY)
        R(500, y, _money(cv), 9); R(566, y, _money(yv), 9, color=GREY); y += 13
    pg.draw_line(fitz.Point(46, y - 4), fitz.Point(566, y - 4), color=LINE, width=0.5)
    T(46, y, "Total Taxes", 9, True); R(500, y, _money(tc), 9, True); R(566, y, _money(ty), 9, True, GREY); y += 22

    # --- deductions (employee 401k with % election) ---
    hdr(y, "DEDUCTIONS"); y += 16
    dp = data.get("deferral_pct")
    T(46, y, "Traditional 401(k)" + (" (Roth)" if data.get("roth") else ""), 9)
    if dp is not None:
        T(250, y, f"{float(dp):g}% election", 8, color=GREY)
    R(500, y, _money(cur.get("ee_401k")), 9); R(566, y, _money(ytd.get("ee_401k")), 9, color=GREY); y += 14
    pg.draw_line(fitz.Point(46, y - 5), fitz.Point(566, y - 5), color=LINE, width=0.5)
    T(46, y, "Total Deductions", 9, True)
    R(500, y, _money(cur.get("ee_401k")), 9, True); R(566, y, _money(ytd.get("ee_401k")), 9, True, GREY); y += 22

    # --- employer contributions ---
    hdr(y, "EMPLOYER CONTRIBUTIONS  (not deducted from pay)"); y += 16
    mp = data.get("match_pct", 4)
    T(46, y, "401(k) Employer Match", 9)
    T(250, y, f"{float(mp):g}% (match up to 4%)", 8, color=GREY)
    R(500, y, _money(cur.get("er_match")), 9); R(566, y, _money(ytd.get("er_match")), 9, color=GREY); y += 22

    # --- net pay bar ---
    pg.draw_rect(fitz.Rect(40, y - 2, 572, y + 22), color=None, fill=GREEN)
    method = per.get("pay_method")
    label = f"NET PAY  ({method})" if method else "NET PAY"
    T(46, y + 14, label, 10, True, (1, 1, 1))
    R(500, y + 14, _money(cur.get("net")), 11, True, (1, 1, 1))
    R(566, y + 14, "YTD " + _money(ytd.get("net")), 8, True, (1, 1, 1))

    doc.save(path)
    doc.close()
    return path
