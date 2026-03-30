# Attendance v2.7.2 On-Prem API Base Hotfix Verification

## Verified Risk

Before the fix, the shipped `run22` package contained:

- `VITE_API_BASE:"http://127.0.0.1:7778"`

inside `apps/web/dist/assets/index-Dxtdj0_0.js`, which matches the rollback report from the deployment environment.

## Commands Run

### Frontend regression checks

```bash
pnpm --filter @metasheet/web exec vitest run tests/utils/api.test.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- `tests/utils/api.test.ts`: `16 passed`
- `vue-tsc`: clean

### Script syntax

```bash
bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
```

Result:

- both passed

### Poisoned env reproduction guard

A temporary `apps/web/.env.local` containing:

```bash
VITE_API_BASE=http://127.0.0.1:7778
```

was created on purpose during verification.

Then the build was run with an isolated env dir:

```bash
METASHEET_ENV_DIR="$(mktemp -d)" pnpm --filter @metasheet/web build
```

Post-build inspection result:

- built `index-B8YJB_dG.js`
- `loopback_idx = -1`
- `localhost_idx = -1`

which means the bundle no longer embedded the loopback API base.

### End-to-end on-prem package verification

```bash
PACKAGE_VERSION=2.7.2 PACKAGE_TAG=run22-hotfix-check OUTPUT_DIR=output/releases/attendance-onprem-hotfix-check bash scripts/ops/attendance-onprem-package-build.sh
VERIFY_NO_GITHUB_LINKS=0 bash scripts/ops/attendance-onprem-package-verify.sh output/releases/attendance-onprem-hotfix-check/metasheet-attendance-onprem-v2.7.2-run22-hotfix-check.zip
```

Result:

- package build succeeded
- package verify succeeded
- extracted zip bundle inspection also reported:
  - `loopback_idx = -1`
  - `localhost_idx = -1`

## Conclusion

This hotfix closes the exact rollback cause:

- production frontend bundles no longer inherit loopback API env by default during on-prem packaging
- runtime API resolution now degrades safely to the deployed browser origin when a loopback env slips into a non-loopback page
- package verification now blocks this class of release regression before publish
