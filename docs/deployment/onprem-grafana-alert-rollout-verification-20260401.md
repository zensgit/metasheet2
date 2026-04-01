# On-Prem Grafana / Alert Rollout Verification

日期：2026-04-01

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | `142.171.239.56` |
| 用户 | `mainuser` |
| App 目录 | `/home/mainuser/metasheet2` |
| App Docker 网络 | `metasheet2_default` |
| Prometheus 访问 | `127.0.0.1:9090` |
| Grafana 访问 | `127.0.0.1:3000` |

## 执行命令

```bash
bash scripts/ops/dingtalk-onprem-observability-rollout.sh
```

## 实际结果

### 1. 容器状态

```text
NAMES                  IMAGE                     STATUS                        PORTS
metasheet-grafana      grafana/grafana:10.2.2    Up About a minute (healthy)   127.0.0.1:3000->3000/tcp
metasheet-prometheus   prom/prometheus:v2.48.0   Up 6 minutes (healthy)        127.0.0.1:9090->9090/tcp
```

### 2. Prometheus target

实际抓取：

```json
{
  "labels": {
    "app": "metasheet",
    "env": "onprem",
    "instance": "backend:8900",
    "job": "metasheet-backend"
  },
  "scrapeUrl": "http://backend:8900/metrics/prom",
  "lastError": "",
  "health": "up"
}
```

说明：

- on-prem Prometheus 已通过容器网络 alias `backend:8900` 成功抓取 backend
- 不再依赖 `host.docker.internal`

### 3. Prometheus rules

```text
dingtalk-oauth-observability
```

说明：

- `ops/prometheus/dingtalk-oauth-alerts.yml` 已被远端 Prometheus 正常加载

### 4. Grafana health

```json
{
  "commit": "161e3cac5075540918e3a39004f2364ad104d5bb",
  "database": "ok",
  "version": "10.2.2"
}
```

### 5. Grafana dashboard registration

```json
[
  {
    "uid": "dingtalk-oauth-overview",
    "title": "DingTalk OAuth Overview",
    "url": "/d/dingtalk-oauth-overview/dingtalk-oauth-overview"
  }
]
```

说明：

- Grafana 已正确注册 `DingTalk OAuth Overview`
- Dashboard provisioning 已在远端生效

## 结论

**结论：`onprem-grafana-alert-rollout` 通过。**

已确认：

1. 远端 Prometheus / Grafana 已成功启动
2. Prometheus 已真实抓到 `metasheet-backend`
3. DingTalk OAuth alert rules 已真实加载
4. Grafana dashboard 已真实可见

仍需后续单独推进但不阻塞本轮通过的事项：

1. 当前仅完成 dashboard / rules rollout，尚未接入 Alertmanager 或外部通知渠道
2. `9090` / `3000` 仍只绑定到宿主机 loopback，若需远程查看应通过 SSH tunnel
