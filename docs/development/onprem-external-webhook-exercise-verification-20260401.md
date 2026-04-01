# On-Prem External Webhook Exercise Verification

日期：2026-04-01

## 本轮变更

- 新增 `scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh`
- 更新 `package.json`
- 更新部署与索引文档

## 预期验证

### 本地

```bash
bash -n scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh
```

### 远端

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

预期：

1. 创建一次性 Webhook.site token
2. 远端临时覆盖 `ALERTMANAGER_WEBHOOK_URL`
3. `DingTalkOAuthExternalWebhookExercise` 被 Webhook.site 捕获
4. 本地默认 receiver 被恢复

## 实际结果

### 本地

实际通过：

```bash
bash -n scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh
git diff --check
```

### 远端

实际执行：

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

结果：

1. 成功创建一次性 Webhook.site token
2. 远端临时覆盖 `ALERTMANAGER_WEBHOOK_URL=https://webhook.site/<token>`
3. `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh` 仍然先通过本地 `local-test-webhook` 验链
4. 额外发送 `DingTalkOAuthExternalWebhookExercise`
5. Webhook.site `requests` API 命中该 exercise
6. 远端主机配置自动恢复为本地默认 receiver

### 关键证据

- Webhook.site 捕获到：
  - `alertname=DingTalkOAuthExternalWebhookExercise`
  - `exercise_id=external-1775011925`
  - `user_agent=Alertmanager/0.27.0`
  - `ip=142.171.239.56`
- exercise 结束后，`alertmanager.onprem.yml` 已恢复为：
  - `default-webhook -> http://alert-webhook:8080/notify`

## 结论

**结论：一次性外部 webhook exercise 通过。**

已确认：

1. 远端 Alertmanager 具备真实公网 webhook 投递能力
2. 当前仓库脚本可在不持久化第三方凭据的前提下完成外部 exercise
3. exercise 结束后会恢复本地默认 receiver，不会把临时 URL 留在主机上
