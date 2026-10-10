# DataSourceManager.removeDataSource 顺序修复（PERM-04）验证

- 日期：2026-09-16
- 分支：`fix/data-source-remove-ordering`，基线 `origin/main` = `38caaf17bfc8eeca23e23f6dfe796683d35ab525`
- 环境：本机 Windows 11 / Node（pnpm 9.15.9 workspace，`pnpm install --frozen-lockfile` 通过）、vitest 1.6.1
- 设计文档：`docs/development/data-source-remove-ordering-design-20260916.md`

新增用例文件：`packages/core-backend/tests/unit/data-source-remove-ordering.test.ts`（12 个用例：manager 层 9 + 路由层 3）。

## 1. 红 → 绿

### 1.1 红：基线（未修复）的 `removeDataSource` 原体

把修好的 `removeDataSource` 整个方法替换回 38caaf17b 的原文（只保留新 code 常量，让 import 能解析），跑新用例：

```
 Test Files  1 failed (1)
      Tests  9 failed | 3 passed (12)
```

失败项（`→` 后是断言原文）：

```
 ❯ DB write FAILS => coded values-free refusal; adapter, connectionPool and scope are untouched
   → expected null not to be null
 ❯ a failed delete leaves NO ghost: the restarted manager and the live one agree
   → promise resolved "undefined" instead of rejecting
 ❯ DB write SUCCEEDS => memory is still intact AT WRITE TIME, cleared after, disconnect last
   → expected { inMemory: false, pool: false, …(1) } to deeply equal { inMemory: true, pool: true, …(1) }
 ❯ disconnect FAILS after a committed delete => still resolves; the delete is not rolled back
   → promise rejected "Error: Login failed for user "svc_plm" at…" instead of resolving
 ❯ hardDelete keeps the same ordering: the row is gone before memory is cleared
   → expected false to be true // Object.is equality
 ❯ referenced and NOT forced => coded 409, no db write, memory unchanged
   → expected undefined to be 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SY…' // Object.is equality
 ❯ the legacy pointer counts only with the owner stamp (the existing P2-A attribution)
   → promise resolved "undefined" instead of rejecting
 ❯ a non-42P01 reference-count failure fails CLOSED: no write, no memory change
   → promise resolved "undefined" instead of rejecting
 ❯ db write fails => non-200 coded refusal, values-free, and the source still answers
   → expected 200 not to be 200 // Object.is equality
```

最后一条是 bug 本体：**数据库写失败，DELETE 路由仍然返回 200**。

### 1.2 绿：修复后

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

## 2. 变异探针

变异全部在工作树上临时施加、跑完立即从 scratchpad 备份还原；还原后 `sha256sum` 与变异前一致（`c4759920b34417fc2b194bc44e7e4b0a863fb25ebf7884b8b99abc477c03cab6`），`git status` 干净。

| 探针 | 变异内容 | 结果 |
|---|---|---|
| M1 | 整个方法体还原成 38caaf17b 原文（先断开、先清内存、写库失败只 warn、无引用检查） | **9 failed / 3 passed** |
| M2 | 只把「清内存」三行搬回数据库写之前（即"先写库"改回"先清内存"），其余不动 | **5 failed / 7 passed** |
| M3 | 只删掉写库失败时的 `throw`（恢复成只 `console.warn`），顺序保持不变 | **3 failed / 9 passed** |
| M4 | 只删掉 ① 引用检查整块 | **3 failed / 9 passed** |
| 还原 | 还原为修复版 | **12 passed** |

M2 的 5 条红（这是任务指定的那条变异）：

```
 ❯ DB write FAILS => coded values-free refusal; adapter, connectionPool and scope are untouched
   → expected false to be true
 ❯ a failed delete leaves NO ghost: the restarted manager and the live one agree
   → expected false to be true
 ❯ DB write SUCCEEDS => memory is still intact AT WRITE TIME, cleared after, disconnect last
   → expected { inMemory: false, pool: false, …(1) } to deeply equal { inMemory: true, pool: true, …(1) }
 ❯ hardDelete keeps the same ordering: the row is gone before memory is cleared
   → expected false to be true
 ❯ db write fails => non-200 coded refusal, values-free, and the source still answers
   → expected 404 to be 200
```

M3 的 3 条红：`DB write FAILS …` / `a failed delete leaves NO ghost …` / `db write fails => non-200 …`。
M4 的 3 条红：`referenced and NOT forced …` / `the legacy pointer counts only with the owner stamp …` / `a non-42P01 reference-count failure fails CLOSED …`。

