# 数据工厂「运行监控」到达率补齐 — 设计 (G34, 2026-09-10)

分支 `feat/integration-monitoring-reach`（基于 origin/main 11dddc18b）。**后端零改动**：本次只把前端能到达的
参数补齐到后端早就支持的范围。

## 1. 后端今天真正支持什么（只读核对，未改）

| 参数 | runs (`GET /api/integration/runs`) | dead-letters (`GET /api/integration/dead-letters`) | 出处 |
| --- | --- | --- | --- |
| `pipelineId` | 可选 | 可选 | `plugins/plugin-integration-core/lib/http-routes.cjs:9639` / `:9674`；`pipelines.cjs:703`、`dead-letter.cjs:129` 都只在值为真时才加谓词 |
| `status` | 可选，闭集 `pending / running / succeeded / partial / failed / cancelled` | 可选，闭集 `open / replayed / discarded` | `pipelines.cjs:27` VALID_RUN_STATUSES（校验在 `:706-707`）；`dead-letter.cjs:7` VALID_STATUSES |
| `limit` | 可选，`asListLimit` 截到 500 | 同左 | `http-routes.cjs:1436` MAX_LIST_LIMIT=500，`:1479` asListLimit |
| `offset` | 可选，`asListOffset` 截到 10000 | 同左 | `http-routes.cjs:1437` MAX_LIST_OFFSET=10000，`:1485` asListOffset |
| `runId` | 无 | 可选（本期未用） | `http-routes.cjs:9679` |
| `includePayload` | 无 | 仅 admin，且本期不用（脱敏面不动） | `http-routes.cjs:9676` |
| 时间窗 `from/to` | **不支持** | **不支持** | 只有 provenance 路由有（`http-routes.cjs:9666`、`pipelines.cjs:725`） |
| 总数 / 分页元信息 | **不返回**（`sendOk(res, 数组)`） | **不返回**（同样是数组） | `http-routes.cjs:9641`、`:9684` |
| 单条运行详情 `GET /runs/:id` | **不存在**（路由表只有 `GET /api/integration/runs`） | — | `http-routes.cjs:270-273` |

两个列表都在 `scopedInput`（`http-routes.cjs:1252-1258`）里带上服务端解析的作用域谓词
（`pipelines.cjs:702`、`dead-letter.cjs:125-128`）。这个作用域**并非两维都经过证明**：
`tenantId` 经过校验（`http-routes.cjs:1028` `resolveTenantId`，不匹配 403 TENANT_MISMATCH / `assertVerifiedTenantClaim`），
而 `workspaceId` 是**客户端自报**（`http-routes.cjs:1248-1250` `resolveWorkspaceId` 直取请求值，无成员校验）——
这是 main 上已有的形状，本 PR 未改变它。

因此“省掉 `pipelineId`”**不是越权放宽**：读取集合仍由服务端 `scopeWhere` 决定，本 PR 之前把任意
pipelineId 粘进输入框就能读到同一批数据，变的只是少一步（已经 29 代理对抗复核终审裁定：不加权限位）。
写入口一行没动。

## 2. 改前的到达率

`IntegrationWorkbenchView.vue` 旧 `buildObservationQuery`（改前 :3256-3265）：先 `savedPipelineId.value.trim()`，
空则 `throw '请先保存 Pipeline'`；再硬编码 `limit: 5`；死信侧固定 `status: 'open'`。全文件没有 `setInterval`。
于是 UI 只能看"某一条管道的最近 5 条 run + 5 条 open 死信"，且没保存过管道时监控区直接报错。

## 3. 这次做了什么

### 3.1 新纯模块 `apps/web/src/services/integration/monitoringQuery.ts`

无 IO、无 Vue，只做「状态 → 请求参数」和游标推进：

