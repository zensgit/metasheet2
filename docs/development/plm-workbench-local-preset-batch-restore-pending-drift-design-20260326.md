# PLM Workbench Local Preset Batch Restore Pending Drift Design

## 背景

`BOM / Where-Used` 页面允许本地 preset 和团队 preset 共存。此前已经有一层保护：当 canonical route owner 还是团队 preset `A`，本地 selector 只是 pending 到已归档的团队 preset `B` 时，batch `restore B` 不会劫持 `requestedPresetId`。

但还有一条对称漏口：

1. 当前 live filter 实际仍由本地 preset owner 驱动。
2. 用户在团队 preset selector 里选中了已归档的 `B`，形成 pending drift。
3. 执行 batch `restore B`。
4. `usePlmTeamFilterPresets.ts` 会直接 `applyPresetToTarget(restored)`。
5. 页面 wrapper 再基于动作后的 `teamPresetKey/query` 判定“restore 已 takeover”，把本地 preset owner 清掉。

结果是一个本应只是“解归档”的 batch restore，会错误升级成团队 preset takeover。

## 设计目标

1. batch `restore` 只有在 restore 之前就已经由团队 preset canonical owner 驱动时，才允许 reapply。
2. 如果 restore 之前 live filter 仍由本地 preset owner 驱动，restore 只能更新团队 preset 生命周期和清理草稿，不能偷偷接管当前过滤状态。
3. 本地 owner cleanup 必须基于动作前状态判定，而不是动作后被 restore 改写过的 selector/query。

## 方案

### 1. restore 分支识别动作前的 external owner drift

在 `usePlmTeamFilterPresets.ts` 的 `runBatchTeamPresetAction('restore')` 中，先捕获：

- `selectedIdBeforeAction`
- `requestedPresetIdBeforeAction`
- `hadExternalOwnerDriftBeforeAction`

当 restore 命中的 target 存在且 `hadExternalOwnerDriftBeforeAction === true` 时：

- 不调用 `applyPresetToTarget(restored)`
- 仅保留 selector、更新列表项、清理 `name/group/owner` 草稿

这样 restore 不会把本地 owner 直接改写成团队 preset owner。

### 2. 页面 wrapper 按动作前 owner 判定是否 clear local owner

在 `PlmProductView.vue` 的：

- `restoreBomTeamPresetSelection()`
- `restoreWhereUsedTeamPresetSelection()`

中，先捕获动作前的：

- `hadLocalOwnerBeforeAction`
- `activeTeamPresetIdBeforeAction`
- `requestedTeamPresetIdBeforeAction`

再把这些值传给 `shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(...)`。helper 只在以下条件全部满足时返回 `true`：

1. restore 前没有本地 preset owner
2. restore 命中了动作前 active team preset
3. 如果动作前存在 requested team preset owner，它也在 processedIds 中

这样本地 owner cleanup 就和 restore 前的 canonical ownership 对齐，而不是被动作后 selector 假象带偏。

## 结果

修复后，batch restore 会分成两种清晰语义：

- 团队 preset 已经是 canonical owner：允许 reapply surviving preset，并可 clear local owner
- 本地 preset 仍是 canonical owner：只解归档，不接管，不 clear local owner
