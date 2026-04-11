# After-Sales Tenant Hardening

## Scope

This slice hardens tenant semantics for the after-sales plugin and removes the last silent fallback to `'default'` in the HTTP/runtime path.

It intentionally keeps the v1 pseudo project id shape unchanged:

- `projectId = ${tenantId}:${appId}`

It does not introduce schema migrations.

## Design

### 1. Trusted token and request propagation

`/api/auth/dev-token` now accepts an optional `tenantId` query parameter and embeds it into the issued JWT payload.

`AuthService.verifyToken()` preserves `tenantId` from trusted tokens and returns it on `req.user`.

`jwtAuthMiddleware` continues to assign the authenticated user object to `req.user`, so the tenant claim is available to downstream routes.

### 2. CoreAPI tenant seam

`CoreAPI` now exposes:

- `tenant.getTenantId(): string | undefined`
- `tenant.requireTenantId(): string`

The implementation is backed by `tenantContext` AsyncLocalStorage in `MetaSheetServer.createCoreAPI()`.

### 3. HTTP tenant ALS establishment

After JWT auth, `MetaSheetServer` now establishes tenant ALS for requests whose authenticated user carries a non-empty `tenantId`.

If the request has no tenant claim, no ALS context is established.

This keeps the server neutral for non-tenant-aware endpoints while allowing tenant-aware plugins to read tenant context from `context.api.tenant`.

### 4. After-sales strict tenant resolution

`plugins/plugin-after-sales/index.cjs` no longer falls back to `'default'`.

HTTP routes now resolve tenant in this order:

1. `context.api.tenant.getTenantId()`
2. `req.user.tenantId`
3. otherwise `401 UNAUTHORIZED` with `tenantId not found`

This turns missing tenant state into an explicit failure instead of silently writing into the wrong tenant namespace.

`resolveTenantIdFromProject()` is now strict and throws `VALIDATION_ERROR` when `projectId` is absent or lacks a tenant prefix.

### 5. Workflow adapter strict runtime resolution

`plugins/plugin-after-sales/lib/workflow-adapter.cjs` no longer resolves tenant to `'default'`.

Runtime tenant resolution now uses:

1. `payload.tenantId`
2. `payload.ticket.tenantId`
3. `payload.approval.tenantId`
4. tenant parsed from `payload.projectId`
5. `context.api.tenant.getTenantId()`
6. otherwise `VALIDATION_ERROR`

After `loadCurrent()`, the adapter also reuses `current.projectId` when available to derive the effective runtime `projectId`.

Invalid non-tenant-scoped `projectId` values now fail fast.

### 6. Frontend adjustment

`AfterSalesView.vue` no longer passes a placeholder project id when loading refund approval snapshots.

The refund-approval read path is now keyed only by `ticketId`, which matches the backend route contract and avoids reintroducing fake tenant/project semantics into runtime reads.

## Files Changed

- `apps/web/src/views/AfterSalesView.vue`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/types/express.d.ts`
- `packages/core-backend/src/types/plugin.ts`
- `packages/core-backend/tests/integration/after-sales-plugin.install.test.ts`
- `packages/core-backend/tests/unit/AuthService.test.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`
- `packages/core-backend/tests/unit/after-sales-workflow-adapter.test.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/jwt-middleware.test.ts`
- `plugins/plugin-after-sales/index.cjs`
- `plugins/plugin-after-sales/lib/workflow-adapter.cjs`

## Verification

### Passed

1. Targeted backend/unit verification

```bash
cd /Users/huazhou/Downloads/Github/metasheet2/.worktrees/after-sales-tenant-hardening
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/AuthService.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/jwt-middleware.test.ts \
  tests/unit/after-sales-plugin-routes.test.ts \
  tests/unit/after-sales-workflow-adapter.test.ts \
  --reporter=dot
```

Result:

- `5` test files passed
- `155` tests passed

2. Real-DB after-sales integration verification

```bash
cd /Users/huazhou/Downloads/Github/metasheet2/.worktrees/after-sales-tenant-hardening
DATABASE_URL=postgresql:///metasheet_test \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/after-sales-plugin.install.test.ts \
  --reporter=dot
```

Result:

- `1` integration file passed
- `25` tests passed

3. Core backend TypeScript build

```bash
cd /Users/huazhou/Downloads/Github/metasheet2/.worktrees/after-sales-tenant-hardening
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

4. Patch hygiene

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2/.worktrees/after-sales-tenant-hardening diff --check
```

Result:

- passed

### Not clean yet

Frontend workspace type-check is not clean, but the failures are pre-existing and unrelated to this slice:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2/.worktrees/after-sales-tenant-hardening
pnpm --filter @metasheet/web type-check
```

Current failures are in unrelated PLM/realtime files, for example:

- missing module `socket.io-client`
- missing module `@metasheet/sdk/client`
- existing implicit `any` / `unknown` issues in `src/services/plm/*`

No type-check error was reported for `apps/web/src/views/AfterSalesView.vue`.

## Local Environment Notes

This worktree required local `node_modules` symlinks to reuse the main workspace dependencies:

- `.worktrees/after-sales-tenant-hardening/node_modules`
- `.worktrees/after-sales-tenant-hardening/packages/core-backend/node_modules`
- `.worktrees/after-sales-tenant-hardening/apps/web/node_modules`

These are local environment conveniences only and are not part of the code change.
