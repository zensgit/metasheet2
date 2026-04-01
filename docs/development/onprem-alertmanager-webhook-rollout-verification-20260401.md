# On-Prem Alertmanager Webhook Rollout Verification

日期：2026-04-01

## 本轮变更

- 新增 `docker/observability/alertmanager/alertmanager.onprem.yml.template`
- 更新 `docker/observability/docker-compose.onprem.yml`
- 更新 `docker/observability/prometheus/prometheus.onprem.yml`
- 新增 `scripts/ops/verify-dingtalk-oauth-alert-notify.sh`
- 新增 `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh`
- 更新部署与索引文档

## 预期验证

### 本地

```bash
bash -n scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
bash scripts/ops/verify-dingtalk-oauth-alert-notify.sh
docker compose -f docker/observability/docker-compose.onprem.yml config >/dev/null
git diff --check
```

### 远端

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

预期：

1. `metasheet-alertmanager` 正常启动
2. Prometheus `/api/v1/alertmanagers` 能看到 `alertmanager:9093`
3. synthetic alert 能被本地 webhook receiver 收到

## 实际结果

### 本地

实际通过：

```bash
bash -n scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
bash scripts/ops/verify-dingtalk-oauth-alert-notify.sh
pnpm verify:dingtalk-oauth-alert-notify
git diff --check
```

结果：

1. Alertmanager 模板 YAML 解析通过
2. `docker/observability/docker-compose.onprem.yml` compose wiring 通过
3. `docker/observability/prometheus/prometheus.onprem.yml` 已包含 `alertmanager:9093`
4. webhook receiver 资产存在

### 远端

实际执行：

```bash
pnpm ops:onprem-alert-notify-rollout
```

目标主机：`142.171.239.56`

远端实测结果：

1. `metasheet-alertmanager` 启动并健康
2. `metasheet-alert-webhook` 启动并健康
3. `metasheet-prometheus` 重启后恢复健康
4. `metasheet-grafana` 保持可用
5. `GET http://127.0.0.1:9090/api/v1/alertmanagers` 返回 `activeAlertmanagers=[http://alertmanager:9093/api/v2/alerts]`
6. 通过 `POST http://127.0.0.1:9093/api/v2/alerts` 注入 `DingTalkOAuthAlertNotifyExercise`
7. `docker logs metasheet-alert-webhook` 命中 synthetic alert，`receiver=local-test-webhook`
8. `alert-webhook` 的 Python healthcheck 通过，容器状态为 `Up ... (healthy)`

### 兼容性处置

首次远端 rollout 再次触发了 `docker-compose 1.29.2` 的 `ContainerConfig` recreate bug。最终通过以下方式规避：

1. 不重建整个 observability stack
2. 仅重建 `alertmanager` / `alert-webhook`
3. 先清掉所有名称匹配 `alertmanager` / `alert-webhook` 的遗留容器
4. 通过 `docker restart metasheet-prometheus` 让 Prometheus 重新加载 `alerting` 配置

## 结论

**结论：`onprem-alertmanager-webhook-rollout` 通过。**

当前已确认：

1. Alertmanager 已在 on-prem 主机真实运行
2. Prometheus 已真实注册 Alertmanager
3. 本地 webhook receiver 已真实收到 synthetic alert
4. 整体通知链已从“可见”推进到“可通知”
