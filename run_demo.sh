#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AqtPM MARKETING DEMO launcher.
#
# Spins up a self-contained demo tenant — fictitious "Pinnacle Engineering P.C."
# with fabricated numbers — while keeping ALL app functionality intact. Used to
# showcase profit tracking, timekeeping<->payroll integration, and expense
# tracking, and as a sandbox to try new ideas. NOTHING here touches prod or any
# real-data DB: it uses its own throwaway SQLite file (demo_aquatech.db).
#
# Usage:   bash run_demo.sh          # (re)seed + start backend :8000 + frontend :3012
#          bash run_demo.sh --no-seed   # start only, keep existing demo data
#
# Then open http://localhost:3012  and click "Enter AqtPM" (dev auth, no Google).
# ---------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
INBOX="$ROOT/backend/demo_inbox_empty"   # empty => company P&L labor COGS comes
mkdir -p "$INBOX"                        # from in-app payroll runs (the integration)

# Fictitious reasonable-comp hourly rates (surname -> $/hr) feeding the overhead /
# daily-profitability engines. Matches the roster in backend/seed_demo.py.
DEMO_SALARY='{"okafor":96,"reilly":74,"nair":58,"brooks":45,"mendes":41,"liu":36}'

# Enable the "Ask AqtPM" assistant by sourcing ANTHROPIC_API_KEY from the repo-root
# .env (kept out of git). Never echoed. If absent, Ask degrades gracefully.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  _k=$(grep -E "^\s*ANTHROPIC_API_KEY\s*=" "$ROOT/.env" | head -1 | cut -d= -f2-)
  _k="${_k%\"}"; _k="${_k#\"}"; _k="${_k%\'}"; _k="${_k#\'}"
  export ANTHROPIC_API_KEY="$_k"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "[demo] Ask AqtPM: API key loaded (len=${#ANTHROPIC_API_KEY})"; else echo "[demo] Ask AqtPM: no key (assistant disabled)"; fi

kill_port() { # $1 = port
  local pid
  pid=$(netstat -ano | grep ":$1" | grep LISTENING | awk '{print $NF}' | head -1 || true)
  [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1 && echo "  stopped :$1 (pid $pid)" || true
}

echo "[demo] stopping any existing servers..."
kill_port 8000; kill_port 3012

if [ "${1:-}" != "--no-seed" ]; then
  echo "[demo] seeding demo_aquatech.db (Pinnacle Engineering P.C.)..."
  ( cd "$ROOT/backend" && DATABASE_URL="sqlite:///./demo_aquatech.db" DEMO_DOMAIN="pinnacle-eng.com" \
      .venv-win/Scripts/python.exe seed_demo.py | grep -E "SEEDED|login" )
fi

echo "[demo] starting backend on :8000..."
( cd "$ROOT/backend" && \
  DATABASE_URL="sqlite:///./demo_aquatech.db" \
  DEV_AUTH_BYPASS=true \
  ALLOWED_GOOGLE_DOMAIN="pinnacle-eng.com" \
  FRESHBOOKS_SYNC_ENABLED=false \
  FRESHBOOKS_TRANSITION_DIR="$INBOX" \
  DEMO_SALARY_RATES_JSON="$DEMO_SALARY" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  .venv-win/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  > "$ROOT/backend/demo_backend.log" 2>&1 & )

echo "[demo] starting frontend on :3012..."
( cd "$ROOT/frontend" && \
  BACKEND_INTERNAL_BASE="http://127.0.0.1:8000" \
  NEXT_PUBLIC_DEV_AUTH_BYPASS=true \
  NEXT_PUBLIC_DEV_LOGIN_EMAIL="dana.okafor@pinnacle-eng.com" \
  NEXT_PUBLIC_TENANT_NAME="Pinnacle Engineering P.C." \
  NEXT_PUBLIC_TENANT_TAGLINE="Profit, time & payroll — built for engineering firms." \
  NEXT_PUBLIC_HIDE_GOVERNANCE=true \
  npm run dev -- -p 3012 \
  > "$ROOT/frontend/demo_frontend.log" 2>&1 & )

echo "[demo] launching. Backend log: backend/demo_backend.log  Frontend log: frontend/demo_frontend.log"
echo "[demo] open http://localhost:3012  (admin: dana.okafor@pinnacle-eng.com)"
