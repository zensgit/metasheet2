# 集成助手 1b：规则编辑器的「表单 / 流程」切换——设计（2026-11-20）

> 状态：实现完成，随本 PR（1b）提交；配套开发验证见 `integration-assistant-flow-mode-1b-development-verification-20261120.md`。
> 授权：登记册 R-99 ③（第 1 阶段只做前端、不加后端能力、不动开关）；owner 2026-11-20 方向卡「#6948 CI 绿了就合，合完接着做 1b」。上位方案：`docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md` §7（1b：流程视图可编辑，复用旧编辑器的草稿模型与保存接口，验收是两种编辑器存出的规则 JSON 逐字节相同）。
> 前置：1a（PR #6948，`dae0b9653`）。values-free。

## 1. 要解决什么

1a 只能看。1b 让人在流程视图里直接调整步骤：排序、删除、添加、点进去配置。硬约束是**不能出现第二种规则**——从流程视图存出的规则必须和从原表单存出的完全一样。

## 2. 方案选择

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 独立的流程编辑器 | 1a 弹层里加编辑，自己组装保存体、调保存接口 | 不取：要重写保存体组装（原编辑器的 `buildPayload` 有逐动作的保留键、指纹相关的逐字节回写规则），极易漂移 |
| **B. 编辑器里的布局切换** | 在现有规则编辑器的「动作」区加「表单 / 流程」切换；流程模式只是同一份 `draft` 的另一种显示 | **取**：增删排序调用编辑器已有函数，保存仍走唯一的 `buildPayload`，逐字节相同由结构保证 |

## 3. 设计

### 3.1 切换

- 「动作」区标题右侧一个两段切换（表单 / 流程），`data-editor-mode`，`aria-pressed`。默认「表单」；每次打开编辑器都重置为「表单」，不持久化。
- 流程模式下，表单的动作行与「添加动作」按钮用 `v-show` 隐藏（保留在页面里，原有的锚点与用例不受影响）；触发与条件区照常显示在上方。

### 3.2 流程面板 `MetaAutomationFlowEditPanel.vue`（新，只负责显示与发事件）

- 触发卡（可点击 → 回表单定位到触发）、条件闸、每个动作一张卡：序号、分类徽标、类型名、一句话摘要，按钮 ↑ ↓ ×「配置」；末尾「+ 添加步骤」。
- 事件 `move(idx, dir)` / `remove(idx)` / `add` / `configure(idx)` / `edit-trigger`，由编辑器接到**已有**的 `moveAction` / `removeAction` / `addAction`。面板自己不改任何数据。
- 摘要直接取编辑器已算好的 `actionSummaries[idx]`，所以两种布局对同一步说的话永远相同。
- 「添加步骤」在原 `addAction()` 会拒绝的情况下禁用并说明原因：已有 3 个步骤；规则里有「运行集成任务」（它必须是唯一步骤，R-69 / R-92）。

### 3.3 编辑器改动 `MetaAutomationRuleEditor.vue`（+92 / −1）

- `editorMode` 状态与切换按钮；
- `flowTrigger`（`schedule.interval` 的草稿用分钟，换算成保存时的毫秒再描述）、`flowSteps`、`flowAddBlockedReason` 三个只读计算属性；
- `configureFlowStep` / `editFlowTrigger` 复用既有的 `scrollToSaveBlockAnchor`；该函数在流程模式下先切回表单、下一帧再展开并滚动。

### 3.4 共享模块

`automationFlowView.ts` 增加 `flowTriggerCard`、`flowStepCategoryLabel` 与类型 `FlowEditStep`；1a 的弹层改用共享的分类标签。新增 11 个标签键（`editor.modeForm` / `editor.modeFlow` / `editor.flow*`）。

## 4. 不做

- 在流程模式里编辑步骤配置、触发或条件（点「配置」回表单编辑）。
- 分支内子步的排序 / 增删（仍在表单里做）。
- 任何后端、开关、迁移、保存接口改动。

## 5. 风险与取舍

| 风险 | 处理 |
|---|---|
| 两种布局存出不同的规则 | 方案 B：同一份草稿、同一个保存；专门用例比对两边保存体（深相等 + `JSON.stringify` 相等），含不被编辑器建模的保留键 |
| 流程模式下的锚点跳转失效 | 所有锚点都在表单里；跳转前统一切回表单 |
| 「添加步骤」与原规则不一致 | 禁用条件逐条镜像 `addAction()` 的拒绝条件，不另立规则 |
| 既有用例被布局改动影响 | 默认表单、`v-show` 保留 DOM；原编辑器全量 spec 回归 |
