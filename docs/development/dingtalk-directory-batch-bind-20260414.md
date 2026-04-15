# DingTalk Directory Batch Bind - 2026-04-14

## Scope

This round extends the directory review queue from read-only review into bind execution:

- backend `batch-bind` route for directory accounts
- frontend quick bind and batch bind in review queue
- targeted backend/frontend test coverage

## Backend Changes

Updated [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1):

- added `DirectoryAccountBatchBindEntry`
- added `batchBindDirectoryAccounts(...)`
- batch bind reuses `bindDirectoryAccount(...)`, so the same identity conflict checks, DingTalk identifier requirements, and grant behavior apply

Updated [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1):

- added `POST /api/admin/directory/accounts/batch-bind`
- route accepts `bindings: [{ accountId, localUserRef, enableDingTalkGrant }]`
- each successful bind writes the same audit pattern as the single-account bind path

## Frontend Changes

Updated [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:150):

- `待处理队列` now supports inline bind for `pending_binding` items
- each pending item can:
  - input local user id/email
  - search local users
  - choose a result
  - toggle `绑定后同时开通钉钉登录`
  - execute `快速绑定`
- added batch action:
  - select multiple `pending_binding` review items
  - submit `批量绑定`
- existing queue refresh chain stays consistent:
  - integration selection
  - manual sync
  - single bind/unbind
  - batch bind/unbind

## Tests

Updated:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [packages/core-backend/tests/unit/directory-sync-bind-account.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-bind-account.test.ts:1)
- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)

Covered behaviors:

- backend `POST /accounts/batch-bind`
- frontend review queue initial load still includes review items
- frontend batch bind for pending review items
- existing batch unbind / observability flows remain green

## Verification

Passed:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Still failing outside this DingTalk change set:

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

## Claude CLI Note

Claude Code CLI is available in this environment (`2.1.107`).

A read-only check confirmed the new admin routes are present:

- `POST /accounts/batch-bind`
- `GET /integrations/:integrationId/review-items`

Implementation and verification still rely on local code and local tests as the source of truth.
