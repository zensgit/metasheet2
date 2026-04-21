# 无邮箱用户闭环总包验证说明 2026-04-19

## 验证范围

- 登录支持统一账号标识
- 管理员可创建无邮箱用户
- 目录手动准入可创建无邮箱用户并绑定
- 自动准入命中的无邮箱成员可返回临时凭据包
- 目录同步页可展示自动准入临时凭据
- 前后端构建通过

## 执行命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/AuthService.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  tests/unit/directory-sync-auto-admission.test.ts \
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

- `6 files passed`
- `137 tests passed`

覆盖重点：

- identifier 登录
- 无邮箱用户创建
- 无邮箱目录手动准入
- 无邮箱自动准入用户名生成
- sync 路由返回 `autoAdmissionOnboardingPackets`

### 前端测试

- `3 files passed`
- `49 tests passed`

覆盖重点：

- 登录页提交 `identifier`
- 用户管理页无邮箱创建用户
- 目录治理页无邮箱手动准入
- 目录同步完成后展示自动准入临时凭据

### 构建

- `pnpm --filter @metasheet/core-backend build`：通过
- `pnpm --filter @metasheet/web build`：通过

## 备注

- 前端测试环境仍会打印既有噪音：
  - `WebSocket server error: Port is already in use`
- 前端构建仍会打印既有 Vite chunk-size warning
- 后端单测启动时仍会打印既有 `DATABASE_URL not set` warning
- 以上均不影响本轮结论

## 部署内容

- 本轮没有远端部署
- 本轮新增数据库迁移：
  - `zzzz20260418170000_allow_no_email_users_and_add_username.ts`
