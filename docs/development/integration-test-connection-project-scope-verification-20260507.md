# Integration Test Connection Project Scope Verification - 2026-05-07

## Scope

This verification covers the external-system test route status writeback:

```text
POST /api/integration/external-systems/:id/test
```

The target bug class is accidental project-scope loss when the route persists
connection-test metadata.

## Local Verification

Command:

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result:

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

Assertions added:

- The normal external-system test path now expects `projectId: "project_1"` in
  the persisted status update.
- The failed inactive-system test path expects `projectId:
  "project_inactive"` to survive while `status: "error"` and `lastError` are
  written.
- The successful inactive-system retry expects the same `projectId` to survive
  while the system remains inactive.

## Regression Notes

- No production external PLM or ERP endpoint was contacted.
- No migration was added.
- No credential path changed.
- No public response shape changed except preserving project scope in the
  internal registry write payload.

## Follow-Up

Run the plugin package test before merging:

```bash
pnpm -F plugin-integration-core test
```

