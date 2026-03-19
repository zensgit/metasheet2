# IAM Final PR Draft

Date: 2026-03-19
Repository: `metasheet2`

## Recommended PR Title

```text
feat(iam): close runtime, auth-session, and contract gaps
```

## Pull Request Body

### 目的

- 完成 IAM 收尾，补齐后端运行时挂载、视图路由鉴权、表级 RBAC、auth/session/permissions OpenAPI 契约和缺失测试覆盖。
- 统一前后端 IAM 相关错误提取、会话解析和登录跳转行为。
- 修复前端角色管理页面的成功状态回归，并恢复当前 worktree 的前端生产构建可通过状态。

### 变更内容

- 后端挂载 `adminUsersRouter()`，使 IAM 用户、会话、审计相关接口在运行时真正暴露。
- 后端新增共享错误提取 helper，并应用到 IAM/admin 路由，统一嵌套错误消息返回。
- 视图路由新增认证与表级 RBAC 校验，补齐 `/api/views/*` 的 `401`、`403`、`404` 行为。
- 清理 `/api/admin/roles` 的重复 `GET` 路由，保留 admin 写别名，避免 IAM 角色目录接口冲突。
- 补齐 `admin-users.yml`、`auth.yml`、`permissions.yml`、`roles.yml`、`views.yml`、`base.yml`，并更新 OpenAPI 校验逻辑与生成产物。
- 前端新增共享 helper，统一处理 API 错误提取、登录后安全跳转和用户会话记录解析。
- 前端覆盖并修正的 IAM 视图包括登录、邀请接受、管理审计、权限管理、角色管理、会话中心和用户管理。
- 新增/扩展后端 IAM 单测与前端 IAM 视图/helper 单测。
- 修复 `RoleManagementView` 创建角色成功提示错误。
- 修复 `AttendanceView` 的语法回归，恢复 `pnpm --filter @metasheet/web build` 可通过。

### 验证

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/jwt-middleware.test.ts tests/unit/permissions-routes.test.ts tests/unit/roles-routes.test.ts tests/unit/views-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm openapi:check`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web exec vitest run tests/acceptInviteView.spec.ts tests/adminAuditView.spec.ts tests/loginView.spec.ts tests/permissionManagementView.spec.ts tests/roleManagementView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts tests/utils/error.spec.ts tests/utils/navigation.spec.ts tests/utils/session.spec.ts tests/featureFlags.spec.ts tests/useAuth.spec.ts`
- `pnpm --filter @metasheet/web build`
- `pnpm validate:plugins`

验证结果：

- 后端 IAM 单测：`102/102`
- 前端 IAM 合并回归：`59/59`
- 插件清单校验：`11` valid，`0` invalid，`9` warnings

补充说明：

- 根级 `pnpm lint` / `pnpm type-check` 当前为仓库空门禁，已在 IAM 验证报告中记录，不作为有效质量结论。

### 风险与回滚

- 风险主要集中在路由鉴权行为变化和 OpenAPI 契约扩展；对应风险已由定向后端/前端测试覆盖。
- `AttendanceView` 的修复属于构建恢复，不改变 IAM 业务逻辑，但建议作为单独提交审阅。
- 回滚方式：
  - 回滚 IAM 运行时、RBAC、OpenAPI 与测试文件
  - 如需保留构建恢复，可仅保留 `AttendanceView.vue` 修复提交

### 清单

- [x] 单一关注点范围已整理
- [x] 文档已更新
- [x] 关键构建与定向测试已通过
- [x] OpenAPI 已重生成并校验
- [x] 插件清单已校验

## Suggested Commit Commands

### Commit 1: IAM主体

```bash
git add \
  apps/web/src/main.ts \
  apps/web/src/stores/featureFlags.ts \
  apps/web/src/views/AcceptInviteView.vue \
  apps/web/src/views/AdminAuditView.vue \
  apps/web/src/views/LoginView.vue \
  apps/web/src/views/PermissionManagementView.vue \
  apps/web/src/views/RoleManagementView.vue \
  apps/web/src/views/SessionCenterView.vue \
  apps/web/src/views/UserManagementView.vue \
  apps/web/src/utils/error.ts \
  apps/web/src/utils/navigation.ts \
  apps/web/src/utils/session.ts \
  apps/web/tests/acceptInviteView.spec.ts \
  apps/web/tests/adminAuditView.spec.ts \
  apps/web/tests/loginView.spec.ts \
  apps/web/tests/permissionManagementView.spec.ts \
  apps/web/tests/roleManagementView.spec.ts \
  apps/web/tests/sessionCenterView.spec.ts \
  apps/web/tests/userManagementView.spec.ts \
  apps/web/tests/utils/error.spec.ts \
  apps/web/tests/utils/navigation.spec.ts \
  apps/web/tests/utils/session.spec.ts \
  packages/core-backend/src/index.ts \
  packages/core-backend/src/routes/admin-routes.ts \
  packages/core-backend/src/routes/admin-users.ts \
  packages/core-backend/src/routes/roles.ts \
  packages/core-backend/src/routes/views.ts \
  packages/core-backend/src/utils/error.ts \
  packages/core-backend/tests/unit/admin-users-routes.test.ts \
  packages/core-backend/tests/unit/roles-routes.test.ts \
  packages/core-backend/tests/unit/views-routes.test.ts \
  packages/openapi/src/base.yml \
  packages/openapi/src/paths/admin-users.yml \
  packages/openapi/src/paths/auth.yml \
  packages/openapi/src/paths/permissions.yml \
  packages/openapi/src/paths/roles.yml \
  packages/openapi/src/paths/views.yml \
  packages/openapi/tools/validate.ts \
  packages/openapi/dist/combined.openapi.yml \
  packages/openapi/dist/openapi.json \
  packages/openapi/dist/openapi.yaml \
  docs/development/iam-final-development-report-20260319.md \
  docs/development/iam-final-verification-report-20260319.md \
  docs/development/iam-final-closure-report-20260319.md \
  docs/development/iam-final-merge-handoff-20260319.md \
  docs/development/iam-final-pr-draft-20260319.md

git commit -m "feat(iam): close runtime, auth-session, and contract gaps"
```

### Commit 2: 前端构建恢复

```bash
git add apps/web/src/views/AttendanceView.vue

git commit -m "fix(web): repair attendance view syntax regression"
```

## Review Focus

- `packages/core-backend/src/routes/views.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/openapi/src/paths/auth.yml`
- `packages/openapi/src/paths/permissions.yml`
- `packages/core-backend/src/routes/roles.ts`
- `packages/openapi/src/paths/admin-users.yml`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/RoleManagementView.vue`
- `apps/web/src/views/AttendanceView.vue`
