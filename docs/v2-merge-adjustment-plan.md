# V2 合并与调整方案

> 文档版本：1.0.0
> 创建日期：2024-10-12
> 目标读者：架构/平台负责人、核心后端维护者、插件作者、前端负责人
> 范围：合并路径、分支收敛、数据库迁移、CI/观测、回滚与所有权

## 一、目标与原则

### 目标
- 主线稳定、合入节奏可控；以"最小可用子集（MVP 壳）+ 特性开关 + 逐步增强"落地 v2 架构
- 收敛分支与重复实现，统一服务层与数据模型；把可变能力外放为插件

### 原则
- 仅追加新迁移，不修改历史迁移；保持 `MIGRATION_INCLUDE=043_core_model_views.sql` 锚点
- 每个 PR ≤ 300 行，具备回滚说明；核心/迁移/接口变更需 CODEOWNERS 审核
- CI"快车道"：非关键路径改动跳过重度校验；关键路径严格校验但软失败不阻断主线发布

## 二、现状快照（核验结论）

### 已在 main
- **视图**：GalleryView.vue、FormView.vue 与迁移 037_add_gallery_form_support.sql、043_core_model_views.sql
- **数据源**：040_data_sources.sql（基础模型）；外部模型（见 044 文档引用）
- **CI/观测**：observability-strict.yml、migration-replay.yml、monitoring-alert.yml（main 软失败）、weekly-trend-summary.yml、publish-openapi-pages.yml

### 分支独有/待合并
- **ViewService 服务层**：ViewService.ts、view-service.ts、routes/views.ts、038_add_view_query_indexes.sql（PR #155/#158）
- **数据物化**：DataMaterializationService.ts（950 行）、routes/materialization.ts、048_data_materialization_tables.sql（PR #137）
- **工作流设计器**：Vue Flow 组件、routes/workflows.ts（PR #136）
- **看板 API**：后端接口与增强组件（feat/kanban-backend-api）

