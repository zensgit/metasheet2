# 审批 & 流程自动化 — 钉钉/飞书对标刷新审计 (2026-07-03)

> **内部研究文档**（`docs/research`）。对标钉钉/飞书用于**定位差距、重排开发阶梯**，不进正式 design 文档
> （正式文档只写 MetaSheet 自己的原则）。基线 = `origin/main @ 43e7e704c`（审批/自动化 runtime 全部 shipped 之后）。
> 对标 = 引擎能力，非 UI 精细度；结论是**下一弧的候选清单 + benefit×risk 排序**，不是承诺。

## 0. 一句话结论

**审批流程引擎已经 ~90% 追平钉钉/飞书**——本季度的密集开发把"流程引擎"这块缺口基本补完了。**剩下的真实差距不在引擎，
在产品面**：表单设计丰富度、移动端、分析看板 UI、委托管理、连接器广度、签名合规强制。**差异化杠杆不是去卷它们的护城河
（连接器生态 / 原生移动端），而是 multitable-native：把 T3-6 已 ship 的"审批数据即多维表记录"兑现成它们做不干净的报表/看板层。**

## 1. 我们现状（grounded @ main）

| 维度 | 已 ship |
|---|---|
| 流程节点 | 串行/并行；`all`(会签)/`any`(或签)/`threshold`(N-of-M, T2-4, re-entry-safe via nodeEntryEpoch)/`single` |
| 节点操作 | approve / reject / return(回退) / transfer(转交) / add_sign(加签) / reduce_sign(减签) / revoke(撤销) / admin jump(跳转) / CC(抄送) |
| 自动通过 | mergeWithRequester / mergeAdjacentApprover / dedupeHistoricalApprover |
| 超时 | 节点级 timeout + effect：remind / transfer / jump（T1-1）|
| 条件 | condition routing / condition_branch（run-gov A6-3）|
| 字段权限 | fieldPermissions：hidden 强制（echo-redaction）+ readonly 声明（T1-4）|
| 签名 | signaturePolicy 声明-inert（T3-3，未强制）|
| 触发器 | record.created/updated/deleted · approval.completed(T1-3) · schedule · webhook.received(signed, T1-2) |
| 动作 | send_notification / send_webhook / send_email / dingtalk_* / create/update/delete_record / lock_record / start_approval / resultWriteback（含 cross-base T3-5）|
| 治理 | scoped admins(T2-1+2) · 去重 ledger(T2-6) · SSRF egress guard(R1/A3) · dedup/幂等 |
| 分析 | ApprovalMetricsService：SLA breach / node breakdown / duration p50·p95 / 模板·部门报表；business-calendar SLA(T3-2) |
| 读模型 | **approvals-as-multitable-records 投影(T3-6)** — 单向、event-silent、reconcile 幂等（**但还没有看板 UI**）|
| 移动端 | T3-1 v0 响应式 web，flag-gated 默认关，无推送 |

## 2. 钉钉/飞书能力模型 + 差距

| 维度 | 钉钉/飞书 | 我们 | 判定 |
|---|---|---|---|
| **流程引擎** | 会签/或签/条件/并行/加减签/转交/**委托(常设代理)**/回退/撤销/自动通过/审批人自选下一步 | 除**委托(常设)**、**并行内 threshold**、**审批人自选**外全有 | **~90% 平**：缺 委托 · 并行会签 · 审批人自选 |
| **表单设计** | 拖拽设计器 · **明细表/子表** · 公式字段 · 关联审批/数据 · 富控件(金额/日期区间/附件/地址/联系人) · **打印模板** | 表单 schema + 字段权限 + 可见性规则 + formula(多维表) | **落后**：缺 明细子表 · 富控件 · 打印模板 · 关联审批 |
| **触发/自动化** | 表单触发 · 定时 · 审批结果触发 · **海量应用连接器** · HTTP/机器人 | 触发器 4 类 + 动作 10+ 类 + cross-base + 幂等 + SSRF 网关 | **原语 ~平；连接器广度落后；multitable-native 集成(cross-base/data-hub)反而领先** |
| **移动端** | 原生 App · 推送 · 离线 · 移动表单 | v0 响应式 web，无推送 | **明显落后**（web-first 设计取舍）：缺 推送(需 Notification Hub) · 原生 · 移动填单 |
| **管理/治理** | **委托管理** · 审批统计看板 · **电子签/合规强制** · 查询导出 | scoped admins · 模板编辑 · SLA metrics · 审计记录 · egress 治理 | **落后**：缺 委托管理 · 看板 UI · 签名强制(T3-3 现为 inert) |
| **分析/报表** | 审批效率报表 · 统计 · 看板 | Metrics 后端强 + **T3-6 读模型**，**但无看板 UI** | **后端不弱，UI 落后**；T3-6 是差异化使能器 |
| **生态集成** | IM/日历/通讯录/文档/百应用 | 钉钉 auth/考勤 · K3/ERP 集成轨 · data-factory hub | 广度落后；我们押 **ERP/数据枢纽深度**（另一个游戏）|

## 3. 差异化命题（"超越"而非"追平"）

不要在**连接器广度**和**原生移动端**上跟钉钉/飞书硬碰——那是它们的护城河、且是无底洞。**赢在 multitable-native**：
T3-6 已经把审批数据变成一等多维表记录 → 在它上面建**它们做不干净的报表/看板/自定义视图/公式/跨表分析**。对它们审批数据是
封闭报表模块；对我们审批数据就是数据集。这是唯一值得投的"超越"杠杆。

## 4. 重排开发阶梯（benefit × risk）

**Tier 1 — 高收益 / 低-中风险 / 引擎相邻（下一弧，建议按 A→B→C）**
- **A. T3-6 投影可见性收紧** — 安全前置：投影表含审批结果，当前任何全局 `multitable:read` 用户可读=泄露。**无需新投票**（补完 design-lock §5 "admin/owner-scoped" 意图）。小。**先做**，否则在会漏的表上建看板。
- **B. 审批分析看板（建在 T3-6 读模型上）** — **差异化兑现**，T3-6 存在的全部理由。multitable-native，钉钉/飞书 复制不了。中。
- **C. 常设委托 / 委托管理（委托）** — 钉钉/飞书 标配、需求明确、引擎相邻（现有一次性 transfer 的自然扩展为按时间段的常设代理 + 管理面）。中。

**Tier 2 — 高收益 / 高投入**
- **D. 表单设计丰富度**（明细子表 + 富控件 + 打印模板）— 补最可见的产品面差距；大。
- **E. T3-3 签名强制**（inert → enforced + 电子签/合规）— 合规客户刚需；中-大（安全面重）。
- **F. 移动推送**（Notification Hub）— 解锁 T3-1 原生/推送；**独立基础设施弧**，非审批线内。

**Tier 3 — 决策/基础设施 gated**
- **G. 连接器库** — 广度无底洞；建议改走 data-factory/ERP 轨的深度，而非广度。
- **H. T3-2 多组织日历** — 需真实 requester→calendar-org 映射（产品/数据决策）。

## 5. 建议

**下一弧 = Tier 1 A→B→C，design-lock-first。** 逻辑：A 是安全前置且无需投票；B 是差异化变现（把 T3-6 从"数据在那"
变成"报表在用"）；C 关掉一个真实的钉钉/飞书 平价缺口。三刀都在引擎/多维表相邻区，风险可控，且共同讲一个故事：
**审批不是一个封闭模块，而是多维表上的一等数据。** Tier 2/3 各自是独立的 ballot/design-lock 起点，按需再开。
