# V2合并方案评审意见

**评审日期**: 2025-09-29
**评审人**: Claude Code
**方案版本**: v2-merge-adjustment-plan.md (草案)

## 总体评价

⭐⭐⭐⭐½ (4.5/5)

**核心优势**:
- 渐进式架构演进策略正确（MVP壳 + 特性开关 + 逐步增强）
- 锚点迁移策略优秀（不修改历史，仅追加）
- 分阶段交付清晰（P0/P1/P2依赖关系明确）
- CI快车道设计聪明（依赖/文档类自动合并）

**需要调整**:
- P0周期过紧（建议拆分P0-A/P0-B）
- ViewService合并策略需细化（#155 vs #158差异处理）
- 插件失败处理策略需明确（critical标记 + 降级路径）
- 工作流表Schema需补充详细字段定义

---

## 详细评审

### ✅ 架构决策（优秀）

#### 1. 插件化思路
```yaml
视图插件: Baserow模式 ✓
数据源插件: NocoDB模式 ✓
工作流引擎: n8n/Camunda混合模式 ✓
脚本沙箱: SeaTable模式（JS + Python Worker）✓
```

**评价**: 借鉴成熟开源项目，避免重复造轮子

#### 2. 数据库迁移
```
锚点: 043_core_model_views.sql（不变）
新增: 045_view_query_indexes.sql
      046_workflow_core.sql
      047_workflow_audit.sql
      048_data_materialization_tables.sql
```

**评价**: 非破坏性追加，完美策略

#### 3. 特性开关
```typescript
MATERIALIZATION_ENABLED
WORKFLOW_ENGINE_V2_ENABLED
KANBAN_AUTH_REQUIRED
```

**评价**: 支持安全灰度，回滚简单

---

### ⚠️ 执行风险（需调整）

#### 风险1: ViewService合并复杂度 🟡

**问题**: PR #155 vs #158存在差异

| 差异项 | PR #155 | PR #158 | 建议 |
|--------|---------|---------|------|
| ViewService实现 | 275行完整实现 | 78行精简实现 | 采用#155，吸收#158 RBAC |
| 迁移文件 | 包含038 | 无 | 采用#155 |
| Metrics | 32行基础 | 43行增强 | 采用#158 |
| RBAC | 基础钩子 | 深度集成 | 采用#158 |

**解决方案**:
```bash
# 以#155为基础
git checkout -b feat/viewservice-unified origin/feat/data-layer-migration

# Cherry-pick #158增强
git cherry-pick <metrics-enhancement>
git cherry-pick <rbac-depth-integration>

# 手动合并冲突（保留#155完整ViewService + #158 RBAC检查）
```

**参考文档**: 见 docs/PR_155_vs_158_merge_strategy.md

---

#### 风险2: P0周期过紧 🟡

**问题**: P0本周工作量8-12人天 > 5人天（单人）

**原P0任务**:
1. 合并ViewService（#155主 + #158差异）← 2-3人天
2. 建立feat/core-backend-v2 ← 2-3人天
3. 建立feat/plugin-framework-v2 ← 2-3人天
4. 关闭测试分支 ← 0.5人天

**调整方案**:

```yaml
P0-A（Day 1-3）: 基础合并
  - 合并ViewService（#155为主，#158差异标记TODO）
  - 关闭测试分支（批量脚本，半天）
  - 运行完整测试套件
  产出: 稳定的main分支，减少20+无用分支

P0-B（Day 4-5）: 架构准备
  - 建立feat/core-backend-v2（框架骨架，不改实现）
  - 建立feat/plugin-framework-v2（增强manifest schema）
  - 编写046详细Schema草案
  产出: P1开发基础，Code Review完成

P1开始前（下周一）:
  - 集成测试通过
  - 性能基准测试建立
  - 开发环境搭建文档更新
```

---

#### 风险3: 工作流Schema缺失细节 🟡

**问题**: 046_workflow_core.sql仅提概念，无详细字段

**补充草案**: 见 `docs/046_workflow_core_schema_draft.sql`

**关键设计**:
- `workflow_definitions`: BPMN/DAG存储，支持版本管理
- `workflow_instances`: 运行时状态，支持重试/补偿
- `workflow_tokens`: Petri-net风格Token传播（Camunda思路）
- `workflow_incidents`: 错误与补偿动作记录

**示例Token状态转换**:
```
active → consumed (正常完成)
active → waiting (等待外部事件，如人工审批)
active → cancelled (实例取消)
waiting → active (事件触发)
```

**建议P1前完成**:
- [ ] Token状态机Mermaid图
- [ ] 关键查询性能预估（百万级Token场景）
- [ ] 死锁预防机制设计

---

#### 风险4: 插件失败处理策略不明确 🟡

**问题**: 方案仅提"fail-open + 审计"，缺少细节

**建议策略**:

