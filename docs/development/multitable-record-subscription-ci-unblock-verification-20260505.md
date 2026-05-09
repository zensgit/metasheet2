# Multitable Record Subscription CI Unblock Verification

Date: 2026-05-05
Branch: `codex/multitable-record-subscriptions-fix-20260505`
Target PR: #1290

## CI Failure Reproduced

GitHub CI for PR #1290 failed in `test (18.x)`:

- `tests/integration/multitable-record-patch.api.test.ts`
- 3 existing PATCH cases returned `500 Internal Server Error` instead of 200.

Root cause: watcher notification enqueue queried
`meta_record_subscriptions` inside the record update transaction. The existing
PATCH integration fixtures did not include that secondary table, which surfaced
the same production risk that deploy skew or notification table failure could
break core record writes.

## Commands Run

```bash
pnpm install --frozen-lockfile
```

Focused backend regression and subscription coverage:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run \
  tests/integration/multitable-record-patch.api.test.ts \
  tests/integration/multitable-record-subscriptions.api.test.ts \
  tests/unit/record-subscription-service.test.ts \
  tests/unit/record-service.test.ts \
  tests/unit/record-write-service.test.ts \
  tests/unit/comment-service.test.ts \
  --reporter=dot
```

Result:

- 6 files passed
- 111 tests passed

Frontend focused coverage:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-record-drawer.spec.ts \
  tests/multitable-client.spec.ts \
  --reporter=dot
```

Result:

- 2 files passed
- 31 tests passed

Build/type gates:

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

Result:

- backend TypeScript build passed
- web `vue-tsc` passed
- whitespace check passed

Full backend CI-style suite:

```bash
CI=true pnpm --filter @metasheet/core-backend test
```

Result:

- 210 files passed
- 9 files skipped
- 2831 tests passed
- 47 tests skipped

## Notes

- Existing `RecordWriteService` post-commit hook tests intentionally log failed
  hook errors while asserting the write still succeeds.
- Full backend tests log expected degraded-mode database errors when
  environment-local tests initialize workflow services without a local
  PostgreSQL database named after the OS user; the suite still exits 0.
- Frontend Vitest printed `WebSocket server error: Port is already in use`;
  both frontend test files still passed.

## Acceptance

- Core PATCH route no longer fails when watcher notification enqueue is absent
  or unavailable.
- Watcher notification enqueue remains durable when available.
- Ordinary record readers can no longer enumerate all watchers for a record.
- Existing drawer watch behavior is preserved.
