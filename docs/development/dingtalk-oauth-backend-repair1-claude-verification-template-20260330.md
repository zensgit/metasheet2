# DingTalk OAuth Backend Repair-1 Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 执行完成后做独立验收时使用。

## 必核项

### 1. 写边界

- 是否只改了 repair 边界内文件
- 是否误碰目录 / admin / attendance / git toolchain
- [jwt-middleware.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/jwt-middleware.ts) 是否只做了最小白名单改动

### 2. OAuth state

- launch 是否真实生成 state
- state 是否被持久化
- callback 是否真实校验 state
- 缺失 / 错误 / 过期 state 是否返回明确错误
- 测试是否覆盖 success + missing state + bad state

### 3. 前后端一致性

- [LoginView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/LoginView.vue) 的发起方式是否和后端一致
- [DingTalkAuthCallbackView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/DingTalkAuthCallbackView.vue) 是否继续复用 `setToken()` + `primeSession()`
- [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml) 是否和最终运行时一致

### 4. 部署与验证

- 部署文档是否不再引用目录 smoke
- 自动验证命令或脚本是否真正覆盖 OAuth
- 设计 / 验证 / 部署文档是否真实回填

### 5. 独立复跑命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/loginView.spec.ts tests/dingtalkAuthCallbackView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
```

如果新增了 OAuth smoke 脚本，也复跑：

```bash
node scripts/dingtalk-oauth-smoke.mjs --help
```

## 允许的唯一预存构建失败

`pnpm --filter @metasheet/web build` 若失败，只允许是：

- [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue#L3394) 引用缺失的 `../utils/timezones`

任何新增 build 错误都算不通过。
