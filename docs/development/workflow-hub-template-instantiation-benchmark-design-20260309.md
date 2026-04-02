# Workflow Hub / Template Instantiation 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow-designer` 的：

- workflow list API
- template catalog API
- pagination / search / sorting

推进到了可被产品层消费的状态。

但产品入口仍然存在一个明显缺口：

1. `WorkflowHub` 还停在旧的 `/api/workflow/definitions?latest=true`
2. 模板虽然可列出，但还不能形成“选模板 -> 进入 designer -> 继续编辑”的闭环
3. `WorkflowDesigner` 仍然默认从空白 BPMN 开始，没有模板入口

所以本轮目标很明确：

- 把 `WorkflowHub` 升成真正的流程工作台入口
- 把模板从“目录”推进成“可实例化的草稿入口”
- 让 `hub -> template -> designer` 形成真正的产品闭环

## 对标判断

当前真正需要对标的，不是某个页面是否已经存在，而是用户第一次进入 workflow 功能时有没有合理入口。

如果继续维持上一轮状态，会有三个现实问题：

1. 用户只能看到部署后的 definitions，看不到自己正在编辑的 draft
2. 模板目录只能“读”，不能“用”
3. designer 虽然强，但入口还是“从空白画布开始”，产品效率不高

这会让 workflow 线停在“工程能力齐了”，但产品体验仍然偏半成品。

## 设计决策

### 1. WorkflowHub 切换到 draft list + template catalog

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 本轮改成双栏工作台：

- 左侧是 `Workflow Drafts`
- 右侧是 `Template Catalog`

草稿列表直接消费 `listWorkflowDrafts()`，模板目录直接消费 `listWorkflowTemplates()`。

这比旧的 definitions 列表更接近真实产品入口，因为它展示的是：

- 我有哪些草稿
- 我能用哪些模板
- 下一步该从哪里进入设计器

### 2. 模板从目录升级为实例化入口

本轮新增：

- `GET /api/workflow-designer/templates/:id`
- `POST /api/workflow-designer/templates/:id/instantiate`

模板实例化不是让前端自己把 visual definition 变成 BPMN，而是交给 backend：

- backend 解析 template definition
- backend 用现有 `saveWorkflow()` 生成新 draft
- frontend 拿到 `workflowId` 后直接跳转 designer

这个决策的关键价值是：

- 不把 visual template -> BPMN 的转换逻辑复制到前端
- 继续复用 backend 已有的 workflow 保存链路
- 模板入口和 draft model 保持同一条主路径

### 3. WorkflowDesigner 增加模板选择与详情预览

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 本轮增加了模板对话框：

- 可搜索
- 可按 `builtin / database` 来源过滤
- 可分页
- 可查看模板详情、变量和标签
- 可直接“使用模板”

同时支持两种进入方式：

- 从 hub 点击 `Use template`
- 在 designer 内部打开模板对话框重新套用模板

这样 designer 不再只有“空白画布”一种开始方式。

### 4. route query 直接承接模板入口

`WorkflowHub -> WorkflowDesigner` 之间没有再造新的页面状态协议，而是直接用：

- `templateId` query

designer 在无 `workflowId` 时会自动识别 `templateId` 并完成实例化。

好处是：

- hub 逻辑更轻
- designer 仍然是唯一实际编辑入口
- URL 语义直观，也方便后续 deep link

### 5. persistence helper 补齐模板详情与实例化能力

本轮把前端 `workflowDesignerPersistence.ts` 补成了真正的 workflow-designer gateway：

- `listWorkflowTemplates()`
- `listWorkflowDrafts()`
- `loadWorkflowTemplate()`
- `instantiateWorkflowTemplate()`

这意味着后续如果要补：

- template picker 独立页
- workflow drafts 首页
- 最近使用模板
- 模板推荐

都可以继续沿用这条 typed helper 链。

## 超越目标

这轮真正想超越的，不只是“把列表页做出来”，而是让 workflow 线从“API ready”推进到“入口 ready”。

超越点有三个：

1. `WorkflowHub` 从只读 definitions 页，升级成真正的 workflow workbench
2. `template catalog` 从只读目录，升级成可实例化的 draft 入口
3. `WorkflowDesigner` 从只支持空白起步，升级成支持模板起步和二次套用

也就是说，这轮之后，workflow 这条线第一次具备了比较完整的用户入口闭环。

## 本轮不做

- 不做模板预览图或画布缩略图
- 不做模板推荐算法
- 不做 workflow drafts 的批量操作
- 不做 template management/admin 后台
- 不做 Playwright 级 UI 回归自动化

本轮只聚焦一件事：

把 `workflow hub + template catalog + designer` 接成一个真正能走通的产品闭环。 
