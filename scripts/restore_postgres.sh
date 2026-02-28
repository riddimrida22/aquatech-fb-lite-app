#!/bin/sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <backup_file.sql.gz>"
  exit 1
fi

backup_file="$1"
if [ ! -f "$backup_file" ]; then
  echo "Backup file not found: $backup_file"
  exit 1
fi

echo "[$(date -Iseconds)] Restoring PostgreSQL from $backup_file"

gunzip -c "$backup_file" | psql \
  -h "${POSTGRES_HOST:-db}" \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fblite}"

echo "[$(date -Iseconds)] Restore completed."
