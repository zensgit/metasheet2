# Correlation-id request tracing — development log (2026-04-25)

- **Date**: 2026-04-25
- **Branch**: `codex/observability-correlation-id-20260425`
- **Worktree**: `/tmp/ms2-correlation-id`
- **Base commit**: `5727a6f7a` (origin/main)

## Scope

Thread an end-to-end `X-Correlation-ID` through every inbound HTTP request so logs, errors, and outbound adapter calls share a single identifier. Additive and opt-out-safe: the middleware either echoes a well-formed client-supplied header or generates a UUID — nothing on the existing hot path changes behaviour beyond gaining one response header and one log field.

## Contract

- **Inbound**: clients MAY send `X-Correlation-ID: <value>` where `<value>` matches `^[A-Za-z0-9_-]{1,128}$`.
- **Preservation**: a matching header is propagated verbatim.
- **Fallback**: a missing/invalid header is replaced by `crypto.randomUUID()`.
- **Outbound response**: every response echoes `X-Correlation-ID` (even error responses).
- **Error body**: the global error handler emits `correlationId` in the JSON body so API clients can reference the id when filing bug reports.
- **Logs**: every line emitted via `core/logger.ts` includes top-level `correlation_id` for the duration of the request.
- **Downstream HTTP**: `HTTPAdapter` (the only shared outbound client) injects `X-Correlation-ID` on every request when a correlation id is in scope.

## Request flow

```
HTTP request ─┐
              │ correlationIdMiddleware    ← sets req.correlationId
              │   └── runWithRequestContext({correlationId, userId?, tenantId?})
              │        │
              │        ├── cors()
              │        ├── requestId/trace bridge (setLogContext)
              │        ├── body parsers, metrics, request logger
              │        ├── jwtAuthMiddleware / tenantContext / route handlers
              │        │     └── logger.info/warn/error  ← mergeMeta() injects
              │        │         correlation_id from getCorrelationId()
              │        └── HTTPAdapter outbound call
              │              └── request interceptor reads getCorrelationId()
              │                  and sets outbound X-Correlation-ID
              │
              └── response headers include X-Correlation-ID
                  error responses include { correlationId } in the JSON body
```

## Files added

| Path | Purpose |
| --- | --- |
| `packages/core-backend/src/context/request-context.ts` | New `AsyncLocalStorage<{ correlationId, userId?, tenantId? }>` with `runWithRequestContext`, `getRequestContext`, `getCorrelationId`. Orthogonal to the existing `LogContext` ALS in `core/logger.ts`. |
| `packages/core-backend/src/middleware/correlation.ts` | Reads/validates the inbound header, populates `req.correlationId`, sets the response header, and wraps `next()` inside `runWithRequestContext`. Exports `resolveCorrelationId` + `isValidCorrelationId` for unit coverage. |
| `packages/core-backend/tests/unit/correlation.test.ts` | Regex boundaries, ALS isolation, express supertest round-trips, concurrent-request isolation, and CORS preflight coverage. |
| `packages/core-backend/tests/unit/http-adapter-correlation.test.ts` | Unit coverage for the `HTTPAdapter` correlation-header helper used by the axios request interceptor. |
| `docs/development/observability-correlation-id-development-20260425.md` | This file. |
| `docs/development/observability-correlation-id-verification-20260425.md` | Verification commands + output + sample log line. |

## Files modified

| Path | Change |
| --- | --- |
| `packages/core-backend/src/types/express.d.ts` | Adds `correlationId?: string` on `Express.Request` alongside the existing `requestId?` field. |
| `packages/core-backend/src/core/logger.ts` | `mergeMeta()` imports `getCorrelationId` from the new context module and emits a **top-level** `correlation_id` field when a correlation id is in scope. Keys with `undefined` values are now stripped so downstream JSON formatters stay clean. |
| `packages/core-backend/src/index.ts` | Registers `correlationIdMiddleware` before `cors()` and before the `x-request-id` bridge — the ALS scope wraps CORS preflights, every subsequent middleware, and every route handler. Configures CORS to expose `X-Correlation-ID` to browser clients. Adds a **new** global error handler through `installGlobalErrorHandler()`, called late in `start()` after routes/plugin routes/Yjs/metrics wiring, that logs via the core logger and emits `{ success: false, error, message, correlationId }` in the JSON body. If headers were already sent, it delegates with `next(err)` instead of swallowing the error. |
| `packages/core-backend/src/data-adapters/HTTPAdapter.ts` | Extends the existing `axios` request interceptor through `applyCorrelationHeader(config)`, which sets `X-Correlation-ID` from a static `getCorrelationId()` import only when the caller did not already provide a case-insensitive correlation header. Adapter instances outside a request scope send no correlation header. |

