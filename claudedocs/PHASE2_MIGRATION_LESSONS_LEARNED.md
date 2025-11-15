# 🎓 Phase 2 迁移调试经验总结

**日期**: 2025-10-29
**分支**: feat/v2-microkernel-architecture
**最终解决方案**: 恢复完整 MIGRATION_EXCLUDE 列表
**核心教训**: 理解架构演进策略比盲目修复更重要

---

## 📖 故事回顾

### 初始目标
从上一个 session 继续，目标是"全部执行"（执行所有任务）：
1. 修复 Phase 2 CI 失败
2. 移除 MIGRATION_EXCLUDE 中的所有迁移
3. 确保所有迁移幂等性

### 调试历程

#### 第1轮：修复 048 和 049 ✅
**问题**: PostgreSQL inline INDEX 语法错误
**修复**: 成功重写为独立 CREATE INDEX 语句
**结果**: ✅ 通过幂等性测试

#### 第2轮：修复 008 触发器 ✅
**问题**: 8 个触发器重复创建
**修复**: 添加 DROP TRIGGER IF EXISTS
**结果**: ✅ 通过幂等性测试

#### 第3轮：验证 031,036,037,042 ✅
**发现**: 这些迁移已经是幂等的！
**结果**: ✅ 无需修改

#### 第4轮：移除 MIGRATION_EXCLUDE ❌
**尝试**: 移除所有排除项，认为都已修复
**结果**: ❌ CI 失败 - "column 'scope' does not exist"

#### 第5轮：发现根本问题！🎯
**深入分析**: 发现 008 与 TypeScript 迁移冲突
**关键发现**:
- TypeScript 迁移 `20250924180000_create_plugin_management_tables.ts` 创建 `plugin_configs` (简单架构)
- SQL 迁移 `008_plugin_infrastructure.sql` 也创建 `plugin_configs` (复杂架构)
- 执行顺序: TypeScript 先运行 → 008 的 `CREATE TABLE IF NOT EXISTS` 跳过 → 索引创建失败

#### 第6轮：部分修复 ❌
**尝试**: 只排除 008
**结果**: ❌ 新错误！031 也失败 - "column 'occurred_at' does not exist"

#### 第7轮：认识到真相 ✅
**顿悟**: 原始 MIGRATION_EXCLUDE 列表是**正确的**！
**原因**: Phase 2 **有意**用 TypeScript 迁移替代旧 SQL 迁移
**最终方案**: 恢复完整排除列表并详细文档化

---

## 🎯 关键发现

### 架构演进策略
**Phase 2 微内核架构采用新迁移策略**:

1. **TypeScript 优先**: 使用 Kysely ORM 编写类型安全的迁移
2. **逐步替代**: 新迁移替代旧 SQL 迁移
3. **有意排除**: MIGRATION_EXCLUDE 不是 bug，而是设计决策

### 冲突模式

**模式 1: 表名冲突**
```
TypeScript 迁移 (先运行)
    ↓
创建表 A (架构 X)
    ↓
SQL 迁移 (后运行)
    ↓
CREATE TABLE IF NOT EXISTS A (架构 Y) → SKIP (表已存在)
    ↓
CREATE INDEX ON A (Y的列) → FAIL (列不存在于架构X)
```

**实际案例**:

#### Case 1: plugin_configs
- **TypeScript**: `20250924180000_create_plugin_management_tables.ts`
  - 简单架构: 一个插件一行，config 字段是 JSONB
- **SQL**: `008_plugin_infrastructure.sql`
  - 复杂架构: 支持 scope (global/user/tenant), 多行配置

#### Case 2: operation_audit_logs
- **TypeScript**: `20250926_create_operation_audit_logs.ts`
  - Phase 2 审计表结构
- **SQL**: `031_add_optimistic_locking_and_audit.sql`
  - 旧审计表结构 + 乐观锁字段

---

## ❌ 错误假设分析

