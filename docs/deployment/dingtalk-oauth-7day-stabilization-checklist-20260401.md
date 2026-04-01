# DingTalk OAuth 7-Day Stabilization Checklist

日期：2026-04-01

## 目标

在 `2026-04-01` 到 `2026-04-07` 的稳定观察窗口内，用固定步骤确认 DingTalk OAuth、Redis state、Alertmanager 和 Slack 通知链保持健康。

## 每日固定动作

### 1. 机器侧日检

```bash
bash scripts/ops/dingtalk-oauth-stability-check.sh
```

期望：

- `health.status=ok`
- `webhook.configured=true`
- `webhook.host=hooks.slack.com`
- `alertmanager.notifyErrors=0`
- `healthy=true`

### 2. 正式 drill

```bash
pnpm ops:onprem-alert-drill
```

期望：

- `firingObserved=true`
- `resolvedObserved=true`

### 3. Slack 频道人工核对

在 `#metasheet-alerts` 中确认同一 `drillId` 同时出现：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

### 4. 观察项记录

每天记录：

- 是否出现 Redis fallback
- 是否出现 Alertmanager `Notify for alerts failed`
- 是否出现 Slack 重复报、漏报、只 firing 不 resolved
- 是否有误报或噪声过高

## 第二操作者演练

在 7 天窗口内至少安排一次第二操作者独立执行：

```bash
pnpm ops:onprem-alert-second-operator-drill
```

并由其在 `#metasheet-alerts` 中核对相同 `drillId` 的 firing / resolved。

若当前只有单一维护者，可先做一次“冷启动自交接模拟”，并在备注中标记：

- `simulated handoff`
- 使用全新 shell / 新浏览器会话
- 不依赖历史命令

## 通过标准

7 天窗口结束时满足：

1. 每天日检 `healthy=true`
2. 每天 drill 都有 firing / resolved
3. `#metasheet-alerts` 无持续性误报 / 漏报
4. 第二操作者演练成功

## 记录模板

| Day | Date | Machine Check | Drill | Slack Check | Fallback | Notify Errors | Notes |
|-----|------|---------------|-------|-------------|----------|---------------|-------|
| 0 | 2026-04-01 | PASS | PASS | PASS | 0 | 0 | Baseline established |
| 1 | 2026-04-02 |  |  |  |  |  |  |
| 2 | 2026-04-03 |  |  |  |  |  |  |
| 3 | 2026-04-04 |  |  |  |  |  |  |
| 4 | 2026-04-05 |  |  |  |  |  |  |
| 5 | 2026-04-06 |  |  |  |  |  |  |
| 6 | 2026-04-07 |  |  |  |  |  |  |
