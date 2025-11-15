# PR重新实施计划 - 系统化重构方案

**创建日期**: 2025-11-03
**基于**: 10个已关闭PR的重新评估
**策略**: 插件化 + 灰度发布 + 可回退
**目标**: 安全、渐进式地重新实现功能

---

## 🎯 核心原则

### 1. 插件优先
- 所有新功能作为**独立插件**实现
- 默认**关闭开关** (`FEATURE_*=false`)
- 清晰的**插件契约**和API边界

### 2. 渐进式交付
- 小PR策略（< 10文件）
- 每个PR可独立上线
- 分批次、分阶段实施

### 3. 安全门禁
- **统一smoke测试**：每个PR附1-2条curl验证
- **CI全覆盖**：lints + build + smoke
- **文档同步**：迁移说明 + 回退方案

### 4. 迁移规范
- **数据库迁移**：`051_*.sql`, `052_*.sql`（纯数字递增）
- **提交规范**：`<scope>: <summary>`
- **开关命名**：`FEATURE_<NAME>=true/false`

---

## 📋 分批实施计划

### 第一批：小且独立（1-2天完成）✅ 优先

#### PR #84 - 权限组简化
**原PR**: feat(core-backend): add permission groups for simplified plugin configuration
**新方案**:
- Rebase到最新main
- 如涉及DB：新增迁移 `051_permission_groups.sql`
- 补充 `backend/src/routes/permissions.js` 的契约文档
- 添加smoke测试

**具体步骤**:
```bash
# 1. 创建新分支
git checkout -b feat/permission-groups-v2

# 2. Cherry-pick原PR的有效commit（如果可能）
# 或手动重新实现

# 3. 添加迁移文件（如需要）
# backend/src/db/migrations/051_permission_groups.sql

# 4. 添加smoke测试
# curl -X GET http://localhost:8900/api/permissions/groups

# 5. 更新文档
# docs/permissions/permission-groups.md

# 6. 提交并创建PR
git add .
git commit -m "feat(permissions): add permission groups for plugin config"
gh pr create --title "feat(permissions): add permission groups (v2)" \
  --body "Reimplementation of #84 with migration strategy and smoke tests"
```

**验收标准**:
- ✅ 迁移文件遵循051+命名
- ✅ Smoke测试覆盖主要API
- ✅ OpenAPI文档更新
- ✅ CI全绿

---

#### PR #83 - 权限白名单扩展
**原PR**: feat(core-backend): expand plugin permission whitelist and clarify checks
**新方案**:
- 显式白名单 + 审计日志（最小实现）
- 白名单配置放`.env`或配置中心
- 增加审计打点
- 补充OpenAPI与smoke

**具体步骤**:
```bash
# 1. 创建新分支
git checkout -b feat/permission-whitelist-v2

# 2. 实现白名单配置
# backend/src/config/permission-whitelist.js
# 支持环境变量: PERMISSION_WHITELIST="action1,action2"

# 3. 添加审计日志
# backend/src/middleware/permission-audit.js

# 4. Smoke测试
# curl -X POST http://localhost:8900/api/permissions/check

# 5. 提交PR
```

**验收标准**:
- ✅ 白名单可通过环境变量配置
- ✅ 所有权限检查记录审计日志
- ✅ OpenAPI完整
- ✅ Smoke测试覆盖关键路径

---

#### PR #126 - Auth工具提取
**原PR**: feat(web): extract auth utils and use in KanbanView
**新方案**:
- 创建 `@metasheet/core-shared/auth` 或 `core-backend/utils/auth`
- 仅移动与导出，不改调用方逻辑
- 配置最小单测

**具体步骤**:
```bash
# 选项A: 独立包
mkdir -p packages/core-shared/auth
cat > packages/core-shared/auth/package.json <<EOF
{
  "name": "@metasheet/core-shared-auth",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts"
}
EOF

# 选项B: 核心工具（推荐）
mkdir -p packages/core-backend/src/utils/auth

# 移动auth相关函数
# 更新import路径
# 添加单测

# 提交
git commit -m "refactor(auth): extract auth utils to shared location"
```

