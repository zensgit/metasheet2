# OAuth State Monitoring Verification

日期：2026-04-01

## 本轮变更

- 新增 `ops/prometheus/dingtalk-oauth-alerts.yml`
- 新增 `docker/observability/grafana/dashboards/dingtalk-oauth-overview.json`
- 新增 `scripts/ops/verify-dingtalk-oauth-observability.sh`
- 更新 `docker/observability/docker-compose.yml`
- 更新 `docker/observability/prometheus/prometheus.yml`
- 更新 `docker/observability/README.md`
- 更新 `docs/deployment/dingtalk-oauth-backend-deploy-20260330.md`

## 实际验证

### 1. 验证脚本

```bash
bash scripts/ops/verify-dingtalk-oauth-observability.sh
pnpm verify:dingtalk-oauth-observability
```

预期：

- dashboard JSON 解析成功
- `docker compose config` 通过
- Prometheus rules lint 通过；若本机无 `promtool` 且无 Docker daemon，则退化为 YAML 结构校验

### 2. 独立 JSON / Compose / Rules 校验

```bash
node --input-type=module -e "JSON.parse(await import('node:fs').then(m => m.readFileSync(process.argv[1], 'utf8')))" docker/observability/grafana/dashboards/dingtalk-oauth-overview.json
docker compose -f docker/observability/docker-compose.yml config >/dev/null
docker run --rm -v \"$PWD/ops/prometheus:/rules:ro\" prom/prometheus:v2.48.0 promtool check rules /rules/phase5-recording-rules.yml /rules/phase5-alerts.yml /rules/attendance-alerts.yml /rules/dingtalk-oauth-alerts.yml
```

若本地没有 `promtool` 且 Docker daemon 未启动，验证脚本会退化为基于 `js-yaml` 的规则结构校验，至少保证：

- YAML 可解析
- `groups[]` 存在
- 每条规则都带 `alert` 或 `record`
- 每条规则都带 `expr`

## 人工复核点

- `docker/observability/prometheus/prometheus.yml` 已加载 `dingtalk-oauth-alerts.yml`
- `docker/observability/docker-compose.yml` 已挂载 `ops/prometheus/dingtalk-oauth-alerts.yml`
- Grafana dashboard 文件名、UID、标题与现有命名保持一致
- 部署文档已增加 dashboard / alert file / verify command 入口

## 实际结果

本机执行结果：

- `bash scripts/ops/verify-dingtalk-oauth-observability.sh`：通过
- `pnpm verify:dingtalk-oauth-observability`：通过
- `git diff --check`：通过

环境说明：

- 当前机器无可用 Docker daemon
- 当前机器未安装 `promtool`

因此 Prometheus rules 校验实际走的是脚本内置的 YAML 结构 fallback，同时：

- `docker compose -f docker/observability/docker-compose.yml config` 已通过
- compose 输出中已能看到 `dingtalk-oauth-alerts.yml` 被挂载到 `/etc/prometheus/rules/dingtalk-oauth-alerts.yml`

## 结论

**结论：通过。**

本轮已把 DingTalk OAuth state observability 从“只有指标”推进到“有 dashboard、有 alert rules、有正式验证入口”。
