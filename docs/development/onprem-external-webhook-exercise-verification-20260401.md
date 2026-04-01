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
2. 远端临时写入持久化 `ALERTMANAGER_WEBHOOK_URL`
3. `DingTalkOAuthExternalWebhookExercise` 被 Webhook.site 捕获
4. 持久化配置被清除，主机恢复到 `configured=false`

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
2. 远端临时写入持久化 `ALERTMANAGER_WEBHOOK_URL=https://webhook.site/<token>`
3. `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh` 仍然先通过本地 `local-test-webhook` 验链，并实际输出 `resolved default receiver source: remote-persisted`
4. 额外发送 `DingTalkOAuthExternalWebhookExercise`
5. Webhook.site `requests` API 命中该 exercise
6. 远端主机持久化配置自动清除，`--print-status` 返回 `configured=false`

### 关键证据

- Webhook.site 捕获到：
  - `alertname=DingTalkOAuthExternalWebhookExercise`
  - `exercise_id=external-1775014044`
  - `user_agent=Alertmanager/0.27.0`
  - `ip=142.171.239.56`
- exercise 结束后，当前远端状态为：
  - `configured=false`
  - `alertmanager.onprem.env` 已不存在
- 再次执行 notify rollout 时，`alertmanager.onprem.yml` 会按 fallback 恢复为：
  - `default-webhook -> http://alert-webhook:8080/notify`

## 结论

**结论：一次性外部 webhook exercise 通过。**

已确认：

1. 远端 Alertmanager 具备真实公网 webhook 投递能力
2. 当前仓库脚本可在不持久化第三方凭据的前提下完成外部 exercise
3. exercise 结束后会清除持久化配置，不会把临时 URL 留在主机上；后续 notify rollout 会再回到本地默认 receiver
