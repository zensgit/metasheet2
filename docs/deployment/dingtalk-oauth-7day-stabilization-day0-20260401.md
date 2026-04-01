# DingTalk OAuth 7-Day Stabilization Day 0

日期：2026-04-01

## 背景

Day 0 作为稳定观察窗口的基线。此时已完成：

- on-prem OAuth state Redis rollout
- Slack 正式频道 `#metasheet-alerts`
- Alertmanager -> local bridge -> Slack 正式通知链
- firing / resolved drill runbook

## 执行命令

```bash
bash scripts/ops/dingtalk-oauth-stability-check.sh
JSON_OUTPUT=true bash scripts/ops/dingtalk-oauth-stability-check.sh
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
```

## 结果

### 机器侧日检

- `health.status=ok`
- `plugins=11`
- `webhook.configured=true`
- `webhook.host=hooks.slack.com`
- `alertmanager.notifyErrorsLastWindow=0`
- `bridge.notifyEventsLastWindow=2`
- `bridge.resolvedEventsLastWindow=1`
- `healthy=true`

### Metrics 样本

已看到：

- `metasheet_dingtalk_oauth_state_operations_total`
- `metasheet_dingtalk_oauth_state_fallback_total`
- `redis_operation_duration_seconds{op="dingtalk_oauth_state_write|validate"}`

Day 0 未见非零 fallback 样本，符合当前预期。

### 正式 drill

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775020948",
  "firingObserved": true,
  "resolvedObserved": true
}
```

### Slack 频道

`#metasheet-alerts` 已看到同一 `drillId=drill-1775020948` 的两条消息：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

## Day 0 结论

**结论：Day 0 baseline established.**

当前没有看到：

- Redis fallback
- Alertmanager `Notify for alerts failed`
- Slack `no_text`
- firing / resolved 缺失
