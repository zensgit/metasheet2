# `/metrics` / `/metrics/prom` scrape-token guard — verification log

Date: 2026-04-23
Branch: `codex/metrics-prom-guard-20260423`
Base: `main@6d5f965e4`
Paired with: `docs/development/metrics-prom-scrape-token-guard-development-20260423.md`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/metrics-auth.test.ts \
  tests/unit/jwt-middleware.test.ts \
  tests/unit/metrics-endpoint.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

## Results

### Focused unit tests

- `tests/unit/metrics-auth.test.ts`: `5/5` pass
- `tests/unit/jwt-middleware.test.ts`: `13/13` pass
- `tests/unit/metrics-endpoint.test.ts`: `2/2` pass
- Aggregate: `20/20` pass

### Type-check

- `packages/core-backend`: `tsc --noEmit` passed with exit `0`

## Assertions locked by this slice

- `/metrics` and `/metrics/prom` are no longer JWT-whitelisted paths
- metrics auth is disabled when `METRICS_SCRAPE_TOKEN` is unset or blank
- metrics auth returns `401` when a token is configured but not supplied
- bearer-token access works when the supplied token matches
- `x-metrics-token` access works when the supplied token matches
- the legacy metrics endpoint smoke contract remains intact

## Operational note

This patch is intentionally backward-compatible by default:

- if `METRICS_SCRAPE_TOKEN` is **not** configured, current anonymous scrape
  behavior remains unchanged
- to actually close public exposure in staging / production, ops must set
  `METRICS_SCRAPE_TOKEN` and update Prometheus scrape auth accordingly
