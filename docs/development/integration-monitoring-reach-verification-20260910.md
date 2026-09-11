# 数据工厂「运行监控」到达率补齐 — 验证 (G34, 2026-09-10)

设计见 `docs/development/integration-monitoring-reach-design-20260910.md`。

本文档已含 **#5612 对抗复核（29 代理）终审**后的两项必修：X1（游标与数据不分家 + 失败可见）、
X2（死信行与真实写入按钮必须写明 pipeline），以及审阅人后续反例 **P2（后台轮询撤销用户正在执行的筛选）**
的修复（§3.2）。两个待裁决点已裁：省 pipelineId **不**算越权放宽、不加权限位；
轮询期间**不**禁用筛选维持现状。
本机：Windows 11 / Node 20 / pnpm 9.15.9 / vitest 1.6.1，worktree `metasheet-wt-g34`，分支
`feat/integration-monitoring-reach`（基于 origin/main 11dddc18b）。**后端零改动**（`plugins/`、`packages/` 未触碰）。

## 1. 改动文件

| 文件 | 说明 |
| --- | --- |
| `apps/web/src/services/integration/monitoringQuery.ts` | 新增。纯模块：状态→请求参数、游标推进、分组/计数、**读取闸门**（P2：票据 + 后台读拒绝规则） |
| `apps/web/src/components/integration/IntegrationMonitoringSection.vue` | 筛选/翻页/分组/运行详情/5s 轮询（含卸载清理）；P2：定时器改走独立的 `pollPipelineObservation` prop |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 5 处最小接线：导入、`monitoringQuery` ref + gate、`refreshPipelineObservation` 重写（P2 加第三参 `source`）、新增 `pollPipelineObservation()`、4 个新 prop |
| `apps/web/src/services/integration/workbench.ts` | `IntegrationPipelineObservationQuery.pipelineId` 由必填改为可选（后端本来就可选） |
| `apps/web/tests/integrationMonitoringQuery.spec.ts` | 新增，**20 测试**（17 + P2 闸门 3） |
| `apps/web/tests/IntegrationMonitoringSection.spec.ts` | 既有 2 测试保留 + 14 个 G34/X1/X2 测试 = 16（P2：3 条轮询用例改断言到新 prop） |
| `apps/web/tests/integrationMonitoringReach.spec.ts` | 新增，**12 测试**（9 + P2 反例 3；挂真视图真 loader） |
| `scripts/ops/integration-guard-guarded-paths.mjs`、`scripts/ops/integration-guard-run-web-specs.sh`、`.github/workflows/integration-guard.yml` | **独立 commit**：把 `monitoringQuery.ts` 与两个新 spec 接进 integration-guard（此前在 CI 里一个都没跑，见 §3.2.4） |

## 2. 命令与退出码

