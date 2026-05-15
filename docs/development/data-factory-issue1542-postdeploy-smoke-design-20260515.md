# Data Factory issue #1542 postdeploy smoke - design notes - 2026-05-15

## Scope

This slice extends the existing K3 WISE postdeploy smoke with an opt-in Data
Factory retest for issue #1542. The goal is to make the deployed-box validation
repeatable after a new package is installed, without turning the normal
postdeploy smoke into a write-heavy test.

The new flag is:

```bash
--issue1542-workbench-smoke
```

It is intentionally opt-in because it creates or updates one draft integration
pipeline metadata row. It never runs pipeline dry-run, Save-only, Submit, or
Audit.

## Why this exists

The bridge/test feedback for #1542 had three practical blockers:

- `metasheet:staging` source schema returned `fields: []`.
- `POST /api/integration/pipelines` failed with PostgreSQL JSONB `22P02`.
- SQL Server still returned `SQLSERVER_EXECUTOR_MISSING`.

The first two should be retestable from the deployed host immediately after a
package update. The third remains a separate SQL executor deployment/wiring
item and is not claimed by this smoke.

## Behavior

When `--issue1542-workbench-smoke` is supplied together with an auth token, the
script adds these checks:

| Check | Purpose |
| --- | --- |
| `issue1542-system-readiness` | Load configured external systems and find a `metasheet:staging` source plus an `erp:k3-wise-webapi` target. |
| `issue1542-staging-source-schema` | Call staging source objects/schema APIs and require `standard_materials` fields `code`, `name`, and `uom`. |
| `issue1542-k3-material-schema` | Call K3 target objects/schema APIs and require material fields `FNumber`, `FName`, and `FBaseUnitID`. |
| `issue1542-pipeline-save` | Save a fixed draft pipeline id and verify JSONB-shaped values hydrate back as arrays/objects. |

The fixed pipeline id is:

```text
issue1542_postdeploy_staging_material_smoke
```

Using a fixed id avoids creating a new pipeline on every smoke run. Re-running
the smoke should update the same draft metadata row.

## Safety

- The pipeline status is `draft`.
- `options.target.autoSubmit=false`.
- `options.target.autoAudit=false`.
- The script does not call `/dry-run` or `/run`.
- The target object is K3 `material`, but this slice only saves metadata in
  MetaSheet.
- Existing token/base-url redaction continues to cover stdout, JSON evidence,
  and Markdown evidence.

## Files changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/development/data-factory-issue1542-postdeploy-smoke-design-20260515.md`
- `docs/development/data-factory-issue1542-postdeploy-smoke-verification-20260515.md`

## Out of scope

- No SQL Server executor implementation.
- No new database migration.
- No frontend behavior change.
- No customer K3 live Submit/Audit.
- No automatic cleanup route for pipelines; the fixed draft id is reused instead.
