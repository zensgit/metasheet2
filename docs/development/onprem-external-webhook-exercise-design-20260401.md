# On-Prem External Webhook Exercise Design

日期：2026-04-01

## 目标

在不掌握长期 Slack / DingTalk / Feishu webhook 凭据的前提下，验证 `142.171.239.56` 的 Alertmanager 已具备真实对外 webhook 投递能力。

## 方案

### 1. 使用一次性外部 request-capture 端点

本轮选择 `Webhook.site` 作为一次性外部端点：

- 通过 `POST https://webhook.site/token` 创建临时 token
- 使用 `https://webhook.site/<token>` 作为 `ALERTMANAGER_WEBHOOK_URL`
- 通过 `GET https://webhook.site/token/<token>/requests` 查询实际接收记录

### 2. 保持现有 on-prem 通知链不变

现有 `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh` 仍然负责：

- 渲染 `alertmanager.onprem.yml`
- 拉起 `metasheet-alertmanager` / `metasheet-alert-webhook`
- 验证本地 synthetic alert 命中 `local-test-webhook`

外部 exercise 只是在此基础上：

1. 临时写入持久化 `ALERTMANAGER_WEBHOOK_URL`
2. 发送一条不命中 `local-test-webhook` 路由的 `DingTalkOAuthExternalWebhookExercise`
3. 在 Webhook.site 上确认实际收到请求
4. 清除持久化配置，让主机回到 `configured=false`

### 3. 为什么要清除持久化配置

因为当前主机没有持久化的外部通知凭据。一次性 request-capture 只用于证明：

- 远端 Alertmanager 能向公网 webhook 发出请求
- 当前网络、TLS、HTTP 出站链路正常

验证完成后，清除持久化配置可以避免把临时 URL 留在生产配置中；后续如需本地自证，notify rollout 会按 fallback 再回到本地 receiver。

## 非目标

- 不在本轮持久化生产级 Slack / DingTalk / Feishu webhook
- 不在本轮引入新的密钥存储机制
- 不在本轮把 Alertmanager 通知永久切到第三方端点
