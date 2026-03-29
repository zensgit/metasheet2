# DingTalk Directory Featureline Git Slice Design

日期：2026-03-29

## 目标

在当前大面积 dirty worktree 中，把“钉钉登录 + 目录同步 + 管理员目录运营 + 模板中心/预检/部署文档”定义成一条独立业务 slice，作为 `directory-migration-baseline` 之后的下一条正式业务收口线。

这条 slice 的目标不是再次扩写功能，而是先把已经完成的钉钉目录 / IAM 业务能力从混杂工作树里切成：

- 可识别的业务边界
- 可分组的提交序列
- 可单独导出 patch 的交接单元
- 可明确说明当前为什么还不能直接送 GitHub 的范围

## 当前基线事实

复核命令：

```bash
node scripts/ops/git-slice-report.mjs --slice dingtalk-directory-featureline --json
node scripts/ops/git-slice-sync-plan.mjs --slice dingtalk-directory-featureline --patch-file output/git-slices/dingtalk-directory-featureline.patch --json
```

当前状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- upstream：`origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- 这条业务 slice 总规模：`73` 个文件
- 当前仍与 upstream behind 的 IAM 收口提交重叠
- 所以当前 slice 的作用是“确定边界并准备后续 Git 收口”，不是宣称已经与 GitHub 同步

## 设计原则

### 1. 只收真实业务面，不再夹带纯工具链

这条 slice 只覆盖：

- 钉钉 OAuth 登录 / 绑定 / 解绑
- 外部身份与授权开关
- 目录同步与目录账号处理
- 管理员目录入口、目录管理页与用户管理页中的钉钉授权
- OpenAPI / 环境模板 / smoke / preflight
- 对应的设计、验证和部署文档

明确不再收：

- `directory-migration-baseline` 那条 migration / git-tooling / remote deliver 工具链
- EventBus 兼容修复
- attendance 时区、导入、排班等无关业务改动
- `output/` 目录里的交付产物

### 2. 先按业务闭环分组，再考虑 Git 收口顺序

这条 slice 设计成 5 组：

1. `backend-dingtalk-auth`
2. `backend-directory-admin`
3. `frontend-dingtalk-admin`
4. `dingtalk-contracts-and-ops`
5. `dingtalk-rollout-docs`

这样后续无论是 stage、bundle、patch 还是正式提交，都能按真实业务闭环拆开，而不是按“谁先写出来”拆。

### 3. 对 upstream 重叠保持诚实

当前 upstream behind 已经有一条 IAM 收口提交覆盖了这条 slice 的一部分基础路径，包括：

- `apps/web/src/main.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/auth.yml`

所以当前结论必须保持为：

- `safeToStage=false`
- `githubSyncReady=false`

也就是这条业务 slice 已经被定义清楚，但还不能直接走正式 GitHub 提交收口。

## 切片范围

### 1. backend DingTalk auth

覆盖：

- `packages/core-backend/src/auth/dingtalk-auth.ts`
- `packages/core-backend/src/auth/external-auth-grants.ts`
- `packages/core-backend/src/auth/external-identities.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/error-utils.test.ts`
- `packages/core-backend/tests/unit/external-identities.test.ts`

这一组负责：

- 钉钉登录入口与回调
- 绑定 / 解绑
- 外部身份查找与回查
- 授权错误结构化透传
- 未绑定 / 未开通 / 待审核链路

### 2. backend directory admin

覆盖：

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/directory-sync.test.ts`

这一组负责：

- 目录集成创建 / 保存 / 测试 / 同步
- 目录账号审核、开户、关联、授权
- 组合式离职策略
- 模板中心、治理报表、计划同步与告警
- 管理员授权某账号是否允许绑定钉钉登录

### 3. frontend DingTalk admin

覆盖：

- `apps/web/src/App.vue`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/main.ts`
- `apps/web/src/router/types.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/DirectoryManagementView.vue`
- 以及对应前端测试

这一组负责：

- 登录页钉钉入口
- 回调页成功 / 失败 / 待审核提示
- 会话中心绑定管理
- 用户管理页钉钉授权
- `attendance` 模式下的平台管理员目录入口
- 目录管理页的大量运营动作

### 4. contracts and ops

覆盖：

- `.env.example`
- `.env.phase5.template`
- `docker/app.env.example`
- `packages/core-backend/.env.example`
- `packages/core-backend/.env.development.example`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/auth.yml`
- `packages/openapi/src/paths/admin-directory.yml`
- `scripts/dingtalk-auth-preflight.mjs`
- `scripts/dingtalk-directory-smoke.mjs`

这一组负责把业务能力补齐到可部署层：

- 环境变量模板
- OpenAPI 契约
- 部署前 preflight
- 目录 smoke 验证

### 5. rollout docs

覆盖：

- `docs/development/dingtalk-auth-*`
- `docs/development/dingtalk-directory-*`
- `docs/development/dingtalk-unbound-login-review-*`
- `docs/development/attendance-directory-admin-access-*`
- `docs/deployment/dingtalk-auth-*`
- `docs/deployment/dingtalk-directory-*`
- 当前这对 slice 设计 / 验证文档

这一组保留整条业务线的设计、上线、运维、验收与批量运营背景，不再让“代码有、证据散在聊天里”。

## 建议提交顺序

### 提交 1

`feat(auth): add DingTalk login, binding, and external identity support`

### 提交 2

`feat(directory): add DingTalk directory admin and provisioning flows`

### 提交 3

`feat(web): add DingTalk admin, callback, and self-service views`

### 提交 4

`chore(ops): add DingTalk rollout contracts and smoke tooling`

### 提交 5

`docs: record DingTalk auth and directory rollout`

## 当前结论

`dingtalk-directory-featureline` 现在已经被定义成一条独立业务 slice，但当前仍处于：

- 范围清晰
- patch 可导出
- 与 upstream 有重叠
- 尚未 GitHub-ready

所以它是“下一条正式业务收口线”，而不是“已经完成同步”的结论。
