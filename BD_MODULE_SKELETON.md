# AqtPM — Business Development Module · Build Skeleton

*Design skeleton for completing the BD / pursuit module in the main app. Grounded in
the existing code and in the real pursuit data on the shared drive.*

> **STATUS — COMPLETE (built 2026-09-11, in repo, not yet deployed).** All four phases
> below are implemented and verified end-to-end on a local instance seeded from the real
> shared-drive data (637 vault docs, 47 Book-of-Work pursuits, BD time, win/loss reviews):
> **Phase 1 Vault** · **Phase 2 Go/No-Go algorithm** · **Phase 3 BD time per pursuit** ·
> **Phase 4 assemble-for-RFP + win/loss reviews**. Deploying to prod (Postgres) is the only
> remaining step and needs explicit sign-off. Seed scripts: `backend/seed_bd_library.py`,
> `seed_bd_pursuits.py`, `seed_bd_time.py`.

---

## 0. TL;DR

The pursuit module is **already ~60% built**. This skeleton completes it into a
pursuit-to-proposal engine that does four things you asked for:

1. **Surfaces base data in one search** — resumes, past projects, capability
   statements, client references, certifications, past RFPs.
2. **A real Go/No-Go algorithm** — a weighted score that is *calibrated on your own
   win/loss history*, so the number means something.
