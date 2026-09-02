"""Parse a Paychex Payroll Journal (PYRJRN) PDF into structured data.

Used by the parallel-run reconciliation. Extracts, per run: the check/period dates,
each employee's gross / 401(k) / net, and the COMPANY TOTALS + employer-liability
lines (label->value zipped in document order). Tolerant of the journal's quirky
layout (concatenated tokens, truncated names).
"""

from __future__ import annotations

import re

import fitz

# Canonical line keys mapped from the journal's labels.
_LABELS = {
    "Social Security": "ss", "Medicare": "medicare", "Fed Income Tax": "fed",
    "NY Income Tax": "ny_inc", "NY Disability": "ny_sdi", "NY PFL": "ny_pfl",
    "NY NYC CTY Inc": "nyc", "NJ Income Tax": "nj_inc", "NJ Disability": "nj_sdi",
    "NJ Unemploy": "nj_ui", "NJ EE Work Dev": "nj_wf",
}
_ER_LABELS = {
    "Social Security": "ss", "Medicare": "medicare", "Fed Unemploy": "futa",
    "NY Unemploy": "ny_ui", "NY Re-empl Svc": "ny_rsf", "NJ Disability": "nj_sdi",
    "NJ Unemploy": "nj_ui", "NJ ER Work Dev": "nj_wf",
}
_NUM = re.compile(r"^-?[\d,]+\.\d{2}$")


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _full_text(pdf_path: str) -> str:
    d = fitz.open(pdf_path)
    t = "\n".join(d.load_page(i).get_text() for i in range(d.page_count))
    d.close()
    return t


def _lines(pdf_path: str) -> list[str]:
    # split, also breaking concatenated "24.61Traditional 401k" style tokens
    raw = _full_text(pdf_path).split("\n")
    out = []
    for ln in raw:
        ln = ln.strip()
        m = re.match(r"^(-?[\d,]+\.\d{2})(\D.+)$", ln)  # number glued to a label
        if m:
            out.append(m.group(1)); out.append(m.group(2).strip())
        else:
            out.append(ln)
    return out


def parse_journal(pdf_path: str) -> dict:
    text = _full_text(pdf_path)
    lines = [l for l in _lines(pdf_path) if l != ""]

    # --- run meta ---
    meta = {}
    m = re.search(r"(\d\d)/(\d\d)/(\d\d)\s*-\s*(\d\d)/(\d\d)/(\d\d)", text)
    if m:
        meta["period_start"] = f"20{m.group(3)}-{m.group(1)}-{m.group(2)}"
        meta["period_end"] = f"20{m.group(6)}-{m.group(4)}-{m.group(5)}"
    m = re.search(r"Check Date\s*\n?\s*(\d\d)/(\d\d)/(\d\d)", text)
    if m:
        meta["check_date"] = f"20{m.group(3)}-{m.group(1)}-{m.group(2)}"

    # --- per-employee: anchor on EMPLOYEE TOTAL, name = last real name before it ---
    def _is_name(ln: str) -> bool:
        return (bool(re.match(r"^[A-Z][A-Za-z'.\- ]+,\s+[A-Z]", ln))
                and any(c.islower() for c in ln) and "Aquatech" not in ln
                and "EARNINGS" not in ln.upper())

    employees = []
    last_name = None
    for i, ln in enumerate(lines):
        if _is_name(ln):
            last_name = ln.replace("(cont.)", "").strip().rstrip(". ")
        if ln.startswith("EMPLOYEE TOTAL"):
            # after EMPLOYEE TOTAL: hours(.4f, skipped), gross(.2f), withholding(.2f),
            # ..., <401k>(.2f) "Net Pay", net(.2f)
            nums, net, k401 = [], None, None
            j = i + 1
            while j < len(lines) and j < i + 16:
                cur = lines[j]
                if _NUM.match(cur):
                    nums.append(_num(cur))
                if cur.startswith("Net Pay"):
                    if nums:
                        k401 = nums[-1]
                    k = j + 1
                    while k < len(lines) and not _NUM.match(lines[k]):
                        k += 1
                    if k < len(lines):
                        net = _num(lines[k])
                    break
                j += 1
            employees.append({"name": last_name or f"Employee {len(employees)+1}",
                              "gross": nums[0] if nums else None,
                              "k401_ee": k401 or 0.0, "net": net})

    # --- company totals (labels then values, zipped) ---
    def _zip_block(start_key: str, label_map: dict) -> dict:
        idx = text.find(start_key)
        if idx < 0:
            return {}
        seg = [l for l in _lines_from(text[idx:])]
        labels, vals = [], []
        for l in seg[1:]:
            if l in label_map:
                labels.append(label_map[l])
            elif _NUM.match(l) and labels:  # ignore the Regular/gross number before the labels
                vals.append(_num(l))
                if len(vals) >= len(labels) and len(labels) > 3:
                    break
        return {k: v for k, v in zip(labels, vals)}

    company = _zip_block("COMPANY TOTALS", _LABELS)
    employer = _zip_block("Employer Liabilities", _ER_LABELS)

    # company gross + net + 401k from the COMPANY TOTAL line
    m = re.search(r"COMPANY TOTAL[^\n]*\n\s*([\d,]+\.\d{2})?\s*\n?\s*([\d,]+\.\d{2})", text)
    totals = {"lines": company, "employer": employer}
    m = re.search(r"Dir Dep\*\*\s*\n?\s*([\d,]+\.\d{2})", text)
    if m:
        totals["net"] = _num(m.group(1))
    m = re.search(r"Traditional 401k\s*\n?\s*([\d,]+\.\d{2})", text)
    if m:
        totals["k401_ee"] = _num(m.group(1))

    return {"meta": meta, "employees": employees, "company": totals,
            "source": pdf_path}


def _lines_from(t: str) -> list[str]:
    out = []
    for ln in t.split("\n"):
        ln = ln.strip()
        mm = re.match(r"^(-?[\d,]+\.\d{2})(\D.+)$", ln)
        if mm:
            out.append(mm.group(1)); out.append(mm.group(2).strip())
        elif ln:
            out.append(ln)
    return out


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(parse_journal(sys.argv[1]), indent=2, default=str)[:3000])
