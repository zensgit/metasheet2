# Multitable Comment Inbox Realtime Verification 2026-04-04

## Planned Verification

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-comment-inbox-realtime.spec.ts tests/multitable-comment-inbox-view.spec.ts`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`

## Result

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-comment-inbox-realtime.spec.ts tests/multitable-comment-inbox-view.spec.ts`
  - passed (`3/3`)
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - passed
- `pnpm --filter @metasheet/web build`
  - passed
