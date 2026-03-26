# PLM Workbench Local Preset Management Transaction Design

## 背景

`BOM / Where-Used` 页面的本地过滤预设和团队过滤预设共存。页面 wrapper 之前会在执行 `apply / save / duplicate / archive / restore / rename / transfer / set-default / batch lifecycle` 之前，先清掉本地 preset owner：

- `bomFilterPreset`
- `whereUsedFilterPreset`

这套设计在“动作真正成功接管目标”时是合理的，但实现上有一个关键缺口：

- `PlmProductView.vue` 使用 `runPlmLocalPresetOwnershipAction(...)` 只在 `action throw` 时保留 owner
- `usePlmTeamFilterPresets.ts` 里的大多数 action 会吞掉失败并只写 message / error，不会 throw
- 结果是 action 失败或 early-return 时，页面仍会把本地 preset owner 提前清掉

这会导致典型事务错位：

1. 当前仍由本地 preset 驱动 BOM/Where-Used 过滤。
2. 用户选中一个团队 preset，尝试 `rename / transfer / save / set default / batch archive`。
3. 后端失败或 action 被 guard 拦住。
4. 页面提示失败，但本地 preset owner 已经消失。

## 设计目标

1. 本地 preset owner 只能在“团队 preset action 确实完成 takeover”后被消费。
2. 失败、guard 拦截、空 batch、无效 target 都不能提前清 owner。
3. 不改变现有 message / error 语义，也不引入新的页面状态分支。

## 方案

### 1. 让 team preset actions 显式返回事务结果

在 `usePlmTeamFilterPresets.ts` 中，把以下 action 的成功路径改成返回 truthy 结果，失败或 no-op 路径统一返回 `null`：

- `saveTeamPreset()`
- `applyTeamPreset()`
- `duplicateTeamPreset()`
- `renameTeamPreset()`
- `transferTeamPreset()`
- `setTeamPresetDefault()`
- `archiveTeamPreset()`
- `restoreTeamPreset()`
- `runBatchTeamPresetAction()`

这样 page wrapper 不再依赖“是否抛错”来判断事务是否完成，而是直接消费 composable 的 canonical result。

### 2. page wrapper 只在结果有效时清本地 owner

在 `PlmProductView.vue` 中，`BOM / Where-Used` 的以下 wrapper 统一改成：

- 先执行 base action
- 再通过 `runPlmLocalPresetOwnershipAction(...)`
- 使用 `shouldClear: Boolean(result)` 或 `Boolean(result.processedIds.length)`

覆盖的 wrapper 包括：

- `apply*TeamPreset`
- `duplicate*TeamPreset`
- `archive*TeamPreset`
- `restore*TeamPreset`
- `rename*TeamPreset`
- `transfer*TeamPreset`
- `save*TeamPreset`
- `set*TeamPresetDefault`
- `archive*TeamPresetSelection`
- `restore*TeamPresetSelection`
- `delete*TeamPresetSelection`

## 影响

修复后，页面会满足这条事务合同：

- 成功接管到 team preset target：清本地 owner
- guard/失败/no-op：保留本地 owner

这让 `local preset -> team preset management` 的交互和之前已经修过的 `promote/save partial-success` 语义真正闭合。
