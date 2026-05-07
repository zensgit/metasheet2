# Integration Core DB Read Where Guard Verification - 2026-05-07

## Verification Plan

1. Run the focused DB helper test.
2. Run the full plugin-integration-core test suite.

## Commands

```bash
node plugins/plugin-integration-core/__tests__/db.test.cjs
pnpm -F plugin-integration-core test
```

## Expected Result

- Invalid `where` shapes fail with `ScopeViolationError`.
- Existing CRUD/query behavior remains unchanged for valid filters and intentionally unfiltered reads.

## Result

Passed locally on 2026-05-07.

- `node plugins/plugin-integration-core/__tests__/db.test.cjs` passed.
- `pnpm -F plugin-integration-core test` passed after linking the root workspace `node_modules` and `packages/core-backend/node_modules` into the temporary worktree used for this isolated PR.
