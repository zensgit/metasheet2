# Phase 2 Action Plan - Cache Data Collection

**创建日期**: 2025-11-03
**执行时间**: 1-2 周
**前置条件**: Phase 1 已完成并合并到 main

---

## Quick Start - 立即执行

### Step 1: 验证 Phase 1 部署 (5分钟)

```bash
# 切换到项目目录
cd /path/to/metasheet-v2

# 确认在 main 分支
git branch
git status

# 确认最新代码
git log --oneline -3
```

**预期输出**:
```
* e7d1931f docs: Final Success Report for Cache Phase 1 (#349)
* a176bf3f docs: Cache Phase 1 completion documentation (#348)
* 5514752d feat(cache): Phase 1 - Observability Foundation (#347)
```

### Step 2: 启动开发服务器验证 (2分钟)

```bash
# 启动服务器
cd packages/core-backend
env DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2' \
    JWT_SECRET='dev-secret-key' \
    API_ORIGIN=http://localhost:8900 \
    pnpm dev
```

**验证检查**:
```bash
# 新终端窗口
# 1. Health check
curl http://localhost:8900/health

# 2. Cache status
curl http://localhost:8900/internal/cache | jq .

# 3. Metrics check
curl http://localhost:8900/metrics/prom | grep cache_

# 预期：看到 8 个 cache_* 指标
```

### Step 3: 检查所有文档完整性 (1分钟)

```bash
ls -lh claudedocs/ | grep -E "(CACHE|PHASE|HANDOFF|COMPLETE|FINAL)"
```

**必备文档清单**:
- ✅ CACHE_DESIGN_INTEGRATION_REPORT.md (设计整合报告)
- ✅ HANDOFF_20251103_PHASE1_COMPLETE.md (项目交接)
- ✅ PHASE2_PREPARATION_GUIDE.md (Phase 2 准备指南)
- ✅ COMPLETE_SUCCESS_20251103.md (完整成功报告)
- ✅ FINAL_STATUS_20251103.md (最终状态报告)
- ✅ CACHE_3PHASE_IMPLEMENTATION_PLAN.md (三阶段计划)
- ✅ CACHE_ARCHITECTURE_DECISION_20251103.md (架构决策)

---

## Phase 2 执行计划

### Week 1: 环境准备与监控配置

#### Day 1-2: Staging 环境部署

**任务 1.1**: 准备 Staging 环境配置

```bash
# 创建 staging 配置文件
cat > k8s/staging/configmap.yaml <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: metasheet-cache-config
  namespace: staging
data:
  FEATURE_CACHE: "true"
  NODE_ENV: "staging"
  DATABASE_URL: "postgresql://staging-db:5432/metasheet"
  JWT_SECRET: "\${STAGING_JWT_SECRET}"
  API_ORIGIN: "https://staging.metasheet.com"
EOF
```

**任务 1.2**: 部署到 Staging

```bash
# 应用配置
kubectl apply -f k8s/staging/configmap.yaml

# 部署应用
kubectl apply -f k8s/staging/deployment.yaml

# 检查部署状态
kubectl get pods -n staging
kubectl logs -f -n staging deployment/metasheet-core-backend
```

**验证标准**:
- [ ] Pod 状态为 Running
- [ ] 日志显示 "Cache: disabled (impl: NullCache)"
- [ ] Health endpoint 响应正常
- [ ] Metrics endpoint 可访问

#### Day 3: Prometheus 配置

**任务 2.1**: 配置 Prometheus 抓取规则

```yaml
# prometheus/staging-config.yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'metasheet-cache'
    static_configs:
      - targets: ['metasheet-core-backend:8900']
    metrics_path: '/metrics/prom'
    scrape_interval: 15s
```

**任务 2.2**: 配置数据保留策略

```bash
# Prometheus 启动参数
--storage.tsdb.retention.time=15d
--storage.tsdb.retention.size=50GB
```

**任务 2.3**: 验证数据采集

```bash
# 检查 Prometheus targets
curl http://prometheus:9090/api/v1/targets | jq .

# 查询缓存指标
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=cache_miss_total'
```

#### Day 4-5: Grafana Dashboard 配置

**任务 3.1**: 创建 Cache Observability Dashboard

