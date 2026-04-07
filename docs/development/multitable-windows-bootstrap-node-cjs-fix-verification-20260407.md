# Multitable Windows Bootstrap Node CJS Fix Verification

Date: 2026-04-07

## Commands

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
pnpm install --frozen-lockfile
PACKAGE_TAG=run17-20260407 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Manual Checks

- Confirm `scripts/ops/multitable-onprem-bootstrap-admin.ps1` no longer calls `node -e`.
- Confirm the packaged archives still include:
  - `bootstrap-admin.bat`
  - `bootstrap-admin-run17.bat`
  - `scripts/ops/multitable-onprem-bootstrap-admin.ps1`

## Field Validation Still Required

- Run `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]` on Windows Server 2022 with Node v24.
- If PostgreSQL is not on `PATH`, re-run with `PSQL_PATH` set and confirm exit code `0`.
