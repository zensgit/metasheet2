# SQL 迁移修复详细指南

> **⚠️ 2026-07-12 陈旧标注（T8 文档化，未删除，仅存历史记录）**
> 本指南生成于 2025-10-29，目标路线="逐个修复 7 个排除的 SQL 迁移文件使其幂等，然后把
> `MIGRATION_EXCLUDE` 清空"。**该路线已于 2026-05-12 被彻底废弃**，改用
> `packages/core-backend/src/db/migration-provider.ts` 里的 `SUPERSEDED_LEGACY_SQL_MIGRATIONS`
> "no-op 双胞胎迁移"机制：不再逐条修复历史 SQL 文件的幂等性，而是把 032-055 号整批老 SQL
> 迁移标记为永久 no-op 历史占位符（名字保留、body 不跑），由现代 timestamp/`zzzz` 迁移作为
> 真正的替代实现。参见 `docs/development/migration-legacy-sql-skip-design-20260512.md`（设计决策）
> 与 `docs/development/superseded-legacy-migrations-gap-audit-20260710.md`（2026-07-10 缺口审计）。
> 本文档下方"修复进度追踪"里的 1/7 (14%) 进度**已冻结、不会再推进**——不要在没有先读上述
> 设计文档的情况下续跑本指南的 Phase 1/2/3 计划。当前权威、活跃的排除名单说明见同目录上级的
> `packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md`。
>
> **项目**: MetaSheet v2
> **目标**: 修复 7 个排除的迁移文件
> **优先级**: P0 - 阻塞 Phase 3 发布

---

## 快速参考

### 当前排除列表
```yaml
MIGRATION_EXCLUDE: >
  008_plugin_infrastructure.sql,
  031_add_optimistic_locking_and_audit.sql,
  036_create_spreadsheet_permissions.sql,
  037_add_gallery_form_support.sql,
  042_core_model_completion.sql,
  048_create_event_bus_tables.sql,
  049_create_bpmn_workflow_tables.sql
```

### 修复顺序
1. ✅ **048** - Event Bus (已修复，待验证)
2. 🔧 **049** - BPMN Workflow (需重写)
3. 🔧 **008** - Plugin Infrastructure
4. 🔧 **031** - Optimistic Locking
5. 🔧 **036** - Spreadsheet Permissions
6. 🔧 **037** - Gallery Form Support
7. 🔧 **042** - Core Model Completion

---

## 048_create_event_bus_tables.sql ✅

### 状态
**已修复** - 所有内联 INDEX 已转换为独立语句

### 验证步骤
```bash
# 1. 重置数据库
dropdb -h localhost -U postgres metasheet_test && \
createdb -h localhost -U postgres metasheet_test
psql -h localhost -U postgres -d metasheet_test -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. 测试幂等性
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 048_create_event_bus_tables.sql
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 048_create_event_bus_tables.sql  # 第二次应该成功

# 3. 验证表结构
psql -d metasheet_test -c "\dt event_*"
psql -d metasheet_test -c "\di event_*"
psql -d metasheet_test -c "\d event_store"  # 检查分区表
```

### 检查清单
- [x] 所有 INDEX 独立创建
- [x] 分区表 PRIMARY KEY 包含 occurred_at
- [ ] 幂等性测试通过
- [ ] 从 MIGRATION_EXCLUDE 移除

---

## 049_create_bpmn_workflow_tables.sql 🔧

### 问题诊断
```bash
# 检查文件问题
cd packages/core-backend/migrations
grep -n "INDEX\|incident_message" 049_create_bpmn_workflow_tables.sql | head -20
```

### 已知问题
1. **22 个内联 INDEX**
2. **84+ 处缺失逗号**
3. **9 处尾随逗号**
4. **多处 syntax error**

### 修复策略：完全重写

#### 第 1 步：备份原文件
```bash
cp 049_create_bpmn_workflow_tables.sql 049_create_bpmn_workflow_tables.sql.backup
```

