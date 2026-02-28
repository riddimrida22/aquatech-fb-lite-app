#!/usr/bin/env bash
set -euo pipefail

APP_BASE_URL="${APP_BASE_URL:-https://app.aquatechpc.com}"
API_BASE_URL="${API_BASE_URL:-https://app.aquatechpc.com/api}"

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

status_code() {
  curl -sS -o /tmp/aq_smoke_body.$$ -w "%{http_code}" "$1"
}

check_status_2xx() {
  local name="$1"
  local url="$2"
  local code
  code="$(status_code "$url")"
  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    pass "$name ($code)"
  else
    echo "--- response body ---"
    cat /tmp/aq_smoke_body.$$ || true
    echo "---------------------"
    fail "$name expected 2xx, got $code"
  fi
}

check_status_3xx() {
  local name="$1"
  local url="$2"
  local code
  code="$(status_code "$url")"
  if [[ "$code" =~ ^3[0-9][0-9]$ ]]; then
    pass "$name ($code)"
  else
    echo "--- response body ---"
    cat /tmp/aq_smoke_body.$$ || true
    echo "---------------------"
    fail "$name expected 3xx, got $code"
  fi
}

cleanup() {
  rm -f /tmp/aq_smoke_body.$$ || true
}
trap cleanup EXIT

check_status_2xx "Frontend root" "$APP_BASE_URL"
check_status_2xx "Backend health" "$API_BASE_URL/health"
check_status_3xx "Timekeeping route redirect" "$APP_BASE_URL/timekeeping"

echo "Smoke check complete."
