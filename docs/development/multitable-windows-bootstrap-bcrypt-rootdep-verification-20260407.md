# Multitable Windows Bootstrap Bcrypt Root Dependency Verification

Date: 2026-04-07

## Commands

```bash
pnpm install --frozen-lockfile
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
PACKAGE_TAG=run19-20260407 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Manual Checks

- Confirm root [package.json](/Users/huazhou/Downloads/Github/metasheet2/package.json) lists `bcryptjs` in `dependencies`
- Confirm the packaged archives still include:
  - `bootstrap-admin.bat`
  - `bootstrap-admin-run19.bat`
  - `scripts/ops/multitable-onprem-bootstrap-admin.ps1`

## Field Validation Still Required

- On Windows Server 2022, run:
  - `deploy.bat` / `deploy-run19.bat`
  - `bootstrap-admin.bat <admin-email> <admin-password> [admin-name]`
