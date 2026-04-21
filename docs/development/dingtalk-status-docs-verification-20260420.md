# DingTalk Status Docs Verification

- Date: 2026-04-20
- Scope: documentation verification against current `main`

## Verification method

The documents were verified by checking current-main code paths and existing shipped docs, not by relying on earlier branch history.

## Repository checks performed

### Existing DingTalk docs

Reviewed:

- [docs/dingtalk-capability-guide-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/docs/dingtalk-capability-guide-20260420.md:1)
- [docs/dingtalk-admin-operations-guide-20260420.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/docs/dingtalk-admin-operations-guide-20260420.md:1)

### Manual admission path

Confirmed:

- admin route returns created local user, temporary password, invite token, and onboarding
- directory admission logic still requires `name + email`

References:

- [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/admin-directory.ts:380)
- [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:3337)

### Auto-admission path

Confirmed:

- department-scoped auto-admission exists
- current-main auto-admission still skips missing-email accounts

References:

- [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:2014)
- [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:2083)
- [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:2258)

### Forced password-change onboarding

Confirmed:

- generated onboarding passwords still route through `must_change_password`

References:

- [packages/core-backend/src/routes/auth.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/auth.ts:433)
- [apps/web/src/views/ForcePasswordChangeView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/ForcePasswordChangeView.vue:1)

### Member-group projection

Confirmed:

- DingTalk department projection into `platform_member_groups` is present on current `main`

References:

- [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/directory/directory-sync.ts:740)
- [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/views/DirectoryManagementView.vue:191)

### Protected public-form allowlists

Confirmed:

- current `main` accepts:
  - `allowedUserIds`
  - `allowedMemberGroupIds`
- `public` mode cannot keep allowlists configured
- local users/member groups are validated on write

References:

- [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/routes/univer-meta.ts:5362)
- [apps/web/src/multitable/components/MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/apps/web/src/multitable/components/MetaFormShareManager.vue:335)

### DingTalk notification mainline

Confirmed:

- group message automation exists
- person message automation exists
- delivery viewers/services exist

References:

- [packages/core-backend/src/multitable/automation-actions.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/multitable/automation-actions.ts:50)
- [packages/core-backend/src/multitable/automation-executor.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/multitable/automation-executor.ts:859)
- [packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts:82)
- [packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-status-docs-20260420/packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts:93)

## Outcome

The new docs match the current-main implementation boundary:

- synced DingTalk accounts can become local users
- current `main` still treats email as required for admission
- DingTalk notifications and protected form allowlists are already shipped
- the next unresolved layer is governance refinement, not the 0-to-1 DingTalk mainline
