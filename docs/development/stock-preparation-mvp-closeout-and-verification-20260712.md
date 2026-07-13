# 备料 (stock-preparation) MVP — 收账 + 验证 MD (2026-07-12)

> **Status: 可交付范围 CLOSED.** 备料 MVP 的 on-prem runtime 验收弧闭合;剩余项全部迁入独立 gated pool。
> 本文是该线的收账 + 验证汇总,**不**声称真实 PLM/K3/ERP 现场对接、C4 外部写、OD-W3-1 值面读完成。

## 1. 审阅结论(数据库代码 / 备料代码 / 目标文档)

审阅 `execution-plan-todo`(C0–C6 逐项)、corrective-arc(1→7)、目标文档与落地代码后:**本线可交付范围内无剩余未开发项**。
所有「看似未开发」的东西,经核对都属于**设计上就 gated 的项**(外部写、值面读、真实外部系统),不是本线漏项。

**贯穿全线的硬约束(设计即定,已守住)**:①无外部数据库写(`externalPlmK3ErpWrite=false` 实体机实证);②证据/摘要 values-free(仅字段名/计数/状态,不含图号/数量/单位等值面);③只读 + dry-run 优先。

## 2. 已交付(全 on main)

| 阶段 | 内容 | 落点 |
|---|---|---|
| C0 | 设计 + TODO + C1–C6 分解 | #2258 `313a31d31` |
| C1 | 备料表模板 / 字段模型 manifest | #2260 `3ffe6f32c` |
| C1b-0/1/2 | canonical target provisioning 设计 + helper + admin readiness workflow | #2305 / #2307 / #2309 |
| C2-0 / C2 | filtered readonly SQL bridge + `projectNo→PLM BOM` dry-run 展开 | #2265 / #2268 |
| C3–C6 | job skeleton / planner handoff / 展开 / 视图 / 审计(GATE PASSED 2026-06-05) | C3-C6 series |
| duplicate-expanded-key D0–D4 | 重复展开键 group 决策(merge-qty / select-representative / skip / source-correction) | D-series |
| **on-prem 包 corrective 1→7** | 见 §3 | #4050/#4061/#4068/#4073/#4084(+#4086)/#4126/**#4163** |
| **实体机 runtime PASS** | corrective-7 真实 Windows 硬件 smoke | **#4101 CLOSED** · 记录 #4173 `1d00b6a88` |

**MVP 实体:8 模板 + runtime + 6 视图 + 审计**,全落;8/8 audit actions 覆盖,selfScan clean。

## 3. corrective 弧最终账(1→7)

| 轮 | 症结 | 落点 |
|---|---|---|
| 1-2 | frozen-lockfile 安全 · corepack pnpm 定版 | #4050 · #4061 |
| 3-4 | 移除未用 native bcrypt · 深路径清理 | #4068 · #4073 |
| 5 | 42P07 迁移 supersession(no-op 保名盖戳) | #4084 (+ 包保障 #4086) |
| 6 | uuid 运行时依赖 + production-install 启动契约 guard + express-validator fail-open 安全修 | #4126 |
| **7** | **备料写入面从未在真实 multitable 上运行(逻辑键 vs 物理 fieldId)** | **#4163** |

## 4. 实体机验收 PASS 判据(corrective-7,2026-07-12,真实 Windows 硬件,#4101)

```
pm2RestartCommand=PASS · pm2StableOnline=PASS(corrective-6 的 502 崩溃循环消除)
postRestartHealthcheck=PASS · mvpSmoke.pass=true · auditActionsCovered=8/8
mvpSmoke.selfScanClean=true · failedCheckCount=0 · repeatability=1/1
externalPlmK3ErpWrite=false(C4 硬闸守住:零未授权外部写) · postSmokeStabilityCheck=PASS
```

**范围界定(owner 口径)**:只闭合 corrective-7 的实体机 *runtime 验收*弧(on-prem 包在真实硬件装得上/起得来/写读审计全链跑通/C4 硬闸守住)。**不**声称整个功能 epic 完成,**不**覆盖真实外部系统现场对接。

## 5. 明确未交付 / 迁入独立 gated pool(勿冒称交付)

| 项 | 定性 | 门 |
|---|---|---|
| **真实 PLM/K3/ERP 现场对接** | 下一条产品线(非本线漏项) | 需现场系统 + 凭据 + 样本 + 授权;design-lock 见 `real-external-plm-k3-erp-onsite-integration-designlock-20260712.md` |
| **C4 外部写 / K3 Save/Submit/Audit** | 最高风险 gate | 客户禁 + owner 单独授权 + sandbox-first(#2253) |
| **OD-W3-1 值面读** | values-free → 值面 | 单独 gated audited read(图号/数量/单位等操作员可见需专门开,不顺手放开) |
| **#4141** | corrective-6 guard governance lane | 质量债,不阻塞 runtime PASS;可选队列 |
| **#4169** | CI flake(retry:2 vs 根因) | 稳定性,非功能闭合项;可选队列,owner 待决 |

## 6. 方法论沉淀(七轮)
- corrective-6/7 都是**本地全量预演**抓出来的,没烧实体机额外轮次 —— 能本地重放的验收步骤别用别人物理机去发现。
- **一个比真依赖更宽容的 fake,保护的不是代码,是缺陷** —— 修 fake 让未修代码当场变红,比修代码更防回归。

## 7. 收账口径
**系统对接 + 备料 MVP 当前可交付范围完成;剩余均迁入独立 gated pool。** #4101 CLOSED;协调状态 #4022 已记。
