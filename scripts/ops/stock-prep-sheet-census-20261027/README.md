# 备料项目表「双份」只读普查包（2026-10-27，batch-refresh step 6d-1a / S6-0）

一个**只读 psql 包**：`_preamble.sql`（共享执行契约）+ `01-sheet-census.sql`（普查本体）。只含
`SELECT`，没有任何 `INSERT` / `UPDATE` / `DELETE` / DDL，不需要安装任何程序包——R 维护线
（R74/R75）和 main 上都能直接跑。它回答一个问题：**每张备料项目表上，design-final §6.1 的几种
「双份」形状各有多少**（D1 两份都有效、D2 第 10 项那种「旧行全失效、副本在 P 下」、D3 重复键、
D4 无键行、D5 非布尔的「有效」单元格），以及隐藏行 / 副本上有没有人工填写。

> **生产执行状态：未执行。** 本包**从未在任何真实数据库上跑过**。在客户机上运行属于读取客户
> 数据，须 owner 另行授权（设计 O6-3；plan §10「客户机只读普查…按各自授权范围执行」）：目标库、
> 只读身份、窗口、超时与证据去向逐项由 owner 定。下文的验证全部在一次性合成 PostgreSQL 上、
> 全假数据完成。

## 1. 唯一的执行方式

整文件跑，一条命令：

```bash
export PGAPPNAME=stock-prep-sheet-census-20261027
export PGCLIENTENCODING=UTF8
psql "$READONLY_DATABASE_URL" -X -q -v schema=public -f 01-sheet-census.sql > census.log 2>&1
grep -h '^CENSUS_' census.log
```

