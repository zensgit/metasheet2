# Data Factory Issue #1542 Workbench Seed Helper - Development

Date: 2026-05-15

## Purpose

The postdeploy smoke added for issue #1542 can now verify the Data Factory
Workbench route, adapter metadata, staging schema discovery, K3 material schema
discovery, and draft pipeline save. The first run on the 142 host failed before
the real smoke surface because `integration_external_systems` was empty:

```text
issue1542-system-readiness failed:
MetaSheet staging source system is not configured
```

That is a deployment setup precondition, not a product code failure. Operators
need a repeatable way to create the minimum metadata required for the retest
without entering real K3 credentials or calling K3 Save.

## Scope

This slice adds a metadata-only operator helper:

```bash
scripts/ops/integration-issue1542-seed-workbench-systems.mjs
```

The helper creates or updates:

- one `metasheet:staging` source system scoped to the supplied tenant/project;
- one `erp:k3-wise-webapi` target system for K3 Material schema discovery.

It deliberately does not:

- write K3 credentials;
- run dry-run;
- run Save-only;
- run Submit or Audit;
- modify `integration_pipelines`;
- bypass customer GATE.

## Modes

### Existing Staging Sheet

If the operator already created staging multitable sheets, they can provide the
`standard_materials` sheet id directly:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --standard-materials-sheet-id "$STANDARD_MATERIALS_SHEET_ID"
```

### Install Then Seed

For a fresh deployment, the helper can first call the existing
`POST /api/integration/staging/install` route and use the returned
`sheetIds.standard_materials`:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --install-staging
```

This mirrors the Workbench UI path: create staging tables, then use
`standard_materials` as a Dry-run source.

## Payload Contract

The staging source payload matches the UI's existing `activateStagingAsSource`
shape:

```json
{
  "kind": "metasheet:staging",
  "role": "source",
  "status": "active",
  "config": {
    "projectId": "default",
    "objects": {
      "standard_materials": {
        "sheetId": "sheet_x",
        "fields": ["code", "name", "uom"],
        "fieldDetails": []
      }
    }
  }
}
```

The K3 target payload is intentionally metadata-only. K3 schema discovery is
local to the adapter template registry, so the postdeploy smoke can verify the
K3 Material template without a live K3 token:

```json
{
  "kind": "erp:k3-wise-webapi",
  "role": "target",
  "status": "active",
  "config": {
    "baseUrl": "http://127.0.0.1/K3API/",
    "autoSubmit": false,
    "autoAudit": false,
    "objects": {},
    "metadataOnly": true
  }
}
```

The helper omits `credentials`, so it will not create or overwrite K3 secrets.

## Artifact Contract

The helper writes two local artifacts under `--out-dir`:

- `integration-issue1542-seed-workbench-systems.json`
- `integration-issue1542-seed-workbench-systems.md`

Files are written with mode `0600`; the directory is created with mode `0700`.
The artifact records ids, sheet ids, status, mode, and next command guidance.
It stores no bearer token and no K3 credential.

## Package Surface

`scripts/ops/multitable-onprem-package-verify.sh` now checks that the helper is
included in the Windows/on-prem package and that the internal-trial runbook
documents it next to `--issue1542-workbench-smoke`.

## Expected Operator Flow

1. Generate a short-lived admin token on the deployment host.
2. Run the seed helper with `--install-staging` or a known
   `--standard-materials-sheet-id`.
3. Run `integration-k3wise-postdeploy-smoke.mjs --issue1542-workbench-smoke`.
4. If the smoke passes, the Data Factory workbench metadata path is ready.
5. Enter real K3 WebAPI credentials only from the K3 setup page before any
   Save-only/live work.
