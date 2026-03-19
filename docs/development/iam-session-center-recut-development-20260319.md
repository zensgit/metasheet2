# IAM Session Center Recut Development Report

## Summary

- Recut the stale IAM slice from `prep-slice2-iam-session-stacked` onto current `main` because [#454](https://github.com/zensgit/metasheet2/pull/454) was stacked on the closed `prep-slice1-attendance-candidate` base from [#455](https://github.com/zensgit/metasheet2/pull/455).
- Cherry-picked `8a74765285dec2b8c3b8422d7ddd27e6042c0867` onto current `main`, then merged the latest `main` again after [#457](https://github.com/zensgit/metasheet2/pull/457) landed so the slice also carries the current PLM/workflow shell.
- Resolved recut conflicts in [main.ts](/private/tmp/metasheet2-pr454-recut/apps/web/src/main.ts) by preserving the current `main` routes and adding the IAM routes together:
  - `/accept-invite`
  - `/settings`
  - `/admin/users`
  - `/admin/roles`
  - `/admin/permissions`
  - `/admin/audit`
- Resolved the backend auth conflict in [auth.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/routes/auth.ts) by keeping the current secret-managed dev-token path together with the IAM invite/session/auth flow.

## Delivered Scope

- Frontend IAM views and shell integration:
  - [App.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/App.vue)
  - [main.ts](/private/tmp/metasheet2-pr454-recut/apps/web/src/main.ts)
  - [AcceptInviteView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/AcceptInviteView.vue)
  - [AdminAuditView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/AdminAuditView.vue)
  - [PermissionManagementView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/PermissionManagementView.vue)
  - [RoleManagementView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/RoleManagementView.vue)
  - [SessionCenterView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/SessionCenterView.vue)
  - [UserManagementView.vue](/private/tmp/metasheet2-pr454-recut/apps/web/src/views/UserManagementView.vue)
- Backend IAM runtime:
  - [AuthService.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/AuthService.ts)
  - [access-presets.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/access-presets.ts)
  - [invite-ledger.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/invite-ledger.ts)
  - [invite-tokens.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/invite-tokens.ts)
  - [password-policy.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/password-policy.ts)
  - [permission-templates.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/permission-templates.ts)
  - [session-registry.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/session-registry.ts)
  - [session-revocation.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/auth/session-revocation.ts)
  - [index.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/index.ts)
  - [admin-users.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/routes/admin-users.ts)
  - [auth.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/routes/auth.ts)
  - [permissions.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/src/routes/permissions.ts)
- Regression coverage:
  - [admin-users-routes.test.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/tests/unit/admin-users-routes.test.ts)
  - [auth-invite-routes.test.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/tests/unit/auth-invite-routes.test.ts)
  - [auth-login-routes.test.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/tests/unit/auth-login-routes.test.ts)
  - [permissions-routes.test.ts](/private/tmp/metasheet2-pr454-recut/packages/core-backend/tests/unit/permissions-routes.test.ts)

## Notes

- The recut intentionally excludes the obsolete stacked base history from `#455`; the resulting diff against current `main` is reduced to the IAM feature set itself.
- `pnpm install --frozen-lockfile` in the recut worktree rewired tracked plugin `node_modules` links; those environment-only changes were restored before preparing the PR branch.
