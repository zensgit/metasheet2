# Approval SLA TopN Contract Tests Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-metrics-router.test.ts tests/unit/approval-metrics-service.test.ts --reporter=verbose
pnpm --filter @metasheet/web exec vitest run tests/approvalMetricsTopnReport.spec.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

## Results

- Backend route + service tests: 19/19 passed.
- Frontend TopN view spec: 2/2 passed.
- Backend TypeScript check: passed with exit code 0.
- Frontend Vue TypeScript check: passed with exit code 0.

## Notes

- The web Vitest run printed `WebSocket server error: Port is already in use`, but the focused spec completed successfully with exit code 0. No test failure was produced.
- No OpenAPI build was needed because this slice changes tests only.

## Not Run

- Browser manual verification. The view contract is pinned by Vue unit tests; staging click verification remains an operational step.
