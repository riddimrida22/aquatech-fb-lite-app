"""
Invoice ledger — the system of record that makes numbering + prior-cumulative
fully automatic (no hardcoding in the generator). Seeded once from known history,
then appended on every generated invoice.

Next invoice number  = increment the last (seed or latest entry).
Prior labor / ODC cumulative for a new invoice = seed cumulative + sum(entries).
"""
from __future__ import annotations
import json, os, re, datetime as dt
from dataclasses import dataclass


def _split_no(no: str) -> tuple[str, int, int]:
    m = re.match(r"^([A-Za-z]+)(\d+)$", no.strip())
    if not m:
        raise ValueError(f"bad invoice number: {no!r}")
    return m.group(1), int(m.group(2)), len(m.group(2))


def next_number(no: str) -> str:
    prefix, n, width = _split_no(no)
    return f"{prefix}{n + 1:0{width}d}"


@dataclass
class LedgerState:
    path: str
    data: dict

    @property
    def entries(self) -> list[dict]:
        return self.data.setdefault("entries", [])

    def last_invoice_no(self) -> str:
        if self.entries:
            return self.entries[-1]["invoice_no"]
        return self.data["seed"]["last_invoice_no"]

    def next_invoice_no(self) -> str:
        return next_number(self.last_invoice_no())

    def prior_labor_cumulative(self) -> float:
        base = float(self.data["seed"]["prior_labor_cumulative"])
        return round(base + sum(float(e["labor"]) for e in self.entries), 2)

    def prior_odc_cumulative(self) -> float:
        base = float(self.data["seed"]["prior_odc_cumulative"])
        return round(base + sum(float(e.get("odc", 0.0)) for e in self.entries), 2)

    def has_period(self, period_number: int) -> dict | None:
        for e in self.entries:
            if e.get("period_number") == period_number:
                return e
        return None

    def append(self, entry: dict) -> None:
        self.entries.append(entry)

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2)


def load(path: str) -> LedgerState:
    with open(path) as f:
        return LedgerState(path, json.load(f))


def seed_hdr_ledger(path: str) -> None:
    """Create the HDR ledger from known history if it doesn't exist.

    Through the April 2026 invoice (HDRAQ0016, period 4 ending 2026-05-02):
      prior labor cumulative = $413,779.21 (sum of the 14 historical monthly labor
      amounts on the invoice's Prior tab), prior ODC cumulative = $5,960.63.
    """
    if os.path.exists(path):
        return
    data = {
        "invoice_prefix": "HDRAQ",
        "seed": {
            "through_period_end": "2026-05-02",
            "last_invoice_no": "HDRAQ0016",
            "prior_labor_cumulative": 413779.21,
            "prior_odc_cumulative": 5960.63,
        },
        "entries": [],
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


if __name__ == "__main__":
    from config import PROJECTS
    p = PROJECTS["HDR_LTCP4"]["ledger"]
    seed_hdr_ledger(p)
    L = load(p)
    print("ledger:", p)
    print("  next invoice no       :", L.next_invoice_no())
    print("  prior labor cumulative:", L.prior_labor_cumulative())
    print("  prior odc cumulative  :", L.prior_odc_cumulative())
    print("  (expect HDRAQ0017 / 413779.21 / 5960.63)")
