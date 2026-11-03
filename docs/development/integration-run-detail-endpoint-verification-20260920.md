# SC-04: `GET /api/integration/runs/:runId` — 验证记录

- 日期：2026-09-20（本机 `date` 校正）
- 分支：`feat/integration-run-detail-endpoint`，基线 `origin/main` @ `0708051ca`
- worktree：独立 worktree，主检出未动
- 设计文档：`docs/development/integration-run-detail-endpoint-design-20260920.md`

## 1. 改动文件

| 文件 | 变化 |
| --- | --- |
| `plugins/plugin-integration-core/lib/pipelines.cjs` | +`getPipelineRun`，加进导出块 |
| `plugins/plugin-integration-core/lib/http-routes.cjs` | +路由 `GET /api/integration/runs/:runId`，+处理器 `runsGet` |
| `plugins/plugin-integration-core/__tests__/pipelines.test.cjs` | +8c 段：三键 WHERE / 与 list 同投影 / workspace 归 null / 他租户与不存在同类错误 / 输入校验不触 db |
| `plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | mock registry +`getPipelineRun`；`testRunAndDeadLetterRoutes` +200/404 同形/403 跨租户/401/403 无权限/写权限可读/501/非 NotFound 不吞成 404/单对象形状 |
| `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` | 只重算 `pluginHttpRoutes` 一个键 |

`test-chain.txt` 未改；`index.cjs` 未改。

## 2. 跑过的命令与结果

在 `plugins/plugin-integration-core/` 下：

```
node __tests__/pipelines.test.cjs
  → ✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed   (exit 0)

node __tests__/http-routes.test.cjs
  → http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed   (exit 0)

sha256sum lib/http-routes.cjs  → 写回 pins.json 的 pluginHttpRoutes 键
node __tests__/sealed-export-package-provenance.test.cjs
  → sealed-export-package-provenance.test.cjs OK   (exit 0)
```

字节扫描（仓库根）：

```
git diff origin/main | grep -cP '\x08'                        → 0
git diff origin/main | grep -P '^\+' | grep -cP '\r'          → 0
```

说明：worktree 是 autocrlf 检出，`pipelines.cjs` 与两个测试文件在工作树是 CRLF、索引是 LF；新增行无 CR，提交时 git 归一。`http-routes.cjs` 带 `eol=lf` 属性，磁盘即索引，所以 `sha256sum` 得到的就是提交后的 pin 值。

后端 `packages/core-backend` 无改动，`tsc --noEmit` 不适用（本 PR 只动 CJS 插件）。

## 3. 变异自证（内存级，不落盘）

运行器：scratchpad 下 `w7c-mutate.cjs`。做法：读原文件 → LF 归一 → 断言变异锚点**恰好命中一次** → 字符串替换 → 用 `Module.prototype._compile` 在同一 `filename` 下编译进 `require.cache` → `require` 真实测试文件。每次运行后核对磁盘文件与运行前逐字节相同，`git status` 全程只有本 PR 的 5 个改动文件。

期望：每个变异都让对应测试 **exit 1**。结果 11/11 红：

| 变异 | 目标 | 结果（首个断言） |
| --- | --- | --- |
| P1 去掉 WHERE 里的 `tenant_id` | `pipelines.cjs` | exit 1 — `getPipelineRun WHERE carries all three scope keys` |
| P2 去掉 WHERE 里的 `workspace_id` | `pipelines.cjs` | exit 1 — 同上 |
| P3 未命中返回 `null` 而非抛 NotFound | `pipelines.cjs` | exit 1 — `foreign-tenant run id throws not found` |
| P4 跳过 `requiredString(id)` | `pipelines.cjs` | exit 1 — `getPipelineRun rejects {...} before the db` |
| P5 `workspaceId===null` 时放成 `undefined`（放宽作用域） | `pipelines.cjs` | exit 1 — WHERE 三键断言 |
| H1 去掉 `requireAccess` | `http-routes.cjs` | exit 1 — 匿名请求拿到 400 而非 401 |
| H2 去掉 501 守卫 | `http-routes.cjs` | exit 1 — 缺方法时 500 而非 501 |
| H3 NotFound 不剥 details 直接上抛 | `http-routes.cjs` | exit 1 — 404 体回显了 tenant/id |
| H4 不走 `scopedInput`，写死租户 | `http-routes.cjs` | exit 1 — 跨租户 query 拿到 200 而非 403 |
| H5 所有错误一律吞成 404 | `http-routes.cjs` | exit 1 — 非 NotFound 错误变 404 |
| H6 返回 `[run]` 列表形状 | `http-routes.cjs` | exit 1 — `single-run read returns an object, not a list` |

## 4. 边界核对

- 跨租户：query `tenantId` 为他租户 → 403（`resolveTenantId`），registry 零调用（测试 `cross-tenant query never reached the registry`）。
- 存在性 oracle：他租户 run 与不存在 run 的 404 响应体 `deepEqual` 相等；体内不含 tenant / id / workspace 字面量。
- 权限阶梯：匿名 401 `UNAUTHENTICATED`；`other:read` 403 `FORBIDDEN`；`integration:write` 也能读（与 `runsList` 同阶梯）。
- 可选方法：删掉 mock 的 `getPipelineRun` 后 mount 仍成功且路由已登记；调用得 501 `RUN_READ_NOT_IMPLEMENTED`；同一 host 上匿名仍是 401（501 在门后）。
- workspace 归一：无 workspace 提示时 route 边界为 `null`，`runsList` 对同形请求同为 `null`（parity 断言）。

## 5. 残余

- `packages/openapi` 契约、`apps/web` 工作台未接入。
- `index.cjs` facade 未加同形方法（避免连带重算 `pluginIndex` pin）。
- 400 `RUN_ID_REQUIRED` 分支在 Express 下不可达，未测。
- 本机未跑整条 `test-chain`（只跑了三条直接相关项）；CI 为准。
