# 运行详情关联 provenance — 验证记录

- 日期：2026-09-20
- 分支：`feat/integration-run-provenance-subroute`（起点 `origin/main` @ `7aa1b3c84`）
- 设计文档：`docs/development/integration-run-provenance-subroute-design-20260920.md`

## 1. 侦察（改动前，`path:line` 均在 `7aa1b3c84` 上成立）

| 事实 | 位置 |
| --- | --- |
| 跨 run 的 by-rowId 路由在**路由层**硬要 `rowId` | `plugins/plugin-integration-core/lib/http-routes.cjs:9968`（`ROW_ID_REQUIRED`，改动前行号） |
| 同一要求在**注册表层**也存在 | `plugins/plugin-integration-core/lib/pipelines.cjs:751`（`requiredString(input.rowId, 'rowId')`，改动前行号） |
| 上面两条各被一个既有用例钉死 | `__tests__/http-routes.test.cjs:3843-3846`、`__tests__/df-n2-2c-provenance-read.test.cjs:237` |
| migration 060 视图带 `run_id` 列 | `packages/core-backend/migrations/060_integration_runs_provenance.sql:23` |
| `rowToPipelineRun` 不投影 `provenance_events` | `plugins/plugin-integration-core/lib/pipelines.cjs:324-344`（改动前行号） |
| #5895 已有 `runs/{runId}` 契约与前端详情面板 | `packages/openapi/src/paths/integration-runs.yml`、`IntegrationWorkbenchView.vue` runDetail 区、`IntegrationMonitoringSection.vue` |

改动后的落点：

- `plugins/plugin-integration-core/lib/pipelines.cjs:800` —— `listProvenanceByRun`
- `plugins/plugin-integration-core/lib/http-routes.cjs:278` —— ROUTES 表新行
- `plugins/plugin-integration-core/lib/http-routes.cjs:9977` —— `runsProvenance` 处理器
- `apps/web/src/services/integration/workbench.ts:1353` —— `getIntegrationRunProvenance`
- `apps/web/src/views/IntegrationWorkbenchView.vue:3576` —— `toggleRunProvenance`

## 2. 变异自证（全部**内存级**，无落盘变异）

工具：

- 后端 —— `node -r <scratchpad>/q4a-mutate-preload.cjs <suite>`，包住 `Module.prototype._compile`，
  按 env 指定的字面量在**读入时**改写源码；字面量缺失时 exit 97（陈旧变异必须失败，不许静默空跑）。
- 前端 —— `vitest --config <scratchpad>/q4a-web-mutate.config.ts`，一个 `enforce: 'pre'` 的 transform 插件做同样的事。

两者都不回写磁盘。每轮跑完 `git status --porcelain` 只有本次真实改动的文件，工作树逐字节未变。

| # | 变异 | 预期 | 实测 |
| --- | --- | --- | --- |
| M1 | `listProvenanceByRun` 的 WHERE 去掉 `tenant_id`（只留 workspace + run_id） | 红 | **红** — `pipelines.test.cjs`：`listProvenanceByRun returns the run timeline ordered by event_index`，实际多出别的租户那一行（`[1,1,2]`） |
| M2 | 放宽**现有** `/api/integration/provenance` 的 `rowId` 守卫（`firstString(query.rowId) \|\| 'any'`） | 红（既有钉死用例） | **红** — `http-routes.test.cjs`：`status 200 is allowed`（`testProvenanceReadRoute` 期望 400 `ROW_ID_REQUIRED`）。证明本次没有动那条路由 |
| M3 | 新路由去掉 `getPipelineRun` 存在性探针 | 红 | **红** — `http-routes.test.cjs`：`expected getPipelineRun to be called` |
| M4 | 注册表 `listProvenanceByRow` 的 `requiredString(input.rowId)` 放宽 | 红（既有钉死用例） | **红** — `df-n2-2c-provenance-read.test.cjs`：`Missing expected rejection` |
| M5 | `listProvenanceByRun` 的 WHERE 去掉 `run_id` | 红 | **红** — `pipelines.test.cjs` 同上断言，别的 run 的事件混入 |
| W1 | 服务层去掉 `/provenance` 路径段（退化成单条 run 读） | 红 | **红** — `IntegrationRunDetail.spec.ts` 4 例失败 |
| W2 | `runProvenanceError.value` 绕过 `runProvenanceErrorCopy`（直接用服务端散文） | 红 | **红** — 404 文案两个 locale 例失败（断言明确要求**不**出现服务端原文） |
| W3 | 去掉「已加载过就不重复请求」的缓存判断 | 红 | **红** — 1 例失败（collapse/re-expand 不应产生第二次请求） |
| W4 | `resetRunProvenance` 不再清空 `runProvenanceEntries` | 红 | **红** — 关闭再打开后重新展开只发了 1 次请求（期望 2 次） |

