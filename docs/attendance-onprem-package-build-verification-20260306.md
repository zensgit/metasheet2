# Attendance On-Prem Package Build Verification (2026-03-06)

## Scope

- Add package build/verify flow for on-prem delivery without `git pull`.
- Verify package archive generation and checksum/content validation.

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2
chmod +x \
  scripts/ops/attendance-onprem-package-build.sh \
  scripts/ops/attendance-onprem-package-verify.sh \
  scripts/ops/attendance-onprem-package-install.sh \
  scripts/ops/attendance-onprem-package-upgrade.sh

bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
bash -n scripts/ops/attendance-onprem-package-install.sh
bash -n scripts/ops/attendance-onprem-package-upgrade.sh

PACKAGE_TAG=20260306-r1 scripts/ops/attendance-onprem-package-build.sh
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.zip
```

## Result

- Syntax checks: PASS
- Package build: PASS
- Package verify (sha + required file set): PASS

## Evidence

- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.zip`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz.sha256`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.zip.sha256`
- `output/releases/attendance-onprem/SHA256SUMS`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.json`

## GitHub Actions Verification (Public Repo)

Execution date: `2026-03-06`

Run metadata:

- Workflow: `attendance-onprem-package-build.yml`
- Run ID: `22746728368`
- Result: `SUCCESS`

Evidence (downloaded locally):

- `output/playwright/ga/22746728368/attendance-onprem-package-22746728368-1/metasheet-attendance-onprem-v2.5.0-run3.tgz`
- `output/playwright/ga/22746728368/attendance-onprem-package-22746728368-1/metasheet-attendance-onprem-v2.5.0-run3.tgz.sha256`
- `output/playwright/ga/22746728368/attendance-onprem-package-22746728368-1/SHA256SUMS`
- `output/playwright/ga/22746728368/attendance-onprem-package-22746728368-1/metasheet-attendance-onprem-v2.5.0-run3.json`

Verification result:

- `attendance-onprem-package-verify.sh` on the downloaded `.tgz`: `PASS`
- Archive SHA256 matches `SHA256SUMS`: `PASS`

## GitHub Actions Verification (Release + WSL Task Script)

Execution date: `2026-03-06`

Run metadata:

- Workflow: `attendance-onprem-package-build.yml`
- Run ID: `22751445059`
- Result: `SUCCESS`
- Release Tag: `v2.5.0-onprem-20260306-wsltask`
- Release URL: `https://github.com/zensgit/metasheet2/releases/tag/v2.5.0-onprem-20260306-wsltask`

Evidence (downloaded locally):

- `output/playwright/ga/22751445059/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.tgz`
- `output/playwright/ga/22751445059/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.zip`
- `output/playwright/ga/22751445059/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.tgz.sha256`
- `output/playwright/ga/22751445059/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.zip.sha256`
- `output/playwright/ga/22751445059/SHA256SUMS`
- `output/playwright/ga/22751445059/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.json`

Verification result:

- `attendance-onprem-package-verify.sh` on downloaded `.tgz`: `PASS`
- `attendance-onprem-package-verify.sh` on downloaded `.zip`: `PASS`
- `.zip` includes:
  - `scripts/ops/attendance-wsl-portproxy-refresh.ps1`
  - `scripts/ops/attendance-wsl-portproxy-task.ps1`

## GitHub Actions Verification (Latest Current Release Audit)

Execution date: `2026-03-06`

Run metadata:

- Workflow: `attendance-onprem-package-build.yml`
- Run ID: `22752221246`
- Result: `SUCCESS`
- Release Tag: `v2.5.0-onprem-20260306-current`
- Release URL: `https://github.com/zensgit/metasheet2/releases/tag/v2.5.0-onprem-20260306-current`

Evidence (downloaded locally):

- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/metasheet-attendance-onprem-v2.5.0-20260306-current.tgz`
- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/metasheet-attendance-onprem-v2.5.0-20260306-current.zip`
- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/SHA256SUMS`
- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/tgz-manifest.txt`
- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/zip-manifest.txt`
- `output/playwright/release-audit/v2.5.0-onprem-20260306-current/audit-summary.txt`

Verification result:

- `attendance-onprem-package-verify.sh` on downloaded `.tgz`: `PASS`
- `attendance-onprem-package-verify.sh` on downloaded `.zip`: `PASS`
- `SHA256SUMS` digest check for `.tgz/.zip`: `PASS`
- Key files confirmed in both archives:
  - `apps/web/dist/index.html`
  - `packages/core-backend/dist/src/db/migrate.js`
  - `scripts/ops/attendance-onprem-deploy-easy.sh`
  - `scripts/ops/attendance-wsl-portproxy-refresh.ps1`
  - `scripts/ops/attendance-wsl-portproxy-task.ps1`
  - `docs/deployment/attendance-windows-wsl-direct-commands-20260306.md`
  - `docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md`

## Notes

- Database instance creation is still external (`CREATE DATABASE` by DBA/installer).
- Install/upgrade scripts run migrations and create/upgrade all schema objects in an existing database.
