# On-Prem Alertmanager Webhook Persistence

日期：2026-04-01

## 目标

为 `142.171.239.56` 这类 on-prem 主机提供可持久化的外部通知目标配置入口。

注意：该配置不是让 Alertmanager 直接调用第三方 webhook，而是供本地 `metasheet-alert-webhook` bridge 使用。

## 写入配置

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook \
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
```

## 查看状态

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status
```

## 清除配置

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --clear
```

`--clear` 会删除持久化文件。之后若未显式传 `ALERTMANAGER_WEBHOOK_URL`，notify rollout 会按 fallback 回退到本地默认 receiver。

## 应用配置

写入后，执行：

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

此时 rollout 会优先读取远端持久化配置，并把它注入到 `metasheet-alert-webhook`。Alertmanager 本身仍只向本地 bridge 发通用 webhook。
