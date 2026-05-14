# Integration Staging Open Multitable Design - 2026-05-14

## Goal

After PLM / external-system data is pulled into integration staging, operators need a direct way to open the generated multitable sheets and clean the data there. Before this change, `/api/integration/staging/install` returned only `sheetIds`, while the multitable route requires both `sheetId` and `viewId`. The K3 WISE setup page therefore showed a JSON blob instead of an operator-friendly "open table" path.

This slice closes that gap without changing the K3 adapter, pipeline schema, or database migrations.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/staging-installer.cjs`
- `plugins/plugin-integration-core/__tests__/staging-installer.test.cjs`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`

No SQL migration, no K3 WebAPI behavior change, no pipeline execution behavior change.

## Backend Contract

`installStaging()` still provisions the five user-visible staging sheets:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

It now also attempts to provision one default grid view for each sheet through `context.api.multitable.provisioning.ensureView()`.

The response keeps the existing `sheetIds` map and adds:

```json
{
  "viewIds": {
    "standard_materials": "view_..."
  },
  "openLinks": {
    "standard_materials": "/multitable/sheet_.../view_...?baseId=base_..."
  },
  "targets": [
    {
      "id": "standard_materials",
      "name": "Standard Materials",
      "sheetId": "sheet_...",
      "viewId": "view_...",
      "baseId": "base_...",
      "openLink": "/multitable/sheet_.../view_...?baseId=base_..."
    }
  ],
  "warnings": []
}
```

`ensureView` is treated as optional for backward compatibility with older plugin-host test contexts. If it is missing, sheets are still installed and the response warns that open links could not be generated.

## Frontend Behavior

After "安装 Staging 多维表" succeeds, the K3 WISE setup page now renders an "open target" list instead of forcing users to interpret raw ids.

Display order is intentionally workflow-oriented:

1. `standard_materials` - main material cleansing table
2. `bom_cleanse` - main BOM cleansing table
3. `integration_exceptions` - rows that need manual correction
4. `plm_raw_items` - raw source audit table
5. `integration_run_log` - execution trace

The cards show business labels and short usage hints. Technical ids remain available in the JSON response for debugging, but they are not printed into the primary card copy.

## Route Shape

Generated links target the existing multitable route:

```text
/multitable/:sheetId/:viewId?baseId=:baseId
```

Route segments and `baseId` are URI-encoded both backend-side and frontend fallback-side.

## Why This Is The Right Cut

This keeps the product centered on multitable cleansing:

- Data still lands in multitable staging sheets.
- Business users open `standard_materials` and `bom_cleanse` to fix data.
- JSON remains a transport/debug artifact, not the primary business surface.
- K3 Save-only / dry-run flow stays unchanged.

The next deployment can therefore tell users: install staging tables, click "打开多维表", clean the rows, then run dry-run.
