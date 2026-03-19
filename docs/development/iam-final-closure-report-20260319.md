# IAM Final Closure Report

Date: 2026-03-19
Repository: `metasheet2`

## Scope

This closure pass completed the remaining IAM runtime, authorization, OpenAPI, and verification work in the current worktree.

## Delivered

### 1. Runtime gaps closed

- Mounted `adminUsersRouter()` in the backend server so IAM user/session/audit endpoints are exposed at runtime.
- Removed the duplicate `GET /api/admin/roles` implementation from `rolesRouter()` to avoid payload conflicts with the IAM role catalog route.
- Kept admin write aliases in `rolesRouter()` for:
  - `POST /api/admin/roles`
  - `PUT /api/admin/roles/:id`
  - `DELETE /api/admin/roles/:id`
- Added shared backend error extraction and applied it across IAM/admin route surfaces so nested error payloads are returned consistently.

### 2. View route IAM enforcement

- Added route-level authentication to `/api/views/*`.
- Added table-level RBAC enforcement on view routes:
  - read checks for `GET /api/views/:viewId/config`
  - read checks for `GET /api/views/:viewId/data`
  - read checks for `GET /api/views/:viewId/state`
  - read checks for `POST /api/views/:viewId/state`
  - write checks for `PUT /api/views/:viewId/config`
  - write checks for `DELETE /api/views/:viewId/config`
- Normalized missing/deleted views to `404`.
- Normalized table RBAC denials to `403`.

### 3. OpenAPI completion

- Expanded `packages/openapi/src/paths/admin-users.yml` to cover the implemented IAM admin surface:
  - user list/create
  - access presets
  - invite ledger, revoke, resend
  - user access snapshot
  - role assign/unassign
  - status change
  - password reset
  - user session list/single revoke/all revoke
  - admin role catalog
  - audit activity list/export
  - session revocation history
- Expanded `packages/openapi/src/paths/auth.yml` for self-service session center endpoints:
  - session list
  - single-session logout
  - current-session heartbeat
  - current-session logout
  - other-sessions logout
- Expanded `packages/openapi/src/paths/permissions.yml` for:
  - degraded permission-state responses
  - admin permission template list/apply
  - user-specific permission-state lookup
- Added reusable OpenAPI schemas in `packages/openapi/src/base.yml` for:
  - permission templates
  - user permission state
  - user session records and session response payloads
- Expanded `packages/openapi/src/paths/roles.yml` for admin write aliases.
- Updated `packages/openapi/src/paths/views.yml` to document `401` and `403` responses for authenticated/RBAC-protected view routes.
- Updated `packages/openapi/tools/validate.ts` so public permission health checks and non-method OpenAPI path keys validate correctly.
- Regenerated:
  - `packages/openapi/dist/combined.openapi.yml`
  - `packages/openapi/dist/openapi.yaml`
  - `packages/openapi/dist/openapi.json`

### 4. Frontend IAM surface hardened

- Added shared frontend helpers for:
  - nested/top-level API error extraction
  - safe post-login redirect resolution
  - session payload normalization across API shapes
- Applied the shared helpers across:
  - invite acceptance
  - login redirect flow
  - admin audit activity
  - permission management
  - role management
  - session center
  - user management
  - app bootstrap and feature-flag loading
- Fixed the role creation success-state regression in `apps/web/src/views/RoleManagementView.vue`.
- Repaired `apps/web/src/views/AttendanceView.vue` syntax regressions so full frontend production build verification could complete.

### 5. Test coverage added

- Extended `packages/core-backend/tests/unit/admin-users-routes.test.ts` for IAM user provisioning, invite ledger, audit export, and session revocation behavior.
- Extended `packages/core-backend/tests/unit/roles-routes.test.ts` to cover admin alias role creation and to lock out duplicate admin list routing in `rolesRouter()`.
- Added `packages/core-backend/tests/unit/views-routes.test.ts` covering:
  - auth required on view routes
  - `403` on table read denial
  - successful read path when table access is granted
  - `403` on table write denial
- Added frontend coverage for:
  - `AcceptInviteView`
  - `AdminAuditView`
  - `LoginView`
  - `PermissionManagementView`
  - `RoleManagementView`
  - `SessionCenterView`
  - `UserManagementView`
  - frontend error/navigation/session helpers

## Validation

### Commands run

1. `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/jwt-middleware.test.ts tests/unit/permissions-routes.test.ts tests/unit/roles-routes.test.ts tests/unit/views-routes.test.ts`
2. `pnpm --filter @metasheet/core-backend build`
3. `pnpm openapi:check`
4. `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
5. `pnpm --filter @metasheet/web exec vitest run tests/acceptInviteView.spec.ts tests/adminAuditView.spec.ts tests/loginView.spec.ts tests/permissionManagementView.spec.ts tests/roleManagementView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts`
6. `pnpm --filter @metasheet/web exec vitest run tests/featureFlags.spec.ts tests/useAuth.spec.ts`
7. `pnpm --filter @metasheet/web build`
8. `pnpm --filter @metasheet/web exec vitest run tests/acceptInviteView.spec.ts tests/adminAuditView.spec.ts tests/loginView.spec.ts tests/permissionManagementView.spec.ts tests/roleManagementView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts tests/utils/error.spec.ts tests/utils/navigation.spec.ts tests/utils/session.spec.ts tests/featureFlags.spec.ts tests/useAuth.spec.ts`
9. `pnpm validate:plugins`

### Results

- Backend IAM unit tests passed: `102/102`
- Backend TypeScript build passed
- OpenAPI build, security validation, and parse validation passed
- Plugin manifest validation passed: `11` valid, `0` invalid, `9` warnings
- Frontend IAM view tests passed: `38/38`
- Frontend auth/session bootstrap tests passed: `7/7`
- Final combined frontend IAM regression rerun passed: `59/59`
- Frontend type-check passed
- Frontend production build passed

## Environment note

The current worktree initially had broken `node_modules` symlinks for packages such as `js-yaml` and `tsx`, pointing into another worktree:

- `node_modules/js-yaml`
- `node_modules/tsx`

This blocked `pnpm openapi:check` even though the source changes were valid. The issue was resolved locally with:

- `CI=true pnpm install --ignore-scripts`

That command repaired dependency links in the current worktree and allowed OpenAPI validation to complete.

## Remaining risk

- This pass covered targeted IAM backend/frontend validation plus plugin manifest validation, not the full repository test matrix or broader non-IAM E2E coverage.
- The root `pnpm lint` and `pnpm type-check` entry points currently resolve to workspace-recursive scripts that are effectively no-op because the selected packages do not expose those scripts.

## Handoff

- Merge handoff and suggested commit split: `docs/development/iam-final-merge-handoff-20260319.md`
- PR draft and exact staging commands: `docs/development/iam-final-pr-draft-20260319.md`
