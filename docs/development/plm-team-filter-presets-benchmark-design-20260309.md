# PLM Team Filter Presets 对标设计

日期: 2026-03-09

## 目标

前几轮已经把 `/plm` 的本地 `preset / share / import-export / query sync` 机制收成了共享规则层，但这些能力都还是浏览器本地能力。对 `BOM / Where-Used` 这类高频筛选面板来说，当前还缺一层真正能在团队内复用的视角沉淀。

当前缺口有三个：

1. 本地 preset 只能单浏览器复用，无法跨人协同
2. 实施、工艺、审核经常复用的 `BOM path / group` 或 `where-used` 视角，不能后端持久化
3. `/plm` 已经像工作台，但过滤视角还没有最基础的“团队入口”

本轮目标是：

1. 给 `BOM / Where-Used` 增加最小可用的后端持久化 `team presets`
2. 保持 owner 可管理，同时让同租户成员可见、可应用
3. 不破坏现有本地 preset、分享链接和导入导出路径

## 对标判断

如果对标 `Retool shared filters`、`Notion database shared views`、`飞书多维表格共享视图`，当前 `/plm` 虽然已经有本地 preset，但还没有真正的共享层。对 `PLM workbench` 来说，这个缺口比普通列表页更明显，因为：

1. `BOM path` 往往对应工艺或装配层级约定
2. `Where-Used` 过滤条件往往对应审核或替代件分析视角
3. 实机调试、客户演示和实施交付都需要“团队约定好的标准过滤入口”

上一轮解决的是“个人可复用”，这一轮要解决的是“团队可复用”。

## 设计决策

### 1. 新增后端资源 `plm_filter_team_presets`

新增迁移 [zzzz20260309123000_create_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts)，核心字段围绕：

- `tenant_id`
- `owner_user_id`
- `scope=team`
- `kind=bom|where-used`
- `name / name_key`
- `state(jsonb)`
- `created_at / updated_at`

这轮不做“所有成员都可编辑”，只做：

- 同租户可见
- owner 可删除

先把共享入口打通，再决定是否做协作编辑、默认团队视图或更细权限。

### 2. 复用统一的 preset state，而不是新造一套 payload

[plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts) 和 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 继续围绕统一的 `state` 结构工作：

- `field`
- `value`
- `group`

这样 `BOM` 和 `Where-Used` 可以共享一套后端 schema、前端模型和删除/应用逻辑，而不是各自维护一份近似实现。

### 3. API 挂到 `plm-workbench`，不挂到 federation

后端接口放在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)：

- `GET /api/plm-workbench/filter-presets/team?kind=bom|where-used`
- `POST /api/plm-workbench/filter-presets/team`
- `DELETE /api/plm-workbench/filter-presets/team/:id`

原因很直接：

1. 这批数据是 MetaSheet 自己的工作台协作状态，不是上游 Yuantus PLM 的领域对象
2. 如果挂到 federation，会把“上游 PLM 业务数据”和“本地工作台协作数据”混在一起
3. 这层未来还可能承接默认团队 preset、共享 deep-link 或组织级 preset，更适合作为本地 workbench 资源

### 4. 前端抽成共享 composable，而不是复制两份交互

新增 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)，让 `BOM` 和 `Where-Used` 共用：

- 列表刷新
- 保存
- 应用
- 删除
- owner 权限判断
- 错误状态

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 只负责把 `kind` 和当前面板状态接进去，不再自己拼装远程 preset 生命周期。

### 5. UI 不替换本地 preset，而是增加独立的团队区块

[PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue) 和 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue) 本轮没有把已有本地 preset 改掉，而是新增独立的“团队预设”区块：

- Refresh
- Select
- Apply
- Delete
- Name / Group
- Save to Team

这样做的好处是：

1. 不会打断现有本地 preset 和 share-link 使用路径
2. 团队共享和个人本地语义清晰分层
3. 后续如果做“从本地 preset 提升为团队 preset”，已有承接点

### 6. 先守住 live runtime，可实机验证

这轮不仅做源码层实现，还明确把 live backend 切到最新代码，让新路由在 `7778` 上真实可调。这样浏览器 smoke 不只是在静态页面里验证按钮，而是真正走通：

- auth
- list
- save
- apply
- delete

对 `PLM workbench` 这种集成型界面，这一步比单纯单测更有价值。

## 超越目标

这轮想超越的不是“给 `BOM / Where-Used` 多一个保存按钮”，而是把 `/plm` 的过滤机制从“单人本地便利功能”推进到“团队工作台协作入口”：

1. 实施或审核人员可以沉淀标准过滤视角
2. 同租户成员可以直接复用，而不是手工重新录入
3. `/plm` 的 `local preset / share link / team preset` 三层能力开始形成清晰分层

后续如果继续做：

- team default presets
- org-level presets
- shared review workbench entry

已经有明确承接点。

## 本轮不做

- 不做多人共同编辑 team preset
- 不做非 owner 删除或重命名
- 不做跨租户共享
- 不做 `Documents / CAD / Approvals` 的团队预设
- 不做服务端 shared deep-link
- 不把本地 preset 自动迁移到后端

本轮目标很明确：

让 `PLM Workbench` 具备最小可用、后端持久化、同租户可复用的 `BOM / Where-Used team presets`，并保证 live dev 环境可直接验证。
