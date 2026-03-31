# DingTalk Ops Hardening Claude Task Pack

日期：2026-03-30

## 目标

把当前 DingTalk 目录 / 登录链路从“功能可用”继续推进到“运营闭环更强、可审计、可告警、可回滚”。

本轮不再扩 Git 工具链；重点是产品和运营能力硬化。

## 交付范围

Claude Code 本轮只允许做 `dingtalk-ops-hardening`，目标拆成 3 个 lane。

### Lane A：后端 / 数据 / 路由

允许写入：

- `packages/core-backend/src/auth/**`
- `packages/core-backend/src/directory/**`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/core-backend/tests/unit/**`

目标：

- 定时同步失败告警状态补齐管理员可见接口
- 离职策略执行审计与回滚接口补齐
- 待审核用户批量处理写入服务端审计记录

### Lane B：前端 / 管理台 / 运营界面

允许写入：

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/composables/**`
- `apps/web/src/stores/**`
- `apps/web/tests/**`

目标：

- 目录管理页新增“计划同步与告警”可操作区
- 增加离职审计 / 回滚入口
- 增加待审核批量处理的服务端审计可视反馈

### Lane C：契约 / 脚本 / 文档

允许写入：

- `packages/openapi/src/**`
- `scripts/dingtalk-*.mjs`
- `scripts/openapi-check.mjs`
- `docs/development/**`
- `docs/deployment/**`

目标：

- OpenAPI 补齐新增接口
- smoke / preflight 脚本覆盖告警与回滚链路
- 设计 / 验证 / 部署文档同步回填

## 明确禁止

本轮 Claude Code 不允许写入：

- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`
- `output/**`
- `plugins/**/node_modules/**`
- `packages/openapi/dist/**`
- `apps/web/src/views/Attendance*.vue`
- `packages/core-backend/src/routes/attendance-*.ts`
- `packages/core-backend/src/routes/workflow*.ts`
- `packages/core-backend/src/routes/kanban.ts`
- `packages/core-backend/src/routes/snapshot*.ts`

## 必做项

Claude Code 必须完成：

1. 代码实现
2. 单测补齐
3. OpenAPI / 脚本文档补齐
4. 本地验证命令执行
5. 输出未完成风险

## 必跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
node scripts/dingtalk-directory-smoke.mjs --help
```

## 交付物格式

Claude Code 回传时必须包含：

- 改动文件列表
- 实际执行命令及通过 / 失败
- 未解决风险
- 设计 / 验证 / 部署文档列表

## Codex 验收标准

我会独立复核：

- 是否越界改动
- 是否误碰其他 dirty 业务线
- 测试是否真的覆盖目标
- OpenAPI / smoke / 文档是否补齐
- 若涉及远端，是否能在目标 on-prem 主机上复核结果

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-ops-hardening" task pack in /Users/huazhou/Downloads/Github/metasheet2.

Write boundary:
- packages/core-backend/src/auth/**
- packages/core-backend/src/directory/**
- packages/core-backend/src/routes/admin-directory.ts
- packages/core-backend/src/routes/admin-users.ts
- packages/core-backend/src/routes/auth.ts
- packages/core-backend/src/utils/error.ts
- packages/core-backend/tests/unit/**
- apps/web/src/views/DirectoryManagementView.vue
- apps/web/src/views/DingTalkAuthCallbackView.vue
- apps/web/src/views/LoginView.vue
- apps/web/src/views/SessionCenterView.vue
- apps/web/src/views/UserManagementView.vue
- apps/web/src/composables/**
- apps/web/src/stores/**
- apps/web/tests/**
- packages/openapi/src/**
- scripts/dingtalk-*.mjs
- scripts/openapi-check.mjs
- docs/development/**
- docs/deployment/**

Do not modify:
- scripts/ops/git-*
- scripts/ops/*remote-git-slice*
- output/**
- plugins/**/node_modules/**
- packages/openapi/dist/**
- attendance/workflow/kanban/snapshot feature files outside the paths above

Goals:
1. add admin-visible scheduled-sync alert state and acknowledgement surfaces
2. add deprovision audit + rollback capability
3. add server-side audit trail for pending-user batch actions
4. update OpenAPI, smoke/preflight scripts, and docs

Required commands:
- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts
- pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts
- pnpm --filter @metasheet/web exec vue-tsc --noEmit
- pnpm --filter @metasheet/core-backend build
- pnpm --filter @metasheet/web build
- node scripts/openapi-check.mjs
- node scripts/dingtalk-directory-smoke.mjs --help

Return:
- changed files
- commands run with pass/fail
- unresolved risks
- design/verification/deployment docs added
```
