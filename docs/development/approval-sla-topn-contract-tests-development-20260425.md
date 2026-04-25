# Approval SLA TopN Contract Tests Development - 2026-04-25

## Context

The TopN report implementation added the backend route, service method, frontend API, and dashboard tables. The implementation was verified at service/typecheck/OpenAPI level, but the route and Vue view contracts were not directly pinned.

This slice adds the missing contract tests without changing runtime behavior.

## Changes

- Added `approval-metrics-router.test.ts` for `GET /api/approvals/metrics/report`.
- Added `approvalMetricsTopnReport.spec.ts` for `ApprovalMetricsView`.
- Kept production code unchanged.

## Backend Test Coverage

- Report route returns `{ ok: true, data }`.
- Tenant id is resolved from authenticated user.
- `since` / `until` are parsed as dates.
- `limit` is clamped to `50`.
- Invalid dates are ignored.
- Invalid limit falls back to `10`.
- Auth and RBAC gates are preserved.
- Service failure returns stable `METRICS_REPORT_FAILED` payload.

## Frontend Test Coverage

- The view loads the report on mount with `{ limit: 10 }`.
- TopN slowest instance and SLA risk template tables render returned rows.
- Duration and percent formatters are exercised through rendered text.
- Row links route to approval detail and template detail.

## Files

- `packages/core-backend/tests/unit/approval-metrics-router.test.ts`
- `apps/web/tests/approvalMetricsTopnReport.spec.ts`