- `MonitoringQueryState = { pipelineScope: 'current'|'all'|'custom', pipelineId, runStatus, deadLetterStatus, pageSize, offset }`。
- `createMonitoringQueryState()` 的默认值刻意等于改前的首屏：current + 无 run 状态 + 死信 `open` + `pageSize 5` + `offset 0`。
- `normalizeMonitoringQueryState()` 把 limit 截到 500、offset 截到 10000、**不在闭集里的 status 一律降级成 ''**
  （直接转发会被后端 400，整个监控区就空了）。
- `buildRunsRequestParams` / `buildDeadLetterRequestParams`：`pipelineId` 为空时**整个键省略**（不是空串），
  `offset === 0` 时也省略——`buildQueryString` 只丢 `undefined/null/''`，`offset=0` 会真的出现在 URL 里，
  那会改掉所有既有 URL 断言，也没有任何收益。
- 翻页：`hasNextMonitoringPage(state, receivedCount)` = 「本页取满 ⇒ 可能还有下一页」＋不越过 offset 上限；
  `hasPreviousMonitoringPage` = `offset > 0`。**没有总页数**，因为后端不给总数。
- 前端聚合（后端没有的）：`groupDeadLettersByErrorCode`（按 errorCode 计数，count 降序、code 升序）、
  `countDeadLettersForRun`、`hasRunningRun`。
- `createMonitoringResponseGate()`：请求票据（issue / isCurrent），供加载器丢弃被后发请求超越的旧响应。

### 3.2 `IntegrationMonitoringSection.vue`（展示层 → 拿到控制权）

新增：管道范围下拉（当前 Pipeline / 全部管道 / 指定 ID，指定时才出现输入框）、run 状态下拉、死信状态下拉、
每页条数（5/20/50/100/500）、上一页/下一页 + 页码指示、死信按 errorCode 的计数头部、运行行的「展开运行详情」、
`running` 时的 5 秒轮询与轮询徽标。所有控件只调用纯模块的 transition，再把**新 state** 交给
`applyMonitoringQuery`；组件自己不发请求。筛选控件在读取进行中**不禁用**（改错了筛选不该等一次请求），
安全性由票据兜底。

### 3.2.1 X1（对抗复核必修）：游标与数据不分家，且失败必须可见

初版的 `applyMonitoringQuery` 先写 `monitoringQuery.value = next` 再 silent 地去读，而 silent 分支的 catch
不写状态栏——于是筛选/翻页失败时：标题已变成「Dead Letters（discarded）」、页码已变成第 1 页，
列表里却还是上一批 open 死信，而且**一个字都不说**。操作员据此对其中一行点「确认 Replay（会真实写入）」，
就会 replay 到一条其实还是 open 的死信上。切管道范围与翻页两条路径行内没有任何反证（行不显示 pipelineId、
不带序号），所以不能靠“行自己渲染 status”兼顾。修法三处：

1. `refreshPipelineObservation(silent, nextQuery?)`：`nextQuery` 是**候选**游标，只在读取成功、且通过
   票据后，才与 rows 在同一个 tick 里一起提交（`monitoringQuery.value = query` 紧跟 `pipelineRuns/deadLetters`）。
   失败时游标根本不动，标题/页码/下拉全部停在“屏上这批行”对应的那个查询上。
2. 新增 `monitoringError` ref（视图）+ `data-testid="monitoring-error"`（section）：**无论 silent 与否**都写，
   成功时清空。文案直说“筛选/翻页未生效（仍显示上一次成功的结果）”。
3. 控件回弹：筛选控件改用 `v-model` + 可写 computed，并在每次 apply 后 `filterEpoch += 1` 强制重渲染，
   让 v-model 的 `updated` 钩子把 DOM 值拉回到“真正产出当前行”的那个值（否则下拉框会独自停在
   discarded，同样是一句谎）。

### 3.2.2 X2（对抗复核必修）：唯一会真实写入的那张表不得匿名

