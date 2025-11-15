# Phase 3 集成计划

**项目**: MetaSheet v2 Microkernel Architecture
**阶段**: Phase 3 - 功能完善与生产就绪
**规划日期**: 2025-10-29
**前置依赖**: Phase 2 PR #332 (TypeScript 集成完成)

---

## 执行摘要

Phase 3 专注于完善 Phase 2 引入的 BPMN Workflow Engine 和 Event Bus System，修复遗留的 SQL 迁移问题，并实现完整的 UI 集成和测试覆盖。

**目标**:
- 🎯 **SQL 迁移**: 修复 048 & 049 + 5个预存在问题
- 🎨 **UI 集成**: Workflow Designer + Event Bus Management
- 🔌 **Plugin System**: 完善插件基础设施
- ✅ **测试覆盖**: 单元测试 + 集成测试 + E2E 测试
- 🚀 **生产就绪**: 性能优化 + 监控告警

---

## Phase 2 完成状态回顾

### ✅ 已完成
1. **BPMN Workflow Engine** (TypeScript)
   - 核心类型定义完整
   - EventBusService 集成
   - 12个数据库表类型定义

2. **Event Bus System** (TypeScript)
   - 事件类型管理
   - 事件队列机制
   - 订阅者管理
   - 事件存储（分区表）

3. **CI/CD Pipeline**
   - TypeScript typecheck 通过
   - Migration Replay 稳定（7个迁移排除）

### ⚠️ 遗留问题
1. **SQL 迁移**:
   - `048_create_event_bus_tables.sql` - 暂时排除
   - `049_create_bpmn_workflow_tables.sql` - 暂时排除

2. **预存在问题迁移** (5个):
   - `008_plugin_infrastructure.sql`
   - `031_add_optimistic_locking_and_audit.sql`
   - `036_create_spreadsheet_permissions.sql`
   - `037_add_gallery_form_support.sql`
   - `042_core_model_completion.sql`

---

## Phase 3 任务分解

### 🔴 P0: 关键路径任务（阻塞发布）

#### 1. SQL 迁移修复 🚨 **最高优先级**

##### 1.1 重写 048_create_event_bus_tables.sql
**问题**:
- 26个内联 INDEX 不符合 PostgreSQL 语法
- 分区表 PRIMARY KEY 约束不完整
- WHERE 子句和 DESC 关键字使用不当

**任务清单**:
- [ ] 移除所有内联 INDEX 关键字
- [ ] 为每个表创建独立的 CREATE INDEX 语句
- [ ] 修复 event_store 分区表的 PRIMARY KEY
- [ ] 确保所有索引包含 `IF NOT EXISTS`
- [ ] 测试幂等性（运行两次迁移）

**预计工作量**: 2-3 小时

**文件位置**: `packages/core-backend/migrations/048_create_event_bus_tables.sql`

**重写模板**:
```sql
-- ✅ 正确的写法
CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  schema JSONB,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for event_types
CREATE INDEX IF NOT EXISTS idx_event_types_category ON event_types (category);
CREATE INDEX IF NOT EXISTS idx_event_types_active ON event_types (is_active);
CREATE INDEX IF NOT EXISTS idx_event_types_name ON event_types (event_name);

-- 分区表正确写法
CREATE TABLE IF NOT EXISTS event_store (
  id BIGSERIAL,
  event_id TEXT NOT NULL,
  event_type_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL,
  metadata JSONB,
  -- 分区表约束必须包含分区键
  PRIMARY KEY (id, occurred_at),
  UNIQUE (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Indexes for event_store
CREATE INDEX IF NOT EXISTS idx_event_store_type ON event_store (event_type_id);
CREATE INDEX IF NOT EXISTS idx_event_store_occurred ON event_store (occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_store_event_id ON event_store (event_id, occurred_at);

-- 创建默认分区（防止插入失败）
CREATE TABLE IF NOT EXISTS event_store_default PARTITION OF event_store DEFAULT;
```

