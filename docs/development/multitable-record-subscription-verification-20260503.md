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
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/multitable-record-patch.api.test.ts \
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

Record patch integration regression:

- 1 file passed;
- 6 tests passed.

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

## CI Follow-Up

PR #1290 initially failed `test (18.x)` in `tests/integration/multitable-record-patch.api.test.ts` because the mocked SQL fixture did not know about the new `meta_record_subscriptions` lookup and notification insert. The route returned 500 only in the test harness. The fixture now returns empty watcher rows for those legacy route extraction scenarios, and the targeted integration file passes locally.

## Follow-Up

- Add OpenAPI source/dist entries for the new subscription APIs in a contract sweep.
- Add notification center UI and read/mark-read APIs if product wants watcher notifications surfaced outside the record drawer.
