# PLM Team Default Presets 对标设计

日期: 2026-03-09

## 目标

上一轮已经给 `/plm` 的 `BOM / Where-Used` 增加了后端持久化的 `team presets`，但还缺一个更接近真实工作台的入口层：

1. 团队预设虽然可共享，但成员进入页面后仍需要手工点一次 `Apply`
2. 实施、工艺、审核场景往往会有一个“团队标准过滤视角”，而不是一堆平级预设
3. `PLM workbench` 现在已经有本地 preset、分享链接、团队 preset，但还没有“默认团队入口”

本轮目标是：

1. 给 `BOM / Where-Used` 增加最小可用的 `team default preset`
2. 让 `/plm` 在空状态进入时自动应用默认团队视角
3. 保持显式 query、手工输入和本地 preset 的优先级更高，不被默认值覆盖

## 对标判断

如果对标 `飞书多维表格默认视图`、`Notion database default view`、`Retool shared filters`，上一轮的 `team presets` 仍只够“团队共享”，还不够“团队默认入口”。

对 `PLM workbench` 这种场景，默认团队视角的价值更高，因为：

1. `BOM` 经常存在一个默认的装配层级或关键路径筛选
2. `Where-Used` 经常存在一个默认的父件分析口径
3. 客户演示、实施交接和运维排障都希望“打开就是团队标准视图”

上一轮解决的是“共享”，这一轮要解决的是“默认进入点”。

## 设计决策

### 1. 在现有团队预设表上增加 `is_default`

新增迁移 [zzzz20260309133000_add_default_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts)，在 [plm_filter_team_presets](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts) 上增加：

- `is_default boolean not null default false`
- 局部唯一索引 `uq_plm_filter_team_presets_default`

唯一索引约束的是：

- 同一 `tenant_id + scope + kind`
- 最多只有一个 `is_default = true`

这意味着默认值语义是“每个租户、每种面板一个默认团队预设”，而不是“每个人都能设自己的默认”。

### 2. 默认权限沿用 owner 边界

这轮没有新引入更复杂的管理员模型，而是沿用上一轮的最小权限边界：

- 同租户可见
- owner 可删除
- owner 可设为默认
- owner 可取消默认

这是刻意收敛。默认值本质上已经带有“团队入口”含义，如果这轮就放开任意成员改默认，live 验证会马上变得不稳定。

### 3. API 继续挂在 `plm-workbench`

新增接口仍挂在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)：

- `POST /api/plm-workbench/filter-presets/team/:id/default`
- `DELETE /api/plm-workbench/filter-presets/team/:id/default`

而不是挂到 federation。原因不变：

1. 这是 MetaSheet 本地工作台协作状态，不是上游 Yuantus PLM 领域对象
2. 默认视角属于工作台元状态，不应污染上游联邦 API
3. 后续如果扩到 `Documents / CAD / Approvals`，这一层更适合作为本地 workbench 能力继续演进

### 4. 前端默认应用只在“空状态进入”触发

[usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts) 本轮新增了默认自动应用逻辑，但触发条件被刻意收紧：

- 当前没有显式 team preset 选中
- 当前过滤值为空
- 当前字段仍是默认字段
- 路由 query 没有显式带 `bomFilter / whereUsedFilter`
- 同一个默认 preset 不会在同一页面生命周期里反复重放

这一步非常关键。目标不是“每次刷新都强行覆盖本地状态”，而是：

让用户在空白进入 `/plm` 时拿到团队标准入口，同时不打断显式 query、手工录入或后续自定义操作。

### 5. UI 保持上一轮骨架，只加默认动作

[PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue) 和 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue) 本轮只增加三类最小交互：

- `设为默认`
- `取消默认`
- `当前默认：...`

并在下拉项中显式展示 `· 默认` 标记。

这样可以保持上一轮 `team preset` 的认知稳定，不把“默认语义”藏进不可见状态里。

### 6. live runtime 必须跟着切到新路由

这轮除了源码实现，我还专门把 live backend 从旧进程切到新代码。原因很直接：

- 默认预设比普通 CRUD 更依赖真实运行态
- 如果 `7778` 还停在旧进程，浏览器和 API 都会得到“路由不存在”的假阴性

因此这轮设计的一部分，就是保证验证环境本身和代码状态对齐。

## 超越目标

这轮想超越的不是“再加一个按钮”，而是把 `/plm` 的团队共享进一步推进到“团队默认入口”：

1. 团队可以沉淀一个标准 `BOM` 视角
2. 新会话重新打开 `/plm` 时，不需要手工再点 `Apply`
3. `/plm` 的 `local preset / share link / team preset / team default preset` 四层能力开始形成清晰分层

如果后续继续做：

- team default preset 扩到 `Documents / CAD / Approvals`
- org-level default preset
- `PLM workbench` 首页化

已经有明确承接点。

## 本轮不做

- 不做每个用户自己的默认团队预设
- 不做管理员越权改默认
- 不做多面板联动默认
- 不做 `Documents / CAD / Approvals` 默认团队视角
- 不做 server-side user profile 默认入口
- 不做跨租户默认共享

本轮目标很明确：

让 `/plm` 具备最小可用、后端唯一、空状态自动应用的 `team default presets`，并保证 live dev 环境与浏览器烟测都能直接验证。
