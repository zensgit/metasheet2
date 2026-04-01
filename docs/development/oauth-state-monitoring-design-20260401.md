# OAuth State Monitoring Design

日期：2026-04-01

## 目标

把 DingTalk OAuth state observability 从“指标存在”推进到“监控资产可直接落地”，补齐：

- Prometheus alert rules
- Grafana dashboard
- 一条可重复执行的资产验证命令

## 背景

上一轮已经补齐了 DingTalk OAuth state 的计数器、fallback 计数器和结构化日志，也完成了 on-prem rollout 验证。但当时仍缺两层运营资产：

1. 没有独立 dashboard，值班时只能直接查 `/metrics/prom`
2. 没有独立 alert rules，Redis fallback 或 callback state rejection 激增不会自动进入告警面

## 方案

### 1. 新增独立 Prometheus 规则文件

新增 `ops/prometheus/dingtalk-oauth-alerts.yml`，单独管理 DingTalk OAuth 相关告警：

- `DingTalkOAuthStateFallbacksDetected`
- `DingTalkOAuthStateValidationSpike`
- `DingTalkOAuthStateRedisLatencyP95High`

这样做比把规则塞进 `phase5-alerts.yml` 或 `attendance-alerts.yml` 更稳，避免职责混杂。

### 2. 接入 observability stack 默认挂载

更新：

- `docker/observability/docker-compose.yml`
- `docker/observability/prometheus/prometheus.yml`

让本地 observability stack 默认挂载并加载新的 DingTalk OAuth alert 文件。这样本地启动 Prometheus/Grafana 时，不需要额外手工加 mount。

### 3. 新增独立 Grafana dashboard

新增 `docker/observability/grafana/dashboards/dingtalk-oauth-overview.json`，覆盖 4 组核心视图：

- 15 分钟窗口内 generate / validate success
- 15 分钟窗口内 rejections / fallbacks
- Redis write / validate p95
- 按 `store/result` 与 `operation/reason` 维度拆开的 timeseries / table

### 4. 新增可重复执行的验证脚本

新增 `scripts/ops/verify-dingtalk-oauth-observability.sh`，统一做：

- dashboard JSON 解析
- 关键 metric 定义存在性检查
- `docker compose config`
- Prometheus rules lint
- `prometheus.yml` config lint

并通过 `pnpm verify:dingtalk-oauth-observability` 暴露成正式入口。

## 阈值选择

### Fallback 告警

规则：

- `sum(increase(metasheet_dingtalk_oauth_state_fallback_total[10m])) by (operation, reason) > 0`

理由：

- fallback 本身就代表 Redis 路径异常
- 对 DingTalk login 来说，Redis fallback 是降级而非正常流量
- 这一类信号宁可早知道，不适合放过高阈值
- 保留 `operation/reason` 维度，值班时可以直接判断是 generate 还是 validate 路径在抖动

### Redis p95 latency

阈值：

- write / validate 任一 p95 > `250ms`

理由：

- DingTalk OAuth state 读写在正常情况下应明显低于 `250ms`
- 单条按 `op` 维度展开的规则，更方便在 Prometheus / Grafana 中直接分面查看 write 与 validate 的差异

### ValidationSpike

规则：

- 15 分钟内 `invalid|expired` 总量 > `10`

理由：

- `missing` 更像手工探测或 smoke 流量，不适合进入运营告警
- `invalid|expired` 连续超过 10 次，更像登录回归、state 丢失或异常 callback 流量

## 非目标

- 不在这一轮新增 Alertmanager webhook 配置
- 不在这一轮自动把 dashboard 发布到生产 Grafana
- 不在这一轮新增 Grafana 截图式 UI 回归
