# Correlation-id request tracing — verification (2026-04-25)

- **Date**: 2026-04-25
- **Branch**: `codex/observability-correlation-id-20260425`
- **Worktree**: `/tmp/ms2-correlation-id`
- **Base commit**: `5727a6f7a` (origin/main)

## Commands

| # | Command | Result |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` (from `packages/core-backend`) | 0 errors, 0 warnings. |
| 2 | `npx vitest run tests/unit/correlation.test.ts` | **10 / 10 passed**, 1 file. |
| 3 | `npx vitest run tests/integration/correlation-header.api.test.ts` | **2 / 2 passed**, 1 file. |
| 4 | `npx vitest run` (full unit + contract suite, from `packages/core-backend`) | **2555 passed, 47 skipped** across **194 files** (9 files skipped by config). |
| 5 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/correlation.test.ts tests/integration/correlation-header.api.test.ts --reporter=verbose` after review hardening | **12 / 12 passed**, 2 files. |
| 6 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/correlation.test.ts tests/unit/http-adapter-correlation.test.ts tests/integration/correlation-header.api.test.ts --reporter=verbose` after second review hardening | **18 / 18 passed**, 3 files. |
| 7 | `pnpm --filter @metasheet/core-backend exec tsc --noEmit` after second review hardening | 0 errors, 0 warnings. |

## Command output — full suite tail

```
 Test Files  194 passed | 9 skipped (203)
      Tests  2555 passed | 47 skipped (2602)
   Start at  00:59:03
   Duration  7.67s (transform 3.65s, setup 5.42s, collect 19.29s, tests 16.47s, environment 19ms, prepare 7.07s)
```

(The pre-existing `BPMNWorkflowEngine` / `EventBusService` "database chouhua does not exist" log lines surface because the test host has no Postgres; every test that observes them asserts degraded-mode paths and still passes.)

## Command output — targeted correlation suite

