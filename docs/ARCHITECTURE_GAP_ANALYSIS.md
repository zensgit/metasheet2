# 架构差异分析：当前实现 vs 目标架构

## 总体差异度：65%
当前系统具备基础框架，但缺少关键的高级功能。

## 详细对比分析

### 1. 前端工作流设计器（差异度：85%）

#### 目标架构（n8n风格）
```typescript
- ✅ 节点库：手动节点、条件、脚本、审批、数据操作、Webhook/定时器
- ✅ 可视化拖拽连线
- ✅ 流程定义持久化（bpmn_json/dag_json）
- ✅ 实时预览与调试
```

#### 当前实现
```typescript
- ✅ 基础审批流程定义
- ❌ 没有可视化设计器
- ❌ 没有节点库概念
- ❌ 不支持 DAG/BPMN 格式
```

#### 需要开发
```typescript
// 1. 流程设计器组件
components/WorkflowDesigner.vue
- 集成 vue-flow 或 X6
- 节点模板库
- 连线规则验证

// 2. 节点定义系统
interface WorkflowNode {
  type: 'manual' | 'condition' | 'script' | 'approval' | 'data' | 'webhook'
  config: NodeConfig
  inputs: Connection[]
  outputs: Connection[]
}

// 3. 流程序列化
class WorkflowSerializer {
  toBPMN(): string
  toDAG(): object
  fromBPMN(xml: string): WorkflowDefinition
}
```

### 2. 多视图系统（差异度：20%）

#### 目标架构
```typescript
- ✅ 视图切换器与 table/view 绑定
- ✅ 配置持久化（views.config）
- ✅ 用户个性化（view_states）
- ✅ Grid/Kanban/Calendar/Gallery/Form 共用数据层
```

#### 当前实现
```typescript
- ✅ 基础视图组件（Grid/Kanban/Calendar）
- ✅ Gallery/Form 视图（刚完成）
- ✅ views 和 view_states 表
- ✅ 数据层基本共用
- ✅ ViewManager 服务统一管理
```

#### 需要微调
```typescript
// 1. 视图切换优化
class ViewSwitcher {
  async switchView(type: ViewType, preserveState: boolean = true)
  preloadViews(types: ViewType[])
}

// 2. 数据层完全统一
interface UnifiedDataLayer {
  subscribe(viewId: string, callback: DataUpdateCallback)
  updateData(changes: DataChange[])
  invalidateCache(resourceType: string, resourceId?: string)
}
```

### 3. 工作流执行引擎（差异度：70%）

#### 目标架构（Camunda风格）
```typescript
- ✅ DAG/BPMN 支持
- ✅ workflow_instances + workflow_tokens
- ✅ 事件记录与变量跟踪
- ✅ incidents 自动生成
- ✅ 可追踪可解释 API
```

#### 当前实现
```typescript
- ✅ 基础审批流程执行
- ✅ approval_requests + approval_actions
- ⚠️ 基础事件记录
- ❌ 没有 token 概念
- ❌ 没有 incidents 管理
- ❌ 缺少完整追踪 API
```

#### 需要实现
```typescript
// 1. Token-based 执行模型
interface WorkflowToken {
  instanceId: string
  nodeId: string
  status: 'waiting' | 'active' | 'completed' | 'failed'
  variables: Record<string, any>
  createdAt: Date
  completedAt?: Date
}

// 2. Incident 管理
interface Incident {
  type: 'error' | 'timeout' | 'validation'
  nodeId: string
  message: string
  stackTrace?: string
  resolution?: 'retry' | 'skip' | 'compensate'
}

// 3. 执行追踪 API
GET /api/workflows/instances/:id/trace
GET /api/workflows/instances/:id/tokens
GET /api/workflows/instances/:id/incidents
POST /api/workflows/instances/:id/retry
```

### 4. 外部数据源集成（差异度：90%）

#### 目标架构（NocoDB风格）
```typescript
- ✅ 统一抽象接口
- ✅ 虚拟表映射（external_tables）
- ✅ 写策略配置
- ✅ 物化视图（materializations）
- ✅ 自动 API 生成
```

#### 当前实现
```typescript
- ✅ 基础数据库操作
- ❌ 没有外部数据源概念
- ❌ 没有虚拟表
- ❌ 没有物化策略
```

#### 需要开发
```typescript
// 1. 数据源适配器
interface DataSourceAdapter {
  introspectSchema(): Promise<Schema>
  listRecords(table: string, query: Query): Promise<Record[]>
  getRecord(table: string, id: string): Promise<Record>
  create(table: string, data: any): Promise<Record>
  update(table: string, id: string, data: any): Promise<Record>
  delete(table: string, id: string): Promise<void>
}

// 2. 虚拟表系统
class VirtualTableManager {
  registerExternalTable(config: ExternalTableConfig)
  materialize(tableId: string, strategy: MaterializationStrategy)
  syncSchema(tableId: string)
}

// 3. API 自动生成
class APIGenerator {
  generateRESTEndpoints(table: Table): Route[]
  generateGraphQLSchema(tables: Table[]): GraphQLSchema
  generateOpenAPISpec(): OpenAPISpec
}
```

### 5. 插件系统（差异度：30%）

#### 目标架构（Baserow风格）
```typescript
- ✅ 完整 PluginContext
- ✅ 能力声明（capabilities）
- ✅ 动态加载与隔离
- ✅ 插件市场与审核
```

