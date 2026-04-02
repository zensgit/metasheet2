# PLM Workbench Panel Scope Roundtrip Design

## Date
- 2026-03-26

## Problem
- `workbenchTeamView` 的 collaborative snapshot 由 `PlmProductView.vue` 内部 `buildDeepLinkParams(true)` 生成。
- 这条 builder 只会在显式传入 `panelOverride` 时写出 `panel`，但当前页面 route 里已经存在的显式 `panel=documents` / `panel=approvals` 等 scope 不会自动 round-trip 回 snapshot。
- 结果是同一个 workbench team view 只要 route 上保留了显式 panel scope，就可能因为本地 snapshot 漏掉 `panel` 而被 watcher 误判成 stale owner。
- 同一条遗漏还会影响 `returnToPlmPath`，导致从 audit 返回 workbench 时丢失显式 panel scope。

## Design
- 把 `panel` 视为 collaborative query snapshot 的 canonical transport 字段，而不是仅供 deep-link copy 使用的可选覆盖。
- 在 `plmWorkbenchViewState.ts` 新增 `normalizePlmWorkbenchPanelScope(...)`：
  - 输入允许任意 query-like 值。
  - 过滤 `all` 和非法 panel。
  - 采用固定 panel 顺序做 canonical serialization，避免仅因顺序不同触发 drift。
- 在 `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)` 中统一走这条 helper：
  - 保留显式 panel scope。
  - 删除空 panel 或无效 panel。
  - 继续保留既有的本地 preset id / approvalComment stripping 语义。
- 在 `PlmProductView.vue` 的 `buildDeepLinkParams(...)` 中：
  - 优先使用调用方传入的 `panelOverride`。
  - 否则从当前 `route.query.panel` 读取显式 scope。
  - 不读取 `deepLinkScope` 本地编辑态，避免把尚未落到 route 的 deep-link 草稿偷偷写进 collaborative snapshot。

## Intended Result
- `workbenchTeamView` collaborative snapshot、share URL、audit return path 都会稳定保留当前 route 上的显式 panel scope。
- `panel` 顺序差异不再造成 false drift。
- 本地 deep-link scope 编辑态仍与 canonical route 状态隔离。

## Touched Files
- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`
