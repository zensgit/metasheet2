# Attendance On-Prem v2.7.2 Package Release Verification

Date: 2026-03-29

## Commands

```bash
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build
PACKAGE_VERSION=2.7.2 PACKAGE_TAG=20260329-current INSTALL_DEPS=0 BUILD_WEB=0 BUILD_BACKEND=0 \
  bash scripts/ops/attendance-onprem-package-build.sh
gh release create v2.7.2 --target b49746df8d1d80ca07940bac107f757837e1f402 ...
gh release view v2.7.2 --json tagName,url,publishedAt,assets
```

## What Was Verified

- release tag `v2.7.2` was created
- release target points at `main@b49746df8d1d80ca07940bac107f757837e1f402`
- on-prem assets were uploaded in both dated and stable-name forms
- stable-name archives have the same hashes as the dated `current` archives
- mainline checks on the target commit were already green before release

## Asset Expectations

- `metasheet-attendance-onprem-v2.7.2.zip`
- `metasheet-attendance-onprem-v2.7.2.tgz`
- `metasheet-attendance-onprem-v2.7.2.zip.sha256`
- `metasheet-attendance-onprem-v2.7.2.tgz.sha256`
- `SHA256SUMS-v2.7.2`

## Claude Code Note

Claude Code was actually called during this continuation. It did not return a timely actionable release recommendation, so verification relies on local build/package outputs plus GitHub release state.
