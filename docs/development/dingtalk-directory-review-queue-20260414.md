# DingTalk Directory Review Queue - 2026-04-14

## Scope

This round extends DingTalk directory governance from observability into operator workflow:

- backend review queue snapshot for directory governance
- backend batch unbind for inactive-linked directory members
- frontend review queue section in directory management
- targeted route/service/frontend tests

## Backend Changes

### Directory Sync Service

Updated [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1):

- added `DirectoryReviewItemSummary` and `DirectoryReviewItemFilter`
- added `listDirectoryReviewItems(...)`
- added `batchUnbindDirectoryAccounts(...)`
- review queue currently covers:
  - `pending_binding`
  - `inactive_linked`
  - `missing_identifier`
- `unbindDirectoryAccount(...)` already supports `disableDingTalkGrant`, and batch unbind reuses that path

### Admin Routes

Updated [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1):

- added `GET /api/admin/directory/integrations/:integrationId/review-items`
- added `POST /api/admin/directory/accounts/batch-unbind`
- batch route writes audit logs for each processed directory account

### Existing Runtime Context

This builds on the directory scheduler + observability work already wired through:

- [packages/core-backend/src/directory/directory-sync-scheduler.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync-scheduler.ts:1)
- [packages/core-backend/src/index.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/index.ts:97)

## Frontend Changes

Updated [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1):

- added a `待处理队列` section above the member account list
- queue displays:
  - pending binding members
  - inactive linked members
  - missing DingTalk identifier members
- added local tabs for:
  - `全部待处理`
  - `待绑定`
  - `停用待停权`
  - `缺身份标识`
- added queue actions:
  - `定位到成员`
  - single `停权处理`
  - batch `批量停权处理`
  - optional `停权时同时关闭钉钉登录`
- integration selection, manual sync, bind, and unbind now all refresh review queue state

## Tests

Updated:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [packages/core-backend/tests/unit/directory-sync-bind-account.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-bind-account.test.ts:1)
- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)

Covered behaviors:

- review-items route
- batch unbind route
- unbind with `disableDingTalkGrant`
- frontend initial load now includes review queue
- frontend manual sync refresh chain now includes review queue
- frontend batch review queue unbind

## Verification

Passed:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Still failing outside this DingTalk review-queue change set:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Current unrelated failures include:

- `src/db/types.ts`
- `src/middleware/api-token-auth.ts`
- `src/multitable/api-token-service.ts`
- `src/multitable/automation-log-service.ts`
- `src/multitable/automation-service.ts`
- `src/multitable/dashboard-service.ts`
- `src/multitable/webhook-service.ts`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`

## Notes

- Claude Code CLI is available in this environment (`2.1.107`), but non-interactive `claude -p` remained unstable during this round, so implementation and verification relied on local code plus local tests.
- Review queue and alerts stay separate by design:
  - alerts are runtime/sync observability
  - review queue is member-governance workflow
