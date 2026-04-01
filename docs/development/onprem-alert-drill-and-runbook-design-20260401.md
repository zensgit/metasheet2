# On-Prem Alert Drill And Runbook Design

日期：2026-04-01

## 目标

把 DingTalk OAuth 告警通知从“链路可达”推进到“可演练、可恢复、可交接”的长期运维状态。

## 背景

前序工作已经完成：

- on-prem Prometheus / Grafana / Alertmanager rollout
- 外部 Slack webhook 持久化配置
- `#metasheet-alerts` 正式频道建立

但真实 drill 暴露出一个关键缺口：Alertmanager 直接对 Slack Incoming Webhook 发送通用 JSON，会得到 `400 no_text`。因此需要把“长期运维 runbook”建立在可工作的 bridge 语义上，而不是继续沿用过时的直连假设。

## 方案

### 1. 固化本地 bridge

Alertmanager 配置统一改成：

- `default-webhook -> http://alert-webhook:8080/notify`
- `local-test-webhook -> http://alert-webhook:8080/exercise`

`alert-webhook` 负责：

- 记录 raw Alertmanager payload
- 对 Slack `hooks.slack.com` 目标自动转换为 Slack `text` 消息
- 对 Webhook.site 等通用目标保留 raw JSON 转发

### 2. 新增 on-prem drill 脚本

新增：

- `scripts/ops/dingtalk-onprem-alert-drill.sh`

职责：

- 向远端 Alertmanager 注入一条 synthetic alert
- 等待 alert 在 Alertmanager 中进入 firing
- 等待 alert 到期后从 Alertmanager 中消失
- 输出 `drillId`，便于到 Slack 频道中核对 firing / resolved 两条消息

### 3. 补长期 runbook

新增一页专门的 on-prem runbook，固定：

- 正式频道：`#metasheet-alerts`
- Slack App：`Metasheet Alerts`
- 持久化 webhook 配置入口
- rollout 命令
- firing / resolved drill 命令
- webhook 轮换与清理步骤

## 取舍

### 为什么 drill 仍直接 POST 到 Alertmanager API

drill 的目标是验证告警通知链，不是等待某条真实 Prometheus 规则自然触发。直接 POST 更快、更稳定，而且不污染真实业务指标。

### 为什么 resolved 校验分成两层

技术层面：

- `dingtalk-onprem-alert-drill.sh` 验证 Alertmanager 中 alert 从出现到消失

运维层面：

- Slack 频道中必须能看到同一 `drillId` 的 firing 与 resolved 两条消息

这两层都成立，才算真正完成一次值班 drill。

## 非目标

- 不把 Slack 频道读取自动化成长期 CI 门禁
- 不在本轮引入第三方签名校验或多 webhook fan-out
- 不在本轮把 Alertmanager 配置抽象成通用多平台消息模板系统
