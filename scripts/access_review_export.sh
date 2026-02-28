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

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker not found"
  exit 1
fi

ts="$(date +%Y%m%d_%H%M%S)"
out_dir="docs/compliance"
out_file="$out_dir/access_review_${ts}.csv"
mkdir -p "$out_dir"

sql="
COPY (
  SELECT
    u.id,
    u.email,
    u.full_name,
    u.role,
    u.is_active,
    COALESCE(u.start_date::text, '') AS start_date,
    COALESCE(u.created_at::text, '') AS created_at
  FROM users u
  ORDER BY u.is_active DESC, u.role, u.email
) TO STDOUT WITH CSV HEADER;
"

echo "Generating access review export -> $out_file"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T db \
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-fblite}" -v ON_ERROR_STOP=1 -c "$sql" > "$out_file"

echo "PASS: wrote $out_file"
