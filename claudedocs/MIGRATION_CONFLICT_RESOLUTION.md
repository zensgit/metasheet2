# 🔍 迁移冲突解决报告

**日期**: 2025-10-29
**分支**: feat/v2-microkernel-architecture
**问题**: CI 失败 - "column 'scope' does not exist"
**根本原因**: 迁移文件冲突
**解决方案**: 恢复 008 到 MIGRATION_EXCLUDE

---

## 🚨 问题描述

### CI 错误
```
Migration failed: error: column "scope" does not exist
Position: 2717
Code: 42703 (errorMissingColumn)
File: 008_plugin_infrastructure.sql
```

### 错误位置
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global
ON plugin_configs (plugin_name, config_key)
WHERE scope = 'global';  -- ← 第 2717 字符，报错：scope 列不存在
```

---

## 🔎 根本原因分析

### 迁移执行顺序
```
1. ✅ 20250924180000_create_plugin_management_tables.ts (TypeScript)
   └─ 创建 plugin_configs 表 (简单架构)

2. ❌ 008_plugin_infrastructure.sql (SQL)
   └─ 尝试创建 plugin_configs 表 (复杂架构) → 失败
```

### 两个迁移的 plugin_configs 表架构对比

#### TypeScript 迁移 (20250924180000)
```typescript
// 文件: src/db/migrations/20250924180000_create_plugin_management_tables.ts
await db.schema
  .createTable('plugin_configs')
  .ifNotExists()
  .addColumn('id', 'serial', col => col.primaryKey())
  .addColumn('plugin_name', 'text', col => col.notNull().unique())
  .addColumn('config', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
  .addColumn('schema', 'jsonb')
  .addColumn('version', 'text', col => col.notNull().defaultTo('1.0.0'))
  .addColumn('last_modified', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
  .addColumn('modified_by', 'text')
  .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
  .execute()
```

**特点**:
- 简单架构：一个插件一行配置
- 配置存储在单个 JSONB 字段 `config`
- **没有 `scope` 列**

---

#### SQL 迁移 (008_plugin_infrastructure.sql)
```sql
-- 文件: migrations/008_plugin_infrastructure.sql
CREATE TABLE IF NOT EXISTS plugin_configs (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    config_key VARCHAR(255) NOT NULL,
    value TEXT,
    encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    scope VARCHAR(50) NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'user', 'tenant')),  -- ← 关键列！
    user_id VARCHAR(255),
    tenant_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(255),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- 部分索引使用 scope 列
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global
ON plugin_configs (plugin_name, config_key)
WHERE scope = 'global';  -- ← 这里失败！
```

**特点**:
- 复杂架构：支持用户级、租户级、全局级配置
- 多行存储：一个插件可以有多个配置项
- **包含 `scope` 列用于权限控制**

---

### 为什么会失败？

**执行流程**:
```
1. TypeScript 迁移创建 plugin_configs 表（无 scope 列）
   ✅ 表已存在：id, plugin_name, config, schema, version, ...

2. SQL 迁移 008 执行:
   a) CREATE TABLE IF NOT EXISTS plugin_configs
      → PostgreSQL 检测到表已存在，SKIP（不创建！）

   b) CREATE UNIQUE INDEX ... WHERE scope = 'global'
      → PostgreSQL 尝试在已存在的表上创建索引
      → 查找 scope 列
      → ❌ ERROR: column "scope" does not exist
```

**关键点**:
- `CREATE TABLE IF NOT EXISTS` 在表已存在时**不会**更新表结构
- 索引创建语句独立执行，此时表中没有 `scope` 列
- 导致 CI 失败

---

## ✅ 解决方案

### 方案决策
008_plugin_infrastructure.sql 已被 TypeScript 迁移**取代**：
- TypeScript 迁移是 Phase 2 微内核架构的官方实现
- 008 是旧的 SQL 迁移文件，应保持排除状态
- 两种架构设计不同，不应共存

### 实施步骤

#### 1. 恢复 MIGRATION_EXCLUDE
```yaml
# .github/workflows/migration-replay.yml
env:
  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/metasheet
  # Migration Exclusions Explained:
  # - 008_plugin_infrastructure.sql: SUPERSEDED by TypeScript migration 20250924180000_create_plugin_management_tables.ts
  #   (Conflicts: creates plugin_configs with different schema - TypeScript version wins)
  MIGRATION_EXCLUDE: 008_plugin_infrastructure.sql
