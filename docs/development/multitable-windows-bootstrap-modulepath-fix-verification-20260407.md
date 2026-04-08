# Multitable Windows Bootstrap Module Path Fix Verification

Date: 2026-04-07

## Commands

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
pnpm install --frozen-lockfile
PACKAGE_TAG=run18-20260407 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Manual Checks

- Confirm `scripts/ops/multitable-onprem-bootstrap-admin.ps1` writes temp `.cjs` files beneath the packaged root instead of `%TEMP%`.
- Confirm the packaged archives still include:
  - `bootstrap-admin.bat`
  - `bootstrap-admin-run18.bat`
  - `scripts/ops/multitable-onprem-bootstrap-admin.ps1`

## Field Validation Still Required

- On Windows Server 2022, run:
  - `deploy.bat` / `deploy-run18.bat`
  - `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]`
- If PostgreSQL is not on `PATH`, set `PSQL_PATH` and rerun bootstrap.
