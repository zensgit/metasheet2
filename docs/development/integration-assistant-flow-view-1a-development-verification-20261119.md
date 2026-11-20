# 集成助手 1a：规则的只读「流程视图」——开发及验证报告（2026-11-19）

> 状态：已合入 main（PR #6948，评审头 `fb4725f3d`，squash 合并 `dae0b9653`，owner 2026-11-20 方向卡「CI 绿了就合」）。设计见 `integration-assistant-flow-view-1a-design-20261119.md`。
> 本文不授权部署、开关或任何真实读写；1a 本身也不含这些。
> `independentHumanReviewClaimed=NO`：这里记录的是自动化测试与 AI 自审，不冒充独立人工评审。

## 1. 交付内容

| 文件 | 变化 |
|---|---|
| `apps/web/src/multitable/automationFlowView.ts` | 新增：规则 → 流程模型的纯函数 |
| `apps/web/src/multitable/components/MetaAutomationFlowView.vue` | 新增：只读弹层 |
| `apps/web/src/multitable/components/MetaAutomationManager.vue` | 规则卡「流程视图」按钮 + 弹层接线（+17 行） |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | 标签键 `manager.viewFlow`（+3 行） |
| `apps/web/tests/automation-flow-view.spec.ts` | 新增 12 例 |
| `apps/web/tests/multitable-automation-manager.spec.ts` | 新增 1 例 |
| `apps/web/scripts/run-required-web-tests.sh` / `.tokens` | 登记 `automation-flow-view`，token 清单重生 |
| `.github/workflows/multitable-web-guard.yml` | 两处路径表与 vitest 列表加入新文件 |

不改后端、不加开关、不加迁移。

## 2. 用例

`automation-flow-view.spec.ts`：
1. 没有 `actions` 数组时取旧的单动作对；
2. 多动作按执行顺序，顶层步骤键 `0`、`1`，摘要正确；
3. 条件分支 / 并行分支子步的步骤键用分支**键**（`1.branch.urgent.0`、`1.branch.otherwise.0`、`2.parallel.left.0`），默认分支标记正确，空分支为空；
4. I 链：cron 触发显示「表达式 · 时区」，`run_integration_job` 显示「备料拉取，N 个项目」；未配置时显示「未配置」；`integration.run_finished` 显示作业种类与结果；
5. 间隔触发「每 N 分钟」、未配置的 cron 显示占位；
6. 规则条件组为空时不显示条件闸，有成员时显示；
7. 读保存形状（`create_record.sheetId/data`、钉钉群 / 个人的目标计数、`start_approval.formDataMapping`、审批回写 `mappings/confirmationHash`）；
8. 不认识的动作类型显示原始类型名、分类「动作」；
9. 隐藏或没有规则时不渲染；
10. 渲染触发、条件闸、每张步骤卡与分支子步，且弹层内没有任何 input / select / textarea；
11. 关闭按钮与背景点击各发一次 `close`；
12. 没有动作时显示空状态。

`multitable-automation-manager.spec.ts` 新增：规则卡按钮打开弹层、步骤键为 `0`、关闭后弹层消失。

## 3. 执行记录

| 检查 | 命令（在 `apps/web`） | 结果 |
|---|---|---|
| 相关单测 | `pnpm exec vitest run automation-flow-view multitable-automation-manager.spec meta-automation-labels automation-action-summary --reporter=dot` | 4 个文件 195 例全过 |
| 变异见证 | 把分支子步步骤键拼成 `${parentIndex}.${kind}.${j}`（去掉分支键） | 2 例变红（用例 3、10），已恢复 |
| 类型检查 | `pnpm exec vue-tsc --noEmit -p tsconfig.app.json` | 0 错 |
| 必跑清单 | 仓库根 `node scripts/ops/required-web-lane-token-manifest.mjs --check` | MANIFEST MATCHES |
| 清单形状 | `pnpm exec vitest run run-required-web-tests-shape` | 5/5 |

## 4. 远端 CI

- 第一次：`unit (20.x)` 红。日志显示后端 1630 个测试文件 30221 例全部通过，红的是 3 个 `[vitest-worker]: Timeout calling "onTaskUpdate"` 未处理错误，发生在后端鉴权守卫测试文件运行期间，与本 PR（只改前端）无关；`test (20.x)` 是它的汇总，随之红。
- 按惯例只重跑失败作业一次：全部通过，35 项成功、1 项按设计跳过（Strict E2E）。
- 合并前核对：本 PR 的 9 个文件在 `dae0b9653` 上与评审头 `fb4725f3d` 逐字节相同。

## 5. 界面

用一个不入库的临时页面以合成数据渲染了弹层并截图自检（中文、分支两列、步骤键、条件闸）；截图随 1b 的 PR 说明一并给出。

## 6. 已知限制

- 视图只读；编辑在 1b。
- 分支只展开一层（与保存门允许的嵌套一致：一层分支）；分支内若有更深结构，只显示子步摘要。
- 摘要里的数据表 id、模板 id 显示原值，不解析成名称（沿用 `automationActionSummary.ts` 的既有做法）。