**验证步骤**:
```bash
# 1. 重置数据库
dropdb metasheet && createdb metasheet
psql -d metasheet -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. 运行迁移两次
pnpm -F @metasheet/core-backend db:migrate
pnpm -F @metasheet/core-backend db:migrate  # 应该不报错

# 3. 验证表结构
psql -d metasheet -c "\dt event_*"
psql -d metasheet -c "\di event_*"
```

---

##### 1.2 重写 049_create_bpmn_workflow_tables.sql
**问题**:
- 22个内联 INDEX 不符合规范
- 84+处缺失逗号（系统性错误）
- 9处尾随逗号

**任务清单**:
- [ ] 完全重写文件（不基于原文件修改）
- [ ] 参考 BPMN 2.0 标准设计表结构
- [ ] 所有 INDEX 独立创建
- [ ] 添加完整的注释文档
- [ ] 测试幂等性

**预计工作量**: 3-4 小时

**文件位置**: `packages/core-backend/migrations/049_create_bpmn_workflow_tables.sql`

**核心表清单**:
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

**重写策略**:
```sql
-- 使用标准化模板
-- 1. 表定义
CREATE TABLE IF NOT EXISTS [table_name] (
  -- 主键
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- 业务字段
  [business_fields],

  -- 状态字段
  state TEXT NOT NULL DEFAULT 'ACTIVE',

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 约束
  CONSTRAINT [constraint_name] CHECK ([condition])
);

-- 2. 索引定义
CREATE INDEX IF NOT EXISTS idx_[table]_[field] ON [table] ([field]);
CREATE INDEX IF NOT EXISTS idx_[table]_[field]_partial
  ON [table] ([field]) WHERE [condition];

-- 3. 触发器
CREATE TRIGGER [trigger_name]
  BEFORE UPDATE ON [table]
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
```

---

#### 2. 移除 MIGRATION_EXCLUDE

**完成条件**: 048 & 049 修复后

**任务**:
- [ ] 从 `.github/workflows/migration-replay.yml` 移除 048 & 049
- [ ] 触发 CI 验证
- [ ] 确认 Migration Replay 通过

**文件**: `.github/workflows/migration-replay.yml`
```yaml
# Before
MIGRATION_EXCLUDE: 008_...,031_...,036_...,037_...,042_...,048_...,049_...

# After (Phase 3.1 完成后)
MIGRATION_EXCLUDE: 008_...,031_...,036_...,037_...,042_...

# After (Phase 3.2 完成后)
MIGRATION_EXCLUDE: ""  # 全部迁移通过
```

---

### 🟡 P1: 重要任务（影响功能完整性）

#### 3. 修复预存在问题迁移

##### 3.1 008_plugin_infrastructure.sql
**问题**: `scope` 列重复创建，第二次运行失败

**诊断**:
```sql
-- 查看当前表结构
\d plugins

-- 检查是否存在 scope 列
SELECT column_name FROM information_schema.columns
WHERE table_name='plugins' AND column_name='scope';
```

**修复策略**:
```sql
-- 使用条件检查
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='plugins' AND column_name='scope'
  ) THEN
    ALTER TABLE plugins ADD COLUMN scope TEXT DEFAULT 'user';
  END IF;
END $$;
```

---

##### 3.2 031_add_optimistic_locking_and_audit.sql
**问题**: 添加已存在的列

**修复策略**: 同 008，添加存在性检查

---

##### 3.3 036_create_spreadsheet_permissions.sql
**问题**: 类型不兼容冲突

**任务**:
- [ ] 分析表结构依赖关系
- [ ] 检查列类型定义
- [ ] 添加类型转换或修改迁移顺序

---

##### 3.4 037_add_gallery_form_support.sql
**问题**: 缺少依赖列

**任务**:
- [ ] 识别依赖的列
- [ ] 添加前置检查
- [ ] 考虑拆分为多个迁移

---

##### 3.5 042_core_model_completion.sql
**问题**: Schema evolution 问题

