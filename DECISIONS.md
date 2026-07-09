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
| D-004 | 🔒 | **Overhead is embedded in the loaded cost rate (~1.75× wrap) — OPEX is NOT subtracted separately.** OPEX is shown as reference only. | The cost rate already contains overhead; subtracting OPEX double-counts. | 2026-07-09 |
| D-005 | 🔒 | The **owner's labor is IN the direct-labor base** (his hours are costed at market). | Owner charges time direct; treated as labor, not a profit-taker. | 2026-07-09 |
| D-006 | 🔒 | **Daily revenue = billable hours × the entry's actual per-project bill rate.** Fall back to the person's standard invoiced rate only when the entry rate is missing or the stale flat **$125** default. | Bill rates vary by project; the per-entry rate is authoritative. | 2026-07-09 |
| D-007 | 🔒 | **Daily cost = all hours × `cost_rate_applied`** (loaded wrap). Non-billable time is costed but earns nothing (correctly drags the day). | Fully-loaded labor cost. | 2026-07-09 |
| D-008 | 🔒 | **Principal (owner) is billed at direct × 2.14** (labor + OH, **no profit markup**); **staff at direct × 2.354** (labor + OH + 10% profit). Bertrand standard = **$208.65** (97.50 × 2.14). | Matches the cost-plus invoice engine. | 2026-07-09 |

## B. Overhead & Rates

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-009 | 🔒 | The **114% overhead rate** in the billing config is the **client-offered minimum** — a legitimate contractual rate. It is **NOT** reconciled/trued-up to actual (~66%); these are **not cost-plus/reimbursable** contracts. | Owner: it's the offered minimum; the 114%-vs-66% gap is margin. | 2026-07-09 |
| D-010 | 🔒 | Actual overhead ≈ **66%** (owner-in-labor-base, first-order). The AqtPM `cost_rate` loads ~76% — a known slight over-cost; **left as-is** unless owner requests truing to 66%. | Directional; not yet trued. | 2026-07-09 |
| D-011 | 🔒 | **Billing direct rates (2026):** Zachary 52.26, Stacey 51.64, Robert 61.50, Bertrand 97.50, Ailsa 75.00, Roger 90.00, Guo 130.00. Mirrored from the invoice engine config. | Source of truth for `_invoice_bill_rate`. | 2026-07-09 |

## C. COGS & Payroll

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-012 | 🔒 | **COGS = employer cost** (gross wages + employer payroll taxes + employer 401(k) match) from the Gusto/Paychex journal **+ NYSIF benefits + categorized direct-project costs.** | Consulting: fully-loaded labor is COGS. | 2026-06 |
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

## F. Timesheet Module (FreshBooks replacement)

| ID | 🔒 | Decision | Rationale | Settled |
|---|---|---|---|---|
| D-022 | 🔒 | **Weeks are Monday-anchored** everywhere (`week_start = Monday`). | One consistent week helper. | 2026-07 |
| D-023 | 🔒 | The **employee/"viewing" picker is admin-only**; employees only ever see/enter their own timesheet. | Privacy / least privilege. | 2026-07-05 |
| D-024 | 🔒 | Submit alert to approvers = **in-app dashboard popup** (SMTP is off in prod), not email. Approvers = Bertrand + Ailsa (admin role). | Email unreliable; in-app is the live path. | 2026-07-05 |
| D-025 | 🔒 | Entry UI mirrors **FreshBooks Day / Week / Month / All** views; Week = grid (rows × days), per-day multi-item with own notes. | Usability parity to cut FB. | 2026-07-05 |
| D-028 | 🔒 | **Aquatech Operations internal categories are GENERIC only:** Administration, Business Development, Accounting, Advertising, Training. The specific client/pursuit/project goes in the entry **NOTE**, never as a category/task name (no "BD — Kensico" style tasks). | Fewer clean categories; detail lives in notes. | 2026-07-09 |
| D-027 | 🔒 | **Overhead/internal projects (e.g. Aquatech Operations) ARE selectable in the timesheet entry pickers** (Day/Week/Month + grid) so non-billable admin / BD / training / PTO time is loggable. They remain **excluded** from the dashboard "active projects" count and from invoicing (billable only). | A complete timesheet needs internal time too. | 2026-07-09 |
| D-026 | 🔒 | **Aquatech-sourced time SUPERSEDES FreshBooks-sourced time.** When both exist (or Aquatech time is loaded later) for the same **(employee, work date, project)**, the FreshBooks copy is **removed** and Aquatech's is kept. Enforced on every FB sync AND whenever Aquatech time is created/edited. | FB has no subtasks and **truncates revenue decimals** (invoices off by cents); Aquatech time is more precise and is the system of record for the transition. | 2026-07-09 |

---

## Change Log
*(Every approved change to a 🔒 Locked decision is recorded here: date · decision · what changed · approved by.)*

- 2026-07-09 — Register created; seeded with D-001…D-025 from the 2026-07 financial-accuracy work. Approved by: Bertrand (owner).

---
*Maintained by Claude on Bertrand's instruction (2026-07-09). Nothing here changes without his express approval.*
