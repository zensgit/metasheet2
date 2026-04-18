# DingTalk Directory Governance PR Package Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Package the current DingTalk directory-governance work into one mergeable PR slice instead of continuing to stack more features onto the branch.

## Included Capabilities

This PR package intentionally groups the following completed capabilities:

1. manual local-user admission from synced DingTalk members;
2. forced password change after temporary-password admission or admin reset;
3. scoped automatic admission for allowlisted department subtrees;
4. excluded-department overrides for auto admission;
5. selected department projection into `platform_member_groups`.

## Why Package Now

At this point the branch already spans:

- directory review-card governance;
- onboarding/password governance;
- department-scoped sync policy;
- member-group projection.

That is already a complete DingTalk sync governance slice. Adding role-template coupling or time-based password policy before opening a PR would make the review surface significantly larger and harder to land safely.

## Delivery Boundary

### Backend

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/migrations/056_add_users_must_change_password.sql`

### Frontend

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/ForcePasswordChangeView.vue`
- `apps/web/src/main.ts`
- `apps/web/src/App.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/router/types.ts`
- `apps/web/src/utils/api.ts`

### Tests

- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/auth-invite-routes.test.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/directory-sync-auto-admission.test.ts`
- `packages/core-backend/tests/unit/directory-sync-bind-account.test.ts`
- `packages/core-backend/tests/unit/directory-sync-member-group-projection.test.ts`
- `packages/core-backend/tests/unit/directory-sync-review-items.test.ts`
- `packages/core-backend/tests/unit/jwt-middleware.test.ts`
- `apps/web/tests/LoginView.spec.ts`
- `apps/web/tests/ForcePasswordChangeView.spec.ts`
- `apps/web/tests/directoryManagementView.spec.ts`
- `apps/web/tests/utils/api.test.ts`

### Documentation

- `docs/development/dingtalk-directory-manual-user-admission-*.md`
- `docs/development/dingtalk-password-change-required-*.md`
- `docs/development/dingtalk-directory-auto-admission-*.md`
- `docs/development/dingtalk-directory-auto-admission-exclusions-*.md`
- `docs/development/dingtalk-directory-member-group-projection-*.md`
- updated design notes:
  - `docs/development/dingtalk-directory-auto-admission-and-password-governance-design-20260418.md`
  - `docs/development/dingtalk-directory-sync-admission-and-scoped-sync-design-20260418.md`

## Explicitly Not Included

This PR package still does **not** implement:

- time-bounded password rotation policies;
- automatic role-template assignment from projected member groups;
- dedicated UI for browsing or editing projected member groups from the directory page;
- DingTalk outbound test-message delivery to bound group webhooks.

## Deployment Notes

No remote deployment was performed while assembling this PR package.

If deployed later, the only new migration required by this package is:

- `056_add_users_must_change_password.sql`
