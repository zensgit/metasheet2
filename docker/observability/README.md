# MetaSheet V2 Observability Stack

本地开发环境的 Prometheus + Grafana 监控栈。

## 快速启动

```bash
# 启动观测栈
./scripts/observability-stack.sh up

# 检查状态
./scripts/observability-stack.sh status

# 停止服务
./scripts/observability-stack.sh down
```

## 访问地址

| 服务 | URL | 默认凭证 |
|------|-----|----------|
| Prometheus | http://localhost:9090 | - |
| Grafana | http://localhost:3000 | admin / admin |

## 前提条件

- Docker Desktop 已运行
- MetaSheet 后端运行在 `localhost:8900`

## 组件说明

### Prometheus
- 每 15 秒从 MetaSheet 后端抓取指标
- 数据保留 7 天
- 配置文件: `prometheus/prometheus.yml`

### Grafana
- 预配置 Prometheus 数据源
- 内置 MetaSheet Overview 仪表板
- 自动加载 `grafana/dashboards/` 目录下的 JSON 文件

## 自定义仪表板

1. 在 Grafana UI 中创建仪表板
2. 导出为 JSON
3. 保存到 `grafana/dashboards/` 目录
4. 重启服务后自动加载

## 监控指标

### 核心指标
- `metasheet_events_emitted_total` - 事件发布总数
- `metasheet_plugin_reload_total` - 插件重载次数
- `metasheet_plugin_reload_duration_seconds` - 插件重载耗时
- `metasheet_snapshot_create_total` - 快照创建数
- `metasheet_permission_denied_total` - 权限拒绝数
- `metasheet_db_pool_size` - 数据库连接池大小
- `metasheet_db_pool_waiting` - 等待连接数

### PromQL 示例

```promql
# 事件发布速率 (每分钟)
rate(metasheet_events_emitted_total[1m])

# 插件重载成功率
sum(metasheet_plugin_reload_total{status="success"}) / sum(metasheet_plugin_reload_total)

# P99 重载时间
histogram_quantile(0.99, metasheet_plugin_reload_duration_seconds_bucket)
```

## 故障排除

### Prometheus 无法抓取指标

检查后端是否运行:
```bash
curl http://localhost:8900/metrics/prom
```

如果在 Docker 内部，确保 `host.docker.internal` 能解析到主机。

### Grafana 数据源连接失败

确保 Prometheus 容器健康:
```bash
docker ps | grep metasheet-prometheus
```

### 数据卷清理

完全重置数据:
```bash
docker compose -f docker/observability/docker-compose.yml down -v
```

## 生产环境注意事项

此配置仅供本地开发使用。生产环境需要:
- 持久化存储 (非本地卷)
- 身份认证和授权
- 告警规则和通知
- 高可用部署
- 数据备份策略
