# Q4c PR-1: /api/integration/* 核心读面 openapi 契约补齐（design, short）

2026-09-21

## 范围

机械补齐，不改任何路由行为。给以下 6 条既存只读路由补 `packages/openapi` 契约（此前只有
`runs` 三条有契约: list #5902 / `{runId}` #5895 / `{runId}/provenance` #5925）：

| 方法+路径 | 处理器 | 来源 |
|---|---|---|
| GET /api/integration/provenance | `provenanceByRow` | `plugins/plugin-integration-core/lib/http-routes.cjs:10012` → `pipelineRegistry.listProvenanceByRow`（`lib/pipelines.cjs:761`） |
| GET /api/integration/dead-letters | `deadLettersList` | `http-routes.cjs:10032` → `deadLetterStore.listDeadLetters`（`lib/dead-letter.cjs:121`）+ `redactDeadLetter`（`http-routes.cjs:2920`） |
| GET /api/integration/pipelines | `pipelinesList` | `http-routes.cjs:5429` → `pipelineRegistry.listPipelines`（`lib/pipelines.cjs:605`） |
| GET /api/integration/pipelines/{id} | `pipelinesGet` | `http-routes.cjs:5451` → `pipelineRegistry.getPipeline`（`lib/pipelines.cjs:588`） |
| GET /api/integration/external-systems | `externalSystemsList` | `http-routes.cjs:4876` → `externalSystems.listExternalSystems`（`lib/external-systems.cjs:1446`） |
| GET /api/integration/external-systems/{id} | `externalSystemsGet` | `http-routes.cjs:4907` → `externalSystems.getExternalSystem`（`lib/external-systems.cjs:978`） |

PR-2（stock-preparation 读面: snapshot-batches / diff / diff/rows）在同一 worktree 切
`docs/openapi-stock-prep-read-contracts` 另做，不在本 PR。

## 做法

1. 亲读每个处理器 + 其调用的 registry/store 函数 + 对应的 `rowTo*` 投影函数，逐条记 `path:line`
   写进新 yml 的注释头（见下表）。
2. 复用 `base.yml` 已有的 `ProvenanceTimelineEntry`（DF-N2-2c，`GET /api/integration/provenance`
   本就是它的文档化目标，只是路径块此前没写）；新增 4 个 schema，按各自 `rowTo*` 投影函数逐字段
   对应：`IntegrationPipeline` + `IntegrationPipelineFieldMapping`（`rowToPipeline`/`rowToFieldMapping`,
   `lib/pipelines.cjs:289`/`:315`）、`IntegrationExternalSystem`（`rowToPublicExternalSystem`,
   `lib/external-systems.cjs:258`）、`IntegrationDeadLetter`（`rowToDeadLetter` + `redactDeadLetter`
   合成后的线上形状）。
3. 三个新 path 文件（`build.ts` 按文件名排序合并，无需登记别处）：
   - `packages/openapi/src/paths/integration-pipelines.yml`
   - `packages/openapi/src/paths/integration-external-systems.yml`
   - `packages/openapi/src/paths/integration-provenance-and-dead-letters.yml`
4. 每条契约记录了非默认行为，均来自亲读，而非猜测：
   - `/api/integration/provenance` 响应是裸数组（无 `{items}` 包装），与
     `/api/integration/runs/{runId}/provenance` 的 `{items}` 包装不同——处理器直接
     `sendOk(res, await pipelineRegistry.listProvenanceByRow(...))`（`http-routes.cjs:10022`），
     而 run 子路由是 `sendOk(res, { items })`（`http-routes.cjs:10005`）。
   - `pipelinesGet` 的 `includeFieldMappings` 判断是 `!== 'false'`（字符串比较），默认 true；
     `false` 时整个 key 被省略（`fieldMappings` 从不为 `undefined` 之外的值，`rowToPipeline`
     只在 `fieldMappings !== undefined` 时才挂上这个 key，`lib/pipelines.cjs:311`）。
   - `externalSystemsList` 在 `workspaceId` 非空时把「精确 workspace」与「租户级 null-workspace」
     两个分支的结果合并去重再切页（`lib/external-systems.cjs:1470-1505`），文档里写明这一点，
     避免调用方以为传了 `workspaceId` 就看不到租户级共享的外部系统。
   - `deadLettersList` 的 `includePayload=true` 只有 `isAdmin(getUser(req))` 才生效
     （`http-routes.cjs:10035`），非 admin 传了也被静默忽略（走 redacted 分支），不是 403。
   - 404 语义与 `runs` 系列一致：`PipelineNotFoundError`/`ExternalSystemNotFoundError` 对「不存在」
     和「别的租户的」返回同一条 message，无 details 泄漏区分。

## 验证

见同名 `-verification-20260921.md`（短版）：build/validate/generate:sdk/guard:codegen 全绿 +
diff 摘要。

## 未做 / 边界

- 不改任何处理器/registry 代码，纯文档。
- 不做 write 路由的契约（pipelinesUpsert/externalSystemsUpsert/deadLettersReplay 等）——本任务只
  要求读面。
- PR-2（stock-preparation 读面）不在此 PR。
