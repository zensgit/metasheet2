# Phase 5: 生产基线观察配置指南

**文档版本**: 1.0.0
**创建日期**: 2025-11-16
**状态**: 待启动

---

## 📋 观察目标

在生产或准生产环境进行 **2 小时基线观察**（12 个样本，每 10 分钟一次），确认以下关键指标：

| 指标 | 目标值 | 告警阈值 |
|------|--------|----------|
| **成功率** | ≥ 98% | < 95% |
| **Fallback 比例** | < 10% | > 15% |
| **P99 延迟** | < 2s | > 5s |
| **错误率** | < 2% | > 5% |

---

## 🔧 环境变量配置

### 必需配置

```bash
# .env 文件或环境变量

# ============================================
# 观察核心配置
# ============================================
METRICS_URL=http://your-prometheus-url:9090
# 示例：
# METRICS_URL=http://prometheus.prod.example.com:9090
# METRICS_URL=http://localhost:9090

# 观察参数
INTERVAL_SECONDS=600          # 采样间隔：10分钟
MAX_SAMPLES=12               # 最大样本数：12个 (2小时)
OBS_WINDOW_LABEL=phase5-prod-2h  # 观察窗口标签

# 输出目录
OUT_DIR=artifacts/phase5-baseline
```

### 可选配置

```bash
# Alerting (如需告警)
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
CREATE_GH_ISSUE=true
GH_REPO=zensgit/metasheet2

# 观察模式
OBS_MODE=baseline    # baseline | continuous | snapshot
VERBOSE_LOGGING=true
```

---

## 🚀 启动步骤

### 1. 验证 Prometheus 连接

```bash
# 测试连接
curl -s "$METRICS_URL/api/v1/status/build" | jq .

# 预期输出:
# {
#   "status": "success",
#   "data": {
#     "version": "2.x.x",
#     "revision": "...",
#     "branch": "HEAD"
#   }
# }
```

### 2. 验证核心指标可用

```bash
# 检查基础指标
curl -s "$METRICS_URL/api/v1/query?query=metasheet_http_requests_total" | jq .status

# 检查新增指标 (Phase 8-9)
curl -s "$METRICS_URL/api/v1/query?query=metasheet_plugin_reload_total" | jq .status
curl -s "$METRICS_URL/api/v1/query?query=metasheet_snapshot_create_total" | jq .status
```

### 3. 启动观察脚本

```bash
# 方式 1: 使用 npm script
npm run observe

# 方式 2: 直接运行
npx ts-node scripts/observe.ts

# 方式 3: 带参数运行
npx ts-node scripts/observe.ts \
  --url "$METRICS_URL" \
  --interval 600 \
  --samples 12 \
  --output artifacts/phase5-baseline
```

### 4. 监控进度

观察脚本会实时输出：

```
[2025-11-16T10:00:00Z] Sample 1/12 collected
  - HTTP Success Rate: 99.2%
  - Fallback Ratio: 3.1%
  - P99 Latency: 1.23s
  - Error Rate: 0.8%

[2025-11-16T10:10:00Z] Sample 2/12 collected
  ...
```

---

## 📊 需要监控的指标

### 核心 HTTP 指标

```promql
# 成功率
sum(rate(metasheet_http_requests_total{status=~"2.."}[5m])) /
sum(rate(metasheet_http_requests_total[5m])) * 100

# P99 延迟
histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m]))

# 错误率
sum(rate(metasheet_http_requests_total{status=~"5.."}[5m])) /
sum(rate(metasheet_http_requests_total[5m])) * 100
```

### 新增 Phase 8-9 指标

```promql
# 插件重载成功率
sum(metasheet_plugin_reload_total{result="success"}) /
sum(metasheet_plugin_reload_total) * 100

# 插件重载平均时长
avg(rate(metasheet_plugin_reload_duration_seconds_sum[5m]) /
    rate(metasheet_plugin_reload_duration_seconds_count[5m]))

# 快照创建成功率
sum(metasheet_snapshot_create_total{result="success"}) /
sum(metasheet_snapshot_create_total) * 100

# 快照恢复成功率
sum(metasheet_snapshot_restore_total{result="success"}) /
sum(metasheet_snapshot_restore_total) * 100

# 快照操作平均时长
avg(rate(metasheet_snapshot_operation_duration_seconds_sum[5m]) /
    rate(metasheet_snapshot_operation_duration_seconds_count[5m]))
```

