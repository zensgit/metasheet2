# On-Prem Alert Drill Runbook

日期：2026-04-01

## 正式目标

- 主机：`142.171.239.56`
- Slack App：`Metasheet Alerts`
- 正式频道：`#metasheet-alerts`

## 1. 查看当前外部通知配置

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status
```

期望：

- `configured=true`
- `host=hooks.slack.com`

## 2. 应用 notify rollout

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

期望：

- 输出 `resolved external forward target source: remote-persisted`
- 最终输出 `PASS`

## 3. 触发一次正式 drill

```bash
pnpm ops:onprem-alert-drill
```

期望：

- 输出 `drillId=...`
- `firingObserved=true`
- `resolvedObserved=true`

### 第二操作者快捷入口

如需让第二操作者按统一顺序完成 status / rollout / 日检 / drill，可直接执行：

```bash
pnpm ops:onprem-alert-second-operator-drill
```

该命令会输出最终 `drillId=...`，再到 `#metasheet-alerts` 手动核对 firing / resolved。

## 4. 在 Slack 频道核对

进入 `#metasheet-alerts`，确认同一 `drillId` 对应两条消息：

- `[FIRING] DingTalkOAuthSlackChannelDrill ...`
- `[RESOLVED] DingTalkOAuthSlackChannelDrill ...`

若只出现 firing，没有出现 resolved，需继续检查：

- Alertmanager `send_resolved`
- Alert 过期时间
- `metasheet-alert-webhook` 日志

## 5. 轮换正式 webhook

写入新的正式 webhook：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/new/webhook \
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

再重新执行一次第 3 步和第 4 步。

## 6. 清除正式 webhook

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --clear
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

清除后：

- Alertmanager 仍会把 payload 发到本地 bridge
- bridge 仅记录日志，不再向外部 Slack 发送

## 7. 常见故障

### `configured=false`

说明远端没有持久化 webhook，需要重新写入正式 webhook。

### Alertmanager 日志出现 `no_text`

说明仍然存在直连 Slack 的旧配置，或 bridge 没有成功 rollout。重新执行：

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

并检查 `alertmanager.onprem.yml` 是否仍然把 `default-webhook` 指向 `alert-webhook:8080/notify`。

### Slack 没有 resolved 消息

优先检查：

- `pnpm ops:onprem-alert-drill` 是否真的观察到了 resolved
- `pnpm ops:onprem-alert-second-operator-drill` 是否输出了 drillId
- `docker logs metasheet-alert-webhook` 是否有 `/notify` resolved payload
- Slack 频道是否筛掉了较早消息
