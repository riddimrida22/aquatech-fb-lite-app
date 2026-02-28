#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.prod}"
APP_BASE_URL="${APP_BASE_URL:-https://app.aquatechpc.com}"
API_BASE_URL="${API_BASE_URL:-https://app.aquatechpc.com/api}"
MAX_TIME_S="${MAX_TIME_S:-12}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: env file not found: $ENV_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker not found"
  exit 1
fi

compose_cmd=(docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml)

check_url() {
  local url="$1"
  local code
  code="$(curl -sS --max-time "$MAX_TIME_S" -o /dev/null -w "%{http_code}" "$url" || echo "000")"
  [[ "$code" =~ ^[23][0-9][0-9]$ ]]
}

frontend_ok=0
backend_ok=0
if check_url "$APP_BASE_URL"; then frontend_ok=1; fi
if check_url "$API_BASE_URL/health"; then backend_ok=1; fi

if (( frontend_ok == 1 && backend_ok == 1 )); then
  echo "PASS: production endpoints are healthy"
  exit 0
fi

echo "WARN: health check failed (frontend_ok=$frontend_ok backend_ok=$backend_ok), attempting recovery"
"${compose_cmd[@]}" up -d --build

# Recheck once after recovery action.
if check_url "$APP_BASE_URL" && check_url "$API_BASE_URL/health"; then
  echo "PASS: recovered production endpoints"
  exit 0
fi

echo "FAIL: recovery attempt did not restore health"
exit 1
