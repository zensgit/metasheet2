# Data Factory Issue #1542 142 Retest Verification

Date: 2026-05-15

## Baseline

- PR #1569 merged to main as `7e38fee72`.
- Main workflows for that merge completed successfully:
  - Phase 5 Production Flags Guard
  - Deploy to Production
  - Build and Push Docker Images
  - Plugin System Tests
  - SafetyGuard E2E
  - Observability E2E
  - monitoring-alert
- 142 host checkout: `HEAD=7e38fee`.
- 142 backend health:
  - `status=ok`
  - `pluginsSummary.total=13`
  - `pluginsSummary.active=13`
  - `pluginsSummary.failed=0`

## Token Handling

A short-lived admin JWT was minted inside the `metasheet-backend` container and
written to a temporary `0600` file. The token value was not printed. The
temporary token file was removed by shell trap after the retest.

## First Attempt: Install Staging Then Seed

Command shape:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/issue1542-seed
```

Result:

```text
token_shape=valid
staging install did not return sheetIds.standard_materials
```

Interpretation: the deployment accepted authenticated control-plane calls, but
the current multitable provisioning path did not return a `standard_materials`
sheet id. This blocks real staging dry-run readiness, but it does not block the
metadata-only #1542 schema/pipeline-save retest.

## Fallback Attempt: Metadata-Only Sheet Id

Command shape:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --standard-materials-sheet-id issue1542_metadata_standard_materials \
  --standard-materials-view-id issue1542_metadata_view \
  --standard-materials-open-link /multitable/issue1542_metadata_standard_materials/issue1542_metadata_view \
  --out-dir artifacts/integration-k3wise/internal-trial/issue1542-seed-direct
```

Seed result:

```json
{
  "decision": "PASS",
  "mode": "seed-existing-sheet",
  "stagingSource": "metasheet_staging_default",
  "k3Target": "issue1542_k3wise_webapi_metadata_target",
  "sheetIdPresent": true
}
```

## Issue #1542 Smoke Result

Command shape:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --require-auth \
  --issue1542-workbench-smoke \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542-direct
```

Result:

```json
{
  "ok": true,
  "signoff": "pass",
  "reason": "authenticated smoke passed",
  "summary": {
    "pass": 16,
    "skipped": 0,
    "fail": 0
  },
  "issue1542": [
    { "id": "issue1542-system-readiness", "status": "pass" },
    { "id": "issue1542-staging-source-schema", "status": "pass" },
    { "id": "issue1542-k3-material-schema", "status": "pass" },
    { "id": "issue1542-pipeline-save", "status": "pass" }
  ]
}
```

## Secret Leak Check

The generated seed and smoke artifact directories were scanned:

```text
secret_jwt_shape_hits=0
secret_bearer_hits=0
secret_field_hits=0
```

## Artifact Paths On 142

```text
artifacts/integration-k3wise/internal-trial/issue1542-seed-direct-20260515T043104Z/
artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542-direct-20260515T043104Z/
```

## Conclusion

The #1542 Data Factory metadata path is verified on 142 after #1569:

- authenticated integration routes work;
- `metasheet:staging` source metadata can expose `standard_materials` schema;
- K3 WebAPI target metadata exposes the `material` schema;
- the fixed issue #1542 draft pipeline can be saved;
- artifacts remain token-safe.

Remaining deployment gap: real staging table provisioning did not return
`sheetIds.standard_materials`. The metadata fallback is acceptable for #1542
schema/pipeline-save retest only. Real dry-run still requires fixing or
rerunning multitable provisioning so `standard_materials` is backed by an
actual sheet.
