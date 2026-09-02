"""Pure payroll tax-calculation engine (no DB, no I/O) — the penny-critical core.

Design notes learned from the Paychex golden stub (2026-08-21):
- **Per-employee, per-tax rounding** to the cent, THEN sum for company totals
  (the EE Medicare total 181.34 vs ER 181.35 only reconciles this way).
- Wages for FICA/SDI/PFL are GROSS (a traditional-401k deferral does NOT reduce
  them); the 401k deferral only reduces income-tax wages.
- Paychex computes FICA on a **YTD-cumulative** basis (tax on YTD wages, rounded,
  minus tax already withheld). That produces occasional 1-cent differences from
  naive per-period rounding (e.g. Bertrand Medicare 5.75 vs a per-period 5.76).
  Uncapped per-period rounding matches 5 of 6 lines; exact match on every line
  and on all wage-base-capped taxes (FUTA, UI, SS cap) requires the YTD ledger —
  seed it from the cumulative Paychex report (next step), then switch the capped
  taxes to `_ytd_delta`.

Implemented now (reproduces the stub to the penny): Social Security, Medicare
(per-period), NY SDI, NY PFL, NJ TDI/UI/WF (employee). Income taxes and
employer experience-rated UI/SDI are scaffolded and return None until their
tables / YTD ledger / company rates are wired.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from . import tables_2026 as T


def cents(x) -> Decimal:
    """Round to the nearest cent, half up (money)."""
    return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass
class EmployeeInput:
    name: str
    gross: Decimal                       # this-period gross wages
    pretax_401k: Decimal = Decimal("0")  # traditional deferral (reduces income-tax wages only)
    state: str = "NY"                    # work/withholding state: "NY" or "NJ"
    nyc_resident: bool = False
    weeks: int = 2                       # pay-period length (for flat weekly items)
    # YTD (for capped/cumulative taxes) — seed from the cumulative report; 0 = start of year.
    ytd_gross: Decimal = Decimal("0")
    ytd_ss_wages: Decimal = Decimal("0")
    # W-4 / IT-2104 / NJ-W4 (drive income tax) — TODO next phase.
    w4: dict = field(default_factory=dict)

    def __post_init__(self):
        self.gross = Decimal(str(self.gross))
        self.pretax_401k = Decimal(str(self.pretax_401k))


@dataclass
class EmployeeResult:
    name: str
    gross: Decimal
    lines: dict[str, Decimal]      # tax/deduction line -> amount (employee side)
    employer: dict[str, Decimal]   # employer-side liabilities
    pretax_401k: Decimal
    net: Decimal | None            # None until income taxes are wired


def compute_employee(e: EmployeeInput) -> EmployeeResult:
    lines: dict[str, Decimal] = {}
    er: dict[str, Decimal] = {}

    # --- FICA (gross-based; per-period rounding; SS wage-base aware) ---
    ss_room = max(Decimal("0"), Decimal(T.SS_WAGE_BASE) - e.ytd_ss_wages)
    ss_wages = min(e.gross, ss_room)
    lines["ss"] = cents(ss_wages * Decimal(str(T.SS_RATE)))
    er["ss"] = lines["ss"]
    lines["medicare"] = cents(e.gross * Decimal(str(T.MEDICARE_RATE)))
    er["medicare"] = lines["medicare"]
    # (Additional Medicare over $200k YTD — none of the current roster is close.)

    # --- State employee statutory items (uncapped for this roster / period) ---
    if e.state == "NY":
        lines["ny_sdi"] = cents(Decimal(str(T.NY_SDI_WEEKLY)) * e.weeks)
        lines["ny_pfl"] = cents(e.gross * Decimal(str(T.NY_PFL_RATE)))
    elif e.state == "NJ":
        lines["nj_sdi"] = cents(e.gross * Decimal(str(T.NJ_TDI_EE_RATE)))
        lines["nj_ui"] = cents(e.gross * Decimal(str(T.NJ_UI_EE_RATE)))
        lines["nj_wf"] = cents(e.gross * Decimal(str(T.NJ_WF_EE_RATE)))

    # --- Income taxes (need percentage-method tables + W-4) — TODO next phase ---
    taxable = e.gross - e.pretax_401k  # income-tax wages (401k reduces these)
    lines["fed"] = _fed_income_tax(taxable, e)          # -> None for now
    if e.state == "NY":
        lines["ny_inc"] = _ny_income_tax(taxable, e)    # -> None
        if e.nyc_resident:
            lines["nyc"] = _nyc_income_tax(taxable, e)  # -> None
    elif e.state == "NJ":
        lines["nj_inc"] = _nj_income_tax(taxable, e)    # -> None

    # --- Employer experience-rated UI/SDI + FUTA — need YTD + company rates ---
    # (left out of `er` until company rate notices + YTD ledger are wired)

    # Net is only computable once income taxes exist.
    net = None
    if all(lines.get(k) is not None for k in lines):
        withheld = sum((v for v in lines.values() if v is not None), Decimal("0"))
        net = cents(e.gross - e.pretax_401k - withheld)

    return EmployeeResult(
        name=e.name, gross=e.gross,
        lines={k: v for k, v in lines.items()},
        employer=er, pretax_401k=e.pretax_401k, net=net,
    )


# --- Federal income tax: Pub 15-T (2026) Worksheet 1A percentage method ---
def _fed_income_tax(taxable_period: Decimal, e: EmployeeInput):
    """taxable_period = gross - pre-tax deductions (401k etc.) for this period."""
    if not T.FED_PERCENTAGE_METHOD:
        return None
    w = e.w4
    status = w.get("filing_status", "single")
    sched_key = status if status in ("single", "mfj", "hoh") else "single"  # mfs -> single schedule
    step2 = bool(w.get("step2", False))
    periods = int(w.get("periods", T.PAY_PERIODS.get("biweekly", 26)))
    dec = lambda k: Decimal(str(w.get(k, 0) or 0))

    annual = taxable_period * periods + dec("other_income_annual")            # 1e
    std = Decimal("0") if step2 else Decimal(str(T.FED_STD_ADJUST.get(status, 8600)))
    adj = annual - dec("deductions_annual") - std                            # 1i
    if adj < 0:
        adj = Decimal("0")

    sched = T.FED_PERCENTAGE_METHOD["checkbox" if step2 else "standard"][sched_key]
    base = pct = exceeds = 0
    for lower, b, p, ex in sched:
        if adj >= lower:
            base, pct, exceeds = b, p, ex
    annual_tentative = Decimal(str(base)) + Decimal(str(pct)) * (adj - Decimal(str(exceeds)))  # 2g
    annual_after = annual_tentative - dec("dependents_annual")               # Step 3 credit
    if annual_after < 0:
        annual_after = Decimal("0")
    per_period = annual_after / Decimal(periods) + dec("extra_per_period")    # Step 4
    return cents(per_period)


def _ny_income_tax(taxable_period: Decimal, e: EmployeeInput):
    """NY State, NYS-50-T-NYS Method II (biweekly). taxable_period = wages after 401k."""
    if not T.NY_WITHHOLDING:
        return None
    w = e.w4
    marital = w.get("ny_marital", "single")
    exempt = min(int(w.get("ny_exemptions", 0)), 10)
    allow = Decimal(str(T.NY_WITHHOLDING["allowance_biweekly"][marital][exempt]))
    net = taxable_period - allow
    if net <= 0:
        return Decimal("0.00")
    sched = T.NY_WITHHOLDING["schedule_biweekly"][marital]
    col3 = rate = add = 0
    for c3, r, a in sched:
        if net >= c3:
            col3, rate, add = c3, r, a
    wh = (net - Decimal(str(col3))) * Decimal(str(rate)) + Decimal(str(add))
    return cents(wh + Decimal(str(w.get("ny_extra_per_period", 0) or 0)))


def _nyc_income_tax(taxable_period: Decimal, e: EmployeeInput):
    """NYC resident tax, NYS-50-T-NYC Method II (biweekly)."""
    if not T.NYC_WITHHOLDING:
        return None
    w = e.w4
    marital = w.get("nyc_marital", w.get("ny_marital", "single"))
    exempt = min(int(w.get("nyc_exemptions", w.get("ny_exemptions", 0))), 10)
    allow = Decimal(str(T.NYC_WITHHOLDING["allowance_biweekly"][marital][exempt]))
    net = taxable_period - allow
    if net <= 0:
        return Decimal("0.00")
    sched = T.NYC_WITHHOLDING["schedule_biweekly"][marital]
    col3 = rate = add = 0
    for c3, r, a in sched:
        if net >= c3:
            col3, rate, add = c3, r, a
    return cents((net - Decimal(str(col3))) * Decimal(str(rate)) + Decimal(str(add)))


def _nj_income_tax(taxable_period: Decimal, e: EmployeeInput):
    """NJ, NJ-WT Rate Table A (biweekly). taxable = wages after 401k minus allowances."""
    if not T.NJ_WITHHOLDING:
        return None
    w = e.w4
    exempt = int(w.get("nj_exemptions", 0))
    net = taxable_period - Decimal(str(T.NJ_WITHHOLDING["allowance_biweekly"])) * exempt
    if net <= 0:
        return Decimal("0.00")
    sched = T.NJ_WITHHOLDING["rate_A_biweekly"]
    over = rate = add = 0
    for o, r, a in sched:
        if net >= o:
            over, rate, add = o, r, a
    wh = (net - Decimal(str(over))) * Decimal(str(rate)) + Decimal(str(add))
    return cents(wh + Decimal(str(w.get("nj_extra_per_period", 0) or 0)))


def company_totals(results: list[EmployeeResult]) -> dict[str, Decimal]:
    """Sum per-employee (already-rounded) line items into company totals."""
    totals: dict[str, Decimal] = {}
    for r in results:
        for k, v in r.lines.items():
            if v is not None:
                totals[k] = totals.get(k, Decimal("0")) + v
    totals["gross"] = sum((r.gross for r in results), Decimal("0"))
    totals["k401_ee"] = sum((r.pretax_401k for r in results), Decimal("0"))
    return totals
