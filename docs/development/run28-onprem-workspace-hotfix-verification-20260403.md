# Run28 On-Prem Workspace Hotfix Verification

## Commands

```bash
bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
pnpm install --frozen-lockfile
PACKAGE_VERSION=2.7.2 PACKAGE_TAG=workspacefix-20260403 BUILD_WEB=1 BUILD_BACKEND=1 OUTPUT_DIR="$PWD/output/releases/attendance-onprem" scripts/ops/attendance-onprem-package-build.sh
scripts/ops/attendance-onprem-package-verify.sh output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.2-workspacefix-20260403.tgz
scripts/ops/attendance-onprem-package-verify.sh output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.2-workspacefix-20260403.zip
tmpdir=$(mktemp -d)
tar -xzf output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.2-workspacefix-20260403.tgz -C "$tmpdir"
cd "$tmpdir"/metasheet-attendance-onprem-v2.7.2-workspacefix-20260403
pnpm install --frozen-lockfile
```

## Results

- shell syntax checks passed for both packaging scripts
- clean worktree install completed successfully
- package build completed successfully with `PACKAGE_VERSION=2.7.2`
- `.tgz` and `.zip` both passed `attendance-onprem-package-verify.sh`
- extracted on-prem package completed `pnpm install --frozen-lockfile` successfully
- extracted package install reported `Scope: all 3 workspace projects`, confirming `apps/web` is no longer part of deployment-time workspace resolution

## What changed in the built package

- packaged `pnpm-workspace.yaml` now includes only `packages/*` and `plugins/*`
- packaged workspace no longer includes `apps/*`
- packaged workspace no longer includes `packages/openapi/dist-sdk`

## Deployment impact

This removes the need for manual hotfixes such as editing `pnpm-workspace.yaml` inside the delivered package before running `pnpm install`.
