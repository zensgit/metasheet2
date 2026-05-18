# On-Prem Package Deployable Artifact Clarity Verification - 2026-05-18

## Scope

This verifies the #651 follow-up that makes Multitable on-prem Release assets
self-describing as deployable packages rather than source-only archives.

## Static Checks

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check
```

Expected result:

- shell syntax passes - PASS
- whitespace/conflict-marker check passes - PASS

## Build/Verify Checks

Command:

```bash
INSTALL_DEPS=1 BUILD_WEB=1 BUILD_BACKEND=1 \
  PACKAGE_TAG=clarity-local \
  scripts/ops/multitable-onprem-package-build.sh

VERIFY_REPORT_JSON=/tmp/metasheet-onprem-clarity/zip.verify.json \
VERIFY_REPORT_MD=/tmp/metasheet-onprem-clarity/zip.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-clarity-local.zip

VERIFY_REPORT_JSON=/tmp/metasheet-onprem-clarity/tgz.verify.json \
VERIFY_REPORT_MD=/tmp/metasheet-onprem-clarity/tgz.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-clarity-local.tgz
```

Expected result:

- zip verify returned `Package verify OK`
- tgz verify returned `Package verify OK`
- both package archives included `DEPLOYMENT.txt`
- both package archives included `PACKAGE-METADATA.json`
- verify reports included `deployability-contract`
- external package metadata JSON included deployability fields

Observed zip report excerpt:

```json
{
  "name": "deployability-contract",
  "status": "PASS",
  "artifactKind": "deployable-onprem-app-package",
  "deployMode": "fresh-extract-or-existing-root-apply",
  "directReplaceSafe": false,
  "nodeModulesBundled": false
}
```

## Required Content Added

The verifier now requires:

- `DEPLOYMENT.txt`
- `PACKAGE-METADATA.json`

The verifier also checks these strings:

- package is a deployable on-prem application package
- package is not a source-only archive
- direct replacement of a running install is unsafe
- Windows upgrade entrypoint is `deploy.bat <downloaded-package.zip>`
- `node_modules` are intentionally not bundled

## Artifact Metadata

`PACKAGE-METADATA.json` must contain:

```json
{
  "artifactKind": "deployable-onprem-app-package",
  "deployMode": "fresh-extract-or-existing-root-apply",
  "directReplaceSafe": false,
  "nodeModulesBundled": false,
  "windowsEntryPoint": "deploy.bat <package.zip|package.tgz>"
}
```

The external release metadata JSON mirrors the same fields.

## Regression Boundary

This PR does not validate entity-machine deployment. It only makes future
release assets unambiguous before they are sent to the field team.

The entity-machine retest remains:

1. Download the rebuilt Release zip.
2. Run package verify.
3. Deploy with the documented apply entrypoint.
4. Run K3 WISE postdeploy smoke with frontend/nginx `--base-url`.
