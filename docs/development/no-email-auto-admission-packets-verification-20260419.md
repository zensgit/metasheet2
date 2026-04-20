# 无邮箱自动准入临时凭据验证说明 2026-04-19

## 验证范围

- 无邮箱自动准入用户名生成逻辑
- 目录同步路由透传 onboarding packet
- 目录同步页展示无邮箱自动准入临时凭据
- 前后端构建通过

## 执行命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/directory-sync-auto-admission.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vitest run \
  tests/directoryManagementView.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## 结果

### 后端测试

- `directory-sync-auto-admission.test.ts`
- `admin-directory-routes.test.ts`
- `directory-sync-bind-account.test.ts`

结果：

- `3 files passed`
- `32 tests passed`

新增覆盖点：

- 无邮箱自动准入用户名稳定生成
- sync 路由返回 `autoAdmissionOnboardingPackets`

### 前端测试

- `directoryManagementView.spec.ts`

结果：

- `1 file passed`
- `33 tests passed`

新增覆盖点：

- 手动同步完成后显示“本次自动准入临时凭据”
- 无邮箱自动准入结果展示：
  - 登录账号
  - 临时密码
  - 无邀请链接提示

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
- 本轮没有新增数据库迁移
