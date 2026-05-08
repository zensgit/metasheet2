# Integration Core Dead-Letter Open Mark Verification - 2026-05-07

## Verification Plan

1. Run the focused runner support test that owns dead-letter store behavior.
2. Run the plugin integration-core package test suite to catch regressions across runner, routes, adapters, and storage helpers.

## Commands

```bash
node plugins/plugin-integration-core/__tests__/runner-support.test.cjs
pnpm -F plugin-integration-core test
```

## Expected Result

- `runner-support.test.cjs` confirms `markReplayed()` updates open rows and refuses discarded rows at write time.
- The full plugin suite remains green.

## Result

Passed locally on 2026-05-07.

- `node plugins/plugin-integration-core/__tests__/runner-support.test.cjs` passed.
- `pnpm -F plugin-integration-core test` passed after linking the root workspace `node_modules` and `packages/core-backend/node_modules` into the temporary worktree used for this isolated PR.
