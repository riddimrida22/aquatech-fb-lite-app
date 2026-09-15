#!/bin/sh
set -eu

ts="$(date +%Y%m%d_%H%M%S)"
out_dir="/backups"
out_file="$out_dir/fblite_${ts}.sql.gz"
retention_days="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$out_dir"

# Nightly business-data backup.
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
echo "[$(date -Iseconds)] Starting PostgreSQL backup (business data, excl. library_documents) -> $out_file"
pg_dump \
  -h "${POSTGRES_HOST:-db}" \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fblite}" \
  --no-owner \
  --no-privileges \
  --exclude-table-data=library_documents \
  | gzip -c > "$out_file"

echo "[$(date -Iseconds)] Backup completed."

find "$out_dir" -type f -name "fblite_*.sql.gz" -mtime "+$retention_days" -delete
echo "[$(date -Iseconds)] Old backups pruned (>${retention_days} days)."
