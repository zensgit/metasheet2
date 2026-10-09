# GET /api/integration/runs — OpenAPI 契约补齐（#5895 后续）

日期：2026-09-20
分支：`docs/openapi-integration-runs-list-contract`

## 背景

#5895 给 `packages/openapi` 加了 `/api/integration/runs/{runId}`
(`packages/openapi/src/paths/integration-runs.yml` + `base.yml` 的
`IntegrationPipelineRun` schema)，但 list 路由 `GET /api/integration/runs`
仍无契约——旧注释写明"预留、故意不做"。本次补上 list 契约。

## 契约来源（以代码为准，逐条对应到 path:line）

处理器：`plugins/plugin-integration-core/lib/http-routes.cjs:9910-9919`
（`runsList`）。

```js
async runsList(req, res) {
  requireAccess(req, 'read')
  const query = requestQuery(req)
  return sendOk(res, await pipelineRegistry.listPipelineRuns(scopedInput(req, {
    pipelineId: query.pipelineId,
    status: query.status,
    limit: asListLimit(query.limit),
    offset: asListOffset(query.offset),
  })))
},
```

- **鉴权**：`requireAccess(req, 'read')`（`http-routes.cjs:931-940`）——无 principal 401
  `UNAUTHENTICATED`；有 principal 但权限不足 403 `FORBIDDEN`。`hasPermission` 对 `read`
  接受 `integration:read` 或 `integration:write`（`http-routes.cjs:914-916`）。
- **租户/工作区作用域**：`scopedInput(req, ...)`（`http-routes.cjs:1258-1264`）调用
  `resolveTenantId`（`1034-1058`）与 `resolveWorkspaceId`（`1254-1256`）。
  - `resolveTenantId` 从 `input.tenantId → req.query.tenantId → req.params.tenantId →
    user.tenantId` 取第一个非空值；非租户平台管理员（`isTenantlessPlatformAdmin`）之外，
    显式值必须等于认证租户，否则 403 `TENANT_MISMATCH`；租户完全解析不出时 400
    `TENANT_REQUIRED`。这条路径与 #5895 的单条读契约共用同一 resolver，因此本次 list
    契约里的 `tenantId` 参数文档照抄单条读契约的措辞。
  - `resolveWorkspaceId` 从 `input.workspaceId → req.query.workspaceId →
    req.params.workspaceId` 取第一个非空值；省略即空工作区（null）。
- **查询参数**：处理器只显式转发 `pipelineId`、`status`、`limit`、`offset` 四个（外加
  `scopedInput` 隐式吃进的 `tenantId`/`workspaceId`）。**没有 `cursor` 字段**——route 也没
  分页游标概念。
  - `status` 校验在 registry 侧：`plugins/plugin-integration-core/lib/pipelines.cjs:704-710`，
    `VALID_RUN_STATUSES`（`pipelines.cjs:27`）= `pending | running | succeeded | partial |
    failed | cancelled`；不在集合内抛 `PipelineValidationError`（`pipelines.cjs:34-40`，
    `name = 'PipelineValidationError'`，无 `.code`），经 `inferErrorCode`
    （`http-routes.cjs:845-849`，无 `.code` 回退到 `.name`）映射为 `code:
    "PipelineValidationError"`，经 `inferHttpStatus`（`http-routes.cjs:851-879`，
    `/Validation|.../.test(name)` → 400）映射为 400。
  - `limit`/`offset` 经 `asListLimit`/`asListOffset`（`http-routes.cjs:1485-1494`，
    依赖 `asPositiveInt` `1476-1480`）：非正整数或非数字**静默忽略**（变成
    `undefined`，交给 registry 默认值），不是 400；`limit` 上限 `MAX_LIST_LIMIT = 500`
    （`http-routes.cjs:1442`）。
- **响应形状**：`sendOk(res, data)` = `{ ok: true, data }`（`http-routes.cjs:738-740`）；
  这里 `data` 是 `pipelineRegistry.listPipelineRuns(...)` 的直接返回值——`pipelines.cjs:711-717`
  确认是**纯数组**（`rows.map(rowToPipelineRun)`），**没有 `total`/`nextCursor`**。
  测试 `plugins/plugin-integration-core/__tests__/http-routes.test.cjs:3245-3264` 实读确认了
  这个形状（`res.body.data.map(...)`，且 `findCall` 断言 registry 只收到
  `{tenantId, workspaceId, pipelineId, status, limit, offset}` 六个键）。
  `IntegrationPipelineRun` schema（`base.yml:1752-1792`）本身已写明"list 与单条读共用同一
  投影，不会漂移"，所以 list 的 200 响应直接复用该 schema，不新开一份。

## 改动

- `packages/openapi/src/paths/integration-runs.yml`：新增 `GET /api/integration/runs`
  路径块（放在 `/api/integration/runs/{runId}` 之前），参数与错误码逐条对应上表；顺带
  把旧的"list 路由故意不契约"注释改写为指向本次处理器 path:line 的说明，并保留
  `/api/integration/runs/{runId}` 原有 200/400/401/403/404/501 契约不动。
- 重新生成 `packages/openapi/dist/{combined.openapi.yml,openapi.json,openapi.yaml}` 与
  `packages/openapi/dist-sdk/index.d.ts`（新增一个 `"/api/integration/runs"` path 条目，
  400 响应携带 `PipelineValidationError` 的具体错误码而非泛化的
  `VALIDATION_ERROR`——与 route 实际返回的 `error.code` 一致）。
- 前端 `apps/web/src/services/integration/workbench.ts` 的 `listIntegrationPipelineRuns`
  已经手写了独立的 `IntegrationPipelineRun` 接口（`workbench.ts:361-379`），字段与本次契约
  的 schema 完全对应；该文件里所有 integration 相关导出（含单条读 `getIntegrationRun`）
  都走同一手写接口模式，没有任何一处 import 生成的 `@metasheet/sdk` 类型（只有
  `services/plm/*` 两个文件这么做）。为它单独切换成 SDK 类型会打破这个文件内部的一致性、
  引入与本任务无关的重构面，故本次**不改前端代码**（步骤 4 是可选项，判定为"已对齐、
  无需改动"）。

## 未改动 / 明确排除

- 未触碰 `runsGet`（`/api/integration/runs/{runId}`）契约内容，只挪了它前面的注释。
- 未新增后端代码或测试——这是纯契约文件补齐，行为零变化；已有的
  `http-routes.test.cjs:3245-3264` 早就实读验证了这条路由的真实响应形状，本次契约据此
  编写，不需要新增测试来"发明"一个尚不存在的行为。
- 未改 `apps/web` 任何文件（见上）。
