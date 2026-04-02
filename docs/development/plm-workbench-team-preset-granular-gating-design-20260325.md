# PLM Workbench Team Preset Granular Gating Design

## 背景

[usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 已经通过 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 计算出：

- `canApply`
- `canDuplicate`
- `canShare`
- `canDelete`
- `canArchive`
- `canRestore`
- `canRename`
- `canTransfer`
- `canSetDefault`
- `canClearDefault`

这些值已经被 UI 用来控制按钮可用性。

## 问题

但 preset handlers 自己仍在读旧的粗粒度条件：

- `preset.canManage`
- `preset.isArchived`

这会导致一个典型旁路：

1. UI 按 granular permission 正确把按钮禁掉
2. handler 里却只看 `canManage`
3. 只要直接调用 handler，就还能继续打到 API

这和已经收口过的 `team views` management contract 不一致。

## 设计

把 team preset handlers 全部拉回 granular permission 合同：

1. `applyTeamPreset()` 走 `canApplyTeamPreset`
2. `shareTeamPreset()` 走 `canShareTeamPreset`
3. `duplicateTeamPreset()` 走 `canDuplicateTeamPreset`
4. `renameTeamPreset()` 走 `canRenameTeamPreset`
5. `transferTeamPreset()` 走 `canTransferTarget`
6. `delete/archive/restore/set-default/clear-default` 分别走各自的 `canX`

同时把失败提示改成 action-accurate 文案，例如：

- `当前BOM团队预设不可删除。`
- `当前Where-Used团队预设不可恢复。`

而不是继续笼统报“仅创建者可…”。

## 结果

- preset handler 不再绕过 UI 上已经生效的 granular permission
- archived / readonly / partially-managed preset 的行为和 team views 对齐
- team preset actionability 合同重新统一到一个来源