#### 第 2 步：创建新文件骨架
```sql
-- 049_create_bpmn_workflow_tables.sql
-- BPMN 2.0 Workflow Engine Tables
-- Generated: 2025-10-29

-- ==========================================
-- 1. Process Definitions (流程定义)
-- ==========================================
CREATE TABLE IF NOT EXISTS bpmn_process_definitions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  bpmn_xml TEXT NOT NULL,
  diagram_json JSONB,
  category TEXT,
  tenant_id TEXT,
  deployment_id TEXT,
  resource_name TEXT,
  has_start_form BOOLEAN DEFAULT false,
  is_suspended BOOLEAN DEFAULT false,
  is_executable BOOLEAN DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 唯一约束
  CONSTRAINT unique_process_key_version UNIQUE (key, version, tenant_id)
);

-- Indexes for bpmn_process_definitions
CREATE INDEX IF NOT EXISTS idx_bpmn_process_def_key ON bpmn_process_definitions (key);
CREATE INDEX IF NOT EXISTS idx_bpmn_process_def_version ON bpmn_process_definitions (key, version);
CREATE INDEX IF NOT EXISTS idx_bpmn_process_def_category ON bpmn_process_definitions (category);
CREATE INDEX IF NOT EXISTS idx_bpmn_process_def_tenant ON bpmn_process_definitions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bpmn_process_def_suspended ON bpmn_process_definitions (is_suspended);

-- Comments
COMMENT ON TABLE bpmn_process_definitions IS 'BPMN 2.0 process definitions (templates)';
COMMENT ON COLUMN bpmn_process_definitions.key IS 'Business key for the process';
COMMENT ON COLUMN bpmn_process_definitions.bpmn_xml IS 'BPMN 2.0 XML definition';
COMMENT ON COLUMN bpmn_process_definitions.version IS 'Process version number, increments on deployment';
```

#### 第 3 步：12 个表完整定义

**完整的表清单**:
1. `bpmn_process_definitions` - 流程定义
2. `bpmn_process_instances` - 流程实例
3. `bpmn_activity_instances` - 活动实例
4. `bpmn_user_tasks` - 用户任务
5. `bpmn_timer_jobs` - 定时任务
6. `bpmn_message_events` - 消息事件
7. `bpmn_signal_events` - 信号事件
8. `bpmn_variables` - 流程变量
9. `bpmn_incidents` - 错误事件
10. `bpmn_audit_log` - 审计日志
11. `bpmn_deployments` - 部署记录
12. `bpmn_external_tasks` - 外部任务

**每个表的标准结构**:
```sql
-- [N]. [Table Name] ([中文名])
CREATE TABLE IF NOT EXISTS [table_name] (
  -- 主键
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- 外键
  [parent]_id TEXT [NOT NULL] REFERENCES [parent_table](id) [ON DELETE CASCADE],

  -- 业务字段
  [business_fields],

  -- 状态字段
  state TEXT [NOT NULL] [DEFAULT 'xxx'] [CHECK (state IN (...))],

  -- 时间字段
  [start|created]_at TIMESTAMPTZ [NOT NULL] DEFAULT NOW(),
  [end|updated]_at TIMESTAMPTZ,

  -- 约束
  CONSTRAINT [name] [CHECK|UNIQUE|...]
);

-- Indexes for [table_name]
CREATE INDEX IF NOT EXISTS idx_[table]_[field] ON [table] ([field]);
[additional indexes...]

-- Comments
COMMENT ON TABLE [table_name] IS '[description]';
COMMENT ON COLUMN [table_name].[column] IS '[description]';
```

#### 第 4 步：触发器和函数
```sql
-- ==========================================
-- Triggers and Functions
-- ==========================================

-- Update timestamps
CREATE OR REPLACE FUNCTION update_bpmn_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_process_definitions_timestamp
  BEFORE UPDATE ON bpmn_process_definitions
  FOR EACH ROW EXECUTE FUNCTION update_bpmn_timestamp();

CREATE TRIGGER update_variables_timestamp
  BEFORE UPDATE ON bpmn_variables
  FOR EACH ROW EXECUTE FUNCTION update_bpmn_timestamp();

-- Calculate duration on completion
CREATE OR REPLACE FUNCTION calculate_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
    NEW.duration_ms = EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) * 1000;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calculate_process_duration
  BEFORE UPDATE ON bpmn_process_instances
  FOR EACH ROW
  WHEN (NEW.end_time IS NOT NULL)
  EXECUTE FUNCTION calculate_duration();

CREATE TRIGGER calculate_activity_duration
  BEFORE UPDATE ON bpmn_activity_instances
  FOR EACH ROW
  WHEN (NEW.end_time IS NOT NULL)
  EXECUTE FUNCTION calculate_duration();

-- Audit logging
CREATE OR REPLACE FUNCTION bpmn_audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO bpmn_audit_log (
    event_type,
    process_instance_id,
    activity_id,
    task_id,
    user_id,
    old_value,
    new_value
  ) VALUES (
    TG_OP || '_' || TG_TABLE_NAME,
    COALESCE(NEW.process_instance_id, OLD.process_instance_id),
    COALESCE(NEW.activity_id, OLD.activity_id),
    CASE
      WHEN TG_TABLE_NAME = 'bpmn_user_tasks' THEN COALESCE(NEW.id, OLD.id)
      ELSE COALESCE(NEW.task_id, OLD.task_id)
    END,
    current_setting('app.current_user', true),
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enable audit logging for key tables
CREATE TRIGGER audit_process_instances
  AFTER INSERT OR UPDATE OR DELETE ON bpmn_process_instances
  FOR EACH ROW EXECUTE FUNCTION bpmn_audit_trigger();

CREATE TRIGGER audit_user_tasks
  AFTER INSERT OR UPDATE OR DELETE ON bpmn_user_tasks
  FOR EACH ROW EXECUTE FUNCTION bpmn_audit_trigger();
```

