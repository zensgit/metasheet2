# Workflow Hub History Replay 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `Workflow Hub` 的目录状态同步到了 URL query，也补了 `saved views`。但这两层能力之间还有一个明显断点：

1. URL 虽然会变，但浏览器 `back / forward` 不会把页面本地状态真正回放
2. `Workflow Hub` 初始化时会读取 route state，但 route 变化后不会再次同步到本地 refs
3. 这意味着当前更像“query 可分享”，而不是“历史可回放”

本轮目标是：

1. 让 `Workflow Hub` 具备真实可用的浏览器历史回放能力
2. 让 `query sync -> saved view -> browser back/forward` 三层能力形成闭环
3. 用最小改动把 route replay 变成明确、可测试的前端契约

## 对标判断

如果对标 `Retool / Notion database views / 飞书多维表格 / 工作目录型 Hub`，仅仅能把筛选写进地址栏还不够，至少还需要：

1. 用户点击浏览器返回时，页面结果真的回到上一个视角
2. 前进时，结果能恢复到下一状态
3. 回放不仅是输入框值变化，而是目录数据、URL、筛选控件三者一致

前几轮已经补了：

- shared query state
- next-page prefetch
- saved views

这轮要补的是：`browser history replay`。

## 设计决策

### 1. 在 `workflowHubQueryState.ts` 增加纯比较函数

新增 [isWorkflowHubRouteStateEqual()](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)，把 route state 判等从页面里抽成纯函数。

原因：

- 避免 `WorkflowHubView.vue` 继续堆匿名比较逻辑
- 后续如果扩展到 `saved views / browser history / route guard replay`，都能复用同一套判定
- 更容易做聚焦单测

### 2. `WorkflowHubView.vue` 监听 `route.query`

在 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 内新增 route watcher：

1. `parseWorkflowHubRouteState(route.query)`
2. 与当前本地 refs 组装出的 `currentRouteState()` 比较
3. 若不同，则 `applyRouteState()`
4. 然后执行 `refreshAll()`

这样做的核心是把“浏览器 history -> route query -> 页面状态 -> 目录请求”这一链打通。

### 3. 保持现有 `saved view` 和 `syncHubQuery()` 语义不变

本轮没有改动：

- `saved view` 的保存结构
- `syncHubQuery()` 的写入规则
- `Apply` 回第一页 / `Refresh` 保持当前页 的交互语义

route watcher 只负责“外部 route 变化后的回放”，不改变已有的主动交互逻辑。

### 4. 仍然依赖已有 cache，不重复引入新 store

本轮 route replay 触发 `refreshAll()` 后，目录层仍复用前一轮已有的：

- [workflowDesignerCatalogCache.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerCatalogCache.ts)

这样保持：

- 回放逻辑清晰
- 数据层仍统一
- 不额外引入新的全局 store

## 超越目标

这轮真正想超越的不是“补一个 watch(route.query)”，而是让 `Workflow Hub` 从“可复制 URL 的目录页”升级成“具备真实浏览器工作流语义的工作台”：

1. 用户可以筛选
2. 可以保存视图
3. 可以按浏览器历史来回切换工作状态
4. 页面结果、地址栏和目录请求能够一起回放

这样后续如果继续做：

- shared team views
- route-driven onboarding
- session restore

就不会再建立在一个“地址会变、页面不回放”的假基础上。

## 本轮不做

- 不做 server-side history/session restore
- 不做 back/forward analytics
- 不引入新的全局 state store
- 不改后端分页协议或 cache 协议

本轮只聚焦：

让 `Workflow Hub` 的浏览器 `back / forward` 具备真实可用的 state replay。