```typescript
// packages/core-backend/src/plugin/PluginManifest.ts
export interface PluginManifest {
  id: string
  name: string
  version: string
  critical: boolean // NEW: 标记关键插件
  capabilities: string[]
  fallback?: {
    pluginId: string // 降级插件ID
    message: string   // 用户提示
  }
}

// 关键插件（fail-closed）
critical_plugins:
  - audit-trail: 审计失败则系统拒绝启动
  - rbac-enforcer: 权限失败则所有请求403

// 非关键插件（fail-open with graceful degrade）
non_critical_plugins:
  - view-kanban: 降级到GridView + 提示"看板视图暂不可用"
  - datasource-mysql: 保留Postgres访问，禁用MySQL数据源
  - script-runner: 禁用脚本执行，保留其他功能
```

**降级示例**:
```typescript
// apps/web/src/components/ViewSwitcher.vue
async loadViewComponent(viewType: string) {
  try {
    const plugin = await PluginRegistry.get(`view-${viewType}`)
    return plugin.component
  } catch (error) {
    this.$message.warning(`${viewType}视图暂不可用，已切换到表格视图`)
    this.auditService.log({ action: 'view_plugin_fallback', viewType })
    return GridView // 通用降级
  }
}
```

---

### ✅ 优秀实践（值得推广）

#### 1. CI快车道设计 🌟

```yaml
paths:
  - 'pnpm-lock.yaml'
  - '.github/workflows/**'
  - 'docs/**'
  - '**/*.md'
```

**建议增强**:
```yaml
# 增加配置文件到快车道
additional_fast_track_paths:
  - '.eslintrc.*'
  - 'tsconfig.json'
  - 'prettier.config.*'
  - '**/package.json' # 仅依赖变更，无代码变更

# 快车道专用Label
labels:
  - 'fast-track'
  - 'auto-merge-safe'
```

#### 2. CODEOWNERS清晰 🌟

```
core-backend/**       @platform-team @backend-lead
migrations/**         @db-admin @platform-team
plugins/**            @plugin-owner @platform-team
apps/web/**           @frontend-lead
```

**建议增强**: 增加`docs/`归属，便于文档维护责任

#### 3. PR回滚说明强制 🌟

```markdown
## Rollback
Revert these files if needed:
- packages/core-backend/src/services/ViewService.ts
- packages/core-backend/migrations/045_view_query_indexes.sql

Rollback steps:
1. git revert <commit-hash>
2. pnpm -F @metasheet/core-backend db:rollback
3. Restart backend service
```

**完美实践**: 每个PR必须包含回滚说明

---

## 执行建议优先级

### 🔴 P0（立即执行）
1. **调整P0周期**: 拆分P0-A（3天）+ P0-B（2天）
2. **补充ViewService合并策略**: 明确#155 vs #158技术决策
3. **清理测试分支**: 批量关闭18-23个无用分支

### 🟡 P1（本周完成）
1. **补充工作流Schema草案**: 详细字段定义（已提供草案）
2. **明确插件失败处理**: critical标记 + 降级路径
3. **增强CI快车道**: 配置文件纳入，增加fast-track标签

### 🟢 P2（下周开始）
1. **性能基准测试**: 建立baseline，便于后续优化对比
2. **插件开发者文档**: manifest编写指南、PluginContext API文档
3. **监控面板**: Grafana仪表盘（工作流执行、插件状态、数据库性能）

---

## 附录: 补充文档

### A. ViewService合并策略
见 `docs/PR_155_vs_158_merge_strategy.md`（需补充）

### B. 工作流Schema详细定义
见 `docs/046_workflow_core_schema_draft.sql`（已生成）

### C. 插件失败处理规范
见 `docs/plugin-failure-handling-spec.md`（需补充）

### D. P0执行Checklist
```markdown
## P0-A Checklist（Day 1-3）
- [ ] PR #155合并到main（squash merge）
- [ ] PR #158差异Cherry-pick（metrics + RBAC）
- [ ] 手动解决ViewService冲突
- [ ] 运行集成测试套件
- [ ] 批量关闭test/*分支（保留报告到docs/）
- [ ] 更新CHANGELOG.md

## P0-B Checklist（Day 4-5）
- [ ] 创建feat/core-backend-v2分支
- [ ] PluginContext接口定义完成
- [ ] EventBus基础实现完成
- [ ] 创建feat/plugin-framework-v2分支
- [ ] manifest.json schema v2定义
- [ ] 补充046_workflow_core.sql详细字段
- [ ] Code Review完成（至少2人）
```

---

## 签署

**方案评审**: ✅ 通过（需小幅调整）
**评审人**: Claude Code
**日期**: 2025-09-29
**建议执行日期**: 2025-09-30起（调整后P0-A）

**关键调整总结**:
1. P0拆分为P0-A/P0-B，避免周期过紧
2. ViewService合并策略细化（#155主 + #158增强）
3. 工作流Schema补充详细定义（已提供草案）
4. 插件失败处理明确critical标记和降级路径

**预期结果**:
- ✅ 稳定的主线（P0-A完成）
- ✅ 清晰的架构基础（P0-B完成）
- ✅ 可执行的P1/P2路线图
- ✅ 降低执行风险，提高成功率
