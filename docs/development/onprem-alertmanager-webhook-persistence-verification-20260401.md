# On-Prem Alertmanager Webhook Persistence Verification

日期：2026-04-01

## 本轮变更

- 新增 `docker/observability/alertmanager/alertmanager.onprem.env.example`
- 新增 `scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh`
- 更新 `scripts/ops/dingtalk-onprem-alert-notify-rollout.sh`
- 更新 `scripts/ops/verify-dingtalk-oauth-alert-notify.sh`
- 更新 `scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh`
- 更新部署与索引文档

## 预期验证

### 本地

```bash
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash -n scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh
pnpm verify:dingtalk-oauth-alert-notify
git diff --check
```

### 远端

```bash
pnpm ops:set-onprem-alertmanager-webhook-config --print-status
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
pnpm ops:set-onprem-alertmanager-webhook-config --print-status
```

预期：

1. 远端可写入/清除持久化 webhook 配置
2. notify rollout 在未显式传环境变量时也能读取远端持久化配置
3. 外部 webhook exercise 通过后，远端应恢复为“无持久化配置”，再由 rollout 回退到本地默认 receiver

## 实际结果

### 本地

实际通过：

```bash
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash -n scripts/ops/verify-dingtalk-oauth-alert-notify-webhooksite.sh
pnpm verify:dingtalk-oauth-alert-notify
git diff --check
```

### 远端

实际通过：

```bash
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh --print-status
```

结果：

1. 远端可通过 `set-dingtalk-onprem-alertmanager-webhook-config.sh` 写入持久化 webhook URL
2. `dingtalk-onprem-alert-notify-rollout.sh` 在未传 `ALERTMANAGER_WEBHOOK_URL` 时已能读取远端持久化配置，实际输出 `resolved default receiver source: remote-persisted`
3. Webhook.site exercise 命中真实 Alertmanager 外发请求
4. Webhook.site 实际捕获到：
   - `alertname=DingTalkOAuthExternalWebhookExercise`
   - `exercise_id=external-1775014044`
   - `user_agent=Alertmanager/0.27.0`
   - `ip=142.171.239.56`
5. exercise 结束后，远端持久化配置已被清除，再次 `--print-status` 返回 `configured=false`
6. 远端 `/home/mainuser/metasheet2/docker/observability/alertmanager/alertmanager.onprem.env` 已不存在；当前渲染文件中的 `default-webhook` 已回到 `http://alert-webhook:8080/notify`

## 结论

**结论：`onprem-alertmanager-webhook-persistence` 通过。**
