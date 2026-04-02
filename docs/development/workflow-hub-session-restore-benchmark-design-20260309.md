# Workflow Hub Session Restore 对标设计

日期: 2026-03-09

## 目标

前几轮已经让 `Workflow Hub` 具备了：

1. `query sync`
2. `saved views`
3. `browser history replay`

但仍有一个明显缺口：

1. 用户离开 `/workflows` 再回来时，空路由不会自动恢复到上次工作视角
2. 当前的目录状态仍停留在“本次停留期间可回放”，还没有做到“下次进入可续接”
3. 对流程管理员来说，重新打开 Hub 后还得手动回到刚才的 template/workflow 视角

本轮目标是：

1. 给 `Workflow Hub` 增加最小可用的 `session restore`
2. 让空路由 `/workflows` 能恢复到上次的非默认工作视角
3. 让 `query sync / saved views / history replay / session restore` 四层能力形成闭环

## 对标判断

如果对标 `Retool / Notion database views / 飞书目录型工作台 / admin console`，目录状态通常要满足四层连续性：

1. 当前状态可分享
2. 浏览器返回/前进可回放
3. 命名视角可保存
4. 重新进入页面时可恢复上次工作状态

前几轮已经补了前 3 层，这轮补的是第 4 层。

## 设计决策

### 1. 新增 `workflowHubSessionState.ts`

新增 [workflowHubSessionState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSessionState.ts)，负责：

- `readWorkflowHubSessionState()`
- `writeWorkflowHubSessionState()`
- `clearWorkflowHubSessionState()`
- `shouldRestoreWorkflowHubSessionState()`

这层只面向 [WorkflowHubRouteState](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)，不耦合页面组件。

### 2. session restore 仍采用浏览器本地存储

本轮没有把“上次会话”做成后端资源，而是先用浏览器本地存储：

- 成本最低
- 符合当前单用户 dev/workbench 场景
- 不引入权限与协作复杂度

如果未来做 `team views` 或 server-side resume，再把这层替换成后端持久化即可。

### 3. 只有空路由才会自动恢复

本轮通过 [shouldRestoreWorkflowHubSessionState()](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSessionState.ts) 明确限制：

- 当前 route state 仍是默认值时，才允许自动恢复
- 如果 URL 已经显式带了 query，就不覆盖用户的当前入口

这样避免 `session restore` 和 `shared link / saved view / back-forward replay` 互相打架。

### 4. 恢复后立即写回 URL，并强制刷新目录

在 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 里，本轮恢复链路是：

1. 读取 stored session
2. `applyRouteState()`
3. `syncHubQuery()`
4. `refreshAll({ force: true })`
5. 提示 `已恢复上次 Workflow Hub 会话`

这里显式选择 `force: true`，是为了确保恢复出来的是当前最新目录结果，而不是单纯命中旧 cache。

### 5. 目录刷新成功后持续写入 session

本轮在 `refreshWorkflows()` 和 `refreshTemplates()` 成功后都会调用 `persistSessionState()`，保证：

- 用户只要成功切换过目录状态
- 下次回到空的 `/workflows`
- 就能恢复到最近一次稳定工作视角

## 超越目标

这轮真正想超越的不是“多存一个 localStorage key”，而是把 `Workflow Hub` 从“有很多单点状态能力”推进成“连续可续接的工作台”：

1. 可以分享 query
2. 可以回放 history
3. 可以保存命名视角
4. 现在还能恢复最近一次工作状态

这样后续再做：

- `team views`
- `server-side resume`
- `default entry presets`

都会建立在一个更完整的工作流模型之上。

## 本轮不做

- 不做跨设备 session restore
- 不做多账户共享 session
- 不做 session 历史列表
- 不把 session restore 接到后端 profile

本轮只聚焦：

让空路由 `/workflows` 能自动恢复到上次的非默认工作视角。
