# Workflow Hub Saved Views 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `Workflow Hub` 的筛选、排序和分页状态同步到了 URL query，并补了 next-page prefetch。但仅靠 query 仍有一个明显缺口：

1. 用户可以复制 URL，却不能把“常用工作视角”沉淀成稳定入口
2. `workflow / template` 双面板状态需要手工记忆，不适合高频切换
3. 对运营、流程管理员和实施同学来说，缺少“保存当前视角，下次一键回到这里”的能力

本轮目标是：

1. 给 `Workflow Hub` 增加最小可用的 `saved views`
2. 让用户能保存当前双面板 route state，并一键恢复
3. 让删除动作也具备明确确认和清理语义

## 对标判断

如果对标 `Retool / Notion database views / 飞书多维表格视图入口 / 流程目录型工作台`，仅有 URL query 还不够，至少还需要：

1. 把当前目录视角保存成具名入口
2. 能从当前页面直接恢复筛选上下文，而不是重新输入一遍
3. 删除入口应可见、可确认、可清理

前一轮的 query sync 解决的是“可分享”，这一轮要解决的是“可复用”。

## 设计决策

### 1. 新增 `workflowHubSavedViews.ts`

新增 [workflowHubSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSavedViews.ts)，负责：

- `readWorkflowHubSavedViews()`
- `saveWorkflowHubSavedView()`
- `deleteWorkflowHubSavedView()`

这层只面向 `WorkflowHubRouteState`，不耦合具体页面组件，避免把 `localStorage` 规则散在 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 里。

### 2. 采用浏览器本地存储，而不是立即做后端持久化

本轮没有把 saved views 做成后端资源，而是先采用浏览器本地存储：

- 实现最小
- 足够覆盖当前“单用户 / 单浏览器复用”的主场景
- 不引入新的权限、协作、共享复杂度

后续如果有跨人共享需求，再演进到 server-side saved filters。

### 3. 保存对象是完整的双面板 route state

saved view 保存的不是单个搜索词，而是完整的 [WorkflowHubRouteState](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)：

- workflow search / status / sort / offset
- template search / source / sort / offset

这样应用 saved view 时，`Workflow Drafts` 和 `Template Catalog` 可以一起回到保存时的工作视角。

### 4. 同名视图按规范化名称覆盖

`saveWorkflowHubSavedView()` 按 `trim + lower-case` 规范化名称进行 upsert：

- 避免同一个视角被大小写差异重复保存
- 保持“重存同名视图就是更新”这一直觉

### 5. 显式生成稳定 ID，避免同毫秒冲突

本轮新增 `generateSavedViewId()`：

- 优先使用 `crypto.randomUUID()`
- fallback 到 `Date.now() + random suffix`

原因是浏览器内快速连续保存时，单纯 `Date.now()` 可能在同毫秒内碰撞，导致新视图覆盖旧视图。

### 6. Hub UI 只做最小入口

本轮在 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 增加：

- 顶部 `Save view`
- `Saved Views` 列表区
- `Apply view`
- `Delete`

不做：

- 分组
- 收藏
- 跨人共享
- 批量管理

目的是先把最基础的产品回路打通。

## 超越目标

这轮真正想超越的不是“多一个 localStorage 小功能”，而是让 `Workflow Hub` 从“有 query state 的目录页”进一步升级成“可沉淀个人工作入口的工作台”：

1. 高频目录视角不再依赖手动输入
2. `query sync -> saved view -> later restore` 形成完整闭环
3. 后续如果继续做：
   - recent searches
   - shared team views
   - role-based default views

   已经有清晰承接点

## 本轮不做

- 不做后端保存
- 不做跨人共享
- 不做拖拽排序
- 不做 saved view analytics
- 不改后端 workflow/template list 协议

本轮只聚焦：

让 `Workflow Hub` 具备最小可用、可恢复、可删除的 saved views 能力。