客户机默认远程 shell 是 PowerShell 5.1（不认 `&&`；中文系统要显式 UTF-8）：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PGAPPNAME = 'stock-prep-sheet-census-20261027'
$env:PGCLIENTENCODING = 'UTF8'
psql $env:READONLY_DATABASE_URL -X -q -v schema=public -f 01-sheet-census.sql *> census.log
Select-String -Path census.log -Pattern '^CENSUS_'
```

可选变量：

| 变量 | 作用 |
|---|---|
| `-v schema=<schema>` | 固定 `search_path`（不传则用角色默认值） |
| `-v tenant=<tenant id>` | 只普查这一个租户的登记行（不传 = 全部租户）。序号随之重排 |
| `-v emit_private_map=1` | **私有输出**：另打印「序号 → objectId」对照（见 §4）。默认不打印 |

### 前置条件（每条都不是可选项）

- **只读角色**：用只有 `GRANT SELECT` 的角色连接。包本身还会 `SET default_transaction_read_only = on`
  并在 `BEGIN … READ ONLY` 事务里读，那是纵深防御，不替代账号层只读。
- **超时**：前言固定 `statement_timeout=120s`、`lock_timeout=5s`、`idle_in_transaction_session_timeout=30s`。
- **psql ≥ 10**（`\if` / `\gset`）。
- **服务器编码 UTF8、pgcrypto 的 `digest()` 可调用**（R74 迁移 041 / 042a 已 `CREATE EXTENSION IF NOT
  EXISTS pgcrypto`）。任一不满足，包输出一行 `CENSUS_RESULT … status=incomplete reason=…` 后退出，不报错。

## 2. 输出与完成态口径

每张登记的项目表一行（序号按登记行 `created_at, id` 排，**每次运行各自编号**）：

```
CENSUS_SHEET ordinal=1 registry_status=active status=complete row_count=… active_row_count=… two_copy_components=… inactive_root_remnant_components=… duplicate_key_groups=… keyless_rows_without_creator=… keyless_rows_with_creator=… non_boolean_active_cells=… inactive_rows_with_human_cells=… nested_copies_with_human_cells=… sheet_rows_all_projects=…
CENSUS_SHEET ordinal=2 registry_status=archived status=incomplete reason=sheet_id_mismatch
```

最后一行永远是：

```
CENSUS_RESULT file=01-sheet-census.sql status=complete sheets=<n> complete=<n> incomplete=0 tenant_filter=off|on
CENSUS_RESULT file=01-sheet-census.sql status=incomplete reason=<原因> …
```

判读规则：

1. `status=complete` → 每张表的数字都可用。
2. `status=incomplete reason=sheet_checks_failed` → 至少一张表自检失败，那几行**没有数字**，其余行仍可用。
3. `status=incomplete reason=server_encoding_not_utf8 | pgcrypto_digest_missing | registry_missing | meta_tables_missing | missing_column_meta_records_created_by` → 整体没跑，没有任何表的数字。
4. **根本没有 `CENSUS_RESULT` 行** → 中途夭折（语法错误、权限不足、超时、断连、输出截断），按不完整处理。

任何一种不完整都**不得解读为「零张双份表」**。

### 每张表的自检（失败即该行 `status=incomplete`、不给数字）

| reason | 含义 |
|---|---|
| `sheet_id_mismatch` | 由 `tenant_id || ':integration-core'` 与 `object_id` 推导的表 id（`'sheet_' || sha1 前 24 位`）≠ 登记的 `sheet_id`（例如工作区作用域部署）。此时字段 id 也推导不出，宁可不数 |
| `sheet_missing` | 推导出的表不存在或已软删 |
| `field_missing` | `projectNo` / `idempotencyKey` / `componentSourceId` / `parentSourceId` / `active` 任一推导出的字段 id 不在这张表上 |

## 3. 每个数的定义（与纯模块逐条相同）

这些定义与 `plugins/plugin-integration-core/lib/stock-preparation-sheet-census.cjs`（`censusOfRows`）
头部的定义表**是同一份**；两边一致性由真库用例 S9D-02 逐表比对（`packages/core-backend/tests/
integration/stock-preparation-sheet-census-realdb.cases.ts`）。只数这张表上**本项目**的行
（`data ->> <projectNo 字段> = 登记的 project_no`，与项目作用域读取同一个等值过滤），只数 `meta_records`
里的在册行（回收站 `meta_records_trash` 不算）。

| 列 | 定义 |
|---|---|
| 有效 | 只有 JSON 布尔 `false` 算失效；字符串 `'false'`、`0`、`null`、缺单元格都算**有效**（F-11） |
| 空 | 缺失、JSON null、或按 JavaScript `trim()` 去空白后为空的字符串（含 NBSP、全角空格等，逐字符与 JS 一致）。布尔 `false`、`0`、`[]` **不算空**（取消勾选也算一次填写——只会多数，不会少数） |
| 根行 | `parentSourceId` 为空 |
| 组件 / 键 | `componentSourceId` / `idempotencyKey` 为非空字符串时取其**原值**（不 trim），否则无 |
| 创建人 | `meta_records.created_by` 非空（去空白后） |
| `two_copy_components` | D1：同一组件既有有效根行、又有有效嵌套行（即就绪检查 O-6 的数） |
| `inactive_root_remnant_components` | D2（第 10 项形状）：有失效根行、**没有**有效根行、且至少一行有效嵌套副本。O-6 看不到它 |
| `duplicate_key_groups` | D3：被两行及以上占用的键（有效失效都算——失效行仍占着键） |
| `keyless_rows_without_creator` | D4：无键、无创建人的**有效**行（插件写的；缺陷） |
| `keyless_rows_with_creator` | D4：无键、有创建人的**有效**行（人工补充行，owner 10-27 规则；不是缺陷） |
| `non_boolean_active_cells` | D5：「有效」单元格存在、非 null、且不是布尔 |
| `inactive_rows_with_human_cells` | 失效行里至少有一个非空人工列（模板人工列）的行数 |
| `nested_copies_with_human_cells` | D1/D2 组件的**有效嵌套首行**里至少有一个非空人工列的行数 |
| `sheet_rows_all_projects` | **仅本包**：这张表上全部在册行（不论项目），用来看「一表一项目」；不在模块里、不参与一致性比对 |

## 4. 去值（values-free）与私有对照

- 默认输出只有序号、登记状态（`active`/`archived`）、自检原因和整数。没有项目号、objectId、表 id、
  租户、物料或图号。
- **objectId 不是秘密但可被暴力还原**：它是 `sha256(tenant:projectNo)` 的前 24 位，仓库公开、租户 id
  已知时可逐个猜项目号。所以 `-v emit_private_map=1` 打印的「序号 → objectId」对照（`CENSUS_PRIVATE`
  行，前面有一行 `-- PRIVATE` 提示）**只进私有记录**，绝不进 #6079、issue 或 PR 正文。公开证据只贴
  计数或「本帖序号」。runbook 的占位符规则同样适用（`runbook-stock-prep-project-sheets-switch-on-20261014.md:6`）。
- 私有对照与普查在同一个 `REPEATABLE READ READ ONLY` 快照里取，两者的序号一致。

## 5. 为什么 R74/R75 上能直接跑

包只读这几样东西，在 `onprem-r74` 与 main 上**逐字节相同**（已比对）：

| 读的对象 | 来源 |
|---|---|
| `integration_stock_prep_project_target`（`id, tenant_id, project_no, sheet_id, object_id, status, created_at`） | 迁移 087 |
| `meta_sheets(id)`（`deleted_at` 经 `to_jsonb` 读取，没有该列也不报错）、`meta_fields(id, sheet_id)`、`meta_records(sheet_id, data, created_by)` | 多维表核心迁移；`created_by` 自 `zzzz20260406093000` |
| `digest(bytea, text)` | pgcrypto（R74 迁移 041 / 042a） |
| 表 id / 字段 id 推导 | `packages/core-backend/src/multitable/provisioning.ts` 的 `stableMetaId`；项目表 objectId 推导 `stock-preparation-own-base.cjs` |

R 线没有 102–104（步骤 4）表，所以本包不输出「是否受治理」列；那一维由 main 上的普查路由（6d-1b）给。

## 6. 已知局限（写明，不假装没有）

- 人工列只看**模板人工列**（`HUMAN_PRESERVED_FIELD_IDS` 那 13 个，插件测试钉死两边一致）。客户包 `ext_`
  人工列要连客户包台账才知道是哪几个——main 上的普查路由（6d-1b）和填写报告（6d-2a）覆盖。
- 只普查**登记过的**项目表；未登记的旧混合表不在内。
- `nested_copies_with_human_cells` 只看副本的**首行**，不看它的子树；子树逐对比较是填写报告（6d-2a）的事。
- 数据单元格里若出现与逻辑字段 id 同名的**原始键**（不是推导出的物理字段 id），本包不读它；正常写入不会出现。

## 7. 验证（只连一次性合成库）

- 插件封闭测试 `plugins/plugin-integration-core/__tests__/stock-preparation-sheet-census.test.cjs`
  （SC-01 / SC-02）：模块在 D1–D5 上的计数；本包的静态契约（前言、无写语句、只读这几张表、人工列清单
  = `HUMAN_PRESERVED_FIELD_IDS`、JS 空白字符集逐字符、默认输出不含值、`object_id` 只在私有块里出现）。
- 真库用例 S9D-02 / S9D-03（挂在已接线的 stock-prep 真库宿主
  `stock-preparation-p4-repair-once-realdb.test.ts` 下，不改工作流）：用**真实开表流程**建三张合成项目表，
  由 CI 机器自带的 `psql` 真跑本包，逐表与 `censusOfRows`（经项目作用域读取）比对全部计数；默认输出不含
  哨兵项目号 / objectId / 表 id / 租户；`sheet_id` 不匹配与表缺失两种自检各输出一行 `incomplete`、不给数字。

本地复现（只连一次性合成库，不要指向任何真实库）：

```bash
DATABASE_URL=postgresql://<user>@127.0.0.1:5432/<scratch db> METASHEET_REAL_DB_TEST_STEP=1 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/stock-preparation-p4-repair-once-realdb.test.ts -t census
```

`psql` 不在 PATH 上时可用 `PSQL=<psql 路径或一个转发脚本 .cjs>` 指定。

## 8. 文件清单

```
scripts/ops/stock-prep-sheet-census-20261027/
├── _preamble.sql      （共享执行契约：ON_ERROR_STOP / 只读 / 超时 / search_path）
├── 01-sheet-census.sql（普查本体）
└── README.md          （本文件）
```

本包没有 `scripts/ops/__tests__` 子测试（`EXPECTED_OPS_TESTS_COUNT` 不变），也没有列进
`ops-sql-pack-verify.yml`（那是改工作流，需要带 `workflow` 权限的账号，可选、以后再做）；它的真库证据是 S9D-02。