> W2 的第一次尝试（把 `integrationApiErrorCode(error)` 换成直接读 `error.code`）**存活**，因为
> `parseIntegrationResponse` 本来就把 code 挂在 Error 上，那不是行为变化。改成绕过整个映射函数后变红。
> W4 的第一次尝试也**存活** —— 当时确实没有用例覆盖「关闭再打开」的清空语义；于是补了
> `clears the provenance section when the dialog is closed and re-opened` 一例，再跑才红。两处都记录在此，不掩盖。

## 3. 测试

### 后端（`plugins/plugin-integration-core`，`node __tests__/<suite>.test.cjs`）

| 套件 | 结果 |
| --- | --- |
| `pipelines.test.cjs` | OK（新增 8d 区块：WHERE 三键、`event_index` 排序、limit 默认/透传/封顶/junk 回落、跨租户与跨 workspace 隔离、入参校验短路、by-row 仍要求 `rowId`） |
| `http-routes.test.cjs` | OK（新增 `testRunProvenanceSubRoute`：200 / 401 / 403（无权限 + 跨租户） / 404（不存在与他租户同形） / 501（两种可选方法各一） / limit 封顶 / write 档位 / by-rowId 守卫未被放宽） |
| `df-n2-2c-provenance-read.test.cjs` | OK（未改，作为 by-row 未被动过的旁证） |
| `provenance-contracts.test.cjs` | OK（normalizer + OpenAPI parity） |
| `sealed-export-package-provenance.test.cjs` | OK（`pluginHttpRoutes` pin 已按新文件 sha256 重算） |
| `http-routes-plm-k3wise-poc.test.cjs` | OK |
| `app-manifest.test.cjs` | OK |

### 契约

```
packages/openapi: pnpm run build          → Built OpenAPI to dist with parts: [... integration-runs.yml ...]
packages/openapi/dist-sdk: openapi-typescript ../dist/openapi.yaml --output index.d.ts
packages/openapi: pnpm run validate       → OpenAPI security validation passed
packages/openapi: pnpm run guard:codegen  → [openapi-guard] all checks passed
                                            content-sha256 dist/openapi.json=aac3503131c2…
                                            content-sha256 dist-sdk/index.d.ts=78c0cdcea6af…
```

`dist-sdk/index.js` 被 sdk build 脚本以 LF 重写但内容相同，已 `git checkout --` 还原，不进 diff。

### 前端

```
pnpm --filter @metasheet/web exec vitest run tests/IntegrationRunDetail.spec.ts \
    tests/IntegrationMonitoringSection.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false
→ Test Files 3 passed (3) / Tests 77 passed (77)

apps/web: pnpm exec vue-tsc -b            → 无输出（通过）
```

`IntegrationRunDetail.spec.ts` 由 8 例增至 14 例（新增 4 个 `it` + 一个双 locale 的 `it.each`）：

1. 只在展开时拉取、`runId` 走路径、无 `x-tenant-id` 头、折叠再展开不重复请求；
2. 按 `event_index` 渲染条数与内容、无写控件、values-free（无 URL / 无点分四段 host 形）；
3. 关闭再打开后折叠且缓存清空（真正重读）；
4. 404 → 按 code 的文案，**不**落到「没有溯源事件」空态，也不出现服务端原文（zh-CN / en 各一）。

## 4. 卫生

- `git diff origin/main | grep -P '\x08'` → 空。
  （途中确实产生过一次 0x08：Bash heredoc 把 `\\b` 折成 `\b` 写进了 spec 的正则。用 Write 落脚本 + 断言修复，已复核为 0。）
- `tests/unit` 未新增 `request(app)`（本次不涉及 core-backend 的 supertest 套件）。
- `plugins/plugin-integration-core/test-chain.txt` **未改动**：新用例全部并入既有的 `pipelines.test.cjs`
  与 `http-routes.test.cjs`，没有新文件要登记。
- `pins.json` 只动 `runtimeFiles.pluginHttpRoutes` 一个键（diff 为单行）。
- 未连接任何真实数据库；未改 `.github/`；未碰 main 与他人工作树/PR。
- 磁盘：开工 19G 可用，收工仍 >4G。

## 5. 残余

- 新路由无 `offset` / `eventType` / `rowId` 过滤（见设计文档 §6）。
- 前端未做「run 里的某一行 → 该行跨 run 血缘」的联动。
- `pnpm install` 只在本 worktree 做了 `--filter @metasheet/openapi / @metasheet/sdk / @metasheet/web` 三次范围安装；
  全仓 lint / type-check / 后端套件未在本机跑，以 CI 为准。
