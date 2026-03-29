# DingTalk Auth Verification

## Files Verified

Backend:

- [packages/core-backend/src/auth/dingtalk-auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/dingtalk-auth.ts)
- [packages/core-backend/src/auth/external-identities.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/external-identities.ts)
- [packages/core-backend/src/auth/external-auth-grants.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/external-auth-grants.ts)
- [packages/core-backend/src/auth/AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts)
- [packages/core-backend/src/auth/session-registry.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/session-registry.ts)
- [packages/core-backend/src/auth/jwt-middleware.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/jwt-middleware.ts)
- [packages/core-backend/src/routes/auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts)
- [packages/core-backend/src/db/types.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/types.ts)
- [packages/core-backend/src/db/migrations/zzzz20260323120000_create_user_external_identities.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260323120000_create_user_external_identities.ts)
- [packages/core-backend/src/db/migrations/zzzz20260323133000_harden_user_external_identities.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260323133000_harden_user_external_identities.ts)
- [packages/core-backend/src/db/migrations/zzzz20260324143000_create_user_external_auth_grants.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260324143000_create_user_external_auth_grants.ts)
- [packages/core-backend/tests/unit/auth-login-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/auth-login-routes.test.ts)
- [packages/core-backend/tests/unit/admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-users-routes.test.ts)
- [packages/core-backend/tests/unit/auth-invite-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/auth-invite-routes.test.ts)
- [packages/openapi/src/paths/auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml)
- [packages/openapi/src/base.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/base.yml)
- [.env.example](/Users/huazhou/Downloads/Github/metasheet2/.env.example)
- [.env.phase5.template](/Users/huazhou/Downloads/Github/metasheet2/.env.phase5.template)
- [packages/core-backend/.env.example](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/.env.example)
- [packages/core-backend/.env.development.example](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/.env.development.example)
- [scripts/dingtalk-auth-preflight.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/dingtalk-auth-preflight.mjs)
- [docs/development/dingtalk-auth-staging-execution-20260324.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-auth-staging-execution-20260324.md)

Frontend:

