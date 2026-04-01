# On-Prem Alertmanager Webhook Rollout

日期：2026-04-01

## 适用场景

适用于 `142.171.239.56` 这类 on-prem 环境，目标是在现有 Prometheus / Grafana 基础上接通 Alertmanager -> webhook 通知链。

前置条件：

- 已完成 `scripts/ops/dingtalk-onprem-observability-rollout.sh`
- `metasheet-prometheus` / `metasheet-grafana` 已在宿主机正常运行

## 默认行为

Alertmanager 默认总是先把通知发到本地 bridge：

- `metasheet-alert-webhook`

bridge 的行为是：

- `default-webhook -> /notify`
- `local-test-webhook -> /exercise`

若未指定外部 webhook，bridge 只记录 payload，不向第三方发送；这样可以在不依赖第三方平台的前提下完成通知链自证。

## 使用方式

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

若需要正式对外通知，先写入长期 webhook，再 rollout：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook \
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

若当前没有长期外部 webhook 凭据，但需要验证真实公网通知能力，可执行一次性外部 exercise：

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

该脚本会：

1. 创建临时 Webhook.site 端点
2. 临时写入持久化 `ALERTMANAGER_WEBHOOK_URL`
3. 验证外部投递成功
4. 自动清除持久化配置并回到 `configured=false`

对应持久化说明：

- `docs/deployment/onprem-alertmanager-webhook-persistence-20260401.md`

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

## 外部通知兼容性

正式外部 webhook 不是由 Alertmanager 直接调用，而是由 `metasheet-alert-webhook` bridge 负责：

- Slack `hooks.slack.com`：bridge 自动把 Alertmanager JSON 转成 Slack `text` 消息
- Webhook.site / 通用 webhook：bridge 直接转发 raw Alertmanager JSON

这一步是必需的，因为 Slack Incoming Webhook 不能直接消费 Alertmanager 通用 webhook payload。

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
