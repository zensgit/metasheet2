# DingTalk Ops Hardening Repair Claude Task Pack

日期：2026-03-30

## 背景

上一轮 `dingtalk-ops-hardening` 交付未通过 Codex 独立验收。

阻塞点已经在下列文档中固定下来，Claude Code 本轮必须以这些发现为真相源，不得绕开：

- 验证结论：`docs/development/dingtalk-ops-hardening-verification-20260330.md`
- 重点阻塞：
  1. 运行时代码、部署 DDL、文档 schema 不一致
  2. 后端 JSON shape、前端读取 shape、OpenAPI shape 不一致
  3. 前端已接 `POST /api/auth/dingtalk/callback`，后端未实现
  4. 上一轮隐性越界修改了入口文件

## 本轮目标

本轮是 **repair-only slice**。

只允许修复上述 4 个阻塞点，不允许扩功能，不允许顺手优化无关页面，不允许继续加新的运营能力。

## 交付范围

### Lane A：后端 / 契约 / schema 对齐

允许写入：

- `packages/core-backend/src/auth/**`
- `packages/core-backend/src/directory/**`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/tests/unit/**`

目标：

- 统一 `directory_sync_status`、`directory_sync_history`、`deprovision_ledger` 的运行时 schema 假设
- 统一列表接口与状态接口的真实 JSON shape
- 补齐或回退 DingTalk callback 后端闭环
- 若必须修改路由注册，显式只限 `src/index.ts`

### Lane B：前端 / 回调页 / 目录页契约修复

允许写入：

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`
- `apps/web/src/main.ts`
- `apps/web/tests/**`

目标：

- 目录管理页按后端真实 shape 读取数据
- 同步状态字段命名与后端保持一致
- DingTalk callback 页与后端实际能力保持一致
- 若必须修改路由注册，显式只限 `src/main.ts`

### Lane C：OpenAPI / 脚本 / 部署文档

允许写入：

- `packages/openapi/src/**`
- `scripts/dingtalk-*.mjs`
- `scripts/openapi-check.mjs`
- `docs/development/**`
- `docs/deployment/**`

目标：

- OpenAPI 与后端真实返回值一致
- smoke 帮助信息与实际端点一致
- 部署文档中的 DDL 与代码真实 schema 一致
- 设计 / 验证 / 部署文档回填到 repair 口径

## 明确禁止

本轮 Claude Code 不允许写入：

- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`
- `output/**`
- `plugins/**/node_modules/**`
- `packages/openapi/dist/**`
- `apps/web/src/views/Attendance*.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/LoginView.vue`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/workflow*.ts`
- `packages/core-backend/src/routes/kanban.ts`
- `packages/core-backend/src/routes/snapshot*.ts`
- `packages/core-backend/src/routes/attendance-*.ts`

## 修复要求

### 1. schema 必须统一

Claude Code 必须选择一套 canonical schema，并把它同步到：

- 运行时代码
- 部署 DDL / 部署文档
- 相关测试假设

禁止保留“代码一套、DDL 一套、fallback 再兜底”的状态。

### 2. JSON shape 必须统一

Claude Code 必须选择一套 canonical response shape，并把它同步到：

- `packages/core-backend/src/routes/admin-directory.ts`
- `apps/web/src/views/DirectoryManagementView.vue`
- `packages/openapi/src/**`
- 相关单测 mock / 断言

禁止继续出现：

- 后端 `data: []`
- 前端读 `data.items`
- OpenAPI 写 `data.list`

这种三方断层。

### 3. DingTalk callback 必须闭环

这项只允许二选一：

1. 真正补齐后端 `POST /api/auth/dingtalk/callback`，并让前端接线真实可用
2. 如果本轮无法安全补齐后端，则回退前端占位接线，并在文档中明确暂缓

禁止继续保留“前端已接，后端不存在”的半成品状态。

### 4. 边界必须显式

上一轮实际改了：

- `apps/web/src/main.ts`
- `packages/core-backend/src/index.ts`

本轮这两个文件已经被显式纳入允许范围。除此之外，不得再出现新的隐性越界。

## 停止条件

如果修复过程中发现必须改动以下路径才能闭环，本轮应停止并把它作为 blocker 回报，不允许擅自继续扩边界：

- `apps/web/src/views/Attendance*.vue`
- `apps/web/src/views/UserManagementView.vue`
- `packages/core-backend/src/routes/admin-users.ts`
- 任意 `scripts/ops/git-*`

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

## 构建失败判定

`pnpm --filter @metasheet/web build` 只有在仍然是下列 **同一个预存错误** 时才允许报告为“预存失败”：

```text
src/views/AttendanceView.vue(3394,59): error TS2307: Cannot find module '../utils/timezones'
```

如果出现任何新增错误，本轮视为未通过。

## 必交付内容

Claude Code 回传时必须包含：

- 改动文件列表
- 实际执行命令及通过 / 失败
- 本轮选定的 canonical schema 决策
- 本轮选定的 canonical JSON shape 决策
- DingTalk callback 处理方式：实现或回退
- 未解决风险
- 设计 / 验证 / 部署文档列表

## Codex 验收重点

Codex 会独立复核：

- schema 是否真的统一到一套
- 后端 / 前端 / OpenAPI 是否真的用同一 shape
- callback 是否真的闭环，而不是只改文案
- `main.ts` / `index.ts` 之外是否再次越界
- 既有预存 web build 失败是否保持原样，没有掺入新错误

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-ops-hardening-repair" task pack in /Users/huazhou/Downloads/Github/metasheet2.

This is a repair-only slice. Do not add new product capability. Only fix the blocked handoff from docs/development/dingtalk-ops-hardening-verification-20260330.md.

Write boundary:
- packages/core-backend/src/auth/**
- packages/core-backend/src/directory/**
- packages/core-backend/src/routes/admin-directory.ts
- packages/core-backend/src/routes/auth.ts
- packages/core-backend/src/utils/error.ts
- packages/core-backend/src/index.ts
- packages/core-backend/tests/unit/**
- apps/web/src/views/DirectoryManagementView.vue
- apps/web/src/views/DingTalkAuthCallbackView.vue
- apps/web/src/main.ts
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
- packages/openapi/dist/**
- apps/web/src/views/Attendance*.vue
- apps/web/src/views/UserManagementView.vue
- apps/web/src/views/SessionCenterView.vue
- apps/web/src/views/LoginView.vue
- packages/core-backend/src/routes/admin-users.ts
- attendance/workflow/kanban/snapshot feature files outside the paths above

Repair goals:
1. unify runtime schema assumptions, deployment DDL, and tests for directory_sync_status, directory_sync_history, and deprovision_ledger
2. unify backend response shape, frontend read shape, and OpenAPI shape for admin directory sync/status/history/deprovision data
3. either implement POST /api/auth/dingtalk/callback on the backend or roll back the frontend placeholder hookup; do not leave a half-wired flow
4. keep route-registration edits explicit and limited to src/index.ts and src/main.ts only if necessary

Required commands:
- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts
- pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts
- pnpm --filter @metasheet/web exec vue-tsc --noEmit
- pnpm --filter @metasheet/core-backend build
- pnpm --filter @metasheet/web build
- node scripts/openapi-check.mjs
- node scripts/dingtalk-directory-smoke.mjs --help

Acceptable web build exception:
- only the exact pre-existing AttendanceView.vue -> ../utils/timezones error

Return:
- changed files
- commands run with pass/fail
- chosen canonical schema
- chosen canonical JSON shape
- whether DingTalk callback was implemented or rolled back
- unresolved risks
- design/verification/deployment docs added
```
