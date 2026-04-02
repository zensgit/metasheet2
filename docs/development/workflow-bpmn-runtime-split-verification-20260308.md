# Workflow BPMN Runtime Split 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerRuntime.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRuntime.ts)
- 更新 [vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts)

## 本轮结果

### 1. BPMN runtime 已从页面中剥离

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 现在不再直接静态 import：

- `bpmn-js/lib/Modeler`
- BPMN 运行时 CSS

这些依赖已进入 [workflowDesignerRuntime.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRuntime.ts)，并由页面在 `initModeler()` 中按需加载。

### 2. BPMN 大块已拆成多块

构建产物中，原先的单一 `workflow-bpmn` 约 `556.77 kB` 已拆成：

- `workflowDesignerRuntime-*.js` 约 `0.24 kB`
- `workflow-bpmn-vendor-*.js` 约 `21.79 kB`
- `workflow-moddle-*.js` 约 `67.00 kB`
- `workflow-bpmn-js-*.js` 约 `234.22 kB`
- `workflow-diagram-js-*.js` 约 `236.00 kB`

对应 CSS 也已独立到：

- `workflow-bpmn-js-*.css` 约 `108.65 kB`

### 3. 构建大包 warning 已消失

本轮 `pnpm --filter @metasheet/web build` 输出中，已经不再出现：

- `Some chunks are larger than 500 kB after minification`

这说明 BPMN 运行时大包问题已经从“单块超线”收口为“可接受的多 chunk 分层”。

### 4. 与上一轮结果共同成立

当前 `apps/web` 构建侧已经同时满足：

- `featureFlags` 混合导入 warning 消失
- `vendor-element-plus` 从大包降到可控范围
- `workflow-bpmn` 超线 warning 消失

也就是说，这条前端构建尾项已经基本收口完。

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

包级测试结果：

- `18 files / 59 tests` 通过

## 非阻塞提示

本轮没有新增构建 warning。

剩余的优化空间主要已经不是“必须处理的问题”，而是：

- 是否继续细拆 `WorkflowDesigner` 本身
- 是否后续对 BPMN 生态做更激进的按需加载

## 未补跑项

本轮没有新增完整 `/plm` UI regression 报告。

原因：

- 改动集中在 `WorkflowDesigner` runtime 边界与构建切块
- 未改 `/plm` 联邦协议，也未改 `PLM` 业务动作

当前最近一次成功基线仍是：

- [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 验证结论

这轮改动证明三件事：

1. `WorkflowDesigner` 已成为更彻底的按需依赖页
2. BPMN runtime 已从单一大包拆成多块稳定 chunk
3. `apps/web` 的构建 warning 收口已经从“明显未完成”进入“基本完成”阶段
