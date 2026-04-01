# On-Prem Grafana Alert Rollout Verification

日期：2026-04-01

## 本轮变更

- 新增 `docker/observability/prometheus/prometheus.onprem.yml`
- 新增 `docker/observability/docker-compose.onprem.yml`
- 新增 `scripts/ops/dingtalk-onprem-observability-rollout.sh`
- 更新 `docs/deployment/dingtalk-oauth-backend-deploy-20260330.md`
- 更新 `docs/verification-index.md`

## 预期验证

### 本地资产验证

```bash
pnpm verify:dingtalk-oauth-observability
git diff --check
```

### 远端 rollout

```bash
bash scripts/ops/dingtalk-onprem-observability-rollout.sh
```

预期：

1. 远端 `docker-compose.onprem.yml` 启动 `metasheet-prometheus` / `metasheet-grafana`
2. `http://127.0.0.1:9090/-/healthy` 返回成功
3. `http://127.0.0.1:3000/api/health` 返回成功
4. Prometheus target 中 `metasheet-backend` 为 `up`
5. Grafana API 搜索到 `dingtalk-oauth-overview`

## 实际结果

本机执行结果：

- `bash -n scripts/ops/dingtalk-onprem-observability-rollout.sh`：通过
- `pnpm verify:dingtalk-oauth-observability`：通过
- `pnpm ops:onprem-grafana-alert-rollout`：通过
- `docker compose -f docker/observability/docker-compose.onprem.yml config`：通过
- `git diff --check`：通过

过程中发现并修复了一个真实阻塞：

- `docker/observability/grafana/provisioning/datasources/` 下同时存在
  - `prometheus.yml`
  - `datasource.yml`
- 两者都声明 `isDefault: true`
- 结果是 Grafana 在远端启动时因 datasource provisioning 冲突而 crash

已处理方式：

1. 删除仓库中的遗留 `datasource.yml`
2. 在 `verify-dingtalk-oauth-observability.sh` 中新增“默认 datasource 只能有一个”的门禁
3. 在 `dingtalk-onprem-observability-rollout.sh` 中显式清理远端旧 `datasource.yml`

结论：

**本轮 on-prem Grafana / alert rollout 资产验证通过。**
