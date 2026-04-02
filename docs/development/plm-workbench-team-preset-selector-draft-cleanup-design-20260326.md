# PLM Workbench Team Preset Selector Draft Cleanup Design

## 背景
- `team views` 已经有 selector-change cleanup：切换 `teamViewKey` 时，会清掉 stale `name/owner` draft。
- `team filter presets` 之前没有对应 watcher。
- 结果是用户把 selector 从 preset A 切到 preset B 时，旧的：
  - `teamPresetName`
  - `teamPresetGroup`
  - `teamPresetOwnerUserId`
  会继续挂到新 target 上。

## 问题
- `rename` 草稿会错误附着到新 preset。
- `save/duplicate` 相关的 group draft 会错误继续显示。
- `transfer-owner` 输入会把旧 owner draft 带到新 preset。

## 目标
- 把 `team filter presets` 的 selector-change 语义拉齐到 `team views`。
- 只在 `teamPresetKey` 真正变化时清掉 drafts，不影响 key 不变时的正常编辑。

## 方案
- 在 [`usePlmTeamFilterPresets.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 中新增 `watch(teamPresetKey, ...)`。
- 当 `next !== previous` 时：
  - `teamPresetName.value = ''`
  - `teamPresetGroup.value = ''`
  - `teamPresetOwnerUserId.value = ''`
- `flush: 'sync'`，保证 selector 切换的同一帧里就把 drafts 归零，不让下游按钮/输入读到 stale 值。

## 不变项
- create-mode drafts 在 `teamPresetKey === ''` 且 key 未变化时继续保留。
- duplicate/rename/restore/save 流程里，后续显式写入的新值仍然覆盖 watcher 清理结果。