使用 `PHASE2_PREPARATION_GUIDE.md` 中的模板创建 4 个面板：

**Panel 1: Cache Operations Volume**
```json
{
  "title": "Cache Operations Volume",
  "targets": [
    {
      "expr": "sum(rate(cache_miss_total[5m])) by (key_pattern)",
      "legendFormat": "{{key_pattern}} - miss/s"
    }
  ]
}
```

**Panel 2: Top Key Patterns**
```json
{
  "title": "Top 10 Key Patterns by Access",
  "targets": [
    {
      "expr": "topk(10, sum(cache_miss_total) by (key_pattern))",
      "legendFormat": "{{key_pattern}}"
    }
  ]
}
```

**Panel 3: Potential Cache Benefit Heatmap**
```json
{
  "title": "High-Value Cache Candidates",
  "targets": [
    {
      "expr": "sum(rate(cache_miss_total[5m])) by (key_pattern) * avg(http_request_duration_seconds) by (route)",
      "legendFormat": "{{key_pattern}}"
    }
  ]
}
```

**Panel 4: Error Tracking**
```json
{
  "title": "Cache Errors",
  "targets": [
    {
      "expr": "sum(rate(cache_errors_total[5m])) by (error_type)",
      "legendFormat": "{{error_type}}"
    }
  ]
}
```

**任务 3.2**: 配置告警规则

```yaml
# grafana/alerts/cache-alerts.yaml
groups:
  - name: cache_observability
    interval: 1m
    rules:
      - alert: HighCacheMissRate
        expr: rate(cache_miss_total[5m]) > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High cache miss rate on {{ $labels.key_pattern }}"
          description: "Pattern {{ $labels.key_pattern }} has {{ $value }} misses/sec"

      - alert: CacheErrorSpike
        expr: rate(cache_errors_total[5m]) > 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Cache error spike detected"
          description: "{{ $value }} errors/sec on {{ $labels.error_type }}"
```

**验证标准**:
- [ ] Grafana dashboard 正常显示
- [ ] 4 个面板有数据更新
- [ ] 告警规则配置成功
- [ ] 测试告警可以正常触发

### Week 2: 数据收集与初步分析

#### Day 6-12: 持续数据收集

**任务 4.1**: 每日数据快照收集

创建自动化脚本：

```bash
#!/bin/bash
# scripts/collect-cache-snapshot.sh

DATE=$(date +%Y%m%d_%H%M%S)
OUTPUT_DIR="data/cache-snapshots"
mkdir -p $OUTPUT_DIR

# 1. 收集 key pattern 分布
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=topk(20, sum(cache_miss_total) by (key_pattern))' \
  > "$OUTPUT_DIR/key_patterns_$DATE.json"

# 2. 收集访问频率
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=rate(cache_miss_total[1h]) by (key_pattern)' \
  > "$OUTPUT_DIR/access_rate_$DATE.json"

# 3. 收集响应时间数据
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) by (route)' \
  > "$OUTPUT_DIR/response_time_$DATE.json"

echo "✓ Snapshot collected: $DATE"
```

**任务 4.2**: 设置定时任务

```bash
# 添加到 crontab
crontab -e

# 每小时执行一次
0 * * * * /path/to/scripts/collect-cache-snapshot.sh >> /var/log/cache-collection.log 2>&1

# 每天凌晨生成日报
0 0 * * * /path/to/scripts/generate-daily-report.sh
```

**任务 4.3**: 监控数据质量

每天检查：
- [ ] Prometheus 数据无断层
- [ ] 磁盘空间充足（< 70% used）
- [ ] 收集脚本无错误
- [ ] Grafana dashboard 数据更新正常

#### Day 13-14: 初步数据分析

**任务 5.1**: 生成分析报告

