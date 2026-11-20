# 集成助手 1a：规则的只读「流程视图」——设计（2026-11-19）

> 状态：已实现并合入 main（PR #6948，squash `dae0b9653`）。本文是事后补齐的设计记录，内容与合入代码一致；配套的开发验证见 `integration-assistant-flow-view-1a-development-verification-20261119.md`。
> 授权：owner 2026-11-19 方向卡，登记册 R-99 ③（第 1 阶段现在趁首发空档做，只做前端、不加后端能力、不动开关）。上位方案：`docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md` §5、§7。
> values-free：不含主机、地址、口令、令牌或客户值；示例数据都是合成的。

## 1. 要解决什么

类 n8n 集成助手的第一步是让人「一眼看懂一条规则在做什么」。现有规则卡只有一行「触发 → 动作 + 动作」，看不到执行顺序、分支里有什么、每一步在执行日志里叫什么。1a 给每条规则加一个只读的流程视图：触发卡在上，步骤卡按执行顺序往下排，分支折叠在所在卡片里。

## 2. 范围

做：
- 规则卡上的「流程视图」按钮（标签键 `manager.viewFlow`，流程视图 / Flow view），打开一个只读弹层。
- 弹层内容：规则名与启用状态；触发卡（类型 + 一行配置说明）；规则有条件时一道「满足规则条件才继续」；每个顶层动作一张卡（分类徽标、类型名、`steps.<键>`、一句话摘要）；条件分支 / 并行分支在卡内按分支分列，子步显示摘要与步骤键；没有动作时显示空状态。

不做：
- 任何编辑、保存、请求（编辑在 1b）。
- 后端改动、开关、迁移。
- 新的规则语义：视图只解释已保存的规则，不认识的东西原样显示。

## 3. 设计

### 3.1 纯函数模型 `apps/web/src/multitable/automationFlowView.ts`

`buildAutomationFlow(rule, { isZh, fieldLabel? })` → `{ ruleId, ruleName, enabled, trigger, hasRuleConditions, steps[] }`。

- **输入是保存后的规则**（后端配置形状，`packages/core-backend/src/multitable/automation-actions.ts` 的各 `*Config`），不是编辑器的草稿模型。动作来源：`rule.actions` 非空时用它，否则用旧的单动作对 `actionType / actionConfig`（`ruleActions`）。
- **步骤键与执行器同一套规则**：顶层 `${i}`，分支子步 `${i}.branch.${key}.${j}` / `${i}.parallel.${key}.${j}`（`packages/core-backend/src/multitable/automation-step-key.ts`）。用分支**键**而不是数组下标，所以视图里的键就是执行日志里的键。
- **摘要复用现有模块**：`savedConfigSnapshot` 把保存后的配置转成 `automationActionSummary.ts` 的快照，再交给 `summarizeAutomationAction`。该模块的原则是「没配的值显示占位，不编造」，1a 沿用。
- **自带说明的三处**：`run_integration_job`（备料拉取 N 个项目 / 管道 id；没配显示「未配置」）、`schedule.cron`（表达式 · 时区）、`schedule.interval`（每 N 分钟）、`integration.run_finished`（作业种类 · 结果集合）。
- **不认识的动作类型**只显示原始类型名，分类为「动作」。

### 3.2 组件 `MetaAutomationFlowView.vue`

只渲染上面的模型。没有输入框、不发请求、没有保存路径；关闭按钮与点背景都发 `close`。样式沿用日志查看器的弹层与原型的卡片 / 连线语言。

### 3.3 接线 `MetaAutomationManager.vue`

规则卡按钮区在「查看日志」旁加「流程视图」；`showFlowView` / `flowViewRule` 两个状态；字段名经 `fields` 解析。

## 4. 风险与取舍

| 风险 | 处理 |
|---|---|
| 视图对规则的解释和执行器不一致 | 步骤键直接照执行器规则拼；摘要走已有的统一摘要模块；只读、不改规则 |
| 保存形状与草稿形状不同导致摘要错 | 单独写 `savedConfigSnapshot` 读保存形状，并有专门用例 |
| 将来新增动作类型 | 落到默认分支显示原始类型名，不会报错也不会编造 |

## 5. 验收

见开发验证文档：纯函数 8 例、组件 4 例、规则列表 1 例；变异见证；类型检查；必跑清单登记；远端 CI。
