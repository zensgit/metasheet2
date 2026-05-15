# Data Factory issue #1542 postdeploy signoff verification - 2026-05-15

## Verification Source

Evidence was collected from GitHub Actions workflow run `25905364900`:

```text
Workflow: K3 WISE Postdeploy Smoke
Run URL: https://github.com/zensgit/metasheet2/actions/runs/25905364900
Commit: f612a04c00b05baaf7aeb6016a16defc6c72f871
Conclusion: success
Job: smoke / success
```

The run used the manual input `issue1542_install_staging=true`.

## Input Check Result

```text
ok=true
summary=6 pass / 0 warn / 0 fail
```

Checks:

| Check | Result |
| --- | --- |
| `base-url` | pass |
| `auth-token` | pass |
| `tenant-id` | pass |
| `issue1542-install-staging` | pass |
| `smoke-output` | pass |
| `timeout` | pass |

## Postdeploy Smoke Result

```text
ok=true
authenticated=true
signoff.internalTrial=pass
summary=17 pass / 0 skipped / 0 fail
```

Baseline checks passed:

- `api-health`
- `integration-plugin-health`
- `k3-wise-frontend-route`
- `data-factory-frontend-route`
- `auth-me`
- `integration-route-contract`
- `data-factory-adapter-discovery`
- `integration-list-external-systems`
- `integration-list-pipelines`
- `integration-list-runs`
- `integration-list-dead-letters`
- `staging-descriptor-contract`

Issue #1542 checks passed:

| Check | Evidence |
| --- | --- |
| `issue1542-staging-install` | installed 5 staging objects: `plm_raw_items`, `standard_materials`, `bom_cleanse`, `integration_exceptions`, `integration_run_log` |
| `issue1542-system-readiness` | checked 3 systems, including the generated `metasheet:staging` source and K3 metadata target |
| `issue1542-staging-source-schema` | `standard_materials` returned 11 fields; required fields include `code`, `name`, `uom` |
| `issue1542-k3-material-schema` | `material` returned 4 target fields; required fields include `FNumber`, `FName`, `FBaseUnitID` |
| `issue1542-pipeline-save` | saved draft pipeline `issue1542_postdeploy_staging_material_smoke` with 3 field mappings |

## Regression Interpretation

The deployment no longer reproduces the previously reported issue #1542 P0
blockers:

- `standard_materials` schema is not empty;
- staging can be used as a source via installed metadata;
- `POST /api/integration/pipelines` did not return `22P02`;
- a pipeline id was returned for the draft staging-to-K3 material pipeline.

## Local Artifact Inspection

The workflow artifact was downloaded locally and inspected from:

```text
/tmp/ms2-issue1542-workflow-artifacts/integration-k3wise-postdeploy-smoke-25905364900-1/
```

Inspected files:

- `integration-k3wise-postdeploy-env-check/manual/integration-k3wise-postdeploy-env-check.json`
- `integration-k3wise-postdeploy-smoke/manual/integration-k3wise-postdeploy-smoke.json`
- `integration-k3wise-postdeploy-smoke/manual/integration-k3wise-postdeploy-smoke.md`

Only redacted/sanitized evidence is copied into this document. No bearer token,
authority code, password, SQL connection string, JDBC URL, or K3 credential is
included.

## Commands Used

```bash
gh workflow run integration-k3wise-postdeploy-smoke.yml \
  --ref main \
  -f base_url=http://142.171.239.56:8081 \
  -f require_auth=true \
  -f tenant_id=default \
  -f auto_discover_tenant=false \
  -f issue1542_install_staging=true \
  -f timeout_ms=10000

gh run watch 25905364900 --interval 10

gh run download 25905364900 \
  --dir /tmp/ms2-issue1542-workflow-artifacts
```

## Out Of Scope

This verification does not claim:

- SQL Server source executor availability;
- K3 live Save-only success;
- Submit/Audit success;
- customer production GATE readiness.

Those remain separate deployment/customer-GATE validations.
