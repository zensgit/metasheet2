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

### 单人冷启动模拟

在当前只有单一维护者的前提下，补充执行了一次“单人模拟第二操作者”：

```bash
env -i HOME="$HOME" PATH="$PATH" SHELL=/bin/zsh TERM=xterm-256color /bin/zsh -lc \
  'cd /Users/huazhou/Downloads/Github/metasheet2 && pnpm ops:onprem-alert-second-operator-drill'
```

结果：

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775024157",
  "firingObserved": true,
  "resolvedObserved": true
}
```

随后在 Slack 频道 `#metasheet-alerts` 中独立核对到同一 `drillId=drill-1775024157` 的两条消息：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

该结果证明 runbook 和单命令 wrapper 已足够支持冷启动自交接，但仍不等价于另一位真实人员的交接演练。

### diff hygiene

- `git diff --check`
- 通过

## 结论

**结论：第二操作者演练已具备单命令交接入口。**

当前剩余的人因动作只剩：

- 条件允许时，由另一位真实操作者亲自执行该命令
- 在 Slack 频道完成人工确认
