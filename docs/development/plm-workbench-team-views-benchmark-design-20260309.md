# PLM Workbench Team Views 对标设计

日期: 2026-03-09

## 目标

前两轮已经让 `/plm` 具备了两层共享能力：

1. `BOM / Where-Used` 的团队过滤预设
2. `Documents / CAD / Approvals` 的团队视图与显式 deep link

但当前仍然缺一层更上位的工作台能力：

1. 用户只能分别保存单个面板视角，不能保存“整个 `/plm` 当前工作状态”
2. 当审核或协同跨越 `Documents / CAD / Approvals` 多块区域时，缺少一键回到工作上下文的入口
3. 默认团队视角仍是按面板恢复，不是按“工作台任务视角”恢复

本轮目标是补上这层：

1. 给 `/plm` 增加 `workbench` 级别的团队视图
2. 保存对象不是单面板 state，而是整个工作台的 query snapshot
3. 让默认工作台视角可以在空 `/plm` 首屏自动恢复

## 对标判断

如果对标 `飞书多维表格共享视图`、`Notion database team views`、`Retool workspace saved views`，工作台级共享视角至少要满足三件事：

1. 不是只存一个面板，而是能恢复整页上下文
2. 支持团队默认入口，而不是只靠个人 local state
3. 恢复路径必须复用页面已有的 URL / state 协议，而不是再造一套私有状态

对 `PLM workbench` 来说，这层尤其重要，因为实际任务往往不是“只看文档”或“只看 CAD”，而是：

1. 文档过滤 + 审批过滤 + CAD 评审备注
2. 某个固定审核工作台入口
3. 某个团队默认检查视角

单面板 team view 解决不了这种跨区块上下文。

## 设计决策

### 1. 新增 `workbench` kind，而不是新建第二张表

后端现有 [plm_workbench_team_views](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts) 已经具备：

1. `tenant + scope + kind` 默认唯一约束
2. 任意 `jsonb state`
3. 团队范围的 `save / list / set default / clear default / delete`

因此这轮不再新增表，而是直接把 `kind` 扩为：

- `documents`
- `cad`
- `approvals`
- `workbench`

对应实现收口在 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)。

### 2. `workbench` state 采用 query snapshot，而不是重新定义一套巨型结构

这轮没有再发明新的“工作台 DTO”，而是直接保存：

```ts
{
  query: Record<string, string>
}
```

其来源就是当前页面已经稳定存在的 deep-link/query 协议。

这样做的好处是：

1. `team view` 与 `deep link` 使用同一份状态语言
2. 工作台视角和显式 URL 可互相转换
3. 后续如果再扩字段，不必同步维护第二套 schema

### 3. 应用 workbench team view 时，走“query replace + applyQueryState”链路

这轮没有在 `applyWorkbenchTeamView()` 里手工逐个赋值几十个 ref，而是：

1. 把保存的 query snapshot 合并回当前 route query
2. `router.replace(...)`
3. 再调用已有的 `applyQueryState()`

对应 helper 在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)，工作台应用逻辑在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)。

这一步很关键，因为它保证：

1. `workbench team view`
2. 显式 deep link
3. 首屏 query restore

三条恢复链路最终落到同一个状态入口。

### 4. 入口放在 Product Panel，而不是再散到各个子面板

工作台级视角的入口放在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)，因为这里本来就是：

1. auth 状态
2. deep-link 管理
3. 产品与工作台头部入口

把 `workbench team views` 放在这里，语义上更像“整个工作台视角管理”，而不是某个子面板的附属功能。

### 5. 默认自动恢复只在“空工作台”生效

这轮仍然保留默认团队视角自动恢复，但规则更收紧：

1. 只有当 `route.query` 中不存在任何显式 `PLM` workbench query 时才自动恢复
2. 一旦页面已有 query 或用户已进入具体工作态，不再用默认视角覆盖

这样可以避免：

1. 显式分享链接被默认值覆盖
2. 用户手工调好的工作态被 auth refresh 重置

## 超越目标

本轮想超越的不是“再多一个保存按钮”，而是把 `/plm` 从“很多子面板的集合”推进到“一个可共享的协作工作台”。

这意味着：

1. 团队可以保存整页工作上下文
2. 默认团队入口不再局限于单块面板
3. deep-link、team view、default restore 三层能力开始真正对齐

当这层完成后，`PLM workbench` 才开始具备接近 `多维表格共享视角 / 工作台共享视角` 的产品语义。

## 本轮不做

- 不做 `workbenchTeamView=<id>` 这种显式 query 引用
- 不做跨租户共享
- 不做多人同时编辑 workbench view
- 不做后端短链接
- 不做 `BOM / Where-Used / Compare / Substitutes` 的独立工作台块级权限

本轮目标很明确：

让 `/plm` 具备最小可用、后端持久化、团队默认可恢复的工作台级 team view。