**任务**:
- [ ] 详细分析失败原因
- [ ] 设计向后兼容的修复方案

**预计总工作量**: 4-6 小时

---

#### 4. Workflow Designer UI 集成

**目标**: 提供可视化的 BPMN 流程设计器

**技术选型**:
- **bpmn-js**: Camunda 官方 BPMN 建模库
- **Vue 3 集成**: 封装为 Vue 组件
- **Element Plus**: UI 组件库

**核心功能**:
1. **流程建模**
   - 拖拽式流程设计
   - 支持 BPMN 2.0 元素
   - 实时验证

2. **流程管理**
   - 流程定义列表
   - 版本管理
   - 部署/激活/停用

3. **流程实例**
   - 启动流程实例
   - 查看执行历史
   - 流程追踪可视化

**任务清单**:
- [ ] 安装 bpmn-js 依赖
- [ ] 创建 WorkflowDesigner.vue 组件
- [ ] 实现流程建模器
- [ ] 实现流程定义 CRUD
- [ ] 实现流程实例管理
- [ ] 添加流程追踪视图

**文件结构**:
```
apps/web/src/
├── components/
│   └── workflow/
│       ├── WorkflowDesigner.vue      # 流程设计器
│       ├── WorkflowModeler.vue       # BPMN 建模器封装
│       ├── ProcessDefinitionList.vue # 流程定义列表
│       ├── ProcessInstanceList.vue   # 流程实例列表
│       └── ProcessTracker.vue        # 流程追踪
└── views/
    └── workflow/
        ├── WorkflowDesignerView.vue  # 设计器页面
        ├── WorkflowDashboard.vue     # 仪表盘
        └── WorkflowHistoryView.vue   # 历史记录
```

**API 集成**:
```typescript
// services/workflow.ts
export class WorkflowService {
  // 流程定义
  async createProcessDefinition(bpmnXml: string): Promise<ProcessDefinition>
  async getProcessDefinitions(): Promise<ProcessDefinition[]>
  async deployProcess(id: string): Promise<void>

  // 流程实例
  async startProcess(key: string, variables: object): Promise<ProcessInstance>
  async getProcessInstances(definitionId: string): Promise<ProcessInstance[]>
  async getProcessHistory(instanceId: string): Promise<ActivityInstance[]>

  // 用户任务
  async getUserTasks(assignee: string): Promise<UserTask[]>
  async completeTask(taskId: string, variables: object): Promise<void>
}
```

**预计工作量**: 5-7 天

---

#### 5. Event Bus Management UI

**目标**: 提供事件类型和订阅管理界面

**核心功能**:
1. **事件类型管理**
   - CRUD 事件类型
   - Schema 定义（JSON Schema）
   - 启用/禁用事件

2. **订阅管理**
   - 配置事件订阅
   - 选择处理器（webhook/内部）
   - 优先级和过滤条件

3. **事件监控**
   - 事件队列状态
   - 失败事件重试
   - 事件历史查询

**任务清单**:
- [ ] 创建 EventTypeManager.vue
- [ ] 创建 EventSubscriptionManager.vue
- [ ] 创建 EventMonitor.vue
- [ ] 实现 Schema 编辑器（monaco-editor）
- [ ] 实现事件测试工具

**文件结构**:
```
apps/web/src/
├── components/
│   └── eventbus/
│       ├── EventTypeManager.vue
│       ├── EventSubscriptionManager.vue
│       ├── EventMonitor.vue
│       ├── EventSchemaEditor.vue
│       └── EventTester.vue
└── views/
    └── eventbus/
        ├── EventBusDashboard.vue
        └── EventHistoryView.vue
```

**预计工作量**: 3-5 天

---

### 🟢 P2: 增强任务（提升质量）

#### 6. Plugin System 完善

**目标**: 完善插件基础设施，支持第三方插件

**核心功能**:
1. **插件注册与发现**
   - 插件市场
   - 插件元数据验证
   - 版本管理

