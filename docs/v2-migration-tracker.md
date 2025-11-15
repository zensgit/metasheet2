# V2迁移进度跟踪

**开始日期**: 2025-09-30
**目标完成**: 2025-10-28 (4周)
**负责人**: [待指定]
**状态更新频率**: 每日站会 + 周五周报

---

## 📊 总体进度

```
P0 (本周)        ████████░░ 80%
P1 (第1-2周)     ██░░░░░░░░ 20%
P2 (第2-4周)     ░░░░░░░░░░  0%
----------------------------------------
整体完成度:       ███░░░░░░░ 30%
```

---

## 🚀 P0 阶段（本周 Day 1-5）

### P0-A: 基础合并（Day 1-3）

#### ✅ Task 1: ViewService功能对比与统一
- **负责人**: [后端负责人]
- **预估时间**: 2天
- **状态**: 🟡 进行中

**前置检查清单**:
- [ ] 读取ViewService.ts (275行) 完整实现
- [ ] 读取view-service.ts (153行 vs 78行) 差异版本
- [ ] 生成功能对比表 (见附录A)
- [ ] 识别重复功能 vs 独特功能
- [ ] 确认RBAC集成点差异

**执行步骤**:
```bash
# 1. 创建对比分支
git checkout -b test/viewservice-comparison main

# 2. 提取两个版本的ViewService
git show origin/feat/data-layer-migration:packages/core-backend/src/services/ViewService.ts > /tmp/ViewService_155.ts
git show origin/feat/data-layer-migration:packages/core-backend/src/services/view-service.ts > /tmp/view-service_155.ts
git show origin/fix/infra-admin-observability-rbac-cache:packages/core-backend/src/services/view-service.ts > /tmp/view-service_158.ts

# 3. 生成diff报告
diff -u /tmp/ViewService_155.ts /tmp/view-service_155.ts > docs/viewservice-diff-155-internal.md
diff -u /tmp/view-service_155.ts /tmp/view-service_158.ts > docs/viewservice-diff-155-vs-158.md

# 4. 功能对比（人工评审）
# 填写 docs/viewservice-feature-comparison.md
```

**合并策略**:
```typescript
// 最终统一为单一文件: packages/core-backend/src/services/ViewService.ts

// 保留来自PR #155:
- 完整的ViewService类实现 (275行)
- 038_add_view_query_indexes.sql 迁移

// 吸收来自PR #158:
- 增强的Metrics (view_data_latency_seconds, view_data_requests_total)
- 深度RBAC集成 (canReadTable/canWriteTable)
- ConfigService统一JWT配置

// 删除:
- view-service.ts (78行精简版，功能已被275行版本包含)
```

**测试验证**:
- [ ] 单元测试通过 (`pnpm -F @metasheet/core-backend test:unit`)
- [ ] 集成测试通过 (`pnpm -F @metasheet/core-backend test:integration`)
- [ ] 五类视图回归测试 (Grid/Kanban/Gallery/Form/Calendar)
- [ ] RBAC权限测试 (403 → grant → 200)
- [ ] 性能基准测试 (与main分支对比，延迟<10%增长)

**产出文档**:
- [ ] `docs/viewservice-feature-comparison.md`
- [ ] `docs/viewservice-unification-report.md`
- [ ] `docs/rollback-procedures/viewservice-unification.md`

**回滚预案**:
```bash
# 如果合并后出现严重问题
git revert <merge-commit-hash>
pnpm -F @metasheet/core-backend db:rollback  # 如果迁移已执行
systemctl restart metasheet-backend

# 关闭特性开关（临时降级）
export USE_VIEW_SERVICE_V2=false
```

---

#### ✅ Task 2: 测试分支批量清理
- **负责人**: [DevOps/平台负责人]
- **预估时间**: 0.5天
- **状态**: ⚪ 待开始

**清理目标**:
```bash
# 测试分支 (18-23个)
test/verify-pr-comment
test/verify-rbac-improvements
test/final-strict-verification
test/v2-strict-workflow
verify-*

# 过时发布分支
v2-stabilize
release-candidate-*
```

**执行脚本**:
```bash
#!/bin/bash
# scripts/cleanup-test-branches.sh

echo "=== 测试分支清理 ==="

# 1. 列出所有test/verify分支
TEST_BRANCHES=$(git branch -r | grep -E "origin/(test|verify)-" | sed 's/origin\///')

echo "发现以下测试分支:"
echo "$TEST_BRANCHES"

# 2. 归档报告到docs/archived-test-reports/
mkdir -p docs/archived-test-reports
for branch in $TEST_BRANCHES; do
  echo "归档 $branch 报告..."
  gh pr list --head "$branch" --json body,title --jq '.[0] | "# \(.title)\n\n\(.body)"' > "docs/archived-test-reports/${branch/\//_}.md"
done

# 3. 关闭PR并删除分支
for branch in $TEST_BRANCHES; do
  PR_NUM=$(gh pr list --head "$branch" --json number --jq '.[0].number')
  if [ -n "$PR_NUM" ]; then
    echo "关闭 PR #$PR_NUM ($branch)"
    gh pr close "$PR_NUM" --comment "测试已完成，功能已合并到main，归档报告见docs/archived-test-reports/"
  fi
  echo "删除分支 $branch"
  git push origin --delete "$branch"
done

echo "清理完成！共删除 $(echo "$TEST_BRANCHES" | wc -l) 个分支"
```