**验收标准**:
- ✅ 所有auth工具函数集中到一处
- ✅ 所有调用方import路径更新
- ✅ 单测覆盖核心函数
- ✅ 不影响现有功能

---

### 第二批：基础设施（低中风险，3-5天）

#### PR #134 - OpenTelemetry
**原PR**: feat: add OpenTelemetry observability system
**新方案**: 插件化实现
- 创建 `plugins/plugin-telemetry-otel`
- 默认开关 `FEATURE_OTEL=false`
- 只接入metrics与简易tracing
- Prometheus导出 + Grafana仪表板

**插件结构**:
```
plugins/plugin-telemetry-otel/
├── package.json
├── plugin.json           # 插件元数据
├── src/
│   ├── index.ts         # 插件入口
│   ├── metrics.ts       # Metrics收集
│   ├── tracing.ts       # Tracing配置
│   └── exporters/
│       └── prometheus.ts
├── grafana/
│   └── dashboard.json
└── docs/
    └── README.md
```

**验收标准**:
- ✅ 插件可独立启用/禁用
- ✅ 不影响核心包依赖
- ✅ Prometheus endpoint可访问
- ✅ 完整文档和示例

---

### 第三批：数据侧（依赖梳理，5-7天）

#### PR #137 + #143 - 数据源系统
**原PR**:
- #137: External Data Source Adapter System
- #143: External data source persistence layer

**新方案**: 合并为"数据源插件链"

##### PR1: plugin-datasource-adapters
**范围**: 接口定义 + 1-2个稳定驱动
```typescript
// plugins/plugin-datasource-adapters/src/interfaces.ts
export interface DataSourceAdapter {
  connect(): Promise<Connection>
  query(sql: string): Promise<Result>
  healthCheck(): Promise<boolean>
  disconnect(): Promise<void>
}

// 实现MySQL和PostgreSQL驱动
export class MySQLAdapter implements DataSourceAdapter { ... }
export class PostgreSQLAdapter implements DataSourceAdapter { ... }
```

**验收标准**:
- ✅ 清晰的接口定义
- ✅ 2个稳定驱动实现
- ✅ 健康检查机制
- ✅ 连接池管理

##### PR2: plugin-datasource-persistence
**范围**: 最小持久化路径
```sql
-- 迁移文件: 052_datasource_configs.sql
CREATE TABLE datasource_configs (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,  -- 'mysql', 'postgresql', etc.
  config JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**验收标准**:
- ✅ 配置持久化到DB
- ✅ 迁移文件完整（up/down）
- ✅ 默认关闭 `FEATURE_DATASOURCE=false`
- ✅ CRUD API完整

##### PR3: 扩展适配器（可选）
**范围**: MongoDB, Redis等额外驱动

---

### 第四批：工作流系统（中高风险，分插件，7-10天）

#### 插件1: plugin-workflow-engine
**原PR基础**: #135 Token-based workflow execution engine
**范围**: 最小MVP
```typescript
// 定义/执行/状态接口
export interface WorkflowEngine {
  define(workflow: WorkflowDefinition): Promise<string>
  execute(workflowId: string, context: Context): Promise<Execution>
  getStatus(executionId: string): Promise<Status>
}

// 复用现有unified_workflows表
```

**验收标准**:
- ✅ 基础工作流定义和执行
- ✅ 状态追踪
- ✅ 错误处理和重试
- ✅ 默认关闭 `FEATURE_WORKFLOW=false`

#### 插件2: plugin-bpmn
**原PR基础**: #142 BPMN/DAG workflow persistence
**范围**: 仅前置设计/解析/验证
```typescript
// BPMN解析器
export class BPMNParser {
  parse(xml: string): WorkflowDefinition
  validate(definition: WorkflowDefinition): ValidationResult
}

