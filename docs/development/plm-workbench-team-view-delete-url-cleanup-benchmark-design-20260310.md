# PLM Workbench Team View Delete URL Cleanup 对标设计

日期: 2026-03-10

## 目标

前几轮已经让 `PLM workbench team view` 在以下动作后保持稳定 identity：

1. `save`
2. `set default`
3. `duplicate`
4. `rename`
5. `save / set default` 后 URL 同步
6. 显式 `workbenchTeamView=<id>` deep link 优先于默认团队视图

但 `delete` 还缺最后一条退场语义：

1. 删除当前 `workbench` 团队视图后，URL 里的 `workbenchTeamView` 应立即退出
2. 当前工作台 query 状态不应被一起清空
3. 团队视图输入框和内部 default sentinel 不应继续挂着已删除对象

本轮目标就是把这条 `delete` 生命周期补齐。

## 对标判断

对标 `Retool saved view delete`、`Figma view preset delete`、`Notion database view delete`，成熟工作台通常遵守一条规则：

`删除的是 view identity，不是当前工作状态本身。`

也就是说：

1. 显式 deep link id 应立即退出 URL
2. 当前过滤/字段/评审等 query 状态可以保留成匿名工作态
3. UI 不应继续显示一个已经不存在的“当前团队视图”

如果删除后 URL 还留着旧 `workbenchTeamView`，就会形成失效 deep link。  
如果删除时把当前 query 一起抹掉，用户会丢失当前工作台状态。  
如果删除后 `teamViewName` 还残留旧名称，则会制造“视图还在”的错觉。

## 设计决策

### 1. hook 内统一做 delete 退场

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `deleteTeamView()` 中补齐四件事：

1. 从本地 `teamViews` 列表移除当前对象
2. 如果当前选中项就是被删对象，清空 `teamViewKey`
3. 清空残留的 `teamViewName`
4. 如果当前 `requestedViewId` 指向被删对象，则同步 `syncRequestedViewId(undefined)`，让 URL 退出 `workbenchTeamView`

同时把 `lastAutoAppliedDefaultId` 对应 id 一并清掉，避免自动恢复逻辑记住一个已经不存在的默认视图。

### 2. 工作台 query 状态保持匿名

这轮 delete 后不做自动回退：

1. 不回退到别的默认团队视图
2. 不重置到空白 `/plm`
3. 不自动切换到本地 preset

删除当前 `workbench team view` 后，页面继续保留已经恢复出来的：

1. `documentRole`
2. `documentFilter`
3. `approvalsFilter`
4. `cadReviewState`
5. `cadReviewNote`

这样当前工作台会退回到“匿名 query 状态”，而不是被意外清空。

### 3. 与 team preset delete 语义对齐

这轮的设计故意和 [plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md) 保持一致：

1. identity 退出 URL
2. 当前工作态保留
3. 残留表单状态清掉

这样 `team view` 和 `team preset` 的删除行为就不会再分叉。

## 超越目标

本轮不是单纯把删除按钮点通，而是让 `PLM workbench team view` 的生命周期第一次完整闭环：

1. 进入：`save / duplicate`
2. 稳定：`rename / set default / deep link / URL sync`
3. 退出：`delete`

其中 `delete` 也开始遵守统一规则：

`team view identity 可以消失，但当前 workbench query 状态不应被意外抹掉。`

## 本轮不做

- 不做 delete 后自动切换到其他默认团队视图
- 不做 soft delete / archive
- 不做 team view 审计日志
- 不做 server-side resume 迁移

本轮只解决一件事：

让当前 `PLM workbench team view` 被删除后，URL、UI 输入状态和当前 query 工作态都能一致退场。
