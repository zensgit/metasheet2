# 场景 B · 合成 BOM 只读源（W7-A1）实证记录

2026-09-18（本机 `date`：`Fri, Sep 18, 2026 11:27:54 AM`）。
基线 `origin/main` = `62fd24461f4c1e1120be65ad9d803b67617a52b3`。
设计见 `scenario-b-synthetic-bom-source-design-20260918.md`。

## 0. 环境事实（先说清楚哪条没跑）

本机**没有可用的 PostgreSQL**，也没有 docker：

```
5432 ERR ECONNREFUSED
5433 ERR ECONNREFUSED
docker: command not found
```

所以 `packages/core-backend/tests/integration/scenario-b-synthetic-bom-source-run.test.ts` 里
**需要 `DATABASE_URL` 的那一个 describe（2 个用例）在本机是 skip 的，本刀没有在真 PG 上跑过**。
它按 `tests/integration/data-source-c3-keyset-realdb.test.ts` 的惯例写成 `DATABASE_URL`-gated，
待有库的环境（CI 或 A2 的本机库）跑。同一文件里 owner 门 / 只读姿态两个 describe **不需要库**
（`assertAccess` 是内存 scopes 表、`isReadOnly()` 是配置标志，都在 connect 之前判），本机真跑且绿。

## 1. 四条断言，逐条结果

| # | 断言 | 结果 | 在哪 |
| --- | --- | --- | --- |
| 1 | 行数：54 行全读到，两层父子都进了 intake 行平面，字段有真值（含 PG numeric 字符串→数字） | **绿** | 插件套件 `testEveryFixtureRowIsRead` |
| 2 | `adapter_reported` 完整性契约 | **不适用于本 kind（实证）**；成立的是 `short_page`/`declared_total` 证明 + 失败关闭 | 插件套件 `testCompletenessContractOnTheBFeederPath` / `testUnprovableReadsFailClosed` |
| 3 | 只读：任何写尝试被拒；整链零写调用；证据面自述未写 | **绿** | 插件套件 `testSourceIsReadOnly` + 宿主套件 read-only posture |
| 4 | 租户/权限门：无权限 403；跨主体不可见 | **绿**（403 在插件侧；跨主体在宿主侧用真 facade） | 插件套件 `testPermissionAndScopeGates` + 宿主套件 owner gate |

第 2 条的详细结论见设计文档 §6，摘要：`data-source:sql-readonly` 登记为 `honours_request`
（`stock-preparation-readonly-source-run.cjs:59-62`），适配器不钳制也不回显 `metadata.limit`，
所以 `adapter_reported` 这条契约根本不落在它身上。B 路径上完整性由**证明**成立：

- 54 行 → `completenessProof: 'short_page'`、`pages: 1`、`sourceRowsTruncated: false`
- 恰好 1000 行 → 跟进 offset 续页、续页为空 → 仍是 `short_page`、`pages: 2`（证明，不是假设）
- 10 × 1000 全满 → `SOURCE_RUN_RESULT_TOO_LARGE`（`details.maxPages: 10`），不报 ready
- 源无视页宽多给 5 行 → `SOURCE_RUN_RESULT_TOO_LARGE`（`details.receivedRows: 1005`）

**已知盲区**（`testKnownGapSilentlyClampingSourceIsNotDetected` 钉住）：悄悄钳制的源抓不住，
20 行会被当成完整快照。要消掉它得改适配器 metadata + 改 kind 契约登记，属产品改动，见设计 §6/§8。

## 2. 测试输出（原样）

插件侧（node:test，`test-chain.txt` 第 61 行）：

```
$ node __tests__/scenario-b-synthetic-bom-source-run.test.cjs
scenario-b synthetic BOM source-run tests: PASS

$ node __tests__/stock-preparation-readonly-source-run.test.cjs   # 既有姊妹套件未回归
stock-preparation readonly source-run tests: PASS

$ node __tests__/test-chain-completeness.test.cjs
✓ test-chain-completeness: 224 suites, all executed by `pnpm test` (0 intentional exclusions)
```

宿主侧（vitest）：

