# Approval SLA TopN Report Development - 2026-04-25

## Context

WP5 SLA metrics exposed summary and breach-list views, but operators still lacked a compact "what should I inspect first" report. This slice adds a TopN report API and frontend cards for slowest completed instances and templates with the highest SLA breach rate.

## Changes

- Added `ApprovalMetricsService.getMetricsReport()`.
- Added `GET /api/approvals/metrics/report`.
- Added frontend API types and `fetchApprovalMetricsReport()`.
- Extended `ApprovalMetricsView.vue` with two TopN tables.
- Added OpenAPI path documentation for the new report endpoint.
- Added focused service tests for report query shape and DTO mapping.

## API

```http
GET /api/approvals/metrics/report?since=<iso>&until=<iso>&limit=10
```

Access guard:

- `authenticate`
- `rbacGuard('approvals:admin')`

Response shape:

- `summary`: existing SLA metrics summary DTO.
- `slowestInstances`: completed instances ordered by `durationSeconds` descending.
- `breachedTemplates`: grouped template rows ordered by breach rate, breach count, and total candidates.

## Design Notes

- `limit` is clamped to `1..50`; default is `10`.
- The report reuses `getMetricsSummary()` so the summary numbers stay aligned with the existing dashboard cards.
- Slowest instances only include rows with non-null `duration_seconds`.
- Template breach rate is computed from SLA candidate rows only and excludes rows without SLA information.
- Frontend loading is intentionally additive: summary, breach list, and report are fetched together through `loadAll()`.

## Explicit Non-Goals

- No pagination for the TopN report.
- No CSV export.
- No route-level integration test in this slice.
- No new database indexes. Current query shape is bounded by tenant/date filters and TopN limits; indexing can be added after staging metrics show pressure.

## Files

- `packages/core-backend/src/services/ApprovalMetricsService.ts`
- `packages/core-backend/src/routes/approval-metrics.ts`
- `packages/core-backend/tests/unit/approval-metrics-service.test.ts`
- `apps/web/src/approvals/api.ts`
- `apps/web/src/views/approval/ApprovalMetricsView.vue`
- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
