# AquatechPM SLO Targets (2026-02-28)

## Service Level Objectives
- Availability SLO: 99.9% monthly uptime for `https://app.aquatechpc.com`.
- API Health SLO: `/api/health` 99.9% monthly success.
- Login Redirect SLO: `/api/auth/google/login` returns 3xx with p95 latency <= 2500 ms.
- Frontend p95 Latency SLO: home page <= 2500 ms.

## Error Budget
- Monthly error budget for 99.9% SLO: 43m 49s downtime.
- Burn-rate trigger (fast): >2% budget in 1 hour.
- Burn-rate trigger (slow): >10% budget in 24 hours.

## Measurement
- Run `./scripts/ops_slo_report.sh` hourly via cron or scheduler.
- Store reports under `docs/ops/` for audit trail and trend reviews.
- Use `./scripts/ops_monitor.sh` for immediate operational checks and alert hooks.
