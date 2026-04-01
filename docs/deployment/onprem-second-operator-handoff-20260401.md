# On-Prem Second-Operator Handoff

日期：2026-04-01

## 目的

让第二位操作者在不依赖主操作者代执行的前提下，独立完成一次 DingTalk OAuth 告警链路演练。

## 单命令入口

```bash
pnpm ops:onprem-alert-second-operator-drill
```

## 这条命令会做什么

1. 打印远端持久化 webhook 状态
2. 应用 on-prem notify rollout
3. 执行机器侧稳定性日检
4. 触发一次 firing / resolved drill
5. 输出 `drillId`

## 操作者还需要手动做什么

进入 Slack 频道 `#metasheet-alerts`，确认同一 `drillId` 的两条消息：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

## 记录模板

- Operator:
- Date:
- Command result: PASS / FAIL
- Drill ID:
- Slack firing observed: YES / NO
- Slack resolved observed: YES / NO
- Notes:

## 失败时先查

1. `bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status`
2. `bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh`
3. `bash scripts/ops/dingtalk-oauth-stability-check.sh`
4. `docker logs metasheet-alertmanager`
5. `docker logs metasheet-alert-webhook`
