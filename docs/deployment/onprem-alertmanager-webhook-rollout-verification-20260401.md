# On-Prem Alertmanager Webhook Rollout Verification

日期：2026-04-01

## 目标主机

- `142.171.239.56`
- 部署目录：`/home/mainuser/metasheet2/docker/observability`

## 实际执行

```bash
pnpm verify:dingtalk-oauth-alert-notify
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

## 结果

### 容器状态

远端实测：

- `metasheet-alertmanager`：`Up ... (healthy)`
- `metasheet-alert-webhook`：`Up ... (healthy)`
- `metasheet-grafana`：`Up ... (healthy)`
- `metasheet-prometheus`：`Up ... (healthy)`

### Prometheus -> Alertmanager 注册

```json
{
  "status": "success",
  "data": {
    "activeAlertmanagers": [
      { "url": "http://alertmanager:9093/api/v2/alerts" }
    ],
    "droppedAlertmanagers": []
  }
}
```

### Synthetic Alert -> Webhook Receiver

远端 `docker logs --since 5m metasheet-alert-webhook` 已命中：

- `receiver=local-test-webhook`
- `alertname=DingTalkOAuthAlertNotifyExercise`
- `exercise_id=exercise-1775011309`

这证明：

1. Alertmanager 已成功接收 synthetic alert
2. route 已命中 `local-test-webhook`
3. webhook receiver 已真实收到通知 payload

## 兼容性处置

目标主机仍使用 `docker-compose 1.29.2`。本轮通过以下方式规避 `ContainerConfig` recreate bug：

1. 先按名称模式删除所有遗留 `alertmanager` / `alert-webhook` 容器
2. 仅增量重建 `alertmanager` / `alert-webhook`
3. 通过 `docker restart metasheet-prometheus` 让 Prometheus 重新读取 `alerting` 配置

## 结论

**结论：on-prem Alertmanager webhook rollout 通过。**
