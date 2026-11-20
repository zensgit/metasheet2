# 集成助手 1d：流程视图的「最近执行」与模板 A、B——开发及验证报告（2026-11-20）

> 状态：本地实现与验证完成，提交在本地分支 `feat/web-automation-flow-history-1d-20261120`（基于 main `88b63f811`，即 1a #6948、1b #6953、1c #6955 之后），代码提交 `83ef67c32`；未推送、未开 PR。设计见 `integration-assistant-flow-history-1d-design-20261120.md`。
> 本文不授权部署、开关或任何真实读写；1d 本身也不含这些。
> `independentHumanReviewClaimed=NO`：实现与验证由 AI 子代理完成；不冒充独立人工评审。

## 1. 交付内容

| 文件 | 变化 |
|---|---|
| `apps/web/src/multitable/automationFlowHistory.ts` | 新增（104 行）：纯函数——行（时间 / 状态 / 来源 / 步数）、步骤显示状态、`matchExecutionToFlow`（下标 + 类型逐位对应，否则「对不上」） |
| `apps/web/src/multitable/components/MetaAutomationFlowHistory.vue` | 新增（291 行）：「最近执行」段；只调 `getAutomationLogs`；加载 / 失败（固定句 + 重试）/ 空；点选发叠加；样式只用设计令牌 |
| `apps/web/src/multitable/components/MetaAutomationFlowView.vue` | +61 / −2：新增可选 `sheetId` / `client`；嵌入历史段；顶层卡片按叠加显示步骤状态（新增样式只用令牌） |
| `apps/web/src/multitable/automationRecipes.ts` | +123 / −1：`AUTOMATION_RULE_TEMPLATES`（A、B）、`automationRuleTemplateOffers`、`buildAutomationTemplateSeed`；原快捷表单 recipes 不变 |
| `apps/web/src/multitable/components/MetaAutomationManager.vue` | +113 / −2：给流程视图传 `client` / `sheetId`；「从模板新建」按钮与模板面板（锁定项禁用 + 原因）；`openRuleEditorFromTemplate`（打开前复查特性）；`ruleEditorSeed` |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | +22 / −1：可选 prop `seedRule`；`draftFromTemplateSeed`（`draftFromRule` + 动作标为刚添加） |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | 27 个新标签键（中英） |
| `apps/web/tests/automation-flow-history.spec.ts` | 新增（687 行，29 例） |
| `apps/web/scripts/run-required-web-tests.sh` / `.tokens`、`.github/workflows/multitable-web-guard.yml` | 登记新 spec、新组件与新模块（yml 保持 CRLF） |
| 本文与设计文档 | 新增 |

不改后端、不加接口、不加开关、不加迁移、不改保存接口。

## 2. 用例（`automation-flow-history.spec.ts`，29 例）

纯函数（6 例）：
1. 条数与每位类型都对上 → 卡片 `0`/`1` 标成功 / 失败；
2. 模拟且成功显示「模拟」，跳过的尾部保持跳过；
3. 条数不同、任一位置类型不同、规则少一步 → 一律「对不上」，不做部分叠加；
4. 无步骤结果（含 `steps` 缺失）→「无逐步记录」；
5. 旧单动作规则（无 `actions` 数组）按其唯一卡片对应；
6. 行只含 id / 时间（业务时区格式化）/ 状态 / 来源 / 计数，序列化后无输出与错误标记。

