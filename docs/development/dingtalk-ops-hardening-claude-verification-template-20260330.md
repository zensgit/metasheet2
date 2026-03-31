# DingTalk Ops Hardening Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 执行完成后做独立验收时使用。

## 必核项

### 1. 写边界

- 是否只改了允许路径
- 是否误碰 `scripts/ops/git-*`
- 是否误碰 attendance / workflow / kanban / snapshot 业务线

### 2. 后端

- 告警状态接口是否存在且有测试
- 离职审计 / 回滚接口是否存在且有测试
- 批量处理审计记录是否真正落到服务端持久层

### 3. 前端

- 目录管理页是否真的展示服务端数据
- 操作按钮是否受权限和状态控制
- 失败态 / 空态 / 成功态是否可见

### 4. 契约 / 脚本 / 文档

- OpenAPI 是否同步
- smoke / preflight 是否新增对应验证
- 设计 / 验证 / 部署文档是否回填

### 5. 独立复跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```
