# Multitable Windows On-Prem Easy Start

Goal: deploy the full MetaSheet app with multitable enabled on `Windows Server + Ubuntu VM` or `Windows Server + WSL2`.

This package is not attendance-only. It runs with:

```env
PRODUCT_MODE=platform
```

## 1) Build or download the package

The release `.zip` and `.tgz` assets are deployable on-prem application
packages. They are not source-only archives, even though extracting them shows
workspace-style directories such as `apps/`, `packages/`, `plugins/`,
`scripts/`, `docker/`, `ops/`, and `docs/`. Those paths are part of the runtime
layout and are required by the deploy helpers.

Each package root includes:

- `DEPLOYMENT.txt` — operator-facing explanation of fresh install vs upgrade.
- `PACKAGE-METADATA.json` — machine-readable artifact kind and deploy mode.

For upgrades, do not hand-copy selected directories over a running install. Use
the existing deploy root's apply entrypoint:

```bat
deploy.bat <downloaded-package.zip>
```

On Windows hosts with deep default `%TEMP%` paths, set a short local staging
root before running the upgrade. The deploy launcher and the staged apply helper
both honor the same variable, so zip extraction and package copy stay under the
short path instead of falling back to the user profile temp directory:

```bat
mkdir C:\ms-tmp 2>NUL
set "METASHEET_ONPREM_STAGING_ROOT=C:\ms-tmp"
deploy.bat <downloaded-package.zip>
```

The setting only changes deploy staging/extraction. It does not change the
installed root, app data paths, database connection, dependency store, or service
configuration.

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
  --frontend-base-url "http://<your-frontend-nginx-host>" \
  --token-file "<admin-token-file>" \
  --tenant-id default \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke

node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

If the same nginx origin serves both `/api/*` and the SPA routes, omit
`--frontend-base-url`. If `--base-url` points at a backend/API-only surface,
set `--frontend-base-url` to the front door where `/`, `/login`,
`/integrations/workbench`, and `/integrations/k3-wise` return the web app.

Detailed operator runbooks included in the package:

- `docs/operations/k3-poc-onprem-preflight-runbook.md`
- `docs/operations/integration-k3wise-onprem-operator-handoff-checklist.md`
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
- `deploy-remote.bat <package.zip|package.tgz>`: scheduled-task-friendly remote wrapper that writes `output/logs/deploy-remote.log`; release `584dbc88a` and later run synchronously and propagate `apply exit=N` (older packages used a detached background wrapper)
- `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]`: create or repair the initial admin user on a pure Windows host
- `bootstrap-admin-runXX.bat <admin-email> <admin-password> [admin-name]`: same helper with the packaged run label baked in

These wrappers now call `scripts/ops/multitable-onprem-apply-package.ps1`, so a plain Windows Server 2022 host does not need bash or WSL just to apply a corrective package reroll.

The PowerShell helper extracts the incoming archive into a short-lived system temp directory instead of a deep deploy-root subdirectory, which avoids common Windows long-path failures during `Expand-Archive`.

The package intentionally does **not** bundle `node_modules`. `deploy.bat`
defaults to `InstallDeps=1` and refreshes dependencies with
`pnpm install --frozen-lockfile` on every package apply. This is intentional for
upgrade installs: the deploy root may already have `node_modules`, but the new
package can add runtime dependencies such as plugin drivers. If you copy package
files manually instead of using `deploy.bat`, run this from the package root
before migrations, PM2 restart, or `bootstrap-admin.bat`:

```bat
pnpm install --frozen-lockfile
```

The Windows apply helper runs that dependency refresh with diagnostics rather
than as an unbounded silent command:

- install entrypoint: a generated `dependency-refresh-*.cmd` wrapper launched
  through `cmd.exe /d /s /c`, with `pnpm.cmd` preferred over `pnpm.ps1`;
- local store: deploy-root `.pnpm-store`, passed to pnpm with `--store-dir`;
- pnpm reporter: `--reporter=append-only`, so scheduled-task logs can grow
  incrementally instead of waiting for an interactive renderer;
- default timeout: 1800 seconds;
- default heartbeat: 60 seconds;
- stdout/stderr logs: `output\logs\dependency-refresh-*.stdout.log` and
  `output\logs\dependency-refresh-*.stderr.log`;
- tunables for exceptional hosts:
  `-DependencyRefreshTimeoutSec <seconds>` and
  `-DependencyRefreshHeartbeatSec <seconds>`.

If a scheduled deployment appears stuck at dependency refresh, inspect
`output\logs\deploy-remote.log` plus the two `dependency-refresh-*` logs before
rerunning. A timeout is a deploy failure, not a valid SQL/K3 runtime test.

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

## 10.2) Scheduled-task remote apply (release 584dbc88a and later)

