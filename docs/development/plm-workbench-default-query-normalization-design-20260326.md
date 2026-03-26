# PLM Workbench Default Query Normalization Design

## Problem

`workbench` 默认团队视角的 auto-apply blocker 之前仍然按“query 非空”粗判：[plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 在去掉 `approvalComment` 和无效 `panel` 之后，直接用 `Object.keys(next).length > 0` 判定是否存在显式 route state。

这会把 canonical no-op 默认值也当成 blocker，例如：

- `whereUsedRecursive=true`
- `whereUsedMaxLevels=5`
- `bomDepth=2`
- `bomView=table`
- `compareLineKey=child_config`
- `compareMaxLevels=10`
- `compareIncludeChildFields=true`
- `compareIncludeSubstitutes=false`
- `compareIncludeEffectivity=false`
- `compareSync=true`
- `compareRelationshipProps=quantity,uom,find_num,refdes`

但 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 deep-link builder 会省略这些默认值，所以显式写默认值和省略默认值之前被错误分成了两套语义。

## Target

把 `workbench` 默认团队视角的 auto-apply blocker 收紧成 canonical query normalization：显式 no-op 默认值不再阻断默认 owner，只有真实非默认 route state 才算 blocker。

## Design

在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 的 `hasExplicitPlmWorkbenchAutoApplyQueryState(...)` 里加入 default normalization：

- `searchItemType=Part` 忽略
- `searchLimit=10` 忽略
- `itemType=Part` 忽略
- `whereUsedRecursive=true` 忽略
- `whereUsedMaxLevels=5` 忽略
- `bomDepth=2` 忽略
- `bomView=table` 忽略
- `compareLineKey=child_config` 忽略
- `compareMaxLevels=10` 忽略
- `compareIncludeChildFields=true` 忽略
- `compareIncludeSubstitutes=false` 忽略
- `compareIncludeEffectivity=false` 忽略
- `compareSync=true` 忽略
- `compareRelationshipProps=quantity,uom,find_num,refdes` 忽略

保留这些语义不变：

- 非默认值仍然阻断默认 auto-apply
- `panel` 仍只认 canonicalized scope
- `approvalComment` 继续视为本地草稿，不进入 blocker

## Non-Goals

- 不改变 team view / preset 的 route ownership cleanup。
- 不改变 deep-link builder 当前的 query 省略策略。
- 不改变 documents / approvals / BOM / Where-Used 各自专用 blocker helper。
