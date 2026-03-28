# Attendance v2.7.1 Item Lookups Design

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Context

The broader v2.7.1 test pass still reported a shared item-route gap across admin-managed attendance resources:

- approval flows
- rule sets
- payroll cycles

At the same time, request payloads had already moved toward normalized `YYYY-MM-DD` dates in other attendance responses, but request item responses still needed to stay strictly date-only.

Current OpenAPI already describes item lookup endpoints for these resources. This slice makes runtime behavior match that contract and locks the date semantics in tests.

## Goals

- Ensure approval flows support stable item lookup.
- Ensure rule sets support stable item lookup.
- Ensure payroll cycles support stable item lookup.
- Keep request `work_date` / `workDate` normalized to `YYYY-MM-DD`.

## Non-goals

- CSV import/template workflow redesign.
- Metrics path compatibility aliases.
- Auth/user-management endpoint expansion.

## Design

### 1. Item lookup parity

Use the existing item endpoints for:

- `/api/attendance/approval-flows/:id`
- `/api/attendance/rule-sets/:id`
- `/api/attendance/payroll-cycles/:id`

Behavior requirements:

- valid item id returns `200`
- missing item id returns `404`
- malformed UUID returns `400` where the module already uses UUID validation semantics

This keeps item lookup behavior aligned with the update/delete paths already present in the same modules.

### 2. Request date normalization

Attendance request responses should expose:

- `work_date`
- `workDate`

Both values must remain the same date-only string. The response shape should not leak timestamp-formatted database values back to clients.

### 3. Contract drift handling

No OpenAPI shape change is required for this slice because the contract already advertises these item endpoints. Verification should instead prove runtime parity and confirm that rebuilding OpenAPI does not introduce further source changes.

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Risks and mitigations

- Item lookup could silently diverge from update/delete semantics.
  - Mitigation: cover create -> get -> missing lookup in focused integration tests.
- Payroll cycle item lookup could accept malformed ids differently from neighboring modules.
  - Mitigation: keep the route behavior narrow and only guarantee `200/404` parity for this slice.
- Request date formatting could regress again if future mapping changes bypass the request response mapper.
  - Mitigation: assert both `work_date` and `workDate` in the request item test.
