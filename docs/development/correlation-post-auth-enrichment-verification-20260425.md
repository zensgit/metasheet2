# Correlation Post-Auth Enrichment Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/correlation.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Results

- `tests/unit/correlation.test.ts`: 16/16 passed.
- Backend TypeScript check: passed with exit code 0.

## Covered Scenarios

- Active request context can be enriched with trimmed `userId` and `tenantId`.
- Calling enrichment outside AsyncLocalStorage returns `undefined`.
- Express middleware order works as intended: correlation context is created first, auth-like middleware attaches request identity, post-auth enrichment makes identity visible to route code through `getRequestContext()`.
- Existing correlation id behavior remains covered by the pre-existing correlation tests.

## Not Run

- Full backend test suite. This slice is isolated to correlation context and logger metadata; the focused test plus backend typecheck were used as the gate.
- Runtime log sink verification. Logger metadata shape is covered by TypeScript and existing logger context wiring, but no external collector was started.
