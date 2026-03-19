# IAM Final Merge Handoff

Date: 2026-03-19
Repository: `metasheet2`

## Merge Readiness

The IAM closure work in the current worktree is ready for merge review.

The remaining caution is repository hygiene, not feature completeness:

- the current worktree contains unrelated non-IAM edits
- IAM files should be staged selectively
- root `pnpm lint` and `pnpm type-check` are currently no-op gates in this repository state

## IAM File Set

### Runtime and authorization

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-routes.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/roles.ts`
- `packages/core-backend/src/routes/views.ts`
- `packages/core-backend/src/utils/error.ts`

### Backend tests

- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/roles-routes.test.ts`
- `packages/core-backend/tests/unit/views-routes.test.ts`

### OpenAPI source and generated artifacts

- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/admin-users.yml`
- `packages/openapi/src/paths/auth.yml`
- `packages/openapi/src/paths/permissions.yml`
- `packages/openapi/src/paths/roles.yml`
- `packages/openapi/src/paths/views.yml`
- `packages/openapi/tools/validate.ts`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`

### Frontend IAM surface and helpers

- `apps/web/src/main.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/AcceptInviteView.vue`
- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/src/views/RoleManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/utils/error.ts`
- `apps/web/src/utils/navigation.ts`
- `apps/web/src/utils/session.ts`

### Frontend tests

- `apps/web/tests/acceptInviteView.spec.ts`
- `apps/web/tests/adminAuditView.spec.ts`
- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `apps/web/tests/roleManagementView.spec.ts`
- `apps/web/tests/sessionCenterView.spec.ts`
- `apps/web/tests/userManagementView.spec.ts`
- `apps/web/tests/utils/error.spec.ts`
- `apps/web/tests/utils/navigation.spec.ts`
- `apps/web/tests/utils/session.spec.ts`

### Frontend build unblock

- `apps/web/src/views/AttendanceView.vue`

### Closure documentation

- `docs/development/iam-final-development-report-20260319.md`
- `docs/development/iam-final-verification-report-20260319.md`
- `docs/development/iam-final-closure-report-20260319.md`
- `docs/development/iam-final-merge-handoff-20260319.md`
- `docs/development/iam-final-pr-draft-20260319.md`

## Suggested Commit Split

### Commit 1: IAM runtime, auth-session, contract, and tests

Recommended scope:

- backend runtime route exposure
- backend/admin shared error extraction
- auth/session/permission contract completion
- view-route auth/RBAC enforcement
- role route conflict cleanup
- backend IAM tests
- frontend IAM view/helper updates
- frontend IAM tests
- OpenAPI source updates
- generated OpenAPI artifacts
- closure documentation

Suggested message:

```text
feat(iam): close runtime, auth-session, and contract gaps
```

### Commit 2: Frontend build unblock

Recommended scope:

- `apps/web/src/views/AttendanceView.vue`

Suggested message:

```text
fix(web): repair attendance view syntax regression
```

This second split keeps the IAM business change set reviewable while still preserving the now-green frontend production build.

## Verification Completed

The following checks passed in the current worktree:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/jwt-middleware.test.ts tests/unit/permissions-routes.test.ts tests/unit/roles-routes.test.ts tests/unit/views-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm openapi:check`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web exec vitest run tests/acceptInviteView.spec.ts tests/adminAuditView.spec.ts tests/loginView.spec.ts tests/permissionManagementView.spec.ts tests/roleManagementView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts tests/utils/error.spec.ts tests/utils/navigation.spec.ts tests/utils/session.spec.ts tests/featureFlags.spec.ts tests/useAuth.spec.ts`
- `pnpm --filter @metasheet/web build`
- `pnpm validate:plugins`

Verification summary:

- backend IAM tests: `102/102`
- frontend IAM combined regression rerun: `59/59`
- plugin manifest validation: `11` valid, `0` invalid, `9` warnings

## Review Notes

- `apps/web/src/views/AttendanceView.vue` is included only because it was required to restore a passing frontend production build in the current worktree.
- `packages/core-backend/src/routes/admin-routes.ts` is adjacent to IAM and should be reviewed as shared admin error-normalization work, not as a new feature surface.
- Generated OpenAPI artifacts should be reviewed together with their source YAML changes, not independently.
- The IAM reports and PR draft in `docs/development/` are part of the deliverable and should be kept with the merge.

## Companion Drafts

- PR draft: `docs/development/iam-final-pr-draft-20260319.md`