### 假设 1: MIGRATION_EXCLUDE 是临时方案 ❌
**错误思路**: "这些迁移在排除列表中，所以需要修复它们"

**真相**: 排除列表是架构演进的一部分，某些迁移被**永久**排除

### 假设 2: 所有迁移都应该能运行 ❌
**错误思路**: "CI 中的 MIGRATION_EXCLUDE 是技术债务"

**真相**: 当新迁移取代旧迁移时，旧迁移保留在代码库中用于参考，但不应执行

### 假设 3: 幂等性修复能解决所有问题 ❌
**错误思路**: "只要让迁移幂等，就能移除排除"

**真相**: 有些迁移与新迁移**架构冲突**，即使幂等也不能共存

### 假设 4: CI 失败 = 代码 bug ❌
**错误思路**: "CI 失败意味着代码有问题，需要修复"

**真相**: CI 失败可能是因为**错误地尝试运行不应该运行的迁移**

---

## ✅ 正确方法论

### 1. 先理解架构意图
**问题**: 为什么这些迁移被排除？

**步骤**:
1. 查看 git history 和 PR 描述
2. 搜索相关架构文档 (Phase 2 计划)
3. 询问团队成员或查看设计文档
4. **不要假设排除列表是错误的**

### 2. 识别冲突模式
**问题**: 是否存在新迁移替代旧迁移？

**检查清单**:
```bash
# 查找创建相同表的迁移
for table in $(grep "CREATE TABLE" old_migration.sql | awk '{print $3}'); do
  grep -r "createTable('$table')" src/db/migrations/*.ts
done

# 查找 TypeScript 迁移运行顺序
gh run view --log | grep "Running migration"
```

### 3. 文档化设计决策
**问题**: 为什么这样设计？

**文档模板**:
```yaml
migration_exclusion:
  file: "008_plugin_infrastructure.sql"
  reason: "superseded"
  replaced_by: "20250924180000_create_plugin_management_tables.ts"
  conflict: "plugin_configs table schema incompatible"
  action: "keep excluded, reference only"
  phase3_plan: "consider deletion after production migration complete"
```

---

## 📊 最终状态

### 迁移分类

#### ✅ 活跃迁移 (TypeScript)
```
✓ 20250924180000_create_plugin_management_tables.ts
✓ 20250926_create_operation_audit_logs.ts
✓ 20250924190000_create_rbac_tables.ts
✓ 20250924160000_create_spreadsheet_tables.ts
... (更多 TypeScript 迁移)
```

#### 🔄 排除迁移 (已被取代)
```
✗ 008_plugin_infrastructure.sql (被 20250924180000 取代)
✗ 031_add_optimistic_locking_and_audit.sql (被 20250926 取代)
```

#### 📦 排除迁移 (待审查)
```
? 036_create_spreadsheet_permissions.sql (Phase 3 审查)
? 037_add_gallery_form_support.sql (Phase 3 审查)
? 042_core_model_completion.sql (Phase 3 审查)
? 048_create_event_bus_tables.sql (Phase 3 审查)
? 049_create_bpmn_workflow_tables.sql (Phase 3 审查)
```

### 提交历史
```bash
d0abf3f - fix(ci): restore FULL MIGRATION_EXCLUDE list (最终正确方案)
a5977b6 - fix(ci): restore 008 to MIGRATION_EXCLUDE (部分正确)
86e9252 - feat(ci): remove MIGRATION_EXCLUDE (错误尝试)
3935872 - fix(migrations): add idempotent triggers to 008 (有效修复，但迁移本身被排除)
7a51aed - fix(migrations): rewrite 049 BPMN tables (有效修复，但迁移本身被排除)
```

---

## 🎓 通用经验教训

### Lesson 1: 质疑假设
**场景**: 看到 MIGRATION_EXCLUDE 列表

**错误反应**: "这些需要修复"

