# PLM Workbench Transfer Target Gating Design

## 背景

`usePlmCollaborativePermissions.ts` 已经把 transfer 语义拆成两层：

- `canTransferTarget`：当前 target 是否允许转移
- `canTransfer`：在 target 可转移的前提下，当前 owner 草稿是否可提交

但 workbench team-view 链路只透传了 `canTransfer`。这会导致 owner input 的 disabled 状态被错误绑定到“提交是否就绪”，而不是“target 是否可编辑”。

## 问题

典型异常场景：

1. 选中一条已归档或 `permissions.canTransfer = false` 的团队视角
2. `transfer` 按钮保持禁用，但 owner input 仍可输入

这会让 UI actionability 和 target 级权限语义脱节。

## 设计

把 `canTransferTarget` 作为 shared contract 从 `usePlmTeamViews.ts` 透传到 team-view block：

1. `usePlmTeamViews.ts`
   - 暴露 `canTransferTargetTeamView`
2. `PlmProductView.vue`
   - workbench/documents/cad/approvals 四条 team-view 链都透传该 computed
3. `plmPanelModels.ts` / `usePlmProductPanel.ts`
   - 增加对应 panel model 字段
4. `PlmTeamViewsBlock.vue`
   - owner input 的 disabled 改为基于 `canTransferTarget`
   - transfer 按钮继续基于 `canTransfer`

## 结果

- target 不可转移时，owner input 直接禁用
- target 可转移但草稿未完成时，owner input 可编辑、提交按钮仍禁用
- workbench/documents/cad/approvals 四条 team-view 面板共享同一语义，不再各自漂移
