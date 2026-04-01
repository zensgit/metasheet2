# On-Prem Alertmanager Webhook Persistence Verification

日期：2026-04-01

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | `142.171.239.56` |
| 用户 | `mainuser` |
| 配置文件 | `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env` |

## 执行命令

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

## 实际结果

### 1. 持久化配置写入

已通过 `set-dingtalk-onprem-alertmanager-webhook-config.sh` 把临时外部 Webhook.site URL 写入：

- `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env`

### 2. rollout 读取持久化配置

在未显式传入 `ALERTMANAGER_WEBHOOK_URL` 时，`dingtalk-onprem-alert-notify-rollout.sh` 已从远端持久化文件读取 webhook URL 并完成 rollout，实际输出：

```text
[onprem-alert-notify] resolved default receiver source: remote-persisted
```

### 3. 外部 webhook 命中

Webhook.site 实际捕获到：

```text
alertname=DingTalkOAuthExternalWebhookExercise
exercise_id=external-1775011925
user_agent=Alertmanager/0.27.0
ip=142.171.239.56
```

### 4. 恢复到无持久化配置

exercise 结束后已恢复为：

```text
configured=false
```

并且已确认：

- `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env` 不存在
- `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.yml` 中的 `default-webhook` 已回到 `http://alert-webhook:8080/notify`

## 结论

**结论：Alertmanager webhook 持久化配置能力已经在 on-prem 主机上真实成立。**