```bash
#!/bin/bash
# scripts/generate-phase2-analysis.sh

echo "# Phase 2 Preliminary Analysis - $(date +%Y-%m-%d)" > analysis.md
echo "" >> analysis.md

# 1. Top 10 high-frequency patterns
echo "## Top 10 High-Frequency Key Patterns" >> analysis.md
echo "" >> analysis.md
echo "| Pattern | Total Accesses | Avg Rate (req/min) |" >> analysis.md
echo "|---------|----------------|---------------------|" >> analysis.md

# 提取数据并格式化...

# 2. Response time analysis
echo "" >> analysis.md
echo "## Response Time by Route" >> analysis.md
echo "" >> analysis.md
echo "| Route | p50 | p95 | p99 |" >> analysis.md
echo "|-------|-----|-----|-----|" >> analysis.md

# 3. Cache candidates recommendation
echo "" >> analysis.md
echo "## High-Value Cache Candidates" >> analysis.md
echo "" >> analysis.md
echo "Candidates meeting criteria (>100 req/min, >500ms p95):" >> analysis.md
echo "" >> analysis.md

echo "✓ Analysis report generated: analysis.md"
```

**任务 5.2**: 候选模式评估

创建评估表格：

| Key Pattern | 访问频率 (req/min) | p95 延迟 (ms) | 数据大小 (KB) | 估算命中率 | 优先级 |
|-------------|-------------------|--------------|--------------|-----------|--------|
| user | ? | ? | ? | ? | ? |
| department | ? | ? | ? | ? | ? |
| spreadsheet | ? | ? | ? | ? | ? |
| workflow | ? | ? | ? | ? | ? |
| file | ? | ? | ? | ? | ? |

**评估标准**:
- 访问频率: > 100 req/min → 高优先级
- p95 延迟: > 500ms → 高收益
- 数据大小: < 100KB → 适合缓存
- 估算命中率: > 60% → 值得投入

### Week 3 (Optional): 扩展分析

#### Day 15-17: 深度模式分析

**任务 6.1**: 按时段分析访问模式

```bash
# 识别访问高峰时段
curl -G http://prometheus:9090/api/v1/query_range \
  --data-urlencode 'query=sum(rate(cache_miss_total[1h])) by (key_pattern)' \
  --data-urlencode 'start=2025-11-01T00:00:00Z' \
  --data-urlencode 'end=2025-11-08T00:00:00Z' \
  --data-urlencode 'step=1h' \
  > time_pattern_analysis.json
```

**任务 6.2**: 用户行为分析

- 分析不同用户群体的访问模式
- 识别高活跃用户的缓存需求
- 评估协作场景下的缓存收益

**任务 6.3**: Redis 容量规划

```bash
# 估算内存需求脚本
#!/bin/bash
# scripts/estimate-redis-memory.sh

# 从 Prometheus 获取数据
TOTAL_KEYS=$(curl -s -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=sum(cache_miss_total)' | jq '.data.result[0].value[1]' | tr -d '"')

AVG_KEY_SIZE=1024  # 假设平均 1KB per key
OVERHEAD_FACTOR=1.2  # 20% overhead

ESTIMATED_MEMORY=$((TOTAL_KEYS * AVG_KEY_SIZE * OVERHEAD_FACTOR / 1024 / 1024))

echo "Estimated Redis Memory: ${ESTIMATED_MEMORY} MB"
echo ""
echo "Recommended Redis Configuration:"
echo "  maxmemory: ${ESTIMATED_MEMORY}MB"
echo "  maxmemory-policy: allkeys-lru"
```

---

## Phase 2 Deliverables

### 必交付成果

1. **✅ 数据收集报告**
   - 文件: `PHASE2_DATA_COLLECTION_REPORT_YYYYMMDD.md`
   - 内容:
     - 收集周期和方法
     - 数据完整性验证
     - 初步观察结果

2. **✅ 缓存候选分析**
   - 文件: `PHASE2_CACHE_CANDIDATES_ANALYSIS.md`
   - 内容:
     - Top 10 高频 key patterns
     - 每个 pattern 的详细指标
     - 优先级排序和推荐

3. **✅ 性能改进估算**
   - 文件: `PHASE2_PERFORMANCE_ESTIMATE.md`
   - 内容:
     - 预期延迟减少百分比
     - 数据库查询减少估算
     - Redis 内存需求计算
     - 成本收益分析

4. **✅ Phase 3 实施计划**
   - 文件: `PHASE3_IMPLEMENTATION_PLAN_DETAILED.md`
   - 内容:
     - RedisCache 详细设计
     - 渐进式推出时间表
     - A/B 测试方案
     - 监控和回滚策略

5. **✅ Grafana Dashboard Export**
   - 文件: `grafana/cache-observability-dashboard.json`
   - 内容: 可导入的 dashboard 配置

