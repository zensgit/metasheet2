# PLM Workbench Local Preset Import Reconcile Design

## 背景

`BOM / Where-Used` 的本地过滤预设允许通过分享链接和 JSON 批量导入。导入逻辑会按 `label` 合并：

- 同名 preset 会被就地更新
- `key` 保持不变

这会留下一个 route-owner 漏口：

1. 当前 URL 由本地 preset owner 持有，例如 `bomFilterPreset=bom:shared`。
2. 用户导入一个同名 preset，但 `field/value` 已经变化。
3. 导入后 preset 还是原来的 key，route owner 不会因为 “key 改变” 被清掉。
4. 实际过滤状态仍是旧值，URL 却继续声称当前由新 snapshot 的 preset owner 持有。

后续 refresh / hydration / share 会把这条 stale local owner 继续带下去。

## 设计目标

1. 同 key in-place 更新后，如果当前 live filter 不再匹配 preset snapshot，必须清掉 stale route owner。
2. 这条清理不能顺手把用户刚导入的 preset 选择一起抹掉。
3. 现有 watcher 的“手工编辑导致 stale owner 时清 selector”语义保持不变。

## 方案

### 1. 扩展 local route-identity helper

在 `plmLocalFilterPresetRouteIdentity.ts` 给 `resolvePlmLocalFilterPresetRouteIdentity(...)` 增加：

- `preserveSelectedPresetKeyOnClear?: boolean`

默认行为保持原样：

- stale route owner 且 selector 仍跟着旧 owner 时，一起清 route owner 和 selector

但 import 场景可显式要求：

- 只清 route owner
- 保留当前 selector key

### 2. 在导入路径显式 reconcile

`PlmProductView.vue` 的这四条导入路径在合并 preset 后，统一补一轮 reconcile：

- `importBomFilterPresetShare(...)`
- `importWhereUsedFilterPresetShare(...)`
- `importBomFilterPresetsFromText(...)`
- `importWhereUsedFilterPresetsFromText(...)`

它们会基于：

- `routePresetKey`
- 当前 `selectedPresetKey`
- 当前 live filter state
- 更新后的 active preset snapshot

判断 route owner 是否失效；若失效则清 `bomFilterPreset / whereUsedFilterPreset` query，但保留当前 selector 作为 pending target。

## 结果

修复后，同名 preset in-place 更新会满足更准确的语义：

- URL 只表达仍然匹配当前 live filter 的 local owner
- 导入动作选中的新 preset 仍留在 selector，用户可继续 `Apply`
- 旧 watcher 的手工 drift 清理合同不变
