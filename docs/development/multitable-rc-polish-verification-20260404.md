# Multitable RC Polish Verification

Date: 2026-04-04

## Commands

```bash
bash -n scripts/ops/multitable-onprem-apply-package.sh
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
PACKAGE_TAG=run11-20260404 BUILD_WEB=1 BUILD_BACKEND=1 pnpm verify:multitable-onprem:release-gate
git diff --check
```

## Expected evidence

- The package verify gate requires:
  - `deploy.bat`
  - `deploy-remote.bat`
  - `scripts/ops/multitable-onprem-apply-package.sh`
- The packaged docs explain the one-command apply flow.
- The package still passes the multitable release gate for both `.tgz` and `.zip`.
- The RC notes summarize the `run2 -> run10` progression without introducing GitHub links into packaged delivery docs.
