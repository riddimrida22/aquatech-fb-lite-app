#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-bertrand.byrne@aquatechpc.com}"
ADMIN_NAME="${ADMIN_NAME:-Bertrand Byrne}"
ACCOUNT_ID="${ACCOUNT_ID:-OPERATING-001}"
TODAY="${TODAY:-$(date +%F)}"

ADMIN_COOKIE="$(mktemp)"
USER_COOKIE="$(mktemp)"
TMP_DIR="$(mktemp -d)"
STAMP="$(date +%Y%m%d%H%M%S)"
TEST_EMAIL="smoke.user.${STAMP}@aquatechpc.com"
PROJECT_NAME="Smoke Project ${STAMP}"

cleanup() {
  rm -f "$ADMIN_COOKIE" "$USER_COOKIE"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label expected HTTP $expected, got $actual"
  fi
}

json_num_field() {
  local key="$1"
  local file="$2"
  sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\1/p" "$file" | head -n1
}

json_list_id_by_email() {
  local email="$1"
  local file="$2"
  awk -v email="$email" '
    BEGIN { RS="\\{"; FS="," }
    $0 ~ "\"email\":\"" email "\"" {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /"id":[0-9]+/) {
          match($i, /[0-9]+/)
          print substr($i, RSTART, RLENGTH)
          exit
        }
      }
    }
  ' "$file"
}

echo "[1/10] Health check"
code="$(curl -sS -o "$TMP_DIR/health.json" -w "%{http_code}" "$BASE_URL/")"
expect_code 200 "$code" "health"

echo "[2/10] Admin auth session"
code="$(curl -sS -c "$ADMIN_COOKIE" -o "$TMP_DIR/admin_login.json" -w "%{http_code}" \
  -X POST "$BASE_URL/auth/dev/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"$ADMIN_EMAIL\"}")"
if [[ "$code" != "200" ]]; then
  bootstrap_code="$(curl -sS -c "$ADMIN_COOKIE" -o "$TMP_DIR/admin_bootstrap.json" -w "%{http_code}" \
    -X POST "$BASE_URL/auth/dev/bootstrap-admin" \
    -H 'Content-Type: application/json' \
    --data "{\"email\":\"$ADMIN_EMAIL\",\"full_name\":\"$ADMIN_NAME\"}")"
  if [[ "$bootstrap_code" != "200" ]]; then
    fail "admin auth/bootstrap failed (login=$code bootstrap=$bootstrap_code)"
  fi
fi

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/me.json" -w "%{http_code}" "$BASE_URL/auth/me")"
expect_code 200 "$code" "auth/me"
ADMIN_ID="$(json_num_field id "$TMP_DIR/me.json")"
[[ -n "$ADMIN_ID" ]] || fail "could not parse admin id from /auth/me"

echo "[3/10] Auth guardrail"
code="$(curl -sS -o "$TMP_DIR/users_unauth.json" -w "%{http_code}" "$BASE_URL/users")"
expect_code 401 "$code" "unauthorized /users"

echo "[4/10] Pending user creation + activation"
code="$(curl -sS -o "$TMP_DIR/new_user_first_login.json" -w "%{http_code}" \
  -X POST "$BASE_URL/auth/dev/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"$TEST_EMAIL\"}")"
expect_code 403 "$code" "new user first login"

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/pending.json" -w "%{http_code}" "$BASE_URL/users/pending")"
expect_code 200 "$code" "pending users"
TEST_USER_ID="$(json_list_id_by_email "$TEST_EMAIL" "$TMP_DIR/pending.json")"
[[ -n "$TEST_USER_ID" ]] || fail "pending user id not found for $TEST_EMAIL"

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/activate.json" -w "%{http_code}" \
  -X POST "$BASE_URL/users/$TEST_USER_ID/activate")"
expect_code 200 "$code" "activate user"

code="$(curl -sS -c "$USER_COOKIE" -o "$TMP_DIR/new_user_second_login.json" -w "%{http_code}" \
  -X POST "$BASE_URL/auth/dev/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"$TEST_EMAIL\"}")"
expect_code 200 "$code" "new user second login"

echo "[5/10] Seed project/WBS"
code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/project.json" -w "%{http_code}" \
  -X POST "$BASE_URL/projects" \
  -H 'Content-Type: application/json' \
  --data "{\"name\":\"$PROJECT_NAME\",\"client_name\":\"Smoke Client\",\"pm_user_id\":$ADMIN_ID,\"is_overhead\":false}")"
