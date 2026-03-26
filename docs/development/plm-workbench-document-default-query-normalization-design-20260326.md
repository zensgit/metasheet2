# PLM Workbench Document Default Query Normalization Design

## 背景

`documents` 面板支持默认 team view auto-apply。

页面同时也允许通过 route query 显式还原文档筛选状态，例如：

- `documentTeamView`
- `documentRole`
- `documentFilter`
- `documentSort`
- `documentSortDir`
- `documentColumns`

## 问题

默认 auto-apply 之前只按“query key 是否存在”阻断：

- `documentSort=updated`
- `documentSortDir=desc`
- `documentColumns=<默认列集合>`

这些其实都是 canonical 默认值，页面自己构造 deep-link 时也会省略它们。

结果是旧 deep-link 或外部 route 只要显式带了这些默认值，就会把默认 `documentTeamView` 错误挡住；hydration 后页面看起来仍是默认文档状态，但默认 team view 不会接管。

## 设计决策

- `documents` 默认 auto-apply blocker 不再看“key 是否出现”，而是看“是否存在非默认显式状态”
- 这套判定抽成纯 helper，便于和 deferred hydration patch 一起复用
- 默认值语义：
  - `documentSort=updated` 不算 blocker
  - `documentSortDir=desc` 不算 blocker
  - `documentColumns` 只有在和默认列集合不同的时候才算 blocker
  - 非空 `documentRole / documentFilter`、显式 `documentTeamView`、非默认 sort/sortDir 继续算 blocker

## 实现

- 在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 新增 `hasExplicitPlmDocumentAutoApplyQueryState(...)`
- 在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `documents.shouldAutoApplyDefault()` 里，先把 `route.query` 与 deferred hydration patch 合成 effective query，再交给该 helper 判断

## 预期结果

- 显式默认排序/默认列的旧链接不会再错误拦住默认 `documentTeamView`
- 真正的显式文档过滤条件仍会阻断默认 auto-apply
- `documents` 面板的 auto-apply 语义与 canonical deep-link round-trip 保持一致
