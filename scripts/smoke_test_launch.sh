#!/usr/bin/env bash
set -euo pipefail

BASE_BACKEND_URL="${BASE_BACKEND_URL:-http://localhost:8000}"
BASE_FRONTEND_URL="${BASE_FRONTEND_URL:-http://localhost:3000}"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    fail "${label} expected HTTP ${expected}, got ${actual}"
  fi
}

echo "[1/5] backend health"
code="$(curl -sS -o /tmp/aq_health.json -w "%{http_code}" "${BASE_BACKEND_URL}/")"
expect_code 200 "${code}" "backend health"

echo "[2/5] frontend reachable"
code="$(curl -sS -o /tmp/aq_frontend.html -w "%{http_code}" "${BASE_FRONTEND_URL}/")"
expect_code 200 "${code}" "frontend home"

echo "[3/5] auth guard active"
code="$(curl -sS -o /tmp/aq_users_unauth.json -w "%{http_code}" "${BASE_BACKEND_URL}/users")"
expect_code 401 "${code}" "unauth users guard"

echo "[4/5] pay period endpoint"
code="$(curl -sS -o /tmp/aq_pay_period.json -w "%{http_code}" "${BASE_BACKEND_URL}/timeframes/pay-period?date_str=$(date +%F)")"
expect_code 200 "${code}" "pay period"

echo "[5/5] startup critical config check"
./scripts/launch_preflight.sh >/tmp/aq_preflight.txt 2>&1 || fail "launch preflight did not pass"

echo "PASS: launch smoke checks complete"
