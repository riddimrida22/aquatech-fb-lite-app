#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_COMMIT="${1:-}"
ENV_FILE="${2:-.env.prod}"
RUN_GATE="${RUN_GATE:-true}"
STATE_FILE="${STATE_FILE:-.deploy_state}"

if [[ -z "$TARGET_COMMIT" ]]; then
  echo "Usage: $0 <target_commit> [env_file]"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: env file not found: $ENV_FILE"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "FAIL: git not found"
  exit 1
fi

current_commit="$(git rev-parse HEAD)"

# Ensure target exists locally or can be fetched.
git fetch --all --tags --prune >/dev/null 2>&1 || true
if ! git rev-parse --verify "$TARGET_COMMIT^{commit}" >/dev/null 2>&1; then
  echo "FAIL: target commit not found: $TARGET_COMMIT"
  exit 1
fi

target_full="$(git rev-parse "$TARGET_COMMIT^{commit}")"
current_full="$(git rev-parse HEAD)"

if [[ "$target_full" == "$current_full" ]]; then
  echo "Info: already on target commit $target_full"
else
  echo "Checking out target commit $target_full"
  git checkout "$target_full"
fi

set +e
RUN_GATE="$RUN_GATE" ./scripts/deploy_prod.sh "$ENV_FILE"
deploy_rc=$?
set -e

if (( deploy_rc != 0 )); then
  echo "Deploy failed on target commit; restoring previous checkout $current_commit"
  git checkout "$current_commit" >/dev/null 2>&1 || true
  exit $deploy_rc
fi

cat > "$STATE_FILE" <<EOF
CURRENT_COMMIT=$target_full
PREVIOUS_COMMIT=$current_full
LAST_DEPLOYED_AT=$(date -Iseconds)
LAST_ENV_FILE=$ENV_FILE
EOF

echo "PASS: deployed $target_full"
echo "State written to $STATE_FILE"
