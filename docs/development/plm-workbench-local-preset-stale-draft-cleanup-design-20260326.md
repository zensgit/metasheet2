# PLM Workbench Local Preset Stale Draft Cleanup Design

## Background

`BOM / Where-Used` 本地 filter preset 的 route owner 在 drift 后会被 watcher 清掉，但旧实现只清：

- `preset key`
- `route query owner`

不会同步清：

- `name` draft
- `group` draft

结果是旧 preset 的管理草稿会继续留在页面上，后续新建、重命名或切到别的 pending preset 时会串味。

## Target

把本地 preset stale-owner cleanup 收紧成这套合同：

1. 如果 stale route owner 同时还是当前 selector owner，那么清 route owner 时也清 `name/group` 草稿。
2. 如果用户已经切到另一个 pending selector target，只清旧 route owner，保留该 pending target 的 `name/group` 草稿。
3. 显式 `clearBomLocalFilterPresetIdentity()` / `clearWhereUsedLocalFilterPresetIdentity()` 也要清掉对应草稿，避免 local owner handoff 后留下旧输入。

## Design

### 1. 扩展 pure helper

在 [plmLocalFilterPresetRouteIdentity.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmLocalFilterPresetRouteIdentity.ts) 的
`resolvePlmLocalFilterPresetRouteIdentity(...)` 里直接返回：

- `nextNameDraft`
- `nextGroupDraft`

规则：

- `shouldClear = false` 时，原样保留 drafts
- `shouldClear = true` 且 `nextSelectedPresetKey` 为空时，清空 drafts
- `shouldClear = true` 但 `nextSelectedPresetKey` 仍存在时，保留 drafts

这样 watcher 不需要自行推断“草稿该不该清”，而是完全服从 pure helper。

### 2. 视图 watcher 对齐 helper 结果

在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的两组 watcher 中：

- BOM local route owner watcher
- Where-Used local route owner watcher

除了更新 `nextSelectedPresetKey / nextRoutePresetKey` 之外，也同步应用：

- `nextNameDraft`
- `nextGroupDraft`

### 3. 显式 local owner clear 语义收口

`clearBomLocalFilterPresetIdentity()` 与 `clearWhereUsedLocalFilterPresetIdentity()` 现在一起清：

- preset key
- route query owner
- preset name draft
- preset group draft

这样本地 owner 被 handoff 给 team preset / team default 时，不会再残留旧草稿。

## Non-goals

- 不改变 `field/value` 的 drift 判定本身
- 不改变 pending selector 的保留策略
- 不改变 team preset owner 或 route owner 的其它 takeover 合同