**验证**:
- [ ] 分支数量从~100减少到<80
- [ ] 所有测试报告已归档到`docs/archived-test-reports/`
- [ ] PR已关闭并添加说明

---

#### ✅ Task 3: 集成测试全面验证
- **负责人**: [QA负责人]
- **预估时间**: 0.5天
- **状态**: ⚪ 待开始

**测试套件**:
```bash
# 1. 数据库迁移验证
pnpm -F @metasheet/core-backend db:migrate
pnpm -F @metasheet/core-backend db:rollback
pnpm -F @metasheet/core-backend db:migrate  # 重新应用，确保幂等性

# 2. 单元测试
pnpm -F @metasheet/core-backend test:unit

# 3. 集成测试
export DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2'
export JWT_SECRET='dev-secret-key'
pnpm -F @metasheet/core-backend test:integration

# 4. 视图功能测试
pnpm -F @metasheet/core-backend test:views

# 5. RBAC权限测试
API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend smoke:table-perms

# 6. Pre-merge检查
API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend pre-merge:check
```

**性能基准**:
```bash
# 建立baseline (在main分支)
git checkout main
pnpm -F @metasheet/core-backend benchmark > docs/performance-baseline-main.json

# 对比新实现
git checkout test/viewservice-unification
pnpm -F @metasheet/core-backend benchmark > docs/performance-viewservice-v2.json

# 生成对比报告
node scripts/compare-benchmarks.js \
  docs/performance-baseline-main.json \
  docs/performance-viewservice-v2.json \
  > docs/performance-comparison-report.md
```

**通过标准**:
- [ ] 所有单元测试通过 (覆盖率 >80%)
- [ ] 所有集成测试通过
- [ ] RBAC测试: 403 → grant → 200
- [ ] 性能退化 <10% (P99延迟)
- [ ] 无内存泄漏 (运行24小时内存增长 <5%)

---

### P0-B: 架构准备（Day 4-5）

#### ✅ Task 4: feat/core-backend-v2 分支创建
- **负责人**: [架构师/后端负责人]
- **预估时间**: 1.5天
- **状态**: ⚪ 待开始

**目标**: 提取核心服务层，为插件化做准备

**抽取内容**:
```typescript
// packages/core-backend/src/core/PluginContext.ts
export interface PluginContext {
  metadata: PluginMetadata
  api: CoreAPI
  services: {
    database: DatabaseService    // 从db/pg.ts抽取
    cache: CacheService          // 新增Redis/内存缓存
    queue: QueueService          // 新增Bull队列
    logger: LoggerService        // 从utils/logger.ts抽取
    eventBus: EventBusService    // 新增事件总线
    metrics: MetricsService      // 从metrics/metrics.ts抽取
    auth: AuthService            // 从auth/jwt-middleware.ts抽取
    audit: AuditService          // 新增审计服务
  }
  config: ConfigService          // 从config/index.ts抽取
}

// packages/core-backend/src/core/EventBus.ts
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): void
  emit(event: string, payload: any): Promise<void>
  off(event: string, handler: EventHandler): void
}

// packages/core-backend/src/core/ConfigService.ts
export class ConfigService {
  get(key: string): any
  set(key: string, value: any): void
  reload(): Promise<void>
  sanitize(): SanitizedConfig  // 隐藏敏感信息
}
```

**实施步骤**:
```bash
# 1. 创建分支
git checkout -b feat/core-backend-v2 main

# 2. 创建目录结构
mkdir -p packages/core-backend/src/core/{interfaces,services,types}

# 3. 抽取接口定义（先接口，后实现，避免破坏现有代码）
# packages/core-backend/src/core/interfaces/PluginContext.ts
# packages/core-backend/src/core/interfaces/CoreAPI.ts

# 4. 逐步迁移实现（保持向后兼容）
# Step 1: DatabaseService (从db/pg.ts抽取)
# Step 2: LoggerService (从utils/logger.ts抽取)
# Step 3: ConfigService (统一配置管理)
# Step 4: EventBus (全新实现)
# Step 5: MetricsService (从metrics.ts抽取)

# 5. 单元测试
pnpm -F @metasheet/core-backend test:unit src/core/**
```

