# Sprint 2: Staging 验证结果

> **执行时间**: ___________
> **环境**: Staging
> **执行人**: ___________
> **验证脚本版本**: verify-sprint2-staging.sh

---

## 📊 验证摘要

| 项目 | 状态 | 备注 |
|------|------|------|
| 整体状态 | [ ] ✅ PASS \| [ ] ❌ FAIL | |
| 验证用时 | _____ 分钟 | |
| 成功检查项 | _____/_____ | |
| 失败检查项 | _____/_____ | |
| 警告项 | _____ | |

---

## 1️⃣ 前置条件检查

- [ ] **API token 可用**
- [ ] **数据库连接正常**
- [ ] **所需命令行工具已安装**（curl, jq, psql, node, npm）

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 2️⃣ 数据库迁移验证

### 表结构检查

- [ ] **snapshots.tags 列存在**
- [ ] **snapshots.protection_level 列存在**
- [ ] **snapshots.release_channel 列存在**
- [ ] **protection_rules 表存在**
- [ ] **rule_execution_log 表存在**

### 索引检查

- [ ] **idx_snapshots_tags (GIN 索引)**
- [ ] **idx_snapshots_protection_level (B-tree 索引)**
- [ ] **idx_snapshots_release_channel (B-tree 索引)**
- [ ] **idx_protection_rules_conditions (GIN 索引)**
- [ ] **idx_protection_rules_effects (GIN 索引)**
- [ ] **idx_protection_rules_target_type (B-tree 索引)**
- [ ] **idx_protection_rules_priority (B-tree 索引)**

### 约束检查

- [ ] **chk_protection_level 约束存在**
- [ ] **chk_release_channel 约束存在**

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 3️⃣ 服务器健康检查

- [ ] **Health endpoint 响应 200**
- [ ] **Prometheus metrics 端点可访问**
- [ ] **Sprint 2 指标可抓取**:
  - [ ] metasheet_snapshot_tags_total
  - [ ] metasheet_snapshot_protection_level
  - [ ] metasheet_snapshot_release_channel
  - [ ] metasheet_protection_rule_evaluations_total
  - [ ] metasheet_protection_rule_blocks_total
  - [ ] metasheet_snapshot_protected_skipped_total

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 4️⃣ Snapshot Labels API 测试

### 测试场景

| 测试用例 | 状态 | 响应时间 | 备注 |
|----------|------|----------|------|
| 创建测试快照 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 添加标签 (tags) | [ ] ✅ \| [ ] ❌ | _____ms | |
| 设置保护级别 (protection_level) | [ ] ✅ \| [ ] ❌ | _____ms | |
| 设置发布渠道 (release_channel) | [ ] ✅ \| [ ] ❌ | _____ms | |
| 按标签查询快照 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 移除标签 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 输入验证测试（无效枚举值） | [ ] ✅ \| [ ] ❌ | _____ms | |

**通过率**: _____% (_____/7)

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 5️⃣ Protection Rules API 测试

### 测试场景

| 测试用例 | 状态 | 响应时间 | 备注 |
|----------|------|----------|------|
| 创建保护规则 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 列出所有规则 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 获取单个规则 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 更新规则 | [ ] ✅ \| [ ] ❌ | _____ms | |
| Dry-run 规则评估 | [ ] ✅ \| [ ] ❌ | _____ms | |
| 删除规则（cleanup） | [ ] ✅ \| [ ] ❌ | _____ms | |

**通过率**: _____% (_____/6)

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 6️⃣ 功能场景测试

### 场景 1: 保护快照清理跳过

- [ ] **创建 expired + protected 快照**
- [ ] **运行清理操作**
- [ ] **验证受保护快照未被删除**
- [ ] **验证 skipped 计数正确**

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

### 场景 2: 规则驱动的操作阻止

- [ ] **创建阻止规则**
- [ ] **创建匹配条件的快照**
- [ ] **尝试删除操作**
- [ ] **验证操作被阻止**
- [ ] **验证审计日志记录**

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 7️⃣ Grafana 仪表板验证

- [ ] **仪表板文件存在** (grafana/dashboards/snapshot-protection.json)
- [ ] **仪表板已导入到 Grafana**
- [ ] **10 个面板均显示数据**:
  - [ ] Protected Snapshots Count
  - [ ] Protected Skipped
  - [ ] Rule Evaluations
  - [ ] Operations Blocked
  - [ ] Protection Level Distribution
  - [ ] Release Channel Distribution
  - [ ] Top 10 Tags
  - [ ] Rule Evaluation Rate
  - [ ] Blocked Operations
  - [ ] Protected Snapshots Skipped

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**截图**: _（上传 Grafana 仪表板截图）_

---

## 8️⃣ 性能基线测试

### 规则评估性能

| 指标 | 目标值 | 实际值 | 状态 |
|------|--------|--------|------|
| 平均响应时间 | < 50ms | _____ms | [ ] ✅ \| [ ] ❌ |
| P50 延迟 | < 50ms | _____ms | [ ] ✅ \| [ ] ❌ |
| P95 延迟 | < 100ms | _____ms | [ ] ✅ \| [ ] ❌ |
| P99 延迟 | < 150ms | _____ms | [ ] ✅ \| [ ] ❌ |

**测试方法**: 10 次规则评估请求的延迟统计

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 9️⃣ Rollback 能力验证

- [ ] **Migration 1 down() 函数存在**
- [ ] **Migration 2 down() 函数存在**
- [ ] **Down migration 语法正确**

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

**问题**（如有）: _（描述）_

---

## 🔍 PromQL 验证结果

### 指标可抓取性

```promql
# 复制自 Prometheus /metrics 端点
metasheet_snapshot_tags_total{tag="production"} = _____
metasheet_snapshot_protection_level{level="protected"} = _____
metasheet_snapshot_release_channel{channel="stable"} = _____
metasheet_protection_rule_evaluations_total{rule="test-rule", result="matched"} = _____
metasheet_protection_rule_blocks_total{rule="test-rule", operation="delete"} = _____
metasheet_snapshot_protected_skipped_total = _____
```

### 高级查询验证

**规则评估速率**（每分钟）:
```promql
rate(metasheet_protection_rule_evaluations_total[5m]) = _____ /min
```

**规则阻止速率**（每分钟）:
```promql
rate(metasheet_protection_rule_blocks_total[5m]) = _____ /min
```

**P95 延迟**（如有 histogram）:
```promql
histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m])) = _____ms
```

**结果**: [ ] ✅ PASS | [ ] ❌ FAIL

---

## 📋 验证日志

### 完整脚本输出

```bash
# 粘贴 verify-sprint2-staging.sh 完整输出
# 或附加日志文件: staging-verification-{date}.log
```

---

## ⚠️ 警告与建议

### 警告事项

1. _（警告 1 描述）_
2. _（警告 2 描述）_
3. _（警告 3 描述）_

### 改进建议

1. _（建议 1 描述）_
2. _（建议 2 描述）_
3. _（建议 3 描述）_

---

## ✅ 最终结论

**整体验证状态**: [ ] ✅ PASS | [ ] ❌ FAIL

**是否可以合并**: [ ] 是 | [ ] 否（需要修复问题）

**是否需要跟进**: [ ] 是 | [ ] 否

**跟进事项**（如有）:
1. _（事项 1）_
2. _（事项 2）_

---

**验证人签名**: ___________
**验证完成时间**: ___________
**下一步**: [ ] 标记 PR Ready for Review | [ ] 修复问题后重新验证
