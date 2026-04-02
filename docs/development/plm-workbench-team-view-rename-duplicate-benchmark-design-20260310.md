# PLM Workbench Team View Rename / Duplicate 对标设计

日期: 2026-03-10

## 目标

前一轮已经让 `/plm` 的 `workbench` 团队视图具备了：

1. `save / apply / delete`
2. `set default / clear default`
3. `workbenchTeamView=<id>` 显式 deep link

但从真实工作台使用角度，仍然缺两条高频动作：

1. 团队成员看到一个共享工作台视角后，不能直接复制成自己的副本
2. 创建者保存了视角后，不能在当前入口直接重命名

这意味着工作台视图虽然已经可恢复、可分享，但还不够可演化。

本轮目标是补上这两条：

1. `duplicate` 允许把任意可见团队视图 fork 成自己的新副本
2. `rename` 允许 owner 在原位更新视图名称
3. UI 不再只是“保存”和“默认恢复”入口，而开始具备视图生命周期操作

## 对标判断

如果对标 `Retool saved query views`、`飞书视图副本`、`Notion database duplicate view`，一个可用的团队视图系统至少要满足：

1. 共享视图可复制，而不是只能照着手工重建
2. 原视图可重命名，而不是只能删除再新建
3. 复制后应成为当前用户自己的可管理资产，而不是继续绑定原 owner

对 `PLM workbench` 来说，这点尤其重要，因为工作台视角本来就承载了跨 `Documents / CAD / Approvals` 的组合任务语义。只支持“默认入口”不支持“fork”时，团队协作会被迫退回手工重配。

## 设计决策

### 1. 后端动作做成通用 `team view` 能力，前端先接 `workbench`

这轮没有只写死在 `workbench`。后端路由直接把能力补在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)：

1. `PATCH /api/plm-workbench/views/team/:id`
2. `POST /api/plm-workbench/views/team/:id/duplicate`

这样文档、CAD、审批三类团队视图未来也能复用同一套协议。

但前端入口本轮只接在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue) 的工作台团队视图块上，避免一次把所有面板 UI 一起搅动。

### 2. `duplicate` 允许复制非本人创建的共享视图

本轮最关键的产品判断是：

1. `rename` 仍然是 owner-only
2. `duplicate` 不要求 owner

也就是说，只要同租户可见，用户就可以把别人的共享视图复制成自己的副本。

原因很明确：

1. 复制的产物是新 `id`
2. owner 会切成当前用户
3. 默认标记不会继承

这更像 `fork`，不是修改原资产。

如果把 duplicate 也限制成 owner-only，这个功能的产品价值会很低，只能解决“我改我自己的名字”，无法解决“团队共享视图的二次演化”。

### 3. duplicate 默认命名采用稳定副本规则

为了避免复制时频繁撞名，本轮把副本命名规则下沉到 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)：

1. 第一个副本：`原名（副本）`
2. 后续副本：`原名（副本 2）`、`原名（副本 3）`

同时仍支持前端显式传自定义名称；如果传了且冲突，则按正常 409 处理。

这样做有两个好处：

1. UI 可以直接点“复制副本”而不强制先填名字
2. 后端对命名冲突有稳定、可预测的行为

### 4. rename 不再通过“保存到团队”间接模拟

本轮没有继续复用 `savePlmWorkbenchTeamView()` 来实现 rename，而是单独做了：

1. route
2. client
3. hook action

因为 `save` 的语义是 upsert 当前 owner + kind + name，而 `rename` 的语义是更新现有视图实体。如果继续拿 `save` 假装 rename，会混淆：

1. 当前选中视图 identity
2. requested view id
3. duplicate / save new / rename existing 三类动作

本轮把这三件事正式拆开了。

### 5. UI 只在工作台块暴露 rename / duplicate

这轮把新按钮加在 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)，但只在 `workbench` 调用点上真正传入：

1. `复制副本`
2. `重命名`

这样能得到两个效果：

1. 复用已有的团队视图块，不新增一套工作台专属模板
2. 保持其他面板团队视图块当前稳定，不在同轮引入过多交互变化

## 超越目标

本轮想超越的不是“再加两个按钮”，而是把 `PLM workbench team view` 从静态配置推进成可协作演化的资产。

完成后，团队视图不再只是：

1. 一个默认入口
2. 一条显式 deep link

而开始具备：

1. fork
2. rename
3. owner / non-owner 的清晰协作边界

这会让 `PLM workbench` 更接近真正的共享工作台产品，而不是一组附着在页面上的恢复参数。

## 本轮不做

- 不做 team view archive
- 不做 rename history
- 不做 duplicate with linked inheritance
- 不做批量复制 / 批量重命名
- 不做跨租户共享

本轮只解决一件事：

让 `PLM workbench team view` 具备最小可用、语义明确的 `duplicate / rename` 生命周期能力。
