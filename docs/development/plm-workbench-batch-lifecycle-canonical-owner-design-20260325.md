# PLM Workbench Batch Lifecycle Canonical Owner Design

## 背景

`usePlmTeamViews.ts` 的 batch lifecycle 路径同时依赖两套状态：

- 本地 selector：`teamViewKey`
- canonical route owner：`requestedViewId`

在 pending selector drift 场景下，这两个值可以不同：

1. 用户当前应用的是 team view `A`
2. 本地下拉切到 team view `B`，但尚未点击 `Apply`
3. 用户对 `B` 执行 batch `archive / restore / delete`

旧实现把 `teamViewKey` 同时当作 selector owner 和 route owner 使用，导致 batch lifecycle 会错误修改 canonical route。

## 问题

- batch `archive / delete` `B` 时，可能把仍然生效的 canonical route owner `A` 一起清掉
- batch `restore` `B` 时，可能在 `requestedViewId` 仍指向 `A` 的情况下，错误重新应用 `B`

这会让 workbench route、selector 和批量操作语义脱节。

## 设计

batch lifecycle 完成后，分别处理两类 owner：

### 1. 本地 selector owner

继续以 `teamViewKey` 为准。

- 如果本地下拉选中的 id 被 batch 处理且动作不是 `restore`，清空本地 selector 和相关表单草稿
- 如果动作是 `restore`，只有在没有 canonical route owner 的情况下，才允许把恢复后的本地 selector 重新应用回来

### 2. Canonical route owner

单独以 `requestedViewId` 为准。

- 只有 `requestedViewId` 本身命中了 processed ids，才允许清理 route owner
- batch `restore` 只有在 `requestedViewId` 本身被恢复时，才允许重新应用该 canonical owner
- 如果 `requestedViewId` 仍然是另一个未处理的 route owner，则不得让 pending selector 抢走 route

## 结果

- pending selector drift 下，batch lifecycle 不会再误清 canonical route owner
- batch `restore` 不会再劫持当前已应用的 workbench route
- selector cleanup 和 route owner cleanup 语义分离，后续可继续复用到其它 takeover 路径
