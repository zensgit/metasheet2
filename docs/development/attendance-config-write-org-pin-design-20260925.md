# Design: pin calculation and authorization config writes to the authenticated org

Date: 2026-09-25. Base: `main` `4189aa096a8a8054315bb97db79dfbac1823954e`.

Slice plan: `docs/development/attendance-cross-org-write-slices-plan-20260925.md`.

## Decision

Slice 1 is the calculation and authorization config writes that still called `getOrgId`:

- `PUT /api/attendance/rules/default`
- `POST`, `PUT`, `DELETE /api/attendance/overtime-rules`
- `POST`, `PUT`, `DELETE /api/attendance/approval-flows`
- `POST`, `PUT`, `DELETE /api/attendance/scheduler-scopes`

Rule-set and rule-template writes already use `resolveAttendanceGroupRouteActorContext`. They are not edited.

Import and integration routes stay on `getOrgId` for draft #6051.

## Contract

`getAuthenticatedOrgId` and `resolveAuthenticatedAttendanceOrg` match the copies on `cursor/attendance-roster-org-gate-0a5d` at `abfb1f824` (draft #6051). On merge, keep one body.

Authenticated org is the first non-blank of `user.orgId`, `user.workspaceId`, and `req.authenticatedTenantId`. A blank or whitespace claim does not hide a later one. A normal JWT has `authenticatedTenantId` and does not set `user.orgId`.

A non-blank `body.orgId`, `query.orgId`, or `x-org-id` value is only compared to that org. Any difference is `404` `{ code: 'NOT_FOUND', message: 'Organization not found' }` and the handler does not run SQL. A blank or whitespace selector is ignored. No authenticated org is `403` `{ code: 'FORBIDDEN', message: 'Authenticated organization not found' }`. The write org is never `'default'` when a token tenant exists.

The check runs before schema validation, so a mismatched selector does not depend on the rest of the body.

Scheduler-scope create and update schemas are `.strict()` and do not declare `orgId`. `attendanceBodyWithoutOrgSelector` drops `orgId` before Zod so a selector that matches the token is not a schema error. That helper is not on the #6051 branch. Reconcile it only if import routes need the same strip.

## What stays multi-org

`POST /api/attendance/anomaly-result-edits` (and recompute / ops-retirement) still pass `getOrgId` into `resolveRecordOperationAdminActorPosture`. An active `user_orgs` member of the named org can edit that org. A delegated admin who is not a member is 403. Platform `user_roles.role_id = 'admin'` still skips that membership check.

`POST /api/attendance/punch` still uses `resolvePunchOrgIdV1` when a selector is present. A non-member is `403` `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED`.

`getAuthenticatedAttendanceGroupEffectivePolicyOrgId` in `packages/core-backend/src/routes/attendance-admin.ts` is a separate copy and still uses `??` between `orgId` and `workspaceId`. This change does not edit it.

## Out of scope

Slices 2–6 in the plan (leave balances, payroll cycles, auto-absence / holiday sync / auto-shift apply / reminders, report sync and formula, shift-swap create and schedule-dispatch cancel). P1 reads and P2 catalogs. Import and integration routes.
