# DingTalk OAuth Backend Claude Task Pack

日期：2026-03-30

## 目标

把当前 DingTalk 登录链路从“前端占位回退”推进到“后端 callback 可用、前端可完成登录闭环、契约与测试同步”。

本轮只做 `dingtalk-oauth-backend`，不扩展目录运营能力，不再碰 Git 工具链。

## 当前事实

- [LoginView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/LoginView.vue) 目前只有邮箱密码登录。
- [DingTalkAuthCallbackView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/DingTalkAuthCallbackView.vue) 目前是“功能尚未开放”的占位页。
- [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 已经存在 `/auth/dingtalk/callback` 前端路由。
- [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml) 目前没有 DingTalk OAuth callback 契约。
- [auth-login-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/auth-login-routes.test.ts) 是本轮后端路由测试主入口。

## 交付范围

Claude Code 本轮只允许实现 DingTalk OAuth callback 闭环。

### 允许写入

- `packages/core-backend/src/auth/**`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`
- `apps/web/src/main.ts`
- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/dingtalkAuthCallbackView.spec.ts`
- `packages/openapi/src/paths/auth.yml`
- `docs/development/**`
- `docs/deployment/**`

### 明确禁止

本轮 Claude Code 不允许写入：

- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/directory/**`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/Attendance*.vue`
- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`
- `output/**`
- `packages/openapi/dist/**`

## 必做项

Claude Code 必须完成：

1. 后端实现 DingTalk callback 所需的 auth 路由和最小服务逻辑。
2. 前端 callback 页面改为真实处理成功 / 失败 / 缺参数场景。
3. 登录页只在后端链路就绪前提下增加 DingTalk 登录入口。
4. 复用现有 `useAuth().setToken()` 与 `primeSession()` 会话路径，不允许发明第二套会话写入逻辑。
5. OpenAPI 补齐 `/api/auth/dingtalk/callback` 以及任何新增 auth 端点。
6. 设计 / 验证 / 部署文档同步回填。

## 设计约束

- 运行时代码是事实源，OpenAPI 和文档必须跟运行时一致。
- 返回 JSON shape 继续沿用现有 auth 端点风格：
  - 成功：`{ success: true, data: { ... } }`
  - 失败：沿用现有 auth 错误风格，不新增独特 envelope
- callback 页面不允许继续调用不存在的后端 API。
- 如果 DingTalk 登录入口需要跳转 URL，必须来自后端可用端点；不要在前端硬编码第三方 OAuth URL 拼装逻辑。
- 若缺少必须的 DingTalk env，后端必须显式返回可诊断错误，前端必须展示可读失败态。

## 目标验收口径

至少覆盖这些用户路径：

1. 登录页点击 DingTalk 登录，进入后端提供的发起链路。
2. callback 成功：
   - 前端拿到 token / user / features
   - `setToken()` 被调用
   - `primeSession()` 被调用
   - 按 redirect 或首页规则完成跳转
3. callback 失败：
   - 缺 code / state
   - 后端返回 4xx / 5xx
   - 用户能看到明确错误并返回登录页

## 必跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```

说明：

- `pnpm --filter @metasheet/web build` 若失败，只允许出现一个已知预存错误：
  - [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue#L3394) 缺失 `../utils/timezones`
- 出现任何新增 build 错误都算不通过。

## 交付物格式

Claude Code 回传时必须包含：

- 改动文件列表
- 实际执行命令及通过 / 失败
- 最终选择的 callback 端点与响应 shape
- 登录页如何发起 DingTalk 登录
- 未解决风险
- 设计 / 验证 / 部署文档列表

## Codex 独立验收标准

我会独立复核：

- 是否只改了允许路径
- 后端 auth 路由是否真实存在并已注册
- callback 页面是否不再调用不存在的 API
- 登录入口与 callback 链路是否一致
- OpenAPI 是否和运行时一致
- 测试是否覆盖成功 / 失败 / 缺参数三类路径
- 是否引入了除 `AttendanceView.vue -> ../utils/timezones` 之外的新 build 错误

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-oauth-backend" task pack in /Users/huazhou/Downloads/Github/metasheet2.

Write boundary:
- packages/core-backend/src/auth/**
- packages/core-backend/src/routes/auth.ts
- packages/core-backend/tests/unit/auth-login-routes.test.ts
- apps/web/src/views/LoginView.vue
- apps/web/src/views/DingTalkAuthCallbackView.vue
- apps/web/src/main.ts
- apps/web/tests/loginView.spec.ts
- apps/web/tests/dingtalkAuthCallbackView.spec.ts
- packages/openapi/src/paths/auth.yml
- docs/development/**
- docs/deployment/**

Do not modify:
- packages/core-backend/src/routes/admin-directory.ts
- packages/core-backend/src/routes/admin-users.ts
- packages/core-backend/src/directory/**
- apps/web/src/views/DirectoryManagementView.vue
- apps/web/src/views/UserManagementView.vue
- apps/web/src/views/SessionCenterView.vue
- apps/web/src/views/Attendance*.vue
- scripts/ops/git-*
- scripts/ops/*remote-git-slice*
- output/**
- packages/openapi/dist/**

Goals:
1. implement backend DingTalk OAuth callback support
2. switch DingTalkAuthCallbackView from placeholder to real callback handling
3. add DingTalk login entry in LoginView only if the backend flow is wired
4. reuse the existing setToken + primeSession flow
5. update OpenAPI and docs

Constraints:
- runtime code is the source of truth
- do not hardcode third-party OAuth URLs on the frontend if a backend launch endpoint exists
- callback success/failure/missing-params must all be handled
- no new directory/admin/ops features

Required commands:
- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
- pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
- pnpm --filter @metasheet/web exec vue-tsc --noEmit
- pnpm --filter @metasheet/core-backend build
- pnpm --filter @metasheet/web build
- node scripts/openapi-check.mjs

If web build fails, the only acceptable pre-existing failure is AttendanceView.vue importing ../utils/timezones. Any new build failure is a regression.

Return:
- changed files
- commands run with pass/fail
- final callback endpoint(s) and response shape
- how login initiates DingTalk auth
- unresolved risks
- design/verification/deployment docs added
```