| 命令（cwd） | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --offline`（worktree 根） | 0 | 6m3s |
| `npx vitest run tests/integrationMonitoringQuery.spec.ts tests/IntegrationMonitoringSection.spec.ts tests/integrationMonitoringReach.spec.ts`（apps/web） | 0 | 3 files / **48 passed** (20 + 16 + 12)，P2 修复后重跑 |
| 同上，**P2 修复之前** | 1 | 3 files / 2 failed \| 46 passed —— 新增的两条反例用例（见 §3.2） |
| `npx vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/IntegrationWorkbenchRail.spec.ts`（apps/web） | 0 | 4 files / **106 passed**（既有回归，未改这些文件；P2 改了加载器签名后重跑，数字不变） |
| `pnpm --filter web run type-check`（worktree 根） | 0 | vue-tsc -b + 两个 verification tsconfig（P2 后重跑） |
| `npx eslint src/services/integration/monitoringQuery.ts tests/integrationMonitoringQuery.spec.ts tests/integrationMonitoringReach.spec.ts tests/IntegrationMonitoringSection.spec.ts` | 0 | 0 errors（6 个 warning 全是既有的 `vue/one-component-per-file` 等，落在改动前就有的行上） |
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

## 3.2 P2（审阅反例）：后台轮询撤销用户正在执行的筛选

审阅原话：

> [P2] #5612：后台轮询会撤销用户正在执行的筛选。用户选择 failed、请求尚未返回时，5 秒轮询使用旧的 all 条件
> 发起新请求，并让手动请求失效。真实 loader 的内存复现结果是：用户选择 failed，最终显示 all，没有错误提示。
> 慢请求还可能反复失效、一直不刷新。修法：读取未完成时跳过轮询，或完成后再调度；后台请求不能抢占手动意图。

修法与理由见设计文档 §3.2.3。落点：

- `apps/web/src/services/integration/monitoringQuery.ts:281-351` — `createMonitoringReadGate()`
  （`begin(source) / isCurrent / settle / pendingCount`；`'background'` 在有未结算读取时返回 `null`）。
- `apps/web/src/views/IntegrationWorkbenchView.vue:3291-3342` — 加载器第三参 `source`（默认 `'manual'`）、
  `begin()` 返回 `null` 就一个请求都不发、`finally` 里 `settle(ticket)`；新增 `pollPipelineObservation()`。
- `apps/web/src/components/integration/IntegrationMonitoringSection.vue:364-370、:489-512` — 定时器只调
  `props.pollPipelineObservation()`（独立 prop），不再借用操作员那扇门。

### 3.2.1 反例：修前红的原样输出

新增用例（`apps/web/tests/integrationMonitoringReach.spec.ts`，挂真视图 + 真 loader，只替身
`setInterval/clearInterval`）。**在修改 `monitoringQuery.ts` / 视图 / 组件之前**跑同一个 spec：

```
 ❯ tests/integrationMonitoringReach.spec.ts  (12 tests | 2 failed) 7184ms
   ❯ ... > P2: a 5s poll never reverts the filter whose read has not come back yet
     → expected 3 to be 2 // Object.is equality
   ❯ ... > P2: a manual read slower than TWO poll periods still wins, and the poll resumes with ITS condition
     → expected 4 to be 2 // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  tests/integrationMonitoringReach.spec.ts > G34 运行监控到达率 (view → request) > P2: a 5s poll never reverts the filter whose read has not come back yet
AssertionError: expected 3 to be 2 // Object.is equality
- Expected
+ Received
- 2
+ 3
 ❯ tests/integrationMonitoringReach.spec.ts:393:28
    391|     await flushUi()
    392|     // A background read here would carry the OLD condition AND invali…
    393|     expect(runUrls.length).toBe(urlsWhenOperatorAsked)
       |                            ^
 Test Files  1 failed (1)
      Tests  2 failed | 10 passed (12)
```

`expected 3 to be 2` = 手动读取还挂着的时候，轮询**多发了一个请求**（第 3 个 runs URL）。慢请求那条是
`expected 4 to be 2`：两个轮询周期各抢发一次。

因为断言在「轮询发了请求」这一步就停了，审阅人描述的**终局**（"最终显示 all，没有错误提示"）还没被打印出来。
所以又做了一次内存探针：把这条用例的中途断言去掉、并把结尾断言原样改成审阅人的说法
（`selectValue('monitoring-run-status') === ''`、`run_failed` 不在、`run_running` 在、没有
`monitoring-error`），在**修复前**的代码上跑：

```
EXIT 0
 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
restored = True
```

即：修复前，用户选 failed、最终屏幕落在 all、死活没有任何错误提示——审阅人的复现被逐条坐实。探针改完立刻还原
（`restored = True`，`git status` 无残留）。

### 3.2.2 修后绿

```
 Test Files  3 passed (3)
      Tests  48 passed (48)
