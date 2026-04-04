# Multitable Comment Foundation Verification

Date: 2026-04-04
Branch: `codex/multitable-comment-collab-main-20260404`

## Commands

```bash
CI=true pnpm install --ignore-scripts
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts tests/integration/rooms.basic.test.ts
pnpm --filter @metasheet/core-backend build
pnpm verify:multitable-openapi:parity
```

## Results

- `tests/integration/comments.api.test.ts`: passed
- `tests/integration/rooms.basic.test.ts`: passed
- `pnpm --filter @metasheet/core-backend build`: passed
- `pnpm verify:multitable-openapi:parity`: passed

## Observations

- Initial validation failed because `packages/core-backend/src/services/commentRooms.ts` was omitted from the first port; adding that file fixed both TypeScript build and integration loading.
- Comment integration expectations were updated to match the current runtime contract fields:
  - mention summary items include `unreadCount`
  - comment presence items include `mentionedCount` and `mentionedFieldCounts`
