# DingTalk Runtime Contract Follow-ups Design

日期：2026-03-31

## 目标

把已经通过验收的 DingTalk OAuth / directory 运行时代码，补成一条独立的“合同与验证” follow-up slice：

- 前端定向测试
- 后端定向测试
- OpenAPI 契约
- OAuth / directory smoke 脚本

本轮不改运行时代码，不再扩产品范围，只把既有能力的合同面和验证面补齐。

## 范围

### 前端测试

- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/dingtalkAuthCallbackView.spec.ts`
- `apps/web/tests/directoryManagementView.spec.ts`

### 后端测试

- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `packages/core-backend/tests/unit/directory-sync.test.ts`

### OpenAPI

- `packages/openapi/src/paths/auth.yml`
- `packages/openapi/src/admin-directory.yml`

### Smoke

- `scripts/dingtalk-oauth-smoke.mjs`
- `scripts/dingtalk-directory-smoke.mjs`

## 设计原则

### 1. 运行时代码仍是事实源

这条 slice 只补“围绕 runtime 的合同与验证”，不再修改：

- `packages/core-backend/src/**`
- `apps/web/src/**`

测试、OpenAPI 和 smoke 必须去追现有 runtime，而不是反过来驱动 runtime 变更。

### 2. OAuth 与 directory 分成两条合同面，但一次收口

这 10 个文件都落在同一条 DingTalk 能力线上：

- OAuth 登录闭环
- directory 管理与同步闭环

把它们一次提交，比拆成更小碎片更符合当前 dirty tree 的真实形态。

### 3. smoke 只证明 reachability 和基本语义

本轮 smoke 不负责完整业务验收，只验证：

- OAuth launch 可达
- OAuth callback 缺参 / 错 state 的错误语义
- directory admin 三个只读端点的 reachability

这样 smoke 脚本能直接为 on-prem rollout 复用，而不会混入 UI 逻辑。

## 预期结果

收口后，这条 follow-up slice 应满足：

- OpenAPI 与 runtime 契约一致
- 后端 DingTalk 相关单测稳定通过
- 前端 DingTalk 相关单测稳定通过
- OAuth / directory smoke 脚本可直接用于部署验证

## 非目标

- 不实现新的 DingTalk 业务能力
- 不修改 OAuth / directory 运行时代码
- 不处理 `.claude/**`、`output/**` 等生成物噪声
- 不替代后续 `repo-baseline-reconciliation` 的其他 candidate groups

## 结论

这条 slice 的本质不是“新功能”，而是把已验收的 DingTalk 能力补成可提交、可复跑、可部署复验的正式合同层。
