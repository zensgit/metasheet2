# PLM Workbench Local Preset Catalog Management Cleanup Design

## Problem

`BOM / Where-Used` 本地 preset catalog 在 `single delete / batch delete / import / clear / stale route-owner reconcile` 这些路径里，之前只对齐了 selector、route owner、name draft、group draft。

但 batch management state 仍然会残留：

- `selection` 里可能还保留已经被删掉或失效的 preset key
- `batchGroupDraft` 可能继续显示在页面上，尽管已经没有任何有效选中项

这会形成典型的 ownership drift：当前 catalog 和 route owner 都已经切走，页面上的批量管理态却还指向旧 preset。

## Design

- 扩展 `resolveFilterPresetCatalogDraftState(...)`，让它同时负责：
  - 过滤 `selectionKeys`
  - 在没有 surviving selection 时清空 `batchGroupDraft`
- 所有会改变本地 preset catalog 的路径统一走这套 reconciliation：
  - single delete
  - batch delete
  - import merge/replace
  - clear catalog
  - stale route-owner reconcile after import / hydration
- 页面层只消费 helper 输出，不再各自手写“清 key 但漏 selection”的局部逻辑。

## Expected Outcome

本地 preset catalog 每次变更后，selector、route owner、drafts、batch selection、batch group 都会一起收敛到同一个 canonical 状态，不再留下旧 preset 的批量管理残留。
