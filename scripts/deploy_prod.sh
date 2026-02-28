#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-.env.prod}"
RUN_GATE="${RUN_GATE:-true}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create it from .env.prod template first."
  exit 1
fi

echo "Using env file: $ENV_FILE"

if [ "$RUN_GATE" = "true" ]; then
  echo "Running pre-deploy quality gate..."
  ./scripts/pre_deploy_gate.sh "$ENV_FILE"
fi

docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml up -d --build
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml ps
