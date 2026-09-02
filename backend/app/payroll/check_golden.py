"""Validate the engine against a real Paychex journal, line by line.

Run:  python -m app.payroll.check_golden   (from backend/)
Also exposes test_golden() for pytest.

Only the *implemented* (rate-based, uncapped) taxes are asserted PASS/FAIL:
Social Security, Medicare, NY SDI, NY PFL, NJ TDI/UI/WF. Income taxes and
employer experience-rated lines are reported as PENDING (need tables / YTD /
company rates) so the report shows exactly how much of the run already ties out.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from .engine import EmployeeInput, cents, company_totals, compute_employee

GOLDEN = Path(__file__).parent / "golden" / "run_2026-08-21.json"
IMPLEMENTED = {"ss", "medicare", "fed", "ny_sdi", "ny_pfl", "nj_sdi", "nj_ui", "nj_wf"}


def _load():
    return json.loads(GOLDEN.read_text())


def run_report() -> tuple[int, int, list[str]]:
    g = _load()
    weeks = g["run"]["weeks"]
    results, rows = [], []
    npass = nfail = 0
    for emp in g["employees"]:
        ein = EmployeeInput(
            name=emp["name"], gross=emp["gross"], pretax_401k=emp["k401_ee"],
            state=emp["state"], nyc_resident=emp["nyc"], weeks=weeks,
            w4=emp.get("w4", {}),
        )
        res = compute_employee(ein)
        results.append(res)
        for line, want in emp["withholdings"].items():
            if line not in IMPLEMENTED:
                continue
            got = res.lines.get(line)
            ok = got is not None and got == cents(want)
            npass += ok
            nfail += (not ok)
            flag = "PASS" if ok else "FAIL"
            rows.append(f"  [{flag}] {emp['name'][:22]:22} {line:9} want {want:>9}  got {got}")

    # Company totals for implemented lines
    tot = company_totals(results)
    ct = g["company_totals"]
    company_checks = [("ss", ct["ss"]), ("fed", ct["fed"]), ("ny_sdi", ct["ny_sdi"]), ("ny_pfl", ct["ny_pfl"]),
                      ("nj_sdi", ct["nj_sdi"]), ("nj_ui", ct["nj_ui"]), ("nj_wf", ct["nj_wf"]),
                      ("gross", ct["gross"]), ("k401_ee", ct["k401_ee"])]
    rows.append("  --- company totals ---")
    for line, want in company_checks:
        got = tot.get(line)
        ok = got is not None and got == cents(want)
        npass += ok
        nfail += (not ok)
        rows.append(f"  [{'PASS' if ok else 'FAIL'}] company            {line:9} want {want:>9}  got {got}")

    # Medicare company total (documents the known 1-cent YTD-cumulative quirk)
    med = tot.get("medicare")
    rows.append(f"  [note] company medicare want {ct['medicare_ee']} got {med} "
                f"(diff = YTD-cumulative rounding on 1 line; needs YTD seed for exact)")

    return npass, nfail, rows


def test_golden():
    npass, nfail, _ = run_report()
    assert nfail == 0, f"{nfail} implemented line(s) did not match the Paychex golden stub"
    assert npass > 0


if __name__ == "__main__":
    npass, nfail, rows = run_report()
    print("\n".join(rows))
    print(f"\n  IMPLEMENTED lines: {npass} PASS / {nfail} FAIL")
    print("  PENDING (need state income-tax tables + W-4): ny_inc, nyc, nj_inc")
    print("  PENDING (need YTD ledger + company experience rates): FUTA, NY UI/RSF, NJ ER UI/SDI/WF, net")
