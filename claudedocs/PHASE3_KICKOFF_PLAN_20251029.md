# 🚀 Phase 3 启动计划

**规划日期**: 2025-10-29 23:30 UTC
**前置完成**: Phase 2 PR #332 已合并
**项目阶段**: Phase 3 - 功能完善与生产就绪
**状态**: 🏃 进行中

---

## 📊 执行摘要

Phase 3 聚焦于完善 Phase 2 微内核架构，修复遗留迁移问题，并实现完整的类型安全和测试覆盖。工作已经启动，有 2 个 PR 正在进行中。

**核心目标**:
- 🔧 **迁移清理**: 修复所有 7 个被排除的迁移文件
- 📘 **类型安全**: 全面的 TypeScript DTO 和类型定义
- 🎨 **UI 完善**: BPMN 工作流和事件总线的 UI 集成
- ✅ **测试覆盖**: 单元测试 + 集成测试 + E2E 测试
- 🚀 **生产就绪**: 性能优化 + 监控告警

---

## 📍 Phase 2 完成状态回顾

### ✅ Phase 2 成就
| 项目 | 状态 | 规模 |
|------|------|------|
| PR #332 合并 | ✅ MERGED | 70 文件, +16,308 行 |
| BPMN Workflow Engine | ✅ 完成 | 1,338 行核心代码 |
| Event Bus Service | ✅ 完成 | 1,082 行核心代码 |
| Plugin Management | ✅ 完成 | 533 行验证逻辑 |
| API 路由集成 | ✅ 完成 | 3 个模块 (1,765 行) |
| CI/CD Pipeline | ✅ 通过 | 4 核心检查全部通过 |

### ⚠️ 已知遗留问题

**迁移文件排除列表** (7 个):
```bash
MIGRATION_EXCLUDE:
  008_plugin_infrastructure.sql
  031_add_optimistic_locking_and_audit.sql
  036_create_spreadsheet_permissions.sql
  037_add_gallery_form_support.sql
  042_core_model_completion.sql
  048_create_event_bus_tables.sql      # Phase 2 新增
  049_create_bpmn_workflow_tables.sql  # Phase 2 新增
```

**问题分类**:
1. **预存在问题** (5 个): 008, 031, 036, 037, 042
   - 幂等性问题（重复列/约束）
   - 类型不兼容
   - 依赖缺失

2. **Phase 2 新增** (2 个): 048, 049
   - 内联 INDEX 语法错误 (48 个)
   - 缺失逗号（84+ 处）
   - 分区表主键约束不完整

---

## 🏃 Phase 3 当前进展

### 正在进行的工作

#### PR #338: Phase 3 – TS migrations plan (batch1)
**分支**: `feat/phase3-ts-migrations-batch1`
**创建**: 2025-10-29
**状态**: 🟢 OPEN

**目标**: 将遗留 SQL 迁移替换为 TypeScript (Kysely) 版本

**Batch 1 范围**:
- ✅ 031_add_optimistic_locking_and_audit.sql → TypeScript
- ✅ 036_create_spreadsheet_permissions.sql → TypeScript

**CI 状态**:
- ✅ Migration Replay: PASS (55s)
- ❌ Observability E2E: FAIL (非必需)
- ❌ v2-observability-strict: FAIL (非必需)

**评估**: CI 核心检查通过，可以继续推进

---

#### PR #337: Phase 3 – DTO typing (batch1)
**分支**: `feat/phase3-web-dto-batch1`
**创建**: 2025-10-29
**状态**: 🔴 OPEN (需要修复)

**目标**: 为 Web 应用添加 DTO 类型以提高类型安全

**Batch 1 范围**:
- DTO 类型定义：`PluginInfoDTO`, `ContributedView`
- API 基础设施标准化：`utils/api`
- 跨组件应用：App, Kanban, ViewManager

**CI 状态**:
- ✅ Migration Replay: PASS (51s)
- ❌ typecheck: FAIL (32s) 🚨 **需要修复**
- ❌ v2-observability-strict: FAIL (非必需)

