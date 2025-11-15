# Phase 2 部署指南

**文档版本**: 1.0
**创建日期**: 2025-11-03
**目标**: 指导 Phase 2 观察期部署和数据收集

---

## 📋 概述

Phase 2 是缓存策略的**观察期阶段**，目标是在真实生产环境中收集 1-2 周的缓存访问数据，用于识别高价值缓存候选模式，为 Phase 3 Redis 实现提供数据支持。

**关键特点**：
- ✅ 零性能影响：使用 NullCache（不实际缓存）
- ✅ 完整观察：记录所有缓存访问模式
- ✅ Prometheus 集成：所有指标自动导出
- ✅ 自动化工具：数据收集和分析脚本

---

## 🎯 Phase 2 目标

### 数据收集目标
- **时长**: 1-2 周连续观察
- **环境**: Staging → Production
- **指标**: 8 个缓存相关 Prometheus 指标
- **产出**: 缓存候选优先级排序

### 决策支持
通过数据回答：
1. 哪些数据访问模式最频繁？
2. 读写比率是多少？
3. 缓存能带来多大收益？
4. 应该为哪些模式实现缓存？

---

## 🚀 快速开始

### 前置条件

**必需**：
- ✅ Phase 1 已部署（NullCache + Prometheus metrics）
- ✅ Prometheus 服务器运行并抓取 `/metrics/prom`
- ✅ 有权限访问服务器和日志

**可选（推荐）**：
- Grafana 服务器（用于可视化）
- 告警系统（用于异常检测）

### 部署步骤

#### 1. 验证 Phase 1 基础

```bash
# 检查服务器健康状态
curl http://your-server:8900/health

# 验证缓存状态（应该显示 NullCache）
curl http://your-server:8900/internal/cache

# 确认 Prometheus 指标可用
curl http://your-server:8900/metrics/prom | grep cache_
```

**预期输出**：
```json
{
  "enabled": false,
  "implName": "NullCache",
  "registeredAt": "2025-11-03T...",
  "recentStats": {...}
}
```

#### 2. 部署数据收集脚本

```bash
# 复制脚本到服务器
scp scripts/collect-cache-metrics.sh your-server:/opt/metasheet/scripts/
scp scripts/monitor-cache-continuous.sh your-server:/opt/metasheet/scripts/

# 设置执行权限
ssh your-server "chmod +x /opt/metasheet/scripts/*.sh"
```

#### 3. 启动持续监控

```bash
# SSH 到服务器
ssh your-server

# 创建报告目录
mkdir -p /opt/metasheet/cache-reports

# 启动监控（每24小时收集一次）
nohup bash /opt/metasheet/scripts/monitor-cache-continuous.sh 24 /opt/metasheet/cache-reports > /dev/null 2>&1 &

# 记录进程ID
echo $! > /opt/metasheet/cache-reports/monitor.pid

# 验证运行状态
tail -f /opt/metasheet/cache-reports/monitoring.log
```

#### 4. 配置 Grafana Dashboard（可选）

```bash
# 导入 dashboard JSON
# 在 Grafana UI: Configuration → Data Sources → Add Prometheus
# 然后: Dashboards → Import → Upload grafana/dashboards/cache-observability-phase2.json
```

或使用 API：
```bash
curl -X POST http://grafana:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d @grafana/dashboards/cache-observability-phase2.json
```

---

## 📊 监控和验证

### 每日检查清单

**自动化检查**：
```bash
# 查看最新报告
ls -lht /opt/metasheet/cache-reports/*.md | head -5

# 检查监控日志
tail -n 50 /opt/metasheet/cache-reports/monitoring.log

# 验证进程运行
ps aux | grep monitor-cache-continuous
```

**指标验证**（Prometheus）：
```promql
# 检查是否有新数据
rate(cache_miss_total[5m])

# 查看top 10模式
topk(10, cache_miss_total{impl="null"})

# 计算优先级分数
(cache_miss_total * 10) / (1 + cache_set_total + cache_del_total)
```

### 异常处理

**问题**: 监控脚本停止
```bash
# 检查进程
cat /opt/metasheet/cache-reports/monitor.pid | xargs ps -p

# 如果不存在，重启
nohup bash /opt/metasheet/scripts/monitor-cache-continuous.sh 24 /opt/metasheet/cache-reports > /dev/null 2>&1 &
echo $! > /opt/metasheet/cache-reports/monitor.pid
```

**问题**: Prometheus 无数据
```bash
# 检查服务器是否正常运行
curl http://localhost:8900/health

# 检查 Prometheus 配置
# 确保有 scrape config 指向 your-server:8900/metrics/prom
```

