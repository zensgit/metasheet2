# PLM Workbench Team Default Views 对标设计

日期: 2026-03-09

## 目标

前两轮已经把 `/plm` 的 `BOM / Where-Used` 做成了后端持久化的 `team presets` 和 `team default presets`，但 `Documents / CAD / Approvals` 仍停留在单会话工作状态：

1. `Documents` 的角色、过滤、排序和列显示无法作为团队标准视角沉淀
2. `CAD` 的 `fileId / otherFileId / review state / review note` 无法作为团队入口重用
3. `Approvals` 的过滤、排序、列配置和备注输入无法后端持久化

本轮目标是：

1. 给 `Documents / CAD / Approvals` 增加统一的后端持久化 `team views`
2. 支持 `save / apply / delete / set default / clear default`
3. 让空的 `/plm` 在无显式 query 且本地状态仍为默认态时，自动恢复团队默认视角

## 对标判断

如果对标 `Notion shared views`、`Retool saved views`、`飞书多维表格共享视图`，`PLM workbench` 现在缺的不是单个按钮，而是“团队工作视角”这一层：

1. 文档审核通常需要固定的角色、过滤词和列配置
2. CAD 评审通常需要固定的对比文件和评审状态入口
3. 审批面板通常需要固定的 `pending / eco / sort / columns` 组合

`BOM / Where-Used` 已经证明这类共享视角对 `PLM` 工作台是高频需求。继续扩到 `Documents / CAD / Approvals`，才能让 `/plm` 真正具备“跨面板团队入口”的一致体验。

## 设计决策

### 1. 新增独立资源 `plm_workbench_team_views`

新增迁移 [zzzz20260309143000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts)，核心字段围绕：

- `tenant_id`
- `owner_user_id`
- `scope=team`
- `kind=documents|cad|approvals`
- `name / name_key`
- `is_default`
- `state(jsonb)`
- `created_at / updated_at`

约束层面：

- 同租户、同 `scope`、同 `kind` 只有一个 `is_default=true`
- 同租户、同 owner、同 `kind`、同名视角采用 upsert

### 2. 不复用 `filter presets` 表，而是允许任意 JSON state

`Documents / CAD / Approvals` 的共享状态不是简单 `field/value/group`：

- `Documents` 需要列显示与排序
- `CAD` 需要双文件 ID 和评审输入
- `Approvals` 需要排序、列显示和备注

因此本轮新增独立 helper [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)，统一做：

- `kind` 归一化
- 任意 JSON state 清洗
- `is_default` 归一化
- DB row -> API item 映射

### 3. API 继续挂在 `plm-workbench`

接口放在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)：

- `GET /api/plm-workbench/views/team?kind=documents|cad|approvals`
- `POST /api/plm-workbench/views/team`
- `DELETE /api/plm-workbench/views/team/:id`
- `POST /api/plm-workbench/views/team/:id/default`
- `DELETE /api/plm-workbench/views/team/:id/default`

原因和前两轮一致：

1. 这批数据是 MetaSheet 自己的 `PLM workbench collaboration state`
2. 不应该挂到 [federation.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/federation.ts)，避免与上游 `Yuantus PLM` 业务对象混层
3. 后续如果扩展到 `org default views` 或跨面板团队入口，仍然有明确承接点

### 4. 前端统一走泛型 composable，而不是复制三套生命周期

新增 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)，让 `Documents / CAD / Approvals` 共用：

- 列表刷新
- 保存
- 应用
- 删除
- 设为默认
- 取消默认
- 默认项自动恢复

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 只负责把本面板当前状态映射成 typed state，并定义“什么时候允许自动套用默认视角”。

### 5. 自动默认恢复只在“空入口 + 默认态”生效

这一轮没有把默认团队视图做成强覆盖。自动恢复只在下面条件下触发：

- URL 没有显式相关 query
- 当前本地状态仍是默认态或空态
- 当前面板未手工选择其它团队视图

这样可以保证：

1. 显式 deep-link 优先
2. 用户已修改的本地状态优先
3. 团队默认只在“空白进入工作台”时作为起始入口

### 6. 文档/CAD/审批三块统一成 typed panel contract

本轮同时更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)，让：

- [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)

都用显式的 `team views` model，而不是把团队视角逻辑散在父页和匿名对象里。

## 超越目标

这轮想超越的不是“再加三个保存框”，而是把 `/plm` 从“局部面板可配置”推进到“跨面板团队标准工作入口”：

1. `Documents` 可以沉淀标准审核视角
2. `CAD` 可以沉淀标准评审入口
3. `Approvals` 可以沉淀标准审核队列视角
4. `/plm` 的 `local preset / team preset / team default view` 分层开始覆盖更多核心面板

这让 `PLM workbench` 更像真正的协作平台子域，而不是单页调试台。

## 本轮不做

- 不做多人共同编辑 team view
- 不做非 owner 删除/设默认
- 不做 org 级默认视角
- 不做跨租户共享
- 不做“一个默认视角联动多个面板”
- 不把这套资源同步到上游 Yuantus PLM

本轮目标非常明确：

让 `Documents / CAD / Approvals` 在 `PLM workbench` 中具备统一的团队视角、默认视角和空入口自动恢复能力，并保证 live dev 环境可直接验证。
