#!/usr/bin/env bash
set -euo pipefail

APP_BASE_URL="${APP_BASE_URL:-https://app.aquatechpc.com}"
API_BASE_URL="${API_BASE_URL:-https://app.aquatechpc.com/api}"
LATENCY_BUDGET_MS="${LATENCY_BUDGET_MS:-2500}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
CURL_MAX_TIME_S="${CURL_MAX_TIME_S:-15}"
CHECK_RETRIES="${CHECK_RETRIES:-3}"
RETRY_DELAY_S="${RETRY_DELAY_S:-2}"

pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; }
fail() { echo "FAIL: $1"; }

post_alert() {
  local message="$1"
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    return 0
  fi
  curl -sS -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"AquatechPM monitor alert: ${message}\"}" >/dev/null || true
}

http_check() {
  local label="$1"
  local url="$2"
  local expected_prefix="$3"

  local out code latency_s latency_ms
  local attempt=1
  code="000"
  latency_s="99"
  while (( attempt <= CHECK_RETRIES )); do
    out="$(curl -sS --max-time "$CURL_MAX_TIME_S" -o /tmp/aq_mon_body.$$ -w '%{http_code} %{time_total}' "$url" || echo '000 99')"
    code="${out%% *}"
    latency_s="${out##* }"
    if [[ "$code" == $expected_prefix* ]]; then
      break
    fi
    if (( attempt < CHECK_RETRIES )); then
      warn "$label attempt $attempt/$CHECK_RETRIES got HTTP $code; retrying in ${RETRY_DELAY_S}s"
      sleep "$RETRY_DELAY_S"
    fi
    ((attempt++))
  done

  local latency_ms
  latency_ms="$(awk -v s="$latency_s" 'BEGIN { printf("%d", s*1000) }')"

  if [[ "$code" != $expected_prefix* ]]; then
    fail "$label returned HTTP $code"
    failures+=("$label failed with HTTP $code at $url")
    return 1
  fi

  if (( latency_ms > LATENCY_BUDGET_MS )); then
    warn "$label latency ${latency_ms}ms exceeds budget ${LATENCY_BUDGET_MS}ms"
  else
    pass "$label HTTP $code latency ${latency_ms}ms"
  fi
}

overall_fail=0
failures=()

echo "== AquatechPM Runtime Monitor =="
echo "APP_BASE_URL=$APP_BASE_URL"
echo "API_BASE_URL=$API_BASE_URL"

http_check "Frontend home" "$APP_BASE_URL" "2" || overall_fail=1
http_check "Backend health" "$API_BASE_URL/health" "2" || overall_fail=1
http_check "Google login redirect" "$API_BASE_URL/auth/google/login" "3" || overall_fail=1

if command -v docker >/dev/null 2>&1 && [[ -f docker-compose.prod.yml ]]; then
  echo "== docker compose status =="
  docker compose -f docker-compose.prod.yml ps || true
fi

if (( overall_fail > 0 )); then
  post_alert "$(printf '%s; ' "${failures[@]}")"
  echo ""
  echo "Monitor result: FAILED"
  exit 1
fi

echo ""
echo "Monitor result: PASS"
