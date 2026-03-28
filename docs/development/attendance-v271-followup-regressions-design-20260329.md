# Attendance v2.7.1 Follow-up Regressions Design

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Context

The v2.7.1 follow-up test pass identified four concrete regression clusters:

1. Request item CRUD was incomplete. `POST /api/attendance/requests` worked, but item routes for `GET /:id`, `PUT /:id`, and `DELETE /:id` returned `404`.
2. Holiday item APIs were incomplete or too loose. `GET /api/attendance/holidays/:id` was missing, invalid `date` could fall through to the database as `500`, and invalid `type` values were accepted.
3. Admin-page "invisible edit button" reports were caused by focused-mode section hiding rather than dead buttons. The hotfix should keep the focused-mode behavior but guarantee that the active section still exposes working edit actions.
4. Mobile overflow remained on the top nav and the records table.

The same test report also mentioned `/api/metrics/prom`. Current runtime and docs use `/metrics/prom`, so this follow-up does not restore `/api/metrics/prom`.

## Goals

- Restore request item CRUD parity for self-service attendance requests.
- Restore holiday item lookup parity and tighten holiday create/update validation.
- Preserve the focused admin console while making the active section's actions visible and mobile layout less brittle.
- Keep OpenAPI and generated artifacts aligned with runtime behavior.

## Non-goals

- Reintroducing "show every admin section at once" as the default admin console mode.
- Adding a compatibility alias for `/api/metrics/prom`.
- Refactoring unrelated attendance approval authorization behavior outside the reported request/holiday regressions.

## Design

### 1. Request item CRUD

Add normalized request item routes in the attendance plugin:

- `GET /api/attendance/requests/:id`
- `PUT /api/attendance/requests/:id`
- `DELETE /api/attendance/requests/:id`

Implementation details:

- Introduce a shared `mapAttendanceRequestRow()` response mapper so create/list/get/update all return the same normalized shape.
- Centralize ownership and reference resolution through `ensureAttendanceRequestAccess()`.
- Reuse a single payload normalizer via `resolveAttendanceRequestDraft()` for create and update so request-type aliases and date-only values stay consistent.
- Keep delete behavior aligned with the existing cancel semantics rather than inventing a second destructive path.

### 2. Holiday item lookup and validation

Add a holiday item route and tighten write validation before database calls:

- `GET /api/attendance/holidays/:id`
- shared `resolveHolidayWritePayload()` used by both create and update

Validation rules:

- `date` must normalize to `YYYY-MM-DD`
- `name` must be non-empty
- `type` must be one of `holiday` or `working_day_override`
- `isWorkingDay` is derived consistently from `type`

Invalid payloads should fail as request errors before hitting the database so callers get `400` instead of storage-level `500`.

### 3. Admin console visibility

Do not revert focused mode. Instead:

- keep non-active sections hidden while focused mode is on
- add focused regression coverage proving the active section still exposes visible `Edit` buttons
- tighten admin-rail action layout on narrow viewports so hidden-state heuristics are not confused by wrapped controls

This preserves the streamlined admin console introduced in v2.7.x while addressing the practical complaint behind the visibility report.

### 4. Mobile overflow

Address the two observed overflow sources:

- allow the global top nav to wrap on mobile
- remove the fixed `min-width: 860px` behavior from the records table on mobile
- prevent action-button groups from collapsing into zero-width or overflowing layouts on small screens

### 5. Contract alignment

Update OpenAPI source and generated artifacts to match runtime:

- add request item CRUD paths
- add holiday item `GET`
- document the `type` enum for holiday create/update bodies

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/openapi/src/paths/attendance.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `apps/web/src/App.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceAdminRail.vue`
- `apps/web/tests/attendance-admin-regressions.spec.ts`

## Risks and mitigations

- Request update/delete semantics could drift from existing request ownership rules.
  - Mitigation: route all item operations through shared access checks and add focused integration coverage.
- Holiday validation could reject existing valid clients if normalization is too strict.
  - Mitigation: accept `Date` and string values, then normalize to canonical `YYYY-MM-DD`.
- Admin focused mode could be accidentally weakened by "visibility" fixes.
  - Mitigation: explicitly keep focused mode and add a regression test that checks active-section visibility instead of counting hidden buttons in inactive sections.
