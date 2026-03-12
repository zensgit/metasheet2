# Workflow Hub Team Views 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `Workflow Hub` 的能力推进到了：

1. `saved views`
2. `query sync + history replay`
3. `session restore`

但这三层都还是浏览器本地能力，缺一个真正能在同一租户内复用的共享层。当前最明显的缺口是：

1. `Saved Views` 只能单浏览器复用，无法跨人协同
2. 流程管理员沉淀下来的常用筛选视角，无法直接让实施或运营复用
3. `Workflow Hub` 已经像工作台，但还没有最基础的“团队入口”概念

本轮目标是：

1. 给 `Workflow Hub` 增加最小可用的 `team views`
2. 让视角从浏览器本地提升到后端持久化
3. 保持 owner 可管理，同时让同租户成员可见、可应用

## 对标判断

如果对标 `Retool shared filters`、`Notion database shared views`、`飞书多维表格共享视图入口`，当前只做到 local saved views 还不够。真正可用的工作台至少还需要：

1. 团队级持久化
2. 跨刷新、跨页面仍可恢复
3. 明确的 owner 和删除边界

上一轮解决的是“个人可复用”，这一轮要解决的是“团队可复用”。

## 设计决策

### 1. 新增后端资源 `workflow_hub_team_views`

新增迁移 [zzzz20260309113000_create_workflow_hub_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts)，表结构围绕：

- `tenant_id`
- `owner_user_id`
- `scope=team`
- `name / name_key`
- `state(jsonb)`
- `created_at / updated_at`

这里没有直接做“所有团队成员都可编辑”，只做：

- 同租户可见
- owner 可删除

先把共享入口打通，再决定是否做协作编辑。

### 2. 仍然复用 `WorkflowHubRouteState`

这轮没有新造一套 team-view schema，而是继续复用 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts) 定义出来的 route state：

- workflow search / status / sort / offset
- template search / source / sort / offset

这样 `saved views / session restore / team views` 三层能力就能围绕同一份状态模型运转。

### 3. API 挂到现有 `workflow-designer` 目录面

后端接口直接接到 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)：

- `GET /api/workflow-designer/hub-views/team`
- `POST /api/workflow-designer/hub-views/team`
- `DELETE /api/workflow-designer/hub-views/team/:id`

原因很直接：

- 这批数据就是 `Workflow Hub` 的目录视角资源
- 先不引入新的 route namespace
- 方便和现有 `draft list / template catalog` 一起收敛

### 4. 前端沿用 `saved views` 交互骨架，但升级为后端持久化

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 继续保留上一轮的 `Saved Views`，同时新增 `Team Views` 区块：

- `Save team view`
- `Apply view`
- `Delete`（仅 owner 可见）

这样用户学习成本最低，也避免把共享视图做成另一套割裂交互。

### 5. 支持 reload 后仍可恢复，不依赖本地 session

这轮的超越点不是简单把 local saved views 再做一遍，而是把它推进到了：

- 后端持久化
- 刷新后仍存在
- 新会话仍可读

即使浏览器本地 `saved views / session state` 被清掉，`Team Views` 仍然可以从后端拉回来。

### 6. 顺手收口 live dev bootstrap

实机验证时暴露出一个真实问题：

- 默认 `dev-token` 会用 `dev-user`
- `auth/me` 会进一步回库取用户
- fresh backend 下 `dev-user` 不存在时会被判成 `Invalid token`

这会让 `/workflows` 在 live dev 环境里掉回默认壳，直接阻断 `Workflow Hub` 的浏览器 smoke。

因此本轮顺手把 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 的非生产 fallback 收口成：

- 非生产环境下，token subject 不在库里时，仍可回落到 synthetic dev user

这不是额外功能，而是保证 `team views` 在 live dev 环境里可验证的必要前提。

## 超越目标

这轮想超越的不是“把 saved views 搬到数据库”，而是把 `Workflow Hub` 从“个人工作视角容器”升级成“团队工作入口”：

1. 流程管理员可以沉淀标准视角
2. 同租户成员可以直接复用，而不是手工重新输入条件
3. `saved views / history replay / session restore / team views` 四层能力开始形成清晰分层

后续如果继续做：

- team default views
- shared template packs
- org-level workflow workbench presets

已经有明确承接点。

## 本轮不做

- 不做多人共同编辑 team view
- 不做 team view 权限矩阵
- 不做 server-side recent views
- 不做默认团队视图自动应用
- 不做跨租户共享

本轮只聚焦：

让 `Workflow Hub` 具备最小可用、后端持久化、租户内可复用的 `team views`，并确保 live dev 环境可直接验证。 
