# Attendance On-Prem v2.7.1 Package Release

Date: 2026-03-28

## Goal

Publish a formal `v2.7.1` hotfix release that includes deployable attendance on-prem package assets.

This release exists because `v2.7.0` was already formally published, but the attendance admin hotfixes from PR `#567` landed afterward on `main`. Those hotfixes needed a new semver release instead of being folded back into `v2.7.0`.

## Packaging base

- source branch: `main`
- source commit: `9a958a5a1c0fdb1a53171b5727a9d62d51e3e201`
- merge source: PR `#567` `fix(attendance): restore admin console regressions`

## Decision

Use the merged `main` hotfix commit as the release target and publish `v2.7.1` as a patch release.

For packaging:

1. build from a clean worktree at `main@9a958a5a1`
2. override `PACKAGE_VERSION=2.7.1` during on-prem packaging
3. produce canonical traceable artifacts with suffix `20260328-current`
4. additionally publish no-suffix operator-friendly aliases
5. create a new GitHub Release `v2.7.1` instead of mutating `v2.7.0`

## Hotfix scope

`v2.7.1` packages the attendance admin fixes that restored or hardened:

- focused right-pane section rendering with show-all toggle
- Run21-facing admin UX slices:
  - user picker
  - import field guide
  - holiday month calendar
  - structured rule builder
- create payload compatibility for approval flow and rule set admin routes
- reduced unauthenticated login flash
- attendance id semantics:
  - malformed id -> `400`
  - valid-but-missing id -> `404`
- regenerated OpenAPI artifacts for `GET /api/attendance/rotation-rules/{id}`

## Published assets

### Canonical traceable assets

- `metasheet-attendance-onprem-v2.7.1-20260328-current.tgz`
- `metasheet-attendance-onprem-v2.7.1-20260328-current.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.1-20260328-current.zip`
- `metasheet-attendance-onprem-v2.7.1-20260328-current.zip.sha256`
- `metasheet-attendance-onprem-v2.7.1-20260328-current.json`

### Operator-friendly alias assets

- `metasheet-attendance-onprem-v2.7.1.tgz`
- `metasheet-attendance-onprem-v2.7.1.tgz.sha256`
- `metasheet-attendance-onprem-v2.7.1.zip`
- `metasheet-attendance-onprem-v2.7.1.zip.sha256`
- `metasheet-attendance-onprem-v2.7.1.json`
- `SHA256SUMS-v2.7.1`

## Release target

- release: `v2.7.1`
- release URL: <https://github.com/zensgit/metasheet2/releases/tag/v2.7.1>
- target commit: `9a958a5a1c0fdb1a53171b5727a9d62d51e3e201`

## Notes

- The build script still derives the package version from `package.json` by default.
- `package.json` on the release commit still does not equal `2.7.1`, so packaging needed the explicit `PACKAGE_VERSION=2.7.1` override.
- This keeps the hotfix release narrow: no extra source-version synchronization change was mixed into the shipping release.