**设计原则**:
- **非破坏性**: 保留现有API，新增PluginContext接口
- **渐进式**: 先接口定义，后逐步迁移实现
- **可测试**: 每个Service都有Mock实现用于测试

**验证清单**:
- [ ] PluginContext接口定义完整
- [ ] DatabaseService抽取完成并通过测试
- [ ] EventBus基础实现完成 (on/emit/off)
- [ ] ConfigService统一配置管理
- [ ] 所有Service有单元测试覆盖
- [ ] 向后兼容性验证（现有代码无需修改）

**文档产出**:
- [ ] `packages/core-backend/src/core/README.md` (核心服务层文档)
- [ ] `docs/plugin-context-api.md` (PluginContext API文档)
- [ ] `docs/migration-to-core-v2.md` (迁移指南)

---

#### ✅ Task 5: feat/plugin-framework-v2 分支创建
- **负责人**: [架构师/插件负责人]
- **预估时间**: 1.5天
- **状态**: ⚪ 待开始

**目标**: 增强插件框架，支持manifest、capabilities、生命周期管理

**Manifest Schema V2**:
```typescript
// packages/core-backend/src/plugin/types/PluginManifest.ts
export interface PluginManifest {
  // 基础信息
  id: string                    // 唯一标识: 'view-kanban', 'datasource-mysql'
  name: string                  // 显示名称: 'Kanban View', 'MySQL Datasource'
  version: string               // 语义化版本: '1.0.0'
  description: string
  author: string
  license: string

  // 能力声明
  capabilities: {
    type: 'view' | 'datasource' | 'workflow' | 'script' | 'audit'
    provides: string[]          // ['kanban', 'board'] for view plugin
    requires: string[]          // 依赖的其他插件
    permissions: string[]       // 需要的权限: ['database.read', 'http.request']
  }

  // 关键性标记（NEW）
  critical: boolean             // true: fail-closed, false: fail-open
  fallback?: {
    pluginId: string           // 降级插件ID
    message: string            // 用户提示
  }

  // 入口
  entry: string                 // './dist/index.js'
  frontend?: {
    component: string          // './dist/KanbanView.vue'
    routes?: RouteConfig[]
  }

  // 配置
  config?: {
    schema: JSONSchema         // 插件配置的JSON Schema
    defaults: any              // 默认配置
  }

  // 钩子
  hooks?: {
    onInstall?: string         // 安装时执行的脚本
    onUninstall?: string
    onUpgrade?: string
  }
}
```

**PluginLoader增强**:
```typescript
// packages/core-backend/src/plugin/PluginLoader.ts
export class PluginLoader {
  private plugins = new Map<string, PluginInstance>()
  private failureCache = new Map<string, PluginFailure>()

  async loadPlugin(manifest: PluginManifest): Promise<PluginInstance> {
    try {
      // 1. 验证manifest
      this.validateManifest(manifest)

      // 2. 检查依赖
      await this.checkDependencies(manifest.capabilities.requires)

      // 3. 加载插件代码
      const plugin = await import(manifest.entry)

      // 4. 验证能力
      await this.validateCapabilities(plugin, manifest.capabilities)

      // 5. 初始化插件
      const instance = await plugin.activate(this.createPluginContext(manifest))

      // 6. 注册插件
      this.plugins.set(manifest.id, instance)

      // 7. 审计日志
      await this.auditService.log({
        action: 'plugin_loaded',
        pluginId: manifest.id,
        version: manifest.version
      })

      return instance
    } catch (error) {
      return this.handlePluginFailure(manifest, error)
    }
  }

  private async handlePluginFailure(
    manifest: PluginManifest,
    error: Error
  ): Promise<PluginInstance> {
    // 审计失败
    await this.auditService.log({
      action: 'plugin_load_failed',
      pluginId: manifest.id,
      error: error.message,
      critical: manifest.critical
    })

    // 记录失败
    this.failureCache.set(manifest.id, {
      pluginId: manifest.id,
      error: error.message,
      timestamp: Date.now(),
      retryCount: 0
    })

    // 策略处理
    if (manifest.critical) {
      // 关键插件失败 → 抛出异常，阻止系统启动
      throw new CriticalPluginFailure(
        `Critical plugin ${manifest.id} failed to load: ${error.message}`
      )
    } else if (manifest.fallback) {
      // 有降级插件 → 加载降级插件
      this.logger.warn(
        `Plugin ${manifest.id} failed, loading fallback: ${manifest.fallback.pluginId}`
      )
      return this.loadPlugin(await this.getManifest(manifest.fallback.pluginId))
    } else {
      // 非关键插件 → fail-open，返回NullPlugin
      this.logger.warn(
        `Plugin ${manifest.id} failed, system continues without it`
      )
      return new NullPlugin(manifest.id)
    }
  }

  private validateManifest(manifest: PluginManifest): void {
    // 使用JSON Schema验证manifest完整性
    const validator = new Ajv()
    const valid = validator.validate(PluginManifestSchema, manifest)
    if (!valid) {
      throw new InvalidManifestError(validator.errors)
    }
  }

  private async checkDependencies(requires: string[]): Promise<void> {
    for (const dep of requires) {
      if (!this.plugins.has(dep)) {
        throw new DependencyMissingError(
          `Required plugin ${dep} is not loaded`
        )
      }
    }
  }
}

// NullPlugin: 占位实现，避免系统崩溃
export class NullPlugin implements PluginInstance {
  constructor(private pluginId: string) {}

  async activate(context: PluginContext): Promise<void> {
    context.logger.warn(`NullPlugin activated for ${this.pluginId}`)
  }

  async deactivate(): Promise<void> {
    // No-op
  }
}
```

