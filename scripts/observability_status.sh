#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose -f deployment/observability/docker-compose.observability.yml ps

curl -fsS http://localhost:9090/-/healthy >/dev/null && echo "PASS: Prometheus healthy" || echo "FAIL: Prometheus unhealthy"
curl -fsS http://localhost:9093/-/healthy >/dev/null && echo "PASS: Alertmanager healthy" || echo "FAIL: Alertmanager unhealthy"
curl -fsS http://localhost:9115/-/healthy >/dev/null && echo "PASS: Blackbox exporter healthy" || echo "FAIL: Blackbox exporter unhealthy"
curl -fsS http://localhost:3001/api/health >/dev/null && echo "PASS: Grafana healthy" || echo "FAIL: Grafana unhealthy"
