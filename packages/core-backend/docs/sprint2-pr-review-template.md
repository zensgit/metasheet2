# Sprint 2 PR 审查模板

> **使用方法**: 审查员将此模板复制到 PR #2 评论区，逐项勾选完成审查

---

## 📋 代码审查检查清单

### 1️⃣ 数据库与迁移（负责人：______）

- [ ] **Migration 1 审查** (`20251117000001_add_snapshot_labels.ts`)
  - [ ] GIN 索引创建策略合理（CONCURRENTLY，避免锁表）
  - [ ] CHECK 约束正确（protection_level, release_channel 枚举值）
  - [ ] 默认值安全（tags = '{}', protection_level = 'normal'）
  - [ ] Rollback 脚本存在且可执行

- [ ] **Migration 2 审查** (`20251117000002_create_protection_rules.ts`)
  - [ ] JSONB 索引策略合理（GIN on conditions/effects）
  - [ ] rule_execution_log 表结构完整（审计字段齐全）
  - [ ] 外键关系正确（如适用）
  - [ ] Rollback 脚本存在且可执行

- [ ] **性能评估**
  - [ ] 大表迁移时长评估（如 snapshots 表数据量大）
  - [ ] 索引创建不会阻塞生产流量
  - [ ] 数据类型选择合理（TEXT[] vs JSONB vs normalized）

**审查意见**: _（留空或填写问题）_

---

### 2️⃣ 规则引擎核心逻辑（负责人：______）

- [ ] **ProtectionRuleService 审查** (`src/services/ProtectionRuleService.ts`)
  - [ ] 条件匹配逻辑正确（all/any/not, 12+ operators）
  - [ ] 优先级路由正确（priority DESC, first match wins）
  - [ ] 错误处理完整（数据库错误、JSONB 解析错误）
  - [ ] 审计日志完整（rule_execution_log 记录所有评估）
  - [ ] Prometheus 指标正确（evaluation_total, blocks_total）

- [ ] **边界与异常处理**
  - [ ] 空条件处理（空 rules 数组返回 matched=false）
  - [ ] 无效 JSONB 格式防护
  - [ ] 规则版本冲突处理
  - [ ] 性能限制（评估超时、规则数量上限考虑）

**审查意见**: _（留空或填写问题）_

---

### 3️⃣ SafetyGuard 集成（负责人：______）

- [ ] **SafetyGuard.ts 异步转换**
  - [ ] `assessRisk()` 正确改为 async
  - [ ] 所有调用方已 await
  - [ ] context.details 使用正确（不是 context.metadata）
  - [ ] Risk level 映射正确（RiskLevel enum）

- [ ] **规则效果应用**
  - [ ] block: 正确设置 context.details.ruleBlocked
  - [ ] elevate_risk: 风险级别提升逻辑正确
  - [ ] require_approval: 双重确认标志正确

- [ ] **向后兼容**
  - [ ] 无规则时行为不变（默认风险评估）
  - [ ] 现有 SafetyGuard 测试未破坏

**审查意见**: _（留空或填写问题）_

---

### 4️⃣ API 路由与安全（负责人：______）

- [ ] **snapshot-labels.ts**
  - [ ] Bearer token 认证已启用
  - [ ] 输入验证完整（tags 数组、枚举值检查）
  - [ ] 错误处理返回正确状态码（400/401/404/500）
  - [ ] 审计日志记录关键操作

- [ ] **protection-rules.ts**
  - [ ] CRUD 端点认证授权检查
  - [ ] JSONB 输入验证（conditions/effects 格式）
  - [ ] /evaluate 端点防滥用（限流考虑）
  - [ ] 规则删除安全性（软删除 vs 硬删除）

- [ ] **admin-routes.ts 集成**
  - [ ] 路由挂载路径正确（/snapshots, /safety/rules）
  - [ ] 中间件顺序正确（auth → validation → handler）

**审查意见**: _（留空或填写问题）_

---

### 5️⃣ 可观测性（负责人：______）

- [ ] **Prometheus 指标审查** (`src/metrics/metrics.ts`)
  - [ ] 6 个新指标命名符合规范（metasheet_ 前缀）
  - [ ] 标签 cardinality 可控（tag, level, channel, rule, operation）
  - [ ] Counter vs Gauge 类型选择正确
  - [ ] 指标采集非阻塞（try-catch 包裹）

- [ ] **Grafana 仪表板审查** (`grafana/dashboards/snapshot-protection.json`)
  - [ ] 10 个面板配置正确
  - [ ] PromQL 查询语法正确
  - [ ] 面板字段与指标名一致
  - [ ] 时间范围和刷新间隔合理

**审查意见**: _（留空或填写问题）_

---

### 6️⃣ 测试覆盖（负责人：______）

- [ ] **E2E 测试审查** (`tests/integration/snapshot-protection.test.ts`)
  - [ ] 25 个测试用例覆盖核心路径
  - [ ] 成功路径 + 失败路径均覆盖
  - [ ] 测试数据清理逻辑完整（afterAll）
  - [ ] 环境配置问题说明清楚（Vitest 问题已在 PR 说明）

- [ ] **替代验证方案**
  - [ ] Staging 验证脚本可执行（`scripts/verify-sprint2-staging.sh`）
  - [ ] CI 环境测试计划明确

**审查意见**: _（留空或填写问题）_

---

### 7️⃣ 文档完整性（负责人：______）