#### 第 5 步：验证
```bash
# 测试新文件
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 049_create_bpmn_workflow_tables.sql
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 049_create_bpmn_workflow_tables.sql

# 验证
psql -d metasheet_test -c "\dt bpmn_*"
psql -d metasheet_test -c "\di bpmn_*"
psql -d metasheet_test -c "\df bpmn_*"
```

### 预计工作量
**2-3 小时**

---

## 008_plugin_infrastructure.sql 🔧

### 问题描述
`scope` 列在第二次运行时重复创建

### 诊断
```bash
# 查看迁移内容
cd packages/core-backend/migrations
cat 008_plugin_infrastructure.sql | grep -A 5 -B 5 "scope"
```

### 修复方案：条件检查
```sql
-- 原代码（错误）
ALTER TABLE plugins ADD COLUMN scope TEXT DEFAULT 'user';

-- 修复后（正确）
DO $$
BEGIN
  -- 检查 scope 列是否存在
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='plugins' AND column_name='scope'
  ) THEN
    ALTER TABLE plugins ADD COLUMN scope TEXT DEFAULT 'user';
  END IF;
END $$;
```

### 完整修复模板
```sql
-- 008_plugin_infrastructure.sql
-- Plugin Infrastructure Tables

-- 检查并创建 plugins 表
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  description TEXT,
  -- ... 其他字段
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 添加 scope 列（带幂等性检查）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'plugins'
      AND column_name = 'scope'
  ) THEN
    ALTER TABLE plugins ADD COLUMN scope TEXT DEFAULT 'user';
    RAISE NOTICE 'Added scope column to plugins table';
  ELSE
    RAISE NOTICE 'scope column already exists in plugins table';
  END IF;
END $$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_plugins_scope ON plugins (scope);
```

### 验证
```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"

# 第一次运行
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 008_plugin_infrastructure.sql

# 第二次运行（应该成功，显示 "scope column already exists"）
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 008_plugin_infrastructure.sql

# 验证列
psql -d metasheet_test -c "\d plugins"
```

### 预计工作量
**30 分钟**

---

## 031_add_optimistic_locking_and_audit.sql 🔧

### 问题描述
添加已存在的列：`version`, `updated_at`, `updated_by`

### 修复方案
```sql
-- 031_add_optimistic_locking_and_audit.sql
-- Add Optimistic Locking and Audit Fields

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['spreadsheets', 'users', 'departments', 'permissions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Add version column
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'version'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN version INTEGER DEFAULT 0 NOT NULL', t);
      RAISE NOTICE 'Added version column to % table', t;
    END IF;

    -- Add updated_at column
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW()', t);
      RAISE NOTICE 'Added updated_at column to % table', t;
    END IF;

    -- Add updated_by column
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'updated_by'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN updated_by TEXT', t);
      RAISE NOTICE 'Added updated_by column to % table', t;
    END IF;
  END LOOP;
END $$;

-- Create trigger for auto-updating updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables (with existence check)
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['spreadsheets', 'users', 'departments', 'permissions'];
  trigger_name text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    trigger_name := 'update_' || t || '_timestamp';

    -- Drop trigger if exists
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, t);

    -- Create trigger
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      trigger_name, t
    );

    RAISE NOTICE 'Created trigger % on %', trigger_name, t;
  END LOOP;
END $$;
```

