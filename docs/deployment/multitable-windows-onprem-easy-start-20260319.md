# Multitable Windows On-Prem Easy Start

Goal: deploy the full MetaSheet app with multitable enabled on `Windows Server + Ubuntu VM` or `Windows Server + WSL2`.

This package is not attendance-only. It runs with:

```env
PRODUCT_MODE=platform
```

## 1) Build or download the package

Local build on the release machine:

```bash
cd <REPO_ROOT>
chmod +x scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
scripts/ops/multitable-onprem-package-build.sh
```

Artifacts:

- `output/releases/multitable-onprem/*.tgz`
- `output/releases/multitable-onprem/*.zip`

Verify before delivery:

```bash
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.tgz
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.zip
```

## 2) Prepare the Ubuntu side

Install dependencies:

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential nginx redis-server postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2
```

## 3) Extract the package

```bash
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
tar -xzf metasheet-multitable-onprem-<version>.tgz -C /opt
# Or, for the Windows-friendly archive:
# unzip metasheet-multitable-onprem-<version>.zip -d /opt
mv /opt/metasheet-multitable-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet
cp docker/app.env.multitable-onprem.template docker/app.env
```

## 4) Edit app.env

At minimum, replace every `change-me` and keep these settings:

```env
NODE_ENV=production
PRODUCT_MODE=platform
DEPLOYMENT_MODEL=onprem
JWT_SECRET=<strong-random-secret>
POSTGRES_PASSWORD=<strong-db-password>
DATABASE_URL=postgres://metasheet:<strong-db-password>@127.0.0.1:5432/metasheet
ATTACHMENT_PATH=/opt/metasheet/data/attachments
ATTACHMENT_STORAGE_BASE_URL=http://<your-server-host>/files
```

Create runtime directories:

```bash
mkdir -p /opt/metasheet/storage/attendance-import
mkdir -p /opt/metasheet/data/attachments
```

## 5) Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
SQL
```

## 6) Configure Nginx

```bash
cd /opt/metasheet
sudo cp ops/nginx/multitable-onprem.conf.example /etc/nginx/sites-available/metasheet-platform.conf
sudo ln -sf /etc/nginx/sites-available/metasheet-platform.conf /etc/nginx/sites-enabled/metasheet-platform.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 7) Install and start

```bash
cd /opt/metasheet
chmod +x scripts/ops/multitable-onprem-package-install.sh

ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
ADMIN_NAME="Administrator" \
scripts/ops/multitable-onprem-package-install.sh
```

## 8) Healthcheck

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/multitable-onprem-healthcheck.sh
```

## 9) Open the app

- Web: `http://<your-server-host>/`
- Multitable route example: `http://<your-server-host>/multitable`

## 10) Upgrade later

```bash
cd /opt/metasheet
chmod +x scripts/ops/multitable-onprem-package-upgrade.sh
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
BASE_URL="http://127.0.0.1" \
scripts/ops/multitable-onprem-package-upgrade.sh
```

## 11) Delivery checklist

Before handing this package to a customer or field team, also review:

- `docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
