# 审批 & 流程自动化 — 钉钉/飞书对标刷新审计 (2026-07-03)

> **内部研究文档**（`docs/research`）。对标钉钉/飞书用于**定位差距、重排开发阶梯**，不进正式 design 文档
> （正式文档只写 MetaSheet 自己的原则）。基线 = `origin/main @ 43e7e704c`（审批/自动化 runtime 全部 shipped 之后）。
> 对标 = 引擎能力，非 UI 精细度；结论是**下一弧的候选清单 + benefit×risk 排序**，不是承诺。

## 0. 一句话结论

**审批流程引擎已经 ~90% 追平钉钉/飞书**——本季度的密集开发把"流程引擎"这块缺口基本补完了。**剩下的真实差距不在引擎，
在产品面**：表单富控件/打印/关联审批、移动端、分析看板 UI、委托体验自助化、连接器广度、签名合规强制。**差异化杠杆不是去卷它们的护城河
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
| **委托** | **常设委托（委托）已 ship**：config CRUD + `/approval-delegations` UI 路由 + resolve-time delegator→delegatee 冻结替换 + real-DB 测试（`ApprovalDelegations` / migration `zzzz20260622060000`）|
| **表单/明细** | 表单 schema + **明细/子表单（detail: columns/minRows/maxRows、一层嵌套、公式聚合、行小计/金额一致性、real-DB 测试）** |
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
| **流程引擎** | 会签/或签/条件/并行/加减签/转交/委托(常设代理)/回退/撤销/自动通过/审批人自选下一步 | 全有，**含常设委托(委托，已 ship)** | **~90% 平**：仅缺 **并行内 threshold** · **审批人自选下一步** |
| **表单设计** | 拖拽设计器 · 明细表/子表 · 公式字段 · 关联审批/数据 · 富控件(金额/日期区间/附件/地址/联系人) · **打印模板** | 表单 schema + 字段权限 + 可见性规则 + formula + **明细/子表单(detail: columns/minRows/maxRows + 公式聚合 + 行小计/金额一致性)** | **部分落后**：缺 富控件 · 打印模板 · 关联审批/数据 · 移动填单体验（**明细子表已有**）|
| **触发/自动化** | 表单触发 · 定时 · 审批结果触发 · **海量应用连接器** · HTTP/机器人 | 触发器 4 类 + 动作 10+ 类 + cross-base + 幂等 + SSRF 网关 | **原语 ~平；连接器广度落后；multitable-native 集成(cross-base/data-hub)反而领先** |
| **移动端** | 原生 App · 推送 · 离线 · 移动表单 | v0 响应式 web，无推送 | **明显落后**（web-first 设计取舍）：缺 推送(需 Notification Hub) · 原生 · 移动填单 |
| **管理/治理** | 委托管理 · 审批统计看板 · **电子签/合规强制** · 查询导出 | scoped admins · 模板编辑 · **委托 config CRUD+UI** · SLA metrics · 审计记录 · egress 治理 | **部分落后**：缺 **委托自助化/审计展示** · 看板 UI · 签名强制(T3-3 现为 inert)（**委托 config 已有**）|
| **分析/报表** | 审批效率报表 · 统计 · 看板 | Metrics 后端强 + **T3-6 读模型**，**但无看板 UI** | **后端不弱，UI 落后**；T3-6 是差异化使能器 |
| **生态集成** | IM/日历/通讯录/文档/百应用 | 钉钉 auth/考勤 · K3/ERP 集成轨 · data-factory hub | 广度落后；我们押 **ERP/数据枢纽深度**（另一个游戏）|

## 3. 差异化命题（"超越"而非"追平"）

不要在**连接器广度**和**原生移动端**上跟钉钉/飞书硬碰——那是它们的护城河、且是无底洞。**赢在 multitable-native**：
T3-6 已经把审批数据变成一等多维表记录 → 在它上面建**它们做不干净的报表/看板/自定义视图/公式/跨表分析**。对它们审批数据是
封闭报表模块；对我们审批数据就是数据集。这是唯一值得投的"超越"杠杆。

## 4. 重排开发阶梯（benefit × risk）

**Tier 1 — 高收益 / 低-中风险 / 引擎相邻（下一弧，建议按 A→B→C）**
- **A. T3-6 投影可见性收紧** — **最高优先级 security/product decision**（非"无需投票"）：投影表含审批结果，当前是 standard multitable capability gate（任何持全局 `multitable:read` 者可读），per-row visibility 继承是 separate slice。默认建议 **admin/owner-scoped**，但 **visibility depth 仍需 owner 选择**——#3522 closeout 已把 "T3-6 visibility depth" 列为 reviewer-decision surface。小-中。**先做**，否则在会漏的表上建看板。
- **B. 审批分析看板（建在 T3-6 读模型上）** — **差异化兑现**，T3-6 存在的全部理由。multitable-native，钉钉/飞书 复制不了。中。
- **C. 委托体验增强（委托 runtime 已 ship）** — 常设委托的 config CRUD / `/approval-delegations` UI / resolve-time 替换 / real-DB 测试**已在 main**（`ApprovalDelegations`）。缺的是**自助化申请 + 审计/生效范围可视 + 边界情形**，不是新建引擎。中偏小。

**Tier 2 — 高收益 / 高投入**
- **D. 表单设计丰富度**（富控件 + 打印模板 + 关联审批/数据 + 移动填单体验；**明细子表已有**）— 补最可见的产品面差距；大。
- **E. T3-3 签名强制**（inert → enforced + 电子签/合规）— 合规客户刚需；中-大（安全面重）。
- **F. 移动推送**（Notification Hub）— 解锁 T3-1 原生/推送；**独立基础设施弧**，非审批线内。

**Tier 3 — 决策/基础设施 gated**
- **G. 连接器库** — 广度无底洞；建议改走 data-factory/ERP 轨的深度，而非广度。
- **H. T3-2 多组织日历** — 需真实 requester→calendar-org 映射（产品/数据决策）。

## 5. 建议

**下一弧 = Tier 1 A→B→C，design-lock-first。** 逻辑：A 是**最高优先级 security/product decision**（default admin/owner-scoped，
但 visibility depth 由 owner 定，不是无需投票）；B 是差异化变现（把 T3-6 从"数据在那"变成"报表在用"）；C 是**已 ship 委托的
体验增强**（不是新建）。三刀都在引擎/多维表相邻区，风险可控，且共同讲一个故事：**审批不是一个封闭模块，而是多维表上的一等
数据。** Tier 2/3 各自是独立的 ballot/design-lock 起点，按需再开。

> **勘误说明（本次 review 修正）**：初稿把**常设委托**和**明细子表**误列为缺口——两者均已 shipped（`ApprovalDelegations`
> / `normalizeDetailFieldParts` + 各自 real-DB 测试）；已从缺口移出并补进 §1 现状。T3-6 可见性从"无需投票"更正为
> "owner 决定 visibility depth"。根因：这两项是凭记忆写的、没 grep 代码——与 SQL-string 单测漂移同类，已引以为戒。
