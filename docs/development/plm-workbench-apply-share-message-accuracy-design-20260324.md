# PLM Workbench Apply And Share Message Accuracy Design

Date: 2026-03-24

## Problem

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 之前已经对 `apply` 和 `share` 做了真实的 handler gating，但错误提示仍把不同失败原因混在一起：

- `applyTeamView()` 只要 `canApplyPlmCollaborativeEntry(...) === false`，一律提示“请先恢复...再执行应用”
- `shareTeamView()` 只要 `canShareTeamView.value === false`，一律提示“仅创建者可分享...”

这会把两类不同情形混淆：

- 视图确实是 archived
- 视图未归档，但 `permissions.canApply` / `permissions.canShare` 显式禁止动作

结果是用户会拿到误导性的指导文案。

## Design

### 1. apply 区分 archived 与 permission denial

`applyTeamView()` 现在分成两条提示：

- `view.isArchived === true` 时，保留原提示：
  - `请先恢复{label}团队视角，再执行应用。`
- 否则使用更准确的：
  - `当前{label}团队视角不可应用。`

### 2. share 区分 ownership denial 与 explicit canShare denial

`shareTeamView()` 继续先处理 archived 路径。

进入 `!canShareTeamView.value` 分支后，再看 coarse manageability：

- `canManageSelectedTeamView.value === false` 时，保留原提示：
  - `仅创建者可分享{label}团队视角。`
- `canManageSelectedTeamView.value === true` 时，改成：
  - `当前{label}团队视角不可分享。`

这样可以覆盖“当前用户仍是 canonical manager，但后端显式禁止分享”的场景。

### 3. 不改变权限判定，只修正文案语义

这轮不修改：

- `canApplyPlmCollaborativeEntry(...)`
- `canShareTeamView`
- UI disabled 合同

只让 handler 在相同 gating 结果下给出更准确的失败原因。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮锁住：

- `permissions.canApply = false` 但 view 未归档时，`apply` 返回“当前不可应用”
- `permissions.canShare = false` 且 `permissions.canManage = true` 时，`share` 返回“当前不可分享”
- 原有 readonly/非 owner 的“仅创建者可分享”合同继续保留

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 apply/share 的权限来源
- 不改 archived 路径的现有提示
- 不修改 duplicate 或其他 management action 的提示文案
