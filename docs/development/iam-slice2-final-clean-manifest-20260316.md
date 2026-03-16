# IAM Slice 2 Clean PR Manifest (Session/Invite/Permissions)

基线：`origin/main`  
生成时间：2026-03-16  
目标：`session center`、`session registry`、`invite ledger/acceptance`、`admin audit`、`permission templates`

## 1) 可整文件入 PR（新增）

### 后端
- `packages/core-backend/src/auth/access-presets.ts`
- `packages/core-backend/src/auth/invite-ledger.ts`
- `packages/core-backend/src/auth/invite-tokens.ts`
- `packages/core-backend/src/auth/password-policy.ts`
- `packages/core-backend/src/auth/permission-templates.ts`
- `packages/core-backend/src/auth/session-registry.ts`
- `packages/core-backend/src/auth/session-revocation.ts`
- `packages/core-backend/src/db/migrations/zzzz20260312170000_create_user_session_revocations.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313103000_create_user_invites.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313183000_create_user_sessions.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/auth-invite-routes.test.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/jwt-middleware.test.ts`
- `packages/core-backend/tests/unit/permissions-routes.test.ts`
- `packages/core-backend/tests/unit/roles-routes.test.ts`

### 前端
- `apps/web/src/views/AcceptInviteView.vue`
- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/src/views/RoleManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/featureFlags.spec.ts`

## 2) 需按 hunk 拆分提交（保留非 Slice2 代码）

- `apps/web/src/main.ts`
- `apps/web/src/stores/featureFlags.ts`

## 3) 本次 Slice2 依赖迁移（必须一并随 PR）

- `packages/core-backend/src/db/migrations/zzzz20260312170000_create_user_session_revocations.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313103000_create_user_invites.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313183000_create_user_sessions.ts`

## 4) 明确排除（不纳入 Slice2）

### 当前明确排除目录/文件
- 考勤线：`apps/web/src/views/Attendance*`、`apps/web/tests/*Attendance*`、`docs/attendance*`、`reports/ATTENDANCE_*`、`scripts/ops/*attendance*`
- PLM / Workflow 业务：`packages/core-backend/src/plm/*`、`packages/core-backend/src/workflow/*`、`apps/web/src/views/plm*`、`apps/web/src/views/workflow*`、`docs/development/platform-slice*` 中非 IAM 线
- 产物与日志：`artifacts/*`、`results/*`、`output/*`、`final-artifacts/*`、`cache-reports/*`
- 插件 `node_modules` 及其自动生成变更：`plugins/*/node_modules/*`
- `apps/web/src/views/LoginView.vue`（本地为重建版本，需单独确认是否与主线一致后再决定是否入库）

## 5) 立即打包命令（严格按清单）

```bash
# 1) 仅加入全文件项
git add apps/web/src/views/AcceptInviteView.vue \
  apps/web/src/views/AdminAuditView.vue \
  apps/web/src/views/PermissionManagementView.vue \
  apps/web/src/views/RoleManagementView.vue \
  apps/web/src/views/SessionCenterView.vue \
  apps/web/src/views/UserManagementView.vue \
  apps/web/tests/featureFlags.spec.ts \
  packages/core-backend/src/auth/access-presets.ts \
  packages/core-backend/src/auth/invite-ledger.ts \
  packages/core-backend/src/auth/invite-tokens.ts \
  packages/core-backend/src/auth/password-policy.ts \
  packages/core-backend/src/auth/permission-templates.ts \
  packages/core-backend/src/auth/session-registry.ts \
  packages/core-backend/src/auth/session-revocation.ts \
  packages/core-backend/src/db/migrations/zzzz20260312170000_create_user_session_revocations.ts \
  packages/core-backend/src/db/migrations/zzzz20260313103000_create_user_invites.ts \
  packages/core-backend/src/db/migrations/zzzz20260313183000_create_user_sessions.ts \
  packages/core-backend/src/routes/admin-users.ts \
  packages/core-backend/tests/unit/admin-users-routes.test.ts \
  packages/core-backend/tests/unit/auth-invite-routes.test.ts \
  packages/core-backend/tests/unit/auth-login-routes.test.ts \
  packages/core-backend/tests/unit/jwt-middleware.test.ts \
  packages/core-backend/tests/unit/permissions-routes.test.ts \
  packages/core-backend/tests/unit/roles-routes.test.ts

# 2) 只保留 Slice2 相关改动
git add apps/web/src/main.ts apps/web/src/stores/featureFlags.ts -p
```

## 6) 本次重跑验证命令（已通过）

```bash
pnpm --filter @metasheet/core-backend run test:unit \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/auth-invite-routes.test.ts \
  tests/unit/jwt-middleware.test.ts \
  tests/unit/permissions-routes.test.ts \
  tests/unit/roles-routes.test.ts

pnpm --filter @metasheet/core-backend run build
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

验证结果：后端新增/变更 6 个 IAM 单测文件通过（42/42），`core-backend build` 通过，`web vue-tsc` 通过。
