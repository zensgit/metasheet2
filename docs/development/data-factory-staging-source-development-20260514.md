# Data Factory staging source adapter - development notes - 2026-05-14

## Purpose

This change lets Data Factory use MetaSheet staging multitables as a read-only source system. The immediate goal is to let an operator open a cleansing table, edit rows in the normal multitable UI, then run `staging -> target` dry-runs without waiting for the upstream PLM / SQL connector to be live.

This keeps the product shape aligned with the Data Factory plan:

- business users cleanse data in multitables, not in JSON editors;
- K3 WISE remains one target preset, not the whole product surface;
- the same pipeline model can run `source dataset -> staging -> target dataset`;
- no new database migration is required for this slice.

## Implementation

### Backend adapter

`plugins/plugin-integration-core/lib/adapters/metasheet-staging-source-adapter.cjs` adds a new adapter kind:

```text
metasheet:staging
```

The adapter is source-only. It reads rows through the host-owned multitable records API:

```text
context.api.multitable.records.queryRecords({ sheetId, filters, limit, offset })
```

External system config is intentionally explicit:

```json
{
  "objects": {
    "standard_materials": {
      "name": "物料清洗",
      "sheetId": "sheet_materials",
      "viewId": "view_materials",
      "baseId": null,
      "openLink": "/multitable/sheet_materials/view_materials",
      "fields": ["code", "name", "uom", "quantity"]
    }
  }
}
```

Each configured object becomes one readable dataset. Returned records include the row data plus metadata fields:

- `_metaRecordId`
- `_metaRecordVersion`
- `_metaSheetId`

Writes are rejected through the normal adapter contract, so staging remains the user-owned cleansing surface rather than a hidden integration write target.

### Discovery metadata

`plugins/plugin-integration-core/lib/http-routes.cjs` exposes `metasheet:staging` as a non-advanced source adapter:

- `roles: ['source']`
- `guardrails.read.hostOwned: true`
- `guardrails.read.dryRunFriendly: true`
- `guardrails.read.noExternalNetwork: true`
- `guardrails.write.supported: false`

This makes the UI able to present it as a normal Data Factory source while still signalling that it does not call an external network.

### Workbench UI

`apps/web/src/views/IntegrationWorkbenchView.vue` adds a `作为 Dry-run 来源` action beside each installed staging table.

When clicked, the view:

1. builds an object config from existing staging descriptors and open links;
2. upserts a deterministic external system id, for example `metasheet_staging_project_1`;
3. selects that system as the current source;
4. selects the clicked staging object;
5. seeds the source schema from staging descriptor fields.

The existing `打开多维表` action stays in place. The intended operator flow is:

```text
创建清洗表 -> 打开多维表清洗 -> 作为 Dry-run 来源 -> 预览 / dry-run -> Save-only 推送
```

### Service API

`apps/web/src/services/integration/workbench.ts` adds `upsertWorkbenchExternalSystem()` so the workbench can create or refresh the internal staging source system through the existing `/api/integration/external-systems` endpoint.

No new public API route, table, or migration is introduced.

## Non-goals

- No direct writes back into staging through this adapter.
- No live K3 Submit / Audit behavior change.
- No SQL executor change.
- No source connector wizard in this slice.
- No new document templates beyond the existing K3 Material / BOM path.

## Deployment impact

Runtime impact is low:

- one new plugin adapter factory is registered at activation time;
- no migration is required;
- no background job is added;
- the adapter only runs when an operator configures a `metasheet:staging` source system.

For Windows / on-prem packages, the slice is covered by normal build output because it only changes web assets, plugin code, and docs.
