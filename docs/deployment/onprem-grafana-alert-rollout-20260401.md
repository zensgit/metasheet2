# On-Prem Grafana / Alert Rollout

日期：2026-04-01

## 适用场景

适用于 `142.171.239.56` 这类 on-prem 环境，其中：

- MetaSheet backend 已通过 `docker run` 方式运行
- backend 位于 Docker 网络 `metasheet2_default`
- 需要把仓库中的 DingTalk OAuth monitoring assets 真正接入 Prometheus / Grafana

## 使用方式

在本地仓库执行：

```bash
bash scripts/ops/dingtalk-onprem-observability-rollout.sh
```

或使用根脚本入口：

```bash
pnpm ops:onprem-grafana-alert-rollout
```

默认参数：

- `SSH_USER_HOST=mainuser@142.171.239.56`
- `SSH_KEY=~/.ssh/metasheet2_deploy`
- `REMOTE_APP_DIR=/home/mainuser/metasheet2`
- `REMOTE_APP_NETWORK=metasheet2_default`

## 远端结果

脚本会：

1. 同步以下资产到远端：
   - `docker/observability/docker-compose.onprem.yml`
   - `docker/observability/prometheus/prometheus.onprem.yml`
   - `docker/observability/grafana/dashboards/dingtalk-oauth-overview.json`
   - `ops/prometheus/dingtalk-oauth-alerts.yml`
2. 启动：
   - `metasheet-prometheus`
   - `metasheet-grafana`
3. 做最小复验：
   - Prometheus health
   - Grafana health
   - Prometheus target = `metasheet-backend` / `up`
   - Grafana dashboard = `DingTalk OAuth Overview`

## 访问方式

默认只绑定到宿主机 loopback：

- `127.0.0.1:9090`
- `127.0.0.1:3000`

推荐通过 SSH tunnel 访问，而不是直接暴露公网。
