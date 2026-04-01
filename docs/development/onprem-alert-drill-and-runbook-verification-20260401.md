# On-Prem Alert Drill And Runbook Verification

日期：2026-04-01

## 本地验证

```bash
bash -n scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
bash -n scripts/ops/dingtalk-onprem-alert-drill.sh
bash -n scripts/ops/verify-dingtalk-oauth-alert-notify.sh
python3 -m py_compile docker/observability/alertmanager/webhook-receiver.py
pnpm verify:dingtalk-oauth-alert-notify
git diff --check
```

结果：

- 全部通过

## 远端修复验证

### 修复前问题复核

在 `142.171.239.56` 上向 Alertmanager 注入一条走默认外部通知链的 synthetic alert，Alertmanager 返回：

- `unexpected status code 400 ... hooks.slack.com ... no_text`

这确认了根因：Alertmanager 通用 webhook payload 不能直接投递到 Slack Incoming Webhook。

### 修复后 rollout

```bash
pnpm ops:onprem-alert-notify-rollout
```

结果：

- `resolved external forward target source: remote-persisted`
- `PASS`

### firing / resolved lifecycle

```bash
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
```

结果：

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775020948",
  "firingObserved": true,
  "resolvedObserved": true
}
```

### bridge logs

远端 `metasheet-alert-webhook` 在 5 分钟内记录到了：

- `/notify` firing payload
- `/notify` resolved payload
- `drill_id=drill-1775020948`

同时远端 `metasheet-alertmanager` 最近 5 分钟未再出现：

- `Notify for alerts failed`
- `no_text`

### Slack 频道可见性

`#metasheet-alerts` 频道内实际可见：

- `[FIRING] DingTalkOAuthSlackChannelDrill ... drill_id=drill-1775020948`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ... drill_id=drill-1775020948`

这证明 Slack 正式通知链已经覆盖 firing 和 resolved 两种状态。

## 结论

**结论：on-prem alert drill 和 runbook 所依赖的技术链路已通过。**

当前正式能力包括：

- Alertmanager -> local bridge -> Slack channel
- persistent webhook config
- repeatable on-prem drill command
- firing / resolved 双消息确认