**实施步骤**:
```bash
# 1. 创建分支
git checkout -b feat/plugin-framework-v2 main

# 2. 增强plugin-template
cd plugins/plugin-template
cat > manifest.json <<EOF
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "capabilities": {
    "type": "view",
    "provides": ["example"],
    "requires": [],
    "permissions": ["database.read"]
  },
  "critical": false,
  "entry": "./dist/index.js"
}
EOF

# 3. 实现PluginLoader增强
touch packages/core-backend/src/plugin/PluginLoader.ts
touch packages/core-backend/src/plugin/types/PluginManifest.ts

# 4. 单元测试
pnpm -F @metasheet/core-backend test:unit src/plugin/**
```

**测试用例**:
```typescript
// packages/core-backend/src/plugin/__tests__/PluginLoader.test.ts
describe('PluginLoader', () => {
  it('should load valid plugin', async () => {
    const loader = new PluginLoader()
    const manifest = createTestManifest({ critical: false })
    const instance = await loader.loadPlugin(manifest)
    expect(instance).toBeDefined()
  })

  it('should throw on critical plugin failure', async () => {
    const loader = new PluginLoader()
    const manifest = createTestManifest({ critical: true, entry: './invalid.js' })
    await expect(loader.loadPlugin(manifest)).rejects.toThrow(CriticalPluginFailure)
  })

  it('should use fallback on non-critical plugin failure', async () => {
    const loader = new PluginLoader()
    const manifest = createTestManifest({
      critical: false,
      fallback: { pluginId: 'fallback-plugin' }
    })
    const instance = await loader.loadPlugin(manifest)
    expect(instance.id).toBe('fallback-plugin')
  })

  it('should return NullPlugin for fail-open case', async () => {
    const loader = new PluginLoader()
    const manifest = createTestManifest({ critical: false, fallback: undefined })
    const instance = await loader.loadPlugin(manifest)
    expect(instance).toBeInstanceOf(NullPlugin)
  })
})
```

**产出文档**:
- [ ] `plugins/plugin-template/README.md` (插件开发指南)
- [ ] `docs/plugin-manifest-schema.md` (Manifest Schema文档)
- [ ] `docs/plugin-lifecycle.md` (插件生命周期文档)
- [ ] `docs/plugin-capabilities.md` (能力声明文档)

---

#### ✅ Task 6: 工作流Schema详细化
- **负责人**: [数据库负责人]
- **预估时间**: 0.5天
- **状态**: ⚪ 待开始

**目标**: 将草案转为可执行的迁移文件

**执行步骤**:
```bash
# 1. 复制草案到迁移目录
cp docs/046_workflow_core_schema_draft.sql \
   packages/core-backend/migrations/046_workflow_core.sql

# 2. 添加迁移头部
cat > packages/core-backend/migrations/046_workflow_core.sql <<'EOF'
-- Migration: 046_workflow_core.sql
-- Description: Token-based workflow execution (Camunda-style)
-- Author: [数据库负责人]
-- Date: 2025-09-30
-- Dependencies: 043_core_model_views.sql
-- Status: Ready for review

-- Rollback: DROP TABLE IF EXISTS workflow_incidents, workflow_tokens, workflow_instances, workflow_definitions CASCADE;
EOF

# 3. 添加迁移检查
cat >> packages/core-backend/migrations/046_workflow_core.sql <<'EOF'
-- Pre-check: Ensure 043 is applied
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'views') THEN
    RAISE EXCEPTION 'Migration 043_core_model_views.sql must be applied first';
  END IF;
END $$;
EOF

# 4. 本地测试
export DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2_test'
psql $DATABASE_URL -f packages/core-backend/migrations/046_workflow_core.sql

# 5. 验证幂等性
psql $DATABASE_URL -f packages/core-backend/migrations/046_workflow_core.sql  # 应该不报错

# 6. 回滚测试
psql $DATABASE_URL -c "DROP TABLE IF EXISTS workflow_incidents, workflow_tokens, workflow_instances, workflow_definitions CASCADE;"
```

