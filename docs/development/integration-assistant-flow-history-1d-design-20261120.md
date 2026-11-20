# 集成助手 1d：流程视图的「最近执行」与模板 A、B——设计（2026-11-20）

> 状态：实现完成，随本切片（1d，第 1 阶段最后一片）提交；配套开发验证见 `integration-assistant-flow-history-1d-development-verification-20261120.md`。
> 授权：登记册 R-99 ③（第 1 阶段只做前端、不加后端能力、不动开关、不加接口）。上位方案：`docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md` §7（1d：执行历史视图与模板 A、B——按流程聚合现有执行日志；「备料 BOM 每日拉取」「拉取失败告警」两个模板）。
> 前置：1a（#6948）、1b（#6953）、1c（#6955），基线 `88b63f811`。values-free。

## 1. 要解决什么

1a 的流程视图只看规则「长什么样」，看不到「跑得怎么样」；搭流程的人要回到规则卡片另开「查看日志」。原型底部的「执行历史」条与「模板」弹窗是第 1 阶段的最后两块。

硬约束：
- **不加接口、不加落值面。** 执行历史只能复用运行日志已经在用的那一个客户端调用；只显示状态、来源与计数，不显示步骤输出。
- **逐步对应不靠猜。** 只有执行记录能无歧义地对上当前规则的步骤卡时才在卡上标结果；对不上就明说。
- **模板只是草稿。** 不自动保存、不启用；保存走编辑器既有保存门；保存体与手工在表单里搭同一条规则逐字节相同。

## 2. 方案取舍

| 问题 | 方案 | 结论 |
|---|---|---|
| 执行历史的数据来源 | A. 新的按流程聚合接口；B. 复用 `MultitableApiClient.getAutomationLogs(sheetId, ruleId, limit)`（运行日志面板同一调用，`GET …/automations/:ruleId/logs`） | **B**：R-99 ③ 不许加接口；该路由返回规则作用域视图，已去掉 `ruleSnapshot` / `triggerEvent` |
| 步骤结果怎么对上卡片 | A. 按 stepKey；B. 按下标 + 类型；C. 按类型模糊匹配 | **B**（理由见 §3.2）：结果里没有 stepKey，C 是猜 |
| 模板放在哪 | A. 扩展快捷表单的 recipes（只认 4 种触发 × 2 种动作）；B. 同一模块里另列「编辑器模板」，打开高级编辑器 | **B**：A、B 两个模板用到 `schedule.cron` + `run_integration_job`、`integration.run_finished`，只有高级编辑器能写；快捷表单 recipes 的 spec 明确钉住「只用快捷表单支持的类型」，不动它 |
| 模板怎么变成草稿 | A. 模板直接写编辑器内部草稿结构；B. 模板给出「已保存规则」形状（无 id），编辑器用自己的 `draftFromRule` 装载 | **B**：不出现第二套草稿模型 |
| 开关关时模板怎么呈现 | A. 隐藏；B. 列出但上锁并写原因 | **B**：沿用 1c 节点库「列出、上锁、写明原因」的姿态；原有 recipes 没有门控机制可循 |

## 3. 设计

### 3.1 「最近执行」（`MetaAutomationFlowHistory.vue`，嵌在 1a 流程视图卡片之下）

- 规则管理器把自己的 `client` 与 `sheetId` 传给流程视图；没有其一就不显示这一段（1a 的流程照常）。
- 打开 / 换规则时调 `getAutomationLogs(sheetId, ruleId, 20)`（`FLOW_HISTORY_LIMIT`；运行日志面板取 50，条带取 20）。
- 每行：时间（运行日志同一个业务时区格式化 `formatBusinessTimestamp(…, { precision: 'second' })`）、执行状态（共用 `automationStatusLabel`）、来源 `triggeredBy`、步数（「N 步 · 成功 a · 失败 b · 跳过 c · 模拟 d」，只列非零项）。
- 状态：加载中 / 加载失败（固定一句 + 重试，**不显示错误原文**，因为原文可能带服务端细节）/ 空（「这条规则还没有执行记录」）。
- 只读：没有输入框、不重跑、不试运行、不写任何东西。
- **values-free**：组件与纯函数都不读 `step.output`、`step.error`、`execution.error`；页面无从显示它们。

### 3.2 逐步叠加（只在能对上时）

