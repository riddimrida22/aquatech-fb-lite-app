# AqtPM — Settled Decisions Register

**Purpose.** This is the single source of truth for decisions about the app that are
**settled**. A settled (🔒 Locked) decision is **never changed, reverted, or implemented
differently without Bertrand's express approval.** This exists so the owner does not have
to re-check that already-decided behavior hasn't silently drifted.

## The rule (non-negotiable)
1. **Before** implementing or changing anything, check this register.
2. If a task would change, revert, or contradict a 🔒 Locked decision — **STOP**, flag it
   as *"⚠️ This touches settled decision D-NNN — approve before I proceed?"*, and **wait for
   an explicit yes.** Do not proceed on assumption.
3. When a new decision is settled, **append it here** (new D-NNN) in the same commit/turn.
4. Any approved change to a locked decision → update the entry **and** add a dated row to
   the Change Log at the bottom (who approved, when, what changed). Never edit silently.
5. This file is version-controlled — `git log DECISIONS.md` / `git blame` is the audit
   trail. An unapproved change to a locked item is a QA/QC failure and must be reverted.

Status legend: **🔒 Locked** (settled — approval required to change) · **🟡 Proposed**
(suggested, not yet approved) · **⚪ Superseded** (replaced; kept for history).

---

## A. Daily Profitability KPI

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-001 | 🔒 | The KPI is **earned-value (accrual)** — value produced vs cost on the day, not cash collected. | Management "are we above water per day" read. | 2026-07-09 |
| D-002 | 🔒 | Overhead averaging denominator = **working (business) days**; lookback = **trailing 6 complete months** (3/6/12 selector in UI). | Fair to billable margin; smooths lumpy months. | 2026-07-09 |
| D-003 | 🔒 | **Owner reasonable comp is NOT added to overhead.** | Owner's time is already costed in the margin via `cost_rate`; adding comp double-counts. | 2026-07-09 |
| D-004 | 🔒 | **Overhead is embedded in the loaded cost rate — OPEX is NOT subtracted separately.** OPEX is shown as reference only. **[AMENDED 2026-07-10 → D-030]** the loading is no longer a fixed ~1.75× guess; it is a **derived overhead rate** computed from actual trailing financials. | The cost rate already contains overhead; subtracting OPEX double-counts. | 2026-07-09 (amended 2026-07-10) |
| D-005 | 🔒 | The **owner's labor is IN the direct-labor base** (his hours are costed at market). | Owner charges time direct; treated as labor, not a profit-taker. | 2026-07-09 |
| D-006 | 🔒 | **Daily revenue = billable hours × the entry's actual per-project bill rate.** Fall back to the person's standard invoiced rate only when the entry rate is missing or the stale flat **$125** default. | Bill rates vary by project; the per-entry rate is authoritative. | 2026-07-09 |
| D-007 | 🔒 | **[SUPERSEDED 2026-07-10 by D-030]** ~~Daily cost = all hours × `cost_rate_applied`~~. **Now: daily cost = CLIENT (direct) hours × derived loaded rate; overhead-project hours cost $0** (their cost is inside the overhead pool → costing them again double-counts). Identity: Σ client_h × loaded = direct labor + overhead pool = total cost. | Absorption model; overhead counted exactly once. | 2026-07-09 (superseded 2026-07-10) |
| D-008 | 🔒 | **Principal (owner) is billed at direct × 2.14** (labor + OH, **no profit markup**); **staff at direct × 2.354** (labor + OH + 10% profit). Bertrand standard = **$208.65** (97.50 × 2.14). | Matches the cost-plus invoice engine. | 2026-07-09 |

## B. Overhead & Rates

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-009 | 🔒 | The **114% overhead rate** in the billing config is the **client-offered minimum** — a legitimate contractual rate. It is **NOT** reconciled/trued-up to actual (~66%); these are **not cost-plus/reimbursable** contracts. | Owner: it's the offered minimum; the 114%-vs-66% gap is margin. | 2026-07-09 |
| D-010 | 🔒 | **[SUPERSEDED 2026-07-10 by D-030]** ~~Actual overhead ≈ 66%; cost_rate loads ~76%, left as-is.~~ **Now measured from actuals: overhead rate ≈ 40.4%** (reasonable-comp direct-labor base, FY2025), **derived not assumed.** | Trued to actuals via D-030 engine. | 2026-07-09 (superseded 2026-07-10) |
| D-011 | 🔒 | **Billing direct rates (2026):** Zachary 52.26, Stacey 51.64, Robert 61.50, Bertrand 97.50, Ailsa 75.00, Roger 90.00, Guo 130.00. Mirrored from the invoice engine config. | Source of truth for `_invoice_bill_rate`. | 2026-07-09 |

