# Multitable Comment Inbox Global Realtime Verification

## Commands
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts tests/integration/rooms.basic.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-comment-inbox-realtime.spec.ts tests/multitable-comment-inbox-view.spec.ts`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`
- `pnpm type-check`

## Results
- Backend integration suite passed: `10/10`.
- Frontend targeted suite passed: `5/5`.
- `vue-tsc --noEmit` passed.
- `@metasheet/web build` passed.
- `@metasheet/core-backend build` passed.
- Root `lint` passed.
- Root `type-check` passed.

## Runtime behavior verified
- Inbox pages join a global `comments-inbox` realtime room.
- `comment:activity` refreshes inbox state for newly created or resolved comment activity.
- Self-authored create events do not trigger redundant inbox refreshes.
- The inbox no longer depends on the currently loaded sheet set to discover new activity.
