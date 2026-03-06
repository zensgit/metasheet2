# Attendance On-Prem (Windows Server, No Docker) Runbook

This runbook targets customers who require local deployment and only provide Windows Server.

If you want copy-paste quick deployment first, use:

- [attendance-windows-onprem-easy-start-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-easy-start-20260306.md)

If you distribute offline install packages (no git pull), use:

- [attendance-onprem-package-layout-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-package-layout-20260306.md)

Recommended topology:

- Windows Server host
- Ubuntu Server VM (Hyper-V/VMware)
- MetaSheet runs natively in Ubuntu (Node.js + PostgreSQL + Redis + Nginx + PM2), no Docker

The runbook supports two process managers:

- PM2 (default in bootstrap/update scripts)
- systemd (service templates provided under `ops/systemd/`)

## 0) Deployment Checklist (Do This Before Start)

- Host readiness:
  - Windows Server VM/Hyper-V resources allocated (recommended: 4 vCPU / 8GB RAM / 80GB disk minimum)
  - Ubuntu VM can access internet and GitHub
- Core dependencies installed in Ubuntu:
  - Node.js 20
  - pnpm
  - PostgreSQL
  - Redis
  - Nginx
- Required env values prepared:
  - `JWT_SECRET`
  - `POSTGRES_PASSWORD`
  - `DATABASE_URL`
  - `PRODUCT_MODE=attendance`
  - `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`
  - `ATTENDANCE_IMPORT_UPLOAD_DIR`
  - `ATTENDANCE_IMPORT_CSV_MAX_ROWS`
- Network/firewall:
  - expose only nginx port (80 or 443)
  - do not expose Postgres/Redis to public network
- Security baseline:
  - disable default/test passwords
  - Linux user permissions set for deployment directory

## 1) Prerequisites (Ubuntu VM)

Install runtime dependencies:

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential nginx redis-server postgresql postgresql-contrib
```

Install Node.js 20 + pnpm + PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2
```

## 2) Extract Delivery Package and Prepare Environment

```bash
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
# Extract delivery package into /opt/metasheet
tar -xzf metasheet-attendance-onprem-<version>.tgz -C /opt
# Optional: normalize extracted folder name
mv /opt/metasheet-attendance-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet
cp docker/app.env.example docker/app.env
```

Edit `docker/app.env` (minimum required):

```env
NODE_ENV=production
PRODUCT_MODE=attendance
DEPLOYMENT_MODEL=onprem
HOST=127.0.0.1
PORT=8900
JWT_SECRET=<strong-random-secret>
POSTGRES_PASSWORD=<strong-db-password>
DATABASE_URL=postgres://metasheet:<strong-db-password>@127.0.0.1:5432/metasheet
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000
```

Create upload directory:

```bash
mkdir -p /opt/metasheet/storage/attendance-import
```

## 3) Configure PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
SQL
```

## 4) Configure Nginx

Use template:

- `ops/nginx/attendance-onprem.conf.example`

Deploy:

```bash
sudo cp ops/nginx/attendance-onprem.conf.example /etc/nginx/sites-available/metasheet-attendance.conf
sudo ln -sf /etc/nginx/sites-available/metasheet-attendance.conf /etc/nginx/sites-enabled/metasheet-attendance.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 5) Initial Bootstrap (No Docker)

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-bootstrap.sh
```

What this does (default `SERVICE_MANAGER=pm2`):

- validates env (`scripts/ops/attendance-onprem-env-check.sh`)
- installs dependencies
- builds web/backend
- runs DB migrations
- starts backend via PM2 (`metasheet-backend`)

If you want systemd instead of PM2:

```bash
cd /opt/metasheet
sudo cp ops/systemd/metasheet-backend.service.example /etc/systemd/system/metasheet-backend.service
sudo systemctl daemon-reload
sudo systemctl enable metasheet-backend

ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
SERVICE_MANAGER=systemd \
scripts/ops/attendance-onprem-bootstrap.sh
```

## 6) Initialize Admin Account (Required)

Run admin bootstrap after backend startup:

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
ADMIN_NAME="Administrator" \
scripts/ops/attendance-onprem-bootstrap-admin.sh
```

What it does:

- creates or updates admin user in `users`
- forces admin role (`role=admin`, `is_admin=true`)
- grants attendance/admin RBAC permissions in `user_roles` + `user_permissions`
- optional login verification via `/api/auth/login` (enabled by default)

If you want to skip login verification during initial network bring-up:

```bash
ENV_FILE=/opt/metasheet/docker/app.env \
VERIFY_LOGIN=0 \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
scripts/ops/attendance-onprem-bootstrap-admin.sh
```

## 7) Validation

```bash
curl -f http://127.0.0.1:8900/health
```

Then run gates from the VM:

```bash
API_BASE="http://127.0.0.1/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
RUN_PREFLIGHT=false \
scripts/ops/attendance-run-gates.sh
```

One-click local healthcheck:

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/attendance-onprem-healthcheck.sh
```

Optional strict feature-mode check:

```bash
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE=attendance \
scripts/ops/attendance-onprem-healthcheck.sh
```

UI checks:

- open `http://<vm-or-host-ip>/attendance`
- non-attendance paths (`/grid`, `/spreadsheets`) should redirect to `/attendance`

## 8) Routine Update / Patch

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-update.sh
```

What update script does:

- pull latest `main` (`git pull --ff-only`)
- install/build
- migrate
- PM2 restart (`--update-env`)
- nginx reload (if active)

If using systemd:

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
SERVICE_MANAGER=systemd \
scripts/ops/attendance-onprem-update.sh
```

## 9) Optional: Periodic Healthcheck Timer (systemd)

Install templates:

```bash
cd /opt/metasheet
sudo cp ops/systemd/metasheet-healthcheck.service.example /etc/systemd/system/metasheet-healthcheck.service
sudo cp ops/systemd/metasheet-healthcheck.timer.example /etc/systemd/system/metasheet-healthcheck.timer
sudo systemctl daemon-reload
sudo systemctl enable --now metasheet-healthcheck.timer
```

Manual run:

```bash
sudo systemctl start metasheet-healthcheck.service
sudo journalctl -u metasheet-healthcheck.service -n 100 --no-pager
```

## 10) Rollback

Recommended rollback method:

1. keep a known-good git tag/commit
2. checkout old commit
3. rebuild + restart with `SKIP_GIT_PULL=1`

Example:

```bash
cd /opt/metasheet
git checkout <GOOD_COMMIT_SHA>
ENV_FILE=/opt/metasheet/docker/app.env \
SKIP_GIT_PULL=1 \
scripts/ops/attendance-onprem-update.sh
```

## 11) Re-enable Full MetaSheet Modules Later

When business allows opening other modules:

1. change `PRODUCT_MODE=platform` in `docker/app.env`
2. run update with attendance-only guard disabled:

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=0 \
scripts/ops/attendance-onprem-update.sh
```
