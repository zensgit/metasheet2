# On-Prem Package Deployable Artifact Clarity Design - 2026-05-18

## Context

Issue #651 reported that the `multitable-onprem-k3wise-20260518-31d25abac`
Release zip downloaded successfully and matched SHA256, but looked like a
source/documentation tree after extraction. That made the field deployment path
ambiguous: operators could not tell whether the asset was directly deployable,
source-only, or meant for another wrapper.

Inspection showed the asset is the expected deployable package. It contains
built frontend output, built backend output, migrations, packaged plugins,
ops scripts, environment templates, nginx examples, and runbooks. The package
intentionally preserves workspace-style paths because the runtime and deploy
helpers resolve files relative to those paths.

The gap was artifact self-description, not missing runtime content.

## Decision

Keep the existing package layout. Do not convert it into a binary or bundle
`node_modules`.

Instead, make the deployability contract explicit in three places:

1. `DEPLOYMENT.txt` inside the package root.
2. `PACKAGE-METADATA.json` inside the package root.
3. The external release metadata JSON and verify reports.

The package verifier now treats this contract as required content. Future
release assets that do not explain deployability, direct-replacement safety,
or dependency policy fail verification before delivery.

## Contract

The package declares:

- `artifactKind`: `deployable-onprem-app-package`
- `deployMode`: `fresh-extract-or-existing-root-apply`
- `directReplaceSafe`: `false`
- `nodeModulesBundled`: `false`
- `windowsEntryPoint`: `deploy.bat <package.zip|package.tgz>`

`directReplaceSafe=false` is intentional. The archive should not be applied by
hand-copying selected directories into a running installation. Upgrade flows
must use the existing deploy root's apply helper, which extracts the archive,
copies package contents consistently, installs dependencies when missing, runs
migrations, restarts PM2, and healthchecks.

## Non-Goals

- No K3 runtime behavior changes.
- No frontend routing changes.
- No migration changes.
- No packaging of `node_modules`.
- No change to Release asset names in this PR.

## Deployment Impact

Future packages include two extra root files and richer metadata. Existing
deployment scripts continue to work.

For field operators, the intended flow becomes harder to miss:

- Fresh install: extract the archive and follow the easy-start guide.
- Upgrade/corrective reroll: run `deploy.bat <downloaded-package.zip>` from the
  existing deploy root.
