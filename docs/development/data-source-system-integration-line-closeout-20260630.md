# 数据库及系统对接 — 交付线收口 (line close-out) — 2026-06-30

> 状态：**线收口 (CLOSED at scoped deliverable)。** 只读数据库源 + K3 `Material/GetDetail` 单条读 + **SQL 批量物料读** + **C3 K3 WebAPI-LIST no-key 列表页读** + C6 **sandbox** 外部写均已交付并验证。production/batch 写、K3 C4 BOM、C5 resolver 仍为各自独立 gate，不在本次收口范围。
>
> 更新 2026-06-30：C3 K3 WebAPI-LIST 由 **deferred** 翻为 **done (no-key 页)** —— 客户/operator 侧 redacted live 样本确认行容器为 `Data.Data`(PascalCase)，窄 preset-owned slice **#3390**（`e1766a629`）修复 response-side extractor，实体机 no-key rerun **PASS**。keyed `FNumber` Filter 仍为独立可选 refinement。
>
> 引用（非重复推导）：#1709（read/list 线 + 诊断 ledger）、`data-source-system-integration-delivery-todo-20260614.md`（子线状态）、`data-factory-k3-read-list-development-verification-20260626.md`（#3263）。

## 收口判据 (completion definition)

所有**可构建且已授权**的开发内容已交付并验证。WebAPI-LIST C3 no-key 列表页读经充分 values-free 诊断 + 客户侧 redacted live 样本确认行容器后，由窄 preset-owned slice (#3390) 修复 extractor 并经实体机 no-key rerun 验证 **PASS**。**未跨越任何写 gate**（read-smoke 为 operator write-gated 只读）；与本仓库 gated-opt-in / values-free / K3 红线纪律一致。

## 已交付 + 已验证（closeable scope）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 只读数据库接入 Data Factory 源（SQL bridge：MySQL/Postgres/SQL Server，引用 dataSourceId、不复制凭据） | done | P0 #2597 → C2-close #2600 → C3 incremental #2609/#2619/#2625/#2628/#2631 → C4 UI #2643/#2646/#2649/#2652/#2655 |
| K3 `Material/GetDetail` 单条读（dormant/fail-closed、operator write-gated、values-free） | done | #1868 + #3241 实体机 values-free PASS |
| **K3 / SQL Server 批量物料读（C5 generic MSSQL seam）** | done | #2670 PASS/CLOSED；#2700 runbook（generic + K3 SQL Server smoke 均 PASS、无 K3 Save/Submit/Audit/BOM、无外部 DB 写、无 raw SQL） |
| **K3 WebAPI-LIST C3 no-key 列表页读**（preset-owned `k3wise.material-list.v1`、response-side `Data.Data` PascalCase extractor、operator write-gated、values-free） | done (no-key page) | #3390（`e1766a629`）+ 实体机 no-key rerun PASS（`recordCount=10`、`dataRowCount=30134`、`dataDataPresent=true`、`listShapeProbe.dataPascalData=true`、`fixedContainers.dataPascalData.type=array`）|
| C6 **sandbox** 外部写（dry-run/apply/re-pull/rollback、per-row 失败隔离、dead-letter、values-free） | done (scoped) | #2769 scoped release evidence PASS（C6-0..5c controlled bad-row PASS） |
| K3 WebAPI read/list C0/C1/C2（next-slice 合同 + normalizer + 路由）+ 诊断 instrumentation | done | #3242/#3245/#3246 + #3341/#3355/#3364/#3369/#3374/#3386 |

## C3 K3 WebAPI-LIST no-key page read —— DONE (no-key page)

**判定**：done（no-key 列表页读经实体机 rerun PASS）。曾判 deferred，后因客户/operator 侧提供 redacted live `GetList` 响应结构样本而重开并解决 —— 即本文档先前"重开条件"所述路径，未越任何边界。

**根因 + 修复：**
1. live 诊断链已 **values-free** 地确证：route/auth/`200` ✓、K3 `Data.ROWCOUNT=30134` ✓、分页 echo 与请求一致 ✓（`PageSize/PageIndex` 被 K3 接受，paging exonerated）。唯一未决 = 行容器在当时已批准的 fixed-probe 范围内未定位。
2. 客户/operator 侧 **redacted live 样本**（结构键保留、值/行/消息脱敏）确认：`actualRowContainer=Data.Data`（**PascalCase**）、长度 10；先前 fixed-probe miss 原因 = **case/path 不匹配（probe 查的是 `Data.DATA`，而非 `Data.Data`）**。count/page 助手早已处理 PascalCase `RowCount/PageSize/PageIndex`，故 count 能取、行不能取。
3. 修复 = 窄 preset-owned slice **#3390**（squash `e1766a629`）：response-side `materialListRowsCandidate` 加 `Data.Data`（compat order 保留 `Data.DATA`/`Data.data` 在前），`dataPascalData` 加入 `materialListShapeProbe` + 容器路径 allowlist + **两个** read-smoke sanitizer allowlist（`listShapeProbe` 与 `responseShapeProbe.fixedContainers`），并将 `Data.Data` 并入 `dataDataPresent`；values-free、`Data.DATA`/`Data.data` 兼容保留、plugin CJS 55/55。wire-vs-fixture drift 由 http-routes wire 测试锁死（断言 route 保留 `responseShapeProbe.fixedContainers.dataPascalData` 且 scrub 诱饵值）。

**实体机 no-key rerun（values-free）PASS**：`buildSha=e1766a629`、`mode=list`、`keyedSmokeRun=false`、`httpStatus=200`、`apiOk=true`、`recordPresent=true`、`recordCount=10`、`dataRowCount=30134`、`dataPageSize=10`、`dataPageIndex=1`、`dataDataPresent=true`、`listShapeProbe.dataPascalData=true`（其余 listShapeProbe 全 false）、`responseShapeProbe.fixedContainers.dataPascalData.type=array length=10`（其余 container 全 missing）。边界守住：no raw Filter / no arbitrary key / no BOM / resolver / Save / Submit / Audit / production write。

**诊断链 de-risk 结论（values-free）**：诊断 instrumentation（error-code 拆分 #3341、envelope split + `dataDataPresent` #3355、shape probe #3364、filter dialect #3369、paging echo #3374、response shape probe #3386）全程 values-free（counts/flags/types only，无 arbitrary key / 行值 / payload），逐级 de-risk 至唯一未决（行容器），最终由客户 redacted live 样本 + #3390 解决。

**残留可选项（不阻塞）**：keyed `FNumber` Filter（`contains_like` / `k3_freeform`）为独立**可选 refinement**，no-key 页 PASS 不依赖它。`#1709` 的 no-key 列表页交付即此达成；其后续（keyed filter / BOM）按需独立推进。

## 仍为独立 gate（不在本次收口范围、不计为本线开发量）

| 面 | 状态 | 解锁条件 |
| --- | --- | --- |
| production / batch 外部写 | frozen | 独立 owner 授权（最大风险刀；sandbox 已验证、production 始终单独 gate）|
| K3 C4 BOM 读 | frozen | 独立 customer GATE + BOM 专属请求/响应契约 |
| C5 resolver / server-side composition | frozen | 显式 owner 解锁 + 具名 demand |
| Windows 默认 temp path 部署 caveat | tracked | #2642（不阻塞 runtime gate）|

## 边界

全程 values-free；无 BOM/resolver/Save/Submit/Audit/production write；无 request-supplied raw Filter；无 arbitrary response key / raw payload / 行值 / 凭据 / host / system id surface。C3 no-key 列表页读经 operator write-gated read-smoke 于实体机（on-prem prerelease）验证，仅只读、未跨任何**写** gate；其余子线本次关闭未部署、未跨任何 gate。

## 一句话

数据库及系统对接能力在 **scoped 层面收口并验证**：只读 DB 源 + K3 单条读 + SQL 批量读 + **WebAPI-LIST C3 no-key 列表页读** + sandbox 外部写。WebAPI-LIST C3 由客户 redacted live 样本确认行容器（`Data.Data` PascalCase）→ #3390 修复 → 实体机 no-key rerun PASS；keyed `FNumber` Filter 为可选 refinement；production 写 / BOM / resolver 为独立未来 gate。
