# EventBus Request Context Correlation Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/eventbus-request-context.test.ts tests/unit/correlation.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Results

- `eventbus-request-context.test.ts` + `correlation.test.ts`: 19/19 passed.
- Backend TypeScript check: passed with exit code 0.

## Covered Scenarios

- Published events inherit `correlation_id`, `metadata.user_id`, and `metadata.tenant_id` from `runWithRequestContext()`.
- Explicit publish options override request-context values.
- Events published without request context retain the previous shape.
- Existing correlation middleware tests still pass.

## Not Run

- Persistent EventBus integration against a real database. The new behavior is applied before persistence and is covered by the emitted event object in a DB-free unit test.
- Full backend suite. Focused EventBus/correlation tests plus typecheck were used as the local gate.
