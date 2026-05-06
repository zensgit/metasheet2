# Multitable Hierarchy Cycle Guard Verification - 2026-05-06

## Environment

- Worktree: `/private/tmp/ms2-hierarchy-cycle-guard-20260506`
- Branch: `codex/multitable-hierarchy-cycle-guard-20260506`
- Base: `origin/main@2b72e30d90ddc11214a4acb54c4877918d7af6b1`
- Dependency setup: `pnpm install --frozen-lockfile`

`pnpm install` recreated local workspace dependency symlink noise under `plugins/*/node_modules` and `tools/cli/node_modules`. Those files are not part of this feature commit.

## Automated Verification

### Focused backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/record-write-service.test.ts tests/unit/record-service.test.ts --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       56 passed (56)
```

Coverage added:

- `RecordWriteService.patchRecords()` rejects hierarchy parent updates that would move a record under its descendant.
- `RecordWriteService.patchRecords()` applies the same first-link fallback used by frontend hierarchy view config.
- `RecordService.patchRecord()` rejects direct legacy single-record patches that would create a hierarchy cycle.

Expected stderr:

- Existing post-commit hook tests intentionally log `purge failed` and `hook failed`.
- Existing pool manager startup warning appears when `DATABASE_URL` is unset.

### Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result: exit 0.

### Whitespace guard

Command:

```bash
git diff --check -- packages/core-backend/src/multitable/hierarchy-cycle-guard.ts packages/core-backend/src/multitable/record-write-service.ts packages/core-backend/src/multitable/record-service.ts packages/core-backend/src/routes/univer-meta.ts packages/core-backend/src/index.ts packages/core-backend/tests/unit/record-write-service.test.ts packages/core-backend/tests/unit/record-service.test.ts
```

Result: exit 0.

## Manual Verification Notes

Recommended staging smoke after merge:

1. Create a hierarchy view on a sheet with a same-sheet single link parent field.
2. Build `Root -> Child`.
3. Try to patch `Root.parent = Child` through Workbench drag-to-reparent or the REST patch API.
4. Confirm the response is a validation failure with code `HIERARCHY_CYCLE`.
5. Confirm normal moves, moving to root, and non-hierarchy same-sheet link fields still work.

## Residual Risk

The guard prevents new hierarchy cycles on the two update seams covered here. It does not repair existing corrupted records. If production data already contains cycles, a separate audit/repair command should detect and clear them explicitly.