顺序断言不是从末态推断的：假 db 在执行删除写入的那一刻回调 `onDataSourceWrite`，当场读 `adapters` / `connectionPool` / `scopes`；`disconnect` 的 spy 也在被调时当场读内存与行状态。所以"先写库"与"释放放最后"是被直接观测的。

## 3. 相邻 suite

`packages/core-backend` 下 `tests/unit` 里文件名含 `data-source` / `datasource` 的全部 spec + `outbound-sql-write-gate`（直接调 `removeDataSource`）+ supertest tripwire，一次跑：

```
 Test Files  20 passed (20)
      Tests  334 passed (334)
```

清单：`data-source-a5-adapter-conformance`、`data-source-connect-failure-cleanup`、`data-source-connect-refusal`、`data-source-credential-encryption`、`data-source-identifier-quoting`、`data-source-k3-destination-fence`、`data-source-mysql-schema`、`data-source-plugin-facade`、`data-source-readonly`、`data-source-remove-ordering`、`data-source-result-boundary`、`data-source-schema-list-only`、`data-source-scope`、`data-source-sealed-snapshot-connection`、`data-source-test-ephemeral`、`data-source-test-error-fidelity`、`data-source-visibility-authority-matrix`、`plm-workbench-datasource-ownership`、`outbound-sql-write-gate`、`supertest-app-mode-tripwire`。

另外把其余 import 了 `routes/data-sources` 或 `data-adapters/DataSourceManager` 的 spec 也跑了一遍：

```
 Test Files  6 passed (6)
      Tests  160 passed (160)
```

（`mssql-adapter`、`plm-embed-discussion-read-routes`、`plm-embed-discussion-routes`、`plm-embed-routes`、`plm-workbench-bom-multitable-routes`、`plm-workbench-capabilities-routes`）

### 3.1 一处相邻改动（必要）

`tests/unit/data-source-scope.test.ts` 的 `statefulFakeDb` 原本只实现 `selectFrom().selectAll()`。`removeDataSource` 现在在写库前先查引用，于是 `selectFrom('integration_external_systems').select(...)` 打到一个没有 `.select` 的 builder，两条 round-trip 用例以 `this.db.selectFrom(...).select is not a function` 变红：

```
 ❯ a source recreated with the same id after deletion still loads after a restart
 ❯ updating autoConnect is persisted so restart behavior is consistent
   → this.db.selectFrom(...).select is not a function
```

修法是给这个假件补上 `integration_external_systems` 的 COUNT 形态（建模"引用表已安装、零引用"，`tests/unit/data-source-scope.test.ts:121-136`），不是放宽产品代码。补完该文件 24/24 绿。

### 3.2 supertest tripwire

`tests/unit/supertest-app-mode-tripwire.test.ts` 随上面 20 文件那一轮一起跑，绿。新 spec 用的是 `usePinnedServer()` + `request(pinned.url())`，没有 `request(app)`。

## 4. 类型检查

- 包级（`src`，包 tsconfig 排除 `**/*.test.ts`）：`npx tsc --noEmit -p tsconfig.json` → 无输出，退出码 0。
- 本次两个 spec：包 tsconfig 排除测试，用临时 tsconfig 单查（include = `src/**/*` + `types/**/*` + 两个 spec + `tests/utils/pinned-server.ts`，exclude 保留 `src/**/*.test.ts`、`src/**/__tests__/**` 以避开与本次无关的既有类型债）→ 无输出。临时 tsconfig 跑完即删，未入库（`git status` 已确认）。

## 5. 未做 / 未验证

- **没有数据库事务**：引用检查与软删之间没有 `BEGIN/COMMIT`，并发新建引用仍有一个读-写窗口（设计文档 §5.2 有具体建议）。本轮不在断言范围内。
- **没有真实数据库验证**：全部用例走假 Kysely，没有连真 PG 验证 `deleted_at` 的实际写入与 `loadFromDatabase` 的真实过滤；重启语义是用"第二个 manager 读同一组行"模拟的。
- **222 未上机**：本改动未部署到 222，没有现场删除失败的实测。
- **未跑整包 `test:unit`**：只跑了上面 26 个文件（334 + 160）。本机整包历史上有与改动无关的红（另见记忆条目），以 CI 为裁判。
- **`force` 逃生门语义未动**，按任务要求仅登记为待裁决。
