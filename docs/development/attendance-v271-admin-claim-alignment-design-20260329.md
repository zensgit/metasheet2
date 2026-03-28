# Attendance v2.7.1 Admin Claim Alignment Design

## Problem

Attendance admin routes inside `plugin-attendance` use a custom `withPermission()` guard that only checks RBAC tables through `isAdmin(userId)` and `userHasPermission(userId, permission)`.

That diverges from the core RBAC middleware, which trusts the already-authenticated request user first:

- admin role on `req.user`
- resolved wildcard permissions such as `*:*`
- request-scoped permission lists already attached by auth middleware

The gap shows up immediately in local/dev sessions:

- `/api/auth/me` returns a valid admin snapshot with `permissions: ["*:*"]`
- `/api/admin/users` succeeds
- but attendance admin routes like `/api/attendance/settings` still return `403 FORBIDDEN`

This makes the admin console appear permission-blocked even though the authenticated session is effectively an admin session.

## Scope

Smallest safe slice:

1. Align `plugin-attendance` permission checks with the core RBAC semantics.
2. Keep database-backed permission fallback intact.
3. Do not change attendance resource schemas or UI structure.

## Change

Add request-user permission helpers inside `plugin-attendance`:

- normalize permission arrays from `req.user.permissions` and `req.user.perms`
- treat `role=admin` or `roles[]` containing `admin` as admin
- accept `*:*` and `<resource>:*` wildcard permissions

Then update `withPermission()` so it:

1. trusts the authenticated request user first
2. falls back to database RBAC only when request claims do not already authorize the action

## Expected Outcome

- Dev/admin sessions that already resolve as admin in core auth can open attendance admin routes without being blocked by plugin-local RBAC drift.
- The previously reported “edit button invisible” report can be rechecked against the actual admin console instead of a permission-blocked shell.
- Existing DB-backed RBAC flows remain unchanged.
