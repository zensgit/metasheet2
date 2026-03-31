# DingTalk OAuth Backend Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 执行完成后做独立验收时使用。

## 必核项

### 1. 写边界

- 是否只改了允许路径
- 是否误碰 `admin-directory` / `admin-users` / `directory/**`
- 是否误碰 attendance / git toolchain / output 目录

### 2. 后端

- DingTalk OAuth callback 路由是否真实存在
- 相关 auth 服务逻辑是否有单测覆盖
- 缺参数 / 第三方失败 / env 缺失是否能返回可诊断错误
- auth 路由是否已经在运行时入口注册

### 3. 前端

- 登录页是否新增了与后端一致的 DingTalk 登录入口
- callback 页是否不再是纯占位页
- callback 成功时是否调用 `setToken()` 和 `primeSession()`
- callback 失败 / 缺参数时是否展示明确错误并允许返回登录

### 4. 契约 / 文档

- [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml) 是否与运行时一致
- 设计 / 验证 / 部署文档是否真实回填
- 文档是否明确说明 env / rollout 前提

### 5. 独立复跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```

## 允许的唯一预存构建失败

`pnpm --filter @metasheet/web build` 若失败，只允许是：

- [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue#L3394) 引用缺失的 `../utils/timezones`

任何新增 build 错误都算不通过。
