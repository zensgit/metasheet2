# Multitable Windows Bootstrap PSQL Fix Verification

Date: 2026-04-07

## Checks

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh

pnpm install --frozen-lockfile
PACKAGE_TAG=run16-20260407 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate

tar -tzf output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-run16-20260407.tgz | rg "bootstrap-admin|multitable-onprem-bootstrap-admin.ps1"
unzip -l output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-run16-20260407.zip | rg "bootstrap-admin|multitable-onprem-bootstrap-admin.ps1"

git diff --check
```

## Notes

- `pwsh` is not available in the current macOS workspace, so the updated Windows bootstrap helper is verified here via code review plus package build/verify gates.
- Field validation should re-run `bootstrap-admin.bat` on Windows Server with both:
  - PostgreSQL on a standard `Program Files\PostgreSQL\<version>\bin` install path
  - an explicit `PSQL_PATH=` override