Verified on the on-prem bridge against release `584dbc88a` (the merge that
fixed the scheduled-task exit-code / log marker quirk for issue #1526). This
subsection documents the **scheduled-task** path specifically — the synchronous
`deploy.bat` and `deploy-runXX.bat` flows already worked and are unchanged here.

### Two upgrade-time gotchas to plan for

1. **Pre-584dbc88a installs cannot self-fix on the first scheduled run.**
   `deploy-remote.bat` and the launcher in older installs are the
   fire-and-forget version: they return `exit /b 0` immediately without
   waiting for `apply`, so the scheduled task's `LastTaskResult` never
   reflects what `apply` actually did. The new `deploy-remote.bat` (the one
   that captures `APPLY_EXIT` and writes `apply exit=N`) only takes effect
   **after** it is on disk in the installed root. On the upgrade run from a
   pre-584dbc88a state, the **old** `deploy-remote.bat` is what executes; the
   new wrappers only land as part of that run's copy step. Plan one of:

   - run a single synchronous `deploy.bat <new-package.zip>` from the
     installed root first (the new wrappers land, the next scheduled-task
     invocation then uses them), or
   - manually copy `deploy.bat`, `deploy-remote.bat`,
     `deploy-runXX.bat`, and
     `scripts\ops\multitable-onprem-deploy-launcher.ps1` from the new
     package zip into the installed root before letting the scheduled task
     fire.

   Either path leaves a `>=584dbc88a` `deploy-remote.bat` on disk before the
   first scheduled-task run that is expected to report a real
   `LastTaskResult`. Path 1 assumes the pre-state's `apply.ps1` actually
   reaches its "Copy extracted package into root" step; if the install
   predates #1696 (env loading) or #1684 (dependency-refresh wrapper),
   `apply` may die before that step and path 2 (manual copy) is the safer
   option from the start.

2. **Scheduled Task running as `SYSTEM` needs the Administrator profile env.**
   `apply` calls `pnpm.cmd` (dependency refresh wrapper) and `pm2` (process
   manager). Both look up Node, pnpm, the pnpm store, and a writable home
   directory through environment variables that the LocalSystem account does
   not inherit. Without these, `pnpm` or PM2 fails — usually visibly in
   `deploy-remote.log` as `'pnpm' is not recognized` or as PM2 unable to
   write to its store. Configure the task with **explicit** environment
   variables before saving it:

   - `PATH` extended with the Administrator's Node install root (e.g.
     `C:\Program Files\nodejs`) and pnpm install root (e.g.
     `%LOCALAPPDATA%\pnpm` from the Administrator profile);
   - `HOME`, `HOMEPATH`, `USERPROFILE` pointing at the Administrator
     profile directory (e.g. `C:\Users\Administrator`);
   - `APPDATA` pointing at that profile's `AppData\Roaming`.

   If the operator policy forbids running the task as SYSTEM, schedule it as
   the Administrator account instead with `Run whether user is logged on or
   not` enabled — the same env then comes through naturally.

### Success acceptance (what to look for after a scheduled run)

A "real" successful scheduled-task apply has **all** of the following:

- the task's `LastTaskResult` is `0` (visible in Task Scheduler → History,
  or `Get-ScheduledTaskInfo -TaskName <task> | Select LastTaskResult`);
- `output/logs/deploy-remote.log` ends with these three parseable markers,
  in this order (inner-most to outer-most), each carrying the same exit
  code:

  ```text
  [multitable-onprem-deploy-launcher] apply exit=0
  [multitable-onprem-deploy] apply exit=0
  [multitable-onprem-deploy-remote] apply exit=0
  ```

- the apply log above the markers passes through the full progression:
  - dependency refresh (`[dependency-refresh-wrapper] pnpm install exit=0`),
  - migrations (`Run database migrations ...` completes),
  - PM2 restart and `pm2 save`,
  - `Package deploy complete`,
  - `Healthcheck OK`.

A failed apply leaves a non-zero in **all three** `apply exit=N` markers and
in `LastTaskResult`; the matching layer in the log shows where the failure
actually originated.

If `LastTaskResult` is `0` but any of the three markers is missing or shows a
different code, the wrapper chain is mixed (an older `deploy-remote.bat`
short-circuited before the new layers ran). Re-check gotcha #1 above. The
missing marker tells you which installed file is stale:

| Missing marker | Stale installed file to refresh from the new package |
| --- | --- |
| `[multitable-onprem-deploy-launcher] apply exit=...` | `scripts\ops\multitable-onprem-deploy-launcher.ps1` |
| `[multitable-onprem-deploy] apply exit=...` | `deploy.bat` |
| `[multitable-onprem-deploy-remote] apply exit=...` | `deploy-remote.bat` |

### Out of scope (deliberate)

This runbook section is about the Windows scheduled-task / `deploy-remote.bat`
plumbing only. It does **not** change:

- `plugins/plugin-integration-core` runtime,
- DB migration behavior,
- API runtime or frontend runtime,
- K3 Save / Submit / Audit semantics,
- SQL Server / TLS failure summarization (a separate #1526 actionable).

Customer GATE state is unchanged — this section is operational hygiene around
an already-shipped fix.

## 11) Delivery checklist

Before handing this package to a customer or field team, also review:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md`
