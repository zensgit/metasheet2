# DingTalk OAuth 7-Day Stabilization Day 2

日期：2026-04-03

## Day 2 执行摘要

Day 2 没有出现 Day 1 的容器缺失事件，但观察过程中暴露出一个真实的 checker 契约问题：

- backend `/health` 返回 `status=ok`
- 稳定性检查脚本只接受 `ok=true`

导致初次日检出现 false negative。该问题已在观察分支内修复，并在同日重跑检查后收口。

## Day 2 执行命令

```bash
pnpm ops:dingtalk-oauth-stability-check
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
pnpm ops:dingtalk-oauth-stability-check
```

## 结果

### 1. 正式 drill

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775176647",
  "firingObserved": true,
  "resolvedObserved": true
}
```

### 2. Bridge / Alertmanager

- `alertmanager.activeAlerts=0`
- `notifyErrors=0`
- `bridge.notifyEventsLastWindow >= 1`
- `bridge.resolvedEventsLastWindow >= 1`

### 3. Health 契约修复前

- `health.status=ok`
- `health.ok=None`
- `healthy=false`

### 4. Health 契约修复后

重跑 checker 后，`status=ok` 不再被误判为失败；Day 2 机器侧检查按实际状态收口。

## Slack 核对

本轮自动化上下文中的 Playwright 浏览器没有现成 Slack 登录态，因此未在浏览器里直接重放人工核对。

但同一 `drill_id=drill-1775176647` 的两条 bridge 事件已在远端 `metasheet-alert-webhook` 日志中确认收到：

- `status=firing`
- `status=resolved`

## Day 2 结论

**结论：Day 2 通过。**

当天没有出现新的 on-prem 容器生命周期异常；唯一问题是稳定性检查脚本对 `/health` 契约的假阴性，已在当日修复。
