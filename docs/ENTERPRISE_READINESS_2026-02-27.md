# AquatechPM Enterprise Readiness (2026-02-27)

## Completed in this sprint
- CI pipeline for backend integration tests and frontend build.
- One-command pre-deploy gate (preflight + integration tests + optional live smoke).
- Runtime monitor script with optional webhook alerts.
- Disaster-recovery restore drill script (backup -> isolated restore -> verification).

## New operational commands
- CI (GitHub Actions): `.github/workflows/ci.yml`
- Staged deployment + rollback workflow: `.github/workflows/deploy.yml`
- Pre-deploy quality gate:
  - `./scripts/pre_deploy_gate.sh .env.prod`
- Runtime monitor:
  - `./scripts/ops_monitor.sh`
  - Optional webhook alerting: `ALERT_WEBHOOK_URL=<url> ./scripts/ops_monitor.sh`
- Disaster recovery restore drill:
  - `./scripts/dr_restore_drill.sh .env.prod`

## GitHub Deployment Setup
1. Create GitHub Environments:
   - `staging`
   - `production` (configure required reviewers for approval gate)
2. Add repository secrets for staging:
   - `STAGING_SSH_PRIVATE_KEY`
   - `STAGING_HOST`
   - `STAGING_USER`
   - `STAGING_APP_DIR`
   - `STAGING_APP_BASE_URL`
3. Add repository secrets for production:
   - `PROD_SSH_PRIVATE_KEY`
   - `PROD_HOST`
   - `PROD_USER`
   - `PROD_APP_DIR`
   - `PROD_APP_BASE_URL`
4. Ensure server app dirs contain:
   - `.env.prod`
   - runnable scripts in `scripts/`
   - git remote configured and fetchable
5. Run workflow `Deploy` via Actions:
   - default deploy path: `validate -> staging -> production`
   - rollback path: set `run_rollback=true` and choose `rollback_target`

## Rollback Hook
- Deploy script writes state to `.deploy_state` with current and previous commit.
- Rollback command restores previous commit and redeploys:
  - `./scripts/rollback_last_deploy.sh .env.prod`

## Security hardening operational policy
- Keep `DEV_AUTH_BYPASS=false` and `NEXT_PUBLIC_DEV_AUTH_BYPASS=false` in production.
- Rotate at least quarterly:
  - `SESSION_SECRET`
  - `POSTGRES_PASSWORD`
  - `GOOGLE_CLIENT_SECRET`
  - `PLAID_SECRET`
  - `SMTP_PASSWORD`
- After secret rotation:
  1. Update `.env.prod`
  2. Run `./scripts/pre_deploy_gate.sh .env.prod`
  3. Deploy with `./scripts/deploy_prod.sh .env.prod`

## Remaining enterprise gaps (next phase)
- Add centralized logs/metrics dashboards (Grafana/Loki/Prometheus or managed equivalent).
- Add policy-based IAM/SSO/SCIM and formal quarterly access-review evidence exports.
- Add staged deploy promotion (dev -> staging -> prod) with approval gates.
- Add load testing baseline and SLO-driven alert thresholds.
