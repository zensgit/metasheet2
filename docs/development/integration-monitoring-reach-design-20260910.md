# 数据工厂「运行监控」到达率补齐 — 设计 (G34, 2026-09-10)

分支 `feat/integration-monitoring-reach`（基于 origin/main 11dddc18b）。**后端零改动**：本次只把前端能到达的
参数补齐到后端早就支持的范围。

## 1. 后端今天真正支持什么（只读核对，未改）

| 参数 | runs (`GET /api/integration/runs`) | dead-letters (`GET /api/integration/dead-letters`) | 出处 |
| --- | --- | --- | --- |
| `pipelineId` | 可选 | 可选 | `plugins/plugin-integration-core/lib/http-routes.cjs:9639` / `:9674`；`pipelines.cjs:702`、`dead-letter.cjs:129` 都只在值为真时才加谓词 |
| `status` | 可选，闭集 `pending / running / succeeded / partial / failed / cancelled` | 可选，闭集 `open / replayed / discarded` | `pipelines.cjs:27` VALID_RUN_STATUSES；`dead-letter.cjs:7` VALID_STATUSES |
| `limit` | 可选，`asListLimit` 截到 500 | 同左 | `http-routes.cjs:1436` MAX_LIST_LIMIT=500，`:1479` asListLimit |
| `offset` | 可选，`asListOffset` 截到 10000 | 同左 | `http-routes.cjs:1437` MAX_LIST_OFFSET=10000，`:1485` asListOffset |
| `runId` | 无 | 可选（本期未用） | `http-routes.cjs:9679` |
| `includePayload` | 无 | 仅 admin，且本期不用（脱敏面不动） | `http-routes.cjs:9676` |
| 时间窗 `from/to` | **不支持** | **不支持** | 只有 provenance 路由有（`http-routes.cjs:9666`、`pipelines.cjs:725`） |
| 总数 / 分页元信息 | **不返回**（`sendOk(res, 数组)`） | **不返回**（同样是数组） | `http-routes.cjs:9641`、`:9684` |
| 单条运行详情 `GET /runs/:id` | **不存在**（路由表只有 `GET /api/integration/runs`） | — | `http-routes.cjs:270-273` |

两个列表都在 `scopedInput` 里带上 tenant/workspace 谓词（`pipelines.cjs:700`、`dead-letter.cjs:125`），
**省掉 `pipelineId` 不会越过调用方自己的租户/工作区作用域**——它只是把"某一条管道"放宽成"本作用域内的全部管道"。
这也是本 PR 唯一一处"读取变宽"，写入口一行没动。

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

### 3.3 视图侧只留最小接线

`IntegrationWorkbenchView.vue` 只动了 4 处（导入、一个 `monitoringQuery` ref + 一个 gate、
`refreshPipelineObservation` 重写、3 个新 prop），刻意避开在飞 PR #5587/#5596/#5597 的落点。
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

## 5. 兼容性

首屏（scope=current + 已保存管道 + 默认页大小）产出的 URL 与改前逐字节相同：
`/api/integration/runs?tenantId=default&pipelineId=pipe_x&limit=5` 和
`/api/integration/dead-letters?tenantId=default&pipelineId=pipe_x&status=open&limit=5`。
唯一的行为变化是：**没有保存过 Pipeline 时不再抛错，而是跨管道读**（这正是本次要补的到达率）。
