# 真实外部系统现场对接线 — 设计锁(design-lock)— 2026-07-12

> **状态:PROPOSED / owner-ratification-required。** 本文是**下一条产品线**的第一刀 ——
> 按 owner 定调:「第一刀不是写代码,而是 runbook / design-lock」。**本文不请求任何编码,
> 不请求任何外部写授权。** 它把现场对接的开放决策(OD-E1..OD-E6)显式列出,交 owner + 客户拍板;
> 在拍板前,**任何 runtime 切片都不启动**。

## 0. 为什么这是新线,不是备料 MVP 的漏项

备料 MVP 的 W3-W6 on-prem 包已实体机 runtime 验收 **PASS**(#4101 CLOSED,2026-07-12):
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
- values-free 证据面 + 审计轨(066,append-only,DB 触发器兜底 T5)。

## 2. 开放决策(OD-E,需 owner + 客户拍板 —— 拍板前不启动 runtime)

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
- E1-E5 **在 OD-E 未经 owner/客户拍板前一律不启动**。

## 6. 下一步(owner 动作)

1. ratify 本 design-lock(或改)。
2. 就 OD-E1..E6 给出客户口径 / 授权范围(尤其 OD-E3 值面读、OD-E4/E5 apply 姿态)。
3. 提供现场只读样本(PLM / K3-ERP)以启动 E1 feasibility。

在此之前:**hold,不启动任何 runtime 切片。**
