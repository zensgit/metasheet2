# Phase 5 生产基线上线计划

**计划日期**: 2025-11-18 (周一)
**上线窗口**: 09:00 - 12:00 (3 小时)
**负责人**: _______________
**状态**: 📋 待执行

---

## 🎯 上线目标

在生产环境验证 Phase 6-9 能力的稳定性，建立 SLO 基线数据。

---

## 📅 上线时间表

| 时间 | 阶段 | 活动 |
|------|------|------|
| 08:30-09:00 | 事前检查 | 配置确认、环境准备 |
| 09:00-09:10 | 启动观察 | 启动监控脚本 |
| 09:10-11:10 | 持续监控 | 2小时观察窗口 (12 samples) |
| 11:10-11:30 | 数据收集 | 汇总指标、截图 |
| 11:30-12:00 | 报告撰写 | 完成观察报告 |

---

## ✅ 事前检查清单 (T-30 min)

### 环境配置
- [ ] **METRICS_URL 配置正确**
  ```bash
  echo $METRICS_URL
  # 预期: http://production-server:4000/metrics/prom
  ```
- [ ] **生产服务运行正常**
  ```bash
  curl $METRICS_URL | head -20
  # 预期: 返回 Prometheus 格式指标
  ```
- [ ] **采样间隔配置**
  ```bash
  export INTERVAL_SECONDS=600  # 10 分钟
  export MAX_SAMPLES=12        # 12 样本
  ```

### SLO 目标确认
- [ ] HTTP 成功率目标: **≥ 98%**
- [ ] P99 延迟目标: **≤ 2 秒**
- [ ] Fallback 使用率目标: **< 10%**
- [ ] 插件重载成功率目标: **≥ 95%**
- [ ] Snapshot 操作成功率目标: **≥ 99%**

### 告警就绪
- [ ] **Slack 通知配置**: ✅/❌
- [ ] **PagerDuty 集成**: ✅/❌ (可选)
- [ ] **邮件通知**: ✅/❌
- [ ] **告警阈值设置**:
  - HTTP 错误率 > 5% → 告警
  - P99 延迟 > 5s → 告警
  - 服务不可用 → 立即告警

### 回滚准备
- [ ] 上一个稳定版本标识: _______________
- [ ] 回滚命令准备就绪
- [ ] 回滚联系人确认: _______________

---

## 🚀 执行阶段 (T+0)

### 启动观察 (09:00)

```bash
# 1. 设置环境变量
export METRICS_URL="http://production:4000/metrics/prom"
export INTERVAL_SECONDS=600
export MAX_SAMPLES=12

# 2. 创建结果目录
mkdir -p results/phase5-$(date +%Y%m%d)

# 3. 启动观察脚本
node scripts/observe.js | tee results/phase5-$(date +%Y%m%d)/log.txt
```

### 第一个样本确认 (09:10)
- [ ] 脚本正常运行
- [ ] 第一个样本数据收集成功
- [ ] 无错误日志
- [ ] 基线值记录:
  - HTTP 成功率: _____%
  - P99 延迟: _____s
  - Fallback 率: _____%

### 持续监控 (09:10 - 11:10)

**每 30 分钟检查点**:

#### 09:40 检查点 (Sample 4)
- [ ] 脚本运行正常
- [ ] 无告警触发
- [ ] 指标在正常范围
- [ ] 备注: _______________

#### 10:10 检查点 (Sample 7)
- [ ] 脚本运行正常
- [ ] 无告警触发
- [ ] 指标在正常范围
- [ ] 备注: _______________

#### 10:40 检查点 (Sample 10)
- [ ] 脚本运行正常
- [ ] 无告警触发
- [ ] 指标在正常范围
- [ ] 备注: _______________

#### 11:10 最终检查 (Sample 12)
- [ ] 所有 12 个样本收集完成
- [ ] 脚本正常退出
- [ ] 数据完整无遗漏

---

## 🔥 异常处理流程

### 场景 1: 指标不达标

**触发条件**: 任一 SLO 指标低于目标值

**处理步骤**:
1. 记录当前指标值
2. 检查错误类型分布
   ```bash
   curl $METRICS_URL | grep -E "status=\"[45]"
   ```
3. 查看应用日志
   ```bash
   kubectl logs -f deployment/metasheet --since=10m | grep ERROR
   ```
4. 评估是否继续观察或提前终止
5. 如果持续恶化，启动回滚流程

**决策**: ⭕ 继续观察 / ⭕ 延长观察时间 / ⭕ 终止并回滚

---

### 场景 2: 服务不可用