// 不抢占引擎控制权
// 输出标准WorkflowDefinition供engine使用
```

**验收标准**:
- ✅ BPMN 2.0解析
- ✅ 验证规则完整
- ✅ 与engine解耦
- ✅ 示例BPMN文件

#### 插件3: plugin-workflow-designer
**原PR基础**: #136 Visual Workflow Designer with Vue Flow
**范围**: 纯前端插件
```vue
<!-- Vue Flow可视化设计器 -->
<template>
  <VueFlow v-model="nodes" v-model:edges="edges">
    <!-- 工作流节点定义 -->
  </VueFlow>
</template>

<script setup>
// 通过API与后端engine通信
const saveWorkflow = async (definition) => {
  await api.post('/api/workflows', definition)
}
</script>
```

**验收标准**:
- ✅ 可视化编辑器可用
- ✅ 节点类型完整（开始/结束/任务/网关）
- ✅ 实时验证
- ✅ 导入/导出BPMN

**插件契约清晰度**:
```
┌─────────────────────────────────────┐
│  plugin-workflow-designer (前端)    │
│  - 可视化编辑                        │
│  - 导出WorkflowDefinition           │
└─────────────┬───────────────────────┘
              │ API契约
              ↓
┌─────────────────────────────────────┐
│  plugin-workflow-engine (后端)      │
│  - 接收WorkflowDefinition           │
│  - 执行工作流                        │
│  - 控制权在这里                      │
└─────────────┬───────────────────────┘
              │ 可选
              ↓
┌─────────────────────────────────────┐
│  plugin-bpmn (解析器)                │
│  - 解析BPMN XML                     │
│  - 转换为WorkflowDefinition         │
│  - 辅助工具，不控制执行              │
└─────────────────────────────────────┘
```

---

### 第五批：大型/冲突（重构后分期，10-14天）

#### PR #145 - Phase 3 RealShare
**原PR**: Implement Phase 3 RealShare metrics and enhanced observability
**新方案**: 归档并分解

##### Step 1: 归档原PR
```bash
# 创建归档分支保存全部改动
git checkout feat/enhanced-plugin-context
git checkout -b archive/realshare-phase3-original
git push origin archive/realshare-phase3-original
```

##### Step 2: 提取独立小能力

**PR2.1: RealShare只读指标**
```typescript
// 只添加指标收集，不改逻辑
export const realShareMetrics = {
  rbac_perm_queries_real_total: new Counter({
    name: 'rbac_perm_queries_real_total',
    help: 'Real RBAC permission queries'
  }),
  rbac_perm_queries_synth_total: new Counter({
    name: 'rbac_perm_queries_synth_total',
    help: 'Synthetic RBAC permission queries'
  })
}
```

**PR2.2: RealShare文档和脚本**
```bash
# 只提取文档改进
docs/observability/realshare-metrics.md
scripts/measure-realshare.sh
```

**PR2.3: 余下功能立项重构**
- 评估是否仍需要
- 设计新架构
- 分期实施

---

## 🔧 统一技术规范

### 迁移文件命名
```
backend/src/db/migrations/
├── 051_permission_groups.sql
├── 052_datasource_configs.sql
├── 053_workflow_definitions.sql
├── 054_workflow_executions.sql
└── ...
```

**规则**:
- 纯数字递增：051, 052, 053...
- 描述性名称：`<number>_<feature_name>.sql`
- 包含up/down：每个迁移文件必须可回退

### 环境变量开关
```bash
# 所有新功能默认关闭
FEATURE_OTEL=false              # OpenTelemetry
FEATURE_DATASOURCE=false        # 数据源适配器
FEATURE_WORKFLOW=false          # 工作流引擎
FEATURE_PERMISSION_GROUPS=false # 权限组
```

### Smoke测试模板
```bash
#!/bin/bash
# scripts/smoke-test-<feature>.sh

echo "🧪 Smoke Test: <Feature Name>"

