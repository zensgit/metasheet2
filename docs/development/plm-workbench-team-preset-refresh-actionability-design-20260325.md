# PLM Workbench Team Preset Refresh Actionability Design

## 背景

[usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 的 refresh 流程之前只按 `id` 是否还存在保留：

- `teamPresetKey`
- `requestedPresetId`
- `teamPresetSelection`

## 问题

这会留下两类 stale ownership：

1. preset 还在，但已经 `canApply = false`
   - selector 仍保留旧 id
   - requested preset 也不会被清掉
   - default fallback 也可能被旧 requested id 卡住
2. preset 还在，但已经 `canManage = false`
   - batch selection 仍保留旧 id
   - 页面继续显示它是已选项

这和前面已经收口过的 `team views refresh actionability` 合同不一致。

## 设计

refresh 时把 ownership 分成两条规则：

1. `selector / requested / default takeover` 按 `canApplyPlmCollaborativeEntry(...)` 对齐
2. `batch selection` 按 `readTeamPresetPermissions(...).canManage` 对齐

具体来说：

- `teamPresetKey` 指向的 preset 失去 applyability 时，清掉 selector
- `requestedPresetId` 指向的 preset 失去 applyability 时，清掉 requested identity
- auto-apply requested/default preset 时，也只接受 still-applyable 的目标
- `teamPresetSelection` 里的 preset 失去 manageability 时，refresh 直接裁掉

## 结果

- refresh 后不会再保留 stale preset route owner
- batch selection 和当前 manageability 一致
- requested/default preset takeover 和 team views 的 refresh 语义重新对齐
