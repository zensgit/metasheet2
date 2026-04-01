# On-Prem Grafana Alert Rollout Design

日期：2026-04-01

## 目标

把 DingTalk OAuth state 的 dashboard 和 Prometheus alert rules 从“仓库资产已存在”推进到“`142.171.239.56` 可实际运行、可查询、可复验”。

## 背景

上一轮已经补齐：

- `ops/prometheus/dingtalk-oauth-alerts.yml`
- `docker/observability/grafana/dashboards/dingtalk-oauth-overview.json`
- `pnpm verify:dingtalk-oauth-observability`

但这些资产仍只是在仓库内完成，还没有真正接入远端 on-prem 的 Prometheus / Grafana。

## 关键问题

仓库自带的 `docker/observability/docker-compose.yml` 面向本地开发，Prometheus 默认抓：

- `host.docker.internal:8900`

这在当前远端 Linux 宿主机上不成立：

1. `host.docker.internal` 在远端 Docker 中不可解析
2. backend 运行在容器网络 `metasheet2_default`
3. backend 通过 `--network-alias backend` 暴露给同网络容器

因此远端不能直接复用本地开发版 observability compose。

## 方案

### 1. 新增 on-prem 专用 Prometheus 配置

新增：

- `docker/observability/prometheus/prometheus.onprem.yml`

改为直接抓：

- `backend:8900`

并保留现有 rule files：

- `phase5-recording-rules.yml`
- `phase5-alerts.yml`
- `attendance-alerts.yml`
- `dingtalk-oauth-alerts.yml`

### 2. 新增 on-prem 专用 compose

新增：

- `docker/observability/docker-compose.onprem.yml`

关键取舍：

- Prometheus 同时挂到：
  - `metasheet-observability`
  - `metasheet2_default`（external）
- Grafana 仅挂 `metasheet-observability`
- `9090` / `3000` 只绑定到 `127.0.0.1`

这样做的原因：

- Prometheus 需要直接访问 backend 容器 alias
- Grafana 不需要接入 app network
- on-prem 默认不把监控面板直接暴露公网，优先走 SSH tunnel 或宿主机本地访问

### 3. 新增 rollout 脚本

新增：

- `scripts/ops/dingtalk-onprem-observability-rollout.sh`

职责：

1. 同步 dashboard / rules / on-prem compose / on-prem prometheus config 到远端
2. 在远端执行 `docker-compose -f docker-compose.onprem.yml up -d`
3. 等待 Prometheus / Grafana 就绪
4. 校验：
   - Prometheus target 中 `metasheet-backend` 健康为 `up`
   - Grafana 已注册 `DingTalk OAuth Overview`

## 非目标

- 不在本轮接入 Alertmanager 或外部通知渠道
- 不在本轮开放 Grafana / Prometheus 公网端口
- 不在本轮自动创建 Grafana dashboard 截图证据
