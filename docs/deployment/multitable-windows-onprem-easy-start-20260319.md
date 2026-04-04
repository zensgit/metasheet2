# Multitable Windows On-Prem Easy Start

Goal: deploy the full MetaSheet app with multitable enabled on `Windows Server + Ubuntu VM` or `Windows Server + WSL2`.

This package is not attendance-only. It runs with:

```env
PRODUCT_MODE=platform
```

## 1) Build or download the package

Local build on the release machine:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
chmod +x scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
PACKAGE_VERSION=2.5.1 \
PACKAGE_TAG=pilot-r2 \
INSTALL_DEPS=1 \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
scripts/ops/multitable-onprem-package-build.sh
```

For a corrective reroll, do not run the build script bare. The defaults only repackage existing `dist/` content and do not force a fresh dependency install or rebuild.

Artifacts:

- `output/releases/multitable-onprem/*.tgz`
- `output/releases/multitable-onprem/*.zip`

Verify before delivery:

```bash
VERIFY_REPORT_JSON=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.json \
VERIFY_REPORT_MD=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.md \
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<PACKAGE_NAME>.tgz

VERIFY_REPORT_JSON=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.json \
VERIFY_REPORT_MD=output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.md \
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

## 10.1) One-command server-side package apply

If the field team keeps losing the SSH session during a long upgrade, keep a fixed deploy entrypoint on the server and feed it the next archive:

```bash
cd /opt/metasheet
chmod +x scripts/ops/multitable-onprem-apply-package.sh

ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
BASE_URL="http://127.0.0.1" \
scripts/ops/multitable-onprem-apply-package.sh /opt/releases/metasheet-multitable-onprem-<version>.zip
```

The packaged root now also includes Windows-friendly wrappers:

- `deploy.bat <package.zip|package.tgz>`: synchronous apply + upgrade
- `deploy-runXX.bat <package.zip|package.tgz>`: same helper with the packaged run label baked in
- `deploy-remote.bat <package.zip|package.tgz>`: detached background run that writes `output/logs/deploy-remote.log`

## 11) Delivery checklist

Before handing this package to a customer or field team, also review:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
