# Attendance Payroll Generate Contract

## Context

Issue [#597](https://github.com/zensgit/metasheet2/issues/597) reported that `POST /api/attendance/payroll-cycles/generate` returned `400` for a natural request body shaped like:

```json
{ "year": 2026, "month": 4 }
```

Current frontend and integration flows already use `anchorDate`, but the public API contract was too narrow and the validation message was not clear enough for external callers.

## Decision

- keep `anchorDate` as the canonical request field
- also accept `year` + `month` as a compatibility alias that resolves to the first day of that month
- return explicit validation messages when callers omit the anchor entirely or provide only one side of the alias pair
- align OpenAPI with both accepted request shapes

## Scope

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `packages/openapi/src/paths/attendance.yml`

## Expected Outcome

- callers can generate payroll cycles with either `anchorDate` or `year/month`
- missing or partial anchor inputs fail with readable `400 VALIDATION_ERROR` messages
- OpenAPI documents both accepted request shapes