### 测试分支
- 多个 test/* 用于触发/验证；能力已由 main 的工作流覆盖，可关闭归档

## 三、架构落地蓝图（v2 对齐）

### 核心（packages/core-backend）
- **基座**：HTTP/路由、PluginContext（db/logger/config/eventBus/metrics/auth/audit）、统一配置与密钥、RBAC、审计与指标、Postgres 存储
- **数据访问**：引入 Kysely/Knex 作为查询层；迁移保持 SQL

### 插件（plugins/*）
- **视图插件**：view-kanban/view-calendar/view-gallery/view-form（Baserow 思路）
- **工作流/审批**：workflow-engine（DAG/BPMN）、approval-actions
- **数据源**：datasource-postgres/mysql/http（NocoDB 思路）
- **审计**：audit-trail（统一写 operation_audit_logs/workflow_audit_logs）
- **脚本**：script-runner（JS 沙箱 + 队列；Python Worker 可选）

### 数据库（Postgres）
- **视图**：views、view_states（已落）；新增 045_view_query_indexes.sql
- **工作流**：新增 046_workflow_core.sql（definitions/instances/tokens/incidents）、047_workflow_audit.sql
- **数据源**：040_data_sources.sql 已落；048_data_materialization_tables.sql（可选）

### 前端（apps/web）
- 视图切换器（Grid/Kanban/Calendar/Gallery/Form）绑定 tables/views/view_states
- 工作流设计器（n8n 风格），保存到 workflow_definitions(bpmn_json/dag_json)

## 四、合并路线图（分阶段）

### P0（本周）核心基座与清理
1. **合并并统一 ViewService**（PR #155 为主，吸收 #158 差异）
   - 仅保留 packages/core-backend/src/services/ViewService.ts
   - 路由统一 packages/core-backend/src/routes/views.ts
   - 新增 045_view_query_indexes.sql（替代 038，避免破坏锚点 043）
   - 加 RBAC 与 metrics 钩子；回归五类视图

2. **建立 feat/core-backend-v2**
   - 抽出 PluginContext、EventBus、统一配置/密钥/RBAC/审计/指标门面

3. **建立 feat/plugin-framework-v2**
   - 增强 plugin-template，加入 manifest/capabilities/PluginLoader（fail-open + 审计）

4. **清理测试分支**（关闭 PR，迁移报告到 docs/）
   - test/verify-pr-comment、verify-rbac-improvements、final-strict-verification、v2-strict-workflow 等

### P1（1–2 周）插件化与工作流模型
1. **数据物化插件"壳"合入**（PR #137 拆分）
   - 新建 plugins/datasource-materialization：接口 + routes/materialization.ts 占位
   - 迁移 048_data_materialization_tables.sql；特性开关 MATERIALIZATION_ENABLED
   - DataSourceManager 仅合非破坏性增强

2. **视图插件化**（渐进）
   - 新建 feat/plugin-view-kanban、feat/plugin-view-gallery、feat/plugin-view-form、feat/plugin-view-calendar
   - 插件包含 manifest.json、前端组件（Vue3）、可选后端子路由、迁移片段（必要）

3. **工作流 DB 迁移**
   - 落地 046/047 与后端最小 API（definitions/instances/tokens/incidents 查询）

### P2（2–4 周）执行引擎与脚本
1. **feat/workflow-engine-v2**
   - 按 DAG/BPMN 核心节点最小集起步
   - 所有节点事件写入 audit/incidents
   - 支持重试/补偿

2. **feat/script-runner 插件壳**
   - JS 沙箱 + 队列接口，审计执行
   - Python Worker 预留

3. **datasource-* 插件**
   - 统一 introspectSchema()/CRUD/queryBuilder

## 五、分支处置与重命名

### 保留并增强
- `fix/infra-admin-observability-rbac-cache` → 重命名为 `feat/core-backend-v2`
- `feat/plugin-template` → `feat/plugin-framework-v2`（增强 manifest/capabilities/loader）
- `feat/data-source-adapters` → 保留，先并入统一接口与基础增强；物化拆到插件
- `feat/workflow-designer`（与 workflow-persistence）→ 与 046/047 配套合入

### 拆分/新建
- 新建：feat/plugin-view-kanban、feat/plugin-view-gallery、feat/plugin-view-form、feat/plugin-view-calendar
- 新建：feat/workflow-engine-v2、feat/script-runner、feat/audit-trail-plugin、feat/db-schema-v2

### 关闭/删除（经评估）
- 测试分支：test/verify-pr-comment、verify-rbac-improvements、final-strict-verification、v2-strict-workflow…
- 过时发布：v2-stabilize、release-*（保留 tag 即可）

## 六、数据库迁移计划

### 锚点
- 043_core_model_views.sql（不变）

### 新增迁移
- 045_view_query_indexes.sql（视图索引）
- 046_workflow_core.sql（definitions/instances/tokens/incidents）
- 047_workflow_audit.sql
- 048_data_materialization_tables.sql（可选）

### 审核要求
- 严格 idempotent；重跑安全
- 在 CI 的 integration-lints 中硬检查链条与 include

## 七、CI/观测与门禁

### 检查策略
- **必需检查**：integration-lints / lints（已修复 + 路径快车道）
- **软失败**：monitoring-alert.yml 在 main
- **联动**：update-branch-on-label → 自动触发 lints（chain 工作流已上线）
- **PR 标签驱动**：auto-merge、update-branch；依赖/CI/文档类默认开启自动合并
- **缓存/策略卡顿**：允许"短暂放宽 → 合并 → 立即恢复"仅对安全类 PR

## 八、所有权与审核

### CODEOWNERS（建议）
- core-backend：平台/后端负责人
- migrations：DB 负责人 + 平台
- plugins：各插件 owner + 平台
- apps/web：前端负责人

### 审核要求
- 核心/迁移/接口变更需 1–2 名 CODEOWNERS 审核
- 其余按常规评审

## 九、回滚与风险

### 风险管理
- 每 PR 提供影响评估、手动验证与回滚说明（revert/关闭开关/降级路径）
- 开关策略：新能力 behind feature flag（env/vars）；灰度后再默认启用
- 监控：Prometheus 指标（工作流、队列、数据库）、OpenTelemetry（可选）、结构化日志

## 十、执行排期（建议）

### 本周（P0）
- 合并 ViewService（#155 主 + #158 差异），推 045_view_query_indexes.sql
- 建立 feat/core-backend-v2、feat/plugin-framework-v2
- 关闭过时 test/* PR

### 1–2 周（P1）
- 合并数据物化插件壳
- 视图插件化 2–3 个
- 落地工作流 046/047 与最小 API

### 2–4 周（P2）
- workflow-engine-v2 MVP
- script-runner 插件壳
- audit-trail 插件
- datasource-* 插件统一抽象接口

---

## 相关文档

- [V2 实施总览](./V2_IMPLEMENTATION_SUMMARY.md)
- [V2 执行手册](./V2_EXECUTION_HANDBOOK.md)
- [V2 迁移跟踪器](./v2-migration-tracker.md)
- [方案评审意见](./v2-merge-adjustment-plan-review.md)
- [回滚预案模板](./rollback-procedures/viewservice-unification.md)