**验证清单**:
- [ ] 迁移文件语法正确
- [ ] 幂等性验证通过（重复执行不报错）
- [ ] 回滚测试通过
- [ ] 索引创建完成（instance_id, node_id, status）
- [ ] 外键约束正确（ON DELETE CASCADE）
- [ ] 示例数据插入成功

**补充文档**:
- [ ] `docs/workflow-schema-design.md` (Schema设计文档)
- [ ] `docs/workflow-token-state-machine.md` (Token状态机文档，Mermaid图)

---

## 📈 P1 阶段（第1-2周）

### 视图插件化

#### Task 7: Kanban插件化 (最复杂，优先攻克)
- **负责人**: [前端负责人 + 后端负责人]
- **预估时间**: 3天
- **状态**: ⚪ 待开始

**目标**: 将Kanban视图从核心代码抽离为独立插件

**实施步骤**:
```bash
# 1. 创建插件目录
mkdir -p plugins/plugin-view-kanban/{src,dist,tests}

# 2. 创建manifest.json
cat > plugins/plugin-view-kanban/manifest.json <<'EOF'
{
  "id": "view-kanban",
  "name": "Kanban View",
  "version": "1.0.0",
  "description": "Kanban board view for project management",
  "author": "Metasheet Team",
  "license": "MIT",
  "capabilities": {
    "type": "view",
    "provides": ["kanban", "board"],
    "requires": [],
    "permissions": ["database.read", "database.write", "view.state"]
  },
  "critical": false,
  "fallback": {
    "pluginId": "view-grid",
    "message": "看板视图暂不可用，已切换到表格视图"
  },
  "entry": "./dist/index.js",
  "frontend": {
    "component": "./dist/KanbanView.vue",
    "routes": [
      { "path": "/kanban/:viewId", "component": "KanbanView" }
    ]
  }
}
EOF

# 3. 迁移后端代码
# 从 packages/core-backend/src/routes/views.ts 提取Kanban相关路由
# 移动到 plugins/plugin-view-kanban/src/routes.ts

# 4. 迁移前端组件
# 从 apps/web/src/views/KanbanView.vue
# 移动到 plugins/plugin-view-kanban/src/KanbanView.vue

# 5. 添加插件入口
cat > plugins/plugin-view-kanban/src/index.ts <<'EOF'
import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend/src/types/plugin'
import { registerKanbanRoutes } from './routes'

export default class KanbanViewPlugin implements PluginLifecycle {
  async activate(context: PluginContext): Promise<void> {
    // 注册后端路由
    registerKanbanRoutes(context.api.http)

    // 注册视图类型
    context.api.views.registerViewType({
      type: 'kanban',
      displayName: 'Kanban Board',
      icon: 'board',
      component: 'KanbanView'
    })

    context.logger.info('Kanban plugin activated')
  }

  async deactivate(): Promise<void> {
    // 清理资源
  }
}
EOF
```

**测试清单**:
- [ ] 插件独立加载测试
- [ ] Kanban视图渲染测试
- [ ] 拖拽功能测试
- [ ] 用户状态持久化测试
- [ ] RBAC权限测试
- [ ] 性能测试（1000+卡片场景）
- [ ] 降级测试（插件失败 → Grid fallback）

**验证脚本**:
```bash
# 1. 构建插件
cd plugins/plugin-view-kanban
pnpm build

# 2. 启动后端（加载插件）
export PLUGINS_PATH=./plugins
pnpm -F @metasheet/core-backend dev:core

# 3. 验证插件加载
curl http://localhost:8900/api/plugins | jq '.[] | select(.id == "view-kanban")'

# 4. 创建Kanban视图
curl -X POST http://localhost:8900/api/views \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "tableId": "test-table-id",
    "type": "kanban",
    "name": "Test Kanban",
    "config": {
      "columns": [
        {"id": "todo", "title": "Todo"},
        {"id": "doing", "title": "Doing"},
        {"id": "done", "title": "Done"}
      ]
    }
  }'

# 5. 访问Kanban视图
curl http://localhost:8900/api/kanban/test-view-id \
  -H "Authorization: Bearer $TOKEN"
```

---

#### Task 8-10: Gallery/Form/Calendar插件化
（结构类似，省略详细步骤）

**优先级**:
1. Gallery (中等复杂度, 3天)
2. Form (相对独立, 2天)
3. Calendar (可能需要新开发, 4天)

---

### 数据物化插件

#### Task 11: DataMaterialization插件壳
- **负责人**: [数据工程师]
- **预估时间**: 2天
- **状态**: ⚪ 待开始

