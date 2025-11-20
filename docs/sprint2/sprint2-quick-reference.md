# Sprint 2: 快速参考卡片

## 🚀 Staging 验证快速命令

### 1. 标准验证
```bash
cd packages/core-backend
./scripts/verify-sprint2-staging.sh <STAGING_API_TOKEN>
```

### 2. 性能基线测试
```bash
./scripts/performance-baseline-test.sh <STAGING_API_TOKEN> http://staging:8900
# 目标: P95 < 150ms, P99 < 250ms
```

### 3. PromQL 验证
```bash
# 在 Prometheus UI (http://staging:9090/graph) 执行:
rate(metasheet_protection_rule_evaluations_total[5m])
rate(metasheet_protection_rule_blocks_total[5m])
histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m]))
metasheet_snapshot_protection_level
topk(5, metasheet_snapshot_tags_total)
metasheet_snapshot_protected_skipped_total
```

### 4. 增强验证脚本 (在增强验证计划文档中)
```bash
# 规则压力测试
/tmp/rule-stress-test.sh <TOKEN>

# 标签兼容性测试
/tmp/label-compatibility-test.sh <TOKEN>

# 只读保护测试
/tmp/readonly-protection-test.sh <TOKEN>

# PromQL 自动验证
/tmp/promql-validation.sh
```

## 📋 验证结果收集

```bash
# 填写模板
vim docs/sprint2-staging-verification-results-template.md

# 必须包含:
• 数据库迁移验证结果
• API 端点测试通过率
• 性能基线数据 (P50/P95/P99)
• PromQL 查询结果
• Grafana 截图
```

## 🔄 PR 流程

```bash
# 1. 附加证据到 PR
gh pr comment --body "$(cat verification-results.md)"

# 2. 标记 Ready
gh pr ready

# 3. 等待审查 (≥2 APPROVED)

# 4. 合并
gh pr merge --squash
# 使用 docs/sprint2-squash-commit-message.md 中的消息
```

## 🎯 性能目标

| 指标 | 目标 | 验证方法 |
|------|------|----------|
| 平均耗时 | < 100ms | 性能基线测试 |
| P50 延迟 | < 50ms | 性能基线测试 |
| P95 延迟 | < 150ms | 性能基线测试 + PromQL |
| P99 延迟 | < 250ms | 性能基线测试 + PromQL |
| 错误率 | < 1% | Prometheus 监控 |

## ⚠️ 回滚触发条件

**立即回滚**（任一满足）:
- 规则评估 P95 > 200ms 持续 > 10 分钟
- 错误率 > 1% 持续 > 5 分钟
- 数据库死锁或严重性能问题
- 关键功能不可用

**回滚步骤**:
```bash
# 1. 禁用功能
export SAFETY_RULES_ENABLED=false

# 2. 回滚迁移
npm run migrate:down  # Migration 2
npm run migrate:down  # Migration 1

# 3. 重启服务
systemctl restart metasheet
```

## 📊 监控关键指标 (24h)

```promql
# 1. 规则阻止率
rate(metasheet_protection_rule_blocks_total[5m]) 
  / rate(metasheet_protection_rule_evaluations_total[5m])
# 告警: > 10% (异常高阻止率)

# 2. 受保护快照跳过
metasheet_snapshot_protected_skipped_total
# 告警: 长时间为 0 (保护机制未生效)

# 3. 错误率
rate(metasheet_protection_rule_eval_error_total[5m])
# 告警: > 0.01 (1%)
```

## 🔗 文档快速导航

| 文档 | 用途 |
|------|------|
| `sprint2-enhanced-validation-plan.md` | 完整增强验证方案 |
| `sprint2-execution-summary.md` | 交付成果总览 |
| `sprint2-final-push-checklist.md` | 8 步推进指南 |
| `sprint2-code-review-checklist.md` | 7 模块审查清单 |
| `sprint2-pr-review-template.md` | PR 审查表单 |
| `sprint2-staging-verification-results-template.md` | 验证结果模板 |

## 👥 审查分工建议

1. **DB 专家**: 迁移文件 + 索引策略 (2-3h)
2. **后端专家**: ProtectionRuleService + SafetyGuard (3-4h)
3. **安全专家**: API 认证/鉴权/审计 (2h)
4. **可观测性专家**: 指标 + Grafana (1-2h)
5. **QA**: E2E 测试覆盖 (2h)

**总计**: 10-13 小时 (可并行)

## 🎉 成功标准

- ✅ 所有验证通过 (标准 + 增强)
- ✅ 性能达标 (P95 < 150ms)
- ✅ ≥2 APPROVED 审查
- ✅ 24h 监控无 P0 告警
- ✅ Grafana 仪表板正常显示
- ✅ PromQL 查询返回有效数据

---

**PR #2**: https://github.com/zensgit/metasheet2/pull/2
**预计总时长**: 4-6 天 (含并行审查)
