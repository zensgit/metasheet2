# K3 WISE Workbench Release Publication Development - 2026-05-13

## Scope

This slice converts the verified K3 WISE + generic integration workbench
on-prem package from a short-lived GitHub Actions artifact into a durable
GitHub prerelease.

The previous deploy-readiness proof showed that the Windows `.zip` package could
be generated and verified. GitHub Actions artifacts expire, so this slice
publishes the same deployable package shape as a prerelease asset set that field
operators can download directly.

## Release

- Release: `multitable-onprem-k3wise-workbench-20260513-20548fe`
- URL: `https://github.com/zensgit/metasheet2/releases/tag/multitable-onprem-k3wise-workbench-20260513-20548fe`
- Type: GitHub prerelease
- Target commit: `20548fe6980a28cad8d6472312aea38a7caf99d6`
- Package workflow run: `25783182629`
- Package tag: `k3wise-workbench-20548fe`

## Published Assets

- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip.sha256`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz.sha256`
- `SHA256SUMS`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.json`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip.verify.json`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip.verify.md`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz.verify.json`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz.verify.md`

## Deployment Interpretation

Use the `.zip` asset for Windows Server entity-machine deployment testing.

The release is marked prerelease because the platform can be deployed and tested
now, but real K3 WISE Save-only writes still require customer GATE credentials
and field mapping answers. Submit/Audit remains outside the default deployment
path until explicitly validated.

## Files

- `docs/development/k3wise-workbench-release-publication-development-20260513.md`
- `docs/development/k3wise-workbench-release-publication-verification-20260513.md`

## Non-Goals

- No source code change.
- No migration change.
- No customer K3 endpoint call.
- No promotion to latest stable GitHub Release.