**目标**: 将PR #137的数据物化功能拆分为插件

**特性开关**:
```bash
export MATERIALIZATION_ENABLED=true
```

**实施策略**:
```bash
# 1. 创建插件目录
mkdir -p plugins/datasource-materialization/{src,dist}

# 2. 迁移048迁移文件（保持不变）
# packages/core-backend/migrations/048_data_materialization_tables.sql

# 3. 仅合并非破坏性增强到DataSourceManager
# 保留核心接口，具体物化逻辑移到插件

# 4. 插件实现
cat > plugins/datasource-materialization/src/index.ts <<'EOF'
export default class MaterializationPlugin implements PluginLifecycle {
  async activate(context: PluginContext): Promise<void> {
    if (!process.env.MATERIALIZATION_ENABLED) {
      context.logger.info('Materialization disabled')
      return
    }

    // 注册物化路由
    context.api.http.addRoute('POST', '/api/datasources/:id/materialize', ...)
    context.api.http.addRoute('GET', '/api/datasources/:id/materialization/status', ...)
  }
}
EOF
```

---

### 工作流模型

#### Task 12: 工作流最小API
- **负责人**: [后端负责人]
- **预估时间**: 2天
- **状态**: ⚪ 待开始

**目标**: 实现definitions/instances/tokens/incidents的CRUD API

**API设计**:
```typescript
// packages/core-backend/src/routes/workflows.ts

// 1. 工作流定义
POST   /api/workflows/definitions        // 创建定义
GET    /api/workflows/definitions        // 列表
GET    /api/workflows/definitions/:id    // 详情
PUT    /api/workflows/definitions/:id    // 更新
DELETE /api/workflows/definitions/:id    // 删除

// 2. 工作流实例
POST   /api/workflows/instances           // 启动实例
GET    /api/workflows/instances           // 列表
GET    /api/workflows/instances/:id       // 详情
POST   /api/workflows/instances/:id/cancel // 取消实例

// 3. Token查询（调试用）
GET    /api/workflows/instances/:id/tokens // 查询实例Token

// 4. Incident管理
GET    /api/workflows/instances/:id/incidents // 查询事故
POST   /api/workflows/incidents/:id/resolve   // 解决事故
```

**实现**:
```typescript
// packages/core-backend/src/services/WorkflowService.ts
export class WorkflowService {
  async createDefinition(def: WorkflowDefinition): Promise<string> {
    // 插入workflow_definitions
    const result = await this.db.query(
      'INSERT INTO workflow_definitions(name, version, bpmn_json, triggers) VALUES($1, $2, $3, $4) RETURNING id',
      [def.name, def.version, def.bpmn_json, def.triggers]
    )
    return result.rows[0].id
  }

  async startInstance(definitionId: string, input: any): Promise<string> {
    // 1. 创建实例
    const instanceId = await this.createInstance(definitionId, input)

    // 2. 创建初始Token（在start节点）
    await this.createToken(instanceId, 'start', { input })

    // 3. 触发Token消费（异步）
    this.consumeTokens(instanceId)

    return instanceId
  }

  private async consumeTokens(instanceId: string): Promise<void> {
    // Token消费循环（Petri-net执行引擎核心）
    // 这是P2阶段的工作，P1只需要CRUD
  }
}
```

---

## 🚀 P2 阶段（第2-4周）

### 执行引擎

#### Task 13: Workflow Engine V2
- **负责人**: [工作流引擎负责人]
- **预估时间**: 5天
- **状态**: ⚪ 待开始

**目标**: 实现Token-based执行引擎

**核心算法**:
```typescript
// packages/core-backend/src/services/workflow/TokenEngine.ts
export class TokenEngine {
  async consumeToken(tokenId: string): Promise<void> {
    // 1. 获取Token
    const token = await this.getToken(tokenId)
    if (token.status !== 'active') return

    // 2. 获取节点定义
    const node = await this.getNode(token.instance_id, token.node_id)

    // 3. 执行节点逻辑
    try {
      const result = await this.executeNode(node, token.payload)

      // 4. 标记Token为consumed
      await this.updateTokenStatus(tokenId, 'consumed')

      // 5. 创建下游Token
      const outgoingEdges = await this.getOutgoingEdges(node.id)
      for (const edge of outgoingEdges) {
        await this.createToken(token.instance_id, edge.target, result)
      }

      // 6. 递归消费下游Token
      for (const edge of outgoingEdges) {
        const newToken = await this.getActiveToken(token.instance_id, edge.target)
        await this.consumeToken(newToken.id)
      }
    } catch (error) {
      // 7. 创建Incident
      await this.createIncident(token.instance_id, tokenId, token.node_id, error)
    }
  }

  private async executeNode(node: WorkflowNode, payload: any): Promise<any> {
    switch (node.type) {
      case 'serviceTask':
        return this.executeServiceTask(node, payload)
      case 'userTask':
        return this.executeUserTask(node, payload)
      case 'exclusiveGateway':
        return this.executeGateway(node, payload)
      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }
}
```