2. **插件生命周期**
   - 安装/卸载
   - 启用/禁用
   - 配置管理

3. **插件隔离与安全**
   - 权限控制
   - 沙箱执行
   - API 限流

**任务清单**:
- [ ] 设计插件元数据格式
- [ ] 实现插件加载器
- [ ] 创建插件 SDK
- [ ] 实现插件市场 UI
- [ ] 添加插件文档

**预计工作量**: 5-7 天

---

#### 7. 测试覆盖

##### 7.1 单元测试
**目标**: 核心逻辑覆盖率 >80%

**测试范围**:
- EventBusService 核心方法
- BPMN execution engine
- Permission 逻辑

**任务**:
- [ ] Event Bus 单元测试（vitest）
- [ ] Workflow Engine 单元测试
- [ ] Plugin System 单元测试

**预计工作量**: 3-4 天

---

##### 7.2 集成测试
**目标**: API 端点覆盖率 >70%

**测试场景**:
- 流程定义 CRUD
- 流程实例启动和执行
- 事件发布和订阅
- 用户任务完成

**任务**:
- [ ] Workflow API 集成测试
- [ ] Event Bus API 集成测试
- [ ] Plugin API 集成测试

**预计工作量**: 3-4 天

---

##### 7.3 E2E 测试
**目标**: 关键用户流程覆盖

**测试场景**:
1. **Workflow Designer**:
   - 创建简单流程
   - 部署流程
   - 启动实例
   - 完成用户任务

2. **Event Bus**:
   - 创建事件类型
   - 配置订阅
   - 触发事件
   - 验证处理

**工具**: Playwright

**任务**:
- [ ] Workflow E2E 测试
- [ ] Event Bus E2E 测试
- [ ] 跨功能集成测试

**预计工作量**: 4-5 天

---

#### 8. 性能优化

**目标**: 确保系统在高负载下稳定运行

**优化项**:
1. **Event Bus 性能**
   - 事件批量处理
   - 队列优化（Redis）
   - 订阅者并发控制

2. **Workflow Engine 性能**
   - 流程实例缓存
   - 数据库查询优化
   - 定时任务调度优化

3. **数据库优化**
   - 索引优化
   - 分区表维护
   - 连接池配置

**任务**:
- [ ] 性能基准测试
- [ ] 瓶颈分析（profiling）
- [ ] 优化实施
- [ ] 压力测试

**预计工作量**: 3-4 天

---

#### 9. 监控与告警

**目标**: 生产环境可观测性

**监控指标**:
1. **Workflow 指标**
   - 流程实例启动率
   - 平均执行时间
   - 失败率
   - 等待任务数量

2. **Event Bus 指标**
   - 事件发布率
   - 队列长度
   - 处理延迟
   - 失败重试次数

3. **System 指标**
   - CPU/内存使用率
   - 数据库连接数
   - API 响应时间

**任务**:
- [ ] 添加 Prometheus metrics
- [ ] 配置 Grafana dashboards
- [ ] 设置告警规则
- [ ] 集成到现有监控系统

**预计工作量**: 2-3 天

---

## Phase 3 时间表

### 第 1 周: SQL 迁移修复（P0）
```
Day 1-2: 重写 048_create_event_bus_tables.sql
Day 3-4: 重写 049_create_bpmn_workflow_tables.sql
Day 5:   测试和验证，移除 MIGRATION_EXCLUDE
```

### 第 2 周: 预存在问题修复（P0-P1）
```
Day 1-2: 修复 008, 031, 036
Day 3-4: 修复 037, 042
Day 5:   全面测试，确认所有迁移通过
```

### 第 3-4 周: UI 集成（P1）
```
Week 3: Workflow Designer UI
Week 4: Event Bus Management UI + Plugin System 基础
```

### 第 5 周: 测试覆盖（P2）
```
Day 1-2: 单元测试
Day 3-4: 集成测试
Day 5:   E2E 测试
```

