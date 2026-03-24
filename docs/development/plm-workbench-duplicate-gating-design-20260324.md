# PLM Workbench Duplicate Gating Design

Date: 2026-03-24

## Problem

[PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的 `复制副本` 按钮已经按 `canDuplicate` 禁用：

- `:disabled="!(canDuplicate?.value ?? false) || loading.value"`

但 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里的 `duplicateTeamView()` 之前只有“是否选中了视图”的检查，没有再校验 `canDuplicateTeamView.value`。

结果是：

- UI 层认为这条 team view 不可复制
- handler 仍能直接调用 duplicate API
- 出现与之前 `apply/share` 同型的 permission-bypass handler 漏口

## Design

### 1. duplicate handler 补 defensive gate

`duplicateTeamView()` 在拿到 `selectedTeamView` 之后，新增：

- `if (!canDuplicateTeamView.value) { ... return }`

错误提示统一为：

- `当前{label}团队视角不可复制。`

### 2. 不改 duplicate 权限合同

这轮不改变 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 里 `canDuplicate` 的推导规则。

也就是说：

- 哪些视图“应该允许复制”，继续由现有 `permissions.canDuplicate` / legacy fallback 决定
- 这轮只让 handler 和现有 UI gating 对齐

### 3. focused regression 锁住只读旁路

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 新增 focused regression：

- 当前 workbench team view 显式给出 `permissions.canDuplicate = false`
- 调用 `duplicateTeamView()`
- duplicate API 不会被调用
- 页面收到 `当前工作台团队视角不可复制。`

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 `canDuplicate` 的权限来源
- 不改变 duplicate 成功后的 route / selection / focus 行为
- 不新增新的 duplicate notice 或 followup 交互