**测试用例**:
```typescript
describe('TokenEngine', () => {
  it('should execute simple sequential workflow', async () => {
    // Given: start → task1 → task2 → end
    const engine = new TokenEngine()
    const instanceId = await engine.startInstance(workflowId, { input: 'test' })

    // When: wait for completion
    await engine.waitForCompletion(instanceId)

    // Then: all tokens consumed
    const tokens = await engine.getTokens(instanceId)
    expect(tokens.every(t => t.status === 'consumed')).toBe(true)
  })

  it('should handle parallel gateway', async () => {
    // Given: start → parallelGateway → [task1, task2] → join → end
    // Then: both branches should execute in parallel
  })

  it('should create incident on task failure', async () => {
    // Given: task throws error
    // Then: incident created, instance not failed
  })
})
```

---

#### Task 14-16: ScriptRunner/DataSource Adapters/Audit Trail
（结构类似，省略详细步骤）

---

## 🛡️ 风险缓解措施

### 1. 特性开关集中管理

```typescript
// packages/core-backend/src/config/features.ts
export const FEATURES = {
  // 核心功能
  PLUGIN_SYSTEM: getEnvBool('ENABLE_PLUGINS', true),
  VIEW_SERVICE_V2: getEnvBool('USE_VIEW_SERVICE_V2', true),

  // 插件功能
  MATERIALIZATION: getEnvBool('MATERIALIZATION_ENABLED', false),
  WORKFLOW_V2: getEnvBool('WORKFLOW_ENGINE_V2_ENABLED', false),
  SCRIPT_SANDBOX: getEnvBool('SCRIPT_SANDBOX_ENABLED', false),
  SCRIPT_PYTHON: getEnvBool('SCRIPT_SANDBOX_PYTHON_ENABLED', false),

  // 视图插件
  VIEW_KANBAN: getEnvBool('VIEW_KANBAN_ENABLED', true),
  VIEW_GALLERY: getEnvBool('VIEW_GALLERY_ENABLED', true),
  VIEW_FORM: getEnvBool('VIEW_FORM_ENABLED', true),
  VIEW_CALENDAR: getEnvBool('VIEW_CALENDAR_ENABLED', false), // 新功能，默认关闭
} as const

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (value === undefined) return defaultValue
  return value === 'true' || value === '1'
}

// 运行时动态开关（通过Admin API）
export class FeatureFlagService {
  async setFeature(key: keyof typeof FEATURES, value: boolean): Promise<void> {
    // 更新数据库
    await this.db.query(
      'INSERT INTO feature_flags(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2',
      [key, value]
    )
    // 广播变更
    this.eventBus.emit('feature:changed', { key, value })
  }

  async getFeature(key: keyof typeof FEATURES): Promise<boolean> {
    // 优先从数据库读取，回退到环境变量
    const result = await this.db.query('SELECT value FROM feature_flags WHERE key = $1', [key])
    return result.rows[0]?.value ?? FEATURES[key]
  }
}
```

**使用示例**:
```typescript
// 在代码中使用
import { FEATURES } from '@/config/features'

if (FEATURES.WORKFLOW_V2) {
  // 使用新工作流引擎
  return new WorkflowEngineV2()
} else {
  // 使用旧工作流引擎
  return new LegacyWorkflowEngine()
}
```

---

### 2. 回滚检查清单模板

```markdown
<!-- PR模板: .github/pull_request_template.md -->

## 影响范围说明
- [ ] 影响核心服务（database/auth/config）
- [ ] 影响插件框架
- [ ] 影响数据库Schema
- [ ] 影响API接口
- [ ] 仅影响文档/配置

## 回滚步骤
<!-- 如果此PR导致问题，如何快速回滚？ -->

### 代码回滚
```bash
git revert <commit-hash>
# OR
git checkout <previous-commit>
```

### 数据库回滚
```bash
# 如果包含迁移
pnpm -F @metasheet/core-backend db:rollback
```

### 特性开关降级
```bash
# 如果使用特性开关
export FEATURE_NAME=false
systemctl restart metasheet-backend
```

## 数据兼容性声明
- [ ] 此PR不影响现有数据
- [ ] 此PR兼容现有数据格式
- [ ] 此PR需要数据迁移（已包含迁移脚本）
- [ ] 此PR可能破坏现有数据（需要备份）

## 性能影响评估
- [ ] 已运行性能基准测试
- [ ] 延迟增长: ____% (P50/P99)
- [ ] 吞吐量变化: ____% (QPS)
- [ ] 内存使用变化: ____MB

## 监控指标
<!-- 此PR引入的新监控指标 -->
- `metric_name_1` - 描述
- `metric_name_2` - 描述

## 测试覆盖
- [ ] 单元测试覆盖率 >80%
- [ ] 集成测试通过
- [ ] 性能测试通过
- [ ] 手动测试完成

---

**审核清单（由Reviewer填写）**
- [ ] 回滚步骤清晰可执行
- [ ] 数据兼容性声明合理
- [ ] 性能影响可接受
- [ ] 监控指标已添加
- [ ] 测试覆盖充分
```

