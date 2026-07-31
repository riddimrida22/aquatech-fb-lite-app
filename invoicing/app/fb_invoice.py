"""
FreshBooks-style invoice generator — reproduces the client-facing invoice that used to
be made in FreshBooks (the line-item page in the sent HDR package). One line per time
entry: task, "(project) person – date", the employee's note, loaded rate, qty, total.

Fully replaces the FreshBooks step; built from AqtPM time entries.
"""
from __future__ import annotations
import datetime as dt, os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle, Paragraph,
                                Spacer, Image)
from reportlab.lib.styles import ParagraphStyle

INK = colors.HexColor("#2b2b2b")
MUTED = colors.HexColor("#5b7f93")     # blue-gray labels
RULE = colors.HexColor("#0f5f6f")      # teal rule
GRAY = colors.HexColor("#6b6b6b")


def _fmt_date(d: dt.date) -> str:
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def _money(x: float) -> str:
    return "${:,.2f}".format(x)


def build_fb_invoice(out_pdf: str, *, invoice_number: str, issue_date: dt.date,
                     due_date: dt.date, billed_to: list[str], company: dict,
                     lines: list[dict], project_label: str, line_task: str,
                     amount_due: float | None = None) -> dict:
    line_sum = round(sum(float(l["amount"]) for l in lines), 2)
    if amount_due is None:
        amount_due = line_sum
    else:
        # The cost-plus spreadsheet rounds on the aggregate; FreshBooks-style per-line
        # rounding drifts a cent or two. Spreadsheet is authoritative, so absorb the
        # difference into the largest line so the line items sum exactly to amount_due.
        adj = round(float(amount_due) - line_sum, 2)
        if abs(adj) >= 0.01 and lines:
            imax = max(range(len(lines)), key=lambda i: float(lines[i]["amount"]))
            lines = list(lines)
            lines[imax] = {**lines[imax], "amount": round(float(lines[imax]["amount"]) + adj, 2)}

    styles = {
        "lbl": ParagraphStyle("lbl", fontName="Helvetica", fontSize=8.5, textColor=MUTED, leading=12),
        "val": ParagraphStyle("val", fontName="Helvetica", fontSize=9.5, textColor=INK, leading=13),
        "co": ParagraphStyle("co", fontName="Helvetica", fontSize=9, textColor=INK, leading=12, alignment=2),
        "task": ParagraphStyle("task", fontName="Helvetica", fontSize=9.5, textColor=INK, leading=13),
        "sub": ParagraphStyle("sub", fontName="Helvetica", fontSize=8.5, textColor=GRAY, leading=11),
        "amt": ParagraphStyle("amt", fontName="Helvetica", fontSize=22, textColor=INK, leading=24),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=9, textColor=INK, leading=12, alignment=2),
        "hdr": ParagraphStyle("hdr", fontName="Helvetica", fontSize=8.5, textColor=MUTED, leading=12, alignment=2),
    }
    doc = SimpleDocTemplate(out_pdf, pagesize=letter, leftMargin=0.7*inch,
                            rightMargin=0.7*inch, topMargin=0.6*inch, bottomMargin=0.7*inch)
    flow = []

    # --- letterhead: logo left, company block right ---
    logo = company.get("logo")
    left = Image(logo, width=2.05*inch, height=0.63*inch) if logo and os.path.exists(logo) else Paragraph("", styles["val"])
    co_lines = "<br/>".join([company["name"], company.get("phone", "")] + company.get("address", []))
    head = Table([[left, Paragraph(co_lines, styles["co"])]], colWidths=[3.2*inch, 3.9*inch])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    flow += [head, Spacer(1, 26)]

    # --- Billed To / Date / Invoice # / Amount Due ---
    def kv(label, value, big=False):
        return [Paragraph(label, styles["lbl"]), Spacer(1, 2),
                Paragraph(value, styles["amt"] if big else styles["val"])]

    billed = "<br/>".join(billed_to)
    dates = (f'{Paragraph}')  # placeholder unused
    c1 = [Paragraph("Billed To", styles["lbl"]), Spacer(1, 2), Paragraph(billed, styles["val"])]
    c2 = [Paragraph("Date of Issue", styles["lbl"]), Spacer(1, 2), Paragraph(_fmt_date(issue_date), styles["val"]),
          Spacer(1, 8), Paragraph("Due Date", styles["lbl"]), Spacer(1, 2), Paragraph(_fmt_date(due_date), styles["val"])]
    c3 = [Paragraph("Invoice Number", styles["lbl"]), Spacer(1, 2), Paragraph(invoice_number, styles["val"])]
    c4 = [Paragraph("Amount Due (USD)", styles["lbl"]), Spacer(1, 2), Paragraph(_money(amount_due), styles["amt"])]
    meta = Table([[c1, c2, c3, c4]], colWidths=[1.9*inch, 1.7*inch, 1.6*inch, 1.9*inch])
    meta.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    flow += [meta, Spacer(1, 14)]

    # --- line-item table ---
    data = [[Paragraph("Description", ParagraphStyle("h", parent=styles["lbl"])),
             Paragraph("Rate", styles["hdr"]), Paragraph("Qty", styles["hdr"]),
             Paragraph("Line Total", styles["hdr"])]]
    for l in lines:
        d = l["date"] if isinstance(l["date"], dt.date) else dt.date.fromisoformat(l["date"])
        desc = (f'{line_task}<br/><font size=8 color="#6b6b6b">({project_label}) '
                f'{l["person"]} &ndash; {_fmt_date(d)}</font>')
        if l.get("note"):
            note = str(l["note"]).replace("&", "&amp;").replace("<", "&lt;")
            desc += f'<br/><font size=8 color="#6b6b6b">{note}</font>'
        data.append([Paragraph(desc, styles["task"]),
                     Paragraph(_money(l["rate"]), styles["cell"]),
                     Paragraph(f'{float(l["hours"]):g}', styles["cell"]),
                     Paragraph(_money(l["amount"]), styles["cell"])])

    tbl = Table(data, colWidths=[3.9*inch, 1.05*inch, 0.7*inch, 1.05*inch], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 1.4, RULE),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.HexColor("#e2e2e2")),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    flow.append(tbl)

    # total line
    flow += [Spacer(1, 10)]
    tot = Table([[Paragraph("Amount Due (USD)", styles["lbl"]), Paragraph(_money(amount_due), styles["cell"])]],
                colWidths=[5.65*inch, 1.05*inch])
    tot.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1.0, RULE),
                             ("TOPPADDING", (0, 0), (-1, -1), 6), ("ALIGN", (1, 0), (1, 0), "RIGHT")]))
    flow.append(tot)

    doc.build(flow)
    return {"out": out_pdf, "amount_due": amount_due, "lines": len(lines)}


if __name__ == "__main__":
    import io, sys, os as _os
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    import config, data_source
    lines = data_source.pull_fb_lines(4, dt.date(2026, 5, 3), dt.date(2026, 5, 30))["lines"]
    out = _os.path.join(config.ROOT, "_test_fb_invoice_may.pdf")
    r = build_fb_invoice(out, invoice_number="HYDRAQ17", issue_date=dt.date(2026, 6, 2),
                         due_date=dt.date(2026, 8, 1), billed_to=["HDR LTCP", "HDR"],
                         company=config.COMPANY, lines=lines, project_label="LTCP4",
                         line_task=config.PROJECTS["HDR_LTCP4"]["fb_line_task"])
    print("FB invoice:", r["out"], "amount_due=", r["amount_due"], "(expect 25052.20)", "lines=", r["lines"])
