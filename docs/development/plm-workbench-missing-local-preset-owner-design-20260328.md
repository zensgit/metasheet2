# PLM Workbench Missing Local Preset Owner Design

## Problem

`bomFilterPreset` / `whereUsedFilterPreset` 的 route owner 已经失效时，`PlmProductView.vue` 现在只会把 URL query 清掉，不会同步清掉同 key 的本地 selector、name/group 草稿和 batch management state。

这会留下两类错位：

- route owner 已经被 authoritative 地消费掉，但页面还像在编辑一个不存在的本地 preset
- batch selection / batch group draft 仍然指向失效 preset，后续批量管理会继续基于 stale state

## Design

- 扩展 `resolvePlmLocalFilterPresetRouteIdentity(...)`，让它在 `routePresetKey` 仍存在但 `activePreset` 已缺失时，也能输出 canonical cleanup 结果。
- cleanup 语义按当前真实 owner 关系对齐：
  - 如果当前 selector 仍等于失效 route owner，则清掉 selector、name/group drafts
  - 如果当前 selector 已经切到另一个 pending preset，则保留这个 pending selector 和它的草稿
  - 无论哪种情况，都把失效 route owner 从 batch selection 里裁掉
  - 如果 batch selection 被裁空，则一并清掉 batch group draft
- `PlmProductView.vue` 在 `applyQueryState()` 的 missing-route-owner 分支，以及 import reconcile / route-owner drift watcher 中消费新的 helper 输出，保证 URL purge 和本地管理态 cleanup 保持同一份合同。

## Expected Outcome

外部 deep-link、浏览器回退、导入更新或其它 hydration 路径把本地 preset route owner 指向一个已经不存在的 preset 时，页面不会再残留 stale selector / stale batch management；route owner、selector、draft、batch state 会一起收敛到真实存活的状态。