## Design decisions

### Two orthogonal ALS stores, not one

`core/logger.ts` already holds an `AsyncLocalStorage<{ traceId, spanId, requestId }>` keyed on per-hop request identity + OpenTelemetry trace IDs. The task requires a dedicated `src/context/request-context.ts` module owning `correlationId` (plus optional `userId` / `tenantId`). I kept the two stores separate: `correlationId` is an **end-to-end** identifier — the same value travels across process boundaries to upstream services — while `requestId` is **per-hop**, regenerated on every entry. Conflating them would hide a real distinction. The logger reads from the new ALS via a one-way dependency (`core/logger.ts → context/request-context.ts`) so the log output now includes both `requestId` and `correlation_id` on every line.

### Registration order

The middleware is placed **before `cors()`** and **before** the existing `x-request-id` bridge in `index.ts`. Any middleware registered after this line — CORS, body parsers, metrics, request logger, JWT, tenant context, attendance guards, every route — executes inside the ALS scope. This is load-bearing for `OPTIONS` preflight coverage because the CORS middleware may terminate the request before later middleware runs.

### Global error handler — additive

The pre-existing codebase had **no** global 4-argument express error handler wired into `index.ts` (a `telemetryErrorHandler` in `middleware/telemetry.ts` exists but is never registered). Routes throw and express's default HTML error page is used. I added a minimal handler via `installGlobalErrorHandler()`, called at the end of `start()` after routes, plugin routes, Yjs, and metrics stream wiring. It (a) routes the error through `this.logger.error` (picks up `correlation_id` automatically via `mergeMeta`), (b) echoes `correlationId` in the JSON body, and (c) honours `err.status`/`err.statusCode` when present. In production 5xx responses hide the raw message; other classes pass through. If `res.headersSent` is already true, the handler calls `next(err)` so Express can delegate or close the request lifecycle rather than silently returning.

### Logger format — top-level `correlation_id`

`mergeMeta` flattens the correlation id as `correlation_id` at the top of the meta object. Winston's JSON formatter emits the full meta bag as sibling fields of `level`/`message`/`timestamp`, so downstream log tooling (Loki/ES) can filter `correlation_id=<uuid>` without any JSON path traversal. The key uses snake-case to match common log-field conventions; the `Express.Request` property stays `correlationId` to fit the TypeScript/JS camelCase norm.

### Outbound HTTP coverage scope

`HTTPAdapter` is the only shared outbound-HTTP client in the backend (`grep axios.create` returned a single hit). Per-file bespoke `fetch`/`node-fetch` call sites exist in a handful of plugins and adapters but each uses direct `fetch(url, init)` — adding `X-Correlation-ID` there would require editing each call site and is out of scope. This is documented as a follow-up: if/when a shared `http` helper lands, it should wire the interceptor uniformly.

The interceptor uses a static `getCorrelationId()` import from the in-package request context module. The header injection itself lives in `applyCorrelationHeader(config)`, so the load-bearing behaviour is unit-testable without brittle Axios module mocking. Adapter instances constructed outside an Express request safely receive `undefined` from `getCorrelationId()` and therefore send no correlation header.

## Rollout safety

- **Opt-out safe**: sending no header or an invalid header yields the generated UUID branch — callers see no failure.
- **Response shape unchanged for success paths**: only the header is added; JSON bodies for 2xx are untouched.
- **Error path change**: previously unhandled errors hit express's default HTML 500 page. Now they get a JSON body with `correlationId`. This is a strict improvement for API clients and does not alter success-path behaviour.
- **No new environment variables, feature flags, or ports.**
- **Logging volume**: one extra field per log line (~40 bytes). No new log lines.
- **Performance**: `AsyncLocalStorage.run` plus one regex test per inbound request. Neither is on a measurable hot path.

## Non-goals

- Migrating all `fetch`/`node-fetch` call sites to propagate correlation id.
- Backfilling correlation id on events already emitted before the middleware is registered (none exist in `setupMiddleware` prior to `correlationIdMiddleware`).
- Surfacing correlation id in the Vue frontend — task scope is backend-only.
- Wiring the pre-existing `telemetryMiddleware` / `telemetryErrorHandler` (`middleware/telemetry.ts`) into the server — that module depends on an OpenTelemetry path that's not enabled and is tracked as a separate cleanup.
- Populating `userId` / `tenantId` on the request context. The fields exist as optional slots on `RequestContext` for future use, but this middleware runs **before** `jwtAuthMiddleware` so `req.user` is always undefined here. Filling those slots requires a small post-auth enrichment middleware that calls back into the ALS to overwrite the entry — a deliberate follow-up because the middleware must remain pre-auth so CORS preflights and public-form bypass paths still get a correlation id.
