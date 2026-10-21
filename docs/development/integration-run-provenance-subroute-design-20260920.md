# 运行详情关联 provenance — `GET /api/integration/runs/:runId/provenance`（设计）

- 日期：2026-09-20
- 分支：`feat/integration-run-provenance-subroute`
- 关联：#5895（`GET /api/integration/runs/{runId}` 单条运行读 + 运行详情面板）、DF-N2-2a/2b/2c（provenance 写入 / 视图 / 按 rowId 读）

## 1. 问题

#5895 之后，运行监控面板的「详情」可以重读一条 run（状态 / 指标 / `details` JSON），但看不到这条 run 到底对哪些行做了什么。
血缘（provenance）已经写进 `integration_runs.provenance_events`（DF-N2-2b），也已经有 migration 060 的只读视图
`integration_provenance_by_row`（`060_integration_runs_provenance.sql:17-41`），但现有读路径只有一条：

- `GET /api/integration/provenance`（handler `provenanceByRow`）—— **跨 run、按 rowId** 的时间线。
  路由层 `http-routes.cjs` 与注册表层 `pipelines.cjs` 都硬性要求 `rowId`，两处都被既有用例钉死
  （`__tests__/http-routes.test.cjs` 的 `testProvenanceReadRoute` 与 `__tests__/df-n2-2c-provenance-read.test.cjs`）。

也就是说，从「一条 run」出发目前没有入口：面板里唯一能查血缘的地方是 dead letter 行（需要 `idempotencyKey`），
一条成功的 run 或一条没有 dead letter 的失败 run 都查不到自己的事件。

## 2. 边界（先说不做什么）

- **不放宽** `GET /api/integration/provenance` 的 `rowId` 要求。那条路由是跨 run 语义，
  把 `rowId` 变成可选会让它退化成「全租户血缘导出」。本次新增的是**另一条**路由，选择器是 URL 里已经有的 `runId`。
  这一点在两处用断言钉住（见验证文档 §2 的 M2 / M4）。
- 只读。新路由不写、不重放、不重试；前端新增的折叠区里没有任何写控件。
- 不改 migration，不改视图，不改 `provenance_events` 的写入路径。
- 不把 `listProvenanceByRun` / `getPipelineRun` 加进 `requireService` 必需方法列表：
  加进去会让所有早于本路由的宿主接线与测试 mock 在**挂载时**就失败，而不是在调用时给一个 501。

## 3. 后端

### 3.1 注册表：`pipelines.cjs` 新增 `listProvenanceByRun`

紧随 `listProvenanceByRow` 之后，照抄其形状，只换谓词：

```
where = { tenant_id, workspace_id, run_id }
orderBy = ['event_index', 'ASC']
limit   = normalizeProvenanceRunLimit(input.limit)   // 默认 200，上限 1000
```

要点：

- **三键 WHERE**。`scopeWhere({tenantId, workspaceId})` + `run_id`。别的租户的同名 run id、本租户别的 workspace 的
  同名 run id、以及不存在的 run id，都选出零行 —— 这个方法本身不是存在性 oracle。
- **按 `event_index` 排序**。在一条 run 内部，`event_index` 就是写入顺序（视图的 `WITH ORDINALITY`
  跑在持久化的 `provenance_events` 数组上），所以不需要 by-row 读那样的二级 `run_created_at` 排序。
  DB 的 `ORDER BY` 是契约，另有一次进程内 `sort` 兜底：某个宿主 db 层若忽略 `orderBy`，不能把乱序时间线交给操作员。
- **limit**。服务端持有默认值 200、上限 1000；非正整数（`0` / `-1` / `'50'` / `1.5` / `null`）一律回落默认值，
  与 list 路由「junk page size 静默忽略」的惯例一致。
- 投影复用 `rowToProvenanceEntry`，与 by-row 读同一个函数 —— 两条读路径的暴露面不可能漂移。
  `attrs` 在**写入时**已脱敏（DF-N2-2b scrub gate），读路径不二次脱敏，与 by-row 读相同。

### 3.2 路由：`http-routes.cjs` 新增 `runsProvenance`

ROUTES 表里插在 `/api/integration/runs/:runId` 之后：

```
['GET', '/api/integration/runs/:runId/provenance', 'runsProvenance'],
```

段数与 `/runs/:runId` 不同，所以 `:runId` 不会捕获它（没有 `/templates/references` 那种顺序陷阱）。

处理器顺序（每一步都是有意的）：

1. `requireAccess(req, 'read')` —— 与 `runsGet` / `runsList` 同一档；write 权限也含 read。
2. 缺 `listProvenanceByRun` → 501 `PROVENANCE_READ_NOT_IMPLEMENTED`；缺 `getPipelineRun` → 501 `RUN_READ_NOT_IMPLEMENTED`。
   两者都是可选方法，挂载不受影响。
