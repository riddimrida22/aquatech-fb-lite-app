#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TPL="deployment/observability/alertmanager.yml.tmpl"
OUT="deployment/observability/alertmanager.runtime.yml"

if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
  cat > "$OUT" <<'YAML'
route:
  receiver: default-log
  group_by: [alertname, instance]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 2h

receivers:
  - name: default-log
YAML
  echo "Configured Alertmanager with default-log receiver only (no webhook)."
  exit 0
fi

escaped="${ALERT_WEBHOOK_URL//\//\\/}"
sed "s/\${ALERT_WEBHOOK_URL}/${escaped}/g" "$TPL" > "$OUT"
echo "Configured Alertmanager webhook receiver."
