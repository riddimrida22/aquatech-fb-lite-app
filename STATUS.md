# AquatechPM — Pilot Plan + Handoff

**Last updated:** 2026-05-02 (planning + Day 1 build)
**Project root:** `C:\Users\bertr\Organized\Curated\Projects_Master\AquatechPM\code\AquatechPM\`

---

## Goal

Replace FreshBooks for ~6 staff with a self-hosted internal app. Get a usable **pilot live next Monday**, then expand week-by-week as gaps surface.

## Pilot scope (2 days of work)

Three things staff can do Monday:
1. **Log hours in a weekly grid** and submit for approval
2. **Owner approves or rejects** with a comment
3. **Import client + project list** from a FreshBooks CSV export so dropdowns aren't empty

Everything else (invoicing, expenses, PDFs, email, project detail pages, charts) is deferred. Reuse the existing custom CSS (`--aq-*` system); skip Tailwind/shadcn for now — that's a cosmetic upgrade we can do later once flows are stable.

---

## Day 1 — Timesheet + approval

**AM — Weekly timesheet grid (~3 hr after fixing build)**
- New route `/time/week`
- 7-column grid Mon→Sun
- Rows = project/task lines (Add row button: pick project → pick task)
- Cells = inline-editable hours (0.25 step)
- Bottom totals row (daily totals); right column (project totals)
- Top: week selector (prev/next arrows, "this week" jump, week-of date label)
- Status badge: Draft / Submitted / Approved / Rejected
- "Submit for approval" button — locks the week from edits
- If rejected, comment shown + can edit again

Backend endpoints already exist for timesheet generate/submit. Frontend just needs the grid UI on top.

**PM — Approval queue (~2 hr)**
- New route `/approvals`
- List of submitted timesheets: name, week-of, total hours, billable hours, submitted-on
- Click → read-only week view with all entries visible
- "Approve" button (1 click) and "Reject" button (requires comment)
- Comment is sent back to submitter and attached to the timesheet

## Day 2 — FB import + polish

**AM — FB importer (essentials only, ~3 hr)**
- New route `/imports`
- Two dropzones in v1:
  - **Clients CSV** (FreshBooks export of client list)
  - **Projects CSV** (FreshBooks export of project list)
- For each: drop file → preview first 10 rows + column mapping (sensible defaults from `handoff-docs/CSV_Import_Mapping.md`) + dedupe count + validation errors → "Import" button
- Show import history at bottom (what was imported when, row count)

Backend already has CSV import endpoints; frontend just needs the dropzone UI. The previously-deleted `FreshbooksCsvImportPanel.tsx` (recovered from git history) is a starting point but needs polish.

**PM — Polish + smoke test**
- Wire up sidebar nav: My Time / Approvals (admin) / Projects / Imports / People & Rates
- Fix any build breaks from the half-finished frontend refactor (untracked workspace stubs)
- Run `./scripts/smoke_test.sh`
- Deploy via existing `./scripts/deploy_push_ssh.sh .env.deploy`

---

## Expansion roadmap (1 day per slice, prioritize by what you miss in actual use)

| # | Slice | Why |
|---|---|---|
| A | Time entries import (historical) | Backfill staff hour history from FB |
| B | Invoices + payments import | AR ledger reflects FB history |
| C | "Create invoice from approved time" | First step of stopping FB invoicing |
| D | Project detail page (tabs: Overview / WBS / Team / Time / Invoices / Settings) | Real project mgmt, not just a list |
| E | Expense tracking (form + list + mark billable + add-to-invoice) | Stop using FB for expenses |
| F | PDF invoices (WeasyPrint, Aquatech-branded template) | Send invoices, not just track them |
| G | Email send + auto-reminders for overdue | Replace FB invoice delivery |
| H | Tailwind + shadcn migration | Visual polish, only after flows are stable |

Each slice is independent. Pick order based on biggest pain point that week.

---

## Open questions (waiting on user)

1. **Sample FreshBooks CSV export** — drop one or two CSVs in `Downloads/freshbooks_sample/` (clients list is the most useful first). Without an actual sample, I'm guessing at column names. With one, the importer fits FB schema exactly.
2. **Billing model** — bill by task or by project in FB today? Affects how the WBS importer maps line items.
3. **Client records** — in FB, are clients just names or do they have addresses/emails/contacts? (Affects what the Clients import does)
4. **Sidebar order** — does the order above (My Time / Approvals / Projects / Imports / People) match your preference? Or do you want Projects first since you spend most time there?

These don't block tomorrow's start — I can answer 1–4 with reasonable defaults and you can correct mid-build.

---

## Discovery findings (what I already know)

**Stack:**
- Backend: FastAPI Python, single 7,897-line `backend/app/main.py` (monolithic but functional)
- Frontend: Next.js 14 App Router, hand-rolled CSS, no UI library
- DB: Postgres 16 (or SQLite fallback)
- Deploy: Docker Compose + Caddy + GitHub Actions

**Healthy parts (don't touch):**
- 95 backend API endpoints — comprehensive
- Backend tests exist (`test_financial_flows.py`, `test_mvp.py`)
- RBAC server-enforced
- Enterprise-grade ops scripts (smoke, dr_restore, observability)
- GitHub Actions CI/CD with staged deploys + rollback

**Broken parts to address in pilot:**
- **Frontend mid-refactor** — `frontend/app/page.tsx` shrunk from 10k+ to 1,347 lines; new workspace stubs (TimeWorkspace, TimesheetsWorkspace, ProjectWorkspace) are minimal shells; build may not currently work. Day 2 PM polish addresses this.
- **`FreshbooksCsvImportPanel.tsx` was deleted** in the recent refactor — found in git history, will recover + polish in Day 2 AM.
- **Database file inflated 25x** uncommitted — gitignore + clean up at end.

**Won't fix in pilot (tracked for later):**
- Monolithic 7,897-line `main.py` (tech debt; refactor to modules later)
- README-stated gaps: invoice PDF generation, month-close export, recurring invoice scheduler resilience, ACH/card in-app payments
- Hardcoded `FRESHBOOKS_TRANSITION_DIR` Windows WSL path in `backend/app/settings.py:36`

---

## Tomorrow's first steps

1. `cd` to project, `git status`, decide whether to commit, stash, or revert the half-finished refactor changes
2. Spin up dev server (`./Start_AquatechPM_App.bat` or `docker compose up`)
3. Confirm app boots; if not, fix imports in `frontend/app/page.tsx` to match the workspace components that exist
4. Start Day 1 AM: weekly timesheet grid

---

## Progress on 2026-05-02 — Day 1 build COMPLETE

### Done today

1. **Built `frontend/app/components/WeeklyTimeEntry.tsx`** (~365 lines).
   - 7-column spreadsheet grid (Mon–Sun) with inline-editable hour cells
   - Prev/This/Next week navigation
   - "Add line" workflow (Project → Task → Subtask cascading pickers, then row appears)
   - Daily totals along the bottom + per-row totals on the right + week total
   - Save button compares grid state to original entries, performs minimal POST/PUT/DELETE on `/time-entries`
   - "×" button per row to clear that line
   - Auto-disables Save when nothing has changed; shows summary after save (`3 created, 2 updated, 1 cleared`)

2. **Replaced `TimeWorkspace` render with `WeeklyTimeEntry`** in `page.tsx` (under the existing "Time" tab — same nav position, transformed UX).

3. **Added new top-level "Imports" nav item** between Reports and Settings — surfaces the existing `TransitionInboxPanel` (which was previously buried under Settings).

4. **Added `FRESHBOOKS_TRANSITION_DIR` to `.env`** pointing at `C:/Users/bertr/Organized/Curated/Projects_Master/AquatechPM/data/imports/AqtPM-Uploads` (where the user has organized their FB exports). Backend was previously looking at the wrong path.

5. **TypeScript build passes clean** (`tsc --noEmit` exit 0). Approval flow already exists in `TimesheetsWorkspace.tsx` (submit/approve/return per timesheet, with status filter) — left unchanged for now.

### What user can test once the app is running
- Click **Time** tab → see the new weekly grid in place of the old single-entry form
- Click **Imports** tab → see the FB inbox (should now show files from `data/imports/AqtPM-Uploads`)
- Click **Timesheets** tab → existing flow works (generate this week, submit, admin approve/return)

### Files touched
- NEW `frontend/app/components/WeeklyTimeEntry.tsx`
- MODIFIED `frontend/app/page.tsx` (3 small edits: import, nav, render)
- MODIFIED `.env` (added FRESHBOOKS_TRANSITION_DIR)
- MODIFIED `STATUS.md` (this file)

### What's next (in priority order)

1. **Smoke test the running app** — start backend + frontend, walk through Time tab + Imports tab to verify behavior matches expectations. Fix any small UX nits surfaced.
2. **Approval reject comments** — `TimesheetsWorkspace` "Return" button currently has no comment field. Add a prompt that captures a reason and posts it with the return.
3. **FB import follow-through** — once user clicks "Import recommended files" in the Imports tab, verify that clients + projects appear in the AquatechPM Clients/Projects tabs. The backend may not auto-create projects from time_entry_details rows; if not, add that step.
4. **Project management UX** — slice D from earlier roadmap. Click project → detail page with Overview / WBS / Time / Invoices tabs. Inline WBS edit. (~1 day)
5. **Visual polish later** — Tailwind/shadcn migration deferred to slice H once flows are stable.

---

## 2026-05-02 — Phase A-E delivery (UX overhaul)

After the Day 1 weekly grid, user gave full implementation permission. Shipped the following bundle:

### Phase A — Status badges + toast styles
- Added 4 new badge variants (`aq-lite-badge-bad/info/neutral/mute`) + toast banner CSS in `globals.css`
- New `frontend/app/components/StatusBadge.tsx` — semantic badge component that maps status strings (draft, sent, paid, overdue, submitted, approved, rejected, etc.) to colored pills
- Applied to: Invoices table, TimesheetsWorkspace personal table, TimesheetsWorkspace admin queue
- Project status retains original badge for now (only active/inactive distinction)

### Phase B — Self-fetching weekly grid
- `WeeklyTimeEntry.tsx` now fetches `/time-entries?start=...&end=...` whenever the visible week changes
- Old behavior: pre-filtered from the parent's monthly state — empty for older/future weeks
- New behavior: always shows correct entries for any week, including 2023-2024 once historical data is imported
- Refetches after save so cell IDs update without a full parent reload
- Shows "loading…" indicator in eyebrow while fetching

### Phase C — Reject-with-comment on timesheet return
- Backend: `POST /timesheets/{id}/return?note=...` now accepts an optional note (2000 char max), persists to audit log payload
- Frontend: `handleAdminReturnTimesheet` prompts manager via `window.prompt()` for a reason before submitting; cancel aborts; reason shows in success toast
- Audit trail: every return event now records who, when, and why

### Phase D — AR Aging widget on Dashboard
- New `frontend/app/components/ARAgingPanel.tsx` — computes per-client aging buckets (Current / 1-30 / 31-60 / 61-90 / 91+) from open invoices' `due_date` + `balance_due`
- Shows top 10 clients by total outstanding, plus grand totals
- Highlights overdue cells in red
- Skips voided/cancelled invoices, only sums positive balances
- Wired into Dashboard view between the existing "Receivables" panel and the "Performance" panel
- Empty state nudges user to the Imports tab if no invoices loaded

### Phase E — Global error / success toast
- New `frontend/app/components/Toast.tsx` — non-blocking toast (top-right) with auto-dismiss (8s for errors, 3.5s for success), manual close button, ARIA live region for screen readers
- Wired into page.tsx — replaces the silent `setError`/`setFlash` pattern. Existing inline banners kept as a fallback for now (can be removed later)

### Backend bug fixed
- `_freshbooks_inbox_preference_score` had hardcoded date ranges (`2024-01-01 - 2026-04-17` got score=3, anything else 0). The user's freshly-downloaded `2023-01-01 - 2026-05-02` invoice export would have lost dedupe to the older one. Replaced with regex parser that scores by actual date-range span — wider always wins. Future-proofs every refresh.

### FB data refreshed in inbox
Copied 4 newer FB exports from Downloads into `data/imports/AqtPM-Uploads/` (replacing older versions):
- `FreshBooks - Invoices Export - 2023-01-01 - 2026-05-02.csv` (3,662 rows; 3 years of line-item history)
- `time_entry_details.csv` (now 2,935 rows, was 634 — multi-user historical time)
- `payments_collected.csv` (refreshed)
- `accounts_aging.csv` (as of 2026-05-02; $221,860 outstanding HDR/Woodard/StantecJV)

### Files created today
- NEW `frontend/app/components/WeeklyTimeEntry.tsx` (~395 lines)
- NEW `frontend/app/components/StatusBadge.tsx`
- NEW `frontend/app/components/Toast.tsx`
- NEW `frontend/app/components/ARAgingPanel.tsx`

### Files modified today
- `frontend/app/page.tsx` — 6 surgical edits (imports, nav, render swaps, Toast, ARAgingPanel placement, reject prompt)
- `frontend/app/globals.css` — added badge variants + toast styles + AR aging grid + inline-edit primitives
- `frontend/app/components/TimesheetsWorkspace.tsx` — StatusBadge for status cells
- `backend/app/main.py` — preference scoring fix + return-with-note endpoint
- `.env` — added FRESHBOOKS_TRANSITION_DIR
- `data/imports/AqtPM-Uploads/` — 4 fresh CSVs

### Build state
- TypeScript: `tsc --noEmit` exits 0
- Python: `ast.parse(main.py)` OK
- No DB schema changes; no migrations required

### To smoke test (user side)

1. **Start app**: `Start_AquatechPM_App.bat` (Docker) or native uvicorn + `npm run dev`
2. **Sign in** (Google OAuth or DEV_AUTH_BYPASS=true bootstrap)
3. **Dashboard** — should now show the AR Aging panel between Receivables and Performance. Will be empty until invoices are imported; that's expected, tells you to use Imports tab
4. **Imports tab** (new top-level nav item) — click "Rescan inbox" → fresh 2023-2026 invoice file should be marked "recommended" (this validates the date-range scoring fix). Click "Import recommended files" — watch step results
5. **Time tab** — weekly grid; navigate weeks with prev/next; older weeks should now load correctly (Phase B)
6. **Timesheets tab** — "Return" button on a submitted sheet now prompts for a reason; status cells show colored badges
7. **Trigger an error** (e.g., let a save fail) — should pop the new toast in the top-right corner

### What's queued (not done yet)

1. **Inline edit amounts** (Phase G — invoice line-item / project budget click-to-edit) — deferred; status-quo separate-edit-form still works
2. **Project detail page** with WBS tabs — biggest remaining UX gap
3. **Backfill historical time entries from FB** — backend endpoint exists (`POST /time-import/freshbooks`), needs UI surface or auto-trigger from transition import
4. **Tailwind/shadcn polish** — deferred until flows feel right

---

## 2026-05-02 PM — Browser-driven session (Claude in Chrome) + Expense_CAT integration

User granted full permission ("you have full permission, implement whatever you think will make the app intuitive and bug friendly"). Switched to Claude in Chrome MCP for live screen-driven debugging.

### Default operating mode going forward
**Open the app in Chrome** for any UX iteration. I drive the browser via MCP, see the screen, read console + network, fix what I find. The user requested this explicitly.

### Bugs fixed live in browser
1. **401 Not Authenticated** — frontend on `localhost:3000` couldn't send session cookies to backend on `127.0.0.1:8000` (cross-origin). Added `frontend/next.config.js` with rewrites so `/api/*` proxies to backend (same-origin). Auth works.
2. **Backend `.env` not loading** — pydantic-settings reads `.env` from CWD, but uvicorn was started from `backend/` so the project-root `.env` was ignored. Restarted with `FRESHBOOKS_TRANSITION_DIR` etc passed inline.
3. **FB import preference scoring** — backend hardcoded date range `2024-01-01 - 2026-04-17` scored 3, anything else 0. The fresh `2023-01-01 - 2026-05-02` invoice export would have lost dedupe. Replaced with regex parser scoring by actual date-range span.
4. **Invoice column names** — added `"Date Issued"` and `"Date Due"` to `INVOICE_ISSUE_DATE_COLUMNS`/`INVOICE_DUE_DATE_COLUMNS` (FB exports use those exact headers, weren't matched).
5. **Invoice status normalizer** — added `overdue / past due / late / viewed / opened / seen` mappings; was previously folding everything to `sent`.
6. **Invoice dates patched directly** — `backend/fix_invoice_dates.py` reads FB CSV, updates 58 invoices' issue_date/due_date in SQLite. AR Aging widget now shows real overdue numbers ($160,547 was previously $0).
7. **Invoice statuses patched** — `backend/fix_invoice_status.py` flipped 9 invoices to `overdue` based on FB Invoice Status column.
8. **Time grid was stuck on current month** — page.tsx loaded `time-entries` only for current month; Projects table showed 0 hours for all projects with historical work. Expanded to load 24 months by default.

### Live verification (Claude in Chrome screenshots)
- **Dashboard AR Aging panel** showing real overdue: HDR $121k, Woodard $88k, Stantec $12k. Overdue $160,547 in red.
- **Status badges colored correctly**: Paid green, Sent blue, Overdue red, Submitted blue, Approved green.
- **Time tab** weekly grid loads historical weeks (e.g., Apr 27 - May 3 with 40h across 3 lines).
- **Reject prompt** asks for a comment when admin returns a timesheet (Phase C live).

### Projects tab redesigned (the user said "project management sucks")
**Old:** flat 5-column read-only list with `$0` budgets.
**New:** 8-column metric-rich roster with click-to-expand inline detail panel.

**Columns added:** Hours · Revenue · Cost · Margin (color-coded vs target) · Open A/R.

**Inline expansion shows:** Performance summary (revenue/cost/expenses/margin vs target), Recent time entries (top 6 most recent for that project), Invoices for that project (count, status, balance).

Files: `frontend/app/components/ProjectWorkspace.tsx` extended with `ProjectInline` sub-component; `page.tsx` passes `projectPerformance`, `timeEntries`, `invoices`, `projectExpenses` props through.

### Expense_CAT integration (the "transfers in/out problem")
The user has a sophisticated **Expense_CAT** project at `Curated/Projects_Master/Expense_CAT/` with:
- Rule-based bank-transaction categorization
- 443 learned merchant overrides
- 3,006 categorized transactions (Chase 0273 + Chase 6611) through 2026-02-20
- Transfer rollforward, payroll/Zelle reconciliation, 401(k) split workpapers
- Today's status report (`reports/Expense_CAT_Project_Status_Report_2026-05-02.md`)

**The problem:** transfers between business 6611 ↔ personal 0273 net to ~$269k due-from-shareholder. Each transfer needs CPA classification (loan / distribution / contribution / reimbursement / payroll / contractor / personal). Currently undifferentiated.

**Decision (per user):** **identify transfers and park in a "Pending Adjudication" bucket — no tax decisions yet.**

### Done today
1. **Imported `categorized.csv` (3,006 rows) into AquatechPM** via `backend/import_expense_cat.py` (mirrors `/bank/import/expense-cat-categorized` endpoint, bypasses HTTP auth).
2. **Added `GET /bank/transfers/pending`** endpoint:
   - Filters bank txns by transfer-related keywords (transfer, owner, loan, due-to/from, shareholder, equity, investment)
   - Returns: total_count, rollforward_by_year_account, by_category aggregate, top-200 items list
3. **Built `frontend/app/components/TransfersPanel.tsx`** — wired into Costs tab as the first panel. Shows:
   - Big number "1,248 transactions awaiting classification"
   - Per-year rollforward table (year × txns × outflow × inflow × net × cumulative due-from)
   - Category filter pills (Equity Transfer, Internal Transfer, Investment Transfer, Loan Payment, Bank Transfers, Equity Draw, Shareholder Distribution, owners equity)
   - Top-100 transaction list with date, account, description, category badge, amount, IN/OUT direction
4. **Imported fresh FB Expenses Export** (`2024-01-01 - 2026-05-02.csv`, 1,533 rows from today). Result: +53 transfer-bucket txns detected, cumulative due-from shifted from −$267k to **−$202k** (the difference = ~$65k of "personal-paid-business credits" the FB ledger had that bank data alone missed).

### Cumulative numbers right now
- **Transfers awaiting CPA adjudication:** 1,248 transactions
- **Net due-from-shareholder:** $202,836 cumulative (2024: −$47k, 2025: −$74k, 2026: −$82k)
- **Top transfer buckets:** Equity Transfer 621/$1.16M abs · Internal Transfer 165/$431k · Investment Transfer 203/$291k · owners equity 60/$95k · Loan Payment 163/$56k

### Files added/changed today
- NEW `frontend/app/components/StatusBadge.tsx`
- NEW `frontend/app/components/Toast.tsx`
- NEW `frontend/app/components/ARAgingPanel.tsx`
- NEW `frontend/app/components/TransfersPanel.tsx`
- NEW `frontend/next.config.js` (Next.js /api proxy)
- NEW `backend/fix_invoice_dates.py` (one-shot date patch)
- NEW `backend/fix_invoice_status.py` (one-shot status patch)
- NEW `backend/import_expense_cat.py` (one-shot Expense_CAT bank-tx import bypassing HTTP)
- MODIFIED `frontend/app/page.tsx` (props plumbing, Toast, AR Aging + Transfers panels, 24-month time history, expanded headlineMetrics filtering)
- MODIFIED `frontend/app/components/ProjectWorkspace.tsx` (metric-rich rows + ProjectInline expand)
- MODIFIED `frontend/app/components/TimesheetsWorkspace.tsx` (StatusBadge usage)
- MODIFIED `frontend/app/globals.css` (status badge variants, toast, AR aging grid, inline-edit primitives)
- MODIFIED `backend/app/main.py` (`_freshbooks_inbox_preference_score` regex, `INVOICE_ISSUE_DATE_COLUMNS` / `INVOICE_DUE_DATE_COLUMNS`, `_normalize_invoice_status` overdue/viewed, `/bank/transfers/pending`)
- MODIFIED `data/imports/AqtPM-Uploads/` (added today's fresh FB Invoices/Expenses/payments/aging CSVs)

### Native dev environment notes
- **Docker Desktop has a boot bug** ("Inference manager" socket fails on Windows). Bypassed by running natively.
- Backend: `cd backend && DATABASE_URL=sqlite:///./aquatech.db DEV_AUTH_BYPASS=true SESSION_SECRET=... FRESHBOOKS_TRANSITION_DIR=... ../.venv_win/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- Frontend: `cd frontend && NEXT_PUBLIC_DEV_AUTH_BYPASS=true npm run dev`
- Sign-in: click "Enter AqtPM" → bootstraps admin session (Bertrand Byrne)
- Python venv `backend/.venv_win/` (Windows-flavored — the WSL `.env_py` doesn't work on Windows native)

### What's queued (priority order)
1. **Per-transfer classification UI** — column on the TransfersPanel transaction rows for marking each as Distribution / Contribution / Loan / Reimbursement / Payroll / Contractor / Personal. Persist on `BankTransaction.raw_json` so re-imports preserve it. Re-compute rollforward respecting classifications.
2. ~~Bank vs FB reconciliation view~~ — **DONE today (DedupPanel)**.
3. **Refresh Expense_CAT** — the categorized data ends 2026-02-20. Run Expense_CAT on the latest Chase exports (post Feb 20) to get current-month transfer flow.
4. **Fix the import-endpoint date bug** — properly. Currently using `fix_invoice_dates.py` as workaround.
5. **Project detail page** — bigger remaining UX gap.

---

## 2026-05-02 evening — bank vs FB deduplication

User raised the right concern: **"double-counting expenses in bank vs FB"**. Investigation confirmed the problem at scale:
- 6,243 BankTransaction rows total
- 3,026 from FB Expenses Export
- 3,006 from Chase (Expense_CAT)
- 211 from payroll summary CSVs
- 1,694 FB rows match Chase rows by date+amount = **$890k double-counted**

Plus a self-duplication problem: re-importing a refreshed FB Expenses CSV created NEW rows for entries already imported (because the FB import endpoint hashed `transaction_id` from `path.name + row_idx + ...`, so the same logical row from a renamed file gets a fresh ID).

### Fixed
1. **Stable FB transaction-id hash** — `_import_freshbooks_expenses_to_bank` no longer includes filename + row-index in hash. Now: `hash(date, amount, merchant, description)`. Re-imports of newer FB CSVs now UPDATE in place, no duplicates.
2. **Self-duplicate cleanup** — `backend/dedupe_fb_self.py` collapsed 1,537 rows where the same logical FB entry appeared twice. Bank table dropped from 6,243 → 4,706 rows.
3. **Backend `GET /bank/dedup/analysis`** — for each FB-source row, finds best matching Chase-source row by absolute amount + posted date (within ±3 days configurable). Returns matched pairs (duplicates), unmatched FB rows (likely personal-paid-business), counts, and totals.
4. **`DedupPanel` on Costs tab** (NEW component) — three colored stat cards (red: Duplicates to remove · orange: Unmatched FB / personal-paid? · green: Chase rows source-of-truth) + unmatched FB entry list (top 20 by amount) + collapsible "show matched examples" with FB / Chase descriptions side-by-side.

### Current numbers (clean)
- **FB-Expenses rows in DB:** 1,489 (was 3,026 before self-dedup)
- **Chase-source rows:** 3,006
- **Matched (true duplicates):** 887 pairs / **$464,895** double-counted
- **Unmatched FB:** 602 rows / **$418,203** — review these for personal-paid-business / FB-only adjustments
- Top unmatched FB merchants: Bertrand Byrne unpaid salary entries, Gusto rows, Bertrand loan repayment, Online Transfers

### Files added/changed in this segment
- NEW `frontend/app/components/DedupPanel.tsx` (~240 lines)
- NEW `backend/dedupe_fb_self.py` (one-shot cleanup script)
- MODIFIED `backend/app/main.py`:
  - Added `_bank_tx_source_file` + `_bank_tx_origin` helpers
  - Added `GET /bank/dedup/analysis` endpoint (~80 lines)
  - Fixed transaction_id hash in `_import_freshbooks_expenses_to_bank`
- MODIFIED `frontend/app/page.tsx` — DedupPanel rendered above TransfersPanel on Costs tab

### Open follow-ups
1. **Filter the bank category summary endpoints** to exclude matched FB rows by default. Right now the dashboard widgets still include both sides, inflating totals.
2. **Refresh Chase data** — user has new `Chase0273_Activity_20260502.CSV` and `Chase6611_Activity_20260502.CSV` in Downloads (1,504/1,502 rows, through 2026-05-01). Need to run Expense_CAT on these and import. The previous Chase data ends 2026-02-20.
3. **One-button "reconcile" workflow** — when both sides are loaded, single button to match, mark dupes, surface unmatched. Currently dedup is read-only diagnostic.

---

## 2026-05-02 (later) — Payroll portal + Gusto integration

### What user asked for (summarized)
1. Payroll portal — track payroll, **don't run it** (Gusto handles that). Important for properly **expensing** the charges.
2. For an engineering consulting business, **all employee costs are COGS** (employees are the product).
3. Gusto journal also includes government tax payments, employer 401(k) match, etc. — need to capture all of these on the COGS side.
4. **Time entry separation** — employees should access ONLY their own timesheet entry area, with project + task pickers from active projects, then submit. Admin sees all employees' timesheets.
5. **"Port actual company costs over to the expenses area"** — make the canonical Gusto payroll cost visible on Costs tab. Employee 401(k) deduction is NOT a company expense; only employer match + employer taxes + gross wages are.

### Done

#### Backend
1. **`_parse_gusto_payroll_journal(text)`** — handles the Gusto multi-section CSV format (header, Per Employee Summary, repeated Employee Earnings sections per pay period). Parses every column: gross, employer/employee taxes, 401(k) employee deduction, 401(k) employer match, net pay, check amount, employer cost.
2. **`GET /payroll/journal/summary`** — reads all `*payroll-summary*.csv` files in the inbox, parses each, returns:
   - `by_year` — period_count, employee_count, totals per year
   - `yearly_ytd` — totals per year
   - `all_employees` — lifetime + per-year per employee
   - `all_periods` — every pay period with per-employee rows
   - `grand_total` — across all years
   - `treatment_note` — explains the COGS treatment
3. **Time-entries endpoint already supports `user_id` query** with permission check (MANAGE_USERS or APPROVE_TIMESHEETS). No backend change needed for admin view-as.

#### Frontend
1. **`PayrollPortal.tsx`** (~280 lines) — full payroll workspace:
   - Hero: total Employer Cost = total payroll COGS, employee count, total hours
   - 4 KPI cards: Gross / Employer taxes / Employer 401(k) match / Total Employer Cost (COGS)
   - **By year** table with year filter pills and lifetime total footer
   - **By employee** table sorted by lifetime cost; click any row to expand year-by-year breakdown
   - **Pay periods** list, sorted newest first, filterable by year
2. **`PayrollExpenseSummary.tsx`** (~180 lines) — concise summary panel for the **Costs tab** that:
   - Surfaces the canonical Gusto-derived COGS at the top of the expenses area
   - Per-year breakdown of what IS company payroll expense (Gross / Employer taxes / 401(k) match / TOTAL)
   - Explicit "What is NOT a separate company expense" callout (employee 401k deduction, employee tax withholdings, net vs gross)
   - 3 KPI cards: Net cash to employees / Hours paid / Total Company COGS
3. **`page.tsx` — "payroll" workspace key + nav tab** between Costs and Reports. Renders `<PayrollPortal />` for that workspace.
4. **`page.tsx` — `<PayrollExpenseSummary />` rendered on Costs tab** above the Dedup panel — first thing the user sees.
5. **`WeeklyTimeEntry.tsx` admin view-as feature**:
   - New props: `staffOptions: StaffOption[]`, `isAdmin: boolean`
   - Admin-only banner with employee picker (orange tint when viewing another user, blue when self)
   - Time-entries fetch passes `?user_id=X` when admin views another employee
   - All editing controls (cell inputs, Add line, Save changes) disabled in admin read-only mode; Save button labeled "Read-only (admin view)"
   - Defaults to self for everyone — no behavior change for non-admins
6. **`page.tsx`** — added `staffList` state, fetches `/users` when admin, passes through `<WeeklyTimeEntry isAdmin={...} staffOptions={staffList...} />`.

### Numbers from real Gusto data (verified live in browser)
- **Lifetime Employer Cost across 2024-2026 YTD: $398,351** = COGS
- 2024: $117,838 (3 employees, 20 periods, 1,853 hours)
- 2025: $223,270 (5 employees, 27 periods, 3,285 hours)
- 2026 YTD: $57,242 (7 employees, 9 periods, 846 hours)
- Top employees by lifetime cost: Svadlenka $143k · Gilliam $126k · Bertrand Byrne $112k · Hodge $14k · Welch Gilliam $9k · Byrne Courtney $1.4k · Wang $0.1k

### Files added/changed
- NEW `frontend/app/components/PayrollPortal.tsx` — full payroll workspace UI (~280 lines)
- NEW `frontend/app/components/PayrollExpenseSummary.tsx` — concise Costs-tab summary (~180 lines)
- MODIFIED `backend/app/main.py` — `_parse_gusto_payroll_journal` + `GET /payroll/journal/summary`
- MODIFIED `frontend/app/page.tsx` — added "payroll" workspace key + nav, render PayrollPortal, render PayrollExpenseSummary on Costs, plumb staffList + isAdmin to WeeklyTimeEntry
- MODIFIED `frontend/app/components/WeeklyTimeEntry.tsx` — admin view-as employee feature with read-only mode
- MODIFIED `data/imports/AqtPM-Uploads/` — added today's fresh 2024/2025/2026 Gusto Payroll Journal CSVs

### What's still queued
1. **Filter bank-side payroll categories** to avoid double-counting against Gusto's authoritative number. Right now the bank category summary still includes "COGS-Payroll Wages" / "Cost of Goods Sold_Wages and Salaries" / "Payroll Taxes And Processing" rows — those should defer to Gusto for the authoritative payroll COGS total. Need a "Gusto sourced" flag or filter on bank txns matching Gusto pay periods.
2. **Auto-recategorize "Payroll Taxes And Processing" → COGS** — currently `expense_group = "OH"` (overhead) for some rows. For an engineering consulting business it's COGS.
3. **Refresh Chase + Expense_CAT** with the May 2 download (currently the bank data ends Feb 20).
4. **Per-transfer classification UI** for CPA review (still queued from earlier).

---

## 2026-05-02 (later) — Business credit card statements (Chase 0434, all-business)

User downloaded 3 Chase Business CC statement PDFs (card 0434) covering Feb 9 – Apr 22, 2026. **All charges are business; none are personal.**

### Done
1. **`backend/import_business_cc.py`** — pypdf-based parser:
   - Reads each statement, extracts Opening/Closing Date for year inference
   - Pulls every `MM/DD merchant amount` row using regex
   - Inverts statement sign (charge → negative outflow; CC payment → positive inflow) to match AquatechPM's bank convention
   - Stable hash-based `transaction_id` (date + amount + description) so re-imports update in place
   - Built-in heuristic categorizer for the merchants seen on this card:
     - **CC Payments** ("Payment Thank You-Mobile") → `Internal Transfer` / `Other`
     - **BIBERK INSURANCE / NYSIF** → `Cost of Goods Sold_Labor Insurance` / `COGS`
     - **FUNDBOX** → `Loan Payment` / `Other`
     - **OpenAI / Adobe / Autodesk / Alpaca / Google** → `Software & Subscriptions` / `OH`
     - **Regus** → `Office Rent` / `OH`
     - **FedEx / UPS / USPS** → `Shipping & Freight` / `OH`
     - **Media Markt / foreign-currency rows** → `Office Equipment` / `OH`
     - **FOREIGN TRANSACTION FEE** → `Bank Fees` / `OH`
     - **Amazon / Amzn** → `Office Supplies` / `OH`
2. **31 CC transactions imported** across the 3 statement periods. Net = -$9,926 (charges $24,715 minus payments-on-CC $14,789).

### CC category breakdown
| Category | Txns | $ abs |
|---|---|---|
| Internal Transfer (CC payments) | 4 | $14,789 |
| Loan Payment (FUNDBOX) | 2 | $12,395 |
| Software & Subscriptions (OpenAI/Adobe/Autodesk/Alpaca) | 9 | $7,001 |
| Office Rent (Regus) | 2 | $1,950 |
| Cost of Goods Sold_Labor Insurance (BIBERK/NYSIF) | 7 | $1,681 |
| Office Equipment (Media Markt foreign) | 1 | $311 |
| Shipping & Freight (FedEx) | 2 | $250 |
| Bank Fees (foreign txn fee) | 1 | $9 |

### How CC data shows up across the app
- **Costs tab** — bank category summary now folds CC rows into existing categories (e.g., Software & Subscriptions OH bucket gained 10 txns / $8,090; Loan Payment Other bucket has 2 txns / $12,395 from FUNDBOX)
- **DedupPanel** unaffected — CC source is "chase_cc_pdf", neither Chase-source-file nor FB-source-file, so it's not part of the FB↔Chase double-count check
- **TransfersPanel** — the 4 CC payment-receipts are correctly flagged as `Internal Transfer` and show up in the transfers bucket
- All marked `is_business = True` (no personal flag possible)

### Files added
- NEW `backend/import_business_cc.py` — one-shot parser + importer (~230 lines)
- pypdf added to backend venv (no impact on docker-compose since it's only used for one-shot scripts; can add to requirements.txt later)

### What's queued
1. ~~Filter bank-side payroll categories to defer to Gusto~~ — still queued
2. ~~Recategorize OH → COGS for payroll taxes~~ — still queued  
3. ~~Refresh Chase via Expense_CAT (May 2)~~ — still queued
4. **Match CC payments against bank-side outflows** — when the user pays the CC from Chase 6611, that transfer shows up TWICE: once in CC data as "Payment Thank You" (Internal Transfer +$X) and once in Chase 6611 as outflow to credit card. Need similar dedup logic to FB↔Chase. Not urgent because both sides are categorized as Transfer (excluded from tax summary), but matters for accurate cash flow accounting.

---

## Important files

| Path | What |
|---|---|
| `frontend/app/page.tsx` | Main shell (1,347 lines post-refactor) |
| `frontend/app/components/TimeWorkspace.tsx` | Single-entry time form (will be augmented with week grid) |
| `frontend/app/components/TimesheetsWorkspace.tsx` | Weekly submit/approval (needs UX overhaul) |
| `frontend/app/components/ProjectWorkspace.tsx` | Project list + new-project form (defer expansion to slice D) |
| `frontend/app/globals.css` | 903-line custom CSS — reuse for pilot |
| `backend/app/main.py` | All routes (7,897 lines, monolithic but works) |
| `handoff-docs/CSV_Import_Mapping.md` | Mapping logic reference for FB importer |
| `scripts/smoke_test.sh` | End-of-day test runner |
| `scripts/deploy_push_ssh.sh` | Deploy to prod after pilot is ready |

---

## Companion project (parallel)

NCB-Cal at `C:\Users\bertr\Downloads\ncb_cal\` — see its own `STATUS.md` for the FPE iter5 import-and-run plan. Independent project; will not affect AquatechPM work.
