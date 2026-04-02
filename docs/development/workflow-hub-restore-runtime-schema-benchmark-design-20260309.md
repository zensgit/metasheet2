# Workflow Hub Restore / Runtime Schema 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow hub` 推到了“可操作”阶段：

- draft 可以 `Duplicate / Archive`
- 模板目录可以从 `hub` 和 `designer` 双入口进入
- recent templates 已经形成复用状态

但如果只停在这里，workflow 线仍然有两个真实缺口：

1. lifecycle 还不完整，归档后没有恢复动作，复制也不支持显式命名
2. 浏览器实机一跑，就会暴露 dev 库并没有 `workflow_definitions / workflow_templates` 这些运行时依赖表

所以本轮目标不是再补一个孤立按钮，而是把 workflow hub 从“接口上能做事”推进到“本地运行时也能闭环”。

## 对标判断

如果以 `n8n / Retool Workflows / 飞书流程草稿台` 这类工作台做参照，当前缺口很明确：

1. `archive` 没有 `restore`，生命周期不完整
2. `duplicate` 只有默认命名，不适合把同一草稿快速派生到业务线场景
3. 单元测试和 build 虽然能过，但 dev 数据库缺表会让页面一打开就变成运行时假象

这说明上一轮解决的是“操作面”，这一轮需要解决“生命周期完整性 + 运行时真实性”。

## 设计决策

### 1. Restore 继续挂在 workflow-designer draft lifecycle API 上

本轮新增：

- `POST /api/workflow-designer/workflows/:id/restore`

原因：

- `restore` 和 `archive` 属于同一条 draft lifecycle
- 不能把恢复动作再分叉到管理后台或数据库脚本
- 必须继续复用 `saveBpmnDraft()`，这样 `status / shares / executions / visual / bpmnXml` 都还留在同一条 draft model 里

### 2. Duplicate with rename 由 Hub 直接承接

后端 `duplicate` 已经支持可选 `name`，本轮把这个能力前推到 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)。

这样做的意义不只是“多一个 prompt”：

- 用户可以把模板副本直接命名为业务场景名
- 不需要复制完成后再进入 designer 改名
- workflow hub 的工作台属性更完整

### 3. 本轮把“运行时 schema”视为产品能力的一部分

浏览器烟测里真正暴露的问题不是页面报错本身，而是：

- `workflow-designer` 已经围绕 `workflow_definitions` 读写
- `templates` 和 `node-types` 也已经允许读取数据库扩展表
- 但 migration 里并没有这些支撑表

所以本轮新增迁移 [zzzz20260309103000_create_workflow_designer_support_tables.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts)，补齐：

- `workflow_definitions`
- `workflow_templates`
- `workflow_node_library`
- `workflow_analytics`

这个决策的重点是：

- 不再把“本地缺表”当作单纯环境问题
- 把 workflow hub 的真实运行前提纳入版本开发本身

### 4. 烟测以真实交互为准，不停留在空列表

本轮 smoke 不只确认“页面能打开”，还明确验证三件事：

1. hub 能显示 active / archived draft
2. duplicate 能弹出重命名对话框，并用自定义名称创建新 draft
3. restore 确认后，归档 draft 会回到 `draft` 状态并重新显示 `Archive`

这比只看接口返回更接近真实使用。

## 超越目标

本轮真正想超越的不是“又多了一个 POST route”，而是这三点：

1. workflow hub lifecycle 从 `Open / Duplicate / Archive` 升级成 `Open / Duplicate(with rename) / Archive / Restore`
2. workflow-designer 这条线从“代码通过”升级成“本地 dev 数据库可运行”
3. workflow hub 验证从 `unit + build` 升级成带真实浏览器交互的 smoke

也就是说，这轮之后 workflow hub 不只是功能更完整，而是更接近一条能持续本地开发和回归的产品线。

## 本轮不做

- 不做批量 restore / batch archive
- 不做 rename history 或复制来源链路可视化
- 不做 server-side recent templates profile
- 不做 `auth/me` 的 dev-token fallback 重构
- 不做 workflow hub 的整套 Playwright 自动测试脚本入仓

本轮只聚焦：

把 `restore + duplicate rename + runtime schema closure + real browser smoke` 收成一个完整增量。 