跨管道是本 PR 自造的默认作用域变更，而死信行是本区唯一能触发真实写入（replay）的地方，
所以死信行的 `<small>` 补上 `· pipeline {{ deadLetter.pipelineId }}`（类型早就有：`workbench.ts:391`），
「确认 Replay（会真实写入）」按钮的 `title` 同步带上 pipelineId。run 行已有 `<dt>pipeline</dt>`，两边持平。

### 3.2.3 P2（#5612 审阅反例必修）：后台轮询不得抢占手动意图

反例原话：

> 用户选择 failed、请求尚未返回时，5 秒轮询使用旧的 all 条件发起新请求，并让手动请求失效。真实 loader 的
> 内存复现结果是：用户选择 failed，最终显示 all，没有错误提示。慢请求还可能反复失效、一直不刷新。

**调用链（改前）**：`IntegrationMonitoringSection.vue` 的 `setInterval` → `props.refreshPipelineObservation(true)`
→ 视图 `refreshPipelineObservation(silent, nextQuery?)`。轮询不传 `nextQuery`，于是
`const query = nextQuery ?? monitoringQuery.value` 取到的是**已提交游标**——而 X1 规定游标只在读取成功后才和行
一起提交，所以手动读还没回来时，`monitoringQuery` 仍然是用户刚离开的那个条件（all）。同时轮询在 `issue()`
里拿到更新的票据，手动读回来时 `isCurrent` 为假被丢弃。两件事叠在一起：屏幕回到 all、下拉回弹到 all、
`monitoringError` 因为轮询成功而被清空 → **一个字都不说**。慢请求每 5 秒被作废一次，可以永远刷不出来。

**修法**：票据升级成「读取闸门」`createMonitoringReadGate()`（纯模块），它同时回答两个问题：

1. `begin('background')`：**只要还有未结算的读取就拒绝本轮轮询**（返回 `null`，加载器直接 return，
   一个请求都不发）。这是二选一里的「读取未完成时跳过轮询」。选它而不是「完成后再调度」的原因：
   定时器是 `setInterval`，被拒绝的一跳会在 5 秒后自然重来，**跳过即延后**，不需要在共用组件里做定时器手术
   （改调度要在 `IntegrationMonitoringSection.vue` 里维护 timeout 链和重入，风险更大）；而且闸门放在加载器里，
   任何未来的后台调用方都自动受管，不只是这一个定时器。
2. `isCurrent(ticket)`：只有最后发出的票据能落盘。手动读**永不被拒绝**，所以它总是拿到比在飞后台读更大的
   序号 → 后台读回来时条件已被用户改过，结果直接丢弃。

**硬约束落点**：`source: MonitoringReadSource = 'manual'` 是加载器第三参的默认值，视图里唯一传
`'background'` 的是新函数 `pollPipelineObservation()`；组件拿到的是**单独的 prop**
`pollPipelineObservation`（不是在刷新 prop 上加旗标），所以「这次请求没人要求过」是写在定时器调用点上的。
既有三个动作后重读（dry-run / save-only、replay、外部写 apply）全部走默认的 `'manual'`，行为不变。

**优先级不靠时序**：全部判定来自单调自增的票据序号与「未结算集合」大小，没有任何 `Date.now()` / 延时比较。

**代价（明写）**：后台读也会挡住下一次后台读（慢轮询不会堆积）；如果某次读取**永远不结算**，轮询也会一直停，
`pendingCount()` 可以观测到。相比「静默把用户的筛选改回去」，这是更好的失败方向。轮询期间
`observingPipeline` 仍会置 true（刷新按钮闪一下），这条不在本次修法里，见 §5.2。

### 3.3 视图侧只留最小接线

`IntegrationWorkbenchView.vue` 只动了 5 处（导入、一个 `monitoringQuery` ref + 一个 gate、
`refreshPipelineObservation` 重写、新增 `pollPipelineObservation()`、4 个新 prop），刻意避开在飞 PR
#5587/#5596/#5597 的落点。
`pipelineRuns` / `deadLetters` / `observationSummary` / 既有 replay & provenance 逻辑全部原地不动。

