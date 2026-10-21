# 外部系统删除守卫的二阶指针计数（079 / 062 / 073）— 验证

- 日期：2026-09-20
- 分支：`fix/external-system-delete-secondary-pointer-count`，基线 `origin/main` @ `36d659c8a`
- 设计：`docs/development/external-system-delete-secondary-pointer-count-design-20260920.md`
- 全程**未连接任何真实数据库**：所有用例跑在内存假 db 上（`countRows/selectOne/deleteRows` 的结构化桩）。

## 1. 侦察（否定性结论的出处）

| 断言 | 证据 |
|---|---|
| 079 存的是 `external_system_id`，不是 `dataSourceId` | `packages/core-backend/migrations/079_create_integration_stock_prep_source_binding.sql:45`（列定义）、`:16-23`（刻意不建 FK 的理由） |
| 062 存的是 `system_id`，不是 `dataSourceId` | `packages/core-backend/migrations/062_create_integration_read_source_configs.sql:27` |
| 073 是**第三张**同形表，且是活的 | 列定义 `migrations/073_create_sealed_export_stock_prep_runtime_authority.sql:19`，状态词表 `:32`（`ACTIVE`/`RETIRED`），`workspace_id` 可为 NULL `:17`；写侧 `scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs:15` → `lib/sealed-export/stock-preparation-runtime-provisioning.cjs:8` → `sealed-export-lifecycle-provisioning.cjs:294`；读侧 `index.cjs:76` → `lib/sealed-export/stock-preparation-sqlserver-runtime.cjs:38` → `stock-preparation-runtime-store.cjs:14`/`:133`；值确系 `external_systems.id`：`stock-preparation-sqlserver-source-authority.cjs:254` |
| 073 的 `RETIRED` 不是活指针 | `stock-preparation-runtime-store.cjs:112-125` 的 `normalizeBinding`：`status !== 'ACTIVE'`（`:120`）即 `SEALED_EXPORT_BINDING_UNQUALIFIED` |
| 073 内没有第二个持指针列 | 同文件里 `external_system_id` 的另两处 `:245`/`:261` 是同表锚点不可变触发器（`:237-279`） |
| 指向外部系统的持久化列就是 057/062/064/073/079 五处 | `grep -rn "external_system_id\|system_id" packages/core-backend/migrations/` 仅命中这五个文件；057 是真 FK（`057:58`、`:60`），064 的 store 休眠（`lib/write-target-config-store.cjs:134` 定义、`:356` 导出，`__tests__/` 之外零实例化） |
| 删除守卫原本只数 pipeline | `plugins/plugin-integration-core/lib/external-systems.cjs`（改动前）`countPipelineReferences` 只查 `integration_pipelines` 的两列，`deleteExternalSystem` 只用它 |
| 079 的 `workspace_id` 可为 NULL，且读路径有租户级回退 | `079:43`；`plugins/plugin-integration-core/lib/http-routes.cjs:4617-4626`（`scopeFallback === 'single_workspace_binding'`） |
| 062 的 `retired` 是终态、不可回头 | `plugins/plugin-integration-core/lib/read-source-config-store.cjs:23-28`（`VALID_STATUSES` + `STATUS_TRANSITIONS`，只有 `approve: draft→approved`、`retire: approved→retired`） |
| `db.countRows` 的 where 不支持 IN | `plugins/plugin-integration-core/lib/db.cjs:buildWhereClause`（每键一条 `= $n`；数组值经 `prepareParamValue` 变成 JSON 文本） |
| 冲突错误映 409 | `plugins/plugin-integration-core/lib/http-routes.cjs:871`（`if (/Conflict/.test(name)) return 409`） |
| `external-systems.cjs` / `test-chain.txt` 都不在 sha256 pin 里 | `lib/sealed-export/vectors/s6a-package-provenance-pins.json` 全文无这两个文件名；被 pin 的是 `pluginPackageJson` / `pluginHttpRoutes` / `pluginDb` 等，本 PR 均未触碰（`sealed-export-package-provenance` 绿可印证） |