### 预计工作量
**45 分钟**

---

## 036_create_spreadsheet_permissions.sql 🔧

### 问题描述
类型不兼容冲突

### 诊断步骤
```bash
# 运行迁移查看具体错误
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 036_create_spreadsheet_permissions.sql 2>&1 | tee 036_error.log

# 分析错误
cat 036_error.log | grep -A 10 "ERROR\|error"
```

### 可能的问题
1. 外键引用的表不存在
2. 列类型与引用表不匹配
3. ENUM 类型冲突

### 修复策略
```sql
-- 检查依赖表
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'spreadsheets') THEN
    RAISE EXCEPTION 'Table spreadsheets does not exist';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'users') THEN
    RAISE EXCEPTION 'Table users does not exist';
  END IF;
END $$;

-- 创建权限表（类型匹配）
CREATE TABLE IF NOT EXISTS spreadsheet_permissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  spreadsheet_id TEXT NOT NULL REFERENCES spreadsheets(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('read', 'write', 'admin')),
  granted_by TEXT REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,

  -- 确保类型与引用表一致
  CONSTRAINT unique_spreadsheet_user_perm UNIQUE (spreadsheet_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_spreadsheet_perms_spreadsheet ON spreadsheet_permissions (spreadsheet_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_perms_user ON spreadsheet_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_perms_role ON spreadsheet_permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_perms_level ON spreadsheet_permissions (permission_level);
```

### 预计工作量
**1 小时**

---

## 037_add_gallery_form_support.sql 🔧

### 问题描述
缺少依赖列

### 诊断
```bash
# 查看迁移内容
cat 037_add_gallery_form_support.sql

# 运行测试
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 037_add_gallery_form_support.sql 2>&1 | grep "ERROR"
```

### 修复策略
```sql
-- 037_add_gallery_form_support.sql
-- Add Gallery and Form Support

-- 1. 先检查依赖列是否存在
DO $$
BEGIN
  -- 检查 spreadsheets 表的必需列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheets' AND column_name = 'config'
  ) THEN
    -- 如果缺少依赖列，先创建
    ALTER TABLE spreadsheets ADD COLUMN config JSONB DEFAULT '{}';
  END IF;
END $$;

-- 2. 添加 gallery 和 form 支持列
DO $$
BEGIN
  -- view_type 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheets' AND column_name = 'view_type'
  ) THEN
    ALTER TABLE spreadsheets ADD COLUMN view_type TEXT DEFAULT 'grid' CHECK (view_type IN ('grid', 'gallery', 'form', 'kanban'));
  END IF;

  -- gallery_config 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheets' AND column_name = 'gallery_config'
  ) THEN
    ALTER TABLE spreadsheets ADD COLUMN gallery_config JSONB;
  END IF;

  -- form_config 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheets' AND column_name = 'form_config'
  ) THEN
    ALTER TABLE spreadsheets ADD COLUMN form_config JSONB;
  END IF;
END $$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_spreadsheets_view_type ON spreadsheets (view_type);
```

### 预计工作量
**1 小时**

---

## 042_core_model_completion.sql 🔧

### 问题描述
Schema evolution 问题

### 诊断
```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/metasheet_test"
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts 042_core_model_completion.sql 2>&1 > 042_error.log
cat 042_error.log
```

### 修复策略：全面幂等性检查
```sql
-- 042_core_model_completion.sql
-- Complete Core Data Model

-- 使用通用的列添加函数
CREATE OR REPLACE FUNCTION add_column_if_not_exists(
  p_table TEXT,
  p_column TEXT,
  p_type TEXT,
  p_default TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  l_default TEXT := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = p_table AND column_name = p_column
  ) THEN
    IF p_default IS NOT NULL THEN
      l_default := ' DEFAULT ' || p_default;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s%s', p_table, p_column, p_type, l_default);
    RAISE NOTICE 'Added column %.% (%)', p_table, p_column, p_type;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 使用函数添加列
SELECT add_column_if_not_exists('users', 'department_id', 'TEXT');
SELECT add_column_if_not_exists('users', 'role', 'TEXT', '''user''');
SELECT add_column_if_not_exists('spreadsheets', 'workspace_id', 'TEXT');
-- ... 其他列

-- 清理临时函数
DROP FUNCTION IF EXISTS add_column_if_not_exists;
```

### 预计工作量
**1.5 小时**

---

## 统一测试脚本

