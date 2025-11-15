# 📊 v2.0.0-alpha.1 发布后监控计划

**版本号**: v2.0.0-alpha.1
**发布时间**: 2025-09-19 15:30:00
**监控周期**: 24-48小时
**GitHub Release**: https://github.com/zensgit/smartsheet/releases/tag/v2.0.0-alpha.1

## 🎯 监控目标

确保新版本在生产环境中稳定运行，及时发现并处理潜在问题。

## 📈 关键监控指标

### 1. 性能指标 ⚡

| 指标 | 监控端点 | 阈值 | 告警条件 | 检查频率 |
|------|---------|------|----------|----------|
| **P99延迟** | `/metrics/prom` | <0.5s | >0.5s持续5分钟 | 每5分钟 |
| **P95延迟** | `/metrics/prom` | <0.3s | >0.3s持续10分钟 | 每10分钟 |
| **P50延迟** | `/metrics/prom` | <0.1s | >0.1s持续15分钟 | 每15分钟 |

#### 监控命令
```bash
# 获取P99延迟
curl -s http://localhost:8900/metrics/prom | \
  grep 'http_server_requests_seconds_summary.*quantile="0.99"' | \
  awk '{print $NF}'

# 监控脚本
while true; do
  P99=$(curl -s http://localhost:8900/metrics/prom | \
    awk '/quantile="0.99"/ {print $NF}')
  echo "$(date): P99=$P99"
  sleep 300  # 5分钟
done
```

### 2. 错误率监控 🚨

| 指标 | 计算方式 | 阈值 | 告警条件 |
|------|---------|------|----------|
| **5xx错误率** | 5xx_count/total_requests | <1% | >1%任意时刻 |
| **4xx错误率** | 4xx_count/total_requests | <5% | >5%持续10分钟 |
| **总错误率** | error_count/total_requests | <2% | >2%持续5分钟 |

#### 监控命令
```bash
# 计算错误率
TOTAL=$(curl -s http://localhost:8900/metrics/prom | \
  awk '/^http_requests_total\{/ {sum+=$NF} END {print sum}')
ERRORS=$(curl -s http://localhost:8900/metrics/prom | \
  awk '/status="5[0-9][0-9]"/ {sum+=$NF} END {print sum}')
RATE=$(echo "scale=4; $ERRORS / $TOTAL" | bc)
echo "Error Rate: $RATE (Errors: $ERRORS, Total: $TOTAL)"
```

### 3. RBAC缓存监控 🔐

| 指标 | 目标值 | 告警条件 | 影响 |
|------|--------|----------|------|
| **缓存命中率** | >60% | <40%持续30分钟 | 性能下降 |
| **缓存大小** | <10000 | >10000条目 | 内存压力 |
| **TTL有效性** | 60s | 配置错误 | 数据一致性 |

#### 监控命令
```bash
# 缓存命中率
HITS=$(curl -s http://localhost:8900/metrics/prom | \
  grep rbac_perm_cache_hits_total | awk '{print $NF}')
MISSES=$(curl -s http://localhost:8900/metrics/prom | \
  grep rbac_perm_cache_misses_total | awk '{print $NF}')
RATE=$(echo "scale=2; $HITS / ($HITS + $MISSES) * 100" | bc)
echo "Cache Hit Rate: $RATE%"
```

### 4. 业务指标监控 📊

| 指标 | 监控内容 | 正常范围 | 异常处理 |
|------|---------|----------|----------|
| **审批冲突率** | conflict/total_approvals | <10% | 检查并发控制 |
| **审批成功率** | success/total_approvals | >90% | 检查业务逻辑 |
| **契约测试通过率** | passed/total_tests | 100% | 立即修复 |

## 🔄 监控时间表

### 第一阶段：0-6小时（高频监控）
- **频率**: 每5分钟
- **重点**: P99延迟、5xx错误率
- **值班**: 需要工程师待命

### 第二阶段：6-24小时（常规监控）
- **频率**: 每15分钟
- **重点**: 所有指标
- **值班**: 标准值班流程

### 第三阶段：24-48小时（稳定性验证）
- **频率**: 每30分钟
- **重点**: 趋势分析
- **值班**: 被动监控

## 🚨 告警响应流程

### 严重级别定义

| 级别 | 条件 | 响应时间 | 处理流程 |
|------|------|----------|----------|
| **P0-Critical** | P99>1s或5xx>5% | 立即 | 立即回滚 |
| **P1-High** | P99>0.5s或5xx>1% | 15分钟 | 评估回滚 |
| **P2-Medium** | 缓存命中率<40% | 1小时 | 优化调整 |
| **P3-Low** | 其他异常 | 4小时 | 记录分析 |

### 回滚决策树
```
异常发生
  ├─ P99 > 1s 持续10分钟 → 立即回滚
  ├─ 5xx错误率 > 5% → 立即回滚
  ├─ 多个P1级告警 → 评估后回滚
  └─ 单个P2/P3告警 → 监控观察
```

