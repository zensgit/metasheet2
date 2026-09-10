# 数据工厂「运行监控」到达率补齐 — 验证 (G34, 2026-09-10)

设计见 `docs/development/integration-monitoring-reach-design-20260910.md`。

本文档已含 **#5612 对抗复核（29 代理）终审**后的两项必修：X1（游标与数据不分家 + 失败可见）、
X2（死信行与真实写入按钮必须写明 pipeline）。两个待裁决点已裁：省 pipelineId **不**算越权放宽、不加权限位；
轮询期间**不**禁用筛选维持现状。
本机：Windows 11 / Node 20 / pnpm 9.15.9 / vitest 1.6.1，worktree `metasheet-wt-g34`，分支
`feat/integration-monitoring-reach`（基于 origin/main 11dddc18b）。**后端零改动**（`plugins/`、`packages/` 未触碰）。

## 1. 改动文件

| 文件 | 说明 |
| --- | --- |
| `apps/web/src/services/integration/monitoringQuery.ts` | 新增。纯模块：状态→请求参数、游标推进、分组/计数、响应票据 |
| `apps/web/src/components/integration/IntegrationMonitoringSection.vue` | 筛选/翻页/分组/运行详情/5s 轮询（含卸载清理） |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 4 处最小接线：导入、`monitoringQuery` ref + gate、`refreshPipelineObservation` 重写、3 个新 prop |
| `apps/web/src/services/integration/workbench.ts` | `IntegrationPipelineObservationQuery.pipelineId` 由必填改为可选（后端本来就可选） |
| `apps/web/tests/integrationMonitoringQuery.spec.ts` | 新增，17 测试 |
| `apps/web/tests/IntegrationMonitoringSection.spec.ts` | 既有 2 测试保留 + 14 个 G34/X1/X2 测试 = 16 |
| `apps/web/tests/integrationMonitoringReach.spec.ts` | 新增，9 测试（挂真视图：URL / 票据 / X1 失败路径） |

## 2. 命令与退出码

