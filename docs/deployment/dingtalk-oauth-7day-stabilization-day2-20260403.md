# DingTalk OAuth 7-Day Stabilization Day 2

日期：2026-04-03

## Day 2 执行摘要

Day 2 没有出现 Day 1 的容器缺失事件，但观察过程中暴露出一个真实的 checker 契约问题：

- backend `/health` 返回 `status=ok`
- 稳定性检查脚本只接受 `ok=true`

导致初次日检出现 false negative。该问题已在观察分支内修复，并在同日重跑检查后收口。

为加速收敛，这一天还额外执行了一次受控重启验证：

- 不切换镜像
- 直接用当时线上正在运行的 backend/web 镜像
- 按标准 `docker run` 参数重建 `metasheet-backend` / `metasheet-web`
- 重启后立刻重跑日检和正式 drill

## Day 2 执行命令

```bash
pnpm ops:dingtalk-oauth-stability-check
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
pnpm ops:dingtalk-oauth-stability-check

# Controlled restart validation
ssh mainuser@142.171.239.56 '<standard docker run recreation with current images>'
pnpm ops:dingtalk-oauth-stability-check
JSON_OUTPUT=true pnpm ops:onprem-alert-drill
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

### 1b. 加速验证 drill（受控重启后）

```json
{
  "alertName": "DingTalkOAuthSlackChannelDrill",
  "drillId": "drill-1775177800",
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

### 5. 受控重启验证

受控重启使用的线上镜像：

- backend: `ghcr.io/zensgit/metasheet2-backend:f9408cf720ab5d988f10a2ec8cafa55cc91c55ed`
- web: `ghcr.io/zensgit/metasheet2-web:f9408cf720ab5d988f10a2ec8cafa55cc91c55ed`

受控重启后直接复验：

- `/metasheet-backend` `restart=unless-stopped`
- `/metasheet-web` `restart=unless-stopped`
- `GET http://127.0.0.1:8900/health` → `status=ok`
- `GET http://127.0.0.1:8081/login` → `200`
- 其后再跑一次正式 drill，`drill-1775177800` 仍然得到 `firingObserved=true / resolvedObserved=true`

## Slack 核对

本轮自动化上下文中的 Playwright 浏览器没有现成 Slack 登录态，因此未在浏览器里直接重放人工核对。

但同一 `drill_id=drill-1775176647` 的两条 bridge 事件已在远端 `metasheet-alert-webhook` 日志中确认收到：

- `status=firing`
- `status=resolved`

## Day 2 结论

**结论：Day 2 通过。**

当天没有出现新的 on-prem 容器生命周期异常；唯一问题是稳定性检查脚本对 `/health` 契约的假阴性，已在当日修复。额外的受控重启验证也通过，说明当前 runbook 在不换镜像的前提下可以稳定重建 app 容器并保持 OAuth/alert 链路健康。