**问题**: TypeScript 类型错误导致 typecheck 失败

**建议**: 优先修复 typecheck 错误，确保类型安全

---

## 📋 Phase 3 完整任务分解

### 🔴 P0: 关键路径（阻塞发布）

#### 1. SQL 迁移修复
**优先级**: 🔴 最高
**预估**: 1-2 周
**负责**: 后端团队

##### 1.1 修复 PR #337 typecheck 失败 🚨
**状态**: 当前阻塞
**任务**:
- [ ] 分析 typecheck 失败原因
- [ ] 修复类型定义错误
- [ ] 验证 `pnpm -F @metasheet/web type-check` 通过
- [ ] 推送修复后重新触发 CI

**预计**: 1-2 小时

---

##### 1.2 完成 Batch 1 TS 迁移 (PR #338)
**状态**: CI 通过，待审核
**任务**:
- [ ] Code review PR #338
- [ ] 测试 031, 036 TS 迁移的幂等性
- [ ] 合并 PR #338

**预计**: 0.5 天

---

##### 1.3 重写 048_create_event_bus_tables.sql
**状态**: 待开始
**问题**:
- 26 个内联 INDEX 不符合 PostgreSQL 语法
- 分区表 PRIMARY KEY 约束不完整
- WHERE 子句和 DESC 关键字使用不当

**任务清单**:
- [ ] 移除所有内联 INDEX 关键字
- [ ] 为每个表创建独立的 CREATE INDEX 语句
- [ ] 修复 event_store 分区表的 PRIMARY KEY
- [ ] 确保所有索引包含 `IF NOT EXISTS`
- [ ] 测试幂等性（运行两次迁移）
- [ ] 创建默认分区防止插入失败

**重写模板**:
```sql
-- ✅ 正确的表定义
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

-- ✅ 独立的索引定义
CREATE INDEX IF NOT EXISTS idx_event_types_category ON event_types (category);
CREATE INDEX IF NOT EXISTS idx_event_types_active ON event_types (is_active);
CREATE INDEX IF NOT EXISTS idx_event_types_name ON event_types (event_name);

-- ✅ 分区表正确写法
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

-- ✅ 创建默认分区
CREATE TABLE IF NOT EXISTS event_store_default PARTITION OF event_store DEFAULT;

-- ✅ 独立索引
CREATE INDEX IF NOT EXISTS idx_event_store_type ON event_store (event_type_id);
CREATE INDEX IF NOT EXISTS idx_event_store_occurred ON event_store (occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_store_event_id ON event_store (event_id, occurred_at);
```

**验证步骤**:
```bash
# 1. 重置数据库
dropdb metasheet && createdb metasheet
psql -d metasheet -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# 2. 运行迁移两次（测试幂等性）
pnpm -F @metasheet/core-backend db:migrate
pnpm -F @metasheet/core-backend db:migrate  # 应该不报错

# 3. 验证表结构
psql -d metasheet -c "\dt event_*"
psql -d metasheet -c "\di event_*"
psql -d metasheet -c "\d+ event_store"
```

**预计**: 2-3 小时

---

##### 1.4 重写 049_create_bpmn_workflow_tables.sql
**状态**: 待开始
**问题**:
- 22 个内联 INDEX 不符合规范
- 84+ 处缺失逗号（系统性错误）
- 9 处尾随逗号

**核心表清单** (12 个):
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

-- 2. 独立索引
CREATE INDEX IF NOT EXISTS idx_[table]_[field] ON [table] ([field]);
CREATE INDEX IF NOT EXISTS idx_[table]_[field]_partial
  ON [table] ([field]) WHERE [condition];

