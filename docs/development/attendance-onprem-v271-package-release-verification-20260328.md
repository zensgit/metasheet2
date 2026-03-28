# Attendance On-Prem v2.7.1 Package Release Verification

Date: 2026-03-28

## Goal

Verify that `v2.7.1` was released from the merged attendance hotfix commit and that the attached on-prem package assets are internally consistent.

## Packaging base

Clean worktree:

- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328`

Base ref:

- `main`
- commit `9a958a5a1c0fdb1a53171b5727a9d62d51e3e201`

## Commands run

### Install workspace dependencies

```bash
pnpm install --frozen-lockfile
```

### Build canonical on-prem package with explicit version override

```bash
PACKAGE_VERSION=2.7.1 \
PACKAGE_TAG=20260328-current \
INSTALL_DEPS=0 \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
scripts/ops/attendance-onprem-package-build.sh
```

### Verify canonical package artifacts

```bash
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.tgz

scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.zip
```

### Create operator-friendly aliases and verify them

Actions performed:

- copy canonical `.tgz/.zip/.json` to no-suffix `v2.7.1` names
- generate per-file `.sha256`
- generate `SHA256SUMS-v2.7.1`
- update alias json metadata
- verify alias `.tgz/.zip` in a temp directory with `SHA256SUMS-v2.7.1` copied locally as `SHA256SUMS`

Alias verification results:

- `metasheet-attendance-onprem-v2.7.1.tgz`: PASS
- `metasheet-attendance-onprem-v2.7.1.zip`: PASS

### Create GitHub Release

```bash
gh release create v2.7.1 \
  --target 9a958a5a1c0fdb1a53171b5727a9d62d51e3e201 \
  --title 'v2.7.1' \
  --notes-file /tmp/metasheet-v271-release-notes.md \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.tgz \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.tgz.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.zip \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.zip.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.json \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.tgz \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.tgz.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.zip \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.zip.sha256 \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.json \
  output/releases/attendance-onprem/SHA256SUMS-v2.7.1
```

## Local evidence

- [metasheet-attendance-onprem-v2.7.1-20260328-current.tgz](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.tgz)
- [metasheet-attendance-onprem-v2.7.1-20260328-current.zip](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1-20260328-current.zip)
- [metasheet-attendance-onprem-v2.7.1.tgz](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.tgz)
- [metasheet-attendance-onprem-v2.7.1.zip](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.zip)
- [SHA256SUMS-v2.7.1](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/SHA256SUMS-v2.7.1)
- [metasheet-attendance-onprem-v2.7.1.json](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v271-release-20260328/output/releases/attendance-onprem/metasheet-attendance-onprem-v2.7.1.json)

## Remote evidence

Release checked:

- <https://github.com/zensgit/metasheet2/releases/tag/v2.7.1>

Observed uploaded assets include:

- `metasheet-attendance-onprem-v2.7.1.zip`
- `metasheet-attendance-onprem-v2.7.1.tgz`
- `metasheet-attendance-onprem-v2.7.1.zip.sha256`
- `metasheet-attendance-onprem-v2.7.1.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.1.json`
- `SHA256SUMS-v2.7.1`
- canonical `20260328-current` package artifacts

Observed release metadata:

- published at: `2026-03-28T14:38:31Z`
- target commit: `9a958a5a1c0fdb1a53171b5727a9d62d51e3e201`

## Result

`v2.7.1` is now formally published and has deployable attendance on-prem package assets attached.

This release closes the gap between:

- merged attendance admin hotfix code on `main`
- and a formally downloadable, operator-ready on-prem package for that hotfix line
