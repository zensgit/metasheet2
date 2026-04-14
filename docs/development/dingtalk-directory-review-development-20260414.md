# DingTalk Directory Review Development

## Scope

This iteration turns the DingTalk directory admin flow into a review-driven workflow instead of forcing operators to process every account one by one in the main member table.

Delivered:

- Directory review queue with server-backed counts and queue filters
- Recent directory sync alert panel with acknowledgement flow
- Batch bind and batch unbind actions for queued directory accounts
- Optional DingTalk grant disable when unbinding linked directory accounts
- Bulk DingTalk grant and bulk namespace admission actions in user management
- Linked-directory visibility in the DingTalk access snapshot

## Backend

Updated [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1):

- Added `DirectoryReviewReason`, `DirectoryReviewQueue`, and alert/review summary types
- Added `listDirectorySyncAlerts()`
- Added `acknowledgeDirectorySyncAlert()`
- Added `listDirectoryIntegrationReviewItems()`
- Restored `disableDingTalkGrant` support in `unbindDirectoryAccount()`

Updated [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1):

- `GET /api/admin/directory/integrations/:integrationId/alerts`
- `GET /api/admin/directory/integrations/:integrationId/review-items`
- `POST /api/admin/directory/accounts/batch-bind`
- `POST /api/admin/directory/accounts/batch-unbind`
- `POST /api/admin/directory/alerts/:alertId/ack`

Updated [packages/core-backend/src/routes/admin-users.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-users.ts:1):

- `fetchDingTalkAccessSnapshot()` now returns linked-directory status
- Added `POST /api/admin/users/dingtalk-grants/bulk`
- Added `POST /api/admin/users/namespaces/:namespace/admission/bulk`

## Frontend

Updated [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1):

- Added recent alert section with `pending / acknowledged / all` filters
- Added review queue section with `needs_binding / inactive_linked / missing_identity` filters
- Added inline local-user search and quick bind inside the queue
- Added batch bind and batch deprovision controls
- Added helper action to focus the selected member in the main account table

Updated [apps/web/src/views/UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue:1):

- Added DingTalk-linked directory visibility in the access panel
- Added batch DingTalk grant controls
- Added batch namespace admission controls

## Tests Updated

Backend:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [packages/core-backend/tests/unit/admin-users-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-users-routes.test.ts:1)
- [packages/core-backend/tests/unit/directory-sync-bind-account.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-bind-account.test.ts:1)

Frontend:

- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)
- [apps/web/tests/userManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/userManagementView.spec.ts:1)

## Notes

- The existing draft overview remains in [docs/development/dingtalk-directory-review-20260414.md](/Users/chouhua/Downloads/Github/metasheet2/docs/development/dingtalk-directory-review-20260414.md:1).
- `Claude Code CLI` was checked for this iteration but is not currently authenticated in this shell, so implementation stayed local.
