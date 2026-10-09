# 验证记录：admin 批量删改 `data_sources` → 409 引用拒绝（H2）

- 日期：2026-09-20（本机 `date`：Sun, Sep 20, 2026 09:25 本地时区）
- 基线 commit：`1a6663a41`（`origin/main`）
- worktree：`C:/Users/zhou/Downloads/dev/metasheet-wt-w8b`
- **未连接任何真实数据库**：kysely 句柄在模块边界被 `vi.mock('../../src/db/kysely')` 替换，所有"驱动错误"都是内存里构造的对象。

## 1. 改了哪些文件

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/routes/admin-routes.ts` | 新增 `referencedRefusalBody` / `findReferencedDataSourceIds` / `referencedDataSourceIdsForRefusal`；DELETE、PUT 两条 `/data/bulk` 各加预检 + catch 映射；从 `DataSourceManager` 引入 `isLiveConnectionFkViolation` 与 409 code（复用，未另造） |
| `packages/core-backend/tests/unit/admin-bulk-data-sources-fk-409.test.ts` | 新增，16 例，`usePinnedServer()` + `request(pinned.url())`（#4154） |
| `docs/development/data-source-live-id-fk-binding-lock-design-20260920.md` | §7 覆盖矩阵第 5 行 → covered |
| `docs/development/admin-bulk-data-sources-fk-409-design-20260920.md` | 新增设计 |

## 2. 用例矩阵（全部实跑）

| 组 | 用例 | 断言 |
|---|---|---|
| ② 兜底 | DELETE + 23503 on live FK / 迁移前 legacy FK / 驱动未报约束名（三参数化） | 409、`code=DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS`、`details.table='data_sources'`；**变更确实发生过**（兜底层不是预检）；响应里不含驱动原文 |
| ② 兜底 | PUT set `deleted_at` + 23503 on live FK | 同上 |
| ② 兜底 | 竞态：预检看不到绑定 → 变更撞 FK → 拒绝时再查已看得到 | 409 且 `details.ids=[SOURCE_ID]`，引用查询跑了 2 次 |
| ② 兜底 | 查询本身失败（57P01） | 仍 409，`details.ids=[]`（顾问性：状态码不会错，只是报不出 id） |
| ① 预检 | DELETE 命中被引用源 | 409、`details={table,ids:[SOURCE_ID]}`、**`mutations` 为空**（一条 DELETE 都没发） |
| ① 预检 | PUT set `deleted_at` 命中被引用源 | 同上，UPDATE 未发 |
| ① 预检 | 未被引用 | 200，变更照常 |
| ① 预检 | 引用表不存在（42P01） | 按 0 引用处理 → 200（严格按 SQLSTATE，不读散文） |
| 边界 | 23503 但约束名是**别的** | 500、无 `code` |
| 边界 | 同一个绑定约束名但目标表是 `tables` | 500、无 `code`；**且完全没跑预检**（`selects` 为空） |
| 边界 | 非 23503（57P01） | 500、无 `code` |
| 边界 | PUT 只改 `name` | 200，且**一次预检查询都没发** |
| 边界 | PUT `deleted_at: null` | 200，无预检 |
| 回归 | 未知表 / 空 filters | 仍 400，且不发任何查询与变更 |

命令与结果：

```
pnpm exec vitest run tests/unit/admin-bulk-data-sources-fk-409.test.ts
→ Test Files 1 passed (1) / Tests 16 passed (16)
```

## 3. 变异自证（内存级，零落盘变异）

变异手法：**不改源文件**，用一份临时探针 spec（正文与真 spec 逐字相同，只多一个 `vi.mock('../../src/data-adapters/DataSourceManager', …)` 覆写被引入的判定函数），跑完即删；`git status` 复核为干净。第三组变异的是**测试替身**（把引用查询致盲），用来证明预检那几条断言确实吃查询结果。

| # | 变异 | 结果 |
|---|---|---|
| m1 | `isLiveConnectionFkViolation` 恒 `false`（= 删掉兜底映射） | **6 failed / 10 passed**：四条兜底用例 + 竞态 + 查询失败回退全红（`expected 500 to be 409`） |
| m2 | `isLiveConnectionFkViolation` 放宽为"任意 23503"（不看约束名） | **1 failed / 15 passed**：恰好是 `a 23503 carrying ANOTHER constraint name keeps its 500`（`expected 409 to be 500`）。"别的目标表"那条仍绿，因为它靠 `table` 判据而非约束名 |
| m3 | 引用查询恒返回空（= 预检瞎了） | **3 failed / 13 passed**：两条预检用例 + 竞态用例红 |

m1/m2 正是任务点名要的两个变异；m3 补上预检一侧。

## 4. 其它闸门

| 闸门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm exec tsc --noEmit -p tsconfig.json`（core-backend） | 无输出（通过） |
| lint | `pnpm exec eslint src/routes/admin-routes.ts` | 0 error；1 条既有 warning（`getIdempotencyStats` 未使用，与本次改动无关） |
| 相邻不回归 | `vitest run` 9 个套件：本 spec + `data-source-remove-ordering` / `data-source-scope` / `data-source-plugin-facade` / `data-source-live-id-binding-lock-migration` / `admin-read-gates-batch2/3-authz` / `admin-safety-confirm-authz` / `admin-users-routes` | **266 passed / 9 files** |
| admin 结构守卫 | `multitable-sheet-liveness-closure-all-routes.guard` + `admin-dlq-read-authz` + `admin-snapshot-delete-authz` + `admin-yjs-status-routes` | **84 passed / 4 files** |
| #4154 | 新 spec 无 `request(app)`，全部 `request(pinned.url())` | 人读 + grep 确认 |
| 值面 | 新增日志只记 `table` / `referencedCount` / `constraint` / `sqlstate`，不记驱动原文；409 体是固定句 + 调用方自己给的 id | 用例里显式断言响应不含驱动原文 |

## 5. 否定性结论（均已亲读代码）

- 这两条批量路由**没有服务层**：SQL 就在 handler 里拼（`admin-routes.ts` 两条 `/data/bulk` 的 `db.deleteFrom(table…)` / `db.updateTable(table…)`），所以 23503 从 kysely 的 `execute()` 直接冒到 handler 的 catch —— 映射只能放在路由层。
- 改动前这两处 catch 只有 `logger.error` + `res.status(500).json({ success:false, error: err.message })`，没有任何 SQLSTATE 分支（这就是"裸 500"的出处）。
- `DataSourceManager.ts:50` 的 `isLiveConnectionFkViolation` 与 `:31` 的 code 常量是**既有导出**，本 PR 只是 import，未复制其逻辑，也未修改 `DataSourceManager.ts`。

## 6. 残余

- **鉴权**：这两条批量路由只有 `requireSafetyCheck`，没有 `requireAdminRole`。本 PR 不动（属 ADM-05 那条线），但这里明确登记：一个非管理员用户若能过 safety 闸，仍能对 `validTables` 里的任何表发批量删改。
- **legacy 绑定形态**不在覆盖内（无 FK，预检也不查），沿用上游设计 §7 的登记。
- **`ids` 可能为空**：预检查询失败时的 409 只有 code 与 table，没有 id 清单——这是"宁可少说不可错判"的取舍。
- **未上 222、未接真库**：本轮全部是内存级替身；真库行为由 #5896 的验证记录（PG 16.9 实测）背书。