## 4. 没做的项与原因

1. **时间窗筛选**：runs / dead-letters 路由都没有 `from/to`（只有 provenance 有）。在前端按时间过滤会在
   `limit` 之后再筛，翻页会变成谎话，所以直接不做，并在 UI 里写明原因。要做得后端先加参数。
2. **运行详情页 / `GET /runs/:id`**：路由不存在。改为把列表行**已有**的字段展开显示（run id / pipeline / mode /
   triggeredBy / 四个行数 / 起止时间 / durationMs / errorSummary / 本页死信数），并在展开区注明
   "后端没有 GET /runs/:id，本期不新增后端路由"。真详情需要后端新增路由。
3. **总数 / 总页数 / 跳页**：后端不返回总数，任何页数都是编的。只保留上一页/下一页与当前页码。
4. **死信按 errorCode 服务端分组**：后端没有 group-by，前端只对**当前这一页**计数，UI 明写"当前这一页"。
5. **`runId` 筛选、`includePayload`**：后端支持但本期用不上（前者要先有运行详情入口，后者涉及脱敏面）。
6. **每页默认仍是 5**：既保持首屏 URL 与既有断言逐字节不变，也让这次改动可回滚为纯 UI 增量。

## 5. 后续（本波不做，对抗复核终审明确记账）

1. **跨端 parity spec**：把前端三个常量（run 状态闭集 / 死信状态闭集 / limit・offset 上限）钉到后端导出上。
   三个源头都已导出：`pipelines.cjs:815 __internals`（`VALID_RUN_STATUSES` 在 `:826`）、`dead-letter.cjs:193`、`http-routes.cjs:9752-9753`（MAX_LIST_LIMIT / MAX_LIST_OFFSET）；
   仓内有同形先例 `apps/web/tests/composition-vocab-mirror.spec.ts`。做了之后，后端改闭集会直接把前端拖红。
2. **轮询与手动读取分离 spinner / 分页禁用**：签名已经在 §3.2.3（P2 必修）里改了——第三参 `source` 默认
   `'manual'`，三个动作后重读的调用点行为逐字不变，已跑回归（`IntegrationWorkbenchView.spec.ts` 等 4 个
   spec / 106 测试）。**仍未做**的是 spinner 本身：轮询照样把 `observingPipeline` 置 true，刷新按钮会闪一下。
   要分开得再给 section 一个「后台读取中」的独立状态位并改按钮禁用条件，本波不做（纯观感，不影响正确性）。
3. **换管道不重置 offset**：`IntegrationWorkbenchView.vue:4116`（本波前为 :4098）的 `watch(savedPipelineId)` 只调
   `resetExternalWriteReview()`，不碰 `monitoringQuery.offset`。停在第 5 页时换管道，会用 offset 20 去读新管道
   （很可能直接空页）。修法是在那个 watch 里把游标归零并重读——但那行在在飞 PR 的落点附近，本波不碰。
4. **排序不稳定**：两个列表都只按 `created_at DESC` 排（`pipelines.cjs:713`、`dead-letter.cjs:135`），
   同一毫秒多行时翻页可能重复/漏行；要稳定得后端加次级排序键。
5. **trim**：自定义 Pipeline ID 输入框只在纯模块里 `trim()`，UI 上不回写被 trim 后的值。

## 6. 兼容性

首屏（scope=current + 已保存管道 + 默认页大小）产出的 URL 与改前逐字节相同：
`/api/integration/runs?tenantId=default&pipelineId=pipe_x&limit=5` 和
`/api/integration/dead-letters?tenantId=default&pipelineId=pipe_x&status=open&limit=5`。
唯一的行为变化是：**没有保存过 Pipeline 时不再抛错，而是跨管道读**（这正是本次要补的到达率）。
