# Integration Core External System Update Defaults Verification - 2026-05-07

## Verification Plan

1. Run the focused external system registry test.
2. Run the full plugin-integration-core test suite.

## Commands

```bash
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
pnpm -F plugin-integration-core test
```

## Expected Result

- Create path still defaults omitted `role/status` to `source/inactive`.
- Update path preserves existing `role/status` when omitted.
- Explicit kind/role changes remain rejected.

## Result

Passed locally on 2026-05-07.

- `node plugins/plugin-integration-core/__tests__/external-systems.test.cjs` passed.
- `pnpm -F plugin-integration-core test` passed after linking the root workspace `node_modules` and `packages/core-backend/node_modules` into the temporary worktree used for this isolated PR.
