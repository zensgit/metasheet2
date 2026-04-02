# PLM Workbench Granular Management Gating Design

Date: 2026-03-24

## Problem

[PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的 generic 管理按钮已经按更细粒度的 computed flags 禁用：

- `canDelete`
- `canArchive`
- `canRestore`
- `canRename`
- `canTransfer`
- `canSetDefault`
- `canClearDefault`

但 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里的对应 handler 之前大多只检查：

- `canManageSelectedTeamView`

结果是：

- UI 已经把某个具体动作禁用了
- handler 仍可能在 direct call / stale callback / future callsite 里绕过 finer-grained permission
- 出现和此前 `apply / duplicate` 同型的 handler gating 漏口

## Design

### 1. 保留 coarse `canManage` 分支

现有“仅创建者可...”分支继续保留，用来处理：

- 当前 view 根本不可管理
- 现有文案和旧测试合同不变

### 2. 每个动作再补自己的 defensive gate

在 coarse `canManage` 通过之后，以下 handler 继续检查自己的 computed flag：

- `deleteTeamView()` -> `canDeleteTeamView`
- `archiveTeamView()` -> `canArchiveTeamView`
- `restoreTeamView()` -> `canRestoreTeamView`
- `renameTeamView()` -> `canRenameTeamView`
- `transferTeamView()` -> `canTransferTeamView`
- `setTeamViewDefault()` -> `canSetTeamViewDefault`
- `clearTeamViewDefault()` -> `canClearTeamViewDefault`

对应的错误提示统一为：

- `当前{label}团队视角不可删除。`
- `当前{label}团队视角不可归档。`
- `当前{label}团队视角不可恢复。`
- `当前{label}团队视角不可重命名。`
- `当前{label}团队视角不可转移所有者。`
- `当前{label}团队视角不可设为默认。`
- `当前{label}团队视角不可取消默认。`

### 3. 与现有 UI disabled 合同对齐

这轮不改变 permission resolver 本身，只让 handler 和现有 UI gating 对齐：

- UI disabled 什么，handler 也必须拒绝
- coarse manageability 和 per-action ability 不再混用

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮新增 focused regression：

- `permissions.canManage = true`
- 但显式关闭 `canDelete / canArchive / canRename / canTransfer / canSetDefault / canClearDefault / canRestore`
- 调用对应 handler
- 所有 API 都不应被触发，并返回对应“当前不可...”提示

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 coarse `canManageSelectedTeamView` 的推导
- 不修改 share handler 的提示文案
- 不改变 batch action 的过滤和处理逻辑
