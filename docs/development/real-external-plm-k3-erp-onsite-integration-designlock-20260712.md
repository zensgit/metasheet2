# 真实外部系统 (PLM / K3 / ERP) 现场对接 — 线 design-lock (2026-07-12)

> **Status: PROPOSED (doc-only; 无 runtime code).** 这是备料 MVP 收账后**新开的下一条产品线**的第一刀 ——
> 按 owner 口径:**第一刀不是写代码,而是 runbook / design-lock**,先钉死现场前置、样本、授权与 gate,再谈实现。
> 本线与已闭合的备料 MVP on-prem runtime 验收弧**分开**;不复用「MVP 已 PASS」去声称任何外部对接已完成。

## 1. 为什么这是新线,不是备料漏项

备料 MVP 的实体机 smoke 明确 `externalPlmK3ErpWrite=false` —— 本轮**从未触碰真实外部写**,这是设计守住的硬闸,不是缺口。
把「真实 PLM/K3/ERP 现场对接」当成备料线的漏项是**范围错配**:它需要现场系统、凭据、样本、授权,是独立立项。

## 2. 硬边界(继承备料线,不放松)
- **无未授权外部写**:C4 外部写 / K3 Save/Submit/Audit 仍是最高风险 gate —— 客户禁 + owner 逐刀单独授权 + **sandbox-first**。
- **values-free 默认**:证据/摘要仍只含字段名/计数/状态;值面读(OD-W3-1:图号/数量/单位给操作员看)是**单独 gated audited read**。
- **readonly-first**:任何真实外部对接从**只读 source 拉样本**起步,不是先写。

## 3. 阶段(readonly → smoke → sandbox → 授权写),每阶段独立 opt-in

| 阶段 | 内容 | 前置 / gate |
|---|---|---|
| **R0 现场前置采集** | 拿到现场 PLM readonly source 样本 + K3/ERP readonly material master 样本(脱敏);记录连接方式/凭据托管/字段映射 | 现场系统可达 + 凭据 + 授权采样 |
| **R1 只读对接 smoke** | 用样本跑 readonly lookup / dry-run 展开,values-free 证据;不写外部 | R0 完成 + opt-in |
| **R2 值面读(可选,gated)** | 若 owner 决定放开操作员看值面(图号/数量/单位):单独 audited read + 权限门 + 审计 | OD-W3-1 决策 = 允许 + 单独授权 |
| **W3 sandbox apply(可选,gated)** | 在**沙箱**外部系统上试写(K3 Save/Submit),不碰生产 | owner 授权 + sandbox 环境就绪 + C4 设计 |
| **W4 生产外部写(最高 gate)** | 真实生产外部写 | 客户明确解禁 + owner 逐刀授权 + W3 sandbox PASS + audit 全链 |

**默认停在 R1**:`externalWrite=false`。是否进入 R2/W3/W4 由下方决策菜单逐项授权。

## 4. Owner 决策菜单(第一刀落地前必须回答)

- **Q1 — 现场 PLM readonly source 样本**:能否取得?什么形态(DB 只读账号 / 导出文件 / API)?脱敏要求?
- **Q2 — K3/ERP readonly material master 样本**:能否取得?物料主数据字段范围?
- **Q3 — 是否允许值面操作员读**(OD-W3-1):
  - (a) 不放开 —— 保持 values-free(**推荐默认**,最省事、最安全);
  - (b) 放开 —— 需单独 gated audited read + 权限门 + 审计设计(R2)。
- **Q4 — 仅 smoke 还是允许 sandbox apply**:
  - (a) 仅 R1 只读 smoke(**推荐第一步**);
  - (b) 进入 W3 sandbox-first 试写(需沙箱 + C4 设计 + 授权)。
- **Q5 — externalWrite 口径**:明确 **`externalWrite=false`**(停 R1)还是**进入 W3/W4 sandbox-first**(需上面 Q4=b + 逐刀授权)。

## 5. OUT(本 design-lock 不含)
- 任何 runtime 代码(本刀是 doc-only)。
- 生产外部写(W4)—— 永远须客户解禁 + owner 逐刀授权 + sandbox PASS。
- 复用备料 MVP 的 PASS 去声称外部对接完成。

## 6. 下一步
owner 回 Q1–Q5 → 据此把 R0/R1 拆成有界 opt-in 切片(仍 readonly / values-free 为默认)→ 每片 design-lock → 实现 → 验证 MD。
**在 owner 明示前,本线停在 design-lock,不写 runtime、不碰外部系统。**
