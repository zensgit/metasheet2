# PLM Workbench Local Preset Import Recheck Design

## Background

本地 `BOM / Where-Used` preset 支持“按 label 合并导入”。当用户通过分享链接或 JSON 导入一个同名 preset 时，系统会原地更新该 preset 的 `field/value`，并保留原 `key`。

旧问题在于 route-owner watcher 只依赖：

- `routePresetKey`
- `selectedPresetKey`
- `activePreset.key`

如果导入后 `key` 没变、但 `field/value` 变了，watcher 不会重新运行，旧的 `bomFilterPreset / whereUsedFilterPreset` route owner 也不会被重新判定为 stale。

## Target

把本地 preset route-owner watcher 的依赖从“只看 key”升级成“看 route-owner snapshot”：

1. same-key import update 发生后，只要 `field/value` 变了，watcher 必须重新运行。
2. 重新运行后继续复用现有 `resolvePlmLocalFilterPresetRouteIdentity(...)` 判定。
3. 不改变已有的 selector/draft cleanup 语义，只补 watcher 触发条件。

## Design

### 1. 新增 route-owner watch key helper

在 [plmLocalFilterPresetRouteIdentity.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmLocalFilterPresetRouteIdentity.ts) 新增：

- `buildPlmLocalFilterPresetRouteOwnerWatchKey(...)`

它会把：

- `preset.key`
- `pickPlmTeamFilterPresetRouteOwnerState(preset)` 里的 `field/value`

一起序列化成稳定 watch key。

### 2. 视图 watcher 改为依赖 snapshot key

在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的两组 watcher 中，把：

- `activeBomLocalRoutePreset.value?.key`
- `activeWhereUsedLocalRoutePreset.value?.key`

改成：

- `buildPlmLocalFilterPresetRouteOwnerWatchKey(activeBomLocalRoutePreset.value)`
- `buildPlmLocalFilterPresetRouteOwnerWatchKey(activeWhereUsedLocalRoutePreset.value)`

这样同 key 但 state 变化时，watcher 也会重新触发并清理 stale route owner。

## Non-goals

- 不改变 preset 导入本身的 merge-by-label 行为
- 不改变 route owner stale 判定规则
- 不改变本地 preset selector / draft 的 handoff 合同
