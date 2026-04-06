# Multitable Record Policy Source Verification

Date: 2026-04-06

## Verified Commands

### Targeted backend integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-permissions.api.test.ts \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts
```

Result: `33/33` tests passed.

### Targeted frontend regression

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-grid.spec.ts \
  tests/multitable-workbench-view.spec.ts
```

Result: `68/68` tests passed.

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Result: passed.

### Workspace lint

```bash
pnpm lint
```

Result: passed.

### Workspace type-check

```bash
pnpm type-check
```

Result: passed.

### Backend build

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed before final documentation/staging. Later changes only touched tests and two frontend local variable declaration orders.

## Functional Verification Summary

- Owner-write sheet permissions now produce:
  - safe default `rowActions` for non-owned rows
  - `rowActionOverrides` for owned rows in multitable view payloads
- Record and form contexts now return record-specific row actions.
- Foreign-row delete is rejected under owner-write scope.
- Grid edit/delete behavior now follows per-record overrides instead of a single global `rowActions` object.
- Workbench regression suite still passes with the new override-aware grid contract.

## Residual Risk

- This slice introduces only owner-based row policy sourced from `created_by`. More complex record-level ACL models remain future work.
