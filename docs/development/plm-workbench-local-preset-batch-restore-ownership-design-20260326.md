# PLM Workbench Local Preset Batch Restore Ownership Design

## Background

`BOM / Where-Used` 的本地 preset owner 已经改成按真实 takeover 语义来消费，而不是只看团队 preset action 有没有成功返回。

上一刀已经把 destructive `archive / batch-archive / batch-delete` 收平，但并行扫描发现 batch `restore` 还有一条更细的漏口。

## Problem

`restoreTeamPresetSelection()` 的页面 wrapper 之前只用 `processedIds.length > 0` 决定是否清本地 owner。

但底层 `usePlmTeamFilterPresets.ts` 的 batch restore 并不总会把 restored preset 应用到当前过滤状态：

- 只有当 restored preset 真正变成 active target 时，才会 `applyPresetToTarget(...)`
- 如果只是恢复了 batch selection 里的一项、当前 active/requested target 没接管，这次 restore 只改列表，不会 takeover 当前过滤状态

复现：

1. 当前 `bomFilterPreset` 或 `whereUsedFilterPreset` 由本地 preset route owner 持有。
2. 在团队 preset 列表里勾选一个 archived preset 进行 batch restore，但不把它变成 active `teamPresetKey` / effective requested owner。
3. 执行 batch restore。
4. 旧逻辑看到 `processedIds` 非空，就清掉本地 owner。

结果是当前过滤状态仍然由本地 preset 持有，但 route owner 被错误剥离。

## Design

新增 `shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(...)`：

- 输入：
  - batch restore result
  - 当前 active `teamPresetKey`
  - 当前 requested route owner
- 语义：
  - active target 没进 `processedIds`：不清
  - requested owner 存在但没进 `processedIds`：不清
  - 只有 restored preset 真正成为 active owner 时：才清

页面 wrapper：

- `restoreBomTeamPresetSelection()`
- `restoreWhereUsedTeamPresetSelection()`

统一改用这条 helper，和底层 `runBatchTeamPresetAction('restore')` 的真实 takeover 语义对齐。

## Expected Outcome

- batch restore 只在真正把当前过滤状态切到 restored team preset 时，才消费本地 owner；
- 只改列表、不接管当前状态的 restore，不再误删本地 route owner；
- BOM / Where-Used 两条路径完全一致。
