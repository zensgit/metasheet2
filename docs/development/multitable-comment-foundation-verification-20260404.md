# Multitable Comment Foundation Verification

Date: 2026-04-04
Branch: `codex/multitable-comment-collab-main-20260404`

## Commands

```bash
CI=true pnpm install --ignore-scripts
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts tests/integration/rooms.basic.test.ts
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/multitable-attachments.api.test.ts tests/integration/multitable-view-config.api.test.ts
pnpm --filter @metasheet/core-backend build
pnpm verify:multitable-openapi:parity
```

## Results

- `tests/integration/comments.api.test.ts`: passed
- `tests/integration/rooms.basic.test.ts`: passed
- multitable integration regression suite (`context`, `record-form`, `attachments`, `view-config`): passed (`28/28`)
- `pnpm --filter @metasheet/core-backend build`: passed
- `pnpm verify:multitable-openapi:parity`: passed

## Observations

- Review follow-up validation covered the restored runtime contract:
  - explicit `mentions` payloads and legacy `@[label](userId)` parsing
  - inbox / unread-count / mark-read endpoints
  - mention-summary unread reset semantics after `mark-read`
  - SQL-backed comment presence and mention aggregation
