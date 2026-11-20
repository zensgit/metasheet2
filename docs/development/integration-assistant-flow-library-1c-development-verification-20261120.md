# 集成助手 1c：流程模式的「节点库」与「上线门」——开发及验证报告（2026-11-20）

> 状态：本地实现与验证完成，提交在本地分支 `feat/web-automation-flow-library-1c-20261120`（基于 1b 的 `6bd879aca` + cherry-pick 的 1b 样式修复），未推送、未开 PR。设计见 `integration-assistant-flow-library-1c-design-20261120.md`。
> 本文不授权部署、开关或任何真实读写；1c 本身也不含这些。
> `independentHumanReviewClaimed=NO`：实现与验证由 AI 子代理完成；不冒充独立人工评审。

## 1. 交付内容

| 文件 | 变化 |
|---|---|
| `apps/web/src/multitable/automationFlowLibrary.ts` | 新增（251 行）：纯函数——节点库分组、锁的说明文字、「即将开放」静态项、上线门行 |
| `apps/web/src/multitable/components/MetaAutomationFlowLibraryPanel.vue` | 新增（275 行）：两页签面板，只显示与发 `pick`；样式只用设计令牌 |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | +92 / −4：挂面板；`selectableActionTypes` 加可选 `actionCount`；`actionTypeOptionDisabled`（表单下拉与节点库共用）；`NEW_ACTION_TYPE`；`addActionFromLibrary`；`flowLibraryGroups` / `flowGates` 等只读计算属性 |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | 50 个新标签键（中英） |
| `apps/web/tests/automation-rule-editor-flow-library.spec.ts` | 新增（568 行，21 例） |
| `apps/web/scripts/run-required-web-tests.sh` / `.tokens`、`.github/workflows/multitable-web-guard.yml` | 登记新 spec、新组件与新模块 |
| 本文与设计文档 | 新增 |

另：cherry-pick 了 1b 分支的 `165a8cdcb`（1b 切换按钮样式改用设计令牌，UI 基础样式守卫 UF-6），本分支上为 `10127b3e2`。

不改后端、不加开关、不加迁移、不改保存接口。

## 2. 用例（`automation-rule-editor-flow-library.spec.ts`，21 例）

纯函数（4 例）：
1. 分组顺序 记录 / 消息 / 控制 / 审批 / 集成，目录内顺序保留、重复去掉，每项有类型名与说明；
2. 锁的判定只看 `addBlockedReason` / `offered` / `optionDisabled`，说明文字按审批回写、运行集成任务、`record.deleted` 各自的输入挑选；被表单列出的类型无论这些输入如何都开放；
3. 「即将开放」四项及原因原文；它们的 id 都不是动作类型；
4. 上线门：只出现草稿牵涉的行；发送类不声称状态；规则状态与保存行总在。

挂载编辑器（17 例，Element Plus 真实下拉）：
5. 节点库只在流程模式出现；中文页签、分组标题、16 种类型全列、说明文字；开关默认关时审批回写与运行集成任务锁着并点名开关；
6–10. **锁与表单逐类型一致**（`it.each` 5 个场景）：开关全关；`record.deleted`（更新 / 删除 / 锁定记录锁，原因与表单卡片同句）；审批回写开关开但触发不对；运行集成任务开关开但非 cron；cron + 开关开但已有一步（「唯一步骤」）。每个场景先读节点库，再在表单里点「添加动作」读新行下拉的可用项，逐类型断言「节点库开放 ⇔ 表单可选」；
11. 空的 cron 规则 + 开关开：运行集成任务开放，表单新行也提供；
12. `addAction()` 拒绝时：3 步、或含运行集成任务——每一项的锁原因都等于 1b 的拒绝句，点了不加；
13. 点开放项把步骤加进同一份草稿，流程卡片与表单行一致（表单下拉选中值逐行核对）；
14–16. **保存体一致**（`it.each`：锁定记录、等待回调〔类型切换会把执行模式改成 `workflow_job_v1`〕、更新记录〔默认类型，不触发 change〕）：A 用节点库加、B 用表单「添加动作」+ 下拉选；更新记录两边再用表单填同一对字段；两边保存体深相等且 `JSON.stringify` 相等；
17. 「即将开放」不是按钮、内部无可点击元素，点了不加；锁着的动作项是禁用按钮，点了也不加；
18. 上线门：运行集成任务开关关 / 开分别显示「关 / 开」、开关名、O 层注，规则状态「已停用」，保存行；
19. 上线门：审批回写开关开时节点库开放该项、加入后显示「开」；关时节点库锁、无该行；已保存的回写规则开关关时显示「关」；
20. 上线门：「集成运行完成」触发开关、发送类无状态、已启用规则、新规则显示「新规则」；
21. 面板两个页签里都没有输入控件、没有 `aria-label`。

