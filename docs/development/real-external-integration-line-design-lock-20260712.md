# 真实外部系统现场对接线 — 设计锁（RATIFIED E0）— 2026-07-12

> **状态：RATIFIED E0（2026-07-19）。** 本文是**下一条产品线**的第一刀 ——
> 按 owner 定调:「第一刀不是写代码,而是 runbook / design-lock」。**本文不请求任何编码,
> 不请求任何外部写授权。** E0 边界与以下保守裁决现已生效：OD-E3=否、OD-E4=仅 smoke、
> OD-E5=`externalWrite=false`、OD-E6=逐客户 gate、OD2=未实现策略 fail-closed、OD6=全 blocking。
> OD-E1/E2 与 OD1/3/4/5 仍须逐客户样本或流程访谈，未满足前不启动对应 runtime。
>
> **2026-07-17 刷新(内容不改判,只补状态与表决单)**:①W3-W6 on-prem 验收弧已以 corrective-6 包
> 终验 PASS 收口(#4101 CLOSED);RC-A(#4437,T3b approved-source 单窗验收)在途、等实体机执行,
> 与本线互不阻塞。②T3a/T3b 服务端 auto-persist 已落 main 且各自独立 default-OFF flag
> (`http-routes.cjs:579-583/:602-608`,反 steering 拒绝已测)——本线 E2 的「readonly intake →
> 内部表」底座较 07-12 更完整。③新增 §7/§8 **owner 表决单**(证据 · 选项 · 推荐 · 批准影响),
> 沿用既有 OD-E1..E6 与备料 OD1..OD6 编号,不另设编号体系。代码证据锚 origin/main `9048c27e2`。
>
> **2026-07-19 owner final：** ratify E0 与上述六项；OD2 的最小安全实现已由 #4463
> 合入 `fbce9d617`（服务端 422 + FE 摘除）。本次 ratify 不授权 E3/E4/E5，不把跨客户样本
> 推断为现场证据，也不改变 RC-A #4437 的实体机门。

## 0. 为什么这是新线,不是备料 MVP 的漏项

备料 MVP 的 W3-W6 on-prem 包已实体机 runtime 验收 **PASS**(首次 PASS=corrective-7 包,
2026-07-12;验收弧最终以 **corrective-6 包 rerun 全判据 PASS 收口,#4101 CLOSED=2026-07-17**):
`mvpSmoke.pass=true` · `auditActionsCovered=8/8` · **`externalPlmK3ErpWrite=false`**。

最后一个字段是关键:**当前验收明确没有触碰任何真实外部写**。备料 MVP 用的是
**readonly intake + 内部 9 逻辑表**,外部系统数据是**样本/夹具**喂进来的,不是现场系统。

**真实外部系统现场对接是独立的下一条线**,它需要备料 MVP 不需要的东西:现场系统、凭据、
真实样本、以及**逐项的 owner/客户授权**。把它混进备料线的 runtime 验收,会错误地把
"我们本地用样本证过链路"当成"我们对通了客户的 PLM/K3/ERP"。**两者是两回事。**

## 1. 范围边界(硬约束,继承自备料线并加强)

**永不在本线擅自跨越 —— 每一项都需 owner 单独、显式授权:**

- **C4 外部写 / K3 Save / Submit / Audit / BOM / 自动建改 ERP 物料** —— 最高风险 gate。
  **客户禁 + owner 单独授权 + sandbox-first**。默认 `externalWrite=false`。本线**默认只读**。
- **OD-W3-1 值面操作员读**(图号 / 数量 / 单位 等业务值面)—— 当前备料面是 values-free。
  若现场需要把值面给操作员看,**必须单独开 gated + audited read**,不随手放开(见 OD-E3)。
- **中央 RBAC** —— 红线,不碰。
- **raw SQL 写入面** —— 不开。

**继承的可用底座(已建成、已实体机 PASS,本线复用)**:
- readonly feeder(#4093)+ 完整性可证/不可证即 fail-closed 语义(见
  `stock-preparation-readonly-source-feeder-dev-verification-20260712.md`);
- read-source-configs / compositions 的 approve-gated 只读配置面;
- 内部 9 逻辑表 + `createTargetScopedRecordsApi`(逻辑键→物理 fieldId 翻译收口,#4163);
- values-free 证据面 + 审计轨(066,append-only,DB 触发器兜底 T5);
- **(2026-07-17 增)** T3a/T3b 服务端 auto-persist(approved source → 内部表),各自独立
  default-OFF flag + 反 steering 拒绝 —— E2 的 intake 落表面已有带闸生产入口,非仅样本管线。

## 2. 决策集合（OD-E；部分已 ratified，其余逐客户拍板）

| # | 决策 | 选项 | 依赖 |
|---|---|---|---|
| **OD-E1** | 现场 **PLM readonly source** 的真实 schema / source kind | 每个客户源的 canonical 图号 · 版本字段(承接备料 OD1/OD2)· source kind(SQL readonly / bridge / adapter)· 是否可翻页 | 现场 PLM 样本 |
| **OD-E2** | 现场 **K3 / ERP readonly material master** 的真实字段 | 物料编码 / 内部 id / 领料单位口径(承接备料 OD3)· 分页机制 · 可证行数上界 | 现场 K3/ERP 样本 |
| **OD-E3** | **是否允许值面操作员读** | 否(保持 values-free,默认)· 是→**单独 gated + audited read**,定义谁能读 / 读什么 / 审计口径(承接 OD-W3-1) | owner 决策 |
| **OD-E4** | **验收深度** | 仅 smoke(只读 end-to-end,externalWrite=false)· 允许 **sandbox apply**(W3/W4 sandbox-first,非生产)· 生产 apply(C4,单独授权) | owner + 客户 |
| **OD-E5** | **externalWrite 姿态** | `externalWrite=false`(默认,只读现场对接)· 进入 **W3/W4 sandbox-first**(隔离沙箱写,可回滚,非客户生产库) | owner |
| **OD-E6** | **feasibility gate 逐客户** | 每个客户 schema / source kind 需**各自** live feasibility gate(承接 execution-plan C1「live PLM feasibility 仅对已关闭样本证过」)—— 不同客户不共享 feasibility 结论 | 现场系统 |

## 3. 建议的分阶段交付(**全部 gated,拍板 OD-E 后逐刀启动**)

> 每一刀都**继承备料线的验收纪律**:真库/真源 end-to-end 证据 · values-free · 对抗审阅门 ·
> mutation · 「完整性必须可证,不可证即 fail-closed」· fake 必须像真依赖严格。

- **E0(runbook,本文即是):** 列 OD-E1..E6,定范围边界,不写代码。
- **E1(现场只读 feasibility,gated on OD-E1/E2/E6):** 对**真实客户 PLM / K3 / ERP 只读源**跑
  feeder feasibility —— 连得上、读得出、完整性可证或诚实 fail-closed。**零写。** 产出 values-free
  feasibility 证据。
- **E2(现场只读 intake → 内部表,gated on E1):** 把现场只读数据经 readonly intake 落**内部 9 表**
  (复用 #4093 硬化路径 + #4163 fieldId 翻译)。**仍零外部写。** 现场数据首次进内部底座。
- **E3(值面 gated read,gated on OD-E3=是):** 若 owner 批,单独开 audited 值面读(图号/数量/单位),
  定义 RBAC 作用域 + 审计口径。**默认不做。**
- **E4(sandbox apply,gated on OD-E4/E5=sandbox):** 若 owner 批 sandbox-first,在**隔离沙箱**
  (非客户生产库)做可回滚的 apply 演练。**非生产。**
- **E5(生产 apply / C4,单独授权):** 最高风险 gate。**客户禁 + owner 单独授权 + 前序全 PASS**
  才可讨论。本线默认**不进入**。

## 4. 与现有 gated pool 的关系

本线是备料收尾时迁出的 gated pool 的**产品化落点**:

- 承接 **OD1-6 + OD-W3-1/2**(备料的客户口径开放决策)→ 本线 OD-E1..E3。
- 承接 **C4 外部写(#2253)**、K3 Save/Submit/Audit、自动建改 ERP 物料 → 本线 E4/E5(默认不进入)。
- 承接 **真实 PLM/K3/ERP 现场对接** → 本线 E1/E2。
- **large-BOM 生产 rollout(#2401)** 与 **duplicate-key D4 剩余策略** 是**相邻但不同**的 epic,
  各自 gated,不并入本线。

## 5. 明确的非目标(收本文范围)

- 本文**不**请求编码、**不**请求外部写授权、**不**声称任何客户对接已发生。
- 本文**不**改变备料 MVP 的 `externalPlmK3ErpWrite=false` 事实。
- E1 仅在逐客户 OD-E1/E2/E6 与真实只读样本齐备后启动；E2 依赖 E1 PASS；E3/E4/E5
  维持未授权。ratified E0 本身不解锁这些 runtime。

## 6. 下一步(owner 动作)

1. ~~ratify 本 design-lock~~ **已完成：E0 于 2026-07-19 ratified。**
2. 为具体客户提供现场只读样本，并逐客户裁 OD-E1/E2 与 OD1/3/4/5；样本不跨客户复用结论。
3. E1 feasibility 只在上一步完成后启动，保持零写；E2 依赖 E1 PASS。
4. OD-E3/E4/E5 的保守裁决保持，除非另开独立 owner + 客户授权门。

在逐客户前置完成前：**hold，不启动对应 runtime 切片。**

## 7. Owner 表决单 — OD-E1..OD-E6(证据 · 选项 · 推荐 · 批准影响)

> 本节现为决策台账；仍开放的逐客户行可继续逐行回帖，每行独立生效。证据锚 `9048c27e2`。
> 推荐是我的倾向,不是预设;任何一行 owner 可改判。
>
> **owner final（2026-07-19）：** OD-E3=否 · OD-E4=仅 smoke · OD-E5=`externalWrite=false` ·
> OD-E6=批；其余 OD-E 行等逐客户样本。备料侧 OD2=服务端 fail-closed + FE 摘除（已合入），
> OD6=ratify 全 blocking；OD1/3/4/5 保持逐客户开放。

| # | 证据(现状,可核) | 选项 | 推荐 | 批准影响 |
|---|---|---|---|---|
| **OD-E1** | 3 个 PLM-capable readonly kind 已 shipped,各带诚实完整性上界(能力表 `readonly-source-run.cjs:54-75`;`bridge:legacy-sql-readonly` clamp 默认 20,大源必 409 `SOURCE_RUN_COMPLETENESS_UNPROVABLE`);workbench 顾问自助面可作现场配置采样(#4437 审阅已核) | 逐客户收样后裁字段口径+kind / 先钉全局默认 | **逐客户收样后裁**(用 E1 现场采样回填,不设全局默认);选 kind 时按能力表核对源规模 | 与 OD-E2/E6 同批 → **启动 E1**(零写 feasibility,主要为 runbook/配置工作,复用探测+feeder) |
| **OD-E2** | 4 个 ERP kind 已 shipped;`k3-wise-webapi` 10 行/页×10 页硬上界(`readonly-source-run.cjs:22-24,:71-74`);`k3-wise-sqlserver` 单页不可续(`:36-39`);完整性不可证即 fail-closed(`:442,:529`) | 同上逐客户 | 同 OD-E1 同批;小上界 kind 只适合小表/样本场景,选型时明示 | 同上 |
| **OD-E3** | values-free 硬边界已构造性落地:项目读面只出 handle+闭枚举+计数(`project-reads.cjs:14-24,:43-46`);值面读显式 OD-W3-1-gated 未建 | 否(默认) / 是→单独 gated+audited read | **RATIFIED：否**。首个现场 UAT 若提出具名读值需求，须重开 RBAC 范围+审计词表设计门 | E3 保持 barred |
| **OD-E4** | 备料线外部写结构性缺席:evidence 恒 false(验收 runner 硬编码 `onprem-acceptance.ps1:90`)+ 路由测试断言零外呼(`http-routes.test.cjs:7143,7192-7195` spy 装置,断言在 `:7246`);内部 apply sandbox-fail-closed(`table-actions.cjs:781-802`),生产 apply config-only(`:824-833`);**唯一带 dry-run→gated-apply 门的外写机制** = C6 `sql-write-gated`(`external-write-dry-run.cjs:18`),未接 K3/PLM——既有 K3 写路径(pipeline upsert/Save/Submit/Audit,`pipeline-runner.cjs:643` + k3 adapter)属 pipeline 线、config-gated、无 sandbox 概念,即 §4 的 C4 gated pool 项 | 仅 smoke / sandbox apply / 生产 apply | **RATIFIED：首轮仅 smoke**（E1/E2 深度） | E4/E5 不解锁；sandbox/生产 apply 均须另立 owner+客户设计门 |
| **OD-E5** | 现姿态强于只读:内部 auto-persist 都各自 default-OFF + 反 steering 拒绝(`http-routes.cjs:579-631`);OFF 时 source-run 逐字节只读 | `externalWrite=false`(默认) / sandbox-first | **RATIFIED：`externalWrite=false`** | sandbox-first 不解锁 |
| **OD-E6** | 逐客户 gate 可零代码复用:S2-b 探测平台钉死 5000ms/10 行(`read-source-probe-contract.cjs:19-20`)+ approve-gated 配置 + 「完整性可证或诚实 fail-closed」run 语义 | 批 gate 协议 / 另行设计 | **RATIFIED：批 gate 协议**。E1 逐客户入门判据 = 连得上 + 读得出 + 完整性可证或诚实 fail-closed | 定义 E1 入门门槛；本身不启动 runtime |

## 8. Owner 表决单 — 备料产品决策 OD1..OD6(承接 §4,同表决方式)

| # | 证据(现状,可核) | 选项 | 推荐 | 批准影响 |
|---|---|---|---|---|
| **OD1** 图号/版本字段 | DN_PDM read plan 钉死为默认且逐请求可覆写(`bom-expansion.cjs:157-207`:IdentityNo/SysVer);mapper 接地校验拒绝未接地映射 | ratify DN_PDM 为默认 / 逐客户收样后裁 | **逐客户**(E1 采样回填);DN_PDM 只是一家 schema,不宜升格为裁决 | 与 OD3/OD4 同批 → 解锁 `sp-export-import-templates` |
| **OD2** 版本是否 ERP-区分 | 原缺口：`category_rule` 曾被 FE/route 接受但 matcher 未实现，可能尾部兜底为按图号匹配。#4463 已以 `fbce9d617` 合入服务端执行点前置 422 与 FE 摘除 | ①摘除 ②服务端 fail-closed ③完整实现 | **RATIFIED 且已完成：①+②**；③等具名客户需求另立设计门 | 当前无静默 category_rule 路径；模板 versionPolicy 词表已收敛 |
| **OD3** 领料单位口径 | FIssueUnit 别名链钉死(`unit-rule-match.cjs:90-91`);无值→HELD `missing_issue_unit`(`:282-285`);规则确认 tri-XOR、未确认永不自动生效 | ratify FIssueUnit 链 / 逐客户裁 | **逐客户**核实 K3 领料实践(基础/库存/领料单位分歧场景)后裁 | 同 OD1 |
| **OD4** 取整/最小领料量 | **机制已建但惰性**:none/ceil/floor/nearest/pack_size + minimum floor 全在(`mvp-generation.cjs:240-263`),默认 none,仅用户确认 unit rule 时手输,无品类默认表 | 保持逐规则手输 / 建品类默认表 | 保持手输至客户品类规则到位;品类默认表=模板工作,与 OD1/OD3 同批 | 同 OD1 |
| **OD5** 确认粒度 | 任何粒度的 prep-line confirm 均未建;行无 human_preserved、重跑刷新(`generation-runtime.cjs:20`);现有确认全在底座级(mapping/unit,内容 hash 键) | project / BOM snapshot / 生产工单 | **客户流程访谈后裁**(无代码可证);裁前 C4 apply 本就 barred,无额外风险 | 决定未来 prep-line confirm 写面与 C4 apply 面的形状(E4/E5 前置) |
| **OD6** 异常 blocking vs warning | 全 blocking 已完整实现+测试:severity 硬编码(`mvp-generation.cjs:274`),行有异常即不生成(`:410-425`),决议闭词表无 ignore/defer(`generation-runtime.cjs:22-23`);读模型已 warning-ready | ratify 全 blocking / 指定 warning 子集 | **RATIFIED：全 blocking** | OD6 已关闭；warning 子集须后续独立设计门 |
