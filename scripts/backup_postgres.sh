#!/bin/sh
set -eu

ts="$(date +%Y%m%d_%H%M%S)"
out_dir="/backups"
out_file="$out_dir/fblite_${ts}.sql.gz"
retention_days="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$out_dir"

echo "[$(date -Iseconds)] Starting PostgreSQL backup -> $out_file"
pg_dump \
  -h "${POSTGRES_HOST:-db}" \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fblite}" \
  --no-owner \
  --no-privileges \
  | gzip -c > "$out_file"

echo "[$(date -Iseconds)] Backup completed."

find "$out_dir" -type f -name "fblite_*.sql.gz" -mtime "+$retention_days" -delete
echo "[$(date -Iseconds)] Old backups pruned (>${retention_days} days)."
