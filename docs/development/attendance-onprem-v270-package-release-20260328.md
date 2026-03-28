# Attendance On-Prem v2.7.0 Package Release

Date: 2026-03-28

## Goal

Publish deployable attendance on-prem package assets for the formal source release `v2.7.0`.

Before this release action:

- formal source release `v2.7.0` existed
- `v2.7.0` had no attached assets
- the latest attendance on-prem package release was still `attendance-onprem-run21-20260322`

That meant source release and installable on-prem package were out of sync.

## Decision

Use the verified `v2.7.0` source tag as the packaging base, but do not mutate repository source files just to fix packaging version naming.

Instead:

1. build from the clean `v2.7.0` tree
2. override `PACKAGE_VERSION=2.7.0` during packaging
3. produce canonical traceable package assets with suffix `20260328-current`
4. additionally publish no-suffix alias assets for easier operator download
5. upload the assets directly to the existing `v2.7.0` GitHub Release

## Published assets

### Canonical traceable assets

- `metasheet-attendance-onprem-v2.7.0-20260328-current.tgz`
- `metasheet-attendance-onprem-v2.7.0-20260328-current.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.0-20260328-current.zip`
- `metasheet-attendance-onprem-v2.7.0-20260328-current.zip.sha256`
- `metasheet-attendance-onprem-v2.7.0-20260328-current.json`

### Operator-friendly alias assets

- `metasheet-attendance-onprem-v2.7.0.tgz`
- `metasheet-attendance-onprem-v2.7.0.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.0.zip`
- `metasheet-attendance-onprem-v2.7.0.zip.sha256`
- `metasheet-attendance-onprem-v2.7.0.json`
- `SHA256SUMS-v2.7.0`

## Release target

- release: `v2.7.0`
- release URL: <https://github.com/zensgit/metasheet2/releases/tag/v2.7.0>
- source commit: `0977b4b19e35d474df4057ea82809d07e6f359c0`

## Notes

- The build script currently derives package version from `package.json` by default.
- Because `package.json` still reads `2.5.0` at tag `v2.7.0`, packaging needed an explicit environment override.
- This release action fixes deployable assets immediately without widening scope into a late source-version synchronization change.

## Follow-up recommendation

Future on-prem releases should make one of these two paths explicit:

1. synchronize `package.json` before packaging
2. or formalize `PACKAGE_VERSION` override as the packaging source of truth for on-prem release automation

The current manual override worked, but it should not stay implicit.