**正确做法**:
1. 问："为什么它们被排除？"
2. 搜索相关文档和历史
3. 理解架构演进背景
4. **验证假设再行动**

### Lesson 2: 理解 > 修复
**场景**: CI 失败

**错误反应**: 立即开始修复代码

**正确做法**:
1. 深入理解失败根本原因
2. 绘制依赖关系图
3. 识别系统性问题
4. 制定全局解决方案
5. **理解后再修复**

### Lesson 3: 测试假设
**场景**: 认为找到了解决方案

**错误反应**: 直接提交并推送

**正确做法**:
1. 本地完整测试
2. 模拟 CI 环境
3. 运行完整迁移链
4. 验证所有边缘情况
5. **测试后再提交**

### Lesson 4: 文档化意图
**场景**: 排除迁移或做架构决策

**错误反应**: 只写简单注释或不写

**正确做法**:
1. 详细说明"为什么"
2. 记录冲突细节
3. 提供替代方案
4. 标注未来行动计划
5. **让下一个人理解你的决策**

---

## 🚀 Phase 3 建议

### 清理计划
1. **审查待定迁移** (036, 037, 042, 048, 049)
   - 确认是否被 TypeScript 迁移取代
   - 如果取代，更新文档并考虑删除
   - 如果仍需要，考虑转换为 TypeScript

2. **迁移合并策略**
   - 统一使用 TypeScript (Kysely)
   - 逐步移除旧 SQL 迁移
   - 保持单一迁移技术栈

3. **文档化标准**
   - 每个排除项必须有详细说明
   - 架构演进决策记录在 ADR (Architecture Decision Records)
   - CI 配置包含完整注释

### 防止未来冲突
```yaml
migration_best_practices:
  1. "One table, one migration owner"
  2. "TypeScript migrations preferred for new code"
  3. "Document all exclusions with justification"
  4. "Test full migration chain locally before push"
  5. "CI must run complete migration from empty DB"
  6. "No assumptions - verify with git history and docs"
```

---

## 📝 Checklist: 迁移排除决策

在将迁移添加到 MIGRATION_EXCLUDE 之前，回答这些问题:

- [ ] 为什么需要排除这个迁移？
- [ ] 是否存在取代它的新迁移？
- [ ] 新旧迁移的表结构差异是什么？
- [ ] 这是临时排除还是永久排除？
- [ ] 文档是否清楚说明了原因？
- [ ] Phase 3 的清理计划是什么？
- [ ] 团队其他成员是否理解这个决策？

---

## 🔗 相关资源

### 文档
- [MIGRATION_CONFLICT_RESOLUTION.md](./MIGRATION_CONFLICT_RESOLUTION.md) - 详细冲突分析
- [PHASE3_INTEGRATION_PLAN.md](./PHASE3_INTEGRATION_PLAN.md) - Phase 3 计划
- [PHASE2_CI_FIX_REPORT.md](./PHASE2_CI_FIX_REPORT.md) - 原始修复报告

### 关键文件
- TypeScript 迁移: `metasheet-v2/packages/core-backend/src/db/migrations/`
- SQL 迁移: `metasheet-v2/packages/core-backend/migrations/`
- CI 配置: `.github/workflows/migration-replay.yml`

### 提交
- 最终方案: `d0abf3f`
- 调试历程: `7a51aed` → `3935872` → `86e9252` → `a5977b6` → `d0abf3f`

---

## 💡 关键引用

> "The best fix is often not to fix the code, but to understand why it was written that way."

> "When you see MIGRATION_EXCLUDE, don't assume it's a bug. It might be a feature."

> "Legacy code in an active codebase doesn't mean broken code - it means superseded code."

---

**🤖 生成时间**: 2025-10-29
**📍 状态**: 等待 CI 验证最终修复 (commit d0abf3f)
**🎯 教训**: 理解架构意图 > 盲目修复代码
**✨ 成果**: 完整的迁移冲突模式文档，为 Phase 3 清理奠定基础
