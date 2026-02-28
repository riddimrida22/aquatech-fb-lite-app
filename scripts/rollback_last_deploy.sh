#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.prod}"
STATE_FILE="${STATE_FILE:-.deploy_state}"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "FAIL: deploy state file not found: $STATE_FILE"
  echo "Run a deploy using scripts/deploy_from_commit.sh first."
  exit 1
fi

# shellcheck disable=SC1090
source "$STATE_FILE"

if [[ -z "${PREVIOUS_COMMIT:-}" ]]; then
  echo "FAIL: PREVIOUS_COMMIT is empty in $STATE_FILE"
  exit 1
fi

echo "Rolling back to previous commit: $PREVIOUS_COMMIT"
RUN_GATE=false ./scripts/deploy_from_commit.sh "$PREVIOUS_COMMIT" "$ENV_FILE"

echo "PASS: rollback completed"
