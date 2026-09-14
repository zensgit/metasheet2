# 托管表 schema 写门 — 验证（2026-09-11）

配套设计：`docs/development/managed-sheet-schema-write-gate-design-20260911.md`。
本文只记"跑了什么、看到什么、哪条没跑"。

## 0. 本机能跑什么、不能跑什么

本机（Windows 开发机）**没有 PostgreSQL、也没有 docker**：`psql` 不存在、5432 无监听、无 `postgres*` 服务、
`docker` 命令不存在。所以**真库件本机一次都没跑过**，由 CI 的专用真库道判定：
`.github/workflows/managed-sheet-schema-write-gate-realdb.yml`（`EXPECT_DB=1` 武装文件顶层哨兵，
缺 `DATABASE_URL` 时该道变红而不是静默跳过）。

本机跑到的是：无库那半（mock pool + **真 express app + 真 `univerMetaRouter` + 真 permission service**）、
既有相邻用例、type-check、以及全部三项变异探针。

## 1. 真实路由用例（真库道，本机未跑）

`packages/core-backend/tests/integration/multitable-managed-sheet-schema-write-gate.db.test.ts`
— 真 express + 真 `univerMetaRouter()` + 真 permission service，能力全部由它自己种进库的
`spreadsheet_permissions` / `plugin_multitable_object_registry` 行推导，没有任何 capabilities mock。

| # | 演员 × 表 | 请求 | 期望 | 零落库证据 |
| --- | --- | --- | --- | --- |
| 1 | 表级 `spreadsheet:write`（无全局权限）× **托管表** | `POST /fields` | 403 + 精确 FORBIDDEN body | `meta_fields` 该表**行数**请求前后相等 |
| 2 | 同上（带调用方自选 id、名字与模板列同名） | `POST /fields` | 403 | 行数相等 **且** 该名字的列仍然只有 1 行（正是"同名死列"的失败形态） |
| 3 | 同上 | `PATCH /fields/:id` | 403 + FORBIDDEN body | 该列 `name`/`type` 与请求前逐字段相等 |
| 4 | 同上 | `DELETE /fields/:id` | 403 + FORBIDDEN body | 行数相等且该列仍在 |
| 5 | 同一演员 × **非托管表** | `POST /fields` | 201 | 行数 +1 |
| 6 | **admin** × 托管表 | `POST /fields` | 201 | 行数 +1（修复口子保持打开） |
| 7 | 表级写手 × 托管表 | `POST /records` | 200 + `ok:true` | `meta_records` +1（数据面未被误伤） |

断言用的是**行数相等**，不是"我试的那个名字不存在"：任何以别的名字/别的 id 落库的写入同样会让用例红。

## 2. 无库那半（本机真跑）

`packages/core-backend/tests/unit/multitable-managed-sheet-schema-write-gate.test.ts` — 16 用例，
本机 **16 passed / 16**（`npx vitest run tests/unit/multitable-managed-sheet-schema-write-gate.test.ts`）。

- §1 路由格（真路由、mock pool 记录每条 SQL）：托管表上 `POST` / `PATCH` / `DELETE /fields` 三条 403，
  除断言精确 FORBIDDEN body 外，还断言**整轮请求没有发出任何** `INSERT INTO|UPDATE|DELETE FROM meta_fields`
  —— 拒绝发生在事务之前；外加"非 admin 的全局 `multitable:manage-schema` 持有者在托管表上也是 403"，
  以及两条正控（同一演员在普通表 201、admin 在托管表 201，内存表各 +1 行）。
- §2 能力层（调真 `resolveSheetCapabilitiesForAccess`）：托管表非 admin ⇒ `canManageFields=false`，
  同时 `canRead/canCreateRecord/canEditRecord/canDeleteRecord/canManageViews` 逐位仍为 true；
  普通表同一演员 ⇒ true；admin ⇒ true；注册表查询抛错 ⇒ false（fail-closed）且数据面不受牵连；
  另有一条断言"无可收窄时根本不查注册表"（admin、以及只读演员）。
- §3 纯函数真值表 + `isPluginManagedSheetFailClosed` 三态（有行/无行/抛错）。

## 2.1 双解析器一致性（本机真跑）

`packages/core-backend/tests/unit/multitable-managed-sheet-schema-write-gate-resolver-parity.test.ts`
— 6 用例，本机 **6 passed / 6**。

