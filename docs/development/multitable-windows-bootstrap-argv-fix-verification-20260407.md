# Multitable Windows Bootstrap Argv Fix Verification

Date: 2026-04-07

## Commands

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
pnpm install --frozen-lockfile
PACKAGE_TAG=run20-20260407 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Manual Checks

- Confirm `Invoke-NodeCapture` prepends `process.argv.splice(1, 1);`
- Confirm the packaged archives still include:
  - `bootstrap-admin.bat`
  - `bootstrap-admin-run20.bat`
  - `scripts/ops/multitable-onprem-bootstrap-admin.ps1`

## Field Validation Still Required

- On Windows Server 2022, run:
  - `deploy.bat` / `deploy-run20.bat`
  - `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]`
- Confirm the admin can log in with the provided password.
