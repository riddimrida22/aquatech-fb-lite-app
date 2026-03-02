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

# Ensure HTTPS port is free before compose starts caddy.
V2_CADDY_NAME="${PROJECT_NAME}-caddy-1"
PORT_443_OWNERS="$(docker ps --filter publish=443 --format '{{.ID}} {{.Names}}')"
if [ -n "$PORT_443_OWNERS" ]; then
  echo "Detected containers using 443:"
  echo "$PORT_443_OWNERS"
fi
if [ "$FORCE_TAKEOVER_443" = "true" ] && [ -n "$PORT_443_OWNERS" ]; then
  echo "FORCE_TAKEOVER_443=true: clearing all running containers bound to 443"
  echo "$PORT_443_OWNERS" | while IFS=' ' read -r OWNER_ID OWNER_NAME; do
    [ -n "$OWNER_ID" ] || continue
    echo "Stopping/removing '$OWNER_NAME' ($OWNER_ID)"
    docker stop "$OWNER_ID" >/dev/null 2>&1 || true
    docker rm "$OWNER_ID" >/dev/null 2>&1 || true
  done
  PORT_443_OWNERS="$(docker ps --filter publish=443 --format '{{.Names}}')"
fi
if [ -n "$PORT_443_OWNERS" ]; then
  echo "FAIL: port 443 is still in use by:"
  echo "$PORT_443_OWNERS"
  echo "Unable to continue deploy safely."
  exit 1
fi

# Handle non-container listeners on 443 (e.g. host nginx/caddy).
PORT_443_HOST_LISTENERS=""
if command -v ss >/dev/null 2>&1; then
  PORT_443_HOST_LISTENERS="$(ss -ltn 2>/dev/null | awk 'NR>1 && $4 ~ /:443$/ {print $0}')"
fi
if [ -n "$PORT_443_HOST_LISTENERS" ]; then
  echo "Detected host listeners on 443:"
  echo "$PORT_443_HOST_LISTENERS"
  if [ "$FORCE_TAKEOVER_443" = "true" ]; then
    echo "FORCE_TAKEOVER_443=true: attempting to free host port 443"
    if command -v sudo >/dev/null 2>&1; then
      sudo -n systemctl stop nginx caddy apache2 traefik >/dev/null 2>&1 || true
      sudo -n fuser -k 443/tcp >/dev/null 2>&1 || true
    fi
    if command -v fuser >/dev/null 2>&1; then
      fuser -k 443/tcp >/dev/null 2>&1 || true
    fi
    if command -v pkill >/dev/null 2>&1; then
      pkill -f 'nginx|caddy|traefik|apache2' >/dev/null 2>&1 || true
    fi
    if command -v ss >/dev/null 2>&1; then
      PORT_443_HOST_LISTENERS="$(ss -ltn 2>/dev/null | awk 'NR>1 && $4 ~ /:443$/ {print $0}')"
    else
      PORT_443_HOST_LISTENERS=""
    fi
  fi
fi
if [ -n "$PORT_443_HOST_LISTENERS" ]; then
  echo "FAIL: host port 443 is still busy after takeover attempts."
  echo "$PORT_443_HOST_LISTENERS"
  exit 1
fi

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