## 2. 用例矩阵

`plugins/plugin-integration-core/__tests__/external-systems-delete-dependent-references.test.cjs`：

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| B-01 | 系统在 workspace `ws_a`，079 绑定行是**租户级**（`workspace_id IS NULL`） | 409，`stockPrepSourceBindingCount=1`，行未删 | 通过 |
| B-02 | 系统是租户级，079 绑定行在**非 NULL workspace** | 409，行未删；并断言实际发出的 where 键只有 `tenant_id` + `external_system_id` | 通过 |
| B-03 | 062 `draft` | 409，`readSourceConfigCount=1`，行未删 | 通过 |
| B-04 | 062 `approved` | 同上 | 通过 |
| B-05 | 062 仅 `retired` | 放行，系统被删 | 通过 |
| B-06 | 三表均 42P01（**中文 locale 的 message**） | 放行，系统被删 | 通过 |
| B-07 | 079 计数抛 `42501` | 原错误传播，非 Conflict，行未删 | 通过 |
| B-08 | 062 计数抛 `08006` | 原错误传播，行未删 | 通过 |
| B-09 | 他租户的 079 + 062 + 073 行 | 不计数，放行 | 通过 |
| B-10 | 同租户、指向**别的系统**的 079 + 062 + 073 行 | 不计数，放行 | 通过 |
| B-11 | 仅 pipeline 引用 | message 逐字仍为 `external system is used by pipelines`，`referencedPipelineCount=1`，新增 `referencedBindingCount=0`、`sealedExportBindingCount=0`；details 键集合断言为纯计数 + scope 句柄（values-free） | 通过 |
| B-12 | 系统在 workspace `ws_a`，073 绑定行是**租户级**且 `ACTIVE` | 409，`sealedExportBindingCount=1`，行未删；并断言实际发出的 where 键只有 `tenant_id` + `external_system_id` + `status`（值为 `ACTIVE`） | 通过 |
| B-13 | 073 仅 `RETIRED` | 放行，系统被删 | 通过 |
| B-14 | 073 计数抛 `42501`（073 是唯一 `REVOKE ALL FROM PUBLIC` 的表，`073:432-446`） | 原错误传播，非 Conflict，行未删 | 通过 |

B-02 是承重用例：它同时钉住「租户级行 vs workspace 级删除」与「workspace 级行 vs 租户级删除」两个方向，
再加一条对实际 where 键集合的断言——后人若「顺手」把 workspace 过滤加回去，这条立刻红。

## 3. 变异自证（内存级，未落盘）

变异方式：读 `lib/external-systems.cjs` 源文本 → 字符串替换 → `node:module` 的 `_compile` 就地编译成
另一个模块实例。**磁盘文件从未被改写**，已加载的正品模块不受影响（文件末尾有一条「正品仍拒绝」的回归断言）。
每个变异都先断言锚点存在（锚点消失 = 变异空转，直接红），杜绝假变异。

| # | 变异 | 预期翻转 | 实测 |
|---|---|---|---|
| M-1 | 去掉 079 计数（返回对象里 `stockPrepSourceBindingCount` 固定为 0） | B-01 由 409 变成删除成功 | 翻转（守卫失效，系统真被删） |
| M-2 | 把 062 的活状态放宽为 `['draft','approved','retired']` | B-05 由放行变成 409 | 翻转 |
| M-3 | 把 42P01 判据从 SQLSTATE 改成读 message（`/does not exist/`） | B-06 在**中文 locale** 下由放行变成错误传播 | 翻转（逃出的正是被容忍的那一个 42P01） |
| M-4 | 去掉 073 计数（返回对象里 `sealedExportBindingCount` 固定为 0） | B-12 由 409 变成删除成功 | 翻转（守卫回到本 PR 之前对 sealed-export 的形状：系统真被删） |
| M-5 | 去掉 073 过滤里的 `status` 键（任何状态都算活） | B-13 由放行变成 409 | 翻转 |

