# OAuth State Observability Design

日期：2026-04-01

## 目标

为 DingTalk OAuth `state` 存储补齐最小但可运营的 observability，覆盖：

- Redis 命中
- Redis 不可用后的内存 fallback
- 失效 / 非法 state
- Redis 写入 / 校验操作耗时

## 背景

当前 DingTalk OAuth `state` 已经是 Redis 优先、内存 fallback，但缺少统一的指标出口。功能可用，不代表问题可观察：

- 无法区分“Redis 正常命中”还是“已经静默降级到内存”
- 无法统计 expired / invalid state 的实际发生量
- Redis 分支虽然有通用耗时指标，但 DingTalk OAuth 没有独立标签，无法单独筛

## 方案

### 1. 新增专用计数器

在 `packages/core-backend/src/metrics/metrics.ts` 新增：

- `metasheet_dingtalk_oauth_state_operations_total`
  - labels:
    - `operation=generate|validate`
    - `store=redis|memory|none`
    - `result=success|fallback|missing|invalid|expired|error`
- `metasheet_dingtalk_oauth_state_fallback_total`
  - labels:
    - `operation=generate|validate`
    - `reason=redis_unavailable|redis_write_failed|redis_validation_failed`

### 2. 复用现有 Redis 耗时直方图

不再新增一套独立 histogram，而是复用：

- `redis_operation_duration_seconds`

新增 DingTalk OAuth 专用 op label：

- `dingtalk_oauth_state_write`
- `dingtalk_oauth_state_validate`

### 3. 补结构化日志

在 `dingtalk-oauth.ts` 和 `routes/auth.ts` 增加低噪声日志：

- 首次 Redis 不可用时记录 fallback warn
- 从 fallback 恢复到 Redis 时记录 recovery info
- callback 因 state 缺失 / 非法 / 过期被拒绝时记录 warn，并带 `reason`

## 设计取舍

### 不把正常成功路径全部打成 info

正常的 `generateState/validateState` 请求量可能较高，若逐次记录 info 会污染日志。成功路径主要靠 metrics，日志只记录异常和恢复事件。

### Missing state 记为 `store=none`

`state` 缺失不是 Redis 或 memory store 的结果，而是请求本身缺参，因此单独标成 `store=none`，避免误读为存储层 miss。

### Fallback reason 与 operation 分开统计

`generate` 和 `validate` 两条路径的 fallback 价值不同，必须分开看。否则只知道“发生过 fallback”，但无法判断是 launch 端还是 callback 端在抖。

## 非目标

- 不新增 Grafana dashboard
- 不做告警规则
- 不改变现有 HTTP 响应 shape
