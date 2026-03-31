# DingTalk OAuth Backend Repair-1 Claude Task Pack

日期：2026-03-30

## 目标

只修 `dingtalk-oauth-backend` 当前独立验收里的 3 个阻塞点，不扩范围：

1. OAuth `state` 生成、持久化和校验
2. `jwt-middleware.ts` 的边界合法化或同等效果的收口
3. 部署文档里的 OAuth 专用自动验证命令

本轮是 **repair-only**，不允许顺手扩功能。

## 当前阻塞

以 [dingtalk-oauth-backend-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-oauth-backend-verification-20260330.md) 的 Codex 独立验收为准，当前 blocker 是：

- `state` 只生成和透传，没有任何持久化或校验
- [jwt-middleware.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/jwt-middleware.ts) 实际被改动，但不在上轮写边界
- 部署文档引用了 [dingtalk-directory-smoke.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/dingtalk-directory-smoke.mjs)，它验证的是目录接口，不是 OAuth

## 允许写入

- `packages/core-backend/src/auth/dingtalk-oauth.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`
- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/dingtalkAuthCallbackView.spec.ts`
- `packages/openapi/src/paths/auth.yml`
- `scripts/dingtalk-oauth-*.mjs`
- `docs/development/dingtalk-oauth-backend-design-20260330.md`
- `docs/development/dingtalk-oauth-backend-verification-20260330.md`
- `docs/deployment/dingtalk-oauth-backend-deploy-20260330.md`
- `docs/verification-index.md`

## 明确禁止

本轮不允许修改：

- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/directory/**`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/Attendance*.vue`
- `scripts/dingtalk-directory-smoke.mjs`
- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`
- `output/**`

## 必做项

### 1. OAuth state

必须把 `state` 做成真实防护，不接受继续“只透传”。

最低要求：

- launch 端生成 `state`
- 前端可带着它完成回调
- callback 端必须校验 `state`
- 缺失 / 不匹配 / 过期时返回明确错误

实现方式可以自行选择，但必须满足：

- 不依赖目录功能或管理员功能
- 不引入新的重型基础设施依赖
- 文档必须说明存储介质和过期策略

### 2. jwt middleware 边界收口

这次允许合法修改 [jwt-middleware.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/jwt-middleware.ts)，但必须保持最小改动，只为 DingTalk OAuth 开放必要白名单，不准顺手改别的 auth 逻辑。

### 3. OAuth 专用验证命令

部署文档中的“自动验证”必须改成真正覆盖 OAuth 的命令或脚本。

可接受两种方案：

- 新增 `scripts/dingtalk-oauth-smoke.mjs`
- 或部署文档使用明确的 `curl` / `node` 验证命令

但结果必须直接验证：

- `/api/auth/dingtalk/launch`
- callback 缺参数或 state 错误的失败路径

## 设计约束

- 运行时代码仍然是事实源
- 不准新增目录/运营/admin 功能
- 不准新增第二套登录态写入机制
- OpenAPI 必须和最终运行时一致
- 设计/验证/部署文档必须真实回填，不能再写“待后续补齐”

## 必跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```

如果新增了 OAuth smoke 脚本，也必须执行：

```bash
node scripts/dingtalk-oauth-smoke.mjs --help
```

说明：

- `pnpm --filter @metasheet/web build` 若失败，只允许出现一个已知预存错误：
  - [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue#L3394) 缺失 `../utils/timezones`
- 出现任何新增 build 错误都算不通过。

## 交付物格式

Claude Code 回传时必须包含：

- 改动文件列表
- 实际执行命令及通过 / 失败
- `state` 的最终存储 / 校验方案
- `jwt-middleware.ts` 为何仍需改动
- OAuth 自动验证命令或脚本路径
- 未解决风险

## Codex 独立验收标准

我会独立复核：

- 是否只改了 repair 边界内文件
- `state` 是否真实校验，不是表面透传
- 缺失 / 错误 `state` 是否有测试覆盖
- `jwt-middleware.ts` 是否只是最小白名单改动
- 部署文档里的自动验证是否真的验证 OAuth
- OpenAPI 和运行时是否一致

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-oauth-backend-repair1" task pack in /Users/huazhou/Downloads/Github/metasheet2.

This is repair-only. Do not expand product scope.

Write boundary:
- packages/core-backend/src/auth/dingtalk-oauth.ts
- packages/core-backend/src/auth/jwt-middleware.ts
- packages/core-backend/src/routes/auth.ts
- packages/core-backend/tests/unit/auth-login-routes.test.ts
- apps/web/src/views/LoginView.vue
- apps/web/src/views/DingTalkAuthCallbackView.vue
- apps/web/tests/loginView.spec.ts
- apps/web/tests/dingtalkAuthCallbackView.spec.ts
- packages/openapi/src/paths/auth.yml
- scripts/dingtalk-oauth-*.mjs
- docs/development/dingtalk-oauth-backend-design-20260330.md
- docs/development/dingtalk-oauth-backend-verification-20260330.md
- docs/deployment/dingtalk-oauth-backend-deploy-20260330.md
- docs/verification-index.md

Do not modify:
- packages/core-backend/src/routes/admin-directory.ts
- packages/core-backend/src/routes/admin-users.ts
- packages/core-backend/src/directory/**
- apps/web/src/views/DirectoryManagementView.vue
- apps/web/src/views/UserManagementView.vue
- apps/web/src/views/SessionCenterView.vue
- apps/web/src/views/Attendance*.vue
- scripts/dingtalk-directory-smoke.mjs
- scripts/ops/git-*
- scripts/ops/*remote-git-slice*
- output/**

Goals:
1. implement real OAuth state generation, persistence, and validation
2. keep jwt-middleware changes minimal and explicitly justified
3. replace the deployment doc's wrong directory smoke reference with OAuth-specific validation

Constraints:
- no new admin/directory/ops features
- runtime code is the source of truth
- callback must reject missing, mismatched, or expired state
- tests must cover success + missing state + bad state
- docs must describe the state storage medium and expiry policy

Required commands:
- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
- pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
- pnpm --filter @metasheet/web exec vue-tsc --noEmit
- pnpm --filter @metasheet/core-backend build
- pnpm --filter @metasheet/web build
- node scripts/openapi-check.mjs

If you add an OAuth smoke script, also run:
- node scripts/dingtalk-oauth-smoke.mjs --help

If web build fails, the only acceptable pre-existing failure is AttendanceView.vue importing ../utils/timezones. Any new build failure is a regression.

Return:
- changed files
- commands run with pass/fail
- final state storage/validation design
- why jwt-middleware still needs modification
- OAuth validation command/script path
- unresolved risks
```
