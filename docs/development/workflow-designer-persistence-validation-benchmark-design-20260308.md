# Workflow Designer Persistence / Validation 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `Workflow BPMN runtime split` 之后，[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 剩余最重的耦合不再是构建体积，而是页面内部职责混杂：

- BPMN runtime 已独立
- 但 persistence 仍直接写在页面里
- validation 仍直接写在页面里
- 页面还同时承受着一条真实契约漂移

所以本轮目标不是“继续拆文件”本身，而是把 `WorkflowDesigner` 从“页面 + 运行时 + 请求 + 校验”推进到至少三层：

- 页面编排层
- persistence 层
- validation 层

## 对标判断

上一轮已经证明 `WorkflowDesigner` 可以被拆成：

- 页面层
- runtime 层

但如果继续把保存、加载、部署、校验都留在页面里，会有三个问题：

1. 页面仍然承担过多协议细节，不利于继续拆分
2. `save / load / deploy` 无法被单独测试
3. 当前前端 BPMN 编辑器与后端 `workflow-designer` 的定义模型存在漂移，兼容逻辑会继续散落在组件中

这个漂移在代码里是明确存在的：

- 前端编辑器维护的是 `BPMN XML`
- [workflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts) 保存/加载的主模型是 `nodes / edges` 视觉定义
- [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts) 对应的保存/更新契约也是视觉定义导向
- 当前真正能直接接收 `BPMN XML` 并部署的是 [workflow.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow.ts) 的 `/api/workflow/deploy`

## 设计决策

### 1. 新增 persistence 模块

新增 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)。

它负责：

- 提供默认 BPMN XML 模板
- 统一 `load / save / deploy` 请求入口
- 封装响应 envelope / legacy raw payload 的兼容解析
- 把“当前部署未返回 BPMN XML”的错误明确暴露出来

这里有一个关键决策：

- `save / load` 仍保留对当前 `workflow-designer` 路由的兼容包装
- `deploy` 不再误用页面内的旧请求方式，而是直接走 `/api/workflow/deploy`，按 `name + bpmnXml` 的实际契约部署

这样做的原因很直接：

- 当前页面编辑器本质上是 `BPMN XML editor`
- 当前真正与它契合的部署入口是 workflow engine，而不是视觉定义 designer route

### 2. 新增 validation 模块

新增 [workflowDesignerValidation.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerValidation.ts)。

它只负责：

- 检查开始事件
- 检查结束事件
- 检查 `Task / Gateway` 的入出连接

这一步的重点不是“提升验证复杂度”，而是把当前页面内联的 BPMN 基础校验提成纯函数，便于后续继续扩到：

- 命名规范
- 默认流规则
- 孤立节点规则
- 部署前校验

### 3. 页面退回编排层

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 本轮调整为：

- `createNewWorkflow()` 只负责装载默认 XML
- `loadWorkflow()` 只负责把 persistence 结果回填给页面状态和 modeler
- `saveWorkflow()` 只负责导出 XML + 调用 persistence save
- `deployWorkflow()` 只负责导出 XML + 调用 workflow deploy
- `validateWorkflow()` 只负责取 element registry + 调用 validation helper

也就是说，这一轮之后页面不再直接承载请求契约和校验细节。

### 4. 增补聚焦测试

新增：

- [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- [workflowDesignerValidation.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerValidation.spec.ts)

测试覆盖的重点不是 UI 交互，而是：

- legacy / envelope 响应归一化
- visual-definition / BPMN-XML 漂移的显式错误
- deployment payload 构造
- 基础 BPMN 校验规则

## 超越目标

这轮真正想超越的不是“再拆两个文件”，而是顺手把 `WorkflowDesigner` 的真实风险点一起收进去：

1. 不只是拆 persistence / validation
2. 还把部署动作纠正到当前后端真实可用的 `BPMN XML` 契约
3. 还把 visual-definition / BPMN-XML 漂移从页面逻辑里隔离出来
4. 还把这些边界纳入包级 lint / test 门禁

这意味着下一轮如果继续拆：

- 可以继续抽 `designer state`
- 可以继续补 `workflow SDK`
- 可以继续推进 `designer API` 与 BPMN editor 的统一

而不需要反复回到页面里修零散协议问题。

## 本轮不做

- 不试图一次性统一 `workflow-designer` 与 `workflow engine` 的后端模型
- 不把当前 BPMN editor 强行改写成 `nodes / edges` 视觉定义编辑器
- 不引入新的 BPMN 库
- 不新增整页级 WorkflowDesigner E2E 基线

本轮目标是先把 `WorkflowDesigner` 从“运行时已拆、协议仍乱”推进到“运行时、持久化、校验各自成层，且部署契约真实可用”。 
