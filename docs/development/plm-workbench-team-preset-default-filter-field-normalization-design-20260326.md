# PLM Workbench Team Preset Default Filter-Field Normalization Design

## Problem

`BOM / Where-Used` 默认团队预设的 auto-apply blocker 之前只按 query key 是否出现判断。

这会把显式写进 URL 的 canonical no-op 默认值也算成 blocker：

- `bomFilterField=all`
- `whereUsedFilterField=all`

但当前 deep-link builder 本身会省略这两个默认值，所以同一个状态会出现两套不一致语义：

1. 省略默认值时，默认团队预设可以 auto-apply。
2. 显式写默认值时，默认团队预设被错误阻断。

## Target

把 `BOM / Where-Used` 默认团队预设的 blocker 语义收紧到“只有真实非默认过滤状态才算显式 blocker”。

## Design

在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 中：

1. 删除 `BOM / Where-Used` 这两条 team-preset auto-apply 对“key presence”的依赖。
2. 改成统一的 filter-preset helper，按下面语义判定 blocker：
   - `team preset id` 存在
   - `local preset id` 存在
   - `filter` 非空
   - `filterField !== 'all'`
3. `filterField=all` 视为 canonical no-op，不再单独阻断默认 auto-apply。

## Non-Goals

- 不改变 `documents / approvals` 已有默认 blocker 语义。
- 不改变本地 preset 或 team preset 的 route ownership cleanup。
- 不改变 deep-link builder 对默认值的省略策略。
