# PLM Team View Deep Links 对标设计

日期: 2026-03-09

## 目标

前一轮已经让 `/plm` 的 `Documents / CAD / Approvals` 具备了后端持久化的 `team views` 和 `default views`，但当前还缺一层很关键的分享入口：

1. 用户只能依赖默认视图自动恢复，不能显式指定“打开哪一个团队视图”
2. `复制深链接` 只能表达当前字段状态，不能显式保留“这是哪个团队视图”
3. 团队协作时，别人拿到链接后虽然能恢复部分字段，但缺少对“共享视图来源”的显式语义

本轮目标是：

1. 让 `/plm` 支持通过 query 显式指定团队视图：
   - `documentTeamView`
   - `cadTeamView`
   - `approvalsTeamView`
2. 当 query 中带有 team view id 时，页面优先应用该视图，再恢复字段状态
3. 让 `复制深链接` 在当前选中团队视图时自动保留这些 query

## 对标判断

如果对标 `Notion shared database views`、`Retool saved views URL state`、`飞书多维表格共享视图链接`，团队视图真正可分享，至少要满足两件事：

1. 链接能表达“打开哪个共享视图”
2. 打开的页面能同时恢复“共享视图身份”和“该视图对应的字段状态”

只靠默认视图还不够，因为默认是环境约定，不是显式分享。对 `PLM workbench` 来说，显式深链接特别重要：

1. 实施与审核常常需要“请直接打开这个视图”
2. `CAD` 和 `Approvals` 这类面板经常依赖固定的队列或评审入口
3. 团队视图如果不能直接挂到 URL，上层工作流、文档和消息系统就很难稳定引用

## 设计决策

### 1. 团队视图 query 作为显式入口，高于默认恢复

本轮新增三组 query：

- `documentTeamView`
- `cadTeamView`
- `approvalsTeamView`

它们不替代已有字段 query，而是与字段 query 并存。优先级规则是：

1. 显式 team view query
2. 显式字段 query
3. 默认团队视图自动恢复

这样可以保证：

- 团队视图链接是明确入口
- 默认恢复不覆盖显式分享
- 即使未来 team view 被删除，字段 query 仍可作为兜底状态

### 2. 深链接同时保留 view identity 和 resolved state

这轮没有让深链接只保留 `team view id`，而是继续保留具体字段状态：

- `documentRole / documentFilter`
- `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
- `approvalsFilter / approvalsStatus`

同时附加：

- `documentTeamView`
- `cadTeamView`
- `approvalsTeamView`

原因很直接：

1. URL 需要有“这是哪个视图”的身份语义
2. 也需要有“这个视图当前展开成什么状态”的冗余信息
3. 当 team view 不存在时，页面仍可利用字段 query 退回到近似工作状态

### 3. 继续复用 `usePlmTeamViews`，不在父页重复处理

这轮没有把显式 query 解析逻辑继续散在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里，而是把它收进 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)：

- `requestedViewId`
- `syncRequestedViewId`

这样 composable 自己负责：

1. refresh 后按请求的 `team view id` 找到并应用视图
2. 找不到时清掉失效 query
3. save / apply / set default / delete 后同步 URL

父页只负责把 query ref 接进去。

### 4. 自动默认恢复继续保留，但只作为回退

前一轮已经有 `shouldAutoApplyDefault()`。本轮不改变它的职责，只把显式 team view query 放在它前面。

这样带来的结果是：

1. 旧的默认恢复路径不受影响
2. 显式分享路径不会误落回默认
3. `Documents / CAD / Approvals` 三块逻辑一致

### 5. 初始化时需要在 query 解析后，补一次 team views refresh

因为 `dev` 页面初次进入时，team views 可能在 query 解析前就被刷新过一次。为了避免显式 query 被错过，本轮在 [applyQueryState() ](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中增加了：

- 解析 `documentTeamView / cadTeamView / approvalsTeamView`
- 若当前 auth 有效，则立即刷新对应 team views

这样可以保证：

1. 显式 team view query 能在首屏生效
2. 后续 `autoload` 任务看到的是已应用的视图状态

## 超越目标

这轮想超越的不是“URL 多几个参数”，而是让 `PLM workbench` 的团队视图真正具备可引用性：

1. 链接可以明确表达团队视图身份
2. 浏览器打开后能恢复相同工作状态
3. 上层工作流、消息、文档或审批备注可以直接引用特定视图入口

这一步做完后，`team views` 才不再只是“页面上的一个保存框”，而是工作台里的可分享资产。

## 本轮不做

- 不做服务端短链接
- 不做 team view 名称级 query，只支持 id
- 不做 `BOM / Where-Used team preset` 的同类显式 query
- 不做 team view 被删除后的专门提示页
- 不做跨租户共享链接

本轮目标很明确：

让 `/plm` 的 `Documents / CAD / Approvals team views` 可以通过 URL 被显式引用、恢复和复用，同时保持默认恢复链路不被破坏。