- [apps/web/src/composables/useAuth.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/composables/useAuth.ts)
- [apps/web/src/utils/api.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/utils/api.ts)
- [apps/web/src/router/types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/router/types.ts)
- [apps/web/src/main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- [apps/web/src/views/LoginView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/LoginView.vue)
- [apps/web/src/views/DingTalkAuthCallbackView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/DingTalkAuthCallbackView.vue)
- [apps/web/src/views/SessionCenterView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/SessionCenterView.vue)
- [apps/web/src/views/UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue)
- [apps/web/tests/loginView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/loginView.spec.ts)
- [apps/web/tests/dingtalkAuthCallbackView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/dingtalkAuthCallbackView.spec.ts)
- [apps/web/tests/sessionCenterView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/sessionCenterView.spec.ts)
- [apps/web/tests/userManagementView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/userManagementView.spec.ts)
- [apps/web/tests/utils/api.test.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/utils/api.test.ts)
- [apps/web/tests/useAuth.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/useAuth.spec.ts)
- [docs/development/dingtalk-auth-ops-preflight-20260323.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-auth-ops-preflight-20260323.md)

## Commands Run

2026-03-23 实际执行：

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/auth-invite-routes.test.ts \
  tests/unit/AuthService.test.ts
pnpm --filter @metasheet/web exec vitest run \
  tests/loginView.spec.ts \
  tests/dingtalkAuthCallbackView.spec.ts \
  tests/sessionCenterView.spec.ts \
  tests/useAuth.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
node scripts/dingtalk-auth-preflight.mjs
env DINGTALK_AUTH_ENABLED=true ... node scripts/dingtalk-auth-preflight.mjs
curl -I --max-time 10 http://142.171.239.56:8081
curl -I --max-time 10 http://142.171.239.56:8081/api/plugins
curl -i --max-time 10 'http://142.171.239.56:8081/api/auth/dingtalk/login-url?redirect=%2Fsettings'
pnpm --filter @metasheet/web exec vitest run \
  tests/sessionCenterView.spec.ts \
  tests/utils/api.test.ts \
  tests/useAuth.spec.ts
pnpm --filter @metasheet/web build
curl -sS -i -X POST http://142.171.239.56:8081/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"email":"zen0888@live.com","password":"***"}'
curl -sS -i http://142.171.239.56:8081/api/auth/dingtalk/bindings \
  -H 'Authorization: Bearer ***'
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts
pnpm --filter @metasheet/web exec vitest run \
  tests/userManagementView.spec.ts \
  tests/sessionCenterView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
```

## Results

- `pnpm --filter @metasheet/core-backend build`：通过
- `pnpm --filter @metasheet/core-backend exec vitest run ...`：`3` 个测试文件、`56` 个用例全部通过
- `pnpm --filter @metasheet/web exec vitest run ...`：`4` 个测试文件、`33` 个用例全部通过
- 2026-03-24 退出体验补丁：
  - `pnpm --filter @metasheet/web exec vitest run tests/app.spec.ts tests/useAuth.spec.ts tests/utils/api.test.ts tests/sessionCenterView.spec.ts`：`4` 个测试文件、`52` 个用例全部通过
  - `pnpm --filter @metasheet/web exec vue-tsc --noEmit`：通过
  - `pnpm --filter @metasheet/web build`：通过
  - 顶栏退出按钮已改为先调用 `/api/auth/logout`，再清理全部本地 token / 权限 / 功能缓存并跳转到 `/login?redirect=%2Fattendance`
  - 浏览器线上实测：
    - 管理员登录后进入 `/attendance`
    - 点击顶栏“退出登录”后稳定落在 `http://142.171.239.56:8081/login?redirect=%2Fattendance`
    - `localStorage` 与 `sessionStorage` 均为空
    - 在登录页点击“钉钉登录”后，正常跳转到钉钉统一身份认证页，URL 中携带 `redirect_uri=http://142.171.239.56:8081/auth/dingtalk/callback`
  - 2026-03-24 真实账号终验：
    - `zen0888@live.com` 已存在 `1` 条 `dingtalk` 绑定记录
    - 绑定企业为 `dingd1f07b3ff4c8042cbc961a6cb783455b`
    - 用户已通过真实钉钉账号成功登录进入系统
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`：通过
- `pnpm --filter @metasheet/web build`：最终通过
  - [SessionCenterView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/SessionCenterView.vue) 的 `:disabled` 表达式把字符串传入了布尔属性
  - 已修正为 `Boolean(bindingBusy) || bindingStartLoading`
  - 修正后重跑构建通过；Vite 仅保留现有大 chunk 警告，不影响本次功能交付
- `node scripts/openapi-check.mjs`：通过
  - OpenAPI build 成功
  - OpenAPI security validation passed
  - OpenAPI parse check passed
- `node scripts/dingtalk-auth-preflight.mjs`：在默认禁用场景下通过，明确提示 DingTalk auth 未启用
- 示例启用场景 preflight：通过，确认 callback URL、自动开户和企业范围配置组合有效
- 远端 HTTP 探测（`142.171.239.56`）：
  - `/` 返回 `200 OK`
  - `/api/plugins` 返回 `200 OK`
  - `/api/auth/dingtalk/login-url?redirect=/settings` 当前返回 `401 Missing Bearer token`
  - 这表明线上公开 DingTalk 登录入口尚未按新实现部署到位
- 2026-03-24 二次验证：
  - 钉钉企业真实授权、绑定和数据库落库已完成
  - 远端 `DINGTALK_ALLOWED_CORP_IDS` 已更新为真实回调返回的企业 ID：`dingd1f07b3ff4c8042cbc961a6cb783455b`
  - 首次线上回调后跳转到 `login?redirect=/settings` 的根因不是钉钉链路，而是前端生产包错误继承了本地 loopback 配置
  - 线上浏览器实际请求过 `http://127.0.0.1:7778/api/auth/me`，导致会话引导失败并回到登录页
  - 已在 [api.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/utils/api.ts) 与 [useAuth.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/composables/useAuth.ts) 增加 loopback 保护：当部署域名不是 loopback 时，自动退回 `window.location.origin`
  - 已在 [SessionCenterView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/SessionCenterView.vue) 修正绑定列表归一化逻辑，兼容后端真实返回的 `id / providerUnionId / profile.nick / createdAt` 字段
  - `pnpm --filter @metasheet/web exec vitest run tests/sessionCenterView.spec.ts tests/utils/api.test.ts tests/useAuth.spec.ts`：`3` 个测试文件、`50` 个用例全部通过
  - 重新构建并热部署前端静态包后，线上 `/settings` 页面实测不再跳回登录页，`/api/auth/me` 请求改为 `http://142.171.239.56:8081/api/auth/me` 并返回 `200`
  - `/api/auth/dingtalk/bindings` 首次刷新出现一次瞬时 `502`，二次刷新返回 `200`
  - 页面最终展示：
    - `已同步 1 条钉钉绑定`
    - `周华`
    - `企业 ID: dingd1f07b3ff4c8042cbc961a6cb783455b`
    - `解除绑定`
- 2026-03-24 方案 B 显式授权门补充验证：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts`：`2` 个测试文件、`98` 个用例全部通过
  - `pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/sessionCenterView.spec.ts`：`2` 个测试文件、`31` 个用例全部通过
  - `pnpm --filter @metasheet/web exec vue-tsc --noEmit`：通过
  - `pnpm --filter @metasheet/core-backend build`：通过
  - 新增验证点：
    - 未获授权的 MetaSheet 账号调用 `POST /api/auth/dingtalk/bind/start` 返回 `403 DINGTALK_BIND_NOT_AUTHORIZED`
    - 已绑定但被撤销授权的账号调用 `POST /api/auth/dingtalk/exchange` 返回 `403 DINGTALK_LOGIN_NOT_AUTHORIZED`
    - 管理员可通过用户管理页对指定用户执行“授权钉钉登录 / 取消钉钉授权”
    - 会话中心在 `authEnabled=false` 时会显示“当前账号未获授权开通钉钉登录”并禁用绑定按钮

## Behaviors Covered

后端覆盖：

- DingTalk 登录地址签发
- DingTalk 公开入口独立限流
- 已绑定用户 code exchange 登录
- 已绑定用户重复绑定冲突拒绝
- 用户发起 bind/start 跳转
- 绑定前显式授权校验
- 用户解绑已绑定 DingTalk 身份
- 已绑定账号登录前显式授权校验
- 未绑定用户自动开户
- 绑定列表查询
- 邀请接受后 session-aware 登录
- token `sid` / `authProvider` 透传
- refresh-token 后 session expiry 对齐
- OpenAPI 契约和环境模板交付
- 发布前静态 preflight

前端覆盖：

- 登录页发起钉钉跳转
- callback 成功交换 token 并进入系统
- callback 失败时展示错误与重试
- callback 对 stale / mismatch auth context 做拦截
- external auth context 读写清理
- external auth context TTL 过期清理
- 生产环境 loopback API 地址自动回退到当前站点 origin
- 会话中心钉钉绑定列表进入页面自动加载、手动刷新、解绑
- 会话中心发起 bind/start 跳转
- 会话中心未授权态提示与禁用
- 用户管理页对指定用户的钉钉登录授权开关
- 顶栏退出触发当前会话注销、清理本地 token/功能缓存并回到登录页
- 退出后重新发起钉钉登录，成功跳转至钉钉统一身份认证页

## Not Yet Verified

- 自动开户后的角色模板、组织映射还未在真实组织数据上做验收。
- 真实生产用户的解绑后重新绑定流程还未做最终验收。
- 钉钉直登成功后的首页落点与首屏体验还未做专门 UX 回归。

## Recommendation

下一轮上线前建议补三项：

1. 在真实测试企业里补一轮解绑、重新绑定和钉钉直登回归。
2. 保持 `DINGTALK_AUTO_PROVISION=false`，等默认组织和 preset 验证完成后再开启自动开户。
3. 清理多余测试会话，并轮换这次联调过程中暴露过的管理员和服务器密码。