针对的是设计文档 §3.3 的第二个能力解析器（`sheet-capabilities.ts:247 resolveSheetCapabilitiesForUser`，
Yjs/collab、automation、OAPI token 的能力口）。每个用例把**同一个**（用户、表、授权、admin 标志）输入
分别喂给两条解析器（各自一份同形状的假 DB，唯一的差别就是它们自己的代码），断言的是
两边 `canManageFields` **彼此相等**，不只是各自等于某个常量：

| # | 用例 | 结论 |
| --- | --- | --- |
| 1 | 托管表 × 非 admin × 表级全写授权 | 两边都 `false` |
| 2 | 非托管表，同一演员、同一授权 | 两边都 `true` |
| 3 | 注册表查询抛错（`42P01`） | 两边都 `false`（fail-closed），且两边 `canEditRecord` 仍为 `true` |
| 4 | 托管表 × admin | 两边都 `true`（admin 豁免逐字一致） |
| 5 | 托管表 × 非 admin：数据面 | 两边 `canEditRecord` 都为 `true` |
| 6 | "无可收窄就不查注册表" | 非 admin 持位时两边都发了注册表读；admin 时两边都没发 |

演员**不带任何全局权限码**（`PERMISSIONS = []`），`canManageFields` 只可能来自表级全写授权被
`applyContextSheetSchemaWriteGrant` 抬起来的那一位——也就是本门要收窄的那一层，两条解析器逐字共用的那一步。

### 变异（本机实跑，未落盘）

摘掉**第二解析器**的接线（`sheet-capabilities.ts:274-280` 整块删除，import 保留），其余不动：

| 变异 | 结果 | 哪些格变红 |
| --- | --- | --- |
| 去掉第二解析器接线 | **3 failed / 3 passed** | #1 托管表非 admin（`viaUser` 收到 `true`，与 `viaRequest` 的 `false` 不等）、#3 fail-closed（同上）、#6 注册表读（`userLog` 里一条都没有） |

`#2 / #4 / #5` 在变异下仍绿——正确：那三格本来就是"两边都 true"或"数据面不动"，摘掉门不改变它们，
这恰好说明红的三格是被**接线本身**而不是被别的东西钉住的。变异后立即还原，还原文件与备份逐字节相同
（`git diff` 回到只有 21 行新增）。

## 3. 变异表（本机实跑，未落盘）

基线：该文件 16/16 绿。每次变异只改一处，跑完立刻还原（还原后与备份逐字节相同）。

| 变异 | 改哪里 | 结果 | 哪些格变红 |
| --- | --- | --- | --- |
| M1 去掉接线 | `permission-service.ts:1794-1800` 整块删除 | **6 failed / 10 passed** | §1 四条拒绝格（`POST` 收到 **201**、`DELETE` 收到 200、`PATCH` 未再答 403、全局 schema 持有者 201）+ §2 "托管表非 admin 降 false" + §2 "fail-closed" |
| M2 判定不查注册表（改成对所有表一视同仁） | `permission-service.ts:1797` 的 `await isPluginManagedSheetFailClosed(query, sheetId)` → `true` | **2 failed / 14 passed** | §1 正控"同一演员 × 普通表 201"（收到 403）+ §2 "普通表仍为 true" |
| M3 lookup 抛错时放行 | `managed-sheet-schema-write-guard.ts:59-61` 的 `catch { return true }` → `return false` | **2 failed / 14 passed** | §2 "fail-closed" + §3 `isPluginManagedSheetFailClosed` 三态 |

M1 里 `PATCH` 那格在 mock pool 下变红的形态是 500 而不是 200 —— 因为这个无库 harness 没有实现 PATCH 事务里
后续的全部 SQL。它证明的是"403 来自本门"，不是"没有本门就一定改名成功"；**"没有本门就真的落库"由 M1 下
`POST` 那格收到 201、内存表 +1 行给出**，真库道的第 1/3/4 格给出同一结论的强证据。

## 4. 既有用例回归（本机实跑）

| 套件 | 结果 |
| --- | --- |
| `tests/unit/multitable-permission-service.test.ts` | 35 passed |
| `tests/unit/multitable-manage-schema-permission-matrix.test.ts` | 99 passed |
| `tests/unit/multitable-display-rename-authority.test.ts` | 82 passed |
| `tests/unit/multitable-link-field-foreign-sheet.test.ts` | 11 passed |
| `tests/unit/field-validation-wiring.test.ts` | 5 passed |
| 合计（上述 5 文件一次跑） | **232 passed / 232** |

