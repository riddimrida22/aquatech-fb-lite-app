#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_INPUT="${1:-.env}"
if [[ "${ENV_FILE_INPUT}" = /* ]]; then
  ENV_FILE="${ENV_FILE_INPUT}"
else
  ENV_FILE="${ROOT_DIR}/${ENV_FILE_INPUT}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "FAIL: .env not found at ${ENV_FILE}"
  echo "Create it from .env.example:"
  echo "  cp .env.example .env"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

fail_count=0

pass() {
  echo "PASS: $1"
}

warn() {
  echo "WARN: $1"
}

fail() {
  echo "FAIL: $1"
  fail_count=$((fail_count + 1))
}

is_placeholder() {
  local v="${1:-}"
  [[ -z "${v}" || "${v}" == "REPLACE_ME" || "${v}" == CHANGE_ME* || "${v}" == "dev-secret-change-me" ]]
}

echo "Running launch preflight checks..."

if is_placeholder "${SESSION_SECRET:-}"; then
  fail "SESSION_SECRET is missing/placeholder."
else
  pass "SESSION_SECRET set."
fi

if is_placeholder "${GOOGLE_CLIENT_ID:-}"; then
  fail "GOOGLE_CLIENT_ID is missing/placeholder."
else
  pass "GOOGLE_CLIENT_ID set."
fi

if is_placeholder "${GOOGLE_CLIENT_SECRET:-}"; then
  fail "GOOGLE_CLIENT_SECRET is missing/placeholder."
else
  pass "GOOGLE_CLIENT_SECRET set."
fi

if [[ "${DEV_AUTH_BYPASS:-true}" != "false" ]]; then
  fail "DEV_AUTH_BYPASS must be false for launch."
else
  pass "DEV_AUTH_BYPASS=false."
fi

if [[ "${NEXT_PUBLIC_DEV_AUTH_BYPASS:-true}" != "false" ]]; then
  fail "NEXT_PUBLIC_DEV_AUTH_BYPASS must be false for launch."
else
  pass "NEXT_PUBLIC_DEV_AUTH_BYPASS=false."
fi

if [[ "${TIMESHEET_REMINDER_ENABLED:-false}" == "true" ]]; then
  if is_placeholder "${SMTP_HOST:-}" || is_placeholder "${SMTP_FROM_EMAIL:-}"; then
    fail "Reminder enabled but SMTP_HOST/SMTP_FROM_EMAIL are missing."
  else
    pass "Reminder SMTP base settings present."
  fi
  if [[ -z "${SMTP_USERNAME:-}" || -z "${SMTP_PASSWORD:-}" ]]; then
    warn "SMTP auth is blank. This is fine only if your SMTP relay allows unauthenticated send."
  else
    pass "SMTP auth credentials present."
  fi
else
  warn "TIMESHEET_REMINDER_ENABLED=false (daily 3 PM reminders are disabled)."
fi

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not installed or not on PATH."
else
  pass "docker found."
fi

if ! docker info >/dev/null 2>&1; then
  fail "docker daemon is not running."
else
  pass "docker daemon is running."
fi

if (( fail_count > 0 )); then
  echo
  echo "Preflight failed with ${fail_count} blocking issue(s)."
  exit 1
fi

echo
echo "Preflight passed with no blocking issues."