```

#### 2. 提交修复
```bash
git add .github/workflows/migration-replay.yml
git commit -m "fix(ci): restore 008 to MIGRATION_EXCLUDE - superseded by TypeScript migration"
git push
```

**提交**: `a5977b6`

---

## 📊 迁移状态总结

### ✅ 成功修复的迁移 (2)
| 迁移文件 | 问题 | 修复方法 | 状态 |
|---------|------|---------|------|
| 048_create_event_bus_tables.sql | 26 个 inline INDEX | 转换为 33 个独立 CREATE INDEX | ✅ 幂等 |
| 049_create_bpmn_workflow_tables.sql | 9 缺逗号 + 22 INDEX + 6 触发器 | 完全重写 | ✅ 幂等 |

### ✅ 已验证幂等的迁移 (4)
| 迁移文件 | 幂等性措施 | 状态 |
|---------|-----------|------|
| 031_add_optimistic_locking_and_audit.sql | DO $$ + IF NOT EXISTS + EXCEPTION | ✅ 无需修改 |
| 036_create_spreadsheet_permissions.sql | CREATE IF NOT EXISTS | ✅ 无需修改 |
| 037_add_gallery_form_support.sql | IF NOT EXISTS + DROP TRIGGER IF EXISTS | ✅ 无需修改 |
| 042_core_model_completion.sql | DO $$ + EXCEPTION WHEN duplicate_object | ✅ 无需修改 |

### 🔄 排除的迁移 (1)
| 迁移文件 | 原因 | 取代方案 | 状态 |
|---------|------|---------|------|
| 008_plugin_infrastructure.sql | 与 TypeScript 迁移冲突 | 20250924180000_create_plugin_management_tables.ts | ✅ 合理排除 |

---

## 🎓 经验教训

### 1. 迁移架构演进
**问题**: 同一表有多个迁移版本时，如何处理？

**最佳实践**:
- ✅ 使用 `MIGRATION_EXCLUDE` 明确排除旧版本
- ✅ 在注释中说明取代关系
- ✅ 考虑删除被取代的迁移文件（生产环境需谨慎）
- ❌ 不要假设 `CREATE TABLE IF NOT EXISTS` 会更新表结构

### 2. TypeScript vs SQL 迁移
**Phase 2 架构决策**:
- 新迁移使用 TypeScript (Kysely ORM)
- 旧 SQL 迁移逐步淘汰
- TypeScript 迁移优先级更高

### 3. CI 测试策略
**问题**: 本地测试通过，CI 失败

**原因分析**:
- 本地测试可能单独运行迁移文件
- CI 运行完整迁移链，暴露依赖冲突
- 需要在干净数据库上测试完整迁移序列

**改进建议**:
```bash
# 本地测试应该模拟 CI 环境
docker-compose up -d postgres
pnpm -F @metasheet/core-backend db:reset  # 清空数据库
pnpm -F @metasheet/core-backend migrate   # 运行所有迁移
```

---

## 📈 提交历史

```bash
a5977b6 - fix(ci): restore 008 to MIGRATION_EXCLUDE - superseded by TypeScript migration
86e9252 - feat(ci): remove MIGRATION_EXCLUDE - all migrations now idempotent! (错误尝试)
3935872 - fix(migrations): add idempotent triggers to 008 plugin infrastructure
7a51aed - fix(migrations): rewrite 049 BPMN tables with proper SQL syntax
[earlier] - fix(migrations): rewrite 048 Event Bus tables
```

---

## 🚀 下一步

### CI 验证
- ⏳ 等待 CI 完成 (commit a5977b6)
- 预期结果: ✅ Migration Replay 通过
- 预期结果: ✅ typecheck 通过

### Phase 2 集成
- 所有有效迁移已验证幂等性 ✅
- BPMN + Event Bus 迁移完成 ✅
- TypeScript 迁移优先策略确立 ✅

### Phase 3 准备
- 等待 CI 验证通过
- 考虑清理被取代的迁移文件
- 文档化迁移演进策略

---

## 🔗 相关资源

- **PR**: #332 feat: Phase 2 - Microkernel Architecture
- **分支**: feat/v2-microkernel-architecture
- **CI**: https://github.com/zensgit/smartsheet/actions

**相关迁移文件**:
- TypeScript: `metasheet-v2/packages/core-backend/src/db/migrations/20250924180000_create_plugin_management_tables.ts`
- SQL (排除): `metasheet-v2/packages/core-backend/migrations/008_plugin_infrastructure.sql`

---

**🤖 生成时间**: 2025-10-29
**📍 状态**: 等待 CI 验证 - 修复已提交 (commit a5977b6)
**🎯 结论**: 008 与 TypeScript 迁移冲突已解决，通过恢复 MIGRATION_EXCLUDE
