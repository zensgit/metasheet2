# 集成助手：流程模式定时摘要与实际保存不一致——修复的开发及验证（2026-11-20）

> 来源：owner 转来的 #6953（1b）审阅结论，P2，冻结审阅头 `165a8cdcb`，合入 `7f083d494`；当时 main `24197d02d` 仍有此问题。
> 授权：登记册 R-99 ③（第 1 阶段只做前端）。本修复只改前端显示，不改保存结果。
> `independentHumanReviewClaimed=NO`。values-free。

## 1. 问题

规则编辑器「流程」模式的触发卡：
1. 已有合法 cron 规则切到流程模式显示「未配置」；
2. 在表单里改了定时预设，流程模式的摘要不反映将要保存的时间。

原因（审阅定位，主会话复核属实）：
- 编辑器的 `flowTrigger` 直接把草稿的 `triggerConfig` 交给展示函数，没用保存路径用的 `effectiveCronExpression`（`buildPayload` 在非自定义预设时把预设写进 `cron`）；
- 共享展示函数 `automationFlowView.ts` 的 cron 分支只读 `expression`，而编辑器保存、加载用的是 `cron`。后端调度器两者都认，顺序是先 `expression` 再 `cron`（`packages/core-backend/src/multitable/automation-scheduler.ts:675-678`）。

1a 的只读流程视图（规则卡「流程视图」）也走同一个展示函数，对用 `cron` 保存的规则同样显示「未配置」。

## 2. 修复

- `automationFlowView.ts`：cron 分支先读 `expression`、再读 `cron`，与调度器顺序一致（同时修好 1a 只读视图）。
- `MetaAutomationRuleEditor.vue` 的 `flowTrigger`：`schedule.cron` 时用 `effectiveCronExpression`（与 `buildPayload` 同一个计算）和 `scheduleTriggerTimezone`（有效时区，旧的 UTC 规则保持 UTC）描述，不再读草稿原值。

## 3. 用例

- `automation-rule-editor-flow-mode.spec.ts` 新增 2 例：
  - 加载 `cron: '15 7 * * 1-5'`、时区 Asia/Shanghai 的规则，切到流程模式，触发卡显示 `15 7 * * 1-5 · Asia/Shanghai`；
  - 同一规则在表单里把预设改成「每周一 0 点」（`0 0 * * 1`），切到流程模式显示 `0 0 * * 1 · Asia/Shanghai`，回表单保存，保存体的 `triggerConfig.cron` 正是 `0 0 * * 1`。
- `automation-flow-view.spec.ts` 新增 1 例：`cron` 字段可读；`expression` 与 `cron` 同时存在时取 `expression`。

## 4. 执行记录（`apps/web`）

| 检查 | 结果 |
|---|---|
| 撤掉两处源码修复（`git stash` 只收 `apps/web/src`），跑 `automation-rule-editor-flow-mode` | 新增 2 例红，其余 7 例绿；恢复后 9/9 |
| `pnpm exec vitest run automation-flow-view automation-flow-history automation-rule-editor-flow-mode automation-rule-editor-flow-library multitable-automation-rule-editor multitable-run-integration-job-editor run-required-web-tests-shape ui-foundation-style-guard --reporter=dot` | 8 个文件 433 例全过 |
| `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` | 0 错 |

没有新文件，不需要改必跑清单或 web 守卫路径。未执行：`pnpm validate:all`、全量 lint。
