#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR" | tr '[:upper:]' '[:lower:]')}"
FORCE_TAKEOVER_443="${FORCE_TAKEOVER_443:-false}"

ENV_FILE="${1:-.env.prod}"
RUN_GATE="${RUN_GATE:-true}"

case "$ENV_FILE" in
  /*) ENV_FILE_PATH="$ENV_FILE" ;;
  *) ENV_FILE_PATH="$ROOT_DIR/$ENV_FILE" ;;
esac

if [ ! -f "$ENV_FILE_PATH" ]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create it from .env.prod template first."
  exit 1
fi

echo "Using env file: $ENV_FILE"

if [ "$RUN_GATE" = "true" ]; then
  echo "Running pre-deploy quality gate..."
  ./scripts/pre_deploy_gate.sh "$ENV_FILE_PATH"
fi

# Ensure HTTPS port is either free or held by this project's caddy container.
V1_CADDY_NAME="${PROJECT_NAME}_caddy_1"
V2_CADDY_NAME="${PROJECT_NAME}-caddy-1"
for OWNER in $(docker ps --filter publish=443 --format '{{.Names}}'); do
  if [ "$OWNER" = "$V1_CADDY_NAME" ] || [ "$OWNER" = "$V2_CADDY_NAME" ]; then
    continue
  fi
  if [ "$FORCE_TAKEOVER_443" = "true" ]; then
    echo "Port 443 owned by '$OWNER'; stopping it due to FORCE_TAKEOVER_443=true"
    docker stop "$OWNER" >/dev/null 2>&1 || true
    docker rm "$OWNER" >/dev/null 2>&1 || true
    continue
  fi
  echo "FAIL: port 443 is already in use by container '$OWNER'."
  echo "Set FORCE_TAKEOVER_443=true to stop/remove that container during deploy."
  exit 1
done

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file "$ENV_FILE_PATH" -f docker-compose.prod.yml up -d --build
  docker compose --env-file "$ENV_FILE_PATH" -f docker-compose.prod.yml ps
elif command -v docker-compose >/dev/null 2>&1; then
  # Legacy docker-compose path on older hosts.
  # Clear stale Compose v2 caddy container name to avoid 443 bind conflicts.
  if docker ps -a --format '{{.Names}}' | grep -Fx "$V2_CADDY_NAME" >/dev/null 2>&1; then
    echo "Removing stale container: $V2_CADDY_NAME"
    docker stop "$V2_CADDY_NAME" >/dev/null 2>&1 || true
    docker rm "$V2_CADDY_NAME" >/dev/null 2>&1 || true
  fi
  # Source env file with nounset disabled to avoid failures on optional expansions.
  set +u
  set -a
  . "$ENV_FILE_PATH"
  set +a
  set -u
  docker-compose -f docker-compose.prod.yml up -d --build
  docker-compose -f docker-compose.prod.yml ps
else
  echo "FAIL: neither 'docker compose' nor 'docker-compose' is available on this host."
  exit 1
fi