3. 路径缺 `runId` → 400 `RUN_ID_REQUIRED`。
4. **先 `getPipelineRun(scopedInput(req, { id: runId }))`**，`NotFound` → 404 `RUN_NOT_FOUND`（不带 `details`）。
5. `listProvenanceByRun(scopedInput(req, { runId, limit: asListLimit(query.limit) }))` → 200 `sendOk({ items })`。

**为什么第 4 步存在**：没有这次探针，一个不存在（或属于别的租户）的 run 会拿到 `200 { items: [] }` ——
这与一条真实存在但没有事件的 run 是同一个响应体。于是「不是你的」与「没有事件」被混为一谈，
而「不存在」与「存在但空」反倒被区分开了，正好是反的。加上探针后：另一个租户的 run id 与不存在的 run id
走同一条路径（三键 `selectOne` 一次未命中），产生**逐字节相同**的 404；而空 run 仍然是 200 + 空数组。

**租户**：全程 `scopedInput` → `resolveTenantId` → `assertVerifiedTenantClaim` 既有门，不读 `user.tenantId`、
不认 `x-tenant-id` 请求头。查询里显式写别的 `tenantId` 在到达注册表之前就被 403 掉。

**limit 双层**：路由 `asListLimit` 封顶 `MAX_LIST_LIMIT`（500），注册表再封顶 1000，两者取紧。

### 3.3 pin

`http-routes.cjs` 是 `s6a-package-provenance-pins.json` 的 `runtimeFiles.pluginHttpRoutes` 被钉住的文件，
本次按新文件内容重算该键（**只**这一个键）。

## 4. 契约（OpenAPI）

`packages/openapi/src/paths/integration-runs.yml` 追加 `/api/integration/runs/{runId}/provenance`：

- `items` 复用已有的 `ProvenanceTimelineEntry`（`base.yml:1714`），不新造 schema —— 它已经和
  `PROVENANCE_TIMELINE_ENTRY_FIELDS` 与 `rowToProvenanceEntry` 三方锁定（`provenance-contracts.test.cjs` 的 parity 用例）。
- 响应 `data` 是 `{ items: [...] }` 对象（`required: [items]`），与单条 run 读的裸对象、list 读的裸数组都不同，
  文档里写明这一点。
- 404 文案明确「另一租户的 run id 与不存在的 run id 返回相同、不带 `details` 的响应」。
- 501 列出两个可能的 code。
- `dist/`（`openapi.yaml` / `openapi.json` / `combined.openapi.yml`）与 `dist-sdk/index.d.ts` 同提交重生成。

## 5. 前端

### 5.1 服务层

`apps/web/src/services/integration/workbench.ts` 新增 `getIntegrationRunProvenance(runId, scope, { limit })`：

- `runId` 走**路径**，不是 query（`/runs?runId=` 会打到 list 路由并返回 run 列表）。
- scope 走 query 参数 + `apiFetch` 附带的 session JWT，**不**自行拼 `x-tenant-id` 头。
- 解包 `{ items }`；条目类型复用已有的 `IntegrationProvenanceTimelineEntry`。

### 5.2 面板

`IntegrationWorkbenchView.vue` 持有状态（`runProvenanceExpanded / Loading / Error / Entries` + 单调 request token），
`IntegrationMonitoringSection.vue` 只渲染并回调（沿用该组件既有的「父持状态、子纯渲染」约定）。

- **默认折叠、首次展开才拉取**：打开「详情」仍然只有一次请求。
- **折叠/再展开复用已取到的时间线**；`openRunDetail` / `closeRunDetail` 都调用 `resetRunProvenance()`，
  所以 run A 的血缘不可能出现在 run B 的弹窗里。
- **values-free 渲染**：每条只显示 `eventType`、`#eventIndex`、`at`、`rowId`；
  `attrs` 走**既有的** `rowProvenanceAttrsSummary()` —— 也就是 dead-letter 跨 run 时间线在用的同一个只读摘要器
  （每个值截断到 60 字符、最多 4 个键、其余记 `+N`）。这里**刻意不**改用 `<pre>{{ JSON.stringify(attrs) }}</pre>`：
  同一份数据在同一个面板里应该只有一种渲染方式，而摘要器是两者中更保守的那个。
- 错误文案按 **code** 分支（`RUN_NOT_FOUND` / `PROVENANCE_READ_NOT_IMPLEMENTED` / `RUN_READ_NOT_IMPLEMENTED`），
  不按服务端散文 —— 与 `runDetailErrorCopy` 同一纪律（PG locale 英文散文守卫失效的同类教训）。
  404 **不**渲染成「这条运行没有溯源事件」：那是真实空 run 的状态，混淆二者正是后端 404 要避免的事。

## 6. 残余 / 未做

- 没有 `offset`：一条 run 的事件数被 runner 写入量界定，200 条默认 + 1000 上限足够，
  真要翻页应该等一个真实的大 run 需求再加，而不是先建能力。
- 没有按 `eventType` / `rowId` 过滤：同理，等真实排查需求。
- 前端没有做「这条 run 的某一行 → 跳到该行跨 run 血缘」的联动（by-rowId 路由已经存在，接线是下一波的事）。
