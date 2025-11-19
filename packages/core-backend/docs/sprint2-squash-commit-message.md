Sprint 2: Snapshot Protection System (#2)

## 📋 概述

实现完整的快照保护与规则引擎系统，提供灵活的标签管理、基于规则的保护策略和增强的可观测性。

## ✨ 新增功能

### 快照标签系统
- 为快照添加 tags（文本数组）、protection_level（normal/protected/critical）、release_channel（stable/canary/beta/experimental）
- 支持标签的添加、移除、替换操作
- 支持按标签、保护级别、发布渠道查询快照
- GIN 索引确保高效的数组查询性能

### 保护规则引擎
- JSONB 条件匹配引擎（支持 12+ 操作符: eq, ne, contains, in, gt, lt, gte, lte, exists, not_exists 等）
- 复合条件逻辑（all/any/not）
- 优先级路由（priority-based, first match wins）
- 4 种效果类型：allow, block, elevate_risk, require_approval
- 完整的 CRUD API 和 dry-run 评估端点
- 审计日志记录所有规则评估

### SafetyGuard 深度集成
- 异步规则评估集成
- 动态风险级别提升
- 规则驱动的操作阻止
- 双重确认要求支持

### 增强的可观测性
- 6 个新增 Prometheus 指标：
  - metasheet_snapshot_tags_total
  - metasheet_snapshot_protection_level
  - metasheet_snapshot_release_channel
  - metasheet_protection_rule_evaluations_total
  - metasheet_protection_rule_blocks_total
  - metasheet_snapshot_protected_skipped_total
- 专用 Grafana 仪表板（10 个可视化面板）
- 完整的审计日志（规则评估 + 标签操作）

## 🗄️ 数据库变更

### Migration 1: 20251117000001_add_snapshot_labels.ts
为 snapshots 表添加标签列：
- tags TEXT[] DEFAULT '{}' (GIN 索引)
- protection_level TEXT DEFAULT 'normal' (B-tree 索引)
- release_channel TEXT (B-tree 索引)
- CHECK 约束确保枚举值有效性

### Migration 2: 20251117000002_create_protection_rules.ts
创建保护规则基础设施：
- protection_rules 表: 规则定义（JSONB 条件 + 效果）
- rule_execution_log 表: 规则评估审计日志
- GIN 索引用于高效 JSONB 查询
- 优先级和版本控制支持

**⚠️ 迁移注意事项**:
- GIN 索引使用 CONCURRENTLY 创建，避免锁表
- 适用于大表（snapshots 表如有大量数据，预计 5-10 分钟）
- 需要 SUPERUSER 或 CREATE INDEX 权限

**回滚步骤**: `npm run migrate:down`

## 🔌 API 端点（9 个新端点）

### Snapshot Labels API
- PUT /api/admin/snapshots/:id/tags - 添加/移除标签
- PATCH /api/admin/snapshots/:id/protection - 设置保护级别
- PATCH /api/admin/snapshots/:id/release-channel - 设置发布渠道
- GET /api/admin/snapshots - 按标签/保护级别/渠道查询

### Protection Rules API
- POST /api/admin/safety/rules - 创建规则
- GET /api/admin/safety/rules - 列出所有规则
- GET /api/admin/safety/rules/:id - 获取单个规则
- PATCH /api/admin/safety/rules/:id - 更新规则
- DELETE /api/admin/safety/rules/:id - 删除规则
- POST /api/admin/safety/rules/evaluate - Dry-run 规则评估

## 🧪 测试覆盖

- 25 个 E2E 集成测试
  - Snapshot Labeling API (8 tests)
  - Protection Rules API (10 tests)
  - Protected Snapshot Cleanup (2 tests)
  - SafetyGuard Integration (5 tests)

## 📊 统计数据

- **新建文件**: 11 个
- **修改文件**: 6 个
- **代码行数**: ~1,500 行
- **文档文件**: 9 个（实施设计、部署指南、审查清单等）
- **API 端点**: 9 个
- **Prometheus 指标**: 6 个
- **Grafana 面板**: 10 个
- **数据库表**: 2 个新表

## 🔒 安全考量

- 所有管理 API 端点都需要 Bearer token 认证
- 规则评估过程记录审计日志
- 受保护的快照在自动清理时会被跳过
- 输入验证防止无效枚举值
- SQL 注入防护（参数化查询）

## ⚡ 性能指标

- 规则评估目标延迟: < 100ms
- GIN 索引: 高效的数组和 JSONB 查询
- 并发索引创建: 避免锁表
- 非阻塞指标收集: Prometheus 指标采集不影响主流程

## 🔄 向后兼容性

✅ **完全向后兼容**

- 现有快照自动获得默认值（tags = [], protection_level = 'normal'）
- 未受保护的快照清理行为不变
- 无破坏性 API 变更
- 新功能为可选功能，不影响现有流程

## 📚 文档

- 实施设计文档: docs/sprint2-snapshot-protection-implementation.md
- 部署指南: docs/sprint2-deployment-guide.md
- 代码审查清单: docs/sprint2-code-review-checklist.md
- 审查模板: docs/sprint2-pr-review-template.md
- 验证脚本: scripts/verify-sprint2-staging.sh
- README 更新: docs/sprint2-readme-update.md
- CHANGELOG: CHANGELOG.md

## 🚀 部署步骤

1. **运行数据库迁移**:
   ```bash
   npm run migrate
   ```

2. **验证迁移成功**:
   ```bash
   psql -d metasheet -c "SELECT * FROM protection_rules LIMIT 1;"
   ```

3. **导入 Grafana 仪表板**:
   - 导入 grafana/dashboards/snapshot-protection.json

4. **（可选）运行 Staging 验证**:
   ```bash
   ./scripts/verify-sprint2-staging.sh {API_TOKEN}
   ```

## 🔄 回滚计划

如果需要回滚：

```bash
# 1. 回滚数据库迁移
npm run migrate:down

# 2. 切换代码到 main 分支前一个版本
git checkout main~1

# 3. 重启服务
systemctl restart metasheet
```

**数据影响**: 回滚会删除 protection_rules 和 rule_execution_log 表，移除 snapshots 表的新增列。已添加的标签和保护级别数据会丢失。

## 🚨 监控要点

### 关键指标（合并后 24 小时内监控）

1. **规则评估性能**:
   ```promql
   histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m]))
   # 告警阈值: P95 > 150ms
   ```

2. **规则阻止率**:
   ```promql
   rate(metasheet_protection_rule_blocks_total[5m])
   /
   rate(metasheet_protection_rule_evaluations_total[5m])
   # 告警阈值: > 10%（异常高阻止率）
   ```

3. **错误率监控**:
   - 检查 SafetyGuard 和 ProtectionRuleService 错误日志
   - 告警阈值: 错误率 > 1%

### 回滚触发条件（任一满足立即回滚）

- 规则评估 P95 > 200ms 持续 > 10 分钟
- 错误率 > 1% 持续 > 5 分钟
- 数据库死锁或严重性能问题
- 关键功能不可用

## 🏷️ 功能旗标（紧急回退）

可通过环境变量快速关闭功能：

```bash
SAFETY_RULES_ENABLED=false   # 关闭规则引擎
SAFETY_GUARD_ENABLED=false   # 关闭 SafetyGuard（仅极端情况）
```

## 👥 贡献者

- **开发**: Claude (AI Assistant)
- **审查**: [待填写]
- **测试**: [待填写]
- **部署**: [待填写]

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
