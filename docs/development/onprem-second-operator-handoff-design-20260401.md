# On-Prem Second-Operator Handoff Design

日期：2026-04-01

## 背景

当前 DingTalk OAuth on-prem 运维链路已经具备：

- 持久化 Slack webhook
- Alertmanager notify rollout
- firing / resolved 正式 drill
- 7 天稳定观察清单

但“第二操作者演练”仍依赖人工从多个 runbook 中拼接命令，容易漏掉 rollout 或机器侧日检。

## 目标

提供一个单命令交接入口，让第二操作者可以按固定顺序完成：

1. 持久化 webhook 状态检查
2. notify rollout
3. 机器侧稳定性日检
4. firing / resolved drill
5. Slack 频道人工核对

## 方案

新增脚本：

- `scripts/ops/dingtalk-onprem-second-operator-drill.sh`

脚本只编排现有已验证命令，不引入新的远端行为：

- `set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status`
- `dingtalk-onprem-alert-notify-rollout.sh`
- `dingtalk-oauth-stability-check.sh`
- `dingtalk-onprem-alert-drill.sh`

最后从 JSON drill 结果中提取 `drillId`，明确提示第二操作者去 `#metasheet-alerts` 核对同一 `drillId` 的 firing / resolved。

由于 `dingtalk-onprem-alert-drill.sh` 在 JSON 模式下仍会输出进度日志，wrapper 按“抓取最后一行 JSON”解析 `drillId`，避免被前置日志干扰。

## 为什么保留手动 Slack 核对

第二操作者演练的目的不是再次证明脚本能跑，而是证明另一位操作者能在真实通知面中确认：

- 消息进入了正确频道
- firing / resolved 两条都出现
- drill id 能被人工追踪

因此 Slack 频道核对仍保留为手动步骤，不尝试自动读取 Slack UI。

## 通过标准

- `pnpm ops:onprem-alert-second-operator-drill` 成功退出
- 输出有效 `drillId`
- 第二操作者在 `#metasheet-alerts` 中确认同一 `drillId` 的 firing / resolved
- 7 天稳定观察清单引用该统一入口