### 第 6 周: 优化与发布（P2）
```
Day 1-2: 性能优化
Day 3-4: 监控告警
Day 5:   发布准备和文档
```

---

## 成功标准

### Phase 3.1 完成标准（SQL 迁移）
- [ ] 所有 7 个排除的迁移修复完成
- [ ] Migration Replay CI 通过（无排除）
- [ ] 幂等性测试通过（运行 3 次无错误）
- [ ] 文档更新（迁移说明）

### Phase 3.2 完成标准（UI 集成）
- [ ] Workflow Designer 可用（创建、部署、执行）
- [ ] Event Bus UI 可用（类型管理、订阅管理）
- [ ] Plugin System 基础功能可用
- [ ] UI 组件文档完整

### Phase 3.3 完成标准（测试覆盖）
- [ ] 单元测试覆盖率 >80%
- [ ] 集成测试覆盖关键 API
- [ ] E2E 测试覆盖核心流程
- [ ] 所有测试在 CI 中运行

### Phase 3 最终完成标准
- [ ] 所有 P0 和 P1 任务完成
- [ ] CI 全部通过（无排除）
- [ ] 性能基准达标
- [ ] 监控告警配置完成
- [ ] 用户文档完整
- [ ] 生产就绪检查通过

---

## 风险与缓解

### 风险 1: SQL 迁移复杂度超预期
**可能性**: 中
**影响**: 高
**缓解措施**:
- 充分的测试时间（预留 buffer）
- 渐进式修复（先修复简单的）
- 寻求数据库专家 review

### 风险 2: BPMN 规范理解偏差
**可能性**: 中
**影响**: 中
**缓解措施**:
- 参考 Camunda 实现
- 阅读 BPMN 2.0 官方规范
- 参与 BPMN 社区讨论

### 风险 3: UI 集成工作量低估
**可能性**: 高
**影响**: 中
**缓解措施**:
- MVP 优先（核心功能先行）
- 复用现有组件
- 渐进式增强

### 风险 4: 性能问题难以定位
**可能性**: 低
**影响**: 高
**缓解措施**:
- 早期性能测试
- 完善的 profiling 工具
- 预留优化时间

---

## 资源需求

### 开发资源
- **后端开发**: 1-2 人（SQL 迁移 + API）
- **前端开发**: 1-2 人（UI 集成）
- **全栈开发**: 1 人（Plugin System + 集成）
- **QA**: 1 人（测试覆盖）

### 基础设施
- **开发环境**: PostgreSQL 15, Redis
- **测试环境**: 独立数据库实例
- **监控工具**: Prometheus, Grafana

### 外部依赖
- **bpmn-js**: ^17.0.0
- **monaco-editor**: ^0.45.0（Schema 编辑器）

---

## 附录

### A. 相关文档
- [Phase 2 CI 修复报告](./PHASE2_CI_FIX_REPORT.md)
- [BPMN 2.0 规范](https://www.omg.org/spec/BPMN/2.0/)
- [Camunda Platform 文档](https://docs.camunda.org/)

### B. 技术参考
- [PostgreSQL 分区表文档](https://www.postgresql.org/docs/15/ddl-partitioning.html)
- [Kysely Query Builder](https://kysely.dev/)
- [bpmn-js Examples](https://github.com/bpmn-io/bpmn-js-examples)

### C. 联系人
- **架构负责人**: [待填写]
- **数据库专家**: [待填写]
- **前端负责人**: [待填写]

---

## 下一步行动

**立即开始**:
1. ✅ Review 并批准此计划
2. 🔧 开始 Task 1.1: 重写 048_create_event_bus_tables.sql
3. 📋 创建 GitHub Issues/Projects 跟踪进度

**本周目标**:
- 完成 048 & 049 SQL 迁移修复
- 从 MIGRATION_EXCLUDE 移除
- CI 验证通过

---

*计划生成时间: 2025-10-29*
*下次更新: Phase 3.1 完成后*