### 系统健康指标

```promql
# RBAC 缓存命中率
sum(rbac_perm_cache_hits_total) /
(sum(rbac_perm_cache_hits_total) + sum(rbac_perm_cache_miss_total)) * 100

# 权限拒绝次数
sum(increase(metasheet_permission_denied_total[1h]))

# RPC 超时次数
sum(increase(metasheet_rpc_timeouts_total[1h]))

# 事件发送速率
sum(rate(metasheet_events_emitted_total[5m]))
```

---

## ✅ 验收标准

### 基线观察通过标准

| 检查项 | 通过标准 | 权重 |
|--------|----------|------|
| HTTP 成功率 | ≥ 98% 稳定 | 30% |
| P99 延迟 | < 2s，无异常峰值 | 25% |
| Fallback 比例 | < 10% | 15% |
| 错误率 | < 2%，无递增趋势 | 15% |
| 新指标上报 | 8 个新指标正常 | 10% |
| 系统稳定性 | 无 OOM/重启 | 5% |

**总分 ≥ 90% 视为通过**

### 新指标验证清单

```yaml
Phase 8 - 插件重载:
  - [ ] metasheet_plugin_reload_total 正常计数
  - [ ] metasheet_plugin_reload_duration_seconds 有数据
  - [ ] Grafana 仪表板显示正确

Phase 9 - Snapshot:
  - [ ] metasheet_snapshot_create_total 正常计数
  - [ ] metasheet_snapshot_restore_total 正常计数
  - [ ] metasheet_snapshot_operation_duration_seconds 有数据
  - [ ] Grafana 仪表板显示正确
```

---

## 📝 观察报告模板

观察完成后，脚本会生成报告：

```markdown
# Phase 5 Baseline Observation Report

## Summary
- Start Time: 2025-11-16 10:00:00
- End Time: 2025-11-16 12:00:00
- Total Samples: 12
- Overall Status: ✅ PASSED / ❌ FAILED

## Key Metrics
| Metric | Min | Max | Avg | Target | Status |
|--------|-----|-----|-----|--------|--------|
| Success Rate | 98.1% | 99.8% | 99.2% | ≥98% | ✅ |
| P99 Latency | 0.9s | 1.5s | 1.2s | <2s | ✅ |
| Fallback Ratio | 2.1% | 4.3% | 3.1% | <10% | ✅ |
| Error Rate | 0.2% | 1.1% | 0.8% | <2% | ✅ |

## New Metrics Validation
- Plugin Reload: ✅ Working
- Snapshot Operations: ✅ Working

## Recommendations
[Based on observations]
```

---

## 🚨 故障排除

### 常见问题

**1. METRICS_URL 连接失败**
```bash
# 检查网络连通性
curl -v "$METRICS_URL/api/v1/status/build"

# 检查防火墙
telnet your-prometheus-host 9090
```

**2. 指标不存在**
```bash
# 确认应用已启动并暴露指标
curl -s http://localhost:8900/metrics/prom | grep metasheet_

# 确认 Prometheus 抓取配置
# prometheus.yml:
# scrape_configs:
#   - job_name: 'metasheet'
#     static_configs:
#       - targets: ['metasheet-app:8900']
```

**3. 观察脚本报错**
```bash
# 检查 Node.js 版本
node --version  # 需要 >= 18

# 检查依赖
pnpm install
```

---

## 📂 输出文件

观察完成后，会在 `artifacts/phase5-baseline/` 生成：

```
artifacts/phase5-baseline/
├── baseline_report.md       # 完整观察报告
├── metrics_snapshot.json    # 原始指标数据
├── timeline.csv            # 时间序列数据
└── grafana_dashboard.json  # Grafana 仪表板配置
```

---

## 🎯 下一步

1. **观察通过后**:
   - 运行 `bash scripts/phase5-completion.sh`
   - 归档基线数据
   - 更新 ROADMAP Phase 5 状态

2. **观察未通过**:
   - 分析失败原因
   - 调整阈值或修复问题
   - 重新运行观察

3. **持续监控**:
   - 设置 Grafana 告警
   - 配置 Alertmanager 规则
   - 建立定期复查机制

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