### 创建测试脚本
```bash
# File: packages/core-backend/scripts/test-migration-idempotency.sh
#!/bin/bash

MIGRATION_FILE=$1
DB_NAME="metasheet_test_$(date +%s)"

if [ -z "$MIGRATION_FILE" ]; then
  echo "Usage: $0 <migration_file>"
  exit 1
fi

echo "Testing migration: $MIGRATION_FILE"
echo "Using database: $DB_NAME"

# 1. 创建测试数据库
dropdb -h localhost -U postgres $DB_NAME 2>/dev/null
createdb -h localhost -U postgres $DB_NAME
psql -h localhost -U postgres -d $DB_NAME -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. 设置环境变量
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$DB_NAME"

# 3. 第一次运行
echo "=== First run ==="
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts $MIGRATION_FILE
if [ $? -ne 0 ]; then
  echo "❌ First run failed"
  exit 1
fi

# 4. 第二次运行（测试幂等性）
echo "=== Second run (idempotency test) ==="
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts $MIGRATION_FILE
if [ $? -ne 0 ]; then
  echo "❌ Second run failed (not idempotent)"
  exit 1
fi

# 5. 第三次运行（额外验证）
echo "=== Third run (extra validation) ==="
pnpm -F @metasheet/core-backend exec tsx scripts/run-single-migration.ts $MIGRATION_FILE
if [ $? -ne 0 ]; then
  echo "❌ Third run failed"
  exit 1
fi

echo "✅ Migration $MIGRATION_FILE passed idempotency test"

# 清理
dropdb -h localhost -U postgres $DB_NAME
```

### 使用方法
```bash
chmod +x packages/core-backend/scripts/test-migration-idempotency.sh

# 测试单个迁移
./packages/core-backend/scripts/test-migration-idempotency.sh 008_plugin_infrastructure.sql

# 测试所有迁移
for f in 008 031 036 037 042 048 049; do
  echo "Testing ${f}_*.sql"
  ./packages/core-backend/scripts/test-migration-idempotency.sh ${f}_*.sql
done
```

---

## 修复进度追踪

### 检查清单
- [ ] 048_create_event_bus_tables.sql
  - [x] 代码修复
  - [ ] 幂等性测试
  - [ ] 从 MIGRATION_EXCLUDE 移除
  - [ ] CI 验证

- [ ] 049_create_bpmn_workflow_tables.sql
  - [ ] 完全重写
  - [ ] 幂等性测试
  - [ ] 从 MIGRATION_EXCLUDE 移除
  - [ ] CI 验证

- [ ] 008_plugin_infrastructure.sql
  - [ ] 添加幂等性检查
  - [ ] 测试验证
  - [ ] 从 MIGRATION_EXCLUDE 移除

- [ ] 031_add_optimistic_locking_and_audit.sql
  - [ ] 添加幂等性检查
  - [ ] 测试验证
  - [ ] 从 MIGRATION_EXCLUDE 移除

- [ ] 036_create_spreadsheet_permissions.sql
  - [ ] 分析类型冲突
  - [ ] 修复实施
  - [ ] 测试验证
  - [ ] 从 MIGRATION_EXCLUDE 移除

- [ ] 037_add_gallery_form_support.sql
  - [ ] 添加依赖检查
  - [ ] 修复实施
  - [ ] 测试验证
  - [ ] 从 MIGRATION_EXCLUDE 移除

- [ ] 042_core_model_completion.sql
  - [ ] 分析 Schema evolution 问题
  - [ ] 实施修复
  - [ ] 测试验证
  - [ ] 从 MIGRATION_EXCLUDE 移除

### 总进度
**已完成**: 1/7 (14%)
**预计剩余时间**: 7-11 小时

---

## 参考资料

### PostgreSQL 文档
- [ALTER TABLE](https://www.postgresql.org/docs/15/sql-altertable.html)
- [CREATE INDEX](https://www.postgresql.org/docs/15/sql-createindex.html)
- [Partitioning](https://www.postgresql.org/docs/15/ddl-partitioning.html)
- [PL/pgSQL](https://www.postgresql.org/docs/15/plpgsql.html)

### 最佳实践
- 始终使用 `IF NOT EXISTS` 检查
- 使用 DO 块进行条件逻辑
- 添加 RAISE NOTICE 日志
- 三次运行测试（验证幂等性）
- 先在测试数据库验证

---

*指南生成时间: 2025-10-29*
*最后更新: -*
