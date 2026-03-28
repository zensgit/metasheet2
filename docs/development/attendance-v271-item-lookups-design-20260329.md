# Attendance v2.7.1 Item Lookup Follow-up Design

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Context

After the first v2.7.1 follow-up slice, the remaining high-confidence backend gap was not holidays/requests anymore. The next repeated pattern from the test report was that several admin-managed resources still supported list and write operations but not item lookup:

- approval flows
- rule sets
- payroll cycles

The same report also noted that attendance request payloads still surfaced `work_date` with a timestamp in some responses, even though record APIs had already standardized on `YYYY-MM-DD`.

## Goals

- Add item-level `GET /:id` parity for approval flows, rule sets, and payroll cycles.
- Normalize attendance request `work_date` in API responses to date-only format.
- Keep this slice backend-only except for OpenAPI regeneration.

## Non-goals

- Changing import preview into a `GET /preview/:fileId` route.
- Adding a compatibility alias for `/api/metrics/prom`.
- Reworking approval-flow authorization behavior beyond item lookup.

## Design

### 1. Item lookup parity

Add three routes to the attendance plugin:

- `GET /api/attendance/approval-flows/:id`
- `GET /api/attendance/rule-sets/:id`
- `GET /api/attendance/payroll-cycles/:id`

Each route:

- uses the same org scoping as the list/update/delete handlers
- reuses the existing row mappers
- returns `404` when the id does not exist in the current org
- returns `503` for schema-not-ready cases, matching surrounding route families

This keeps behavior consistent with the already-restored request, holiday, and rotation-rule item routes.

### 2. Request date normalization

Update `mapAttendanceRequestRow()` so both:

- `work_date`
- `workDate`

resolve to canonical `YYYY-MM-DD`.

This keeps self-service request payloads aligned with the rest of the attendance surface without breaking existing snake_case consumers.

### 3. Payroll cycle response normalization

Normalize `startDate` and `endDate` in `mapPayrollCycleRow()` using the same date-only helper already used in other attendance mappers. This prevents item lookup from reintroducing timestamp-shaped date fields for payroll cycles.

### 4. Contract alignment

Update OpenAPI source and generated artifacts so the newly restored item routes are reflected in:

- `packages/openapi/src/paths/attendance.yml`
- generated `packages/openapi/dist/*`

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/openapi/src/paths/attendance.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Risks and mitigations

- Item routes could diverge from existing row shapes.
  - Mitigation: reuse `mapApprovalFlowRow`, `mapRuleSetRow`, and `mapPayrollCycleRow`.
- Request date normalization could break callers that were reading the timestamp form.
  - Mitigation: preserve `work_date` while adding aligned `workDate`, both normalized to the same date-only value.
