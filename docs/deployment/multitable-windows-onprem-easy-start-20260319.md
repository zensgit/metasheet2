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
- Data Factory: `http://<your-server-host>/integrations/workbench`
- K3 WISE quick-start preset: `http://<your-server-host>/integrations/k3-wise`

## 9.1) Data Factory and K3 WISE Setup

The package includes `plugin-integration-core`, which registers the
`/api/integration/*` control-plane routes used by both integration pages.

Use `/integrations/k3-wise` when the field team is setting up the standard K3
WISE Material/BOM path:

1. Fill K3 WISE WebAPI system name, version, environment, Base URL, and
   credential mode.
2. Leave Tenant ID and Workspace ID alone for a single-tenant PoC. Blank Tenant
   ID resolves to `default`; Workspace ID is optional.
3. Keep Base URL at protocol, host, and port only, for example
   `http://k3-server:port`.
4. Keep `/K3API/...` in the advanced endpoint paths. If both Base URL and
   endpoint paths contain `/K3API`, the UI warns because requests may be built
   with duplicate path segments.
5. Enable SQL Server only for implementation users. SQL reads must use
   allowlisted tables or views; SQL writes must target middle tables or
   controlled stored procedures. Do not expose direct K3 core-table writes in
   normal UI operation.
6. Use the Material/BOM preview cards to verify K3 `Data` JSON shape. Preview
   is local calculation only and does not write DB rows or call K3.
7. Save the K3 WebAPI system, test WebAPI, then install staging tables and
   create draft pipelines.

Use `/integrations/workbench` as the default Data Factory surface when the
customer needs configurable CRM / PLM / ERP / SRM / HTTP / SQL data movement
beyond the K3 preset:

1. Select source and target systems as data sources.
2. Load source and target datasets or document templates.
3. Create or open staging multitable sheets for raw data, cleansing, feedback,
   and run logs.
4. Configure cleansing mapping rules using only the whitelisted transforms
   (`trim`, `upper`, `lower`, `toNumber`, `dictMap`).
5. Add dictionary mappings and required/min/max validation rules as needed.
6. Generate payload preview first, then save the pipeline, run dry-run, and only
   then opt into Save-only execution.

Operator evidence for K3:

```bash
pnpm verify:integration-k3wise:onprem-preflight
pnpm verify:integration-k3wise:poc
```

Post-deploy internal-trial signoff uses:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "http://<your-server-host>" \
  --token-file "<admin-token-file>" \
  --tenant-id default \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke

node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

Detailed operator runbooks included in the package:

- `docs/operations/k3-poc-onprem-preflight-runbook.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/operations/integration-k3wise-live-gate-execution-package.md`

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

The packaged root now also includes Windows-native wrappers:

- `deploy.bat <package.zip|package.tgz>`: synchronous apply + upgrade
- `deploy-runXX.bat <package.zip|package.tgz>`: same helper with the packaged run label baked in
- `deploy-remote.bat <package.zip|package.tgz>`: detached background run that writes `output/logs/deploy-remote.log`
- `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]`: create or repair the initial admin user on a pure Windows host
- `bootstrap-admin-runXX.bat <admin-email> <admin-password> [admin-name]`: same helper with the packaged run label baked in

These wrappers now call `scripts/ops/multitable-onprem-apply-package.ps1`, so a plain Windows Server 2022 host does not need bash or WSL just to apply a corrective package reroll.

The PowerShell helper extracts the incoming archive into a short-lived system temp directory instead of a deep deploy-root subdirectory, which avoids common Windows long-path failures during `Expand-Archive`.

The package intentionally does **not** bundle `node_modules`. `deploy.bat` defaults to `InstallDeps=1` and runs `pnpm install --frozen-lockfile` when `node_modules` is missing. If you copy package files manually instead of using `deploy.bat`, run this from the package root before migrations, PM2 restart, or `bootstrap-admin.bat`:

```bat
pnpm install --frozen-lockfile
```

The packaged Windows admin bootstrap helper also avoids `node -e` and writes a short-lived `.cjs` file into the package-local `.tmp/node-bootstrap` directory before invoking Node. This sidesteps the Node v24 + Windows PowerShell type-stripping issue and keeps bundled dependencies such as `bcryptjs` resolvable from the packaged app root.

After `deploy.bat` completes on a fresh Windows-only install, create the first admin with:

```bat
bootstrap-admin.bat admin@your-company.local <StrongPasswordAtLeast12Chars> Administrator
```

If PostgreSQL is installed on Windows but `psql.exe` is not on `PATH`, the PowerShell helper now auto-probes common install roots such as `C:\Program Files\PostgreSQL\<version>\bin`. You can also override it explicitly:

```bat
set PSQL_PATH=C:\Program Files\PostgreSQL\17\bin\psql.exe
bootstrap-admin.bat admin@your-company.local <StrongPasswordAtLeast12Chars> Administrator
```

## 11) Delivery checklist

Before handing this package to a customer or field team, also review:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