---

### 3. 监控指标增强

```typescript
// packages/core-backend/src/metrics/metrics.ts

// 插件相关指标
export const pluginLoadTimeMs = new Histogram({
  name: 'plugin_load_time_ms',
  help: 'Plugin load time in milliseconds',
  labelNames: ['plugin_id', 'result'],
  buckets: [10, 50, 100, 500, 1000, 5000]
})

export const pluginErrorCount = new Counter({
  name: 'plugin_error_count',
  help: 'Plugin error count',
  labelNames: ['plugin_id', 'error_type']
})

// 视图相关指标
export const viewRenderTimeMs = new Histogram({
  name: 'view_render_time_ms',
  help: 'View render time in milliseconds',
  labelNames: ['view_type', 'result'],
  buckets: [50, 100, 200, 500, 1000, 2000]
})

// 工作流相关指标
export const workflowInstanceDurationMs = new Histogram({
  name: 'workflow_instance_duration_ms',
  help: 'Workflow instance duration in milliseconds',
  labelNames: ['workflow_name', 'status'],
  buckets: [100, 500, 1000, 5000, 10000, 60000]
})

export const workflowTokenCount = new Gauge({
  name: 'workflow_token_count',
  help: 'Active workflow tokens',
  labelNames: ['instance_id', 'status']
})

// 迁移相关指标
export const migrationExecutionTimeMs = new Histogram({
  name: 'migration_execution_time_ms',
  help: 'Migration execution time in milliseconds',
  labelNames: ['migration_name', 'result'],
  buckets: [100, 500, 1000, 5000, 10000]
})
```

**Grafana仪表盘配置**:
```json
{
  "dashboard": {
    "title": "Metasheet V2 Monitoring",
    "panels": [
      {
        "title": "Plugin Load Time (P99)",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, rate(plugin_load_time_ms_bucket[5m]))",
            "legendFormat": "{{plugin_id}}"
          }
        ]
      },
      {
        "title": "Plugin Error Rate",
        "targets": [
          {
            "expr": "rate(plugin_error_count[5m])",
            "legendFormat": "{{plugin_id}} - {{error_type}}"
          }
        ],
        "alert": {
          "conditions": [
            {
              "type": "query",
              "evaluator": { "type": "gt", "params": [0.01] }
            }
          ],
          "message": "Plugin error rate > 1%"
        }
      },
      {
        "title": "View Render Time (P95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(view_render_time_ms_bucket[5m]))",
            "legendFormat": "{{view_type}}"
          }
        ],
        "alert": {
          "conditions": [
            {
              "type": "query",
              "evaluator": { "type": "gt", "params": [500] }
            }
          ],
          "message": "View render time > 500ms"
        }
      },
      {
        "title": "Workflow Active Tokens",
        "targets": [
          {
            "expr": "sum(workflow_token_count{status='active'})",
            "legendFormat": "Active Tokens"
          }
        ]
      }
    ]
  }
}
```

---

## 📋 附录

### A. ViewService功能对比表
（待Task 1完成后填写）

### B. 插件开发示例
（见 `plugins/plugin-template/README.md`）

### C. 迁移依赖图
```mermaid
graph TD
  A[043_core_model_views.sql] --> B[045_view_query_indexes.sql]
  A --> C[046_workflow_core.sql]
  C --> D[047_workflow_audit.sql]
  A --> E[048_data_materialization_tables.sql]
```

### D. Token状态机图
```mermaid
stateDiagram-v2
  [*] --> active: createToken
  active --> consumed: executeNode success
  active --> waiting: waitForExternalEvent
  active --> cancelled: cancelInstance
  waiting --> active: externalEventReceived
  consumed --> [*]
  cancelled --> [*]
```

---

## 📞 联系与支持

**日常沟通**: Slack #v2-migration
**问题上报**: GitHub Issues (label: v2-migration)
**紧急联系**: [架构师手机] / [平台负责人邮箱]

**每日站会**: 10:00 AM (15分钟)
**周五周报**: 提交至 docs/weekly-reports/

---

**最后更新**: 2025-09-30
**下次更新**: 每日或有重大进展时
