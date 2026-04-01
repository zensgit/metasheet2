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
pnpm ops:set-onprem-alertmanager-webhook-config --set-local-default
```

预期：

1. 远端可写入/恢复持久化 webhook 配置
2. notify rollout 在未显式传环境变量时也能读取远端持久化配置
3. 外部 webhook exercise 通过后，远端能恢复到本地默认 receiver

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
2. `dingtalk-onprem-alert-notify-rollout.sh` 在未传 `ALERTMANAGER_WEBHOOK_URL` 时已能读取远端持久化配置
3. Webhook.site exercise 命中真实 Alertmanager 外发请求
4. exercise 结束后，远端持久化配置被恢复为本地默认 `http://alert-webhook:8080/notify`
5. 最终 `--print-status` 返回：
   - `configured=true`
   - `scheme=http`
   - `host=alert-webhook:8080`

## 结论

**结论：`onprem-alertmanager-webhook-persistence` 通过。**
