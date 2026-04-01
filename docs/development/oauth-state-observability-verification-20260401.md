# OAuth State Observability Verification

日期：2026-04-01

## 范围

验证 DingTalk OAuth state observability 是否已覆盖：

- Redis 命中
- Redis fallback
- 失效 / 非法 / 缺失 state
- Redis 专用耗时标签

## 实际执行

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-oauth-state-store.test.ts tests/unit/auth-login-routes.test.ts src/metrics/__tests__/metrics-integration.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `git diff --check`

## 结果

### 1. DingTalk state store 定向测试

- `tests/unit/dingtalk-oauth-state-store.test.ts`
  - 结果：通过

覆盖点：

- Redis 正常写入 + 一次性消费
- Redis 逻辑过期
- Redis 不可用时 fallback 到内存
- 新指标调用：
  - `dingtalkOauthStateOpsTotal`
  - `dingtalkOauthStateFallbackTotal`
  - `redisOperationDuration`

### 2. Auth route 回归

- `tests/unit/auth-login-routes.test.ts`
  - 结果：通过

确认点：

- callback 缺 `state` 仍返回 `400`
- callback 非法 state 仍返回 `400`
- callback 过期 state 仍返回 `400`
- 新增 `DingTalk callback state rejected` warn 不改变响应语义

### 3. Metrics 集成测试

- `src/metrics/__tests__/metrics-integration.test.ts`
  - 结果：通过

确认新增导出：

- `metrics.dingtalkOauthStateOpsTotal`
- `metrics.dingtalkOauthStateFallbackTotal`

并将导出总数从 `61` 更新为 `63`。

### 4. Backend build

- `pnpm --filter @metasheet/core-backend build`
  - 结果：通过

## 结论

这条 slice 已完成：

- DingTalk OAuth state 现在有独立 Prometheus 指标
- Redis 分支有 DingTalk 专用耗时标签
- fallback / invalid / expired / missing 都能被统计
- callback 端拒绝 state 时会落结构化 warn