## C. COGS & Payroll

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-012 | 🔒 | **COGS = employer cost** (gross wages + employer payroll taxes + employer 401(k) match) from the Gusto/Paychex journal **+ NYSIF benefits + categorized direct-project costs.** **[AMENDED 2026-07-10 → D-031]** payroll is now **split by hours**: only the **billable (client-project) share = COGS Labor**; the **overhead-project share = Non-Billable labor**, reclassified to overhead below gross profit. | Consulting: only DIRECT labor is COGS; indirect labor is overhead. | 2026-06 (amended 2026-07-10) |
| D-013 | 🔒 | Paychex **"PDF Reports" are per-period** — **ADD** each new report to the inbox; do NOT replace/remove prior ones (each is one distinct pay period). De-dup is by period key. | Avoids losing periods; parser de-dups. | 2026-07-09 |
| D-014 | 🔒 | **Plaid `pending` transactions are excluded** from all accounting (P&L OPEX + benefits). | Pending + posted twins double-count. | 2026-07-09 |
| D-015 | 🔒 | **NYSIF** (workers-comp + disability) is the only benefit in COGS. **Nu Era** = discontinued 2026 ($0). **Human Interest** = 401(k) recordkeeping fee → **OPEX/G&A**, not COGS-benefits. | Correct benefit classification. | 2026-07-09 |

## D. Expense Categorization

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-016 | 🔒 | **Autodesk** charges → **OPEX / Software & Subscriptions** (not a client reimbursable / not COGS). | Client didn't pay; it's the firm's license. | 2026-07-09 |
| D-017 | 🔒 | **Regus** charges → single **Rent** category (not split across Rent / Rent & Utilities / GENERAL_SERVICES). | One vendor, one line. | 2026-07-09 |
| D-018 | 🔒 | **ActBlue** (political contribution) → **personal**, out of the business books. | Not a business expense. | 2026-07-09 |
| D-019 | 🔒 | **Overseas travel/expenses = 50/50 personal / business-development.** | Owner rule for overseas trips. | 2026-07-09 |
| D-020 | 🔒 | To remove a personal charge from business OPEX, set category to an **OTHER-section label** (Owner Draw / Transfer / Loan Payment). `is_business=False` **alone is insufficient** for travel/hardware charges (auto-promoted back by keyword). | Mechanism note — prevents re-promotion. | 2026-07-09 |

## E. Owner Compensation (P&L, separate from the daily KPI)

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-021 | 🔒 | Owner **reasonable W-2 comp = $206,398.40/yr**, used only by the P&L **"after salary"** toggle (owner takes distributions, not salary). This is **separate from** the daily KPI, which does not add owner comp (see D-003). | S-corp reasonable-comp basis. | 2026-06 |

## G. Derived Overhead Rate (cost side of the daily P/L)

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-031 | 🔒 | **Period labor cost is split into COGS Labor vs Non-Billable.** Each person's ACTUAL payroll (employer cost from the Gusto/Paychex journal) is allocated by their **billable-vs-overhead hour ratio** in the period. **COGS Labor** (billable/client-project share) stays in COGS; **Non-Billable labor** (admin/BD/PTO/overhead-project share) is reclassified to **overhead** below gross profit. Reconciles exactly to total payroll. Name-matching restricts to users who logged hours (avoids stale duplicate user records) and requires first+last match. FY2025: COGS Labor $216,705, Non-Billable $6,566. | Gross margin should reflect DIRECT labor only; indirect labor is overhead. | 2026-07-10 |
| D-030 | 🔒 | **The overhead rate is DERIVED from actual trailing-12-month financials, not a fixed multiplier.** Build-up: **Direct labor** = reasonable-comp salary (D-021 basis, e.g. Bertrand $99.23/h) × **client-project** hours × (1 + fringe). **Overhead pool** = indirect labor (admin/BD/PTO/overhead-project hours × reasonable comp × (1+fringe)) **+ all non-labor OPEX** (rent, travel, software, insurance, …). **Overhead rate = pool ÷ direct labor.** **Loaded cost rate** per person = `reasonable_salary × (1+fringe%) × (1+OH%)`. **Billing floor** = loaded × (1+profit 10%). Daily P/L costs **client hours × loaded rate; overhead hours cost $0** (recovered via the rate — counted once). Engine: `GET /accounting/overhead-rate`. FY2025: fringe 12.6%, **OH rate 40.4%**. | Owner: "the OH rate must be the entire non-labor cost pool allocated intelligently to each employee's rate, so we know the true cost to run the business." Owner costed at reasonable comp so cost isn't understated by distributions. | 2026-07-10 |

