# On-Prem External Webhook Exercise Verification

日期：2026-04-01

## 目标环境

| 项 | 值 |
|----|-----|
| 主机 | `142.171.239.56` |
| 用户 | `mainuser` |
| Alertmanager 访问 | `127.0.0.1:9093` |
| 方式 | 临时外部 Webhook.site 端点 |

## 执行命令

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

## 实际结果

### 1. 外部端点

本轮使用一次性 Webhook.site 端点完成验证，token 已临时生成并使用，exercise 结束后不再保留到主机配置中。

### 2. 外部投递命中

Webhook.site 实际收到来自目标主机的 POST：

```text
alertname=DingTalkOAuthExternalWebhookExercise
exercise_id=external-1775011925
user_agent=Alertmanager/0.27.0
ip=142.171.239.56
```

### 3. 目标主机恢复状态

exercise 结束后再次确认：

- `metasheet-alertmanager` healthy
- `metasheet-alert-webhook` healthy
- `metasheet-prometheus` healthy
- `metasheet-grafana` healthy
- `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env` 已恢复成本地默认 `http://alert-webhook:8080/notify`

## 结论

**结论：on-prem 外部 webhook exercise 通过。**

当前已能证明：

1. Alertmanager 到外部 webhook 的真实出站网络可用
2. 目标主机可在短时覆盖外部 URL 后恢复到本地默认 receiver
3. 若后续提供长期 Slack / DingTalk / Feishu webhook，可直接复用同一 rollout 路径