---

## Success Criteria Checklist

### Phase 2 完成标准

- [ ] **数据收集**: ≥7 天持续数据，无明显断层
- [ ] **候选识别**: 至少 5 个符合标准的高价值候选
  - [ ] 候选 1: 访问频率 > 100 req/min
  - [ ] 候选 2: 访问频率 > 100 req/min
  - [ ] 候选 3: 访问频率 > 100 req/min
  - [ ] 候选 4: 访问频率 > 100 req/min
  - [ ] 候选 5: 访问频率 > 100 req/min
- [ ] **性能估算**: 完成延迟减少和命中率预测
- [ ] **容量规划**: Redis 内存需求已计算
- [ ] **Phase 3 计划**: 详细实施文档已编写并 review
- [ ] **监控就绪**: Grafana dashboard 运行良好，告警配置完成
- [ ] **团队对齐**: Phase 2 结果已与团队分享并获得认可

### 关键指标目标

| 指标 | 目标 | 状态 |
|------|------|------|
| 数据收集天数 | ≥ 7 days | ⏳ |
| 高价值候选数量 | ≥ 5 | ⏳ |
| 估算延迟减少 | ≥ 30% | ⏳ |
| 估算命中率 | ≥ 60% | ⏳ |
| Redis 内存需求 | 计算完成 | ⏳ |
| Grafana 面板 | 4 个运行正常 | ⏳ |
| 告警规则 | 2 个配置完成 | ⏳ |

---

## Risk Management

### 潜在风险与缓解

| 风险 | 影响 | 缓解措施 | 负责人 |
|------|------|----------|--------|
| 数据收集不足 | 高 | 延长收集期至数据充分 | DevOps |
| Prometheus 存储满 | 中 | 监控磁盘，调整保留策略 | SRE |
| 候选数量不足 | 中 | 降低阈值标准，扩大范围 | Tech Lead |
| 分析结果偏差 | 高 | 多人交叉验证，数据采样 | Team |
| Staging 环境不稳定 | 低 | 及时修复，必要时回滚 | DevOps |

---

## Communication Plan

### 周报节奏

**每周一**:
- 发送上周数据收集摘要
- 更新 Grafana dashboard 截图
- 报告任何异常或发现

**每周五**:
- 总结本周工作进展
- 下周工作计划预告
- 风险和阻塞点同步

### 里程碑汇报

**Week 1 结束**:
- 汇报环境部署和监控配置完成情况
- 展示 Grafana dashboard
- 初步数据趋势观察

**Week 2 结束**:
- 完整的 Phase 2 数据分析报告
- 高价值缓存候选推荐
- Phase 3 Go/No-Go 决策建议

---

## Next Steps After Phase 2

### 如果 Phase 2 成功

进入 Phase 3:
1. 开始 RedisCache 实现开发
2. 准备 Redis 基础设施
3. 编写 A/B 测试框架
4. 制定渐进式推出计划

### 如果需要迭代

- 延长数据收集期
- 调整分析方法
- 重新评估候选标准
- 寻求团队输入和建议

---

## Quick Reference Commands

### 常用检查命令

```bash
# 检查 Prometheus 数据
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=cache_miss_total' | jq .

# 检查 Grafana dashboard
open http://grafana:3000/d/cache-observability

# 查看 Staging 日志
kubectl logs -f -n staging deployment/metasheet-core-backend

# 收集数据快照
./scripts/collect-cache-snapshot.sh

# 生成分析报告
./scripts/generate-phase2-analysis.sh
```

### 紧急操作

```bash
# 回滚 Phase 1（如有问题）
kubectl set env deployment/metasheet-core-backend FEATURE_CACHE=false -n staging

# 清理 Prometheus 旧数据
curl -X POST http://prometheus:9090/api/v1/admin/tsdb/delete_series \
  -d 'match[]=cache_miss_total'

# 重启服务
kubectl rollout restart deployment/metasheet-core-backend -n staging
```

---

**创建者**: Claude Code
**更新时间**: 2025-11-03
**状态**: Ready to Execute
**预计完成**: 2025-11-17 (2 weeks)

🚀 **Phase 2 准备完毕，可以开始执行！**