流程视图（11 例，挂载组件，客户端为桩）：
7. 以 `(sheet_1, rule_1, 20)` 调一次 `getAutomationLogs`；行内时间、状态、「Source: scheduler」、「2 steps · succeeded 1 · failed 1」、全模拟行「2 steps · simulated 2」、条数徽标；段内无输入控件；
8. 中文：「最近执行」「失败」「2 步 · 成功 1 · 失败 1」；
9. 加载中文字在调用未返回时出现，返回后出行；
10. 空：「This rule has not run yet.」；
11. 失败：`role="alert"` 固定句，页面不含错误原文里的主机与口令样字串；重试再调一次并出行；
12. 无 client 或无 sheetId：不显示该段、不调用，1a 流程照常；
13. 点选对得上的执行 → 两张卡片 `data-step-run-status` 为 success / failed，徽标文字正确；再点清除；「取消选择」清除；
14. 对不上：显示「The rule may have changed…」，卡片无任何状态；
15. 中文对不上文案「规则可能已改动（步骤数或类型与这次执行对不上），无法逐步对应。」；无步骤执行显示「没有逐步记录」；
16. **values-free**：步骤输出、步骤错误、执行错误三个标记在点选前后都不出现在页面文本与 HTML 中；
17. 换规则：按新规则重取，旧叠加清除。

规则管理器（1 例，真实 `MultitableApiClient` + fetch 桩）：
18. 从规则卡片打开流程视图，历史经管理器的客户端走 `GET …/automations/rule_1/logs?limit=20`；点选后没有任何非 GET 请求。

模板（纯函数 3 例 + 管理器 3 例）：
19. 两个模板及各自的特性；四种开关组合中的三种（全关、只开运行动作、只开运行事件）开放情况；快捷表单 recipes 键不变；
20. 模板 A 种子逐字段；
21. 模板 B 种子逐字段，每次调用返回新对象；
22. 全关：两张卡都禁用、带 `data-template-locked` 与点名开关的原因，点击不打开编辑器、无写请求；
23. 只开 `integrationAutomationRunAction`：B 锁、A 开；点 A 打开「New Automation Rule」，触发 `schedule.cron`、cron 输入 `0 6 * * *`、动作为运行集成任务、项目号为空且有保存阻断原因；无写请求；
24. 只开 `integrationAutomationRunEvent`：A 锁、B 开；打开后作业种类控件在，告警状态只勾「失败」；无写请求。

模板 → 保存（5 例）：
25. **A 一致性**：模板只填项目号 `P-001` 保存；手工在空白编辑器里填同名、选 `schedule.cron`、自定义 `0 6 * * *`、选运行集成任务、填 `P-001` 保存；两份保存体深相等且 `JSON.stringify` 相等；触发配置 `{ cron, timezone: 'Asia/Shanghai' }`，动作配置为只试算形状（含默认超时），不含 binding；
26. **B 一致性**：模板只填收件人 `user_1`；手工选「集成运行完成」、把默认告警集取消到只剩「失败」、选站内通知、填同一收件人与同一文案；两份保存体深相等且 `JSON.stringify` 相等；
27. 空的模板 A 有保存阻断原因，点保存不发保存事件；
28. 模板的动作卡默认展开（对照：同形状作为已保存规则装载时默认折叠）；
29. 同时给 `rule` 与 `seedRule` 时以 `rule` 为准。

## 3. 执行记录

全部在 `apps/web` 下执行，均为本代理亲自运行：

| 检查 | 命令 | 结果 |
|---|---|---|
| 指定集合 + 样式守卫 | `pnpm exec vitest run automation-flow-history automation-flow-view automation-rule-editor-flow-mode automation-rule-editor-flow-library multitable-automation-rule-editor multitable-run-integration-job-editor multitable-automation-manager.spec MetaAutomationLogViewer automation-recipes meta-automation-labels automation-action-summary run-required-web-tests-shape ui-foundation-style-guard --reporter=dot` | 13 个文件 645 例全过（最后一次、补第 28 例之后的干净复跑） |
| 类型检查 | `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` | 0 错（两次：中途一次、全部改动后一次） |
| eslint（改动文件） | `pnpm exec eslint <8 个改动 / 新增文件>` | 新代码 0 错；`MetaAutomationManager.vue` 有 2 个 `no-unused-vars` 错（`dingTalkGroupName`、`openEditForm`），经在未改动的基线上复跑确认为既有问题，未处理；spec 有 3 个 `vue/one-component-per-file` 警告（同类 spec 的既有写法） |
| 必跑清单 | 仓库根 `node scripts/ops/required-web-lane-token-manifest.mjs --write` 后 `--check` | MANIFEST MATCHES（655 个 token） |
| token 唯一性 | `automation-flow-history` 在 `apps/web`（除 node_modules）只命中新 spec 文件 | 是 |
| 颜色字面量 | 新组件样式块与流程视图 / 管理器新增行中 hex / rgb 计数 | 0 |

