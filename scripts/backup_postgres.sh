#!/bin/sh
# Nightly business-data backup (run by the db-backup container every 24 h).
#
# A failed or empty dump must never look like a good one (three empty 20-byte dumps from
# Feb 2026 are what an unchecked `pg_dump | gzip` produced), and old backups are pruned only
# after tonight's backup is verified. Each run records its outcome in audit_events
# (entity_type 'backup', action 'backup_ok' / 'backup_failed'), which the Data Health page
# checks, so a missed or failed night shows up in the app.
#
# We EXCLUDE the data of `library_documents` (the BD proposal Vault): it holds
# ~1.3 GB of static document blobs that never change and are fully reproducible
# from the shared drive via backend/seed_bd_library.py. Dumping it nightly made
# every backup ~1.4 GB and filled the 20 GB disk in a few days, crashing
# Postgres in a checkpoint PANIC loop. Excluding it keeps the nightly dump ~50 MB
# while retaining the table's schema (so a restore recreates the empty table).
#
# The Vault's own bytes are preserved separately in a standing full snapshot
# (backups/vault_full_reference_*.sql.gz) and can always be re-seeded from the
# shared drive. Refresh that reference after a material Vault change:
#   docker-compose -f docker-compose.prod.yml exec -T db \
#     pg_dump -U postgres -d fblite --no-owner --no-privileges \
#     --table=library_documents | gzip > backups/vault_full_reference_$(date +%Y%m%d).sql.gz
set -eu

ts="$(date +%Y%m%d_%H%M%S)"
out_dir="/backups"
out_file="$out_dir/fblite_${ts}.sql.gz"
tmp_file="$out_dir/.fblite_${ts}.sql.partial"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
keep_min="${BACKUP_KEEP_MIN:-7}"   # never prune below this many good backups
PGHOST="${POSTGRES_HOST:-db}"
PGUSER="${POSTGRES_USER:-postgres}"
PGDB="${POSTGRES_DB:-fblite}"

mkdir -p "$out_dir"

record() {  # record <action> <detail>: best effort, never fails the script
  psql -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -q -v ON_ERROR_STOP=1 \
    -c "INSERT INTO audit_events (entity_type, entity_id, action, actor_user_id, payload_json, created_at)
        VALUES ('backup', 0, '$1', NULL, '{\"detail\": \"$2\"}', NOW() AT TIME ZONE 'UTC')" \
    >/dev/null 2>&1 || echo "[$(date -Iseconds)] (could not record '$1' in audit_events)"
}

fail() {
  echo "[$(date -Iseconds)] BACKUP FAILED: $1"
  rm -f "$tmp_file"
  record backup_failed "$1"
  exit 1
}

echo "[$(date -Iseconds)] Starting PostgreSQL backup (business data, excl. library_documents) -> $out_file"
pg_dump \
  -h "$PGHOST" \
  -U "$PGUSER" \
  -d "$PGDB" \
  --no-owner \
  --no-privileges \
  --exclude-table-data=library_documents \
  > "$tmp_file" || fail "pg_dump exited with an error"

[ -s "$tmp_file" ] || fail "pg_dump produced an empty file"
tail -n 5 "$tmp_file" | grep -q "PostgreSQL database dump complete" || fail "dump is incomplete (no completion marker)"

gzip -c "$tmp_file" > "$out_file" || fail "gzip failed"
gzip -t "$out_file" || fail "compressed file failed its integrity test"
rm -f "$tmp_file"
size="$(wc -c < "$out_file" | tr -d ' ')"
echo "[$(date -Iseconds)] Backup completed and verified ($size bytes)."
record backup_ok "$(basename "$out_file") $size bytes"

# Prune only after a verified backup, and never below keep_min backups.
count="$(find "$out_dir" -maxdepth 1 -type f -name 'fblite_*.sql.gz' | wc -l | tr -d ' ')"
if [ "$count" -gt "$keep_min" ]; then
  find "$out_dir" -maxdepth 1 -type f -name "fblite_*.sql.gz" -mtime "+$retention_days" -delete
  echo "[$(date -Iseconds)] Old backups pruned (>${retention_days} days, keeping at least $keep_min)."
fi
