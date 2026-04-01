# On-Prem Second-Operator Handoff Verification

日期：2026-04-01

## 执行命令

```bash
bash -n scripts/ops/dingtalk-onprem-second-operator-drill.sh
pnpm ops:onprem-alert-second-operator-drill
git diff --check
```

## 结果

### shell 语法

- `bash -n scripts/ops/dingtalk-onprem-second-operator-drill.sh`
- 通过

### 统一交接命令

- `pnpm ops:onprem-alert-second-operator-drill`
- 通过

执行链包含：

- persisted webhook 状态检查
- on-prem notify rollout
- 机器侧稳定性日检
- firing / resolved 正式 drill

最终输出 drill JSON，并明确打印人工核对提示：

- 打开 `#metasheet-alerts`
- 核对相同 `drillId`
- 同时出现 `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- 和 `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

wrapper 已兼容 `dingtalk-onprem-alert-drill.sh` 的“日志 + 最后一行 JSON”混合输出，不再要求子脚本必须输出纯 JSON。

本次实测 drill 结果：

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775023386",
  "firingObserved": true,
  "resolvedObserved": true
}
```

稳定性检查同时返回：

- `webhook.configured=True`
- `webhook.host=hooks.slack.com`
- `notifyErrors=0`
- `healthy=true`

### diff hygiene

- `git diff --check`
- 通过

## 结论

**结论：第二操作者演练已具备单命令交接入口。**

当前剩余的人因动作只剩：

- 由另一位真实操作者亲自执行该命令
- 在 Slack 频道完成人工确认
