# Data Factory issue #651 external-system delete verification - 2026-05-17

## Summary

This verification covers the small #651 follow-up that turns the Data Factory
connection inventory delete control into a real backend-protected operation.

## Local Commands

### Backend registry

```bash
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
```

Result:

```text
PASS - external-systems: registry + credential boundary tests passed
```

Coverage added:

- referenced external systems throw `ExternalSystemConflictError`
- conflict counts are scoped by tenant/workspace
- unused external systems are removed
- deleted public system output does not expose credentials
- missing delete target throws `ExternalSystemNotFoundError`
- registry construction requires `deleteRows` and `countRows`

### Backend HTTP routes

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result:

```text
PASS - http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

Coverage added:

- `DELETE /api/integration/external-systems/:id` is registered
- write-permission user can call delete
- scoped `{ id, tenantId, workspaceId }` is passed to the registry
- registry conflict maps to HTTP `409`

### Frontend Data Factory view

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

```text
PASS - 1 file, 7 tests
```

Coverage added:

- inventory delete button is enabled
- click confirms the destructive action
- frontend calls `DELETE /api/integration/external-systems/k3_target?tenantId=default`
- deleted connection is removed from the rendered inventory
- success status shows `连接已删除：...`

### Frontend type check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

```text
PASS - exit 0
```

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
PASS - vite build completed
```

Notes:

- Vite reported the existing WorkflowDesigner dynamic/static import warning.
- Vite reported existing large chunk warnings.
- No build error was produced.

### Diff hygiene

```bash
git diff --check
```

Result:

```text
PASS - exit 0
```

## Notes

`pnpm install --frozen-lockfile --ignore-scripts` was needed in the isolated
worktree before running frontend tests. It temporarily changed several tracked
plugin/tool `node_modules` symlinks; those install-side effects were restored and
are not part of this change.

## Risk Checks

- No migration added.
- No `plugin-integration-core` K3 read/list runtime added.
- No SQL executor or relationship mapping touched.
- Delete is scoped and bounded by `tenantId`, `workspaceId`, and `id`.
- Referenced connections are blocked before the DB FK can fire.
- Public delete response uses the existing redacted serializer.
