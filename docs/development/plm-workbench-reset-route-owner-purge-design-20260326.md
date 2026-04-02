# PLM Workbench Reset Route Owner Purge Design

## 背景

`PlmProductView.vue` 的 `resetAll()` 会清掉页面内存中的 collaborative owner：

- `workbenchTeamViewQuery`
- `documentTeamViewQuery`
- `cadTeamViewQuery`
- `approvalsTeamViewQuery`

但它传给 `syncQueryParams(...)` 的 patch 之前没有把这四个 query key 一起删掉。结果是：

1. 用户打开带 `workbenchTeamView` 或 panel team-view owner 的链接。
2. 触发 `resetAll()`。
3. 本地 ref 被清空，但 URL 里旧 owner 还在。
4. `route.fullPath` watcher 再次触发 hydration，把旧 owner 从 query 回灌回来。

这会让 reset 之后的页面重新绑定到刚刚被清掉的 canonical owner，形成“reset 不彻底”的假象。

## 设计目标

1. `resetAll()` 必须 authoritative 地清掉 workbench 级和 panel 级 canonical team-view owner query。
2. 这条合同要有显式可测试定义，避免以后再次在裸 patch 里漏 key。

## 方案

### 1. 提取 reset owner purge helper

在 `plmWorkbenchViewState.ts` 中新增：

- `PLM_WORKBENCH_TEAM_VIEW_OWNER_QUERY_KEYS`
- `buildPlmWorkbenchResetOwnerQueryPatch()`

它只负责表达 reset 时必须删除的 canonical owner query keys：

- `workbenchTeamView`
- `documentTeamView`
- `cadTeamView`
- `approvalsTeamView`

### 2. resetAll 统一复用 helper

`PlmProductView.vue` 的 `resetAll()` 在 `syncQueryParams(...)` patch 中直接展开该 helper，避免继续靠人工手写这 4 个 key。

## 影响

修复后，`resetAll()` 的 route cleanup 会和本地 state cleanup 保持一致：

- 页面 state 清空
- URL canonical owner 一并清空
- 后续 hydration 不会把 stale owner 再带回来