变异见证（每个都先改、跑 `automation-flow-history`、再恢复；恢复后文件哈希与改前一致）：

| 变异 | 结果 |
|---|---|
| `matchExecutionToFlow` 去掉条数检查与类型检查 | 3 例变红（纯函数「对不上」、组件「对不上不叠加」、中文文案） |
| 模板 A 不看特性一律开放 | 3 例变红（纯函数门控、全关时上锁、只开事件时 A 上锁） |
| 种子动作保留「已装载」标记（不设 `persisted: false` / 不清快照） | 起初**存活**——暴露缺口；补第 28 例「模板动作卡默认展开」后复跑变红（1 例） |
| 历史行里渲染步骤输出 | 1 例变红（values-free） |

偏离与原因：
- 模板没有塞进原快捷表单的 `AUTOMATION_RECIPES`：快捷表单只支持 4 种触发 × 2 种动作，其 spec 明确钉住这一点；模板与 recipes 同在 `automationRecipes.ts`，但打开的是高级编辑器。原 recipes 没有门控机制，本片按 1c 节点库的姿态选择「列出、上锁、写原因」，而非隐藏。
- 「规则已改动」的措辞用「规则可能已改动（步骤数或类型与这次执行对不上），无法逐步对应」：暂停中的执行（条数少于动作数）也会走到这里，不能断言规则一定改过。
- 模板 B 用站内通知（最简单的既有通知动作），而非编辑器里已有的钉钉群消息告警模板。
- 加载失败只显示固定句，不像运行日志面板那样显示脱敏后的错误原文（本段要求 values-free）。
- 一致性用例中两个编辑器不同时挂载：同一 jsdom 文档里两个 Element Plus 应用会生成相同的弹层 id，第二个编辑器的下拉会解析到第一个的选项表（1c 记录过同一现象），故改为先存模板一份、卸载、再手工搭一份。
- 中途为确认 eslint 既有错误执行过一次 `git stash` / `git stash pop`，与当时在跑的一轮测试重叠；该轮结果不计，表中数字取其后的干净复跑。

未执行：`pnpm validate:all`、`pnpm lint` 全量、全仓 web 必跑清单全集、真实浏览器截图自检、任何真实后端读取。远端 CI 结果待 PR 上看。

## 4. 已知限制

- 叠加只对顶层步骤；分支 / 并行内的子步没有逐子步结果可标。
- 同条数、同类型但配置改过的规则仍按位置叠加（顶层步骤键就是下标，位置与类型对上时结果确属该位置）。
- 历史取最近 20 次；更早的仍在「查看日志」里看。
- 模板只覆盖 A、B 两个场景；项目号、收件人须作者填写，编辑器原有保存门照常把关。

## 附：主会话复核

- 审阅了 `MetaAutomationRuleEditor.vue`（`seedRule` 经 `draftFromRule` 进入，动作标为新建、无原配置快照）与 `MetaAutomationManager.vue`（模板面板、关闭时清空种子、打开前再查一次开关）的改动。
- 在 `apps/web`：`pnpm exec vitest run automation-flow-history automation-flow-view automation-rule-editor-flow-mode automation-rule-editor-flow-library multitable-automation-rule-editor multitable-automation-manager.spec automation-recipes meta-automation-labels run-required-web-tests-shape ui-foundation-style-guard --reporter=dot` → 10 个文件 541 例全过。
- `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` 0 错；仓库根 `required-web-lane-token-manifest.mjs --check` MANIFEST MATCHES。
- 本片未做界面截图（执行历史需要模拟客户端返回执行记录，临时页面成本高于收益）；上线前在测试环境用真实界面过一遍。
