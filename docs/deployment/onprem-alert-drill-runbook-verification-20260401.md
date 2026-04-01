# On-Prem Alert Drill Runbook Verification

日期：2026-04-01

## 目标主机

- `142.171.239.56`

## 实际执行

```bash
pnpm ops:onprem-alert-notify-rollout
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
```

## 实际结果

### rollout

- `resolved external forward target source: remote-persisted`
- `PASS`

### drill

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775020948",
  "firingObserved": true,
  "resolvedObserved": true
}
```

### bridge logs

远端 `metasheet-alert-webhook` 已记录：

- `/notify` firing
- `/notify` resolved

并带有相同 `drill_id=drill-1775020948`。

### Slack 频道

`#metasheet-alerts` 已见到：

- `[FIRING] DingTalkOAuthSlackChannelDrill ... drill_id=drill-1775020948`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ... drill_id=drill-1775020948`

## 结论

**结论：on-prem Alertmanager 正式 drill 与 runbook 通过。**
