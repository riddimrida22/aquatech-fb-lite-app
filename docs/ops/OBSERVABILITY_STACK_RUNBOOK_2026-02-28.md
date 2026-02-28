# AquatechPM Observability Stack Runbook (2026-02-28)

## Stack Components
- Prometheus (metrics + alert rules): `http://localhost:9090`
- Alertmanager (alert routing): `http://localhost:9093`
- Grafana (dashboards): `http://localhost:3001`
- Blackbox Exporter (HTTP probing): `http://localhost:9115`

## Start / Stop / Status
- Start:
  - `./scripts/observability_up.sh`
- Status:
  - `./scripts/observability_status.sh`
- Stop:
  - `./scripts/observability_down.sh`

## Alert Routing
1. Set webhook URL in shell and start stack:
   - `ALERT_WEBHOOK_URL=https://<your-webhook-endpoint> ./scripts/observability_up.sh`
2. This writes runtime config to:
   - `deployment/observability/alertmanager.runtime.yml`
3. Alert rules currently trigger on:
   - endpoint down > 2 minutes (`critical`)
   - endpoint latency > 2.5s for 5 minutes (`warning`)

## Grafana Access
- URL: `http://localhost:3001`
- Default user: `admin`
- Default password: `change-me-now`
- Change admin password immediately in production.

## First Validation Checklist
1. Run `./scripts/observability_status.sh` and confirm all PASS.
2. Open Prometheus and run query:
   - `probe_success{job="blackbox-http"}`
3. Open Grafana dashboard:
   - `AquatechPM Uptime Overview`
4. Confirm targets include:
   - `https://app.aquatechpc.com`
   - `https://app.aquatechpc.com/api/health`
   - `https://app.aquatechpc.com/api/auth/google/login`

## Notes
- Stack runs on external Docker network `aquatechpm_private`.
- This release includes metrics and probe-based monitoring.
- Log aggregation (Loki/Promtail or managed logging) remains next step.
