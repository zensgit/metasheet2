# Multitable Bulk Edit Partial Success - Verification - 2026-05-10

## Summary

Branch: `codex/multitable-bulk-edit-partial-success-20260510`

Result: targeted backend and frontend verification passed.

## Commands

### Install

```bash
pnpm install --frozen-lockfile
```

Result: passed. The worktree initially had no `node_modules`, so Vitest was unavailable until install linked workspace dependencies.

### Backend Partial-Success Route Spec

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/multitable-patch-partial-success.api.test.ts \
  --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       2 passed (2)
```

Coverage:

- `partialSuccess: true` keeps successful rows and reports a stale row as `VERSION_CONFLICT` in `data.failed[]`.
- Default mode without `partialSuccess` still calls `RecordWriteService.patchRecords()` once with all records and does not include `failed`.

### Frontend Grid Composable Spec

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-grid.spec.ts \
  --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       39 passed (39)
```

Coverage:

- `bulkPatch()` sends `partialSuccess: true`.
- It preserves `expectedVersion` per selected row.
- It applies successful rows from `records[]`.
- It maps backend `failed[]` into `{ recordId, reason }`.
- Top-level API errors still reject normally.

### Bulk Edit Component Regressions

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-grid-bulk-edit.spec.ts \
  tests/multitable-bulk-edit-dialog.spec.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       21 passed (21)
```

Coverage:

- PR #1451 edit-only selection regression remains covered.
- PR #1451 select/boolean no-auto-submit regression remains covered.

### Type Checks

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: both passed.

### Whitespace

```bash
git diff --check
```

Result: passed.

## Attempted Adjacent Backend Regression

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/multitable-record-form.api.test.ts \
  --watch=false
```

Result: not run by current backend Vitest config.

Reason:

```text
No test files found
exclude: ... tests/integration/multitable-record-form.api.test.ts ...
```

This is a config exclusion, not a product failure. The new route-level spec covers this slice's changed branch directly.

## Known Limits

- Partial success is record-level, not field-level. Multiple field changes for one record still succeed or fail together via one service transaction.
- Unknown/internal exceptions are intentionally not converted into `failed[]`; they still fail the request to avoid hiding server bugs.
- The UI shows a compact first-three-failures summary, not a full per-row error table. A richer result panel can be a later UX polish if operators need it.
