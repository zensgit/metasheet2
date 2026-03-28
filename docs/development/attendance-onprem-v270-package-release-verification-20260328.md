# Attendance On-Prem v2.7.0 Package Release Verification

Date: 2026-03-28

## Goal

Verify that `v2.7.0` now has deployable attendance on-prem package assets and that those assets are internally consistent.

## Packaging base

Clean worktree:

- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328`

Base ref:

- `v2.7.0`
- commit `0977b4b19e35d474df4057ea82809d07e6f359c0`

## Commands run

### Install workspace dependencies in the clean worktree

```bash
pnpm install --frozen-lockfile
```

### Build canonical on-prem package with explicit version override

```bash
PACKAGE_VERSION=2.7.0 \
PACKAGE_TAG=20260328-current \
INSTALL_DEPS=0 \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
scripts/ops/attendance-onprem-package-build.sh
```

### Verify canonical package

```bash
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.tgz

scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.zip
```

### Create and verify operator-friendly aliases

Actions performed:

- copy canonical `.tgz/.zip` to no-suffix `v2.7.0` names
- generate individual `.sha256`
- generate `SHA256SUMS-v2.7.0`
- generate `metasheet-attendance-onprem-v2.7.0.json`
- verify the alias `.tgz/.zip` in a temp directory with a local `SHA256SUMS`

Alias verification results:

- `metasheet-attendance-onprem-v2.7.0.tgz`: PASS
- `metasheet-attendance-onprem-v2.7.0.zip`: PASS

### Upload assets to GitHub Release

```bash
gh release upload v2.7.0 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.tgz \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.tgz.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.zip \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.zip.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.json \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.tgz \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.tgz.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.zip \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.zip.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.json \
  output/releases/attendance-onprem/SHA256SUMS-v2.7.0 \
  --clobber
```

### Update release body to mention on-prem assets

Result:

- `v2.7.0` release body now explicitly lists the recommended on-prem downloads

## Local evidence

- [metasheet-attendance-onprem-v2.7.0-20260328-current.tgz](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.tgz)
- [metasheet-attendance-onprem-v2.7.0-20260328-current.zip](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0-20260328-current.zip)
- [metasheet-attendance-onprem-v2.7.0.tgz](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.tgz)
- [metasheet-attendance-onprem-v2.7.0.zip](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.zip)
- [SHA256SUMS-v2.7.0](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/SHA256SUMS-v2.7.0)
- [metasheet-attendance-onprem-v2.7.0.json](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.0.json)

## Remote evidence

Release checked:

- <https://github.com/zensgit/metasheet2/releases/tag/v2.7.0>

Observed uploaded assets include:

- `metasheet-attendance-onprem-v2.7.0.zip`
- `metasheet-attendance-onprem-v2.7.0.tgz`
- `metasheet-attendance-onprem-v2.7.0.zip.sha256`
- `metasheet-attendance-onprem-v2.7.0.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.0.json`
- `SHA256SUMS-v2.7.0`
- canonical `20260328-current` package artifacts

## Result

`v2.7.0` now has deployable attendance on-prem package assets.

This closes the earlier gap where:

- source release `v2.7.0` existed
- but only `attendance-onprem-run21-20260322` exposed downloadable on-prem package files

The current release page now supports direct operator download for `v2.7.0`.
