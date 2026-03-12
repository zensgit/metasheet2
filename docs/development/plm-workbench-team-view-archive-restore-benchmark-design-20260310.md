# PLM Workbench Team View Archive Restore 对标设计

日期: 2026-03-10

## 目标

前几轮已经把 `PLM workbench team view` 的主生命周期收到了可用状态：

1. `save`
2. `set default`
3. `duplicate`
4. `rename`
5. `delete`
6. 显式 `workbenchTeamView=<id>` deep link
7. `save / default / duplicate / rename / delete` 的 URL 一致性

但还缺一段更成熟的“软退出”路径：

1. 团队视图不想直接删掉时，应该支持 `archive`
2. 被归档的团队视图应退出当前 URL identity，但保留当前工作台状态
3. 归档视图应可 `restore`，并重新回到当前 URL identity

本轮目标就是把这段 `archive / restore` 生命周期补齐。

## 对标判断

对标 `Notion archived view`、`Linear archived workflow preset`、`Retool saved view archive`，成熟工作台通常遵守这条规则：

`archive 是 identity 退场，不是当前工作态丢失。`

也就是说：

1. 归档后，显式 `workbenchTeamView` 应立即退出 URL
2. 当前 query 工作态应保留为匿名状态
3. 归档视图仍应在目录中可见，但不能继续作为“当前可应用视图”使用
4. 恢复后，同一个 view id 应重新回到 URL

如果归档后 URL 还残留旧 id，就会形成失效 deep link。  
如果归档时把当前 query 一起清空，用户会丢失工作台上下文。  
如果恢复后拿到的是新 id，用户之前分享过的链接就会失效。

## 设计决策

### 1. workbench team view 改为支持 soft archive

在 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts) 和 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 中引入：

1. `archived_at`
2. `isArchived`
3. `archivedAt`

并新增两个动作：

1. `POST /api/plm-workbench/views/team/:id/archive`
2. `POST /api/plm-workbench/views/team/:id/restore`

同时约束：

1. `archived` 视图不可设为默认
2. `save` 同名视图时会自动清掉 `archived_at`，避免“同名保存却还躺在归档态”

### 2. 前端归档后退出 identity，但保留 query

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 中，`archiveTeamView()` 会统一做四件事：

1. 把当前选中的 team view 标成 `isArchived`
2. 清空 `teamViewKey`
3. 清空 `teamViewName`
4. 如果当前 `requestedViewId` 指向该视图，则同步 `syncRequestedViewId(undefined)`

但不会清当前工作台的 query 状态：

1. `documentRole`
2. `documentFilter`
3. `approvalsFilter`
4. `cadReviewState`
5. `cadReviewNote`

也就是从“显式团队视图”退回“匿名工作态”。

### 3. 恢复后用原 id 重新占住 URL

`restoreTeamView()` 的行为不是只把列表项改回来，而是：

1. 后端清掉 `archived_at`
2. 前端把该视图重新设为当前选中
3. 通过 `applyView()` 重新同步 `requestedViewId`
4. URL 恢复 `workbenchTeamView=<same-id>`

这样 `archive -> restore` 的 identity 是闭环的，不会生成新 id。

### 4. 目录层也要显式暴露归档态

工作台团队视图下拉不再把归档对象完全隐藏，而是显式标识：

`· 已归档`

同时：

1. 归档项不可 `apply`
2. 归档项不可 `set default`
3. 归档项可 `restore`

这样用户能在不离开当前工作台的前提下完成恢复。

## 超越目标

本轮不是只补两个按钮，而是让 `PLM workbench team view` 第一次具备完整的生命周期层级：

1. `save / duplicate` 进入
2. `rename / default / deep link` 稳定
3. `archive / restore` 软退出与回归
4. `delete` 硬退出

也就是说，`PLM workbench team view` 现在已经不只是一个可保存的临时视角，而是接近真正“团队工作台视图资源”的行为模型。

## 本轮不做

- 不做 `archive list` 独立分页
- 不做 `archive` 审计日志
- 不做 `restore` 后自动回为默认
- 不做 `team view` 分享权限细分

本轮只解决一件事：

让 `PLM workbench team view` 在 `archive / restore` 后，URL identity、当前 query 工作态和目录可见性保持一致。