```
 ✓ tests/unit/correlation.test.ts > resolveCorrelationId > accepts a well-formed header value
 ✓ tests/unit/correlation.test.ts > resolveCorrelationId > rejects empty strings, too-long values, and disallowed characters
 ✓ tests/unit/correlation.test.ts > resolveCorrelationId > falls back to a UUID when header is missing or invalid
 ✓ tests/unit/correlation.test.ts > request-context AsyncLocalStorage > returns undefined outside a context
 ✓ tests/unit/correlation.test.ts > request-context AsyncLocalStorage > exposes the correlation id inside a run() scope
 ✓ tests/unit/correlation.test.ts > correlationIdMiddleware (express integration) > generates a uuid when the header is missing and echoes it on the response
 ✓ tests/unit/correlation.test.ts > correlationIdMiddleware (express integration) > preserves a valid inbound X-Correlation-ID header
 ✓ tests/unit/correlation.test.ts > correlationIdMiddleware (express integration) > replaces an invalid inbound header with a generated uuid
 ✓ tests/unit/correlation.test.ts > correlationIdMiddleware (express integration) > keeps each request isolated across concurrent invocations
 ✓ tests/unit/correlation.test.ts > correlationIdMiddleware (express integration) > can wrap CORS preflight responses when installed before cors()

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

## Sample log line

Probe script:

```js
process.env.LOG_LEVEL = 'info'
const { createLogger } = await import('.../src/core/logger.ts')
const { runWithRequestContext } = await import('.../src/context/request-context.ts')
const log = createLogger('VerifyProbe')
runWithRequestContext({ correlationId: 'sample-uuid-123' }, () => {
  log.info('request handled', { path: '/api/foo', status: 200 })
})
```

Captured output:

```
info: request handled {"context":"VerifyProbe","correlation_id":"sample-uuid-123","path":"/api/foo","service":"metasheet","status":200,"timestamp":"2026-04-24T17:00:17.047Z"}
```

`correlation_id` is emitted **top-level** alongside `context`/`service`/`timestamp`, so a Loki/ES filter like `correlation_id="sample-uuid-123"` resolves without any JSON path traversal. When the caller is outside a correlation context, the key is simply absent (see the unit test `returns undefined outside a context`).

## Response-header round-trip

Proof is in the supertest-backed integration test (`tests/integration/correlation-header.api.test.ts`). The cases asserted:

| Inbound header | Response `X-Correlation-ID` | Notes |
| --- | --- | --- |
| *(none)* | `<generated uuid>` | Matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. |
| `end-to-end_42` | `end-to-end_42` | Verbatim preservation. |
| `not valid!` (space + `!`) | `<generated uuid>` | Invalid header dropped, UUID generated. |
| Two concurrent requests with distinct ids | Each request sees its own id both on the response and via `getCorrelationId()` inside the handler | Asserts ALS isolation across concurrent flights. |

## Error-response body shape

The new global error handler installed by `installGlobalErrorHandler()` at the end of `MetaSheetServer.start()` emits:

```json
{
  "success": false,
  "error": "<message | 'Internal Server Error'>",
  "message": "<details | undefined in production 5xx>",
  "correlationId": "<request correlation id>"
}
```

Routes that previously threw (and relied on express's default HTML 500) now surface JSON the client can reference in a bug report by quoting `correlationId`. Route handlers that already send their own JSON response are untouched — the handler only runs when the error bubbles past the route.

## Outbound HTTP propagation

`packages/core-backend/src/data-adapters/HTTPAdapter.ts` — the shared axios client — reads `getCorrelationId()` inside its request interceptor and sets `X-Correlation-ID` on every outbound call when a correlation id is in scope and the caller has not already supplied a case-insensitive correlation header. The interceptor uses a static import; adapter instances constructed outside a request keep working because `getCorrelationId()` safely returns `undefined` when no AsyncLocalStorage scope exists.

## Review hardening — 2026-04-25

- Moved `correlationIdMiddleware` before `cors()` so CORS preflight short-circuits still receive `X-Correlation-ID`.
- Moved the global Express error handler out of early middleware setup and into a late `installGlobalErrorHandler()` call at the end of `MetaSheetServer.start()`, after routes and plugin routes are registered.
- Changed the global error handler to call `next(err)` when `res.headersSent` is already true.
- Configured CORS with `exposedHeaders: ['X-Correlation-ID']` so browser clients can read the response header.
- Changed `HTTPAdapter` outbound propagation to preserve explicit caller-provided `X-Correlation-ID` / `x-correlation-id` headers.
- Replaced the dynamic `require('../context/request-context')` in `HTTPAdapter` with a static import.
- Extracted `applyCorrelationHeader(config)` from the `HTTPAdapter` interceptor so correlation propagation is covered without relying on Axios module-mock internals.
- Added supertest CORS preflight/header-exposure assertions, error-handler `headersSent` coverage, and outbound header-helper tests; targeted correlation tests now pass `18 / 18`.

Focused re-verification after review fixes:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/correlation.test.ts \
  tests/unit/http-adapter-correlation.test.ts \
  tests/integration/correlation-header.api.test.ts \
  --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

```text
Test Files  3 passed (3)
Tests       18 passed (18)
tsc         exit 0
```

`grep -rn 'axios.create' packages/core-backend/src` returns exactly one hit — `HTTPAdapter` — so no other shared outbound client requires wiring. Ad-hoc `fetch(url, init)` call sites (a handful in plugin adapters) are deliberately not retrofitted; propagating the header there is follow-up work scoped to a shared `http` helper.

## Rollout safety recap

- **Client-visible**: one new response header (`X-Correlation-ID`) on every route. Error responses gain a JSON body with `correlationId`.
- **Server-visible**: one new top-level field (`correlation_id`) per log line inside a request scope. No new log lines.
- **No new env vars, feature flags, or ports.**
- **No existing test regressed** (full suite = 2555 passed, same shape as base `5727a6f7a`).

## Follow-ups

- Wire the pre-existing `telemetryMiddleware` / `telemetryErrorHandler` in `packages/core-backend/src/middleware/telemetry.ts` into the server when OpenTelemetry is enabled. Those modules read/write `req.correlationId` from the same Express declaration now fed by the new middleware, so they'll compose cleanly once activated.
- When a shared `http` helper replaces ad-hoc `fetch` calls, reuse the same interceptor pattern (`getCorrelationId() → X-Correlation-ID`) for uniform coverage.
- Consider surfacing `correlationId` in the frontend error toasts so end-users can copy/paste a request id into bug reports without developer assistance.
