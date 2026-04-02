# Workflow Designer Persistence / Validation 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 新增 [workflowDesignerValidation.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerValidation.ts)
- 新增 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 新增 [workflowDesignerValidation.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerValidation.spec.ts)
- 更新 [package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

## 本轮结果

### 1. persistence 已从页面中剥离

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 里原先内联的：

- 默认 BPMN XML
- `loadWorkflow`
- `saveWorkflow`
- `deployWorkflow`

已经迁到 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts) 或通过它统一调度。

页面现在只负责：

- 导出当前 XML
- 更新页面 state
- 触发消息提示

### 2. validation 已从页面中剥离

[workflowDesignerValidation.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerValidation.ts) 现在承接了 BPMN 基础规则校验：

- 缺少开始事件
- 多开始事件
- 缺少结束事件
- `Task / Gateway` 缺失入出连接

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 现在只取 element registry，再把结果交给弹窗展示。

### 3. 部署契约已修正到真实可用路径

这轮最重要的行为修正不是“文件拆分”，而是部署动作已经不再沿用页面里的旧请求方式。

当前实现改为：

- 直接从 modeler 导出当前 `BPMN XML`
- 通过 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts) 调用 `/api/workflow/deploy`
- 按 `name + bpmnXml` 的后端真实契约部署

这意味着：

- 部署不再错误依赖旧的 `{ workflowId }` 请求体
- 页面即使没有先保存草稿，也可以基于当前 BPMN 内容完成部署

### 4. visual-definition / BPMN-XML 漂移已被显式隔离

这轮没有掩盖当前后端模型漂移，而是把它明确收进 persistence 层。

当前行为是：

- 如果 `workflow-designer` 返回的是 visual-definition payload 且未包含 `BPMN XML`
- persistence 会抛出显式错误：
  - `当前部署返回的是可视化工作流定义，未包含 BPMN XML，无法直接回填到 BPMN 设计器。`

这比之前在页面里隐式失败再 fallback 到空白流程更清楚，也更利于后续继续统一契约。

### 5. 测试与 lint 门已纳入 WorkflowDesigner 模块

`apps/web` 现在的 lint 脚本已经覆盖：

- `src/views/workflowDesigner*.ts`
- `tests/workflowDesigner*.spec.ts`

本轮新增测试通过后，`apps/web` 包级测试结果已提升到：

- `20 files / 68 tests`

## 验证命令

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充检查：

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果: `200`

## 构建结果

本轮 `apps/web` 构建继续保持稳定：

- 未出现新的 chunk size warning
- 之前收口的 `featureFlags` 混合导入 warning 仍然没有回归
- BPMN runtime 分 chunk 结果保持稳定

关键产物包括：

- `WorkflowDesigner-*.js` 约 `17.32 kB`
- `workflowDesignerRuntime-*.js` 约 `0.24 kB`
- `workflow-bpmn-js-*.js` 约 `234.22 kB`
- `workflow-diagram-js-*.js` 约 `236.00 kB`

## 非阻塞提示

这轮没有新增 `/plm` UI regression 报告。

原因：

- 改动集中在 `WorkflowDesigner`
- 未触碰 `PLM` 联邦协议或 `/plm` 页面逻辑

当前最近一次成功的 `/plm` UI regression 基线仍是：

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

当前仍存在的结构性问题是：

- `workflow-designer` 后端主模型是 `nodes / edges`
- 当前前端 BPMN 设计器主模型是 `BPMN XML`

这已经不再是页面内联逻辑问题，而是后端建模统一问题，留给下一阶段处理更合适。

## 验证结论

这轮改动证明四件事：

1. `WorkflowDesigner` 已从“runtime 已拆、协议仍内联”推进到“runtime / persistence / validation` 三层分离”
2. 页面部署动作已经修正到当前后端真实可用的 `BPMN XML` 契约
3. visual-definition / BPMN-XML 漂移已被显式隔离到 persistence 层
4. 新边界已经进入 `apps/web` 的 test / lint / type-check / build 门禁

也就是说，`WorkflowDesigner` 现在已经适合继续往 `state / SDK / API 统一` 方向演进，而不是继续把协议细节堆回页面。 