expect_code 200 "$code" "create project"
PROJECT_ID="$(json_num_field id "$TMP_DIR/project.json")"
[[ -n "$PROJECT_ID" ]] || fail "project id parse failed"

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/task.json" -w "%{http_code}" \
  -X POST "$BASE_URL/projects/$PROJECT_ID/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Design"}')"
expect_code 200 "$code" "create task"
TASK_ID="$(json_num_field id "$TMP_DIR/task.json")"
[[ -n "$TASK_ID" ]] || fail "task id parse failed"

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/subtask.json" -w "%{http_code}" \
  -X POST "$BASE_URL/tasks/$TASK_ID/subtasks" \
  -H 'Content-Type: application/json' \
  --data '{"code":"SMK-01","name":"Smoke Subtask","budget_hours":8,"budget_fee":1200}')"
expect_code 200 "$code" "create subtask"
SUBTASK_ID="$(json_num_field id "$TMP_DIR/subtask.json")"
[[ -n "$SUBTASK_ID" ]] || fail "subtask id parse failed"

echo "[6/10] Rate + time entry"
code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/rate.json" -w "%{http_code}" \
  -X POST "$BASE_URL/rates" \
  -H 'Content-Type: application/json' \
  --data "{\"user_id\":$TEST_USER_ID,\"effective_date\":\"$TODAY\",\"bill_rate\":190,\"cost_rate\":115}")"
expect_code 200 "$code" "upsert rate"

code="$(curl -sS -b "$USER_COOKIE" -o "$TMP_DIR/time_entry.json" -w "%{http_code}" \
  -X POST "$BASE_URL/time-entries" \
  -H 'Content-Type: application/json' \
  --data "{\"project_id\":$PROJECT_ID,\"task_id\":$TASK_ID,\"subtask_id\":$SUBTASK_ID,\"work_date\":\"$TODAY\",\"hours\":2.5,\"note\":\"Smoke test entry\"}")"
expect_code 200 "$code" "create time entry"

echo "[7/10] Timesheet generate/submit/approve"
week_start="$(date -d "$TODAY -$(( $(date -d "$TODAY" +%u) - 1 )) days" +%F)"
code="$(curl -sS -b "$USER_COOKIE" -o "$TMP_DIR/sheet_generate.json" -w "%{http_code}" \
  -X POST "$BASE_URL/timesheets/generate?week_start=$week_start")"
expect_code 200 "$code" "generate timesheet"
SHEET_ID="$(json_num_field id "$TMP_DIR/sheet_generate.json")"
[[ -n "$SHEET_ID" ]] || fail "timesheet id parse failed"

code="$(curl -sS -b "$USER_COOKIE" -o "$TMP_DIR/sheet_submit.json" -w "%{http_code}" \
  -X POST "$BASE_URL/timesheets/$SHEET_ID/submit")"
expect_code 200 "$code" "submit timesheet"

code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/sheet_approve.json" -w "%{http_code}" \
  -X POST "$BASE_URL/timesheets/$SHEET_ID/approve")"
expect_code 200 "$code" "approve timesheet"

echo "[8/10] Accounting import preview"
cat > "$TMP_DIR/smoke_accounting.csv" <<'CSV'
Date,Description,Amount
2026-02-12,POS ONLINE Home Depot #1234,-245.67
CSV
code="$(curl -sS -b "$ADMIN_COOKIE" -o "$TMP_DIR/import_preview.json" -w "%{http_code}" \
  -X POST "$BASE_URL/accounting/import-preview?account_id=$ACCOUNT_ID" \
  -F "file=@$TMP_DIR/smoke_accounting.csv;type=text/csv")"
expect_code 200 "$code" "accounting import preview"

echo "[9/10] Pay period endpoint"
code="$(curl -sS -o "$TMP_DIR/pay_period.json" -w "%{http_code}" \
  "$BASE_URL/timeframes/pay-period?date_str=$TODAY")"
expect_code 200 "$code" "pay period"

echo "[10/10] Complete"
echo "PASS: Smoke test complete"
echo "admin_email=$ADMIN_EMAIL"
echo "test_user_email=$TEST_EMAIL"
echo "project_id=$PROJECT_ID task_id=$TASK_ID subtask_id=$SUBTASK_ID sheet_id=$SHEET_ID"
