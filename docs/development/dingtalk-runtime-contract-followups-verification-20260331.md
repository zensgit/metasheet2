# DingTalk Runtime Contract Follow-ups Verification

日期：2026-03-31

## 范围

验证 DingTalk 合同与验证 follow-up slice 是否满足：

- 后端定向测试通过
- 前端定向测试通过
- OpenAPI 校验通过
- OAuth / directory smoke 脚本可执行并输出正确帮助信息

## 实际命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/directory-sync.test.ts

pnpm --filter @metasheet/web exec vitest run \
  tests/dingtalkAuthCallbackView.spec.ts \
  tests/directoryManagementView.spec.ts \
  tests/loginView.spec.ts

node scripts/openapi-check.mjs
node scripts/dingtalk-directory-smoke.mjs --help
node scripts/dingtalk-oauth-smoke.mjs --help
```

## 实际结果

### 1. 后端定向测试

- 命令：`pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/auth-login-routes.test.ts tests/unit/directory-sync.test.ts`
- 结果：通过
- 汇总：
  - `3` 个测试文件
  - `77` 项测试通过

### 2. 前端定向测试

- 命令：`pnpm --filter @metasheet/web exec vitest run tests/dingtalkAuthCallbackView.spec.ts tests/directoryManagementView.spec.ts tests/loginView.spec.ts`
- 结果：通过
- 汇总：
  - `3` 个测试文件
  - `16` 项测试通过

### 3. OpenAPI 校验

- 命令：`node scripts/openapi-check.mjs`
- 结果：通过
- 汇总：
  - `3` 个文件
  - `32` 条路径
  - `0` 个问题

### 4. smoke 脚本

- 命令：`node scripts/dingtalk-directory-smoke.mjs --help`
  - 结果：通过
  - 覆盖：
    - `/api/admin/directory/sync/status`
    - `/api/admin/directory/sync/history`
    - `/api/admin/directory/deprovisions`
- 命令：`node scripts/dingtalk-oauth-smoke.mjs --help`
  - 结果：通过
  - 覆盖：
    - `GET /api/auth/dingtalk/launch`
    - `POST /api/auth/dingtalk/callback` 缺 `code`
    - `POST /api/auth/dingtalk/callback` 错 `state`

## 结论

这条 follow-up slice 已满足“合同与验证层收口”的目标：

- DingTalk OAuth 测试、OpenAPI、smoke 已对齐
- directory 测试、OpenAPI、smoke 已对齐
- 本轮没有引入新的运行时代码改动

下一步应继续按 `repo-baseline-reconciliation` 的候选组顺序，处理：

1. `generated-artifacts-and-vendor-churn`
2. `claude-task-pack-archives`
3. 其余 DingTalk rollout 文档 backlog
