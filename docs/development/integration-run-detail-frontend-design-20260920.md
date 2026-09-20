# 集成工作台「运行详情」前端接线 + OpenAPI 契约（SC-04 后续）

日期：2026-09-20 · 后端前置：PR #5887（squash `980362303`）

## 1. 背景与范围

#5887 在插件里加了单条运行读取 `GET /api/integration/runs/:runId`
（`plugins/plugin-integration-core/lib/http-routes.cjs`，处理器 `runsGet`，紧随 `runsList`），
并在自己的残余里写明：**packages/openapi 契约与 apps/web 工作台未更新**。本 PR 只补这两项。

在做的：

1. OpenAPI 契约：`/api/integration/runs/{runId}` GET + 复用的 run 投影 schema；
2. 前端服务层：`getIntegrationRun(runId, scope)`；
3. 工作台监控面板：每行「详情」入口 → 只读对话框；
4. 新 spec + 两点登记。

不在做的（见 §6 残余）：list 路由本身的契约、provenance 关联、轮询刷新。

## 2. 调用链

```
IntegrationMonitoringSection.vue  「详情」按钮 (open-run-detail-<id>)
  → (函数 prop) IntegrationWorkbenchView.vue  openRunDetail(runId)
      → services/integration/workbench.ts  getIntegrationRun(runId, currentScope())
          → utils/api.ts  apiFetch  GET /api/integration/runs/<runId>?tenantId=...
              → 插件路由 runsGet
                  requireAccess(req,'read') → scopedInput → resolveTenantId
                  (assertVerifiedTenantClaim) → pipelineRegistry.getPipelineRun
                      → WHERE tenant_id + workspace_id + id → rowToPipelineRun
  ← { ok:true, data:<run> } → parseIntegrationResponse → runDetail ref → 对话框
```

**谁生产输入**：列表 `listIntegrationPipelineRuns` 渲染出的 run 行提供 `run.id`；作用域来自同一个
`currentScope()`（view 内唯一来源），列表与详情共用，所以详情不可能去另一个 workspace 里查
（`getPipelineRun` 的 WHERE 带 `workspace_id`，查错了就是 404）。

**谁消费输出**：只有 view 自己的 `runDetail` / `runDetailError` ref，再作为 props 下发给纯展示组件；
组件不发起任何请求（沿用 IU-2b 抽取时定下的「parent 拥有全部 ref/computed/service-call」约定）。

**前后守卫**：401/403 由 `requireAccess` + `resolveTenantId` 决定；404 与 501 由路由抛出。前端**只按
错误码分支**（`integrationApiErrorCode`），不匹配服务端英文散文——与 PG 中文 locale 那批失效守卫同一教训。

## 3. 边界与不做的事

- **不自己拼租户头**：值面请求只带 `apiFetch` 附的会话 JWT，`tenantId` 只作为查询参数回显（服务端
  与已验证声明比对，不一致 403），前端不写 `x-tenant-id`。spec 里有一条断言直接钉住这一点。
- **不新增暴露面**：对话框渲染的字段全部是列表路由早已返回的同一投影（`rowToPipelineRun`）；
  `details` JSONB 沿用面板里已有的只读 pretty-JSON 呈现方式，不引入新组件、新依赖。
- **只读**：对话框里没有任何 replay / retry / 重跑控件，spec 断言其中不存在 `replay-*` 控件。
- **404 不是跨租户存在性探针**：服务端对「他租户的 id」与「不存在的 id」返回同形 404，前端两者也
  只给同一句文案，不做任何区分展示。

## 4. 三态文案（双语，按错误码）

| 状态 | 触发 | zh-CN | en |
| --- | --- | --- | --- |
| 空态 | 200 但 `details` 为空对象 | 这条运行没有附加详情（details 为空）。 | This run carries no extra details (empty details). |
| 404 | `RUN_NOT_FOUND` | 运行不存在或不可见（可能属于其它租户/工作区，或已被清理）。 | This run does not exist or is not visible in your scope. |
| 501 | `RUN_READ_NOT_IMPLEMENTED` | 当前版本未启用单条运行详情读取。 | Single-run detail read is not enabled in this version. |

其余错误保留服务端 message（`parseIntegrationResponse` 已生成），不吞掉。

## 5. 为什么详情要重新读一次，而不是直接展示列表里那一行

列表被截到最近 5 条，且 `status` / `finishedAt` / `details` 在 run 开始后仍会变。详情必须能显示
比缓存行更新的状态——spec 用「列表里是 `running`、单读返回 `partial`」把这条钉死。
`runDetailRequestId` 单调令牌保证连点两次时慢的那次答复不会覆盖新的。

## 6. 残余

- `GET /api/integration/runs`（list）本身仍未进契约；本 PR 只补单读那一条。
- 未做 provenance 关联（详情里不跳转 `/api/integration/provenance`）。
- 未做轮询/自动刷新：对话框是一次性读取，要更新得关掉再点。
- `apps/web/tests/**` 不在 `vue-tsc -b` 的工程图里（`tsconfig.app.json` 的 include 只有 `src/**`），
  新 spec 的类型只在 vitest 运行时被间接校验——这是仓库既有姿态，本 PR 未改。