**触发条件**: METRICS_URL 无法访问

**处理步骤**:
1. 确认网络连通性
   ```bash
   ping production-server
   curl -I $METRICS_URL
   ```
2. 检查服务状态
   ```bash
   kubectl get pods | grep metasheet
   kubectl describe pod metasheet-xxx
   ```
3. 如果服务崩溃，立即回滚
4. 记录事件详情

---

### 场景 3: 告警触发

**处理步骤**:
1. 确认告警内容和严重程度
2. 评估对观察的影响
3. 决定是否继续
4. 记录到问题清单

---

## 📊 数据收集 (11:10-11:30)

### 核心指标汇总

```bash
# 运行汇总脚本
node scripts/summarize-phase5.js results/phase5-$(date +%Y%m%d)/log.txt
```

**指标记录表**:

| 指标 | 目标 | 最小值 | 最大值 | 平均值 | 达标 |
|------|------|--------|--------|--------|------|
| HTTP 成功率 | ≥98% | ___% | ___% | ___% | ✅/❌ |
| P99 延迟 | ≤2s | ___s | ___s | ___s | ✅/❌ |
| Fallback 率 | <10% | ___% | ___% | ___% | ✅/❌ |
| 插件重载成功率 | ≥95% | ___% | ___% | ___% | ✅/❌ |
| Snapshot 成功率 | ≥99% | ___% | ___% | ___% | ✅/❌ |

### 新增指标验证

- [ ] `metasheet_plugin_reload_total` 正常上报
- [ ] `metasheet_plugin_reload_duration_seconds` 正常上报
- [ ] `metasheet_snapshot_create_total` 正常上报
- [ ] `metasheet_snapshot_restore_total` 正常上报
- [ ] `metasheet_snapshot_cleanup_total` 正常上报

### 截图存档

- [ ] Grafana Dashboard 截图
- [ ] Prometheus 查询结果截图
- [ ] 关键指标趋势图
- [ ] 保存位置: `results/phase5-$(date +%Y%m%d)/screenshots/`

---

## 📝 Phase 5 完成报告模板

```markdown
# Phase 5 生产基线观察报告

**观察日期**: 2025-11-18
**观察时长**: 2 小时 (12 样本)
**观察环境**: Production

---

## 执行摘要

Phase 5 生产基线观察已[成功/部分成功/失败]完成。

**关键发现**:
- HTTP 成功率: ___% (目标 ≥98%) ✅/❌
- P99 延迟: ___s (目标 ≤2s) ✅/❌
- Fallback 率: ___% (目标 <10%) ✅/❌

---

## SLO 基线数据

[粘贴指标记录表]

---

## 新增指标验证

所有 Phase 8-9 新增指标均[正常/部分异常]上报:
- 插件重载指标: ✅/❌
- Snapshot 指标: ✅/❌

---

## 发现的问题

1. [问题描述]
   - 影响: [低/中/高]
   - 建议: [解决方案]

---

## 结论与建议

基于本次观察结果，建议:
- [ ] Phase 6-9 能力稳定，可进入 Sprint 1 其他工作
- [ ] 需要优化某些指标后再进行下一步
- [ ] 需要延长观察时间

---

**下一步行动**:
1. 将 SLO 基线数据更新到正式文档
2. 设置基于基线的告警阈值
3. 开始 Sprint 1 开发工作
```

---

## 📚 事后文档更新

### 更新 ROADMAP_V2.md

在 "Milestone: Phase 5 Production Baseline" 章节添加:

```markdown
### 实测结果 (2025-11-18)

**状态**: ✅ 已验证通过

- 观察时长: 2 小时 (12 样本)
- HTTP 成功率: __% (✅ 达标)
- P99 延迟: __s (✅ 达标)
- Fallback 率: __% (✅ 达标)

**报告**: [Phase 5 完成报告](claudedocs/PHASE5_COMPLETION_REPORT.md)
```

### 更新 MAP_FEATURE_TO_CODE.md

将 Phase 4 Observability 状态从 🚀 更新为:
```
**状态**: 🚀 **Verified** - 生产实测通过 (2025-11-18)
```

---

## ✅ 最终确认

- [ ] 所有 SLO 指标达标
- [ ] 无 Sev-1/Sev-2 事件
- [ ] 新增指标正常上报
- [ ] 完成报告已撰写
- [ ] 文档已更新
- [ ] 数据已存档

**Phase 5 状态**: ⭕ 通过 / ⭕ 条件通过 / ⭕ 未通过

**签字**: _______________
**日期**: _______________

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
