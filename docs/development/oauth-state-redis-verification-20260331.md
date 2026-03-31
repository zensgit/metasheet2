# OAuth State Redis Verification

日期：2026-03-31

## 范围

验证 DingTalk OAuth `state` 是否已切换为 Redis 优先存储，并确认 Redis 不可用时仍能回退到单机可用模式。

## 实际执行

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-oauth-state-store.test.ts`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `node scripts/openapi-check.mjs`

## 预期口径

- `generateState()` 和 `validateState()` 改为异步
- `GET /api/auth/dingtalk/launch` 与 `POST /api/auth/dingtalk/callback` 仍保持既有响应 shape
- Redis 已配置时，state 走 Redis 并支持一次性消费
- Redis 不可用时，state 自动回退到内存，单机场景仍可完成 callback

## 结果

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-oauth-state-store.test.ts`
  - 结果：通过
  - 实际结果：`1 file / 3 tests passed`
  - 覆盖：
    - Redis 已配置时的生成与一次性消费
    - Redis 逻辑 TTL 过期语义
    - Redis 不可用时的内存 fallback

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts`
  - 结果：通过
  - 实际结果：`1 file / 48 tests passed`
  - 说明：`/dingtalk/launch` 与 `/dingtalk/callback` 路由已切到 async state API，原有响应 shape 未变化

- `pnpm --filter @metasheet/core-backend build`
  - 结果：通过

- `pnpm --filter @metasheet/web build`
  - 结果：通过
  - 说明：本轮未改前端运行时代码，但已复核全量前端构建仍为绿色

- `node scripts/openapi-check.mjs`
  - 结果：通过（Files checked: 3 / Total paths: 32 / Issues found: 0 / PASSED）

## 独立结论

- DingTalk OAuth `state` 现已改为 Redis 优先存储
- Redis 不可用时，会自动回退到进程内存储，单机场景不丢功能
- API 契约与前端 callback 行为保持不变，无需额外前端改造
- 当前剩余风险是设计内已接受的运维项：如果部署为多实例，仍应确保所有实例共享同一个 Redis
