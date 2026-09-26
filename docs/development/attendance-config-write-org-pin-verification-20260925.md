# Verification: calculation and authorization config org pin

Date: 2026-09-25. Base `main` `4189aa096a8a8054315bb97db79dfbac1823954e`.

Design: `docs/development/attendance-config-write-org-pin-design-20260925.md`.
Plan: `docs/development/attendance-cross-org-write-slices-plan-20260925.md`.

## Command

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-config-write-org-pin.test.ts \
  tests/unit/attendance-import-permission.test.ts \
  --reporter=dot --watch=false
```

Vitest 1.6.1. Result: **2 files, 117 tests, all passed** (113 in the org-pin file, 4 in the import-permission file).

The org-pin file activates the attendance plugin against an in-memory query double. It does not open Postgres.

## What the 113 cases cover

For each of the 10 slice routes:

| Case | Result |
| --- | --- |
| `query.orgId`, `body.orgId`, or `x-org-id` names another org | 404 `NOT_FOUND` / `Organization not found`. No `attendance_*` SQL |
| No selector | 200 or 201. Every attendance write parameter list contains the token tenant and not the other org |
| Empty-string selector on body, query, or header, and a whitespace body selector | Same as no selector |
| Body selector equal to the token tenant | Write proceeds (including scheduler-scope schemas, which are `.strict()`) |
| `user.orgId === ''` with `authenticatedTenantId` set | Write uses the token tenant |
| No `user.orgId`, `workspaceId`, or `authenticatedTenantId` | 403 `FORBIDDEN` / `Authenticated organization not found`. No `attendance_*` SQL |

Also:

- `GET /api/attendance/rules/default` with a foreign query org is still 404 `Group not found` and runs no attendance SQL. With `user.orgId === ''` and a token tenant, the read uses that tenant.
- `POST /api/attendance/anomaly-result-edits` with a foreign body org still reaches `resolveRecordOperationAdminActorPosture`. An active member gets `404` `ATTENDANCE_RECORD_NOT_FOUND` (membership passed, no record row, no write). A non-member gets `403` `Record operation requires active org membership` and the record query does not run.
- `POST /api/attendance/punch` with a foreign body org is `403` `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED` for a non-member. A member is not rejected with `Organization not found` or `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED`.

`attendance-import-permission.test.ts` now expects `getAuthenticatedOrgId` to walk `[user.orgId, user.workspaceId, req.authenticatedTenantId]` and skip blank strings. It still requires that helper not to read `user.tenantId`, `x-org-id`, or `DEFAULT_ORG_ID`.

## If the pin is removed

Replacing `resolveAuthenticatedAttendanceOrg` with `getOrgId` on these routes makes the foreign query, body, and header cases fail: they would write, or they would not return 404 `Organization not found` with zero attendance SQL.

## Not proved here

- A live database or HTTP server.
- Platform `user_roles.role_id = 'admin'` skipping record-operation membership. The double returns `platform_admin: false`.
- Import and integration routes. They still call `getOrgId` on this branch.
- `getAuthenticatedAttendanceGroupEffectivePolicyOrgId` in `attendance-admin.ts`, which still uses `??` between `orgId` and `workspaceId`.
- Group-route selectors: a present empty string is still a mismatch (`Group not found`), unlike the slice-1 helper, which ignores blanks.
- Punch with no selector still uses `getOrgId`.