## 3. 执行记录

全部在 `apps/web` 下执行，均为本代理亲自运行：

| 检查 | 命令 | 结果 |
|---|---|---|
| 指定集合 + 样式守卫 | `pnpm exec vitest run automation-rule-editor-flow-library automation-rule-editor-flow-mode automation-flow-view multitable-automation-rule-editor multitable-run-integration-job-editor meta-automation-labels automation-action-summary run-required-web-tests-shape ui-foundation-style-guard --reporter=dot` | 9 个文件 461 例全过（提交前最后一次复跑） |
| 规则列表 | `pnpm exec vitest run multitable-automation-manager.spec --reporter=dot` | 1 个文件 123 例全过 |
| 类型检查 | `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` | 0 错（改动中途一次、提交后一次） |
| eslint（改动文件） | `pnpm exec eslint src/multitable/automationFlowLibrary.ts src/multitable/components/MetaAutomationFlowLibraryPanel.vue src/multitable/components/MetaAutomationRuleEditor.vue src/multitable/utils/meta-automation-labels.ts tests/automation-rule-editor-flow-library.spec.ts` | 0 问题 |
| 必跑清单 | 仓库根 `node scripts/ops/required-web-lane-token-manifest.mjs --write` 后 `--check` | MANIFEST MATCHES（654 个 token） |
| token 唯一性 | `automation-rule-editor-flow-library` 只命中新 spec 文件名 | 是 |

变异见证（每个都先改、跑 `automation-rule-editor-flow-library`、再恢复；恢复后文件哈希与改前一致）：

| 变异 | 结果 |
|---|---|
| 节点库的 `optionDisabled` 改成只看 `isUnsupportedSelectableActionType`（忽略 `isDeletedTriggerBlockedActionType`） | `record.deleted` 场景变红（1 例） |
| `addActionFromLibrary` 只改类型、不调 `onDraftActionTypeChange` | 锁定记录、等待回调两例保存体一致性变红（2 例） |
| 节点库问 `selectableActionTypes` 时不把将追加的那一行计入步数 | 「cron + 已有一步」场景与「空 cron 规则」两例变红（2 例） |

偏离与原因：
- 1b 的「+ 添加步骤」没有改成打开节点库，而是保持原样（加默认类型），节点库作为并列页签：1b 的用例按「点一下就加一步」验收，改它等于改 1b 已合约的行为。
- 新 spec 在必跑脚本里放在 `automation-rule-concurrent-merge` 与 `automation-rule-editor-flow-mode` 之间：清单形状守卫要求忽略大小写的字母序。
- 中途按协调方补充要求 cherry-pick 了 `165a8cdcb`，新组件样式也只用设计令牌；新组件未加入 `ui-foundation-style-guard` 的目标清单（该清单不归本切片），但其样式块经检查无颜色字面量。
- 用例里按行取表单下拉时，选择器 `[data-action-index="1"] .meta-rule-editor__action-header .el-select` 在两个编辑器同时挂载时 jsdom 返回空（原因未深究），改为先取行元素再在行内查找。

主会话复核（#6953 合入 main `7f083d494` 后，1c 变基到其上，去掉已被 squash 吸收的 cherry-pick）：

- 在 `apps/web`：`pnpm exec vitest run automation-rule-editor-flow-library automation-rule-editor-flow-mode automation-flow-view multitable-automation-rule-editor multitable-run-integration-job-editor meta-automation-labels automation-action-summary run-required-web-tests-shape ui-foundation-style-guard --reporter=dot` → 9 个文件 461 例全过；
- `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` 0 错；仓库根 `required-web-lane-token-manifest.mjs --check` MANIFEST MATCHES；
- 新组件样式块颜色字面量计数为 0；
- 用不入库的临时页面（加载 `src/styles/tokens.css`）以合成数据截图自检节点库与上线门两个页签：分组、上锁原因、即将开放、上线门各行显示正确。

未执行：`pnpm validate:all`、`pnpm lint` 全量、全仓 web 必跑清单全集。远端 CI 结果待 PR 上看。

## 4. 已知限制

- 节点库只加顶层步骤；分支内子步仍在表单里加。
- 上线门不读发送类开关（编辑器本来不读），只写明「按既有的发送开关执行」。
- 规则启用状态取的是打开编辑器时加载的规则；在规则列表里改了启用状态需重新打开编辑器才反映。