| 命令（cwd） | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --offline`（worktree 根） | 0 | 6m3s |
| `npx vitest run tests/integrationMonitoringQuery.spec.ts tests/IntegrationMonitoringSection.spec.ts tests/integrationMonitoringReach.spec.ts`（apps/web） | 0 | 3 files / **42 passed** (17 + 16 + 9) |
| `npx vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/IntegrationWorkbenchRail.spec.ts`（apps/web） | 0 | 4 files / **106 passed**（既有回归，未改这些文件） |
| `pnpm --filter web run type-check`（worktree 根） | 0 | vue-tsc -b + 两个 verification tsconfig |
| `npx eslint src/services/integration/monitoringQuery.ts tests/integrationMonitoringQuery.spec.ts` | 0 | 0 problems |
| `npx vitest run --watch=false`（apps/web 全量） | 1 | 813 files / 10977 tests：**760 files & 10901 tests passed**，53 files / 76 tests failed，474s |

lint 说明：`apps/web` 的 `lint` 脚本是**白名单**（`src/main.ts`、PLM、workflow 等），本次改动的文件都不在其中，
所以 `pnpm --filter web run lint` 不覆盖它们；上表用 `npx eslint` 直接跑了新文件。
对 `IntegrationWorkbenchView.vue` 直接跑 eslint 会报 2 个 `no-unused-vars` 错误
（`MetaIntegrationFieldRuleAuthoring`、`PlmBomReviewPanel`），这两行在 HEAD 上就存在（`git show HEAD:… | grep` 已核），
与本次改动无关，且该文件不在 lint 白名单里，本 PR 不顺手改（会扩大在飞 PR 的冲突面）。

全量跑的 53 个红文件**没有一个是本次改动的文件**（无 integration/monitoring 相关 spec），已将失败文件名列表逐条比对；
失败原因都是本机既有噪音：`spawnSync … tsx ENOENT`、被 vitest 抓到的 Playwright spec（"Playwright Test did not
expect test() to be called here"）、approvals api mock 导出漂移、以及 813 个文件并行下的 5s 超时。判定以 CI 为准。

## 3. 变异探针（内存改写→跑测→立即还原，全部 `restored=True`，`git status` 无残留）

| # | 变异（改哪一行） | 期望 | 实测退出码 | 变红的测试 |
| --- | --- | --- | --- | --- |
| P1 | `resolveMonitoringPipelineId` 改回"必填 savedPipelineId，空则抛错" | 红 | 1 | `integrationMonitoringQuery`: OMITS pipelineId…/ sends the typed pipelineId…；`IntegrationMonitoringSection`: 全部管道→NO pipelineId / custom id；`integrationMonitoringReach`: reads ACROSS pipelines… / reads across pipelines with no saved pipeline…（3 files / 6 tests failed） |
| P2 | 删掉视图加载器里 `if (!observationGate.isCurrent(ticket)) return`（写入前那次） | 红 | 1 | `integrationMonitoringReach`: a slow EARLIER read cannot repaint the list after a newer read has landed (response gate) |
| P3 | 删掉组件的 `onBeforeUnmount(stopMonitoringPoll)` | 红 | 1 | `IntegrationMonitoringSection`: unmount clears the poll timer… |
| P4 | 轮询 watch 去掉 `else stopMonitoringPoll()` | 红 | 1 | `IntegrationMonitoringSection`: polls every 5s while a run is running, and stops as soon as none is |
| P5 | `offset` 永远发送（含 0） | 红 | 1 | `integrationMonitoringQuery` ×2、`integrationMonitoringReach` ×5，**并且既有的 `IntegrationWorkbenchView.spec.ts` 也红**（首屏 URL 断言 :844） |
| P6 | `hasNextMonitoringPage` 去掉"本页取满"判定 | 红 | 1 | `integrationMonitoringQuery`: offers a next page only when the page came back FULL；`IntegrationMonitoringSection`: paging buttons are disabled at the boundaries… |
| P7 | `normalizeStatus` 不再校验闭集 | 红 | 1 | `integrationMonitoringQuery`: forwards only backend-valid statuses… / normalizes junk… |

P5 额外证明了"首屏 URL 逐字节不变"这条兼容性保证是被既有测试守住的，不只是被新测试守住。

## 3.1 X1 / X2 必修项的证据

**X1（新标签配旧数据、且完全静默）**——三处修法均有测试，且都有变异探针：

- `IntegrationWorkbenchView.vue:3290-3306`：`refreshPipelineObservation(silent, nextQuery?)`，游标只在
  票据仍为最新且读取成功时才与 rows 一起提交；`:3308-3313` catch 里**无条件**写 `monitoringError`。
- `IntegrationMonitoringSection.vue:78-83` 渲染 `data-testid="monitoring-error"`（role=alert）。
- `IntegrationMonitoringSection.vue:405-414`：`applyQuery` 在 finally 里 `filterEpoch += 1`，配合 `v-model`
  的 `updated` 钩子把控件拉回到屏上那批行对应的值。

新增失败路径用例（本波之前三个 spec grep `mockRejected|reject|throw` 零命中）：

- reach: `X1: a filter read that REJECTS shows an error and never relabels the previous rows`
  （死信路由 reject → 错误可见、dl_open 仍在、标题不是 `Dead Letters（discarded）`、下拉回弹到 open）
- reach: `X1: a page turn that FAILS keeps the page indicator and rows on the page that is showing`
  （offset 请求返 500 + 错误体 → 页码仍为第 1 页 / offset 0，行仍是第 1 页）
- reach: `X1: a later SUCCESSFUL read clears the error banner`
- section: `X1: a filter change that did NOT commit snaps the control back and surfaces the error`
- section: `X1: a page turn that did NOT commit leaves the page indicator on the page that is showing`

**X2**：`IntegrationMonitoringSection.vue:188-190` 死信行 `<small>` 写 `· pipeline {{ deadLetter.pipelineId }}`（
`data-testid="dead-letter-meta-<id>"`），`:211` 确认按钮 `:title` 带 pipelineId + “会向目标系统真实写入”；
用例 `X2: every dead-letter row names its pipeline, and so does the real-write confirm button`。

### 变异探针（X1/X2 追加 5 条，均 `restored=True`）

| # | 变异 | exit | 变红的测试 |
| --- | --- | --- | --- |
| X1a | 游标回到“乐观提交”（读前就写 `monitoringQuery.value = query`） | 1 | reach: `a filter read that REJECTS…`、`a page turn that FAILS…`（2 tests） |
| X1b | 删掉 catch 里的 `monitoringError.value = …`（回到完全静默） | 1 | reach: 上面两条 + `a later SUCCESSFUL read clears the error banner`（3 tests） |
| X1c | 删掉 `filterEpoch += 1`（控件不回弹） | 1 | section: `a filter change that did NOT commit snaps the control back…` |
| X2a | 死信行拿掉 `· pipeline …` | 1 | section: `every dead-letter row names its pipeline…` |
| X2b | 确认按钮拿掉 `:title` | 1 | section: 同上 |
| P2b | 重跑票据探针（X1 把游标提交挪到它旁边后，原 P2 的锚点失效）：删 `if (!observationGate.isCurrent(ticket)) return` | 1 | reach: `a slow EARLIER read cannot repaint the list after a newer read has landed (response gate)`（1 failed / 8 passed） |

X1c 只把 section 层用例拖红：reach 层那条断言下拉回弹的用例，因为 `monitoringError` 本身变了也会触发重渲染，
所以在那个场景里 v-model 的 updated 钩子依然能拉回。`filterEpoch` 是为“两次失败错误文字完全相同 → 无 prop 变化”
那一支准备的保险，已在 section 层单独钉住。

## 4. 手动核对的行为

- 首屏（已保存 Pipeline + 默认筛选）请求 URL 与改前完全一致：
  `runs?tenantId=default&pipelineId=pipe_g34&limit=5`、`dead-letters?…&status=open&limit=5`
  （`integrationMonitoringReach.spec.ts` 第 1 个用例逐字符断言）。
- 管道范围选「全部管道」后 URL 里**没有 `pipelineId` 键**（不是空串），且另一条管道的 run 出现在列表里。
- run 状态与死信状态互不串台（run 的 `failed` 不会进死信路由，死信的 `replayed` 不会进 runs 路由）。
- 翻页：`limit=20` → `limit=20&offset=20` → 回到 `limit=20`（首页不带 offset）。
- 票据：读 #1 挂起 → 改筛选发出读 #2 并渲染 → 释放读 #1 → 列表仍是 #2 的数据。

## 5. 没做 / 遗留

1. **时间窗**：runs / dead-letters 后端无 `from/to`，本期不做（UI 里写明原因）。要做需后端先加参数。
2. **运行详情路由**：后端没有 `GET /runs/:id`，本 PR 不新增后端路由；详情只展开列表行已有字段，
   "本页死信数"只统计当前这一页。**运行详情需要后端新增路由，本 PR 不做。**
3. **总数/跳页**：后端不返回总数，只做上一页/下一页；"下一页"是保守判定（取满即可能有），
   因此最后一页取满时点下一页会看到空页——宁可多一页空的，也不藏行。
4. **`observationSummary`**：仍由视图计算（措辞含 "open dead letters"）。死信筛选不是 `open` 时组件改用本地
   计数串，避免谎称 open；这条有专门用例。
5. 死信区的空态引导文案（IU-6）仍写“当前没有 open dead letters”，选了其他状态且结果为空时措辞略偏；
   标题已带当前状态（如 `Dead Letters（replayed）`），文案本身由另一条测试钉长度，本期不改。
6. 未覆盖：真实浏览器/e2e 未跑（无环境），轮询与真实后端的联调未做。
