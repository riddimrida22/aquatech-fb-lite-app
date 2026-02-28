#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 [run_user]"
  exit 1
fi

RUN_USER="${1:-$SUDO_USER}"
if [[ -z "$RUN_USER" ]]; then
  echo "FAIL: run user is empty. Pass it explicitly."
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "FAIL: user does not exist: $RUN_USER"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release ufw

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

arch="$(dpkg --print-architecture)"
release="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${release} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git

systemctl enable --now docker
usermod -aG docker "$RUN_USER"

# Keep SSH open while allowing web traffic.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "PASS: server bootstrap complete"
echo "Next: log out/in to apply docker group for user $RUN_USER"
