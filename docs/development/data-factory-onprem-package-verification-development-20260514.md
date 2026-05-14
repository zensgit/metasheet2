# Data Factory on-prem package verification - development notes - 2026-05-14

## Purpose

This documentation slice records the deployment-package closeout after the Data
Factory source/target multitable work and postdeploy smoke hardening landed on
`main`.

The goal is not to add another runtime capability. The goal is to make the
current deployable Windows/on-prem artifact traceable:

- Data Factory workbench UI is built into the web dist.
- `metasheet:staging` and `metasheet:multitable` adapter metadata is packaged.
- postdeploy smoke validates Data Factory frontend and adapter discovery.
- postdeploy summary renders adapter drift details from `invalidAdapters`.
- the package verifier checks the above contract before an operator installs the
  zip on a Windows bridge/on-prem host.

## Artifact Built

The official GitHub workflow was dispatched against `main` after PR #1559:

```text
Workflow: Multitable On-Prem Package Build
Run:      25859650271
Head:     c120ae3fa4fe0ddfa118901da9cd77b987e57da6
Tag:      data-factory-c120ae3f
```

The workflow produced:

```text
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.tgz
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip
SHA256SUMS
package metadata JSON
```

## Files Relevant To This Closeout

The package verifier already enforces the Data Factory contract through:

- `scripts/ops/multitable-onprem-package-verify.sh`
  - checks the web dist contains Data Factory route/copy;
  - checks the K3/internal-trial postdeploy smoke contains
    `data-factory-frontend-route`;
  - checks the smoke contains `data-factory-adapter-discovery`;
  - checks the summary renderer contains `invalidAdapters`.
- `scripts/ops/multitable-onprem-package-build.sh`
  - includes the Data Factory development/verification docs in the package.

This closeout adds documentation only. It does not change package content,
runtime APIs, migrations, adapters, K3 behavior, or deployment scripts.

## Deployment Impact

- No runtime code change.
- No migration.
- No package script change.
- No generated artifact is committed.
- No secrets or environment values are recorded.

The verified zip is suitable for the next deployment attempt from a package
content perspective. A real host still must run the existing preflight,
migration, startup, and postdeploy smoke steps.
