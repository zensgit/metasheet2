# PLM Workbench Team Preset Single-Action Cleanup Design

## 背景
- `team views` 这条链之前已经收口过 single action takeover/selection cleanup：
  - single `archive/delete/transfer` 会同步清掉 stale batch selection
  - target 被清空时会同步清掉 owner draft residue
- `team filter presets` 仍然落后半拍：
  - single `archiveTeamPreset()` 会把当前 preset 归档并清空 `teamPresetKey`，但不会清掉同 id 的 `teamPresetSelection`
  - single `deleteTeamPreset()` 会移除 preset，但不会清掉同 id selection，也不会清掉 `teamPresetOwnerUserId`
  - single `transferTeamPreset()` 如果把 preset 转成只读，selection 仍然保留

## 问题
- 归档后，UI 可能继续显示“已选 1 项”，但这条 preset 已经不可管理。
- 删除或归档当前 preset 后，`teamPresetOwnerUserId` 仍会保留旧 owner 草稿。
- 转移所有者后，如果当前 preset 不再可管理，batch selection 还会继续把它算作已选项。

## 目标
- 把 `team filter presets` 的 single action cleanup 拉齐到 `team views` 的既有合同。
- 只清理由当前 action 处理过的 target，不误清其它仍有效的 selection/draft。

## 方案
- 在 [`usePlmTeamFilterPresets.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 中补齐 3 处 cleanup：
  - `transferTeamPreset()`
    - 如果保存后的 preset 已失去 `canManage`，从 `teamPresetSelection` 中移除该 id
  - `deleteTeamPreset()`
    - 总是移除同 id 的 `teamPresetSelection`
    - 如果当前 target 就是该 preset，同时清掉 `teamPresetOwnerUserId`
  - `archiveTeamPreset()`
    - 总是移除同 id 的 `teamPresetSelection`
    - 如果当前 target 就是该 preset，同时清掉 `teamPresetOwnerUserId`

## 不变项
- `restoreTeamPreset()` 仍保留当前 explicit target，不做额外 selection 清理。
- 其它未受影响的 preset selection 继续保留。
- create/save 相关草稿合同不变。
