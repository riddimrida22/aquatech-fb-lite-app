#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE_INPUT="${1:-.env.prod}"
if [[ "${ENV_FILE_INPUT}" = /* ]]; then
  ENV_FILE="${ENV_FILE_INPUT}"
else
  ENV_FILE="${ROOT_DIR}/${ENV_FILE_INPUT}"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: env file not found: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-fblite}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
if [[ -z "$POSTGRES_PASSWORD" ]]; then
  echo "FAIL: POSTGRES_PASSWORD is required in $ENV_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker not found"
  exit 1
fi

ts="$(date +%Y%m%d_%H%M%S)"
tmp_name="aq-drill-${ts}"
trap 'docker rm -f "$tmp_name" >/dev/null 2>&1 || true' EXIT

echo "[1/6] Creating fresh backup snapshot"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T db-backup /scripts/backup_postgres.sh >/tmp/aq_drill_backup.log 2>&1 || {
  cat /tmp/aq_drill_backup.log
  echo "FAIL: backup step failed"
  exit 1
}

latest_backup="$(ls -1t backups/fblite_*.sql.gz 2>/dev/null | head -n 1 || true)"
if [[ -z "$latest_backup" ]]; then
  echo "FAIL: no backup file found under backups/"
  exit 1
fi
echo "Using backup: $latest_backup"

echo "[2/6] Validating backup archive integrity"
gunzip -t "$latest_backup"

echo "[3/6] Starting isolated drill database container"
docker run -d --name "$tmp_name" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB="$POSTGRES_DB" postgres:16 >/dev/null

for i in $(seq 1 30); do
  if docker exec "$tmp_name" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 30 ]]; then
    echo "FAIL: drill database did not become ready"
    exit 1
  fi
done

echo "[4/6] Restoring backup into isolated drill database"
gunzip -c "$latest_backup" | docker exec -i "$tmp_name" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/tmp/aq_drill_restore.log 2>&1 || {
  tail -n 120 /tmp/aq_drill_restore.log || true
  echo "FAIL: restore failed"
  exit 1
}

echo "[5/6] Running restore verification queries"
verify_sql="
SELECT 'users' AS table_name, COUNT(*)::text AS row_count FROM users
UNION ALL
SELECT 'projects', COUNT(*)::text FROM projects
UNION ALL
SELECT 'time_entries', COUNT(*)::text FROM time_entries
UNION ALL
SELECT 'invoices', COUNT(*)::text FROM invoices;
"
docker exec -i "$tmp_name" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "$verify_sql" | sed 's/|/ = /g'

echo "[6/6] Drill cleanup"
docker rm -f "$tmp_name" >/dev/null
trap - EXIT

echo "PASS: disaster recovery restore drill completed"
