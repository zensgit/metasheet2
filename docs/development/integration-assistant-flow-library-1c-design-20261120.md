# 集成助手 1c：流程模式的「节点库」与「上线门」——设计（2026-11-20）

> 状态：实现完成，随本 PR（1c）提交；配套开发验证见 `integration-assistant-flow-library-1c-development-verification-20261120.md`。
> 授权：登记册 R-99 ③（第 1 阶段只做前端、不加后端能力、不动开关）。上位方案：`docs/development/takeover-beiliao-20260821/integration-assistant-n8n-plan-20261119.md` §3.3、§7（1c：节点库列出全部动作类型，未开放的上锁并写明原因；上线门页签只读显示相关开关与 O 层门）。
> 前置：1a（PR #6948，`dae0b9653`）、1b（Draft PR #6953，含样式修复 `165a8cdcb`，本分支以 cherry-pick 带上）。values-free。

## 1. 要解决什么

1b 的流程模式只能「+ 添加步骤」加一个默认的「更新记录」，再回表单改类型。1c 让搭流程的人在流程模式里直接看到**所有**能加的步骤、哪些现在加不了以及为什么，并看到这条草稿启用前牵涉哪些开关与门。

硬约束有两条：
- **不能出现第二套规则。** 节点库里一个类型能不能加，必须与表单里「添加动作」后那一行的类型下拉完全一致；
- **不能出现第二种规则 JSON。** 从节点库加一步再保存，必须与在表单里加一行、选同一类型再保存逐字节相同。

## 2. 方案

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 节点库自带一张「可选类型」表 | 在新模块里按开关 / 触发写一份判定 | 不取：这就是第二套规则，迟早与表单漂移 |
| **B. 节点库只问编辑器** | 编辑器把表单已有的判定（`selectableActionTypes`、选项的 `:disabled`、`addAction()` 的拒绝条件）交给一个纯函数，纯函数只负责分组与挑说明文字 | **取**：锁不锁由表单逻辑决定；加步骤走表单的同一条路 |

## 3. 设计

### 3.1 位置

流程模式下、流程卡片之下，一个两页签的面板 `MetaAutomationFlowLibraryPanel.vue`：「节点库」（默认）/「上线门」。1b 的「+ 添加步骤」保持不变（仍加默认类型），节点库与它并列。面板只显示与发事件（`pick(type)`），没有输入框、不取数、不碰开关。

### 3.2 节点库

- **目录**：表单下拉可能出现的全部顶层类型 = `SUPPORTED_SELECTABLE_ACTION_TYPES` + `write_approval_form_values` + `run_integration_job`（16 种）。旧别名 `notify` / `update_field` 不可新建，不列。
- **分组**：用 1a/1b 卡片同一个 `flowStepCategory`：记录 / 消息 / 控制 / 审批 / 集成。每项显示类型名（`automationActionTypeLabel`）与一句话说明。
- **锁的判定（唯一来源）**：对「`addAction()` 将追加的那一行」问表单——
  1. `addAction()` 会拒绝（已有 3 步，或草稿里有「运行集成任务」）→ 每一项都锁，原因就是 1b 已有的 `flowAddBlockedReason`；
  2. 否则，`selectableActionTypes(NEW_ACTION_TYPE, 当前步数 + 1)` 里有它、且 `actionTypeOptionDisabled(type)` 为假 → 开放；否则锁。
  
  为此只做了两处等价改动：`selectableActionTypes` 增加可选参数 `actionCount`（默认取草稿当前步数，表单的每次调用结果不变）；表单下拉选项的 `:disabled` 表达式提成函数 `actionTypeOptionDisabled`，表单与节点库共用。`addAction()` 的默认类型命名为常量 `NEW_ACTION_TYPE`（值不变）。
- **锁的说明文字**：只在锁已定的前提下挑一句话，读的输入就是那些判定本来读的：`record.deleted` 下用表单卡片上已有的同一句（`actionConfig.deletedTriggerSelfMutation`）；审批回写依次说开关未开 / 只能用于「审批完成」/ 只支持「通过」结果；运行集成任务依次说开关未开 / 只能用于定时（cron）/ 必须是唯一步骤。挑不到时用通用句「当前规则不可选此类型」。
- **点选**：`addActionFromLibrary(type)` = `addAction()`，再像表单下拉那样把新行的 `type` 设为所选值并调 `onDraftActionTypeChange`；所选恰是默认类型时不触发（el-select 对同值不发 change）。锁着的项按钮禁用，函数本身也会再拒一次。
- **即将开放**：调用连接（只调已批准的具名操作）、字段转换——「S 线（ADR #6914）未合入」；代码节点——「不在本期（冻结基线 v2.3 :738）」；K3 写回——「永久禁止」。它们只是静态文字，不是按钮、不进 `AutomationActionType` 或任何联合类型。

### 3.3 上线门（只读）

只列这份草稿牵涉的项，全部取自编辑器已经读到的东西：

| 何时出现 | 显示 | 来源 |
|---|---|---|
| 草稿含「运行集成任务」 | 开 / 关 + 注「只试算；真写开关另批（O 层）」 | `featureFlags.hasFeature('integrationAutomationRunAction')`（编辑器原有） |
| 触发是「集成运行完成」 | 开 / 关 | `integrationAutomationRunEvent`（原有） |
| 草稿含「审批回写」 | 开 / 关 | `approvalFwbWriteback`（原有） |
| 草稿含 Webhook / 钉钉 / 邮件 | 只写「按既有的发送开关执行；本页不读取其状态」，**不显示开关状态** | 编辑器不读这些开关，故不声称 |
| 总是 | 规则状态：已保存规则显示已启用 / 已停用；新规则显示「新规则」；注「在规则列表里开关；在这里保存不改变它」 | `props.rule.enabled`（编辑器保存体从不带 `enabled`） |
| 总是 | 「保存只经同一个保存门；本页不改任何开关」 | — |

只看顶层步骤：分支内可写的子步只有更新记录 / 站内通知 / 等待回调，不涉及上表任何开关。

### 3.4 文案与样式

新增 50 个标签键（`editor.library*` / `editor.gates*`，中英）。新组件样式只用设计令牌（`tokens.css`），不写颜色字面量；没有新增 `aria-label`（原编辑器 spec 有「不加 aria-label」的计数守卫）。

## 4. 不做

- 拖拽、搜索、节点库内配置；分支内子步从节点库添加。
- 任何开关的读取以外的动作；任何后端、迁移、保存接口改动。
- 把「即将开放」做成可选类型。

## 5. 风险与取舍

| 风险 | 处理 |
|---|---|
| 节点库与表单判定漂移 | 判定只来自表单函数；用例按 6 个场景逐类型比对节点库与表单新行下拉（真实 el-select） |
| 节点库加出的步骤与表单不同 | 走同一条 `addAction` + `onDraftActionTypeChange`；用例比对保存体深相等 + `JSON.stringify` 相等 |
| 上线门「说多了」 | 只显示编辑器本来就读的三个开关；发送类不显示状态 |
| `selectableActionTypes` 签名改动影响表单 | 新参数有默认值，表单调用不变；原编辑器与 run_integration_job 编辑器全量 spec 回归 |
