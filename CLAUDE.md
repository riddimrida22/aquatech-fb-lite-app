# AqtPM — Agent Instructions

## ⛔ FIRST, EVERY TIME: read `DECISIONS.md` (the Settled Decisions Register)

`DECISIONS.md` is the source of truth for **settled** decisions about this app. Before you
implement, change, or "improve" anything:

1. **Check `DECISIONS.md`.**
2. If your task would change, revert, or contradict a **🔒 Locked** decision — **STOP.**
   Flag it as *"⚠️ This touches settled decision D-NNN — approve before I proceed?"* and
   **wait for the owner's (Bertrand's) explicit approval.** Never proceed on assumption, and
   never silently do it differently than the register says.
3. When a new decision is settled in your session, **append it to `DECISIONS.md`** (new
   D-NNN) in the same turn.
4. Any approved change to a locked decision → update the entry **and** add a Change Log row
   (date · what changed · approved by). `git blame DECISIONS.md` is the audit trail.

The whole point: the owner must not have to re-check that already-decided behavior hasn't
drifted. Treat the register as binding.

## Stack / deploy (quick reference)
- Backend: FastAPI + SQLAlchemy (`backend/app/main.py`), Postgres prod / SQLite dev.
- Frontend: Next.js + TypeScript (`frontend/app/`).
- Prod: GCE `35.186.187.114`, Docker Compose at `/opt/AquatechPM`, `app.aquatechpc.com`.
- Deploy (disk-safe): `git reset --hard <commit>` then
  `ALLOW_SKIP_CADDY_ON_443_CONFLICT=true FORCE_TAKEOVER_443=true RUN_GATE=false ./scripts/deploy_from_commit.sh <commit> .env.prod` — auto-rolls-back on build failure.
- Verify financials server-side against prod (`docker exec aquatechpm_backend_1 python ...`),
  not just locally — the SQLite dev DB lacks the Plaid/payroll data.
