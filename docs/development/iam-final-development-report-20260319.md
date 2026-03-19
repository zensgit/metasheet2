# IAM Final Development Report

Date: 2026-03-19
Repository: `metasheet2`

## Objective

Complete the remaining IAM closure work so the delivered session/invite/user/role/permission/audit surface is consistent across runtime routes, authorization behavior, frontend behavior, API contract, shared error handling, and targeted automated coverage.

## Completed Development Work

### Backend runtime

- Mounted `adminUsersRouter()` in the main server bootstrap so IAM admin routes are actually exposed at runtime.
- Preserved existing `/api/admin/*` safety/admin routes while adding the missing IAM management router in parallel.
- Normalized admin IAM error extraction through a shared backend helper so nested payload errors are surfaced consistently.

### Route conflict cleanup

- Removed the duplicate `GET /api/admin/roles` implementation from `rolesRouter()`.
- Kept the admin write aliases for role CRUD mutations:
  - `POST /api/admin/roles`
  - `PUT /api/admin/roles/:id`
  - `DELETE /api/admin/roles/:id`
- This prevents runtime ambiguity between:
  - role catalog payload used by IAM user/role management
  - generic role CRUD payload used by legacy role mutation handlers

### View IAM hardening

- Added route-level authentication to `/api/views/*`.
- Added table-level RBAC gating for view config/data/state access.
- Enforced:
  - read permission for config reads, data reads, and state reads/writes
  - write permission for config updates/deletes
- Normalized denied access to `403`.
- Normalized missing views to `404`.

### OpenAPI completion

- Expanded admin IAM contract coverage in `packages/openapi/src/paths/admin-users.yml`.
- Expanded auth/session contract coverage in `packages/openapi/src/paths/auth.yml`.
- Expanded permission-state and permission-template coverage in `packages/openapi/src/paths/permissions.yml`.
- Added admin role mutation aliases to `packages/openapi/src/paths/roles.yml`.
- Updated `packages/openapi/src/paths/views.yml` to reflect authenticated/RBAC-protected behavior.
- Added reusable session and permission schemas in `packages/openapi/src/base.yml`.
- Updated the OpenAPI validator so `/api/permissions/health` is treated as a public health endpoint while method-key validation skips non-HTTP keys.
- Regenerated the OpenAPI dist artifacts.

### Frontend IAM hardening

- Added shared frontend helpers for:
  - nested/top-level API error extraction
  - safe post-login redirect resolution
  - session payload normalization across camelCase and snake_case responses
- Updated IAM-facing views to use the shared helpers and consistent failure handling:
  - `AcceptInviteView`
  - `AdminAuditView`
  - `LoginView`
  - `PermissionManagementView`
  - `RoleManagementView`
  - `SessionCenterView`
  - `UserManagementView`
- Updated app bootstrap and feature-flag loading to use the same error/session handling path.

### Additional test coverage

- Extended backend admin-user route coverage for user provisioning, invite ledger, audit export, and admin session revocation flows.
- Added backend route tests for view auth + RBAC behavior.
- Extended backend role-route tests to lock the admin alias behavior.
- Added frontend unit coverage for:
  - `AcceptInviteView`
  - `AdminAuditView`
  - `LoginView`
  - `PermissionManagementView`
  - `RoleManagementView`
  - `SessionCenterView`
  - `UserManagementView`
  - frontend error/navigation/session helpers
- Fixed a frontend regression in `RoleManagementView` so successful role creation now reports `角色已创建` instead of incorrectly reusing the update status.

### Build unblock

- Repaired a broad syntax break in `apps/web/src/views/AttendanceView.vue` caused by incomplete `readErrorMessage(...)` substitutions and several residual extra/missing parentheses.
- This was necessary to restore full frontend production build verification for the current worktree.

## Files Added

- `apps/web/src/utils/error.ts`
- `apps/web/src/utils/navigation.ts`
- `apps/web/src/utils/session.ts`
- `apps/web/tests/acceptInviteView.spec.ts`
- `apps/web/tests/adminAuditView.spec.ts`
- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `packages/core-backend/tests/unit/views-routes.test.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/openapi/src/paths/admin-users.yml`
- `apps/web/tests/sessionCenterView.spec.ts`
- `apps/web/tests/userManagementView.spec.ts`
- `apps/web/tests/utils/error.spec.ts`
- `apps/web/tests/utils/navigation.spec.ts`
- `apps/web/tests/utils/session.spec.ts`
- `apps/web/tests/roleManagementView.spec.ts`

## Files Updated

- `apps/web/src/main.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/AcceptInviteView.vue`
- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/src/views/RoleManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-routes.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/views.ts`
- `packages/core-backend/src/routes/roles.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/roles-routes.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/auth.yml`
- `packages/openapi/src/paths/permissions.yml`
- `packages/openapi/src/paths/roles.yml`
- `packages/openapi/src/paths/views.yml`
- `packages/openapi/tools/validate.ts`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`

## Outcome

The IAM closure plan is now carried through the backend runtime, admin/user/session/permission contract surface, view-route authorization path, frontend IAM session and management views, shared error/session helpers, and targeted backend/frontend verification for the delivered user/session/invite/permission/audit flows.
