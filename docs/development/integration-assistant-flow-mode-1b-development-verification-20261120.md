# 集成助手 1b：规则编辑器的「表单 / 流程」切换——开发及验证报告（2026-11-20）

> 状态：本地实现与验证完成，随本 PR 提交（Draft，合并须 owner 批）。设计见 `integration-assistant-flow-mode-1b-design-20261120.md`。
> 本文不授权部署、开关或任何真实读写；1b 本身也不含这些。
> `independentHumanReviewClaimed=NO`：实现由 AI 子代理完成，主会话审阅代码并亲自复跑了下列检查；不冒充独立人工评审。

## 1. 交付内容

| 文件 | 变化 |
|---|---|
| `apps/web/src/multitable/components/MetaAutomationFlowEditPanel.vue` | 新增（273 行）：流程面板，只显示与发事件 |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | +92 / −1：切换、三个只读计算属性、两个跳转函数、`scrollToSaveBlockAnchor` 先切回表单 |
| `apps/web/src/multitable/automationFlowView.ts` | +60：`flowTriggerCard`、`flowStepCategoryLabel`、`FlowEditStep` |
| `apps/web/src/multitable/components/MetaAutomationFlowView.vue` | 改用共享分类标签（11 行） |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | 11 个新标签键（中英） |
| `apps/web/tests/automation-rule-editor-flow-mode.spec.ts` | 新增 7 例 |
| `apps/web/scripts/run-required-web-tests.sh` / `.tokens`、`.github/workflows/multitable-web-guard.yml` | 登记新 spec 与新组件 |
| `docs/development/integration-assistant-flow-*-{design,development-verification}-*.md` | 1a、1b 各一对设计 + 开发验证（本文所在） |

不改后端、不加开关、不加迁移。

## 2. 用例（`automation-rule-editor-flow-mode.spec.ts`）

1. 切换按钮存在、默认表单；切到流程后显示触发卡与每个动作一张卡，卡上摘要与表单折叠头的摘要相同；
2. 中文文案：表单 / 流程 / 添加步骤 / 配置；
3. **逐字节相同的保存**：同一条 3 个动作的规则（含 `send_webhook` 的 headers / body / secret 与 `update_record` 的跨表键这类编辑器不建模的保留键）分别在两个编辑器实例里打开；A 用流程模式的 ↓ 和 × 做「下移 + 删除」，B 用表单模式的按钮做同样操作；两边点保存，保存体深相等且 `JSON.stringify` 相等，保留键都在；
4. 「配置」切回表单、对应动作展开并滚动到位；
5. 「添加步骤」调用编辑器的 `addAction`；已有 3 个步骤或含「运行集成任务」时禁用并显示原因；
6. 流程区域内没有配置输入（没有 input / select / textarea），切换按钮在流程区域外；
7. 布局按次：关闭再打开编辑器回到表单。

## 3. 执行记录

实现子代理在 1a 分支上完成后，主会话把 1b 变基到合入 1a 后的 main（`dae0b9653`）、修了一处样式（流程卡片缺 `box-sizing: border-box`，右侧溢出几像素，截图发现），然后复跑：

| 检查 | 命令（在 `apps/web`） | 结果 |
|---|---|---|
| 相关单测（变基后，主会话） | `pnpm exec vitest run automation-rule-editor-flow-mode automation-flow-view multitable-automation-rule-editor multitable-run-integration-job-editor meta-automation-labels automation-action-summary run-required-web-tests-shape --reporter=dot` | 7 个文件 331 例全过 |
| 含规则列表的全集（变基前，子代理） | 上面的集合再加 `multitable-automation-manager.spec` | 8 个文件 454 例全过 |
| 变异见证 ①（主会话复跑） | 面板 ↓ 按钮改发 `move(idx + 1, 1)` | 「逐字节相同的保存」变红，已恢复 |
| 变异见证 ②（子代理） | 「配置」只切回表单、不展开动作 | 「配置」用例变红，已恢复 |
| 类型检查（变基后，主会话） | `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` | 0 错 |
| 必跑清单 | 仓库根 `node scripts/ops/required-web-lane-token-manifest.mjs --check` | MANIFEST MATCHES（653 个 token） |
| token 唯一性 | `automation-rule-editor-flow-mode` 只命中新 spec | 是 |

偏离与原因：
- 新 spec 在必跑脚本里放在 `automation-rule-concurrent-merge` 之后，而不是紧挨 `automation-flow-view`：清单形状守卫要求按字母序（忽略大小写）。
- 切换按钮最初带 `aria-label`，导致原编辑器 spec 里两个按无障碍名称计数的用例变红；去掉了这个属性与对应标签键。按钮有可见文字与 `aria-pressed`。

未执行：`pnpm validate:all`、`pnpm lint` 全量（改动文件的 eslint 已过，子代理执行）。远端 CI 结果在 PR 上看。

## 4. 界面

用不入库的临时页面以合成数据渲染流程面板截图自检：触发卡、条件闸、3 张步骤卡（↑ ↓ × 配置）、禁用的「添加步骤」与原因「最多 3 个步骤」。修复溢出后的截图随 PR 说明给出。

## 5. 已知限制

- 流程模式不编辑配置、触发、条件，不处理分支内子步；这些仍在表单里。
- 一条规则至多 3 个动作的上限来自原编辑器界面（`addAction()`），不是本切片新加的；服务端上限另由保存门决定。
