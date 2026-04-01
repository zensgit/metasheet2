# On-Prem Alertmanager Webhook Persistence

日期：2026-04-01

## 目标

为 `142.171.239.56` 这类 on-prem 主机提供可持久化的 Alertmanager 外部 webhook 配置入口。

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

仅当你希望删除持久化文件、完全回退到 rollout 的纯 fallback 行为时才需要 `--clear`。

## 恢复安全默认值

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --set-local-default
```

## 应用配置

写入后，执行：

```bash
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

此时 rollout 会优先读取远端持久化配置，而不是回退到本地默认 receiver。
