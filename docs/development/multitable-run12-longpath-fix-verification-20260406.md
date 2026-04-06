# Multitable Run12 Long-Path Fix Verification

Date: 2026-04-06

## Checks

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh

pnpm install --frozen-lockfile
PACKAGE_TAG=run13-20260406 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate

git diff --check
```

## Notes

- `pwsh` is not available in the current macOS workspace, so the PowerShell helper is verified here via code review plus package-gate packaging/verification.
- Field validation should re-run `deploy.bat` or `deploy-run13.bat` on Windows Server to confirm the long-path extraction failure is gone.