`pnpm --filter @metasheet/core-backend type-check`（`tsc --noEmit`）：**0 错**。

### 4.1 本门改红、需要跟着改的既有用例（两处，都是测试件）

无库全量跑（`npx vitest run`，core-backend 默认配置＝required `test` job 的口径）先跑了一遍**带门**，
再把接线注释掉跑了一遍**基线**，逐文件比对。归到本门名下的只有两处：

1. `tests/unit/multitable-permission-subject-hydration.test.ts`（5 格 403，应为 200/500）。
   根因不是行为错，是**夹具缺应答**：该文件的 mock pool 对未登记 SQL 直接 `throw`，而本门的注册表查询
   fail-closed ⇒ 抛错＝当成托管表 ⇒ `canManageFields` 降掉 ⇒ 字段权限路由 403。修法是在它的
   `sheetScaffold` 里显式答"`sheet_ops` 没有插件登记行"（`{ rows: [] }`），与
   `tests/unit/multitable-manage-schema-permission-matrix.test.ts:146` 对删除守卫的既有做法同形。
   修后该文件 16/16 绿。
2. `tests/unit/multitable-recovery-archive-writer-closure-routes.test.ts`（1 格，SQL 序列 sha256 pin）。
   本门给恢复路由的 SQL 序列多了一条读（trace 第 3 条
   `SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1 LIMIT 1`），其余 5 条与三个响应
   逐字节不变。按该文件自己的先例**重打 pin**（旧值留在注释里）：
   `626bd3e1…56db455` → `568c3552…4dbaeac`。修后该文件 20/20 绿。

这两处以外的全量红格，带门/基线两轮**完全一致**（详见 §4.2），与本门无关。

### 4.2 无库全量三轮（本机实跑，Windows）

同一台机器、同一份工作树，只改"接线在/不在"这一处：

| 轮次 | 状态 | 结果 |
| --- | --- | --- |
| A 带门（修夹具与重打 pin **之前**） | 接线在 | 31 files failed / 66 tests failed / 12827 passed / 1571 skipped（1054 files） |
| B 基线（接线注释掉，其余与最终态相同） | 接线**不在** | 32 files failed / 68 tests failed / 12825 passed |
| C 最终态（接线在 + 两处测试件已修） | 接线在 | **29 files failed / 60 tests failed / 12833 passed / 1571 skipped** |

逐"文件 > 用例名"比对：

- C 相对 B **没有任何新增红格**（`comm -13` 空集）—— 也就是最终态里剩下的 60 个红格，
  在把本门摘掉之后同样是红的：与本门无关（attendance/elearning/approval 的源码静态扫描件、
  migration-provider、spike-b1c、Windows 下 `EPERM: symlink`、#3365 OAPI 扫描 tripwire 等，
  与记忆里"四个套件只在 Windows 上红、CI 才是裁判"一致）。
- B 相对 C 多出的 8 格＝本门自己的 6 格（**这就是 M1 变异在全量尺度上的复现**）
  + SQL pin 那 1 格（B 里 pin 已按带门的新值，接线摘掉自然不匹配）+ `plm-disable-routes.test.ts` 1 格
  （A 绿 B 红 C 绿，抖动件，与本门无关）。

### 4.3 第二解析器接线后的受影响套件（本机实跑，未跑全量）

内存吃紧，只跑**受影响**的套件：先 grep 出第二解析器的全部直接调用方
（`resolveSheetCapabilitiesForUser`）与间接调用方（automation-service 的 FWB 保存门、routes/api-tokens、
index.ts 的 collab/Yjs 接线），再逐个跑它们对应的 spec。

| 套件 | 结果 |
| --- | --- |
| `tests/unit/multitable-managed-sheet-schema-write-gate-resolver-parity.test.ts`（新增） | 6 passed |
| `tests/unit/multitable-managed-sheet-schema-write-gate.test.ts` | 16 passed |
| `tests/unit/approval-projection-capabilities-for-user.test.ts` | 7 passed |
| `tests/unit/yjs-hardening.test.ts` | 7 passed |
| `tests/unit/yjs-poc.test.ts` | 28 passed |
| 第一批合计（一次跑） | **64 passed / 64** |
| `tests/unit/multitable-automation-service.test.ts` | 52 passed |
| `tests/unit/automation-testrun-gate.test.ts` | 16 passed |
| `tests/unit/api-token-webhook.test.ts` | passed |
| `tests/unit/multitable-manage-schema-permission-matrix.test.ts` | 99 passed |
| `tests/unit/multitable-member-group-acl-hardening.test.ts` | passed |
| `tests/unit/approval-fwb-number-mapping-gate.test.ts` | **1 failed**（见下，与本改动无关） |
| 第二批合计（一次跑） | **219 passed / 220，1 failed** |
| `tests/integration/dingtalk-group-destination-routes.api.test.ts` | 13 passed |

