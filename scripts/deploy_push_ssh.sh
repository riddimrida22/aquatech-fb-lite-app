#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEPLOY_ENV_FILE="${1:-.env.deploy}"

if [[ ! -f "$DEPLOY_ENV_FILE" ]]; then
  echo "Missing deploy env file: $DEPLOY_ENV_FILE"
  echo "Copy .env.deploy.example to $DEPLOY_ENV_FILE and set values first."
  exit 1
fi

# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"

required_vars=(
  DEPLOY_SSH_HOST
  DEPLOY_SSH_USER
  DEPLOY_SERVER_DIR
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing required variable in $DEPLOY_ENV_FILE: $v"
    exit 1
  fi
done

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_REBUILD_CMD="${DEPLOY_REBUILD_CMD:-sudo docker-compose up -d --build}"
DEPLOY_VERIFY_URL="${DEPLOY_VERIFY_URL:-https://app.aquatechpc.com}"
RUN_TESTS_BEFORE_PUSH="${RUN_TESTS_BEFORE_PUSH:-false}"

if [[ "$RUN_TESTS_BEFORE_PUSH" == "true" ]]; then
  echo "Running pre-deploy gate..."
  ./scripts/pre_deploy_gate.sh
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has uncommitted changes."
  echo "Commit or stash before running deploy_push_ssh.sh."
  exit 1
fi

echo "Pushing ${DEPLOY_BRANCH} to ${DEPLOY_REMOTE}..."
git push "${DEPLOY_REMOTE}" "${DEPLOY_BRANCH}"

echo "Deploying on ${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}..."
ssh -o BatchMode=yes "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "
  set -euo pipefail
  cd '${DEPLOY_SERVER_DIR}'
  git fetch '${DEPLOY_REMOTE}'
  git checkout '${DEPLOY_BRANCH}'
  git pull '${DEPLOY_REMOTE}' '${DEPLOY_BRANCH}'
  ${DEPLOY_REBUILD_CMD}
  curl -I --max-time 20 '${DEPLOY_VERIFY_URL}'
  git rev-parse --short HEAD
  git rev-parse --short '${DEPLOY_REMOTE}/${DEPLOY_BRANCH}'
"

echo "Deploy complete."
