# DingTalk OAuth Stability Check Contract Fix Design

日期：2026-04-03

## 目标

修复 `scripts/ops/dingtalk-oauth-stability-check.sh` 对 backend `/health` 响应的过严判定，避免在服务实际健康时产生 `healthy=false` 的假阴性。

## 背景

Day 2 稳定观察中，on-prem backend 实际返回：

```json
{
  "status": "ok",
  "timestamp": "...",
  "plugins": 11,
  "pluginsSummary": { "total": 11, "active": 11, "failed": 0 },
  "dbPool": { "total": 2, "idle": 2, "waiting": 0 }
}
```

但现有 checker 只接受：

- `health.ok === true`

因此在 `status=ok` 且 `ok` 字段缺失时，会把服务误判成：

- `healthy=false`

这会污染 7 天稳定观察记录，也会弱化真实异常与检查器异常的边界。

## 方案

保持现有 check 的其余条件不变，只放宽 health 契约：

- 若 `health.ok === true`，判健康
- 若 `health.status === 'ok'`，也判健康

保留原有限制：

- webhook 必须已持久化配置到 `hooks.slack.com`
- Alertmanager `notifyErrorsLastWindow` 必须为 `0`

## 设计取舍

### 不去修改 backend `/health`

Day 2 目标是继续稳定观察，不是扩应用逻辑。当前最小修复点是 checker，而不是远端健康接口。

### 不把 metrics 样本数纳入 hard gate

当前 OAuth `state` metrics 是否出现样本，取决于观察窗口内是否发生真实 OAuth state 读写。它适合做观察项，不适合做健康硬门槛。

## 非目标

- 不改变 drill 逻辑
- 不改变 Alertmanager / Slack webhook 流程
- 不把 Redis metrics 缺样本解释成故障
