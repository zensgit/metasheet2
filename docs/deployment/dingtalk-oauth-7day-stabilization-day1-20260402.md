# DingTalk OAuth 7-Day Stabilization Day 1

日期：2026-04-02

## Day 1 执行摘要

Day 1 初始日检未通过，原因不是应用逻辑回归，而是 on-prem `metasheet-backend` 与 `metasheet-web` 容器在观察窗口开始时已不存在，导致：

- `http://127.0.0.1:8900/health` 连接拒绝
- `http://127.0.0.1:8081/login` 连接拒绝

随后按既有 on-prem docker run 标准参数恢复容器，再重新执行 Day 1 日检和正式 drill。

## 恢复动作

恢复使用的镜像：

- backend: `ghcr.io/zensgit/metasheet2-backend:dingtalk-rollout-20260401-01ad02964`
- web: `ghcr.io/zensgit/metasheet2-web:dingtalk-rollout-20260330-d619b560d`

恢复后确认：

- `curl http://127.0.0.1:8900/health` 返回 `200`
- `curl http://127.0.0.1:8081/login` 返回 `200`
- `curl http://127.0.0.1:8081/api/auth/dingtalk/launch` 返回 `200`

## Day 1 执行命令

```bash
pnpm ops:dingtalk-oauth-stability-check
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
```

## 结果

### 机器侧日检

- `health.status=ok`
- `plugins=11`
- `webhook.configured=true`
- `webhook.host=hooks.slack.com`
- `alertmanager.activeAlerts=0`
- `alertmanager.notifyErrorsLastWindow=0`
- `bridge.notifyEventsLastWindow=2`
- `bridge.resolvedEventsLastWindow=1`
- `metrics.operations=1`
- `metrics.fallback=0`
- `metrics.redis=2`
- `healthy=true`

### 正式 drill

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775088625",
  "firingObserved": true,
  "resolvedObserved": true
}
```

### Slack 频道核对

在 `#metasheet-alerts` 中已核对到同一 `drill_id=drill-1775088625` 的两条消息：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

## Day 1 结论

**结论：Day 1 最终通过，但记录一次“容器缺失后按 runbook 恢复”的真实运维事件。**

该事件说明 7 天稳定观察仍有价值，后续几天需要继续关注：

- backend/web 容器是否再次意外消失
- `--restart unless-stopped` 是否被宿主机上的其他操作绕过
- 日检是否再次出现连接拒绝

后续 investigation 已补充结论：

- 不是宿主机 reboot
- 不是 Docker daemon shutdown
- 最可信根因是 `2026-04-01 17:45 UTC` 左右发生过一次批量手工 Docker stop/delete 或不受支持 rollout 动作
- 具体 actor / 具体命令未能从现有 history 中恢复

详见：

- `docs/development/onprem-container-lifecycle-investigation-design-20260402.md`
- `docs/development/onprem-container-lifecycle-investigation-verification-20260402.md`
