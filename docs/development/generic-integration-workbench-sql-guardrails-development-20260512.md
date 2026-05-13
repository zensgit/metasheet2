# Generic Integration Workbench SQL Guardrails Development - 2026-05-12

## Scope

This slice closes the M3 SQL advanced-channel TODOs by making the existing K3 WISE SQL Server safety rules explicit in adapter discovery metadata.

The runtime SQL adapter already enforces:

- Read objects must use configured read allowlists.
- Writes must target configured middle tables.
- Direct K3 core-table writes are blocked unless an explicit low-level escape hatch is configured outside the normal workbench UI.

This change exposes those rules to Workbench clients through `GET /api/integration/adapters`.

## Design

`erp:k3-wise-sqlserver` now returns:

```json
{
  "advanced": true,
  "guardrails": {
    "read": {
      "requiresTableAllowlist": true,
      "allowlistKeys": ["readTables", "allowedTables"]
    },
    "write": {
      "requiresMiddleTableMode": true,
      "requiresTableAllowlist": true,
      "allowlistKeys": ["writeTables", "allowedTables"],
      "writeModes": ["middle-table"]
    },
    "ui": {
      "hiddenByDefault": true,
      "normalUiDirectCoreTableWrites": false
    }
  }
}
```

The generic Workbench already hides advanced connectors by default and shows the implementation warning only after the advanced toggle is enabled. The new metadata gives future clients a machine-readable contract instead of relying only on copy text.

## Files

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `apps/web/src/services/integration/workbench.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-sql-guardrails-development-20260512.md`
- `docs/development/generic-integration-workbench-sql-guardrails-verification-20260512.md`

## Non-Goals

- No raw SQL UI was added.
- No direct K3 core-table write UI was added.
- No change was made to the SQL adapter runtime enforcement path.
