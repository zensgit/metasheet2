# PLM Workbench Local Preset Catalog Draft Cleanup Design

## Background

`BOM / Where-Used` 本地过滤预设的导入与清空流程，会直接替换整个 preset catalog。

在这条链上，页面之前只会清 selector 和 route owner：

- selected local preset 消失时清 `*FilterPresetKey`
- route owner 消失时清 `*FilterPresetQuery`

但与该 preset 绑定的本地管理草稿没有一起处理：

- `*FilterPresetName`
- `*FilterPresetGroup`

## Problem

如果当前选中的本地 preset 已经因为导入替换或清空 catalog 而消失，旧的 rename / regroup 草稿仍会留在输入框里。

这会造成两类错误感知：

- 用户看到的仍像是在编辑一个已经不存在的 preset
- route owner 虽然已经清掉，但 UI 草稿仍保留旧 target 的语义

## Decision

把 catalog refresh 后的 selector / route-owner / draft 清理收口成一个纯 helper：

- surviving selected preset 继续保留草稿
- stale route owner 单独清掉，但不误伤仍然活着的 selected preset 草稿
- selected preset 也失效时，name/group 草稿一起清空

## Implementation

在 `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts` 新增：

- `resolveFilterPresetCatalogDraftState(...)`

并在 `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue` 中复用它处理：

- `importBomFilterPresetsFromText(...)`
- `clearBomFilterPresets()`
- `importWhereUsedFilterPresetsFromText(...)`
- `clearWhereUsedFilterPresets()`

## Expected Outcome

- local preset catalog 被替换后，UI draft 只会跟随仍然有效的 selected preset
- stale route owner 不会继续残留
- 已失效 preset 的 rename/group 草稿不会再挂在页面上
