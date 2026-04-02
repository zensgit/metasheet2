# Workflow Catalog Cache 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `/workflows` 首屏里的无关请求收掉，但 `Workflow Hub` 和 `Workflow Designer` 之间仍然共享一套目录语义：

1. workflow drafts list
2. template catalog
3. template detail

如果这三类数据在前端仍然各取各的，那么用户从 `Hub -> Designer -> 模板弹窗` 的自然路径里，仍会重复命中相同目录接口。

本轮目标是：

1. 把 `workflow drafts / template catalog / template detail` 提升成共享的前端 catalog cache
2. 让 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 和 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 共用这层缓存
3. 保留用户显式 `Refresh` 时的强制刷新能力
4. 在 `duplicate / archive / restore / save / instantiate` 后自动失效对应 cache，避免“快但脏”的目录状态

## 对标判断

如果对标 `Retool / n8n / 飞书流程工作台` 这类工作台体验，目录型数据至少应满足：

1. 同一个 shell 内的相同目录查询只拉一次
2. 不同页面复用同一目录语义时，不应继续各自维护独立请求状态
3. 用户操作改变目录结果后，缓存必须显式失效
4. 手动刷新应保留“跳过缓存”的明确路径

当前代码已经具备：

- typed persistence helper
- typed route list/template response
- 可观测的 live smoke

所以这轮不再需要扩协议，而是应当把重复目录调用沉到共享前端层。

## 设计决策

### 1. 引入单独的 `workflowDesignerCatalogCache.ts`

新增 [workflowDesignerCatalogCache.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerCatalogCache.ts)，承载：

- `listWorkflowDraftsCached()`
- `listWorkflowTemplatesCached()`
- `loadWorkflowTemplateCached()`
- `invalidateWorkflowDraftCatalogCache()`
- `invalidateWorkflowTemplateCatalogCache()`
- `invalidateWorkflowTemplateDetailCache()`

这样做的原因是：

- 不污染 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts) 里“请求协议与归一化”这一层职责
- 让 cache 成为纯前端编排层，而不是 API helper 的副作用

### 2. 缓存策略采用内存级 `query-key + TTL + in-flight promise coalescing`

本轮 cache 不是本地持久化，而是会话级内存缓存：

- key: `query` 或 `templateId`
- TTL: `30s`
- 已在飞行中的 promise 会被复用

这样足够解决：

- `Hub` 进入时拉一次
- `Designer` 打开模板弹窗再次复用
- 连续点击不会并发重打同一目录

同时也避免把这轮升级成新的本地存储协议设计。

### 3. `Hub` 默认吃缓存，显式 Refresh 强制刷新

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 的策略调整为：

- `onMounted()` 默认命中共享 cache
- 顶部 `Refresh` 按钮走 `force: true`

这能让用户首次进入 `Hub` 和从其他流程页回到 `Hub` 时享受到缓存收益，同时仍然保留显式更新入口。

### 4. 变更型操作负责失效缓存

以下操作现在会主动失效 cache：

- `duplicate`
- `archive`
- `restore`
- `save`
- `instantiate template`

原因：

- drafts list 会因为 `duplicate / archive / restore / save` 变化
- template catalog / detail 会因为 `instantiate` 的 usage 语义变化

这一步是本轮的关键边界，避免“缓存命中了，但列表已经过期”。

## 超越目标

这轮真正想超越的不是“把某个接口少打一遍”，而是把 `workflow hub` 的目录数据提升成真正的前端产品能力：

1. `Hub` 和 `Designer` 共享一套 typed catalog source
2. 首屏/跨页流转不再重复拉同一批目录
3. 用户操作后的失效边界被明确建模
4. 后续如果继续做：
   - shared store
   - background refresh
   - workflow analytics prefetch
   
   都有明确的承接层，而不需要再回头拆页面

## 本轮不做

- 不做 localStorage 级目录持久化
- 不做跨标签页共享缓存
- 不引入全局 Pinia store
- 不继续修改后端 workflow-designer 契约

本轮只聚焦：

把 `workflow drafts / template catalog / template detail` 做成共享的前端 catalog cache，并用真实浏览器路径证明它已经带来跨页复用收益。
