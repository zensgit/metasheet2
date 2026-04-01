# OAuth State Observability On-Prem Rollout Verification

日期：2026-04-01

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | `142.171.239.56` |
| 用户 | `mainuser` |
| backend 镜像 | `ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260401-01ad02964` |
| web 镜像 | `ghcr.io/zensgit/metasheet2-web:dingtalk-rollout-20260330-d619b560d` |
| 部署方式 | `docker run` |

## 执行摘要

1. 将 `feat(auth): add oauth state observability` 推送到 `origin/codex/dingtalk-onprem-rollout-20260330`
2. 在远端 fresh clone `/home/mainuser/metasheet2-rollout-oauth-state-observability` 构建新 backend 镜像
3. 使用 `scripts/ops/dingtalk-onprem-docker-run.sh` 仅替换 `metasheet-backend`
4. 通过真实 DingTalk OAuth reachability 触发一组 state 指标：
   - `GET /api/auth/dingtalk/launch`
   - `POST /api/auth/dingtalk/callback` with invalid state
   - `POST /api/auth/dingtalk/callback` with missing code
5. 从 `/metrics/prom` 抓取新指标样本，并从容器日志中确认 callback state rejection warn

## 远端实测

### 1. 运行镜像

```text
ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260401-01ad02964
```

### 2. 健康与 OAuth reachability

```json
{"status":"ok","timestamp":"2026-04-01T01:37:28.277Z","plugins":11,"pluginsSummary":{"total":11,"active":11,"failed":0},"dbPool":{"total":2,"idle":2,"waiting":0},"ok":true,"success":true}
```

```json
{"success":true,"data":{"url":"https://login.dingtalk.com/oauth2/auth?...","state":"a17a8aa2-f10f-47ee-93d0-38beb69015d3"},"ok":true}
```

```json
{"success":false,"error":"Invalid or unknown state parameter","ok":false}
```

```json
{"success":false,"error":"Missing required parameter: code","ok":false}
```

结论：

- backend 新镜像已正常运行
- launch 正常
- callback invalid state / missing code 语义保持不变

### 3. Prometheus 指标样本

实际抓取到：

```text
# HELP metasheet_dingtalk_oauth_state_operations_total Total DingTalk OAuth state store operations by operation, store, and result
# TYPE metasheet_dingtalk_oauth_state_operations_total counter
metasheet_dingtalk_oauth_state_operations_total{operation="generate",store="redis",result="success"} 1
metasheet_dingtalk_oauth_state_operations_total{operation="validate",store="redis",result="invalid"} 1
metasheet_dingtalk_oauth_state_operations_total{operation="validate",store="memory",result="invalid"} 1
```

```text
redis_operation_duration_seconds_sum{op="dingtalk_oauth_state_write"} 0.057
redis_operation_duration_seconds_count{op="dingtalk_oauth_state_write"} 1
redis_operation_duration_seconds_sum{op="dingtalk_oauth_state_validate"} 0.005
redis_operation_duration_seconds_count{op="dingtalk_oauth_state_validate"} 1
```

说明：

- `generate=redis/success` 证明 launch 侧 state 已实际写入 Redis
- `validate=redis/invalid` 证明 callback invalid-state 路径已被统计
- `redis_operation_duration_seconds{op="dingtalk_oauth_state_write|validate"}` 已存在实际观测值
- `metasheet_dingtalk_oauth_state_fallback_total` 本次未出现样本，符合预期，因为本轮没有触发 Redis fallback

### 4. 结构化日志样本

```text
warn: DingTalk callback state rejected {"context":"AuthRouter","reason":"Invalid or unknown state parameter","requestId":"f2ac70ba-38f5-484c-87b4-cc99463cd6e2","service":"metasheet","timestamp":"2026-04-01T01:37:28.430Z"}
```

说明：

- callback 因 state 被拒绝时，现网已能落结构化 warn 日志
- 当前样本证明 `reason` 字段已带出

## 结论

**结论：`oauth-state-observability` on-prem rollout 通过。**

通过项：

- 新 backend 镜像已部署到 `142.171.239.56`
- OAuth reachability 未回归
- 新增 DingTalk OAuth state 指标已在 `/metrics/prom` 实际可见
- Redis write / validate 的专用 `op` 耗时标签已实际可见
- callback state rejection warn 已在现网日志中落出

仍需跟踪但不阻塞本轮通过的事项：

1. 本轮未主动制造 Redis 不可用，因此 `metasheet_dingtalk_oauth_state_fallback_total` 仍未在现网出现非零样本
2. 如后续需要 dashboard/告警，还需单独补 Grafana 与告警规则