---

## 📈 数据分析

### 手动分析报告

```bash
# 生成单次分析报告
bash scripts/collect-cache-metrics.sh 168 /opt/metasheet/cache-reports  # 7天数据

# 查看报告
cat /opt/metasheet/cache-reports/cache_analysis_*.md | less
```

### 报告解读

**优先级分数计算**：
```
Score = (Total_Misses * 10) / (1 + Total_Sets + Total_Deletes)
```

**分级标准**：
- 🔥 **HIGH** (>= 50): 立即实现 Redis 缓存
- 🟡 **MEDIUM** (20-50): 二期考虑
- 🔵 **LOW** (< 20): 可选或推迟

**示例输出**：
```markdown
| Pattern     | Misses | Sets | Deletes | R/W Ratio | Priority    |
|-------------|--------|------|---------|-----------|-------------|
| user        | 18000  | 1500 | 300     | 10.00     | 🔥 HIGH (100)  |
| department  | 6000   | 600  | 100     | 8.57      | 🔥 HIGH (85)   |
| spreadsheet | 5000   | 800  | 200     | 5.00      | 🟡 MEDIUM (50) |
```

### Grafana Dashboard

访问 Grafana 查看实时可视化：

**主要面板**：
1. **Cache Misses by Pattern** - 各模式访问趋势
2. **Operations Rate** - 每秒操作数
3. **Top 10 High-Frequency Patterns** - 高频模式排名
4. **Read/Write Ratio** - 读写比率分析
5. **Priority Score** - 缓存优先级实时计算
6. **Hourly Patterns Heatmap** - 24小时访问热图
7. **Candidates Summary Table** - 候选缓存汇总表

---

## 🎯 Phase 2 结束评估

### 数据收集完成标准

**最少要求**（7天）：
- ✅ 连续 7 天无中断数据
- ✅ 覆盖工作日和周末
- ✅ 至少 5 个不同的访问模式

**理想标准**（14天）：
- ✅ 连续 14 天数据
- ✅ 覆盖 2 个完整工作周
- ✅ 包含高峰和低谷时段

### 决策会议准备

**准备材料**：
1. 最新分析报告（`cache_analysis_*.md`）
2. Grafana dashboard 截图
3. 优先级排序列表
4. 成本收益估算

**讨论议题**：
- 哪些模式应该在 Phase 3 实现缓存？
- TTL 策略（每个模式的过期时间）
- 失效策略（何时清除缓存）
- Redis 基础设施成本
- 实施时间表

---

## 🔧 故障排查

### 常见问题

#### Q1: 指标数据为 0
**原因**: 应用未实际使用 CacheRegistry
**解决**: 检查业务代码是否调用 `cacheRegistry.get()`

#### Q2: 监控脚本报错 "jq not found"
**解决**:
```bash
# Ubuntu/Debian
sudo apt-get install jq

# CentOS/RHEL
sudo yum install jq

# macOS
brew install jq
```

#### Q3: Grafana 显示 "No data"
**检查清单**:
1. Prometheus 是否正常运行？
2. Prometheus 是否正确抓取指标？
3. 时间范围是否正确？
4. PromQL 查询是否正确？

#### Q4: 报告生成失败
**Debug**:
```bash
# 手动运行看详细错误
bash -x scripts/collect-cache-metrics.sh 24 /tmp/test-reports
```

---

## 📚 相关文档

- **Phase 1 实现**: `claudedocs/COMPLETE_SUCCESS_20251103.md`
- **架构设计**: `claudedocs/CACHE_DESIGN_INTEGRATION_REPORT.md`
- **Phase 2 计划**: `claudedocs/PHASE2_ACTION_PLAN.md`
- **Phase 3 准备**: 待完成数据收集后创建

---

## 🚦 阶段进展

### 当前状态: Phase 2 准备完成 ✅

- [x] Phase 1 已部署
- [x] 数据收集脚本已创建
- [x] Grafana dashboard 已配置
- [x] 监控工具已验证
- [ ] Staging 环境部署中...
- [ ] Production 环境部署待定
- [ ] 数据收集进行中...
- [ ] Phase 3 决策待定

### 下一里程碑

**Week 1-2**: 数据收集
**Week 3**: 数据分析和决策会议
**Week 4**: Phase 3 Redis 实现开始

---

## 📞 支持和联系

**技术问题**: 查看 GitHub Issues
**紧急故障**: 联系运维团队
**数据分析**: 联系架构团队

---

**文档维护**: 此文档应随 Phase 2 进展更新。

最后更新: 2025-11-03 15:40 CST
