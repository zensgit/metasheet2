# Workflow BPMN Runtime Split 对标设计

日期: 2026-03-08

## 目标

在上一轮完成 `Element Plus scoped loading` 之后，`apps/web` 剩余最明显的构建大包只剩 BPMN 设计器链路：

- `workflow-bpmn` 约 `556.77 kB`

所以本轮目标非常明确：

- 把 `WorkflowDesigner` 从“直接静态依赖整套 BPMN 运行时”推进到“页面逻辑 + 按需 runtime 模块”
- 把 `bpmn-js / diagram-js / moddle / vendor` 从单一大块拆成更细的稳定 chunk
- 让 `apps/web` 构建日志不再保留这条大包 warning

## 对标判断

上一轮已经做完：

- 路由级懒加载
- `featureFlags` 混合导入 warning 收口
- `Element Plus` 从全局入口剥离

这意味着剩余大包已经不再是“平台壳设计问题”，而是 `WorkflowDesigner` 自身对 BPMN 生态的重依赖问题。

如果继续把 `bpmn-js / diagram-js / moddle` 塞进一个 `workflow-bpmn` chunk，会有两个问题：

1. 构建 warning 仍会存在
2. `WorkflowDesigner` 的依赖边界仍然不清晰，页面逻辑和 BPMN 运行时还耦在一起

## 设计决策

### 1. 新增独立 runtime 模块

新增 [workflowDesignerRuntime.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRuntime.ts)。

它只负责：

- 引入 `bpmn-js/lib/Modeler`
- 引入 BPMN 运行时所需 CSS
- 对外提供 `createWorkflowModeler`

这样 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 就不再直接静态依赖 BPMN 运行时。

### 2. 页面改成按需加载 runtime

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 的 `initModeler()` 现在通过动态导入 runtime 模块获取 modeler 工厂。

这一步的目的不是改变业务行为，而是明确区分：

- 页面编排层
- BPMN 编辑器 runtime 层

### 3. 手动 chunk 由“一刀切”改为“按生态分层”

[vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts) 中，原先所有 BPMN 生态都落在一个 `workflow-bpmn` chunk。

本轮调整为：

- `workflow-bpmn-js`
- `workflow-diagram-js`
- `workflow-moddle`
- `workflow-bpmn-vendor`

这样不是单纯“把 warning 藏起来”，而是按依赖生态的真实层次拆开。

## 超越目标

这轮真正想超越的不是“再减少一个 warning”，而是让 `WorkflowDesigner` 更像真正的按需依赖页：

- 页面本身保持轻量
- BPMN 运行时独立存在
- 构建产物体现清晰的依赖边界

完成后带来的收益：

- BPMN 链路不再是单一超线大块
- `WorkflowDesigner` 更容易继续抽运行时、抽编辑器服务
- `apps/web` 主前端的剩余大包问题基本完成收口

## 本轮不做

- 不改 `WorkflowDesigner` 业务逻辑
- 不替换 `bpmn-js`
- 不引入新的 BPMN 编辑器库
- 不补新的完整 `/plm` UI regression 基线

本轮目标很明确：把 BPMN 编辑器从“一个大块”推进到“按需 runtime + 多 chunk 生态分层”。
