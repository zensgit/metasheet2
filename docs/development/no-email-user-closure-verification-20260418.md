# 无邮箱用户闭环验证说明 2026-04-18

## 验证范围

- 登录支持 `identifier`
- 管理员可创建无邮箱用户
- 目录手动准入可创建无邮箱用户并绑定
- onboarding 文案在无邮箱场景不再依赖 invite link
- 前后端构建通过

## 执行命令

```bash
pnpm install --frozen-lockfile

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/AuthService.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vitest run \
  tests/LoginView.spec.ts \
  tests/userManagementView.spec.ts \
  tests/directoryManagementView.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## 结果

### 后端测试

- `AuthService.test.ts`
- `auth-login-routes.test.ts`
- `admin-users-routes.test.ts`
- `admin-directory-routes.test.ts`
- `directory-sync-bind-account.test.ts`

结果：

- `5 files passed`
- `132 tests passed`

### 前端测试

- `LoginView.spec.ts`
- `userManagementView.spec.ts`
- `directoryManagementView.spec.ts`

结果：

- `3 files passed`
- `49 tests passed`

新增覆盖点：

- 登录页提交 `identifier`
- 用户管理页无邮箱创建用户
- 目录治理页无邮箱手动准入创建并绑定

### 构建

- `pnpm --filter @metasheet/core-backend build`：通过
- `pnpm --filter @metasheet/web build`：通过

## 备注

- 前端测试环境仍会打印既有噪音：
  - `WebSocket server error: Port is already in use`
- 前端构建仍会打印既有 Vite chunk-size warning
- 以上均不影响本轮结论

## 部署内容

- 本轮未做远端部署
- 本轮新增数据库迁移：
  - `zzzz20260418170000_allow_no_email_users_and_add_username.ts`
