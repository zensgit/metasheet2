# OAuth State Redis Design

日期：2026-03-31

## 目标

把 DingTalk OAuth `state` 从单进程内存升级为 Redis 优先存储，消除多实例和服务重启场景下的 CSRF state 丢失风险，同时保留单机环境的 graceful fallback。

## 设计

### 存储策略

- 主存储：Redis
- 回退：进程内 `Map<string, number>`
- `state` 生成与校验接口保持不变，只把实现改成异步

### Redis key

- 单个 state key：`metasheet:auth:dingtalk:state:<uuid>`
- 索引 key：`metasheet:auth:dingtalk:state:index`

### 语义要求

- TTL：5 分钟
- 一次性消费：校验成功或失败后都消费该 state
- 最大待处理 state：10,000 条
- 错误语义保持不变：
  - `Missing required parameter: state`
  - `Invalid or unknown state parameter`
  - `State parameter has expired`

### 过期判定

Redis key 比逻辑 TTL 多保留 60 秒诊断窗口。value 内部保存 `expiresAt`，这样 callback 在逻辑 TTL 刚过时仍能返回 `expired`，而不是直接退化成 `invalid/unknown`。

### 回退策略

- 未配置 Redis：直接使用进程内存储
- Redis 连接失败或运行时操作失败：记录一次 warning，自动回退到进程内存储
- 回退模式下保持单机场景可用，但不承诺跨实例共享

## 影响面

- `packages/core-backend/src/auth/dingtalk-oauth.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/dingtalk-oauth-state-store.test.ts`
- OAuth 设计/部署/验证文档