`pnpm --filter @metasheet/core-backend type-check`（`tsc --noEmit`）：**0 错**。

**假 SQL 夹具：本轮一个都不用补。** 第二解析器的门带"无可收窄就不查注册表"前置
（`sheet-capabilities.ts:274`），而既有用例里走这条解析器的演员要么是 admin、要么没有全局
`multitable:manage-schema`、也没有表级 `canRead && canWrite` 授权（`yjs-hardening.test.ts` 那格是
read + write-own，`applyContextSheetSchemaWriteGrant` 不抬这一位），于是**新查询一次也没发出去**，
throw-on-unknown 的假 query 不会被触发。首提交给 `multitable-context.api.test.ts` 补应答那类假红
（f66badf00）在本轮没有复现。补过的文件清单：**空**。

那一格 `approval-fwb-number-mapping-gate.test.ts` 的红是 **Windows CRLF 检出导致的本机假红**，与本改动无关，
已逐字证伪：该文件 `git status` 干净（本支一个字节没动 `approval-fwb-activation.ts`），
工作树（CRLF）sha256 = `e8e393b7…babc0`，而 git blob（LF）sha256 =
`46f54ec5b7918388cb2cc5a8a5e2bf1e092963f310118220194d3eb707e00ad2`，与用例里的
`PINNED_SHA256`（`approval-fwb-number-mapping-gate.test.ts:17`）**逐字节相同**。CI 是 LF 检出，绿。

## 5. CI 接线（两点法）

- 真库件从无库默认配置里排除：`packages/core-backend/vitest.config.ts:1521`
  （否则 `describeIfDatabase` 会在 required job 里"跳过即绿"）。
- 真库件整文件接进自己的道：`.github/workflows/managed-sheet-schema-write-gate-realdb.yml`
  （`--config vitest.integration.config.ts`、整文件参数、`--reporter=verbose`、`DATABASE_URL` 为字面量、
  `EXPECT_DB=1`）。**没有动 `plugin-tests.yml`**：那是 s6a sha256 打包 pin 的输入，改一次就要重打 pin 并引发
  合并序列化竞争；这与既有 `approval-realdb-*` 独立道的先例一致。
- 无库那半不依赖任何道：它在 required 的 core-backend 单测 job 里每个 PR 都跑。

## 6. 没做 / 不确定

- 真库件本机零执行（无 PG/无 docker）：七格的状态码/行数断言全部是按路由源码推的
  （`POST /fields` 的 201 在 univer-meta.ts 的 create 分支、`POST /records` 用 `res.json(...)` ⇒ 200），
  真库道第一次跑是它们的第一次实测。
- 变异探针只作用于无库那半（本机唯一可执行的一半）。真库那七格的"去掉守卫必红"未在本机演示。
- `GET /context` 的能力口径未对齐（设计文档 §4）：托管表上的字段管理 UI 仍然可见，点击得 403。
- 第二解析器这一轮**没跑全量**（内存吃紧，按受影响面跑，见 §4.3）。没跑的包括：core-backend 无库全量
  （首提交跑过三轮，本轮未重跑）、需要 `DATABASE_URL` 的真库道整套（`approval-record-projection.test.ts`、
  `multitable-p2-fwb-eight-scenario-matrix.test.ts`、`multitable-permmatrix-b1-*-realdb`、
  `multitable-w11/w13-*-realdb`、`multitable-fwb-update-activation-realdb`、
  `approval-projection-participant-read.db.test.ts` 等——本机无 PG/无 docker）。已逐个 grep 确认
  这些真库件里只有 `approval-projection-participant-read.db.test.ts:99` 断言 `canManageFields`，
  且断言的是"投影表上非 admin 全为 false"，本门只收窄不放宽，不可能把它从 false 变 true。
- 第二解析器的变异探针只作用于一致性用例文件（本机可执行的那一半）；没有在全量尺度上复现它的红格。
