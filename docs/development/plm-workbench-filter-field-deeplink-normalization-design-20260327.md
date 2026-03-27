# PLM Workbench Filter-Field Deep-Link Normalization Design

## Background

`BOM / Where-Used` 的默认 team preset auto-apply blocker 已经收紧成“只有真实 filter value 存在时，非默认 filter field 才算显式状态”。但 `PlmProductView.vue` 的 deep-link builder 和实时 query sync 仍会把只有 `filterField`、没有 `filter` 的 no-op 状态写进 URL，导致：

- 复制链接、share URL、`returnToPlmPath` 仍然携带伪显式 query。
- 页面 runtime 已把这类状态当作 no-op，但 URL canonical state 仍把它序列化出来。

## Design

统一使用一条 helper 语义：

- 只有 `filterValue` 非空，且 `filterField !== 'all'` 时，才保留 `bomFilterField / whereUsedFilterField`。
- 否则把 field-only 状态降回 canonical no-op。

落点：

1. `plmWorkbenchViewState.ts`
   - 新增 `resolvePlmFilterFieldQueryValue(...)`。
   - `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)` 和 `normalizePlmWorkbenchLocalRouteQuerySnapshot(...)` 都走同一条规则，保证 share URL、return path、canonical snapshot 一致。

2. `PlmProductView.vue`
   - `buildDeepLinkParams(...)` 改用同一 helper，避免复制链接继续写出 no-op field。
   - `scheduleQuerySync(...)` 的 BOM/Where-Used watcher 也改用同一 helper，避免页面自己把 no-op field 抖回 URL。

## Expected Result

- field-only/no-filter 状态不再出现在 deep link、share URL、`returnToPlmPath`、canonical query snapshot 里。
- 有真实 filter value 时，非默认 filter field 仍然继续保留。