证据（基线 `88b63f811`）：
- 结果里没有步骤键：`apps/web/src/multitable/types.ts:1484`（`AutomationStepResult`：actionType / status / simulated / output / error / durationMs）；后端同名接口 `packages/core-backend/src/multitable/automation-executor.ts:912` 也没有。
- 日志路由去掉规则快照，无法拿执行时的规则对比：`packages/core-backend/src/routes/automation.ts:207`。
- 执行器顶层循环每个顶层动作恰好推一条结果、按顺序、`actionType: action.type`；分支 / 并行各推一条汇总结果；失败后为剩余动作逐个推 `skipped`：`automation-executor.ts:2435`（循环）、`:2445` / `:2488` / `:2598`（推结果）、`:2609`（补 skipped）。
- 顶层步骤键就是下标：`packages/core-backend/src/multitable/automation-step-key.ts:22`（`topLevelStepKey`），1a 卡片用的就是它。

规则（`automationFlowHistory.ts` `matchExecutionToFlow`）：
- 结果为空 → 「这次执行没有逐步记录（例如条件未满足）」，不叠加；
- 结果条数 ≠ 当前规则顶层动作数，或任一位置 `actionType` ≠ 该位置动作类型 → 「规则可能已改动（步骤数或类型与这次执行对不上），无法逐步对应」，**整张不叠加**（不做部分叠加）；
- 否则第 i 条结果标在卡片 `steps.${i}` 上：成功 / 失败 / 已跳过 / 模拟（`simulated: true` 且成功时显示「模拟」，其余按原状态）。
- 分支内子步不叠加（日志里没有逐子步结果）。
- 再点同一行或「取消选择」清除叠加；换规则自动清除。

### 3.3 模板 A、B（`automationRecipes.ts` 新增 `AUTOMATION_RULE_TEMPLATES`）

| 模板 | 种子（新规则，无 id） | 开放条件 |
|---|---|---|
| A 备料 BOM 每日拉取 | `schedule.cron` `{ cron: '0 6 * * *', timezone: 'Asia/Shanghai' }` → 唯一动作 `run_integration_job` `{ job: { kind: 'stock_prep_pull', projectNos: [], applyMode: 'dry_run_only' } }` | 会话特性 `integrationAutomationRunAction`（编辑器提供该动作的同一条件） |
| B 拉取失败告警 | `integration.run_finished` `{ job: { kind: 'stock_prep_pull' }, statuses: ['failed'] }` → 唯一动作 `send_notification` `{ userIds: [], message: <固定文案> }` | 会话特性 `integrationAutomationRunEvent`（编辑器提供该触发的同一条件） |

- B 选站内通知而不是 ADR §4.3 的钉钉群消息告警模板：站内通知是最简单的既有通知动作，收件人由作者选，不牵涉群目标绑定。编辑器里原有的「使用告警模板（钉钉群消息）」按钮不受影响。
- 名称预填为模板标题；项目号（A）、收件人（B）留空给作者填，编辑器原有保存门照常拒绝空值。
- 入口：规则管理器「新建」一行加「从模板新建」，展开模板面板；开关关的模板是禁用按钮 + 「未开放」+ 原因（点名开关）；点开放的模板 → 以新规则打开高级编辑器。管理器在打开前再查一次特性，锁着的模板到不了编辑器。
- 编辑器新增可选 prop `seedRule`：`rule` 优先；只有新规则时用 `draftFromRule({ ...seed, id: '', sheetId, enabled: false })` 装载（没有 id，所以「已保存规则」的分支——旧 UTC 保留、Webhook 密钥保留、试运行——都不触发），再把每个动作标成「刚添加」（`persisted: false` → 展开；无原始配置快照 → 保存体只含表单建模的键），因此保存体与手工逐项选出、填同样值的规则相同。
- 从不自动保存、不启用、不改开关。

### 3.4 文案与样式

新增 27 个标签键（`recipe.stockPrep*`、`manager.template*`、`flowHistory.*`，中英）。新组件与新增样式只用设计令牌（`tokens.css` / Element Plus 变量），无颜色字面量；没有新增 `aria-label`（新增的是 `aria-pressed` 与 `role="alert"`）。

## 4. 不做

- 新接口、新落值面、重跑 / 重试按钮、分支子步的逐步结果。
- 显示步骤输出、错误原文或执行错误。
- 模板自动保存、自动启用、改任何开关；模板之外的其他场景。

## 5. 风险与取舍

| 风险 | 处理 |
|---|---|
| 规则改过之后误标结果 | 条数与每个位置的类型都要相等才叠加；否则明说对不上，不做部分叠加 |
| 同类型同条数但配置改过 | 仍按位置叠加：顶层步骤键就是下标，位置与类型都对上时结果确属该位置 |
| 暂停中的执行（条数少于动作数） | 也显示「对不上」；措辞用「可能已改动」，不断言规则一定改过 |
| 模板与手工规则 JSON 不同 | 走同一个 `draftFromRule` + 同一个 `buildPayload`；用例比对深相等 + `JSON.stringify` 相等 |
| 开关关时模板仍能用 | 按钮禁用 + 管理器打开前复查；用例覆盖两种开关的四种组合中的三种 |