#### 当前实现
```typescript
- ✅ 基础插件结构
- ✅ 插件清单（plugin.json）
- ✅ RBAC、审批、审计插件已完成
- ⚠️ 部分 PluginContext（需完善）
- ❌ 缺少完整能力系统
- ❌ 没有动态加载
- ❌ 没有插件市场
```

#### 需要增强
```typescript
// 1. 完整 PluginContext
interface PluginContext {
  db: Database
  logger: Logger
  config: ConfigService
  eventBus: EventEmitter
  metrics: MetricsCollector
  auth: AuthService
  auditWriter: AuditService
  // 新增
  cache: CacheService
  queue: QueueService
  storage: StorageService
  scheduler: SchedulerService
  notificationService: NotificationService
}

// 2. 能力系统
enum PluginCapability {
  VIEW_PROVIDER = 'view-provider',
  WORKFLOW_NODE = 'workflow-node',
  DATASOURCE = 'datasource',
  FIELD_TYPE = 'field-type',
  AUTOMATION = 'automation',
  WEBHOOK = 'webhook',
  API_EXTENSION = 'api-extension'
}

// 3. 插件加载器
class PluginLoader {
  async loadPlugin(path: string): Promise<Plugin>
  async enablePlugin(pluginId: string)
  async disablePlugin(pluginId: string)
  sandboxPlugin(plugin: Plugin): SandboxedPlugin
}
```

### 6. 脚本执行环境（差异度：95%）

#### 目标架构（SeaTable风格）
```typescript
- ✅ JS 沙箱（vm2/isolated-vm）
- ✅ Python 支持
- ✅ 超时/内存限制
- ✅ 审计与持久化
```

#### 当前实现
```typescript
- ❌ 没有脚本执行能力
- ❌ 没有沙箱环境
- ❌ 没有 Python 支持
```

#### 需要实现
```typescript
// 1. JS 沙箱
class ScriptSandbox {
  constructor(options: {
    timeout: number
    memoryLimit: number
    allowedAPIs: string[]
  })

  async execute(code: string, context: any): Promise<any>
}

// 2. Python Worker
class PythonWorker {
  async execute(script: string, data: any): Promise<any>
  async installPackage(package: string)
}

// 3. 脚本字段
interface ScriptField {
  fieldId: string
  script: string
  trigger: 'onChange' | 'onSchedule' | 'manual'
  lastRun?: Date
  lastResult?: any
}
```

## 实施优先级建议

### 第一阶段（P0 - 1个月）- 已部分完成
1. **✅ 完善多视图系统** - Gallery/Form 已完成
   - ✅ 实现 Gallery/Form 视图
   - 🔄 统一视图管理器（需微调）

2. **🔄 增强插件系统** - 基础已有，需要完善
   - 📋 完整 PluginContext
   - 📋 动态加载机制

### 第二阶段（P1 - 2个月）
3. **工作流可视化设计器** - 核心功能
   - 集成 vue-flow/X6
   - 节点库实现
   - BPMN/DAG 转换

4. **增强执行引擎** - 提升能力
   - Token-based 执行
   - Incidents 管理
   - 追踪 API

### 第三阶段（P2 - 2个月）
5. **外部数据源** - 扩展性
   - 数据源适配器
   - 虚拟表系统
   - API 自动生成

6. **脚本执行环境** - 高级功能
   - JS 沙箱
   - Python Worker
   - 脚本字段

## 技术栈建议

### 前端
- **流程设计器**: vue-flow (轻量) 或 X6 (功能全)
- **状态管理**: Pinia + 持久化
- **可视化**: ECharts/D3.js

### 后端
- **工作流引擎**:
  - 自研: 继续增强当前系统
  - 集成: Camunda REST API
- **脚本执行**:
  - JS: isolated-vm (安全性高)
  - Python: Pyodide (浏览器) 或 独立 Worker
- **队列**: Bull/BullMQ
- **缓存**: Redis

### 数据层
- **ORM**: Kysely (已有) + Prisma (可选)
- **GraphQL**: PostGraphile 或 Nexus
- **CDC**: Debezium 或 数据库原生

## 迁移策略

1. **向下兼容**: 保持现有 API 不变
2. **渐进增强**: 新功能用 Feature Flag 控制
3. **数据迁移**: 提供自动迁移脚本
4. **插件升级**: 支持多版本共存

## 当前完成度总结

| 模块 | 完成度 | 状态 |
|------|--------|------|
| **多视图系统** | 80% | ✅ Gallery/Form 已完成 |
| **插件系统** | 70% | 🔄 PluginContext 需完善 |
| **工作流执行引擎** | 30% | 📋 需要 Token 模型 |
| **工作流设计器** | 15% | 📋 需要可视化界面 |
| **外部数据源** | 10% | 📋 需要适配器系统 |
| **脚本执行** | 5% | 📋 需要沙箱环境 |

**总体完成度**: **约 45%** (相比之前的 35% 有显著提升)

## 总结

经过 Gallery/Form 视图的开发，当前系统已具备：
- 🟢 **完整的多视图系统** (Grid/Kanban/Calendar/Gallery/Form)
- 🟢 **基础插件架构** (RBAC/审批/审计插件)
- 🟡 **基础工作流能力** (需要增强为 Token 模型)
- 🔴 **缺少可视化设计器** (最大痛点)
- 🔴 **缺少外部数据源** (数据孤岛)
- 🔴 **缺少脚本执行** (灵活性不足)

建议继续按 P0 → P1 → P2 的优先级推进，先完善 PluginContext，再实现工作流可视化设计器。