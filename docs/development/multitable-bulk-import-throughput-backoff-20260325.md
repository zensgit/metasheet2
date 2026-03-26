# Multitable Bulk Import Throughput And Backoff

Date: 2026-03-25

## Context

The clean multitable mainline had already recovered the richer import result / repair flow, but `bulkImportRecords(...)` still had two operational gaps:

1. it fired every `createRecord(...)` request at once
2. retryable failures (`429/5xx/409`) were only exposed back to the UI, not retried in-process

That left workbench import vulnerable to backend floods and made transient failures noisier than necessary.

## Design

### 1. Bound bulk import concurrency

File:
- `apps/web/src/multitable/import/bulk-import.ts`

`bulkImportRecords(...)` now processes records in bounded chunks instead of a single `Promise.allSettled(records.map(...))`.

Defaults:

- `concurrency = 10`
- `maxRetryAttempts = 1`
- `retryBaseDelayMs = 500`
- `maxRetryDelayMs = 30000`

The function also accepts overrides for tests.

### 2. Retry retryable failures once before surfacing them

File:
- `apps/web/src/multitable/import/bulk-import.ts`

Each record import now goes through `createRecordWithRetry(...)`.

Retryable conditions remain:

- `status >= 500`
- `status === 429`
- `status === 409`
- missing `status` (network-like client failures)

Retry behavior:

- at most one retry by default
- backoff uses `Retry-After` if the backend provided it
- `Retry-After` is capped by `maxRetryDelayMs`
- otherwise it falls back to exponential delay from `retryBaseDelayMs`
- fallback delay adds jitter so a whole retryable chunk does not hammer the backend again in lockstep

This changes workbench behavior in a good way:

- transient failures can self-heal within the first import attempt
- the result step now mainly reflects durable failures or preflight/manual-fix issues

### 3. Parse `Retry-After` into frontend API errors

File:
- `apps/web/src/multitable/api/client.ts`

`MultitableApiClient` errors now carry `retryAfterMs` when the response includes `Retry-After`.

That lets bulk import use header-aware backoff instead of a blind fixed delay.

## Files Touched

- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/import/bulk-import.ts`
- `apps/web/tests/multitable-client.spec.ts`
- `apps/web/tests/multitable-import.spec.ts`
- `apps/web/tests/multitable-workbench-import-flow.spec.ts`

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-client.spec.ts \
  tests/multitable-import.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-workbench-import-flow.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-form-view.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- focused Vitest: passed
- `@metasheet/web build`: passed

## Notes

This round intentionally fixes correctness and operator-grade resilience first.

Not done yet:

- abort/cancel propagation through bulk import
- idempotency keys for duplicate-safe record retries
- adaptive concurrency and richer multi-retry policy
- UI countdown / visible retry delay messaging

Those are potential next slices, but not required for this round’s correctness target.
