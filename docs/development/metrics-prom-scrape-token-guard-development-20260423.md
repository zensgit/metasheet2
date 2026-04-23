# `/metrics` / `/metrics/prom` scrape-token guard — development log

Date: 2026-04-23
Branch: `codex/metrics-prom-guard-20260423`
Base: `main@6d5f965e4`

## Goal

Reduce the blast radius of the shared metrics endpoints without breaking the
existing local / CI scrape path by default.

The problem in `main` was:

- `installMetrics()` registered `/metrics` and `/metrics/prom` as naked routes.
- `jwt-middleware.ts` also listed both paths in `AUTH_WHITELIST`.
- The global JWT middleware only protects `/api/**`, so the whitelist entry was
  not the root cause, but it still documented the wrong mental model.

## Scope

This slice intentionally does **not** retroactively require JWT / RBAC for
Prometheus. That would break existing anonymous scrape configurations and turn
an observability hardening patch into a deployment cut-over.

Instead it adds an explicit scrape-token seam:

- when `METRICS_SCRAPE_TOKEN` is unset, behavior stays unchanged
- when `METRICS_SCRAPE_TOKEN` is set, `/metrics` and `/metrics/prom` require
  either:
  - `Authorization: Bearer <token>`
  - or `x-metrics-token: <token>`

## Code changes

### 1. Add reusable metrics auth middleware

File:
`packages/core-backend/src/metrics/metrics.ts`

Added:

- `resolveMetricsScrapeToken(env?)`
- `createMetricsAuthMiddleware(getToken?)`

Behavior:

- trims `METRICS_SCRAPE_TOKEN`
- treats blank values as disabled
- returns `401 UNAUTHORIZED` + `WWW-Authenticate: Bearer realm="metrics"` when a
  token is configured but missing / incorrect

`installMetrics(app)` now applies the middleware to both `/metrics` and
`/metrics/prom`.

### 2. Remove stale metrics whitelist entries

File:
`packages/core-backend/src/auth/jwt-middleware.ts`

Removed:

- `/metrics`
- `/metrics/prom`

This does not change runtime auth for those endpoints by itself because the
global JWT layer only intercepts `/api/**`, but it removes misleading
whitelist state and locks the intended security ownership to the dedicated
metrics guard.

### 3. Add focused tests

New file:
`packages/core-backend/tests/unit/metrics-auth.test.ts`

Coverage:

- blank / unset token disables auth
- no token configured keeps anonymous access working
- configured token rejects anonymous access
- configured token accepts bearer token
- configured token accepts `x-metrics-token`

Updated:

- `packages/core-backend/tests/unit/jwt-middleware.test.ts`

Added:

- assertion that `/metrics` and `/metrics/prom` are no longer treated as JWT
  whitelist paths

## Explicit defer

- No production-only fail-closed behavior when token is absent
- No Prometheus docker compose reconfiguration in this slice
- No RBAC / admin-user protection for metrics endpoints
- No `/metrics` route removal

Those are separate operational decisions and should land with coordinated
scrape config changes.