M-2 的断言按 `error.name` 而非 `instanceof`：变异体是独立模块实例，错误类是不同构造器；而 `name` 正是生产
路径上 `http-routes.cjs:871` 的判据，所以用 `name` 比 `instanceof` 更贴近线上。

## 4. 回归

本机 Windows，`node v25.9.0`，逐个套件直跑：

| 套件 | 结果 |
|---|---|
| `__tests__/external-systems-delete-dependent-references.test.cjs`（新增） | ✓ |
| `__tests__/external-systems.test.cjs` | ✓ registry + credential boundary tests passed |
| `__tests__/external-systems-list-workspace-fallback.test.cjs` | ✓ list non-null workspace hint fallback tests passed |
| `__tests__/http-routes.test.cjs` | ✓ REST auth/list/upsert/run/dry-run/staging/replay tests passed |
| `__tests__/db.test.cjs` | ✓ all CRUD + boundary + injection tests passed |
| `__tests__/read-source-config-store.test.cjs` | ✓ OK |
| `__tests__/stock-preparation-source-binding.test.cjs` | ✓ |
| `__tests__/stock-preparation-source-binding-scope-fallback.test.cjs` | ✓ |
| `__tests__/sealed-export-package-provenance.test.cjs` | ✓ OK（pin 未动） |
| `__tests__/sealed-export-s6a-runtime-store.test.cjs` | ✓ OK（073 读侧 store，未被本 PR 触碰） |
| `__tests__/sealed-export-lifecycle.test.cjs` | ✓ OK（073 写侧 provisioning） |
| `__tests__/write-target-config-store.test.cjs` | ✓ OK（064 的休眠 store，形状未变） |
| `__tests__/test-chain-completeness.test.cjs` | ✓ 228 suites, all executed by `pnpm test` (0 intentional exclusions) |

登记：`plugins/plugin-integration-core/test-chain.txt` 的新行插在同族旁（紧接
`external-systems-list-workspace-fallback`），不是追加到文件末尾；`package.json` 未改，
`pluginPackageJson` / `pluginHttpRoutes` 两个 pin 均未重算（`lib/http-routes.cjs`、`lib/db.cjs` 未触碰）。

## 5. 未做 / 残余

- 未建 FK、未写迁移、未清理**存量**悬空 079/062/073 行——那需要连真实库，属 owner 侧动作。本 PR 只阻止新增悬空。
- **064 `integration_write_target_configs` 刻意未计数**：其 store 今天休眠（`lib/write-target-config-store.cjs:134` 定义、`:356` 导出，`__tests__/` 之外零实例化）。接线它的人必须同时补这条计数；已登记在设计文档第 4 节的覆盖面表里，不再被一句「全仓穷举只有两张」盖住。
- **073 在仓内没有退场路径**：写侧只写 `status: 'ACTIVE'`（`sealed-export-lifecycle-provisioning.cjs:294`），仓内非测试面没有任何一处把 073 行置为 `RETIRED`，且锚点列被不可变触发器钉死（`073:237-279`）。于是已 provision 过 sealed-export 的外部系统，本 PR 之后只能由 owner 侧先退掉/删掉绑定行再删。方向 fail-closed，但这是新增的操作代价。
- **073 的 SELECT 授权是部署前置**：073 对 PUBLIC 是 REVOKE 的（`073:432-446`），API 角色若无 SELECT，删除会以 `42501` 被拒（B-14 钉住）。修法是补授权，不是吞错误。
- **062 的 draft 也没有直接退场路径**（非本 PR 引入）：`read-source-config-store.cjs:25-28` 只有 `approve`/`retire`，无 delete/discard；历史上留过 draft 的外接源必须逐个 approve 再 retire 才能删。可经既有路由完成。
- 未跑整条 `pnpm test`（228 个套件，耗时过长且与本改动无关面占绝大多数）；CI 是裁判。
- 未在 222 上机验证。
- 假 db 不复刻 PG 的 `COALESCE(workspace_id,'')` 唯一索引语义；本 PR 的计数不依赖这些索引，仅依赖等值过滤。
