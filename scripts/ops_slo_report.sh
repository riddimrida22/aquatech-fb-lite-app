#!/usr/bin/env bash
set -euo pipefail

APP_BASE_URL="${APP_BASE_URL:-https://app.aquatechpc.com}"
API_BASE_URL="${API_BASE_URL:-https://app.aquatechpc.com/api}"
LATENCY_BUDGET_MS="${LATENCY_BUDGET_MS:-2500}"
OUT_DIR="${OUT_DIR:-docs/ops}"

mkdir -p "$OUT_DIR"
ts="$(date +%Y%m%d_%H%M%S)"
out_file="$OUT_DIR/slo_report_${ts}.json"

probe() {
  local name="$1"
  local url="$2"
  local expect_prefix="$3"

  local raw code latency_s latency_ms ok
  raw="$(curl -sS -o /tmp/aq_slo_body.$$ -w '%{http_code} %{time_total}' "$url" || echo '000 99')"
  code="${raw%% *}"
  latency_s="${raw##* }"
  latency_ms="$(awk -v s="$latency_s" 'BEGIN { printf("%d", s*1000) }')"

  ok=true
  if [[ "$code" != $expect_prefix* ]]; then
    ok=false
  fi
  if (( latency_ms > LATENCY_BUDGET_MS )); then
    ok=false
  fi

  printf '{"name":"%s","url":"%s","status_code":%s,"latency_ms":%s,"ok":%s}' \
    "$name" "$url" "$code" "$latency_ms" "$ok"
}

p1="$(probe "frontend_home" "$APP_BASE_URL" "2")"
p2="$(probe "backend_health" "$API_BASE_URL/health" "2")"
p3="$(probe "google_login_redirect" "$API_BASE_URL/auth/google/login" "3")"

overall=true
for p in "$p1" "$p2" "$p3"; do
  if [[ "$p" == *'"ok":false'* ]]; then
    overall=false
  fi
done

cat > "$out_file" <<EOF
{
  "generated_at": "$(date -Iseconds)",
  "app_base_url": "${APP_BASE_URL}",
  "api_base_url": "${API_BASE_URL}",
  "latency_budget_ms": ${LATENCY_BUDGET_MS},
  "overall_ok": ${overall},
  "checks": [
    ${p1},
    ${p2},
    ${p3}
  ]
}
EOF

cat "$out_file"

if [[ "$overall" != "true" ]]; then
  echo "FAIL: SLO report not within target"
  exit 1
fi

echo "PASS: SLO report written to $out_file"
