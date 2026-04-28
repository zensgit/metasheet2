# Integration Pipeline Run UI Design - 2026-04-28

## Status

Implemented in `codex/integration-pipeline-run-ui-20260428`.

This slice completes the K3 WISE setup page control loop after staging installation
and draft pipeline creation:

1. Save or select the K3 WISE WebAPI target.
2. Install the PLM/K3 staging multitable objects.
3. Create draft material and BOM cleansing pipelines.
4. Dry-run or run those pipelines from the setup page.

## Files

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`

## UI Behavior

The `PLM -> K3 清洗链路` section now stores the generated or manually entered
pipeline IDs:

- `materialPipelineId`
- `bomPipelineId`

It also exposes the public run options accepted by the plugin REST API:

- `pipelineRunMode`: `manual`, `incremental`, or `full`
- `pipelineSampleLimit`: optional positive integer
- `pipelineCursor`: optional string cursor
- `allowLivePipelineRun`: explicit live-run guard

The side rail now has an `执行 Pipeline` panel with four actions:

- Dry-run material
- Run material
- Dry-run BOM
- Run BOM

Creating draft pipeline templates writes returned IDs back into the form, so the
operator can dry-run immediately without copying IDs by hand.

## API Contract

The frontend posts to the existing plugin routes:

- `POST /api/integration/pipelines/:id/dry-run`
- `POST /api/integration/pipelines/:id/run`

The request body is intentionally limited to the route whitelist:

```json
{
  "tenantId": "tenant_1",
  "workspaceId": "workspace_1",
  "mode": "manual",
  "sampleLimit": 20,
  "cursor": "optional-watermark"
}
```

The frontend does not send server-owned fields such as `dryRun`, `triggeredBy`,
`sourceRecords`, `details`, or `allowInactive`. The plugin route continues to
own those fields and strips unsafe input.

## Safety

Dry-run is available once tenant and pipeline ID validation passes.

Live run requires the operator to explicitly check `允许真实执行 Pipeline`.
This is a frontend guard only; backend authorization and route sanitization remain
the enforcement layer.

## Multitable Cleansing Model

The cleansing chain still uses multitable staging as the operational surface:

- PLM records are normalized into staging objects.
- Pipeline field mappings transform PLM fields into K3 payload fields.
- Validation and dead-letter handling happen in the pipeline runner.
- ERP feedback writes run state back into staging objects when configured.

The UI added here does not replace that model. It exposes the runner controls
needed to operate the model from the K3 setup page.
