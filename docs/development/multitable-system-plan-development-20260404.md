# 多维表系统计划开发报告（2026-04-04）

## 结论

本工作树已经完成《多维表系统计划（采纳 Claude 反馈后的修正版）》的实现收口。`Slice 1` 到 `Slice 6` 的运行时代码、协议、前后端交互、试点脚本和 on-prem 交付链都已经落地；本轮最后收口的是一组已经滞后的 backend integration tests，使 `pnpm verify:multitable-pilot:ready:local` 可以完整通过。

## 实现范围

### Slice 1 / Slice 2 基线

本工作树在本轮开始前已经包含以下基线实现：

- multitable 附件展示与表单/记录抽屉联动
- `commentsScope` 贯穿 `record-context` / `form-context` / submit / patch 响应
- people 字段准备链：`person-fields/prepare` + 隐藏系统 people sheet
- 导入闭环：草稿恢复、people/link 手工修复、duplicate skip
- comments 后端扩展：显式 `mentions`、`inbox`、`unread-count`、`mark read`

## 本工作树完成的计划项

### Slice 1：附件 UX + commentsScope 第一阶段

- multitable 各视图附件交互统一到当前工作台体系，相关前端落点集中在：
  - [MultitableWorkbench.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/views/MultitableWorkbench.vue)
  - [MetaFormView.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaFormView.vue)
  - [MetaGridTable.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaGridTable.vue)
  - [MetaRecordDrawer.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaRecordDrawer.vue)
- 前端评论入口改为优先消费后端返回的 `commentsScope`，而不是只依赖前端手拼 sheet/record 组合。

### Slice 2：people/import + comments mentions/inbox backend

- import 草稿持久化与 duplicate skip 已落地：
  - [MetaImportModal.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaImportModal.vue)
  - [bulk-import.ts](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/import/bulk-import.ts)
- comments API 扩展为支持显式 `mentions` 和 inbox/unread：
  - [comments.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/routes/comments.ts)
  - [CommentService.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/services/CommentService.ts)
  - [identifiers.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/di/identifiers.ts)
- 评论已读状态存储迁移已加入：
  - [zzzz20260404121000_create_meta_comment_reads.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260404121000_create_meta_comment_reads.ts)

### Slice 3：视图一致性 + mention composer + inbox 前端

- 轻量评论输入器、收件箱 store / 页面、前端实时评论订阅已落地：
  - [MetaCommentComposer.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaCommentComposer.vue)
  - [MetaCommentsDrawer.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/components/MetaCommentsDrawer.vue)
  - [useMultitableCommentInbox.ts](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/composables/useMultitableCommentInbox.ts)
  - [useMultitableCommentRealtime.ts](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/multitable/composables/useMultitableCommentRealtime.ts)
  - [MultitableCommentInboxView.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/views/MultitableCommentInboxView.vue)
- legacy `/api/views/:viewId/*` 与 `/api/multitable/*` 的兼容矩阵已补：
  - [multitable-views-bridge-matrix-20260404.md](/tmp/metasheet2-multitable-plan-mORTqT/docs/development/multitable-views-bridge-matrix-20260404.md)

### Slice 4：smoke / on-prem / jump / realtime / orphan cleanup

- comments realtime 继续复用现有协作基础设施，无另起 websocket 栈：
  - [index.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/index.ts)
  - [univer-meta.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/routes/univer-meta.ts)
- multitable 孤儿附件清理已落地：
  - [attachment-orphan-retention.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/multitable/attachment-orphan-retention.ts)

### Slice 5：scoped permissions

- 当前 coarse-grained `MetaCapabilities` 仍保留，同时叠加字段、视图、记录动作级权限：
  - [univer-meta.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/routes/univer-meta.ts)
  - `fieldPermissions`
  - `viewPermissions`
  - `rowActions`

### Slice 6：automation 入口与 workflow designer 契约整理

- workflow-designer / automation 契约已经在本工作树统一，相关主落点为：
  - [WorkflowDesigner.vue](/tmp/metasheet2-multitable-plan-mORTqT/apps/web/src/views/WorkflowDesigner.vue)
  - [workflow-designer.yml](/tmp/metasheet2-multitable-plan-mORTqT/packages/openapi/src/paths/workflow-designer.yml)
  - [base.yml](/tmp/metasheet2-multitable-plan-mORTqT/packages/openapi/src/base.yml)

## 关键运行时修复

### canonical `/api/multitable` 挂载

- 后端已明确挂载 `univerMetaRouter()` 到 canonical 路径：
  - [index.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/index.ts)
- `/api/univer-meta` 仅保留为非生产兼容别名。

### 历史 DB drift 修复

本工作树恢复了此前缺失的 multitable / comments / permissions 迁移，并新增两条 repair migration，用于修正本地历史库漂移：

- 恢复的历史迁移：
  - [zzzz20260318123000_formalize_meta_comments.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260318123000_formalize_meta_comments.ts)
  - [zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.ts)
  - [zzzz20260320163000_add_comment_permissions.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260320163000_add_comment_permissions.ts)
  - [zzzz20260321124000_add_meta_view_config.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260321124000_add_meta_view_config.ts)
- 新增 repair migration：
  - [zzzz20260404153000_repair_meta_core_schema.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260404153000_repair_meta_core_schema.ts)
  - [zzzz20260404154500_repair_multitable_attachments_schema.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/src/db/migrations/zzzz20260404154500_repair_multitable_attachments_schema.ts)

新增这两条 repair migration 的原因是：本地历史数据库在此前缺迁移和表结构漂移后，无法稳定通过 multitable smoke / on-prem gate，需要用幂等修复迁移把 `meta_*` 与 `multitable_attachments` 相关结构重新对齐。

### comments integration test 隔离修复

- [comments.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/comments.api.test.ts) 曾错误地对共享 dev DB 做 destructive table drop。
- 当前已改为只做加法建表与测试数据清理，不再破坏 `meta_*` 主表。
- 这是本轮能够稳定跑通本地 readiness gate 的必要修复之一。

## 本轮最终收口

本轮最后处理的不是主运行时代码，而是两组已经滞后的 backend integration tests：

- [multitable-context.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/multitable-context.api.test.ts)
  - 补齐了 `context` 路由现在会触发的 `meta_fields` 查询 mock。
- [multitable-record-form.api.test.ts](/tmp/metasheet2-multitable-plan-mORTqT/packages/core-backend/tests/integration/multitable-record-form.api.test.ts)
  - 把 `commentsScope` 断言升级为与当前扩展结构一致。

这一步完成后，`pnpm verify:multitable-pilot:ready:local` 已完整通过，意味着当前计划在本工作树上的实现与本地收口门禁已经闭环。
