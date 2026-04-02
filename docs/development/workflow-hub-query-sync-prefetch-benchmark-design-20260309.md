# Workflow Hub Query Sync / Prefetch 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow catalog cache` 做成共享前端层，但 `Workflow Hub` 仍有两个明显的产品缺口：

1. 搜索、筛选、排序、分页状态不会同步到 URL
2. 下一页数据虽然可以缓存，但用户点击 `Next` 前没有预取

这会带来两个直接问题：

- 当前过滤结果无法复制/分享/刷新后保留
- 即使已经有 cache，分页切换也还像“每次都重新请求”

本轮目标是：

1. 把 `Workflow Hub` 的 workflow/template 双面板状态同步到 URL query
2. 把 `Apply`、分页和显式 `Refresh` 的交互语义收紧
3. 在当前页加载成功后预取下一页，进一步放大前一轮 catalog cache 的收益

## 对标判断

如果对标 `Retool / n8n / 飞书流程工作台` 这类目录型工作台，筛选页至少应满足：

1. 过滤和分页状态可通过 URL 重建
2. 用户刷新页面后能回到同一个目录视角
3. `Apply` 会从第一页重新计算结果，而不是停留在历史 offset
4. 当前页加载后，应优先预取下一页以缩短翻页等待

前一轮已经解决了“跨页重复目录请求”，这一轮要解决的是“目录状态本身的可分享性与可连续交互性”。

## 设计决策

### 1. 新增 `workflowHubQueryState.ts`

新增 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)，负责：

- `parseWorkflowHubRouteState()`
- `buildWorkflowHubRouteQuery()`
- `getNextWorkflowHubOffset()`

这样把 `query <-> UI state` 的规则从 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 里拆开，避免页面继续堆内联解析逻辑。

### 2. URL query 分成 workflow/template 两组命名空间

本轮采用：

- `wfSearch / wfStatus / wfSort / wfOffset`
- `tplSearch / tplSource / tplSort / tplOffset`

原因：

- 两个面板都存在搜索、排序、分页
- 必须避免 query key 冲突
- 需要能单独分享某一侧的工作视角

### 3. `Apply` 回第一页，`Refresh` 保持当前页

本轮把交互语义收紧为：

- `Apply` 始终回 `offset = 0`
- 顶部 `Refresh` 保持当前 offset
- 上一页/下一页继续按当前 offset 推进

这样更符合用户对“筛选重算”和“手动刷新”的真实预期。

### 4. 成功加载当前页后，预取下一页

本轮在 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 内部加了基于 [workflowDesignerCatalogCache.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerCatalogCache.ts) 的 next-page prefetch：

- current page success
- 计算 `nextOffset`
- 若仍有下一页，则静默预取

这样能把前一轮的目录 cache 从“减少重复请求”推进到“缩短下一步等待”。

## 超越目标

这轮真正想超越的不是“又多了几个 query 参数”，而是让 `Workflow Hub` 从目录展示页升级成可分享、可回跳、可连续操作的工作台：

1. 当前过滤视角可以直接复制 URL
2. 用户刷新或重新打开后能回到同一状态
3. 翻页体验开始利用前一轮 cache，而不是只把 cache 当实现细节
4. `Hub` 的交互语义开始稳定，后续继续做：
   - saved views
   - recent searches
   - analytics prefetch
   
   才有清晰承接点

## 本轮不做

- 不把 query state 抽成全局 store
- 不做浏览器 back/forward 全量状态回放
- 不修改后端分页协议
- 不继续扩新的 workflow 功能按钮

本轮只聚焦：

让 `Workflow Hub` 具备 shareable query state 和 next-page prefetch，补齐目录型工作台最基础的产品交互能力。
