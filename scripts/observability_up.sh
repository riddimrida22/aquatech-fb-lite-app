#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/configure_alertmanager.sh

docker compose -f deployment/observability/docker-compose.observability.yml up -d

echo "Observability stack started."
echo "Grafana: http://localhost:3001"
echo "Prometheus: http://localhost:9090"
echo "Alertmanager: http://localhost:9093"
