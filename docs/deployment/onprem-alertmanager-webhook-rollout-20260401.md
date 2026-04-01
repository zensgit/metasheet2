# On-Prem Alertmanager Webhook Rollout

日期：2026-04-01

## 适用场景

适用于 `142.171.239.56` 这类 on-prem 环境，目标是在现有 Prometheus / Grafana 基础上接通 Alertmanager -> webhook 通知链。

前置条件：

- 已完成 `scripts/ops/dingtalk-onprem-observability-rollout.sh`
- `metasheet-prometheus` / `metasheet-grafana` 已在宿主机正常运行

## 默认行为

若未指定外部 webhook，rollout 默认使用本地容器 receiver：

- `metasheet-alert-webhook`

这样可以在不依赖第三方平台的前提下完成通知链自证。

## 使用方式

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

或：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook \
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

## 结果

脚本会：

1. 同步 Alertmanager 模板、on-prem compose、Prometheus on-prem 配置
2. 在远端拉起：
   - `metasheet-alertmanager`
   - `metasheet-alert-webhook`
3. 通过重启 `metasheet-prometheus` 让 `alerting.alertmanagers` 生效
4. 验证：
   - Alertmanager health
   - Prometheus `api/v1/alertmanagers`
   - synthetic alert webhook delivery

## 实际验证报告

- `docs/development/onprem-alertmanager-webhook-rollout-verification-20260401.md`
- `docs/deployment/onprem-alertmanager-webhook-rollout-verification-20260401.md`

## 兼容性说明

目标主机当前仍使用 `docker-compose 1.29.2`。脚本已经内置规避策略：

- 不重建整个 observability stack
- 只重建 `alertmanager` / `alert-webhook`
- 先删除所有名称匹配 `alertmanager` / `alert-webhook` 的遗留容器
- 通过 `docker restart metasheet-prometheus` 重新加载配置

这样可以避免 `ContainerConfig` recreate bug 波及现有 Grafana / Prometheus 容器。