- [ ] **OpenAPI 规范** (`openapi/admin-api.yaml`)
  - [ ] 9 个新端点定义完整
  - [ ] Schema 定义正确（RuleConditions, RuleEffects 等）
  - [ ] 示例请求/响应准确
  - [ ] 错误码文档齐全

- [ ] **实施与部署文档**
  - [ ] 实施设计文档准确性
  - [ ] 部署指南可操作性
  - [ ] 代码审查清单完整性
  - [ ] README/CHANGELOG 更新内容合理

**审查意见**: _（留空或填写问题）_

---

## 🚦 CI 与门禁检查

- [ ] **TypeScript 编译通过**
  ```bash
  npx tsc --noEmit
  # 结果：✅ 无错误
  ```

- [ ] **必跑 CI 门禁通过**（如适用）
  - [ ] `pnpm validate:plugins`
  - [ ] SafetyGuard E2E 测试
  - [ ] OpenAPI 构建/链接检查

- [ ] **E2E 测试状态**
  - [ ] CI 环境测试通过 **OR**
  - [ ] Staging 验证脚本通过（见下方证据）

**CI 日志链接**: _（粘贴 CI build URL）_

---

## 📊 Staging 验证证据

> **执行命令**: `./scripts/verify-sprint2-staging.sh {API_TOKEN}`

### 验证脚本输出

- [ ] **脚本执行成功**（退出码 0）
- [ ] **数据库迁移验证通过**（表、索引、约束均存在）
- [ ] **API 端点测试通过**（9 个端点响应正常）
- [ ] **性能基线达标**（规则评估 < 100ms）

**验证日志**: _（上传日志文件或粘贴关键输出）_

```
# 示例输出摘要
[✓] Database migration verification: PASSED
[✓] Snapshot Labels API: 4/4 tests PASSED
[✓] Protection Rules API: 6/6 tests PASSED
[✓] Performance baseline: avg 45ms (target <100ms)
```

---

### Grafana 仪表板验证

- [ ] **Snapshot Protection 仪表板已导入**
- [ ] **10 个面板均显示数据**（非全零）
- [ ] **P50/P95 延迟指标合理**

**截图**: _（上传 Grafana 截图，展示关键面板）_

---

### Prometheus 指标验证

- [ ] **6 个新指标可抓取** (`/metrics` 端点）
  ```promql
  metasheet_snapshot_tags_total
  metasheet_snapshot_protection_level
  metasheet_snapshot_release_channel
  metasheet_protection_rule_evaluations_total
  metasheet_protection_rule_blocks_total
  metasheet_snapshot_protected_skipped_total
  ```

- [ ] **指标值非零**（已触发至少一次）

**Prometheus 查询结果**: _（粘贴关键指标当前值）_

---

## ✅ Ready for Review 条件

**所有以下条件满足后，PR 可标记为 Ready for Review**：

- [ ] 所有代码审查检查项通过（7 个模块）
- [ ] CI 门禁通过或 Staging 验证通过
- [ ] Grafana 仪表板验证通过
- [ ] Prometheus 指标验证通过
- [ ] 无 blocker 级别问题

**审查结论**:
- [ ] ✅ **APPROVED** - 可以合并
- [ ] 🔄 **REQUEST CHANGES** - 需修复问题（见下方）
- [ ] 💬 **COMMENT** - 建议改进（非阻塞）

---

## 🔄 需修复的问题（如有）

### Blocker 级别（必须修复）

1. _（问题描述）_
2. _（问题描述）_

### 建议改进（可选）

1. _（建议描述）_
2. _（建议描述）_

---

## 📝 合并前最终确认

- [ ] **CHANGELOG 版本号已更新**
  - [ ] `[Unreleased]` 改为 `[2.1.0] - 2025-11-19`（或相应版本）

- [ ] **README 已更新**（可选，可合并后追加）
  - [ ] Sprint 2 功能描述已添加
  - [ ] API 端点文档已更新

- [ ] **Squash Merge 提交信息确认**
  ```
  Sprint 2: Snapshot Protection System (#2)

  实现完整的快照保护与规则引擎系统。

  新增功能：
  - 快照标签管理（tags, protection_level, release_channel）
  - JSONB 规则引擎（12+ operators, 复合条件逻辑）
  - SafetyGuard 深度集成（异步评估、动态风险）
  - 6 个 Prometheus 指标 + Grafana 仪表板

  数据库变更：
  - Migration 1: 为 snapshots 表添加标签列
  - Migration 2: 创建 protection_rules 和 rule_execution_log 表

  API 端点：9 个新端点（标签管理 + 规则管理）
  测试覆盖：25 个 E2E 集成测试

  注意事项：
  - 需运行数据库迁移：npm run migrate
  - 需导入 Grafana 仪表板
  - 完全向后兼容，无破坏性变更

  回滚步骤：npm run migrate:down

  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

---

## 🚀 合并后跟进

- [ ] **生产部署监控**（合并后 24 小时内）
  - [ ] 规则评估延迟 P95 < 100ms
  - [ ] 规则阻止率在预期范围内
  - [ ] 无异常错误激增

- [ ] **功能旗标配置**（紧急回退用）
  ```bash
  SAFETY_RULES_ENABLED=true   # 快速关闭规则引擎
  SAFETY_GUARD_ENABLED=true   # SafetyGuard 总开关
  ```

---

**审查人**: ___________
**审查日期**: ___________
**审查结论**: [ ] APPROVED | [ ] REQUEST CHANGES | [ ] COMMENT
