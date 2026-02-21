#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-bertrand.byrne@aquatechpc.com}"
TODAY="${TODAY:-$(date +%F)}"

ADMIN_COOKIE="$(mktemp)"
TMP_DIR="$(mktemp -d)"
trap 'rm -f "$ADMIN_COOKIE"; rm -rf "$TMP_DIR"' EXIT

post_json() {
  local cookie="$1"
  local path="$2"
  local body="$3"
  curl -sS -b "$cookie" -c "$cookie" -H 'Content-Type: application/json' -X POST "$BASE_URL$path" --data "$body"
}

post_json_no_cookie() {
  local path="$1"
  local body="$2"
  curl -sS -H 'Content-Type: application/json' -X POST "$BASE_URL$path" --data "$body"
}

user_id_by_email() {
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

json_num_field() {
  local key="$1"
  local file="$2"
  sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\1/p" "$file" | head -n1
}

calc_cost_rate() {
  local bill="$1"
  awk -v b="$bill" 'BEGIN { printf "%.2f", b * 0.40 }'
}

echo "Admin login..."
curl -sS -c "$ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/auth/dev/login" --data "{\"email\":\"$ADMIN_EMAIL\"}" > "$TMP_DIR/admin_login.json"

WEEK_START="$(date -d "$TODAY -6 days" +%F)"
D0="$WEEK_START"
D1="$(date -d "$WEEK_START +1 day" +%F)"
D2="$(date -d "$WEEK_START +2 day" +%F)"
D3="$(date -d "$WEEK_START +3 day" +%F)"

declare -A EMP_BILL
EMP_BILL["rob.placeholder@aquatechpc.com"]="144.77"
EMP_BILL["zach.placeholder@aquatechpc.com"]="123.02"
EMP_BILL["stacey.placeholder@aquatechpc.com"]="121.56"
EMP_BILL["ailsa.welch@aquatechpc.com"]="176.55"

EMP_EMAILS=(
  "rob.placeholder@aquatechpc.com"
  "zach.placeholder@aquatechpc.com"
  "stacey.placeholder@aquatechpc.com"
  "ailsa.welch@aquatechpc.com"
)

echo "Ensuring employees exist and are active..."
for email in "${EMP_EMAILS[@]}"; do
  post_json_no_cookie "/auth/dev/login" "{\"email\":\"$email\"}" > /dev/null || true
done

curl -sS -b "$ADMIN_COOKIE" "$BASE_URL/users/pending" > "$TMP_DIR/pending.json"
for email in "${EMP_EMAILS[@]}"; do
  pending_id="$(user_id_by_email "$email" "$TMP_DIR/pending.json" || true)"
  if [[ -n "${pending_id:-}" ]]; then
    post_json "$ADMIN_COOKIE" "/users/$pending_id/activate" "{}" > /dev/null
  fi
done

curl -sS -b "$ADMIN_COOKIE" "$BASE_URL/users" > "$TMP_DIR/users.json"

declare -A EMP_ID
for email in "${EMP_EMAILS[@]}"; do
  id="$(user_id_by_email "$email" "$TMP_DIR/users.json")"
  EMP_ID["$email"]="$id"
  bill="${EMP_BILL[$email]}"
  cost="$(calc_cost_rate "$bill")"
  post_json "$ADMIN_COOKIE" "/rates" "{\"user_id\":$id,\"effective_date\":\"$WEEK_START\",\"bill_rate\":$bill,\"cost_rate\":$cost}" > /dev/null
done

PROJECTS=(
  "Placeholder Project Alpha"
  "Placeholder Project Bravo"
  "Placeholder Project Charlie"
  "Placeholder Project Delta"
)

TASKS=(
  "Planning"
  "Field Work"
  "Modeling"
  "Reporting"
)

TASK_CODES=("PLN" "FLD" "MOD" "RPT")

declare -A PROJECT_ID
declare -A FIRST_TASK_ID
declare -A FIRST_SUBTASK_ID

ADMIN_ID="$(user_id_by_email "$ADMIN_EMAIL" "$TMP_DIR/users.json")"

echo "Creating placeholder projects/tasks/subtasks..."
for p in "${PROJECTS[@]}"; do
  p_resp="$TMP_DIR/project_$(echo "$p" | tr ' ' '_' | tr '[:upper:]' '[:lower:]').json"
  post_json "$ADMIN_COOKIE" "/projects" "{\"name\":\"$p\",\"client_name\":\"Placeholder Client\",\"pm_user_id\":$ADMIN_ID,\"is_overhead\":false}" > "$p_resp"
  pid="$(json_num_field id "$p_resp")"
  PROJECT_ID["$p"]="$pid"

  i=0
  for task in "${TASKS[@]}"; do
    t_resp="$TMP_DIR/task_${pid}_${i}.json"
    post_json "$ADMIN_COOKIE" "/projects/$pid/tasks" "{\"name\":\"$task\"}" > "$t_resp"
    tid="$(json_num_field id "$t_resp")"
    s_resp="$TMP_DIR/subtask_${pid}_${i}.json"
    code="${TASK_CODES[$i]}-$(printf "%02d" $((i + 1)))"
    post_json "$ADMIN_COOKIE" "/tasks/$tid/subtasks" "{\"code\":\"$code\",\"name\":\"$task Placeholder\",\"budget_hours\":120,\"budget_fee\":12000}" > "$s_resp"
    sid="$(json_num_field id "$s_resp")"
    if [[ "$i" -eq 0 ]]; then
      FIRST_TASK_ID["$p"]="$tid"
      FIRST_SUBTASK_ID["$p"]="$sid"
    fi
    i=$((i + 1))
  done
done

echo "Adding last-week entries for each employee across each project..."
declare -A HOURS_ROB=( ["Placeholder Project Alpha"]="8.0" ["Placeholder Project Bravo"]="7.0" ["Placeholder Project Charlie"]="6.0" ["Placeholder Project Delta"]="5.0" )
declare -A HOURS_ZACH=( ["Placeholder Project Alpha"]="7.0" ["Placeholder Project Bravo"]="6.0" ["Placeholder Project Charlie"]="5.0" ["Placeholder Project Delta"]="4.0" )
declare -A HOURS_STACEY=( ["Placeholder Project Alpha"]="6.0" ["Placeholder Project Bravo"]="5.0" ["Placeholder Project Charlie"]="4.0" ["Placeholder Project Delta"]="3.0" )
declare -A HOURS_AILSA=( ["Placeholder Project Alpha"]="5.0" ["Placeholder Project Bravo"]="4.0" ["Placeholder Project Charlie"]="3.0" ["Placeholder Project Delta"]="2.0" )

for email in "${EMP_EMAILS[@]}"; do
  user_cookie="$TMP_DIR/$(echo "$email" | tr '@.' '__').cookie"
  curl -sS -c "$user_cookie" -H 'Content-Type: application/json' -X POST "$BASE_URL/auth/dev/login" --data "{\"email\":\"$email\"}" > /dev/null

  for project in "${PROJECTS[@]}"; do
    pid="${PROJECT_ID[$project]}"
    tid="${FIRST_TASK_ID[$project]}"
    sid="${FIRST_SUBTASK_ID[$project]}"
    case "$email" in
      rob.placeholder@aquatechpc.com)
        hrs="${HOURS_ROB[$project]}"
        ;;
      zach.placeholder@aquatechpc.com)
        hrs="${HOURS_ZACH[$project]}"
        ;;
      stacey.placeholder@aquatechpc.com)
        hrs="${HOURS_STACEY[$project]}"
        ;;
      *)
        hrs="${HOURS_AILSA[$project]}"
        ;;
    esac
    case "$project" in
      "Placeholder Project Alpha") d="$D0" ;;
      "Placeholder Project Bravo") d="$D1" ;;
      "Placeholder Project Charlie") d="$D2" ;;
      *) d="$D3" ;;
    esac
    curl -sS -b "$user_cookie" -H 'Content-Type: application/json' -X POST "$BASE_URL/time-entries" \
      --data "{\"project_id\":$pid,\"task_id\":$tid,\"subtask_id\":$sid,\"work_date\":\"$d\",\"hours\":$hrs,\"note\":\"Placeholder seeded entry\"}" \
      > /dev/null
  done
done

echo "Seeding complete."
echo "Week range: $WEEK_START to $TODAY"
for email in "${EMP_EMAILS[@]}"; do
  bill="${EMP_BILL[$email]}"
  cost="$(calc_cost_rate "$bill")"
  echo "  $email -> bill=$bill cost=$cost (40%)"
done
