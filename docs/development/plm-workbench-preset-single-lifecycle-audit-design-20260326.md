# PLM Workbench Preset Single Lifecycle Audit Design

## 背景

`team view` 的 single `archive / restore / delete` 已经会写 unified lifecycle audit，但 `team preset` 目前只有 batch lifecycle 会写 `plm-team-preset-batch` 审计。

## 问题

- single preset `archive`
  - 不写审计
- single preset `restore`
  - 不写审计
- single preset `delete`
  - 不写审计
  - 同时 lookup 还缺少 `tenant_id` 和 `scope = team`

## 设计决策

- 让 single preset lifecycle 和 single team view lifecycle 对齐
- 继续复用现有 `plm-team-preset-batch` resource type
- 不新造 resource type，避免拉宽 audit 面板合同
- delete route 同时补上 tenant/team scoped lookup

## 实现

- 在 `packages/core-backend/src/routes/plm-workbench.ts`
  - 新增 `logPlmTeamPresetLifecycleAudit(...)`
  - `archive / restore / delete` 成功后统一写单条 lifecycle audit
  - `DELETE /api/plm-workbench/filter-presets/team/:id` lookup 增加
    - `tenant_id`
    - `scope = team`

## 预期结果

- single preset lifecycle 不再掉出审计面板
- preset 和 team view 的 lifecycle audit 语义一致
- preset delete route 不再是裸 `id` 命中
