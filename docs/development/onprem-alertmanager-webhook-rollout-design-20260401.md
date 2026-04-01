# On-Prem Alertmanager Webhook Rollout Design

日期：2026-04-01

## 目标

把 DingTalk OAuth observability 从“有 dashboard / 有规则”推进到“Alertmanager 可接收告警并向 webhook 发送通知”。

## 背景

当前 `142.171.239.56` 已经具备：

- Prometheus
- Grafana
- `dingtalk-oauth-alerts.yml`
- `DingTalk OAuth Overview`

但 Prometheus 还没有配置 Alertmanager，下游通知链仍未接通。

本轮建立在已经完成的 `onprem-grafana-alert-rollout` 基础上：

- 不重建 `metasheet-backend` / `metasheet-web`
- 不重做 Prometheus / Grafana 初始部署
- 仅追加 `alertmanager` 和 `alert-webhook`，并让 Prometheus 重新加载 `alerting` 配置

## 方案

### 1. 新增 on-prem Alertmanager 模板

新增：

- `docker/observability/alertmanager/alertmanager.onprem.yml.template`

默认接收器不再直连外部 webhook，而是统一发往本地 bridge：

- `default-webhook -> http://alert-webhook:8080/notify`
- `local-test-webhook -> http://alert-webhook:8080/exercise`

这样 Alertmanager 始终只面对通用 webhook 协议，真正的外部平台兼容性由本地 receiver 负责。

### 2. 扩展 on-prem compose

在 `docker/observability/docker-compose.onprem.yml` 中新增：

- `alertmanager`
- `alert-webhook`

其中：

- `alertmanager` 只绑定 `127.0.0.1:9093`
- `alert-webhook` 作为默认本地通知接收器和外部桥接器，方便 on-prem 自证通知链
- `alert-webhook` 的 healthcheck 改用 Python 标准库请求 `/`，避免 `python:3.12-alpine` 上缺失 `wget`
- `alert-webhook` 通过运行时 env 接收 `ALERTMANAGER_WEBHOOK_URL`，从而把 Alertmanager payload 转换并转发到 Slack / Webhook.site / 其他外部地址

### 3. Prometheus 接入 Alertmanager

更新 `docker/observability/prometheus/prometheus.onprem.yml`：

- `alerting.alertmanagers -> alertmanager:9093`

### 4. 新增 rollout 与验证脚本

新增：

- `scripts/ops/verify-dingtalk-oauth-alert-notify.sh`
- `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh`

职责：

- 本地验证 Alertmanager 模板、on-prem compose、Prometheus alertmanager target
- 远端同步资产、渲染 config、拉起 Alertmanager / webhook receiver
- 通过 Alertmanager API 注入一条 synthetic alert，并在 receiver logs 中确认 webhook 收到通知

新增：

- `scripts/ops/dingtalk-onprem-alert-drill.sh`

职责：

- 直接向远端 Alertmanager 注入一条走默认外部通知链的 synthetic alert
- 等待 firing -> resolved 生命周期闭环
- 输出 drill id，便于到 Slack 频道中精确核对两条消息

### 5. 兼容 docker-compose v1.29.2

目标主机上的 `docker-compose` 仍是 `1.29.2`，存在已知的 `ContainerConfig` recreate 问题。为避免再次把健康中的 Grafana / Prometheus 带崩，本轮 rollout 采用：

1. 只对 `alertmanager` / `alert-webhook` 执行 `up -d`
2. 先按名称模式删除所有遗留 `alertmanager` / `alert-webhook` 容器，避免 compose 复用旧容器元数据
3. 通过 `docker restart metasheet-prometheus` 让 Prometheus 重新读取 `alertmanager` 配置

这让 Alertmanager 通知链能增量落地，而不触碰现有 app 容器拓扑。

## 取舍

### 为什么引入本地 bridge，而不是让 Alertmanager 直连 Slack

Alertmanager 的 `webhook_configs` 会发送通用 Alertmanager JSON，而 Slack Incoming Webhook 需要 `{"text": ...}` 之类的 Slack payload。直接把 Slack URL 配到 Alertmanager 会触发 `400 no_text`。本地 bridge 负责把两者解耦：

1. Alertmanager 始终只发通用 JSON
2. `alert-webhook` 可以把 payload 转成 Slack 可接收的文本消息
3. 对 Webhook.site 等通用端点则保留 raw JSON 转发
4. 本地 exercise 与正式外部通知链可以共存，不互相污染

### 为什么 default route 仍经过本地 bridge

即便已经拿到正式 Slack webhook，也不应让 Alertmanager 直接面对第三方 webhook 协议差异。bridge 让后续新增格式化、签名、重试与路由扩展都发生在本地资产中，而不是散落在告警配置里。

### 为什么 synthetic alert 直接发到 Alertmanager

这轮目标是验证通知链，而不是等待某条 Prometheus 规则自然触发。直接 POST 到 Alertmanager API 更快、更稳定，也避免为了演练去污染真实业务指标。

## 非目标

- 不在本轮接入外部 Slack / Feishu 凭据
- 不在本轮开放 Alertmanager 公网访问
- 不在本轮接入第三方机器人签名协议
- 不在本轮把 resolved drill 做成 Slack API 读回校验；频道落地仍以浏览器可见性复核为准
