# PLM Workbench Local Preset Route Parity Design

## Problem

`BOM / Where-Used` 本地 preset 还有三条同型 route/ownership 分叉：

- external hydration 只按 `selector` 清理，不会处理“没有 selector、但仍残留 batch 管理态”的情况
- same-key import/reconcile 会消费 route owner cleanup，但不会把 `name/group` draft 一起写回
- mount 首屏如果 URL 带着一个缺失的本地 preset owner，默认 team preset 会先被这个 stale blocker 挡住，之后也不会自动补接管

## Design

- 扩展 `resolvePlmHydratedLocalFilterPresetTakeover(...)`
  - route owner 存在时，不再只比较 `selector`
  - 同时裁剪 `selectionKeys`
  - 仅在仍有 surviving selection 时保留 `batchGroupDraft`
- `reconcileBom/WhereUsedLocalFilterPresetIdentityAfterImport()`
  - 传入当前 `nameDraft/groupDraft`
  - 消费 helper 返回的 `nextNameDraft/nextGroupDraft`
- 默认 team preset auto-apply blocker
  - 保留 `bomFilterPreset/whereUsedFilterPreset` 对显式 query 的阻断能力
  - 但如果该本地 preset key 在当前 catalog 中已不存在，则不再把它当作有效 blocker

## Expected Outcome

本地 preset 的 hydration、导入重对齐、默认 team preset auto-apply 会共享同一份 canonical owner 语义：

- stale local route owner 不会再残留 batch 管理态
- same-key import 不会把旧 rename/group 草稿挂到新的 owner 判定上
- 缺失的 local preset query 不会在首屏把默认 team preset 永久挡住