# 1. 健康检查
curl -f http://localhost:8900/health || exit 1

# 2. 功能特定检查
curl -f http://localhost:8900/api/<feature>/status || exit 1

# 3. 基础操作
curl -X POST http://localhost:8900/api/<feature> \
  -H "Content-Type: application/json" \
  -d '{"test": true}' || exit 1

echo "✅ All smoke tests passed"
```

### 提交信息规范
```bash
# 格式
<scope>: <summary>

# 示例
feat(permissions): add permission groups for plugin config
fix(datasource): handle connection pool exhaustion
docs(workflow): add BPMN integration guide
refactor(auth): extract auth utils to shared location
```

**Scope建议**:
- `permissions` - 权限相关
- `datasource` - 数据源
- `workflow` - 工作流
- `auth` - 认证授权
- `telemetry` - 可观测性
- `cache` - 缓存系统

---

## ✅ 验收门禁清单

每个PR必须满足：

### 1. 代码质量
- [ ] ESLint通过
- [ ] TypeScript编译通过
- [ ] Build成功

### 2. 测试覆盖
- [ ] 单元测试（如适用）
- [ ] Smoke测试脚本
- [ ] CI全绿

### 3. 文档完整
- [ ] README.md（插件）或更新相关文档
- [ ] 迁移说明（如有DB改动）
- [ ] 回退方案
- [ ] OpenAPI文档（如有API改动）

### 4. 功能开关
- [ ] 默认关闭（`FEATURE_*=false`）
- [ ] 可灰度发布
- [ ] 可快速回退

### 5. 审查标准
- [ ] < 10文件（推荐）
- [ ] < 500行改动（推荐）
- [ ] 单一职责
- [ ] 清晰的PR描述

---

## 📊 进度跟踪

### 第一批（目标：本周内）
- [ ] #84 权限组简化
- [ ] #83 权限白名单扩展
- [ ] #126 Auth工具提取

### 第二批（目标：下周）
- [ ] #134 OpenTelemetry插件

### 第三批（目标：2周后）
- [ ] #137/#143 数据源插件（PR1-3）

### 第四批（目标：3-4周）
- [ ] #135 工作流引擎
- [ ] #142 BPMN插件
- [ ] #136 工作流设计器

### 第五批（目标：评估后决定）
- [ ] #145 RealShare（分解）

---

## 🎓 实施建议

### 从第一批开始
1. **立即着手**: #84权限组最简单，作为模板
2. **建立流程**: 通过第一个PR建立标准流程
3. **复制成功**: 后续PR遵循相同模式

### 并行开发策略
- **不同开发者**: 可并行处理不同批次
- **相同开发者**: 按批次顺序进行
- **依赖管理**: 确保API契约清晰

### 风险管理
- **每个PR独立可回退**: 通过feature flag
- **渐进式上线**: 先灰度，再全量
- **监控告警**: 每个新功能配置监控

---

## 📚 参考资源

### 现有成功案例
- **PR #350**: Cache Phase 2 - 作为插件化参考
- **PR #347**: Cache Phase 1 - Observability模式
- **Migration files**: 现有迁移文件作为模板

### 文档位置
- **插件开发**: `docs/plugin-development.md`
- **迁移指南**: `docs/database-migrations.md`
- **测试规范**: `docs/testing-guidelines.md`

---

## 💡 下一步行动

### 立即执行（推荐）
```bash
# 1. 创建第一批PR跟踪issue
gh issue create --title "实施计划：第一批PR (权限+Auth)" \
  --body "参考: claudedocs/PR_REIMPLEMENTATION_PLAN.md"

# 2. 开始#84 - 权限组简化
git checkout -b feat/permission-groups-v2
# 开始实施...
```

### 本周目标
- 完成第一批3个PR
- 建立标准流程模板
- 验证门禁有效性

---

**文档版本**: v1.0
**创建日期**: 2025-11-03
**维护者**: Development Team
**审核周期**: 每周更新进度

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
