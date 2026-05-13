# Generic Integration Workbench Pipeline Run Design - 2026-05-12

## Purpose

This slice turns the generic integration workbench from a preview-only page into a small execution loop:

1. save the selected source/target/object/mapping setup as an `integration_pipelines` row;
2. run the saved pipeline in dry-run mode;
3. optionally run a guarded Save-only push;
4. refresh run/dead-letter observation in the companion observation slice.

The product boundary stays the same: MetaSheet tables remain the cleansing and review surface. The workbench stores mapping and execution policy. It does not become a full ERP document editor.

## Frontend Service Additions

`apps/web/src/services/integration/workbench.ts` now exposes:

- `upsertIntegrationPipeline(payload)`;
- `runIntegrationPipeline(pipelineId, payload, dryRun)`;
- pipeline request/result types shared by the workbench view tests.

The service uses the existing plugin routes:

- `POST /api/integration/pipelines`;
- `POST /api/integration/pipelines/:id/dry-run`;
- `POST /api/integration/pipelines/:id/run`.

No backend route or migration is added in this slice.

## Workbench UI Additions

`apps/web/src/views/IntegrationWorkbenchView.vue` now includes a `Pipeline 执行` section:

- pipeline name;
- pipeline mode: `manual`, `incremental`, `full`;
- idempotency key fields;
- staging descriptor selector;
- saved pipeline ID;
- run mode;
- dry-run sample limit;
- Save-only confirmation checkbox;
- buttons for save, dry-run, and Save-only run;
- result JSON panel.

The saved pipeline is created as `status: active` so operator-triggered dry-run/run works immediately. This does not schedule anything by itself; execution still requires an explicit button click.

## Payload Shape

The upsert payload keeps the generic workbench contract small:

```json
{
  "tenantId": "default",
  "workspaceId": null,
  "name": "PLM Source:materials -> K3 Target:material",
  "sourceSystemId": "plm_1",
  "sourceObject": "materials",
  "targetSystemId": "k3_1",
  "targetObject": "material",
  "stagingSheetId": "standard_materials",
  "mode": "manual",
  "status": "active",
  "idempotencyKeyFields": ["code"],
  "options": {
    "target": {
      "autoSubmit": false,
      "autoAudit": false
    },
    "workbench": {
      "source": "generic-integration-workbench",
      "version": "v1"
    },
    "k3Template": {
      "id": "k3wise.material.v1",
      "documentType": "material",
      "bodyKey": "Data"
    }
  },
  "fieldMappings": []
}
```

`fieldMappings` are built from the mapping grid. `options.k3Template` is included only when the selected target object carries template metadata.

## Save-Only Guard

Save-only push is guarded in the UI:

- dry-run does not require confirmation;
- live run is disabled until the operator checks `允许本次 Save-only 推送`;
- the generated pipeline options always set `autoSubmit: false` and `autoAudit: false`;
- the result panel shows the exact sanitized API response returned by the backend.

This matches the current K3 WISE Stage 1 rule: live customer Submit/Audit remains blocked until the customer GATE data and explicit sign-off exist.

## Non-Goals

- No scheduled pipeline automation.
- No dead-letter table UI yet.
- No pipeline list/search UI yet.
- No staging table picker yet.
- No custom template authoring UI.
