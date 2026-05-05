# Multitable Record Subscription Notifications Verification

Date: 2026-05-05
Branch: `codex/multitable-record-subscriptions-20260505`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-subscription-service.test.ts \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/comment-service.test.ts \
  --reporter=dot
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-record-drawer.spec.ts \
  tests/multitable-client.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

## Results

Backend focused tests:

- 4 files passed;
- 103 tests passed.

Frontend focused tests:

- 2 files passed;
- 31 tests passed.

Type/build gates:

- `@metasheet/core-backend` TypeScript build passed;
- `@metasheet/web` `vue-tsc -b --noEmit` passed.

## Coverage Notes

Backend coverage includes:

- subscription upsert;
- unsubscribe;
- list/status;
- watcher notification enqueue;
- actor suppression through `user_id <> actorId`;
- single-record patch notification;
- batch patch notification;
- comment-created notification.

Frontend coverage includes:

- client URL encoding and status normalization;
- subscribe/unsubscribe methods;
- notification list normalization;
- drawer watch-state loading;
- drawer Watch/Watching toggle.

## Non-Failing Noise

`RecordWriteService` tests intentionally log post-commit hook failures in existing test cases that assert failed hooks do not fail the write.

Frontend Vitest printed `WebSocket server error: Port is already in use`; tests still completed successfully.

## Follow-Up

- Add OpenAPI source/dist entries for the new subscription APIs in a contract sweep.
- Add notification center UI and read/mark-read APIs if product wants watcher notifications surfaced outside the record drawer.