```
$ node_modules/.bin/vitest run tests/integration/scenario-b-synthetic-bom-source-run.test.ts --reporter=verbose
 ✓ … host owner gate (no database required) > refuses a read carried by ANOTHER principal with the uniform not-found — no existence leak
 ✓ … host owner gate (no database required) > refuses a read with no principal at all — never falls back to a default identity
 ✓ … host owner gate (no database required) > lets the owner through the same gate (so the two refusals above are not vacuous)
 ✓ … read-only posture (no database required) > refuses to READ a writable data source at the facade choke point, before any connection
 ✓ … read-only posture (no database required) > has no write verb on the adapter itself
 Test Files  1 passed (1)
      Tests  5 passed | 2 skipped (7)
```

（2 skipped = `describeIfDatabase` 的真 PG feeder 跑，本机无库，见 §0。）

## 3. 变异探针（全部内存级，不落盘改产品文件）

探针脚本在会话 scratchpad（`<scratchpad>/metasheet-wt-w7a/`），不入库。

### 3.1 去掉只读门 → 写被放行 → 红

把 `lib/contracts.cjs` 的 `unsupportedAdapterOperation` 在 require.cache 上换成放行版：

```
AssertionError [ERR_ASSERTION]: Missing expected rejection.
    at async testSourceIsReadOnly (…/__tests__/scenario-b-synthetic-bom-source-run.test.cjs:274:3)
```

### 3.2 去掉权限门 → 非 admin 放行 → 红

把 feeder 的 `if (input.permission !== REQUIRED_PERMISSION) {` 编译成 `if (false) {`：

```
AssertionError [ERR_ASSERTION]: Missing expected rejection.
    at async testPermissionAndScopeGates (…/__tests__/scenario-b-synthetic-bom-source-run.test.cjs:308:3)
```

### 3.3 去掉项目域守卫 → 别的项目的行被收下 → 红

把 `assertRowsStayInProjectScope` 的函数体改成立即 return：

```
AssertionError [ERR_ASSERTION]: Missing expected rejection.
    at async testPermissionAndScopeGates (…/__tests__/scenario-b-synthetic-bom-source-run.test.cjs:320:3)
```

### 3.4 去掉宿主 owner 门 → 跨主体可见 → 红

vitest setup 阶段把 `DataSourceManager.prototype.assertAccess` 换成放行：

```
⎯⎯⎯ Failed Tests 1 ⎯⎯⎯
- Data source with id 'scenario-b-owner-gate' not found
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed | 2 skipped (7)
```

## 4. 卫生

- `grep -cP '\x08'` 对全部新增文件 = 0（见下节命令）。
- `package.json` 未改；`.github/` 未改；`http-routes.cjs`（pin）未改 —— 本刀**没有改任何被 pin
  的文件**，因此无需重打 pin。
- 未连 222、未连任何真实库、未读真实 PLM/K3、未启用 autopersist。
- 新增/改动文件：
  - `plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/`（5 个文件，新增）
  - `plugins/plugin-integration-core/__tests__/scenario-b-synthetic-bom-source-run.test.cjs`（新增）
  - `plugins/plugin-integration-core/test-chain.txt`（+1 行）
  - `packages/core-backend/tests/integration/scenario-b-synthetic-bom-source-run.test.ts`（新增）
  - 本目录两份文档（新增）

## 5. 我不确定的点

1. 真 PG 那条 feeder 用例本机没跑过（无库）。它复用夹具 SQL、只把表名换成本次运行的独占名，
   逻辑上应当绿，但**这是推断不是实测**。
2. 该宿主套件没有被任何 workflow 显式点名；它落在 core-backend 默认 vitest 泳道里（不在
   `vitest.config.ts` 的 exclude 列表），所以无 DB 的 5 个用例应当会在 CI 跑，真 PG 的 2 个会
   skip。是否要给它一条像 `data-source-c3-keyset-realdb` 那样的 realdb 泳道 —— `.github/` 本刀
   不许碰，留给 A2/owner。
3. `adapter_reported` 的盲区（§1）要不要在 A2 之前消，需要 owner 裁决。
