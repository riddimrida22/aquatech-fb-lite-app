> **⚠️ ARCHIVED — 2026-06-02. DO NOT FOLLOW.**
> Aquatech is **no longer using Gusto**. Payroll is transitioning to **Paychex** (timing TBD).
> This Gusto demo→production promotion workflow was never executed and is kept for
> historical reference only. Do **not** request Gusto production approval.
> The committed `backend/app/gusto.py` and `/auth/gusto/*` endpoints remain solely to
> keep parsing the historical Gusto Payroll Journal CSVs already imported into the app.
> A Paychex equivalent of this doc will be written when that integration is scoped.

---

# Gusto demo → production promotion workflow

**As of 2026-05-06:** AquatechPM Gusto integration is fully built and tested in demo (api.gusto-demo.com). Demo company "AQT_Demo" has 14 demo employees and synced once successfully on 2026-05-02. Refresh token expired 2026-05-02. To use the integration with the **real Aquatech Gusto account** ($398k lifetime payroll), follow these steps.

---

## What's already done

- `backend/app/gusto.py` (320 lines): OAuth flow, token storage, refresh, employee + payroll sync
- `backend/app/main.py`: 4 endpoints — `/auth/gusto/start`, `/auth/gusto/callback`, `/admin/gusto/status`, `/admin/gusto/sync`, `/admin/gusto/disconnect`
- `backend/app/models.py`: GustoEmployee, GustoPayroll, IntegrationToken tables
- `.env`: GUSTO_CLIENT_ID + GUSTO_CLIENT_SECRET set (demo values)

## What's NOT done

- App is registered with **Gusto demo only** — needs promotion to production
- `.env` GUSTO_API_BASE / GUSTO_AUTH_BASE point at `api.gusto-demo.com` — must flip to `api.gusto.com`
- Refresh token expired (was last issued 2026-05-02, expired same day per demo TTL)

---

## Promotion steps

### 1. Request promotion in the Gusto Developer Portal

Log in to https://dev.gusto.com → your application (currently in demo). There's a **"Move to production"** or **"Promote app"** action. You'll need to provide:

- **Use case description**: "Internal project-controls and accounting app for Aquatech Engineering P.C. Imports payroll cost data (employer cost, employer taxes, 401(k) match, gross wages) for COGS reporting against engineering project budgets. Read-only — does not run or modify payroll."
- **Live application URL** (your production AquatechPM domain — `https://app.aquatechpc.com`)
- **OAuth redirect URI** (production): `https://app.aquatechpc.com/api/auth/gusto/callback`
- **Logo + privacy policy URL** (Gusto requires these)
- **Scopes used**: companies/read, employees/read, payrolls/read, departments/read

Approval is typically 1-3 business days.

### 2. Get production credentials

After approval, Gusto issues a **new** `client_id` + `client_secret` (production keys differ from demo). They appear in the developer portal.

### 3. Update `.env` (or `.env.prod` on the server)

```ini
# Production Gusto endpoints
GUSTO_API_BASE=https://api.gusto.com
GUSTO_AUTH_BASE=https://api.gusto.com
# Production credentials (new, not the demo ones)
GUSTO_CLIENT_ID=<prod_client_id>
GUSTO_CLIENT_SECRET=<prod_client_secret>
GUSTO_REDIRECT_URI=https://app.aquatechpc.com/api/auth/gusto/callback
GUSTO_API_VERSION=2026-02-01
```

Restart backend so pydantic-settings reloads:
```bash
docker compose -f docker-compose.prod.yml restart backend
# or for local dev: kill the uvicorn process, restart
```

### 4. Authorize against the real Aquatech Gusto account

1. Sign in to AquatechPM as admin
2. Visit `https://app.aquatechpc.com/auth/gusto/start` (or click "Connect Gusto" once UI surfacing exists)
3. You'll be redirected to Gusto's auth page — sign in with your **Aquatech Gusto admin** credentials
4. Grant the requested scopes
5. Gusto redirects back to `/auth/gusto/callback?code=...`
6. Backend exchanges code for tokens, stores them in `integration_tokens` table

