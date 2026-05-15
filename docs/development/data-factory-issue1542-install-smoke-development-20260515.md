# Data Factory issue #1542 install-staging smoke development - 2026-05-15

## Summary

This slice closes the gap between the #1572 staging-install project-scope fix
and the deployed-box #1542 smoke.

Before this change, the opt-in `--issue1542-workbench-smoke` expected a
`metasheet:staging` source external system to already exist. That meant a
freshly deployed box still needed a separate manual or seed step before the
smoke could verify the real Data Factory setup path.

The smoke now supports:

```bash
--issue1542-workbench-smoke --issue1542-install-staging
```

With both flags, the script:

1. reads staging descriptors;
2. calls `POST /api/integration/staging/install`;
3. requires `sheetIds.standard_materials`;
4. builds a `metasheet:staging` source config from returned `targets` or
   `sheetIds`;
5. upserts that source through `POST /api/integration/external-systems`;
6. continues the existing #1542 schema and draft-pipeline save checks.

The flag intentionally creates only the MetaSheet staging source. It still
expects an `erp:k3-wise-webapi` target to exist from the K3 preset page, the
Data Factory target-system form, or the existing metadata-only seed helper.

## Safety

- This is opt-in and does not run during the default postdeploy smoke.
- It writes only staging/source/pipeline metadata.
- It does not call pipeline dry-run.
- It does not call Save-only, Submit, or Audit.
- It does not include credentials, K3 tokens, SQL connection strings, or
  authority codes in evidence.

## Files changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/development/data-factory-issue1542-install-smoke-development-20260515.md`
- `docs/development/data-factory-issue1542-install-smoke-verification-20260515.md`

## Runtime behavior

The new check ID is:

```text
issue1542-staging-install
```

A passing check records:

- resolved project ID;
- created/upserted staging source system ID;
- returned staging sheet IDs;
- configured staging objects;
- warning count.

If staging install fails or returns no `standard_materials` sheet, the smoke
fails before attempting schema or pipeline-save checks. This makes the failure
cause direct and keeps the evidence small.

When multiple `metasheet:staging` sources already exist, the smoke carries the
freshly installed/upserted source system ID forward and uses that exact source
for schema discovery and draft pipeline save. This prevents the deployment
smoke from accidentally validating an older staging source left in the tenant.

## Operator command

Prerequisite: save or seed one K3 WISE WebAPI target for the same tenant scope.

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --issue1542-workbench-smoke \
  --issue1542-install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

Expected passing #1542 checks:

- `issue1542-staging-install`
- `issue1542-system-readiness`
- `issue1542-staging-source-schema`
- `issue1542-k3-material-schema`
- `issue1542-pipeline-save`

## Out of scope

- SQL Server executor implementation remains outside this slice.
- No new migration.
- No frontend UI change.
- No automatic K3 target creation in the smoke itself.
- No K3 live write.
