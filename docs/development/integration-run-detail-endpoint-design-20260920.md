# SC-04: `GET /api/integration/runs/:runId` 单条运行读取 — 设计

- 日期：2026-09-20
- 分支：`feat/integration-run-detail-endpoint`
- 基线：`origin/main` @ `0708051ca`
- 范围：`plugins/plugin-integration-core` 内部（registry 方法 + HTTP 路由 + 测试 + provenance pin）

## 1. 为什么

集成运行（`integration_runs`）的 HTTP 面此前只有列表：`GET /api/integration/runs`（`lib/http-routes.cjs` 路由表 `runsList`）、`/provenance`、`/dead-letters`。工作台要看某一条运行的详情只能拉列表再在前端过滤，既浪费又和"按 id 读"的语义不符。registry 侧 `lib/pipelines.cjs` 只有 `listPipelineRuns`，没有 `getPipelineRun`。

## 2. 改了什么

### 2.1 `lib/pipelines.cjs` — `getPipelineRun(input)`

紧跟 `listPipelineRuns` 之后新增，形状逐字照 `getPipeline`：

- `requiredString(input?.tenantId, 'tenantId')` / `normalizeWorkspaceId(input?.workspaceId)` / `requiredString(input?.id, 'id')`；
- `db.selectOne(RUNS_TABLE, { tenant_id, workspace_id, id })` —— **三键齐全**；
- 未命中抛 `PipelineNotFoundError('pipeline run not found', { id, tenantId, workspaceId })`；
- 命中走 `rowToPipelineRun(row)`，与列表同一投影；**不**顺手 join `provenance_events`。
- 加进 `createPipelineRegistry` 的 return 导出块。

`workspaceId` 归一：`normalizeWorkspaceId` 把 `undefined` / `''` / `null` 都归成 `null`，和 `listPipelineRuns` 走的 `scopeWhere` 完全一致（`workspace_id: workspaceId ?? null`）。也就是说 null-workspace 下写入的运行在 null-workspace 下读回，**不比 list 更宽**，这是既有行为的对齐而不是新洞。

### 2.2 `lib/http-routes.cjs` — 路由 + 处理器 `runsGet`

- 路由表 `['GET', '/api/integration/runs', 'runsList']` 之后插入 `['GET', '/api/integration/runs/:runId', 'runsGet']`。
- 处理器放在 `runsList` 之下，顺序即契约：
  1. `requireAccess(req, 'read')` → 无 user 401 `UNAUTHENTICATED`；无 integration 权限 403 `FORBIDDEN`；
  2. `typeof pipelineRegistry.getPipelineRun !== 'function'` → 501 `RUN_READ_NOT_IMPLEMENTED`（照 `provenanceByRow` 的可选方法形状）；
  3. `firstString(requestParams(req).runId)` 空 → 400 `RUN_ID_REQUIRED`（Express 路由下实际不可达，防御性保留）；
  4. `pipelineRegistry.getPipelineRun(scopedInput(req, { id: runId }))`；
  5. 名字匹配 `/NotFound/` 的错误 → 重抛 `HttpRouteError(404, 'RUN_NOT_FOUND', 'pipeline run not found')`，**不带 details**；其它错误原样上抛；
  6. `sendOk(res, run)` → `{ ok: true, data: <run> }`（`data` 是单个对象，不是数组；和 `pipelinesGet` 返回单个 pipeline 一致）。

### 2.3 三条刻意的"不做"

- **不**把 `getPipelineRun` 加进 `requireService('pipelineRegistry', [...])` 必需列表：那会让所有先于本路由的 host 接线和测试 mock 在 mount 期集体失败。走可选方法 501。
- **不**套 `resolveOperatorValueScope`：该助手的注释明确它只服务备料 operator 层，不适用 `integration:read` 传统层。租户门就是 `scopedInput → resolveTenantId → assertVerifiedTenantClaim`（已有硬门，flag 开时要求 verified claim）。
- **不**加 `provenance_events` 投影，不动 `index.cjs` facade（facade 文件被 `pluginIndex` pin 锁着，本 PR 只重算 `pluginHttpRoutes` 一个键）。

## 3. 404 不做跨租户存在性 oracle

- registry 的 WHERE 三键齐全：他租户的 run id 和不存在的 id 对当前租户都是**同一次 `selectOne` 未命中**，走同一个 `PipelineNotFoundError`。
- `sendError` 会把 `error.details` 经 `sanitizeIntegrationPayload` 后**透传**（`lib/http-routes.cjs` `sendError`），而 registry 的 details 回显 `{ id, tenantId, workspaceId }`。所以处理器把 NotFound 重抛成不带 details 的 `RUN_NOT_FOUND`，两种 miss 的响应体逐字节相同（测试里用 `deepEqual(foreign.body, missing.body)` 钉住）。
- 显式在 query 里带他租户 `tenantId` 的请求在 `resolveTenantId` 就 403 `TENANT_MISMATCH`，根本到不了 registry。

## 4. 与 provenance pin 的关系

`lib/http-routes.cjs` 被 `lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的 `pluginHttpRoutes` 键按 sha256 pin。本 PR 用 `sha256sum` 实算重写了**只这一个键**，`evidenceFiles` 块未动，`node __tests__/sealed-export-package-provenance.test.cjs` 绿。`test-chain.txt` 未改（测试都加在既有文件里，没有新登记行）。

## 5. 残余 / 未覆盖

- `packages/openapi` 的契约与 `apps/web` 工作台前端未随本 PR 更新；前端接入单条读取是后续项。
- `index.cjs` facade 未加 `getPipelineRun`（避免同时重算 `pluginIndex` pin）；进程内调用方仍需直接拿 registry。
- 400 `RUN_ID_REQUIRED` 分支在真实 Express 路由下不可达（空段不匹配 `:runId`），只在直接调用 handler 时可见；未单独写测试。
