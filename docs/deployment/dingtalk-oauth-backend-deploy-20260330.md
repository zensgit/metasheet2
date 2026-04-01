# DingTalk OAuth Backend 部署清单

日期：2026-03-30

## 前提

本次部署的功能为 DingTalk OAuth 登录。如果不需要启用 DingTalk 登录，可以不配置以下环境变量——系统会自动降级，登录页不显示钉钉登录按钮。

## 1. 环境变量

在服务端运行环境中配置：

```bash
DINGTALK_CLIENT_ID=<DingTalk 应用 AppKey>
DINGTALK_CLIENT_SECRET=<DingTalk 应用 AppSecret>
DINGTALK_REDIRECT_URI=https://<your-domain>/auth/dingtalk/callback
```

**注意**：
- `DINGTALK_REDIRECT_URI` 必须与 DingTalk 开放平台应用配置中的回调地址完全一致
- 三个变量任一缺失时，`/api/auth/dingtalk/launch` 返回 503，前端自动隐藏钉钉登录按钮

## 1.1 OAuth state 存储

推荐同时配置 Redis，使 DingTalk OAuth `state` 在多实例和重启场景下保持可验证：

```bash
REDIS_URL=redis://<host>:6379
```

如果没有 `REDIS_URL`，也可以使用现有的拆分变量：

```bash
REDIS_HOST=<host>
REDIS_PORT=6379
REDIS_PASSWORD=<optional>
```

未配置 Redis 或 Redis 短时不可用时，系统会自动回退到进程内存储。回退模式在单实例部署下可工作，但服务重启后 state 会失效，多实例部署也无法跨进程共享。

## 2. 数据库（可选）

如果需要通过 `dingtalk_open_id` 关联已有用户，执行：

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS dingtalk_open_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_dingtalk_open_id ON users (dingtalk_open_id) WHERE dingtalk_open_id IS NOT NULL;
```

如果不执行此迁移，DingTalk 登录仍可工作——系统会通过 email 匹配已有用户或创建新用户，但无法按 DingTalk OpenID 直接关联。

## 3. 构建与部署

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## 4. 验证

### 自动验证

```bash
node scripts/dingtalk-oauth-smoke.mjs --base-url http://localhost:7778
```

该脚本验证：
1. `GET /api/auth/dingtalk/launch` 可达（200 或 503）
2. `POST /api/auth/dingtalk/callback` 缺 code → 400
3. `POST /api/auth/dingtalk/callback` 错误 state → 400

### 可观测性检查

若服务已暴露 Prometheus 指标，可进一步确认 DingTalk OAuth state observability：

```bash
pnpm verify:dingtalk-oauth-observability
curl -s http://localhost:7778/metrics/prom | grep 'metasheet_dingtalk_oauth_state_'
curl -s http://localhost:7778/metrics/prom | grep 'redis_operation_duration_seconds'
```

应至少能看到：

- `metasheet_dingtalk_oauth_state_operations_total`
- `metasheet_dingtalk_oauth_state_fallback_total`

其中 `redis_operation_duration_seconds` 会带 DingTalk OAuth 专用 `op` 标签：

- `dingtalk_oauth_state_write`
- `dingtalk_oauth_state_validate`

本地 observability 资产位置：

- Prometheus alerts: `ops/prometheus/dingtalk-oauth-alerts.yml`
- Grafana dashboard: `docker/observability/grafana/dashboards/dingtalk-oauth-overview.json`

若使用仓库自带 observability stack：

```bash
./scripts/observability-stack.sh up
```

然后在 Grafana 中查看：

- `DingTalk OAuth Overview`

若目标是 on-prem Docker 主机，请改用专用 rollout：

```bash
bash scripts/ops/dingtalk-onprem-observability-rollout.sh
```

对应部署说明：

- `docs/deployment/onprem-grafana-alert-rollout-20260401.md`

若需要把 DingTalk OAuth 告警从“可见”推进到“可通知”，再执行：

```bash
pnpm verify:dingtalk-oauth-alert-notify
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

默认 rollout 只建立本地 bridge。若要接通正式外部通知目标，先写入长期 webhook：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook \
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

bridge 会把 Alertmanager 的通用 webhook payload 转成 Slack `text` 消息，避免 Slack Incoming Webhook 的 `no_text` 错误。

对应部署说明：

- `docs/deployment/onprem-alertmanager-webhook-rollout-20260401.md`
- `docs/deployment/onprem-alertmanager-webhook-persistence-20260401.md`

若尚未准备长期外部 webhook，但要确认公网 webhook 投递能力，可执行：

```bash
pnpm verify:dingtalk-oauth-alert-notify:webhooksite
```

对应验证记录：

- `docs/deployment/onprem-external-webhook-exercise-verification-20260401.md`

若已准备正式 webhook，并希望作为 on-prem 长期配置保留：

```bash
ALERTMANAGER_WEBHOOK_URL=https://example.com/your/webhook \
bash scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash scripts/ops/dingtalk-onprem-alert-notify-rollout.sh
```

对应部署说明：

- `docs/deployment/onprem-alertmanager-webhook-persistence-20260401.md`

### 手动验证

1. 不配置 DingTalk 环境变量时：
   - 访问登录页，不应出现"钉钉登录"按钮
   - `GET /api/auth/dingtalk/launch` 应返回 503

2. 配置 DingTalk 环境变量后：
   - 访问登录页，应显示"钉钉登录"按钮
   - 点击按钮，应跳转到 DingTalk 授权页
   - 授权后回调，应完成登录并跳转到首页

## 5. 回滚

1. 移除 DingTalk 环境变量即可禁用此功能
2. 前端会自动隐藏钉钉登录按钮
3. 已通过 DingTalk 登录创建的用户不受影响，可通过邮箱密码登录（需管理员设置密码）
