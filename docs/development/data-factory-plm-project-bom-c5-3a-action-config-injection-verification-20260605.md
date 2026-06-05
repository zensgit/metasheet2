# Data Factory PLM stock-preparation C5-3a action config injection verification (2026-06-05)

## Scope

C5-3a fixes the entity-machine C5-3 blocker found in #2253: the
`plugin-integration-core` table-action routes were implemented, but the host
created the plugin context with `config: {}`. As a result,
`GET /api/integration/table-actions` correctly returned `configured:false`
because no server-owned action config could reach the plugin.

This slice adds a narrow deployment-time config ingestion path for
`plugin-integration-core` only:

- `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` ->
  `context.config.stockPreparationTableActions`;
- `INTEGRATION_CORE_TABLE_ACTIONS_JSON` -> `context.config.tableActions`.

Both values must be valid JSON arrays or objects. Invalid JSON or primitive
JSON fails closed at startup instead of silently starting with empty config.

## Boundary

This slice does not add:

- UI changes;
- PLM reads;
- MetaSheet writes;
- K3 Save / Submit / Audit / BOM;
- migrations;
- raw SQL;
- permission model changes;
- datasource credentials in the integration plugin config.

The table-action config remains server-side/admin-owned. Public action metadata
is still values-free and does not expose source system ids or target sheet ids.

## Non-secret deployment shape

The stock-preparation action JSON may carry IDs and field maps needed to bind
the already-reviewed C5 action, for example:

```json
[
  {
    "actionId": "plm.stock-preparation.pull-bom.v1",
    "source": {
      "kind": "data-source:sql-readonly",
      "externalSystemId": "integration_external_system_id_for_plm_sql",
      "readPlan": {}
    },
    "target": {
      "sheetId": "stock_preparation_sheet_id",
      "objectId": "stockPreparationMain",
      "fieldIdMap": {}
    },
    "limits": {
      "maxDepth": 8,
      "maxRows": 5000
    }
  }
]
```

`source.externalSystemId` is the Integration external-system id whose kind is
`data-source:sql-readonly`; it is not the raw datasource id and it must not
contain database credentials.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-config.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter plugin-integration-core test:http-routes
git diff --check
```

Results:

- `plugin-runtime-config.test.ts`: 5/5 passed.
- `@metasheet/core-backend build`: passed.
- `plugin-integration-core test:http-routes`: passed.
- `git diff --check`: passed.

## Test locks

`packages/core-backend/tests/unit/plugin-runtime-config.test.ts` locks the host
ingestion path:

- unrelated plugins receive `{}` and do not parse integration env;
- `plugin-integration-core` receives both stock-specific and generic
  table-action config;
- invalid JSON rejects;
- primitive JSON rejects.

`plugins/plugin-integration-core/__tests__/http-routes.test.cjs` remains the
consumer lock:

- configured action metadata reports `configured:true`;
- public metadata does not expose the configured target sheet id;
- public metadata does not expose the configured source external-system id;
- unconfigured action remains fail-closed.

## Remaining gate

After this slice lands, cut a refreshed on-prem package and rerun #2253 C5-3
entity-machine smoke. The operator should confirm:

- `GET /api/integration/table-actions?tenantId=default` reports
  `configured:true` for `plm.stock-preparation.pull-bom.v1`;
- dry-run remains read-only and values-free in issue evidence;
- apply is executed only if explicitly approved for the configured
  stock-preparation target.
