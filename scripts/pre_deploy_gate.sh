#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env}"
RUN_LIVE_SMOKE="${RUN_LIVE_SMOKE:-auto}"
BASE_BACKEND_URL="${BASE_BACKEND_URL:-http://localhost:8000}"
BASE_FRONTEND_URL="${BASE_FRONTEND_URL:-http://localhost:3000}"

pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; }
fail() { echo "FAIL: $1"; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  fail "Env file not found: $ENV_FILE"
fi

echo "== Pre-deploy quality gate =="
echo "Project: $ROOT_DIR"
echo "Env: $ENV_FILE"

echo "[1/3] Launch preflight"
./scripts/launch_preflight.sh "$ENV_FILE"

echo "[2/3] Backend integration tests"
PY_BIN="python3"
if [[ -x "$ROOT_DIR/backend/.venv/bin/python" ]]; then
  PY_BIN="$ROOT_DIR/backend/.venv/bin/python"
fi
(
  cd backend
  "$PY_BIN" -m pytest -q tests/test_mvp.py tests/test_financial_flows.py
)
pass "Backend integration tests"

echo "[3/3] Live smoke checks (optional)"
run_smoke=false
if [[ "$RUN_LIVE_SMOKE" == "true" ]]; then
  run_smoke=true
elif [[ "$RUN_LIVE_SMOKE" == "auto" ]]; then
  if curl -fsS "$BASE_BACKEND_URL/" >/dev/null 2>&1 && curl -fsS "$BASE_FRONTEND_URL/" >/dev/null 2>&1; then
    run_smoke=true
  fi
fi

if [[ "$run_smoke" == "true" ]]; then
  BASE_BACKEND_URL="$BASE_BACKEND_URL" BASE_FRONTEND_URL="$BASE_FRONTEND_URL" ./scripts/smoke_test_launch.sh
  pass "Live smoke checks"
else
  warn "Skipped live smoke checks (set RUN_LIVE_SMOKE=true to force)."
fi

echo ""
pass "Pre-deploy quality gate complete"
