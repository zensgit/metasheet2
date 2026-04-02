# PLM Workbench Pending-Apply Management Gating Design

Date: 2026-03-25

## Problem

在 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 里，`Team views` selector 和 `Apply` 是两步：

- selector 直接改 `teamViewKey.value`
- `Apply` 才会真正调用 `applyView()`，并把 canonical `requestedViewId` / query 同步过去

但 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 之前把 generic 管理动作直接绑到了瞬时的 `selectedTeamView`：

- `shareTeamView()`
- `renameTeamView()`
- `deleteTeamView()`
- `archiveTeamView()`
- `restoreTeamView()`
- `duplicateTeamView()`
- `transferTeamView()`
- `setTeamViewDefault()`
- `clearTeamViewDefault()`

结果是：

1. 当前已应用的是 `A`
2. 用户在 selector 里切到 `B`
3. 还没点 `Apply`
4. generic 管理动作已经提前命中 `B`

这会让“当前页面仍显示 A 的状态，但管理动作已经在改 B”。

## Design

### 1. 显式识别 pending-apply selector drift

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里新增：

- `requestedTeamView`
- `hasPendingApplySelection`

判定条件是：

- route / canonical `requestedViewId` 仍指向已应用 target
- 本地 `teamViewKey` 已经切到另一个 selector target

### 2. generic 管理动作在 drift 期间冻结

这轮不改 `Apply` 语义，也不把 selector 自动同步回 route。只收口 generic 管理动作：

- 在 drift 期间，`selectedManagementTarget = null`
- 权限计算继续通过 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 走同一套 disabled 合同
- handler 再补一层 defensive gate，统一提示：
  - `请先应用工作台团队视角，再执行管理操作。`

这样：

- `Apply` 仍然 selector-first
- `Save to team` 仍然允许基于当前 state 新建
- 只有 generic 管理动作会被 pending-apply drift 暂停

### 3. 为什么不直接改成 selector-target 管理

这轮不再让 generic 管理动作继续跟 selector 的瞬时值跑。原因是：

- route query 里的 `requestedViewId` 仍是 canonical/applied target
- 页面主 state 仍是已应用视图的 state
- 如果管理动作先切到新 selector target，会产生“页面看的是 A，动作改的是 B”的错位

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 新增 focused regression：

- 先通过 `requestedViewId` 应用 `workbench-applied`
- 再只改 selector 到 `workbench-pending`
- 不点 `Apply`
- 断言：
  - `canShareTeamView / canRenameTeamView / canDeleteTeamView` 都会变成 `false`
  - `shareTeamView()` 不会复制链接
  - `renameTeamView()` 不会命中 rename API
  - 页面收到统一的 “请先应用...” 错误提示

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 selector-first 的 `Apply` 流程
- 不改变 `Save to team` 的 create-mode 语义
- 不改 batch management 的目标解析
