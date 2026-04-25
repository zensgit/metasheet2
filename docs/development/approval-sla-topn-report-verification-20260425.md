# Approval SLA TopN Report Verification - 2026-04-25

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-metrics-service.test.ts --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Results

- `tests/unit/approval-metrics-service.test.ts`: 15/15 passed.
- Backend TypeScript check: passed with exit code 0.
- Frontend Vue TypeScript check: passed with exit code 0.
- OpenAPI build: passed and regenerated `packages/openapi/dist/*`.

## Covered Scenarios

- `getMetricsReport()` reuses summary retrieval and maps slowest-instance rows to camelCase DTOs.
- Limit values are clamped to the service maximum.
- SQL generation includes duration ordering for slowest instances.
- SQL generation includes grouped template breach-rate ordering.
- Frontend typecheck covers new API DTOs and `ApprovalMetricsView.vue` bindings.
- OpenAPI build validates the new report path can be merged into the generated OpenAPI artifacts.

## Not Run

- Route-level supertest for `/api/approvals/metrics/report`. The route is thin and delegates to the tested service; adding route coverage is a reasonable follow-up if approval metrics route tests are introduced.
- Browser screenshot/manual dashboard verification. This needs a running staging build with approval SLA sample data.
