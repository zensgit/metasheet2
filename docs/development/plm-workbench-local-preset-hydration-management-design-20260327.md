# PLM Workbench Local Preset Hydration Management Design

## Problem

`bomFilterPreset` / `whereUsedFilterPreset` 的 external route hydration 现在只会清 selector、name draft、group draft。
如果 route owner 从本地预设 A 切到 B，页面仍会保留 A 的 batch selection 和 batch group draft，随后用户还能对旧选择执行批量分组或删除，形成 owner 已切换但 management state 还指向旧预设的错位。

## Design

- 扩展 `resolvePlmHydratedLocalFilterPresetTakeover(...)`，把 `localSelectionKeys` 和 `localBatchGroupDraft` 一并纳入 takeover cleanup。
- 当 hydrated route owner 明确从 A 切到 B 时：
  - 清空 local selector
  - 清空 name/group drafts
  - 清空 batch selection
  - 清空 batch group draft
- 当 hydrated route owner 与当前 selector 相同，或 route 上没有显式 local owner 时，保留这些本地管理态。
- 在 `PlmProductView.vue` 的 BOM / Where-Used hydration wiring 中消费新的 cleanup 结果，保证 helper 合同真正落到页面状态。

## Expected Outcome

external deep-link / browser back 把 local preset owner 从 A 切到 B 后，页面不会再保留旧 A 的批量管理状态；本地 preset takeover 语义和 team preset hydration takeover、resetAll cleanup 保持一致。