## F. Timesheet Module (FreshBooks replacement)

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-022 | 🔒 | **Weeks are Monday-anchored** everywhere (`week_start = Monday`). | One consistent week helper. | 2026-07 |
| D-023 | 🔒 | The **employee/"viewing" picker is admin-only**; employees only ever see/enter their own timesheet. | Privacy / least privilege. | 2026-07-05 |
| D-024 | 🔒 | Submit alert to approvers = **in-app dashboard popup** (SMTP is off in prod), not email. Approvers = Bertrand + Ailsa (admin role). | Email unreliable; in-app is the live path. | 2026-07-05 |
| D-025 | 🔒 | Entry UI mirrors **FreshBooks Day / Week / Month / All** views; Week = grid (rows × days), per-day multi-item with own notes. | Usability parity to cut FB. | 2026-07-05 |
| D-029 | 🔒 | **FreshBooks hours are quarantined during cut-over.** NEW FB-imported time routes to a hidden per-project **`FB-TRANS`** ("FreshBooks transitional") subtask — never into real work subtasks (e.g. DWF-MODEL/REG-CAP). `FB-TRANS` is hidden from the employee entry pickers. Existing/historical FB time and any manual re-categorization are **preserved on re-sync** (subtask not re-routed when the project is unchanged). A read-only **"FreshBooks hours"** admin panel shows the transitional FB time; it retires automatically at cut-over. Employees log via the AQT app (supersedes FB — D-026). | Keep real subtasks clean; FB time visible but segregated until exit. | 2026-07-09 |
| D-028 | 🔒 | **Aquatech Operations internal categories are GENERIC only:** Administration, Business Development, Accounting, Advertising, Training. The specific client/pursuit/project goes in the entry **NOTE**, never as a category/task name (no "BD — Kensico" style tasks). | Fewer clean categories; detail lives in notes. | 2026-07-09 |
| D-027 | 🔒 | **Overhead/internal projects (e.g. Aquatech Operations) ARE selectable in the timesheet entry pickers** (Day/Week/Month + grid) so non-billable admin / BD / training / PTO time is loggable. They remain **excluded** from the dashboard "active projects" count and from invoicing (billable only). | A complete timesheet needs internal time too. | 2026-07-09 |
| D-026 | 🔒 | **Aquatech-sourced time SUPERSEDES FreshBooks-sourced time.** When both exist (or Aquatech time is loaded later) for the same **(employee, work date, project)**, the FreshBooks copy is **removed** and Aquatech's is kept. Enforced on every FB sync AND whenever Aquatech time is created/edited. | FB has no subtasks and **truncates revenue decimals** (invoices off by cents); Aquatech time is more precise and is the system of record for the transition. | 2026-07-09 |

---

## Change Log
*(Every approved change to a 🔒 Locked decision is recorded here: date · decision · what changed · approved by.)*

- 2026-07-09 — Register created; seeded with D-001…D-025 from the 2026-07 financial-accuracy work. Approved by: Bertrand (owner).
- 2026-07-10 — **Added D-031 (COGS Labor vs Non-Billable split).** Amended **D-012**: payroll split by billable/overhead hours; only billable share is COGS, overhead share moves below gross profit. Total cost & net income unchanged; gross margin now reflects direct labor only. Approved by: Bertrand — "break it out to COGS Labor vs Non-Billable cost."
- 2026-07-10 — **Added D-030 (derived overhead rate).** Amended **D-004** (loading is now derived, not a fixed ~1.75× guess); **superseded D-007** (daily cost is now client-hours × derived loaded rate, overhead hours cost $0, vs all-hours × stored rate); **superseded D-010** (overhead measured at ~40.4% from actuals, vs the earlier ~66% assumption). Owner labor costed at reasonable comp (D-021 basis) for the daily P/L cost side. Approved by: Bertrand (owner) — "yes and yes" to reasonable-comp basis + completing the overhead pool. | Note: D-003 (owner comp not *added on top*) still holds — the owner is costed inside the rate, not double-added.

---
*Maintained by Claude on Bertrand's instruction (2026-07-09). Nothing here changes without his express approval.*
