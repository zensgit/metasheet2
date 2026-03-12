# Workflow Hub Draft Actions / Recent Templates 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow hub -> template -> designer` 的基础闭环接上，但 workflow 线仍然停在“能进入”，还没有推进到“能高频使用”。

当前缺口主要有三类：

1. draft 列表只能打开，不能直接做生命周期动作
2. 模板目录只能依赖搜索和分页，没有“最近使用”捷径
3. designer 虽然支持模板应用，但缺少对高频模板的二次提速

所以本轮目标不是再补一个新入口，而是把 workflow hub 从“入口页”推进成“日常工作台”。

## 对标判断

如果只保留上一轮能力，workflow 线仍然会有三个实际问题：

1. 用户复制已有草稿时还得重新建草稿再粘贴 BPMN
2. 草稿归档要靠后端状态或数据库手工处理，页面没有生命周期动作
3. 常用模板每次都要重新搜一遍，模板目录缺少“最近使用”记忆

这说明上一轮解决的是“第一次怎么进来”，这一轮需要解决的是“第二次、第三次怎么更快地回来”。

## 设计决策

### 1. Draft action 直接建在 workflow-designer 主 API 上

本轮新增：

- `POST /api/workflow-designer/workflows/:id/duplicate`
- `POST /api/workflow-designer/workflows/:id/archive`

原因很直接：

- 这两类动作都属于 draft lifecycle
- 不应该让前端自己拼接一套复制/归档语义
- 不应该把 workflow hub 退回到 definitions 层或数据库层

复制动作走后端的统一 `saveBpmnDraft()`，归档动作走同一条 draft 保存链，只是把 `status` 收成 `archived`。

### 2. Duplicate 采用“读权限可复制，编辑权限可归档”

复制和归档的权限语义不能混为一谈。

- `duplicate` 允许任何有访问权限的用户执行
- `archive` 要求具备编辑能力

这样可以满足两个产品诉求：

1. 共享草稿的只读协作者也能复制出自己的工作副本
2. 生命周期动作不会落到纯 viewer 手里

### 3. Duplicate name 采用稳定、可递增的 copy 命名

[workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts) 本轮新增了 duplicate name helper。

目标不是做复杂命名系统，而是先解决两个实际问题：

- 第一次复制不产生空名
- 连续复制不生成 `Copy Copy Copy`

所以本轮策略是：

- `审批流程` -> `审批流程 Copy`
- `审批流程 Copy` -> `审批流程 Copy 2`
- `审批流程 Copy 2` -> `审批流程 Copy 3`

### 4. Recent templates 先走前端 local storage，不阻塞主 API

“最近使用模板”这件事，本质上是前端工作台效率能力，不需要一开始就做 server-side profile。

所以本轮把它收成 [workflowDesignerRecentTemplates.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRecentTemplates.ts)：

- 本地持久化
- 去重
- 按最近使用时间排序
- 限制上限数量

这样能快速验证产品价值，而且不需要先引入用户画像表、最近访问表或额外 API。

### 5. WorkflowHub 和 WorkflowDesigner 同时消费 recent templates

这轮不是只把 recent templates 做成一个底层工具函数，而是同时接进两处高频入口：

- [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)

Hub 用于“回到工作台后再次发起”。
Designer 用于“当前画布里快速套用另一套模板”。

这样 recent templates 不再是“有存储但没有入口”，而是形成双入口复用。

## 超越目标

本轮真正想超越的，不是再把一个接口补齐，而是把 workflow 线从“能进来”推进成“能反复高频使用”。

超越点有三个：

1. `WorkflowHub` 从只支持 `Open`，升级到支持 `Duplicate / Archive`
2. `template catalog` 从全量目录检索，升级到带 `Recent Templates` 的高频入口
3. `WorkflowDesigner` 从模板选择器，升级到带最近模板记忆的二次起步入口

也就是说，这轮之后 workflow 这条线不只是入口闭环，而开始具备工作台属性。

## 本轮不做

- 不做服务端 recent templates profile
- 不做 draft 批量归档或批量复制
- 不做 template recommendation / ranking algorithm
- 不做 workflow hub 的 Playwright 全 UI 自动化
- 不做 archived 恢复动作

本轮只聚焦：

把 `duplicate / archive / recent templates` 这三个最接近日常使用的动作收进主产品路径。 