-- 3. 触发器
CREATE TRIGGER [trigger_name]
  BEFORE UPDATE ON [table]
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
```

**任务清单**:
- [ ] 完全重写文件（不基于原文件修改）
- [ ] 参考 BPMN 2.0 标准设计表结构
- [ ] 所有 INDEX 独立创建
- [ ] 添加完整的注释文档
- [ ] 测试幂等性

**预计**: 3-4 小时

---

##### 1.5 修复预存在问题迁移 (Batch 2+)
**状态**: 计划中
**范围**: 008, 037, 042

**策略**:
- 使用 PL/pgSQL 条件检查替代直接 ALTER
- 添加存在性验证
- 确保幂等性

**示例修复**:
```sql
-- ✅ 幂等性修复模板
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

**预计**: 4-6 小时

---

##### 1.6 移除 MIGRATION_EXCLUDE
**完成条件**: 所有 7 个迁移修复后

**任务**:
- [ ] 从 `.github/workflows/migration-replay.yml` 移除所有排除项
- [ ] 触发 CI 验证
- [ ] 确认 Migration Replay 通过

**文件**: `.github/workflows/migration-replay.yml`
```yaml
# Before
MIGRATION_EXCLUDE: 008_...,031_...,036_...,037_...,042_...,048_...,049_...

# After (Phase 3 完成)
MIGRATION_EXCLUDE: ""  # 全部迁移通过
```

**预计**: 0.5 小时

---

### 🟡 P1: 重要任务（影响功能完整性）

#### 2. Workflow Designer UI 集成
**优先级**: 🟡 高
**预估**: 5-7 天
**负责**: 前端团队

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

---

#### 3. Event Bus Management UI
**优先级**: 🟡 高
**预估**: 3-5 天
**负责**: 前端团队

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

---

### 🟢 P2: 增强任务（提升质量）

#### 4. Plugin System 完善
**优先级**: 🟢 中
**预估**: 5-7 天

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

---

#### 5. 测试覆盖
**优先级**: 🟢 中
**预估**: 7-10 天

##### 5.1 单元测试
**目标**: 核心逻辑覆盖率 >80%

**测试范围**:
- EventBusService 核心方法
- BPMN execution engine
- Permission 逻辑

**预计**: 3-4 天

---

##### 5.2 集成测试
**目标**: API 端点覆盖率 >70%

**测试场景**:
- 流程定义 CRUD
- 流程实例启动和执行
- 事件发布和订阅
- 用户任务完成

**预计**: 3-4 天

---

##### 5.3 E2E 测试
**目标**: 关键用户流程覆盖

**工具**: Playwright

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

**预计**: 4-5 天

---

#### 6. 性能优化
**优先级**: 🟢 中
**预估**: 3-4 天

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

---

#### 7. 监控与告警
**优先级**: 🟢 中
**预估**: 2-3 天

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

---

## 📅 Phase 3 时间表

### 第 1 周: 迁移修复 Sprint 1 (当前)
```
✅ Day 1: PR #337, #338 创建
🔧 Day 2-3: 修复 PR #337 typecheck + 审核合并 #338
🔧 Day 4-5: 重写 048_create_event_bus_tables.sql
```

### 第 2 周: 迁移修复 Sprint 2
```
Day 1-3: 重写 049_create_bpmn_workflow_tables.sql
Day 4-5: 测试和验证，移除部分 MIGRATION_EXCLUDE
```

### 第 3 周: 迁移修复 Sprint 3
```
Day 1-3: 修复 008, 037, 042 预存在问题
Day 4-5: 全面测试，移除所有 MIGRATION_EXCLUDE
```

### 第 4-5 周: UI 集成
```
Week 4: Workflow Designer UI
Week 5: Event Bus Management UI + Plugin System 基础
```

### 第 6 周: 测试覆盖
```
Day 1-2: 单元测试
Day 3-4: 集成测试
Day 5: E2E 测试
```

### 第 7 周: 优化与发布
```
Day 1-2: 性能优化
Day 3-4: 监控告警
Day 5: 发布准备和文档
```

---

## ✅ 成功标准

### Phase 3.1 完成标准（迁移清理）
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

## 🎯 近期行动计划 (本周)

### 🚨 立即行动 (今天)
1. **修复 PR #337 typecheck 失败**
   - 分析错误日志
   - 修复类型定义
   - 验证本地 typecheck
   - 推送修复

