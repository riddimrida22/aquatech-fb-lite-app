# Production Deployment Runbook

This runbook publishes AquatechPM for remote employee/admin access over HTTPS.

## 1) Server Prerequisites

- Ubuntu/Debian Linux VM with static public IP.
- DNS `A` record from your domain to that public IP:
  - Example: `app.yourdomain.com -> <server-ip>`
- Docker Engine + Docker Compose plugin installed.
- Ports open in firewall/security group:
  - `80/tcp`
  - `443/tcp`

## 2) Prepare App Folder

```bash
cd /opt
git clone <your-repo-url> AquatechPM
cd AquatechPM
cp .env.example .env
```

Edit `.env` with production values:

- `APP_DOMAIN=app.yourdomain.com`
- `ACME_EMAIL=ops@yourdomain.com`
- `POSTGRES_PASSWORD=<strong-random-password>`
- `DATABASE_URL=postgresql+psycopg://postgres:<same-password>@db:5432/fblite`
- `SESSION_SECRET=<long-random-secret>`
- `DEV_AUTH_BYPASS=false`
- `NEXT_PUBLIC_DEV_AUTH_BYPASS=false`
- `GOOGLE_REDIRECT_URI=https://app.yourdomain.com/api/auth/google/callback`
- `FRONTEND_ORIGIN=https://app.yourdomain.com`
- Plaid:
  - `PLAID_ENV=production`
  - `PLAID_CLIENT_ID=<production-client-id>`
  - `PLAID_SECRET=<production-secret>`
  - `PLAID_PRODUCTS=transactions`

## 3) Start Production Stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Check status:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy backend frontend
```

## 4) Verify External Access

- Open `https://app.yourdomain.com`.
- Confirm login works for your company domain.
- In browser dev tools, confirm session cookie has `Secure` and `SameSite=Lax`.
- Confirm `/api/auth/me` succeeds after sign in.

## 5) Backups and Restore

Automatic backups:
- `db-backup` service runs daily and writes compressed dumps to `./backups`.

Manual backup now:

```bash
docker compose -f docker-compose.prod.yml run --rm db-backup /scripts/backup_postgres.sh
```

Manual restore:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e POSTGRES_HOST=db \
  db-backup /scripts/restore_postgres.sh /backups/<file>.sql.gz
```

## 6) Operations

Deploy updates:

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Stop services:

```bash
docker compose -f docker-compose.prod.yml down
```

## 7) Plaid Production Checklist

- In Plaid Dashboard, enable `Transactions` product for Production.
- Use Production keys only when `PLAID_ENV=production`.
- If you get `INVALID_PRODUCT`, request/enable Transactions first.

## 8) Keep The App Online 24/7 (Always-On Mode)

Run these steps on the Linux production server once.

### 8.1 Bootstrap host dependencies

```bash
cd /opt/AquatechPM
sudo ./scripts/bootstrap_prod_server.sh <linux-user>
```

This installs Docker Engine, Docker Compose plugin, Git, and firewall rules for `80/443`.

### 8.2 Install boot + watchdog services

```bash
cd /opt/AquatechPM
sudo ./scripts/install_always_on_systemd.sh /opt/AquatechPM <linux-user> .env.prod
```

This enables:
- `aquatechpm.service` (starts production stack on boot)
- `aquatechpm-watchdog.timer` (runs every 5 minutes)
- `aquatechpm-watchdog.service` (health check + auto-recovery)

### 8.3 Verify services

```bash
systemctl status aquatechpm.service
systemctl status aquatechpm-watchdog.timer
systemctl status aquatechpm-watchdog.service
journalctl -u aquatechpm-watchdog.service -n 100 --no-pager
```

### 8.4 Reboot test (required)

```bash
sudo reboot
```

After reboot:

```bash
systemctl status aquatechpm.service
curl -I https://app.aquatechpc.com
curl -I https://app.aquatechpc.com/api/health
```