```

三条新用例（全部挂真视图真 loader）：

1. `P2: a 5s poll never reverts the filter whose read has not come back yet` —— 屏上有 `running` run（定时器活着）
   → 选 `failed`（请求挂起）→ 推进 5s → **runs URL 数量不变**（轮询一个请求都没发）→ 放行手动请求 →
   下拉是 `failed`、`run_failed` 在、`run_running` 不在、没有错误横幅。
2. `P2: a manual read slower than TWO poll periods still wins, and the poll resumes with ITS condition` ——
   死信筛选 `replayed` 的读取挂满**两个**轮询周期 → 两边 URL 数量都不变 → 放行 → 屏上是 `dl_replayed`；
   再推进 5s，轮询**恢复**并且带的是 `status=replayed`（跳过是延后不是停摆，且轮询跟着用户的意图走）。
3. `P2: an in-flight POLL never makes the operator wait, and its late answer is discarded` —— 轮询先发且挂起 →
   用户改筛选，手动请求**立刻发出并渲染**（后台在飞不许挡住操作员）→ 轮询的旧答案最后落地 → 丢弃，不渲染。

另加 3 条纯模块用例（`integrationMonitoringQuery.spec.ts`）：后台读在有未结算读取时被拒绝且之后放行、
手动读永不被拒绝且作废在飞后台读、失败的读取也必须释放名额。

### 3.2.3 P2 变异探针（内存改写 → 跑 3 个 spec → 立即还原，全部 `restored = True`）

| # | 变异 | exit | 3 spec 汇总 | 变红的测试 |
| --- | --- | --- | --- | --- |
| M1 | 去掉序号比较：`isCurrent` 只判票据非空 | 1 | 5 failed / 43 passed | query: `drops a slow EARLIER response…` / `keeps the newest ticket current…` / `P2: a MANUAL read is never refused…`；reach: `a slow EARLIER read cannot repaint the list…(response gate)` / `P2: an in-flight POLL never makes the operator wait…` |
| M2 | 去掉跳过逻辑：后台读不再被在飞读拒绝 | 1 | 4 failed / 44 passed | query: `P2: refuses a BACKGROUND read…` / `P2: a read that FAILED still releases the slot…`；reach: `P2: a 5s poll never reverts the filter…` / `P2: a manual read slower than TWO poll periods…` |
| M3 | `settle()` 变空操作（名额永不释放） | 1 | 4 failed / 44 passed | query: `P2: refuses a BACKGROUND read…` / `P2: a read that FAILED still releases the slot…`；reach: `P2: a manual read slower than TWO poll periods…` / `P2: an in-flight POLL never makes the operator wait…` |
| M4 | 视图把轮询标成 `'manual'`（后台冒充手动） | 1 | 2 failed / 46 passed | reach: `P2: a 5s poll never reverts the filter…` / `P2: a manual read slower than TWO poll periods…` |
| M5 | 组件定时器改回调 `refreshPipelineObservation(true)` | 1 | 4 failed / 44 passed | reach 同 M4 两条；section: `G34: polls every 5s while a run is running…` / `G34: unmount clears the poll timer…` |

M2 连 M1 之外的另一个方向也钉住了：光有序号比较（last-write-wins）**不够**——轮询即使不作废手动读，也会用
旧游标把屏幕改回去，所以必须两条一起在。M4/M5 证明「纯模块正确」不等于「接线正确」：闸门放在加载器里，
但只要视图或组件把后台读伪装成手动读，反例立刻复活。

### 3.2.4 接线补丁：两个新 spec 此前在 CI 里一个都没跑

做 P2 时顺手核了一遍「这些用例在 CI 里真的会跑吗」，答案是**不会**：

- `scripts/ops/integration-guard-run-web-specs.sh:57` 的 vitest 过滤 token 里只有
  `IntegrationMonitoringSection`，按**大小写敏感的路径子串**匹配 —— `integrationMonitoringQuery.spec.ts`
  和 `integrationMonitoringReach.spec.ts`（G34 本 PR 新增、承载 X1 与 P2 反例的两个文件）一个都不命中。
- `apps/web/scripts/run-required-web-tests.sh`（always-on `web-tests` 必需检查）里 grep `[Mm]onitoring`
  零命中。
- `scripts/ops/integration-guard-guarded-paths.mjs` 里也没有 `monitoringQuery.ts` 与这两个 spec：
  以后只改纯模块的 PR 连 integration-guard 都不会触发。

即：变异探针在本机全红，到 CI 就没人跑。这属于「守卫没接线」，所以补了三处（**独立 commit，可单独回滚**）：
roster 加 3 条、`integration-guard.yml` 的 `on.push.paths` 同步加同样 3 条（该仓库的
`integration-guard-required-wiring-contract.test.mjs` Pin 10 要求两者**集合完全相等**）、web 守卫 token
加 `integrationMonitoringQuery integrationMonitoringReach`（各自只命中一个文件，已逐个 `find` 核过，
无子串碰撞）。

合约测试实测（本机需要两个绕行：Windows 没有 `python3` → 拷一个 `python3.exe` 进 PATH；合约的 PyYAML 桥
拒绝 CR，而本工作区是 CRLF（`core.autocrlf=true`，**索引里本来就是 LF**，CI 检出的也是 LF）→ 跑之前把该
yml 临时写成 LF，跑完按字节还原，`restored: True`）：

| 状态 | tests | pass | fail |
| --- | --- | --- | --- |
| 本次接线（3 处都加） | 62 | 56 | 6 |
| 基线：把 3 处全部还原成 HEAD | 62 | 56 | **同样的 6 条** |
| M6：roster/workflow 加了但 web 守卫 token 不加 | 62 | 55 | 7（多的是 `web-specs.sh: every guarded apps/web spec in the roster is actually RUN by the web guard`） |
| M7：roster/token 加了但 `on.push.paths` 不加 | 62 | 55 | 7（多的是 `on.push.paths is exactly the guarded-path roster…`） |

那 6 条恒红的是 `classify() CLI` ×3 与 `resolve-diff CLI` ×3，**改动前后逐条相同**，都是本机 Windows 下
spawn CLI 拿到空 stdout 的环境噪音（基线行已证），不是本次引入。M6/M7 证明这三处必须同时在，
少任何一处仓库自己的合约就红。

## 4. 手动核对的行为

- 首屏（已保存 Pipeline + 默认筛选）请求 URL 与改前完全一致：
  `runs?tenantId=default&pipelineId=pipe_g34&limit=5`、`dead-letters?…&status=open&limit=5`
  （`integrationMonitoringReach.spec.ts` 第 1 个用例逐字符断言）。
- 管道范围选「全部管道」后 URL 里**没有 `pipelineId` 键**（不是空串），且另一条管道的 run 出现在列表里。
- run 状态与死信状态互不串台（run 的 `failed` 不会进死信路由，死信的 `replayed` 不会进 runs 路由）。
- 翻页：`limit=20` → `limit=20&offset=20` → 回到 `limit=20`（首页不带 offset）。
- 票据：读 #1 挂起 → 改筛选发出读 #2 并渲染 → 释放读 #1 → 列表仍是 #2 的数据。
- P2 轮询：手动读在飞时 5s 定时器一个请求都不发；手动读结束后的下一跳恢复轮询，且带的是用户刚选中的条件。

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
7. **P2 遗留**：(a) spinner 不分家——轮询照样把 `observingPipeline` 置 true，刷新按钮会闪一下（纯观感，
   见设计 §5.2）；(b) 一次**永不结算**的读取会让轮询一直停在跳过态（`pendingCount()` 可观测，
   真实 fetch 总会 settle，所以只会出现在被 mock 卡住的测试里）；(c) 后台轮询失败时仍然写
   `monitoringError`（文案是「筛选/翻页未生效」，对一次后台读来说措辞偏硬）——这条是 X1 的既有形状，
   本次不动，以免松掉 X1 的守卫。
8. 本轮未跑 `apps/web` 全量 vitest（上一轮已跑过并逐条比对过 53 个本机噪音红文件）；本轮只跑了
   monitoring 三件套 + 4 个相邻回归 spec + type-check。CI 是裁判。
