#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 [app_dir] [run_user] [env_file]"
  exit 1
fi

APP_DIR="${1:-/opt/AquatechPM}"
RUN_USER="${2:-$SUDO_USER}"
ENV_FILE="${3:-.env.prod}"
SERVICE_NAME="aquatechpm"
WATCHDOG_SERVICE="${SERVICE_NAME}-watchdog"

if [[ -z "$RUN_USER" ]]; then
  echo "FAIL: run user is empty. Pass it explicitly."
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "FAIL: app dir not found: $APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/docker-compose.prod.yml" ]]; then
  echo "FAIL: missing docker-compose.prod.yml in $APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/$ENV_FILE" ]]; then
  echo "FAIL: missing env file $APP_DIR/$ENV_FILE"
  exit 1
fi

mkdir -p /etc/systemd/system

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AquatechPM Production Stack
Requires=docker.service
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}
Environment=ENV_FILE=${ENV_FILE}
ExecStart=/usr/bin/docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml up -d --build
ExecStop=/usr/bin/docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml down
TimeoutStartSec=0
User=${RUN_USER}
Group=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${WATCHDOG_SERVICE}.service" <<EOF
[Unit]
Description=AquatechPM Production Watchdog
Requires=docker.service
After=network-online.target docker.service ${SERVICE_NAME}.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
Environment=APP_BASE_URL=https://app.aquatechpc.com
Environment=API_BASE_URL=https://app.aquatechpc.com/api
ExecStart=${APP_DIR}/scripts/prod_watchdog.sh ${ENV_FILE}
User=${RUN_USER}
Group=${RUN_USER}
EOF

cat > "/etc/systemd/system/${WATCHDOG_SERVICE}.timer" <<EOF
[Unit]
Description=Run AquatechPM watchdog every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod 644 "/etc/systemd/system/${SERVICE_NAME}.service"
chmod 644 "/etc/systemd/system/${WATCHDOG_SERVICE}.service"
chmod 644 "/etc/systemd/system/${WATCHDOG_SERVICE}.timer"
chmod +x "${APP_DIR}/scripts/prod_watchdog.sh"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl enable --now "${WATCHDOG_SERVICE}.timer"

echo "PASS: always-on services installed"
echo "Check status:"
echo "  systemctl status ${SERVICE_NAME}.service"
echo "  systemctl status ${WATCHDOG_SERVICE}.timer"
echo "  systemctl status ${WATCHDOG_SERVICE}.service"
