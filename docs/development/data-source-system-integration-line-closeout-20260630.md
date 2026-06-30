# 数据库及系统对接 — 交付线收口 (line close-out) — 2026-06-30

> 状态：**线收口 (CLOSED at scoped deliverable)。** 只读数据库源 + K3 `Material/GetDetail` 单条读 + **SQL 批量物料读** + C6 **sandbox** 外部写均已交付并验证。**C3 K3 WebAPI-LIST runtime = DEFERRED**（理由见下）。production/batch 写、K3 C4 BOM、C5 resolver 仍为各自独立 gate，不在本次收口范围。
>
> 引用（非重复推导）：#1709（read/list 线 + 诊断 ledger）、`data-source-system-integration-delivery-todo-20260614.md`（子线状态）、`data-factory-k3-read-list-development-verification-20260626.md`（#3263）。

## 收口判据 (completion definition)

所有**可构建且已授权**的开发内容已交付并验证。WebAPI-LIST C3 runtime 经充分 values-free 诊断后判定为 **deferred** —— 既有 SQL 批量读通道已覆盖该用例，且其完成需要客户侧 redacted live 样本输入。**未跨越任何 gate**；与本仓库 gated-opt-in / values-free / K3 红线纪律一致。

## 已交付 + 已验证（closeable scope）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 只读数据库接入 Data Factory 源（SQL bridge：MySQL/Postgres/SQL Server，引用 dataSourceId、不复制凭据） | done | P0 #2597 → C2-close #2600 → C3 incremental #2609/#2619/#2625/#2628/#2631 → C4 UI #2643/#2646/#2649/#2652/#2655 |
| K3 `Material/GetDetail` 单条读（dormant/fail-closed、operator write-gated、values-free） | done | #1868 + #3241 实体机 values-free PASS |
| **K3 / SQL Server 批量物料读（C5 generic MSSQL seam）** | done | #2670 PASS/CLOSED；#2700 runbook（generic + K3 SQL Server smoke 均 PASS、无 K3 Save/Submit/Audit/BOM、无外部 DB 写、无 raw SQL） |
| C6 **sandbox** 外部写（dry-run/apply/re-pull/rollback、per-row 失败隔离、dead-letter、values-free） | done (scoped) | #2769 scoped release evidence PASS（C6-0..5c controlled bad-row PASS） |
| K3 WebAPI read/list C0/C1/C2（next-slice 合同 + normalizer + 路由）+ 诊断 instrumentation | done | #3242/#3245/#3246 + #3341/#3355/#3364/#3369/#3374/#3386 |

## C3 K3 WebAPI-LIST runtime —— DEFERRED

**判定**：deferred（既非 PASS、亦非 fail，更不是未完成的可构建项）。

**理由：**
1. 既有 **SQL 批量读通道（C5）已覆盖物料列表读**；C0 gate 合同本身即规定 WebAPI-LIST 仅在"客户明确要求、且优于现有 SQL 批量读通道"时才开。当前**无具名需求**。
2. live 诊断链已 **values-free** 地确证：route/auth/`200` ✓、K3 `Data.ROWCOUNT=30134` ✓、分页 echo 与请求一致 ✓（`PageSize/PageIndex` 被 K3 接受，paging exonerated）—— 但 no-filter `Material/GetList` 响应**只返回 count + paging 元数据，`Data.DATA` 键缺失（absent）**，8 个固定容器路径无任一行数组。即：**在已批准的 fixed-probe 范围内只观察到 count/paging 元数据，未定位到行容器**（行是否需特定请求字段/flag 才返回，待客户 redacted live 样本确认）。
3. 解决它需要**客户提供 redacted live GetList 请求 + 响应样本**（尤其是"哪个请求字段/flag 使 `DATA` 行返回"），属客户侧输入。鉴于 SQL 通道已覆盖该用例，不值得为此再开往返。

**诊断链 de-risk 结论（values-free）**：**非** endpoint / auth / 分页问题；行确实存在（`ROWCOUNT=30134`）；唯一未决 = 行容器在已批准 fixed-probe 范围内未定位，需客户 redacted live 样本确认（确认行容器及"使 `DATA` 行返回"的请求形态）。诊断 instrumentation（error-code 拆分 #3341、envelope split + `dataDataPresent` #3355、shape probe #3364、filter dialect #3369、paging echo #3374、response shape probe #3386）已全程 values-free（counts/flags/types only，无 arbitrary key / 行值 / payload）。

**重开条件**：出现 WebAPI-LIST 路径的具名需求 **且** 客户提供 redacted live working GetList 请求/响应样本（结构键保留、值/行/消息脱敏）。届时为一个**窄的 preset-owned slice**（请求 flag + extractor 对齐确认容器 + fixture），不改边界。`#1709` 保持 open/on-hold（deferred），不在本次关闭。

## 仍为独立 gate（不在本次收口范围、不计为本线开发量）

| 面 | 状态 | 解锁条件 |
| --- | --- | --- |
| production / batch 外部写 | frozen | 独立 owner 授权（最大风险刀；sandbox 已验证、production 始终单独 gate）|
| K3 C4 BOM 读 | frozen | 独立 customer GATE + BOM 专属请求/响应契约 |
| C5 resolver / server-side composition | frozen | 显式 owner 解锁 + 具名 demand |
| Windows 默认 temp path 部署 caveat | tracked | #2642（不阻塞 runtime gate）|

## 边界

全程 values-free；无 BOM/resolver/Save/Submit/Audit/production write；无 request-supplied raw Filter；无 arbitrary response key / raw payload / 行值 / 凭据 / host / system id surface。本次关闭未部署、未跨任何 gate。

## 一句话

数据库及系统对接能力在 **scoped 层面收口并验证**：只读 DB 源 + K3 单条读 + SQL 批量读 + sandbox 外部写。WebAPI-LIST C3 仅作为对既有 SQL 批量读的**可选增强**而 deferred（已 de-risk、重开条件明确）；production 写 / BOM / resolver 为独立未来 gate。
