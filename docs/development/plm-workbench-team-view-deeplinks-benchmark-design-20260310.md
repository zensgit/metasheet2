# PLM Workbench Team View Deep Links 对标设计

日期: 2026-03-10

## 目标

上一轮已经让 `/plm` 具备了 `workbench` 级团队视图，但还缺最后一层“可分享引用”：

1. 工作台团队视图可以保存和默认恢复
2. 但 URL 还不能直接指向某个 `workbench` 视图
3. 团队默认视图与显式分享链接之间也还没有优先级约束

本轮目标是补上这层：

1. 让 `/plm?workbenchTeamView=<id>` 成为正式协议
2. `copyDeepLink / buildDeepLinkUrl` 能带出当前 `workbench` 视图 ID
3. 显式 `workbenchTeamView` 在存在默认团队视图时仍优先恢复

## 对标判断

如果对标 `飞书共享视图链接`、`Retool saved view links`、`Notion database view links`，工作台级共享视角不能只支持“默认恢复”，还必须支持：

1. 显式链接到某个已保存视图
2. 显式链接优先于团队默认入口
3. 打开链接后，页面不仅选中该视图，还要恢复该视图对应的具体状态

否则这类能力仍然只是“团队默认配置”，不是可传播、可复现的工作台入口。

## 设计决策

### 1. `workbenchTeamView` 进入统一 query 协议

本轮直接把 `workbenchTeamView` 纳入 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts) 的允许 key 集合，而不是另加第二套路由参数解析。

这样做的结果是：

1. `workbench` 视图引用和现有 `documentTeamView / cadTeamView / approvalsTeamView` 语义保持一致
2. `mergePlmWorkbenchRouteQuery()` 可以统一处理显式引用和 query snapshot 合并
3. `hasExplicitWorkbenchQueryState()` 会把显式 `workbenchTeamView` 也视为“已有用户意图”

### 2. 保存 `workbench` 状态时，不把自身 ID 写回 snapshot

`workbench` 团队视图保存的仍是：

```ts
{
  query: Record<string, string>
}
```

但本轮在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里明确去掉了 `query.workbenchTeamView`。

原因很简单：

1. 视图状态应描述“工作台内容”，不应把“当前引用的是哪条视图”递归保存进去
2. 否则从某个旧视图派生保存新视图时，会把旧视图 ID 固化进新视图 snapshot
3. 显式 view id 应由 URL / selection 驱动，而不是埋进状态负载里

### 3. `usePlmTeamViews` 先同步 requested id，再应用状态

这轮在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 调整了应用顺序：

1. 先 `syncRequestedViewId(view.id)`
2. 再 `applyViewState(view.state)`

这样 `workbench` 视图在应用时，`applyWorkbenchTeamViewState()` 就能读取到最新的 `workbenchTeamViewQuery`，并把它保留在合并后的 route query 里。

这一步是本轮的关键。如果顺序反过来，页面会先恢复字段状态，再把 `workbenchTeamView` 补进 URL，容易出现一次无引用的中间态。

### 4. 显式引用优先于默认工作台恢复

`usePlmTeamViews()` 原本就支持 `requestedViewId` 优先于默认视图。本轮把这套机制正式接到 `workbench`：

1. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 增加 `workbenchTeamViewQuery`
2. `applyQueryState()` 会先读取 `workbenchTeamView`
3. auth 可用时，会优先刷新 `workbench` team views
4. 列表刷新后，如命中 `requestedViewId`，先应用显式视图；只有没有显式引用时才回退默认视图

### 5. 分享链接同时保留“视图身份 + 具体状态”

本轮没有把 URL 简化成只有 `workbenchTeamView=<id>`。相反，最终深链接和恢复后的 URL 会同时包含：

1. `workbenchTeamView=<id>`
2. 该视图展开后的具体字段状态

这样做的好处是：

1. 链接语义清晰，知道它引用了哪个团队视图
2. 页面状态具备可观察性，浏览器前进/后退仍能工作
3. 即便将来该团队视图被删掉，URL 里的展开状态仍可作为最小恢复线索

## 超越目标

本轮想超越的不是“再多一个 query 参数”，而是把 `PLM workbench` 从“可默认恢复”推进到“可被精确引用的团队工作台入口”。

达到这个层级后：

1. 团队可以直接分享某个 workbench 视图，而不是只能让对方依赖默认入口
2. 默认视图和显式视图不再互相覆盖
3. `workbench team view` 真正成为 `/plm` 的一等工作对象，而不仅是附属配置

## 本轮不做

- 不做短链接服务
- 不做 workbench team view 的跨租户共享
- 不做 view rename / duplicate
- 不做 `workbenchTeamView` 的 server-side redirect
- 不做权限细分到“可读但不可应用”的共享模型

本轮只解决一件事：

让 `/plm` 具备正式、稳定、优先级明确的 `workbench` 团队视图 deep link。
