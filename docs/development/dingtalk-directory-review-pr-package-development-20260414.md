# DingTalk Directory Review PR Package

## PR Target

- Branch: `codex/feishu-gap-rc-integration-202605`
- Head commit: `591e915b2`
- Suggested title: `feat(dingtalk): add directory review workflow`

## PR Summary

This PR upgrades DingTalk admin operations from single-account fixes to a review-driven workflow.

Delivered:

- Directory review queue with `needs_binding / inactive_linked / missing_identity` filters
- Recent sync alert panel with acknowledgement flow
- Batch bind and batch unbind operations for queued directory accounts
- Optional DingTalk grant disable on unbind
- Bulk DingTalk grant and plugin namespace admission actions in user management
- Linked-directory visibility in the DingTalk access snapshot

## Primary Files

Backend:

- [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1)
- [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1)
- [packages/core-backend/src/routes/admin-users.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-users.ts:1)

Frontend:

- [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1)
- [apps/web/src/views/UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue:1)

Tests:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [packages/core-backend/tests/unit/admin-users-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-users-routes.test.ts:1)
- [packages/core-backend/tests/unit/directory-sync-bind-account.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-bind-account.test.ts:1)
- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)
- [apps/web/tests/userManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/userManagementView.spec.ts:1)

## Suggested PR Body

```md
## What Changed

This PR adds a DingTalk directory review workflow for platform admins.

Backend changes:

- add directory sync alert listing and acknowledgement
- add review-queue listing with counts and queue filters
- add batch bind and batch unbind routes for directory accounts
- restore optional `disableDingTalkGrant` behavior on unbind
- add bulk DingTalk grant and bulk namespace admission routes in admin users
- include linked-directory status in the DingTalk access snapshot

Frontend changes:

- add a recent alerts panel to Directory Management
- add a review queue with inline bind/search actions
- add batch bind and batch deprovision controls
- add linked-directory visibility and bulk controls in User Management

## Why

The existing DingTalk admin flow handled account drift one member at a time. This PR introduces an operator workflow that surfaces reviewable items directly, lets admins acknowledge sync alerts, and supports bulk handling for the common cases.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`

## Notes

- Backend workspace `tsc --noEmit` is still blocked by pre-existing issues in `api-token-auth.ts`, `automation-service.ts`, `comments.ts`, and `univer-meta.ts`.
- This PR does not modify the DingTalk OAuth login callback flow.
```

## Review Focus

- Alert acknowledgement route and audit coverage
- Review queue classification logic
- Batch bind / unbind semantics and grant side effects
- Bulk user-management actions and refresh behavior
- Frontend state separation between alerts, review queue, and account table