2. **审核 PR #338**
   - Code review
   - 测试 TS 迁移
   - 准备合并

### 🔧 本周任务 (Week 1)
1. **合并 PR #338** (Batch 1 TS migrations)
2. **修复并合并 PR #337** (DTO typing)
3. **重写 048_create_event_bus_tables.sql**
4. **创建 PR for 048 修复**

### 📊 本周目标
- ✅ 2 个 PR 合并
- ✅ 048 迁移重写完成
- ✅ 从 MIGRATION_EXCLUDE 移除 2-3 个迁移

---

## ⚠️ 风险与缓解

### 风险 1: SQL 迁移复杂度超预期
**可能性**: 中
**影响**: 高
**缓解措施**:
- 充分的测试时间（预留 buffer）
- 渐进式修复（先修复简单的）
- 寻求数据库专家 review
- 使用标准化模板减少错误

### 风险 2: TypeScript 类型错误累积
**可能性**: 中
**影响**: 中
**缓解措施**:
- 每个 PR 都必须通过 typecheck
- 使用严格的 TypeScript 配置
- 及时修复类型错误，不累积

### 风险 3: UI 集成工作量低估
**可能性**: 高
**影响**: 中
**缓解措施**:
- MVP 优先（核心功能先行）
- 复用现有组件
- 渐进式增强
- 留足时间缓冲

### 风险 4: 性能问题难以定位
**可能性**: 低
**影响**: 高
**缓解措施**:
- 早期性能测试
- 完善的 profiling 工具
- 预留优化时间
- 借鉴成熟框架实践

---

## 📚 相关资源

### 已有文档
- [Phase 3 Integration Plan](./PHASE3_INTEGRATION_PLAN.md)
- [V2 Architecture Design](../V2_ARCHITECTURE_DESIGN.md)
- [Phase 2 CI Fix Report](./PHASE2_CI_FIX_REPORT.md)
- [DEBUG_SUMMARY.md](../DEBUG_SUMMARY.md)

### 技术参考
- [PostgreSQL 分区表文档](https://www.postgresql.org/docs/15/ddl-partitioning.html)
- [BPMN 2.0 规范](https://www.omg.org/spec/BPMN/2.0/)
- [Camunda Platform 文档](https://docs.camunda.org/)
- [Kysely Query Builder](https://kysely.dev/)
- [bpmn-js Examples](https://github.com/bpmn-io/bpmn-js-examples)

### GitHub 链接
- **PR #338**: https://github.com/zensgit/smartsheet/pull/338 (TS migrations batch1)
- **PR #337**: https://github.com/zensgit/smartsheet/pull/337 (DTO typing batch1)
- **PR #332**: https://github.com/zensgit/smartsheet/pull/332 (Phase 2, MERGED)

---

## 👥 团队协作

### 后端团队职责
- SQL 迁移修复
- API 端点完善
- 数据库优化
- 性能调优

### 前端团队职责
- UI 组件开发
- DTO 类型定义
- 组件集成测试
- 用户体验优化

### 全栈团队职责
- Plugin System 完善
- 端到端集成
- E2E 测试
- 文档编写

---

## 📍 下一步

**立即开始**:
1. 🚨 修复 PR #337 typecheck 失败
2. ✅ Review 并合并 PR #338
3. 🔧 开始 048 迁移重写

**本周目标**:
- 合并 2 个 PR
- 完成 048 迁移修复
- 从 MIGRATION_EXCLUDE 移除 2-3 项

**里程碑**:
- Week 3: 所有迁移修复完成
- Week 5: UI 集成完成
- Week 7: Phase 3 发布就绪

---

**🤖 报告生成时间**: 2025-10-29 23:30 UTC
**📍 当前状态**: Phase 3 已启动，2 个 PR 进行中
**🎯 近期焦点**: 修复 PR #337 typecheck + 迁移清理

**Phase 3 启动！让我们一起完成架构完善！** 🚀