### 5. Test with `GET /admin/gusto/status`

```bash
curl -sf -b cookie.txt https://app.aquatechpc.com/api/admin/gusto/status
```

Expected response:
```json
{
  "connected": true,
  "account_id": "<real_aquatech_uuid>",
  "expires_at": "<future timestamp>",
  "last_sync_status": "ok",
  "last_sync_summary": {
    "companies": { "count": 1, "sample": [{ "name": "Aquatech Engineering P.C." }] },
    "employees": { "count": <real_count>, ... }
  }
}
```

### 6. Trigger first production sync

```bash
curl -sf -X POST -b cookie.txt https://app.aquatechpc.com/api/admin/gusto/sync
```

This populates `gusto_employees` and `gusto_payrolls` tables with **real Aquatech employee and payroll data**.

Expected to see real names (Bertrand, Roger Wang, Svadlenka, Gilliam, Hodge, etc.) and ~$398k lifetime employer cost — should match the Gusto Payroll Journal CSV-derived figures already in the app.

### 7. Reconcile API data vs CSV data

The Gusto Journal CSV import (`POST /payroll/journal/summary`) is the canonical path today and matches your bank Gusto wires. After API sync, both paths should agree. If they diverge:

- **API > CSV**: real-time Gusto has periods not yet exported to CSV — promote API as canonical
- **CSV > API**: CSV has historical periods Gusto API can't return (likely date-range limit) — keep CSV as historical, API for forward sync
- **Equal**: switch the Payroll Portal to use `/admin/gusto/employees` + `/admin/gusto/payrolls` directly, drop the CSV inbox dependency

### 8. Schedule auto-refresh

The integration already supports `refresh_bearer()` for token renewal. Add a daily cron:

```python
# backend/app/scheduler.py (or whatever periodic runner exists)
@scheduler.scheduled_job('cron', hour=2)
def refresh_gusto():
    db = SessionLocal()
    try:
        tok = gusto.load_token(db)
        if tok and tok.refresh_token:
            new = gusto.refresh_bearer(tok.refresh_token)
            gusto.store_tokens(db, new, notes='auto-refresh')
    finally:
        db.close()
```

---

## Risks / things to watch

- **Gusto rate limits**: production is more restrictive than demo. Sync should be incremental (last_synced_at filter) once payrolls > a few hundred.
- **Webhooks vs polling**: Gusto supports webhooks for payroll-completed events. Worth wiring up to avoid stale data between scheduled syncs.
- **Departments + projects mapping**: Gusto employees have a `department` field that maps poorly to Aquatech's project codes. Decide whether to (a) ignore, (b) maintain a manual lookup, or (c) reuse the AquatechPM Project list as Gusto departments via the Departments API.
- **Two-way sync**: out of scope. Gusto remains the source of truth for payroll itself; AquatechPM just consumes the journal.

---

## Fallback if production approval is delayed

While waiting on Gusto promotion approval:
1. Continue using the **CSV import path** (already canonical and producing correct $398k figure)
2. Refresh CSV monthly: download Payroll Journal Report from Gusto admin UI, drop in `data/imports/AqtPM-Uploads/`, click "Import recommended files" in the AquatechPM Imports tab
3. Migrate to API once promoted

---

## Status checklist

- [ ] Submit promotion request in Gusto Developer Portal
- [ ] Receive production approval + new client_id / client_secret
- [ ] Update `.env.prod` with prod endpoints + credentials
- [ ] Restart production backend
- [ ] Authorize against real Aquatech Gusto account
- [ ] Verify `/admin/gusto/status` returns Aquatech (not "AQT_Demo")
- [ ] First sync — verify employee names match real staff
- [ ] Reconcile API totals vs Payroll Journal CSV totals
- [ ] Schedule auto-refresh cron
- [ ] (Optional) Wire payroll-completed webhook