## 🔧 回滚操作指南

### 快速回滚步骤
```bash
# 1. 切换到上一个稳定版本
git checkout v1.x.x  # 或其他稳定tag

# 2. 重新部署
cd metasheet-v2
pnpm install
pnpm -F @metasheet/core-backend build
pm2 restart metasheet-backend

# 3. 验证回滚
curl http://localhost:8900/health
curl http://localhost:8900/metrics/prom
```

### 数据库回滚（如需要）
```bash
# 注意：评估审计表影响
cd metasheet-v2
pnpm -F @metasheet/core-backend migrate:rollback
```

## 📝 监控检查清单

### 每小时检查项
- [ ] P99延迟 < 0.5s
- [ ] 5xx错误率 < 1%
- [ ] 缓存命中率 > 60%
- [ ] 无Critical级别告警
- [ ] CI/CD管道正常

### 每6小时检查项
- [ ] 性能趋势稳定
- [ ] 内存使用正常
- [ ] 日志无异常
- [ ] 契约测试通过
- [ ] 用户反馈收集

### 24小时总结
- [ ] 生成性能报告
- [ ] 评估优化点
- [ ] 更新监控阈值
- [ ] 文档更新
- [ ] 团队复盘

## 📊 监控仪表板

### Grafana配置（如已部署）
```json
{
  "dashboard": {
    "title": "MetaSheet v2.0.0-alpha.1 Monitoring",
    "panels": [
      {
        "title": "P99 Latency",
        "query": "http_server_requests_seconds_summary{quantile=\"0.99\"}"
      },
      {
        "title": "Error Rate",
        "query": "rate(http_requests_total{status=~\"5..\"}[5m])"
      },
      {
        "title": "Cache Hit Rate",
        "query": "rbac_perm_cache_hits_total / (rbac_perm_cache_hits_total + rbac_perm_cache_misses_total)"
      }
    ]
  }
}
```

### 命令行监控脚本
```bash
#!/bin/bash
# monitor.sh - 实时监控脚本

while true; do
  clear
  echo "=== MetaSheet v2.0.0-alpha.1 Monitor ==="
  echo "Time: $(date)"
  echo ""

  # 性能指标
  P99=$(curl -s http://localhost:8900/metrics/prom | \
    awk '/quantile="0.99"/ {print $NF}' | head -1)
  echo "P99 Latency: $P99s (threshold: <0.5s)"

  # 错误率
  TOTAL=$(curl -s http://localhost:8900/metrics/prom | \
    awk '/^http_requests_total\{/ {sum+=$NF} END {print sum}')
  ERRORS=$(curl -s http://localhost:8900/metrics/prom | \
    awk '/status="5[0-9][0-9]"/ {sum+=$NF} END {print sum+0}')
  if [ "$TOTAL" -gt 0 ]; then
    RATE=$(echo "scale=4; $ERRORS / $TOTAL * 100" | bc)
    echo "Error Rate: $RATE% (threshold: <1%)"
  fi

  # 缓存命中率
  HITS=$(curl -s http://localhost:8900/metrics/prom | \
    grep rbac_perm_cache_hits_total | awk '{print $NF}')
  MISSES=$(curl -s http://localhost:8900/metrics/prom | \
    grep rbac_perm_cache_misses_total | awk '{print $NF}')
  if [ "$((HITS + MISSES))" -gt 0 ]; then
    HIT_RATE=$(echo "scale=1; $HITS / ($HITS + $MISSES) * 100" | bc)
    echo "Cache Hit Rate: $HIT_RATE% (target: >60%)"
  fi

  echo ""
  echo "Press Ctrl+C to exit"
  sleep 60
done
```

## 🎯 成功标准

### 48小时后评估
- ✅ P99延迟始终 < 0.5s
- ✅ 5xx错误率始终 < 1%
- ✅ 缓存命中率 > 60%
- ✅ 无P0/P1级别事件
- ✅ 契约测试100%通过

达到以上标准则认为发布成功，可以：
1. 将契约测试转为阻塞模式
2. 考虑收紧P99阈值至0.3s
3. 准备下一版本迭代

## 📞 紧急联系

| 角色 | 责任 | 联系方式 |
|------|------|----------|
| DevOps Lead | 监控和回滚 | oncall@team |
| Backend Lead | 性能问题 | backend@team |
| Product Owner | 业务决策 | product@team |

## 🔗 相关资源

- **GitHub Release**: https://github.com/zensgit/smartsheet/releases/tag/v2.0.0-alpha.1
- **PR #40**: https://github.com/zensgit/smartsheet/pull/40
- **监控端点**: http://localhost:8900/metrics/prom
- **健康检查**: http://localhost:8900/health
- **OpenAPI规范**: 已发布至Release

---

**监控开始时间**: 2025-09-19 15:30:00
**下次评估时间**: 2025-09-20 15:30:00 (24小时)
**最终评估时间**: 2025-09-21 15:30:00 (48小时)

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>