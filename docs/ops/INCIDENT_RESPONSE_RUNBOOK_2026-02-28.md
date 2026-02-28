# AquatechPM Incident Response Runbook (2026-02-28)

## Severity Model
- SEV1: Production unavailable or data integrity risk.
- SEV2: Major feature degradation (timesheets, invoicing, bank sync impaired).
- SEV3: Minor defect with workaround.

## First 15 Minutes
1. Confirm incident and capture exact timestamp in UTC.
2. Run `./scripts/ops_monitor.sh` and save output.
3. Check service status: `docker compose -f docker-compose.prod.yml ps`.
4. Check logs: `docker compose -f docker-compose.prod.yml logs --tail=200 backend frontend caddy`.
5. If recent deploy likely caused issue, run rollback:
   - `./scripts/rollback_last_deploy.sh .env.prod`

## Communications
1. Open incident channel/thread with severity and owner.
2. Provide updates every 15 minutes for SEV1/SEV2.
3. Record customer impact and mitigation timeline.

## Recovery Criteria
- `./scripts/ops_monitor.sh` returns PASS.
- Core user journey works: sign-in -> time tracking -> save/submit -> admin review.
- Financial journey works: bank transactions view -> category action -> reports load.

## Postmortem (within 24h for SEV1/SEV2)
1. Timeline with exact UTC timestamps.
2. Root cause and contributing factors.
3. Corrective actions with owners and due dates.
4. Regression tests and monitoring updates added.
