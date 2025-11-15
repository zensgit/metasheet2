# plugin-telemetry-otel

OpenTelemetry 可观测性插件 - 为 MetaSheet V2 提供最小化的 Metrics 和 Tracing 功能

## ✨ 特性

- ✅ **Prometheus Metrics 导出** - 标准 `/metrics` 端点
- ✅ **HTTP 请求指标** - 请求数、延迟、错误率
- ✅ **默认禁用** - `FEATURE_OTEL=false` 安全启动
- ✅ **零依赖核心** - 不修改 core-backend 入口
- ✅ **轻量级** - 最小实现，仅核心功能

## 🚀 快速开始

### 启用插件

```bash
# 设置环境变量
export FEATURE_OTEL=true

# 启动服务
pnpm dev
```

### 访问 Metrics

```bash
# 访问 Prometheus metrics 端点（两种等价的端点，任选其一）
curl http://localhost:9464/metrics
curl http://localhost:9464/metrics/otel

# 示例输出：
# http_requests_total{method="GET",path="/api/users",status="200"} 42
# http_request_duration_seconds_sum{method="GET",path="/api/users"} 1.234
```

## 📦 安装

该插件已包含在 MetaSheet V2 插件系统中，无需额外安装。

```bash
# 安装依赖（如需开发）
cd plugins/plugin-telemetry-otel
pnpm install

# 构建
pnpm build

# 测试
pnpm test
```

## ⚙️ 配置

### 环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FEATURE_OTEL` | `false` | 是否启用 OpenTelemetry |
| `OTEL_SERVICE_NAME` | `metasheet-v2` | 服务名称（用于 tracing） |
| `OTEL_METRICS_PORT` | `9464` | Prometheus metrics 导出端口 |
| `OTEL_TRACE_SAMPLE_RATE` | `0.1` | Tracing 采样率 (0.0-1.0) |

### 示例配置

```bash
# .env
FEATURE_OTEL=true
OTEL_SERVICE_NAME=my-metasheet-instance
OTEL_METRICS_PORT=9464
OTEL_TRACE_SAMPLE_RATE=0.1
```

## 📊 可用 Metrics

### HTTP Metrics

- **`http_requests_total`** - HTTP 请求总数
  - Labels: `method`, `path`, `status`

- **`http_request_duration_seconds`** - HTTP 请求延迟分布
  - Labels: `method`, `path`
  - Buckets: `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]` 秒

- **`http_request_errors_total`** - HTTP 错误总数
  - Labels: `method`, `path`, `errorType`

## 🔌 集成 Prometheus

### prometheus.yml 配置（推荐使用 /metrics/otel 以避免命名冲突）

```yaml
scrape_configs:
  - job_name: 'metasheet-v2'
    static_configs:
      - targets: ['localhost:9464']
    metrics_path: /metrics/otel
    scrape_interval: 15s
    scrape_timeout: 10s
```

### 启动 Prometheus

```bash
# Docker 方式
docker run -d \
  -p 9090:9090 \
  -v ./prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus

# 访问 Prometheus UI
open http://localhost:9090
```

### 示例 PromQL 查询

```promql
# HTTP 请求速率（每秒）
rate(http_requests_total[5m])

# P95 延迟
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# 错误率
rate(http_request_errors_total[5m]) / rate(http_requests_total[5m])
```

## 🧪 测试

```bash
# 运行单元测试
pnpm test

# 运行 smoke 测试
FEATURE_OTEL=true pnpm test smoke.test.ts
```

## 🔧 开发指南

### 添加自定义 Metric

```typescript
// 在 src/metrics/index.ts 中添加
export function setupMetrics(): Metrics {
  // ... 现有代码

  const customMetric = new Counter({
    name: 'custom_events_total',
    help: 'Total custom events',
    labelNames: ['eventType'],
    registers: [registry]
  })

  return {
    // ... 现有 metrics
    customMetric
  }
}
```

### 插件生命周期

```typescript
// src/index.ts
export default class TelemetryOtelPlugin {
  async onLoad(context: PluginContext) {
    // 插件加载时调用
    // 初始化 metrics、注册路由
  }

  async onUnload() {
    // 插件卸载时调用
    // 清理资源
  }
}
```

## 🚨 故障排查

### 插件未启动

**问题**: 日志显示 "OpenTelemetry plugin is DISABLED"

**解决**:
```bash
export FEATURE_OTEL=true
```

### /metrics 或 /metrics/otel 端点返回 404

**问题**: 无法访问 `/metrics` 端点

**检查**:
1. 确认 `FEATURE_OTEL=true`
2. 确认插件已加载（查看启动日志）
3. 确认端口 `9464` 未被占用

### Metrics 为空

**问题**: `/metrics` 返回空数据

**原因**: 还没有 HTTP 请求产生数据

**测试**:
```bash
# 生成一些请求
for i in {1..10}; do
  curl http://localhost:8900/api/health
done

# 再次检查 metrics
curl http://localhost:9464/metrics
```

## 📖 参考资料

- [OpenTelemetry 官方文档](https://opentelemetry.io/docs/)
- [Prometheus 文档](https://prometheus.io/docs/)
- [prom-client GitHub](https://github.com/siimon/prom-client)

## 🛡️ 安全性

- ✅ 默认禁用 - 不会影响生产环境
- ✅ 无敏感数据 - Metrics 不包含个人信息
- ✅ 内部网络 - Metrics 端点应在防火墙后

## 📝 版本历史

### v1.0.0 (2025-11-03)

- ✨ 初始发布
- ✅ Prometheus metrics 导出
- ✅ HTTP 请求指标
- ✅ 功能开关支持

## 📄 许可证

MIT License - See LICENSE file for details

---

**维护者**: MetaSheet Team
**创建日期**: 2025-11-03
**最后更新**: 2025-11-03