3. **Tracks BD time per pursuit** — the true cost of chasing each job (mostly your
   and Ailsa's hours today).
4. **Learns from wins** — structured win/loss reviews that feed back into the score
   and the reusable content.

Seed data comes straight from `G:\Shared drives\Aquatech_Admin\Business_Development`.

---

## 1. What already exists (reuse — do not rebuild)

**Models** (`backend/app/models.py`)
- `Pursuit` — pipeline row: `stage`, `win_probability`, `est_fee`, `weighted_value`,
  `solicitation_type`, `proposal_due_date`, `gng_score` / `gng_recommendation` /
  `gng_scores_json`, `outcome_reason`, `converted_project_id`.
- `TeamingPartner` — firm + `is_mbe/is_wbe/is_dbe/is_sbe`, disciplines, rating.
- `Contact` (+ iCloud CardDAV sync), `PursuitContact`, `PursuitPartner`, `Activity`.
- `LibraryDocument` — **the vault already exists**: `category` ∈
  `rfp | resume | project | certificate | financial | boilerplate | other`, `tags`,
  `status`, `pursuit_id`, file bytes in DB (survive deploys, caught by PG backup).

**Endpoints** (`backend/app/main.py`)
- `/pursuits` CRUD, `/pursuits/{id}/gng`, `/pursuits/{id}/convert`,
  `/pursuits/{id}/activities`, `/bd/config`, `/bd/tasks`,
  `/bd/metrics` (hit rate, weighted pipeline, loss reasons, aging).

**Frontend** (`frontend/app/components/BdWorkspace.tsx`)
- Tabs: **dashboard | pipeline | library**; stage taxonomy
  `lead → qualifying → go_no_go → pursuing → proposal → shortlist → won/lost/no_go`;
  Go/No-Go factor scoring UI.

So the work below is **completion**, not greenfield.

---

## 2. Real data to seed from  ·  `…/Business_Development`

| Source | Seeds | Notes |
|---|---|---|
| `Business Development Planning/Aquatech Book of Work.xlsx` (sheet *Book of Work*) | `Pursuit` rows | Columns already map to the model: stage, RFP #, Contract Holder→client, Partner→teaming, Status→outcome, Source→lead source, Pending/Completed→$ value |
| `MBE_Certificates/` | `LibraryDocument` `category=certificate` | NYS MBE, NYC, PANYNJ DBE, NYCHA S3BC, Cert of Incorporation, Tax Release |
| Pursuit folders (`R1700/1701/1702`, `Skanska Manhattan Tunnel`, `Nassau`, `NYPA`, `Sewer_Drawings_New_Rochelle`, `DOT2024`) | `LibraryDocument` `category=rfp` + `past_proposal` | Each folder = one pursuit's RFP + our response + pricing form |
| App `TimeEntry` on the *Business Development* task (Bertrand / Ailsa) | BD hours → pursuit cost | Needs the `pursuit_id` link in §5 |

Book-of-Work KPIs already present (drop straight onto the BD dashboard):
Booked **$1.96M** · Pending **$6.63M** · Completed 2024 **$234,628** / 2023 **$34,900** · Active contracts **4**.

Stage mapping (their taxonomy → app enum):
`1-In Contract → won/converted` · `2-Pitched-Positive → proposal|shortlist` ·
`4-Pitch-Neutral → qualifying` · `5-Completed → won (closed)` · `6-Pitched-No Go → no_go|lost`.

---

## 3. Data-model deltas

```python
# models.py — extend LibraryDocument (vault gets tags that make "assemble for RFP" possible)
class LibraryDocument(Base):
    # ...existing columns...
    # NEW categories (widen the comment set): capability_statement | client_reference | past_proposal | win_theme
    sector:        Mapped[str | None]  # water | transportation | buildings | energy ...
    agency:        Mapped[str | None]  # DEP | DDC | DOT | PANYNJ | NYCHA ...
    discipline:    Mapped[str | None]  # civil | mechanical | CPM | modeling | QAQC
    person_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # resumes
    project_id:    Mapped[int | None]  = mapped_column(ForeignKey("projects.id")) # project sheets
    is_current:    Mapped[bool] = mapped_column(default=True)   # latest resume/cert
    expires_on:    Mapped[date | None]                          # cert expiry → alerts

# TimeEntry — attribute BD hours to a pursuit (the "time spent on BD" ask)
class TimeEntry(Base):
    # ...existing...
    pursuit_id: Mapped[int | None] = mapped_column(ForeignKey("pursuits.id"), index=True)

# NEW — Go/No-Go scoring model + calibration
class GngFactor(Base):
    key: Mapped[str]; label: Mapped[str]; weight: Mapped[float]   # weights sum to 100
    active: Mapped[bool] = mapped_column(default=True)

class WinLossReview(Base):
    pursuit_id: Mapped[int] = mapped_column(ForeignKey("pursuits.id"))
    outcome: Mapped[str]          # won | lost | no_go
    price_competitive: Mapped[int | None]   # 1..5
    reasons: Mapped[str]          # tags: relationship, price, past-performance, teaming, timing
    reuse_notes: Mapped[str]      # what to lift into the next proposal (feeds the vault)
    reviewed_by: Mapped[int | None]; reviewed_at: Mapped[datetime]
```

---

## 4. Go/No-Go algorithm  (the "develop the algo" ask)

Weighted 0–100 score; each factor scored **0–5**, normalized by weight.

| Factor | Weight | Scored on |
|---|--:|---|
| Client fit / relationship | 20 | existing client, warm contact, incumbent-adjacent |
| Win probability | 20 | teaming strength, set-aside (MBE/DBE) advantage, incumbency |
| Strategic value | 15 | sector we want, reference-building, follow-on potential |
| Margin quality | 15 | fee ÷ loaded cost, scope clarity, T&Cs |
| Capacity | 15 | do we have the people in the proposal + delivery window |
| Teaming | 10 | prime/sub strength, our role, past experience together |
| Effort to bid | 5 | proposal cost ÷ expected fee (inverse) |

```
score   = Σ( weight × factor_0to5 / 5 )                    # 0..100
rec     = "go" if score ≥ 70 else "conditional" if score ≥ 50 else "no_go"
```

**Calibration (learning from wins).** A nightly job fits realized outcomes against
historical `gng_score`, so the UI can show *"pursuits you scored ~78 win 41% of the
time"* and nudges the factor weights toward what actually predicts your wins. This is
what turns the score from a gut-feel form into an algorithm.

---

## 5. Base-data vault — quick surface

```
GET /library/search?q=&category=&sector=&agency=&discipline=&tag=&current=1
        → full-text over title/description/tags (+ optional PDF-text index)
GET /pursuits/{id}/assemble
        → auto-surfaces a proposal working set for this RFP:
            · resumes matched by discipline
            · 3–5 project sheets matched by sector/agency/scope
            · current capability statement for the sector
            · required certs (MBE/DBE/S3BC) with expiry check
            · client references for the agency
POST /library         (upload)     ·   GET /library/{id}/file  (download)
GET  /library/expiring             → certs within 60 days of expiry
```

One click on *Assemble* gives a responder the resumes, past projects, caps statement,
certs and references for that solicitation — the "respond to RFPs quickly" goal.

---

## 6. BD time tracking

- `TimeEntry.pursuit_id` links BD hours (already logged to the *Business Development*
  task, mostly Bertrand + Ailsa) to a specific pursuit.
- `/bd/metrics` adds **cost-per-pursuit** and **cost-per-win**
  (Σ hours × loaded cost rate), so the dashboard shows what chasing work really costs
  and which sources/partners return the best win per BD dollar.

---

## 7. UI (extends `BdWorkspace.tsx`)

```
BdWorkspace
├─ Dashboard   pipeline $ (weighted), hit rate, win/loss, BD cost & cost-per-win, aging
├─ Pipeline    kanban by stage · go/no-go badge · due-date + $ on each card
├─ Pursuit ▸   scope · team (partners+contacts) · activities · TIME · Go/No-Go · [Assemble]
├─ Vault       search/filter by category·sector·agency·discipline · upload · cert-expiry
└─ Reviews     win/loss reviews · reasons · "reuse notes" that push into the Vault
```

---

## 8. Build sequence (phased, low-risk)

1. **Vault surface** — widen `LibraryDocument`, add `/library/search`, build the Vault
   tab, seed certs + RFPs from the shared drive. *(Immediately useful for the next RFP.)*
2. **Go/No-Go algorithm** — `GngFactor` weights, scoring endpoint, nightly calibration,
   score UI on the pursuit detail.
3. **BD time** — `TimeEntry.pursuit_id`, cost-per-pursuit / cost-per-win metrics.
4. **Reviews + Assemble + seed pursuits** — `WinLossReview`, `/pursuits/{id}/assemble`,
   `seed_bd_from_bookofwork.py` to import the Book of Work pipeline.

Each phase ships independently and touches no existing accounting/payroll code.

---

## 9. Seed script (stub)

```python
# backend/seed_bd_from_bookofwork.py
#  parse "Aquatech Book of Work.xlsx" (sheet "Book of Work") → Pursuit rows
#    map the "1-In Contract … 6-Pitched-No Go" column → app stage enum (see §2)
#    Contract Holder → client_name/agency ; Partner → TeamingPartner + PursuitPartner
#    Pending / Completed columns → est_fee / outcome value ; Source → source
#  walk MBE_Certificates/  → LibraryDocument(category="certificate", is_current=True)
#  walk each pursuit folder → LibraryDocument(category="rfp"/"past_proposal", pursuit_id=…)
```
