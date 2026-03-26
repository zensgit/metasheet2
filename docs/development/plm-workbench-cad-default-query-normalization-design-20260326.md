# PLM Workbench CAD Default Query Normalization Design

## Problem

`CAD` 默认团队视角的 auto-apply blocker 之前仍然走前端本地的 key-presence 语义：只要 route query 里出现过 `cadTeamView`、`cadFileId`、`cadOtherFileId`、`cadReviewState`、`cadReviewNote` 这些 key，就会阻断默认视角接管。

这会把 canonical no-op query 也当成显式 blocker，例如：

- `cadReviewState=`
- `cadReviewNote=`

但当前 deep-link builder 本来就会省略这些空默认值，所以同一状态会出现两套不一致语义：

1. 省略空值时，默认 CAD team view 可以 auto-apply。
2. 显式写空值时，默认 CAD team view 被错误阻断。

## Target

把 `CAD` 默认团队视角的 blocker 判定统一成 canonical route state：只有真实非默认状态才算显式 blocker。

## Design

在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 中新增 `hasExplicitPlmCadAutoApplyQueryState(...)`，语义是：

- `cadTeamView` 非空 => blocker
- `cadFileId` 非空 => blocker
- `cadOtherFileId` 非空 => blocker
- `cadReviewState` 非空 => blocker
- `cadReviewNote` 非空 => blocker

空字符串、空白字符串、被 deferred patch 清空后的空值都不算 blocker。

随后把 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `CAD` 默认 auto-apply gate 从本地 `hasExplicitQueryKey(CAD_QUERY_KEYS)` 切到这个 helper。

## Non-Goals

- 不改变 `CAD` route ownership cleanup 语义。
- 不改变 `documents / approvals / BOM / Where-Used` 已有 blocker 逻辑。
- 不改变 deep-link builder 对空 CAD query 的省略策略。
