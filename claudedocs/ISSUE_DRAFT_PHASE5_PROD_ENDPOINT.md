# [DRAFT] Phase 5 Production Prometheus Endpoint Configuration

## 背景 (Background)

Phase 4 observability基础设施硬化已完成并合并到main分支（PR #424, Release v2.4.0）。Phase 5需要采集真实生产环境的P99延迟数据，建立2小时生产基线。

目前观察脚本已具备以下增强功能：
- ✅ 单实例防护 (.observe-24h.lock)
- ✅ 自定义输出目录支持 (OUT_DIR)
- ✅ 自动CSV去重（基于时间戳）
- ✅ 优雅停止机制 (STOP_OBSERVATION)

## 问题 (Problem)

当前Phase 5运行在**CI fallback模式**，所有P99指标为0，无法获得真实生产性能基线。

需要配置生产环境Prometheus endpoint以采集真实metrics数据。

## 需求 (Requirements)

### 必需配置 (Required)

**METRICS_URL** - 生产Prometheus查询endpoint
- 格式：`http(s)://<prometheus-host>:<port>`
- 示例：`https://prometheus.prod.example.com:9090`
- 用途：通过PromQL查询approval API的P99延迟和数据库P99延迟

### 可选配置 (Optional - 告警集成)

如需验证告警功能，可配置：

**ALERT_WEBHOOK_URL** - Webhook endpoint用于发送告警通知
- 格式：`https://<webhook-service>/endpoint`
- 支持：Slack, Discord, 钉钉, 飞书等
- 用途：当success rate < 0.98或检测到BLOCK/CRIT事件时发送告警

**CREATE_GH_ISSUE** - 自动创建GitHub Issue
- 值：`true` 或 `false`
- 默认：`false`
- 用途：BLOCK/CRIT事件发生时自动创建GitHub Issue追踪

## Phase 5运行指令 (Execution Commands)

### 最小配置（仅metrics采集）

```bash
cd metasheet-v2

# 设置环境变量
export METRICS_URL="<YOUR_PRODUCTION_PROMETHEUS_ENDPOINT>"
export INTERVAL_SECONDS=600              # 10分钟间隔
export MAX_SAMPLES=12                    # 12个样本（2小时）
export OBS_WINDOW_LABEL=phase5-prod-2h
export OUT_DIR=metasheet-v2/artifacts
export LC_ALL=C

# 启动Phase 5观察
nohup bash scripts/observe-24h.sh > metasheet-v2/artifacts/phase5-run.log 2>&1 &
echo $! > metasheet-v2/artifacts/phase5.pid

# 监控进度
watch -n 30 'jq -r ".status,.samples_collected" metasheet-v2/artifacts/observability-24h-summary.json'
```

### 完整配置（含告警集成）

```bash
cd metasheet-v2

# 设置环境变量（含告警）
export METRICS_URL="<YOUR_PRODUCTION_PROMETHEUS_ENDPOINT>"
export ALERT_WEBHOOK_URL="<YOUR_WEBHOOK_URL>"    # 可选
export CREATE_GH_ISSUE=true                       # 可选
export INTERVAL_SECONDS=600
export MAX_SAMPLES=12
export OBS_WINDOW_LABEL=phase5-prod-2h
export OUT_DIR=metasheet-v2/artifacts
export LC_ALL=C

# 启动Phase 5观察
nohup bash scripts/observe-24h.sh > metasheet-v2/artifacts/phase5-run.log 2>&1 &
echo $! > metasheet-v2/artifacts/phase5.pid
```

### 早期停止方法

如需提前停止观察：

```bash
touch metasheet-v2/artifacts/STOP_OBSERVATION
```

脚本将在当前样本完成后优雅退出。

## 完成后快照步骤 (Post-Completion Snapshot)

Phase 5运行完成后（2小时），执行以下步骤：

```bash
# 1. 创建快照目录
mkdir -p metasheet-v2/artifacts/phase5-2h

# 2. 复制关键文件
cp metasheet-v2/artifacts/observability-24h.* \
   metasheet-v2/artifacts/phase5-run.log \
   metasheet-v2/artifacts/phase5-2h/

# 3. 生成校验和
(cd metasheet-v2/artifacts/phase5-2h && shasum -a 256 * > CHECKSUMS.txt)

# 4. 计算关键指标（排除COLD_START和CRIT样本）
awk -F',' '
  NR>1 && $11!="COLD_START" && $11!="CRIT" {
    s+=$9; f+=$10; c+=$5; p+=$7; n++
  }
  END {
    printf "samples=%d success_rate=%.4f fallback_ratio=%.4f p99_avg=%.3fs conflicts=%d\n",
           n, s/n, f/n, p/n, c
  }
' metasheet-v2/artifacts/observability-24h.csv
```

## 预期结果 (Expected Results)

- **12个有效样本**（排除第1个COLD_START样本，实际分析11个样本）
- **Success Rate**: ≥ 0.98 (98%)
- **Fallback Ratio**: < 0.10 (10%)
- **P99 Latency**: 真实生产数据（非0）
- **Conflicts**: 应为0
- **BLOCK/CRIT Events**: 应为0

## 验收标准 (Acceptance Criteria)

- [ ] METRICS_URL已配置且可访问生产Prometheus
- [ ] Phase 5观察脚本成功运行2小时（12个样本）
- [ ] `final-artifacts/phase5-prod-2h/` 包含完整数据和校验和
- [ ] Success rate ≥ 98%，无BLOCK/CRIT事件
- [ ] P99指标为真实生产值（非0）
- [ ] 主指南已更新Phase 5完成段落

## 相关资源 (References)

- **Phase 4完成报告**: `claudedocs/PHASE4_COMPLETION_REPORT.md`
- **主指南**: `claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md`
- **Release v2.4.0**: https://github.com/zensgit/smartsheet/releases/tag/v2.4.0
- **PR #424**: https://github.com/zensgit/smartsheet/pull/424
- **观察脚本**: `scripts/observe-24h.sh`

## 标签建议 (Suggested Labels)

- `phase-5`
- `observability`
- `production`
- `infrastructure`
- `priority-high`

## 负责人 (Assignee)

待分配 - 需要具有生产Prometheus访问权限的团队成员

---

**创建日期**: 2025-11-14
**状态**: 草稿 (Draft)
**优先级**: 高 (High)
