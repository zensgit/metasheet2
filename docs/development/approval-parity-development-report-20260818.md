# 审批对标程序 — 开发报告（FINAL，2026-08-18）

**Status:** FINAL — **已执行批次的审批实现切片全部落地**。曾唯一在飞行的 K6 `#4993`（`form_field_user_manager` / `form_field_user_dept_head`，Lock-2 §L2-C）已于 **`ffa3a5f595`**（squash merge，2026-08-18T14:58:58Z）落地，闸门 **MERGE-CLEAN（0 P1）**；落地后派单人 union = **15 成员**（前后端逐字一致）。
八个 P7 phase-A FAIL 已由 **P7 phase-B 在 fresh `origin/main` 复核 = 8/8 FIXED**（见 §5.8）；phase-B 曾记的 FAIL-0 枚举守卫残留与可执行的判别性反例债（I3）已由 **#5004（`6ace2e5a01`）DISCHARGED**。
本文件**不 ratify 任何东西**，不授权运行时能力、租户 UAT、部署或 feature flag，**不是完成声明**。
**已执行批次内无一个在飞行的实现切片，无未 discharge 的可执行硬化项**；但剩余工作分两类，不得压平成一类——**尚未开发的代码切片**（P5-C / P3-A / Lock-2 其余实现 / L5-B 后加签运行时等，§6.3；见 §8 全表）与**owner 专属项**（第 7 节）。

| 锚点 | 值 |
|---|---|
| 仓库 | `zensgit/metasheet2` |
| 撰写日期 | 2026-08-18 |
| 程序起点（母锁落地） | `5b31cb4349` — `docs(approval): unify parity development program (#4935)` |
| **最后一个能力切片 head** | `ffa3a5f595` — `feat(approval): K6 — form-field contact extensions … (Lock-2 §L2-C) (#4993)` |
| **当前 `origin/main` tip** | `6ace2e5a01` — `test(approval): FAIL-0 enumeration guard + discriminating-negative discharge (#5004)`（**test-only residual-hardening**，不改任何能力面/union/计数；K6 与它之间 #5001–5003 为非审批） |
| 程序基线（母锁 header 自陈） | `origin/main@d33a6a0fa120452b721ea76d449dfa1463727463` |
| 已合并审批切片 | **45 个 PR** = **9 锁（Lock-0…Lock-8）+ 3 治理文档 PR**（#4935 母锁统一提案，一次落地母锁/台账/验证三份文档；#4937 母锁 RATIFY 状态翻转；#4866 表单构建器对标 delta 锁提案）+ **32 能力实现** + **1 residual-hardening（#5004）**，逐条见 §3.1。**订正**：先前版本写「12 文档锁」——文档锁只有 9 个（Lock-0…Lock-8，见 §2）；连同上述 3 个非 Lock 编号的治理/delta 文档 PR 才凑成「12 个文档 PR」，两者不是同一回事，已逐条对 `git log` 核实（见 §3.1 文档 PR 表，行数一致）。枚举命令：`git log --first-parent --oneline 5b31cb4349~1..6ace2e5a01 \| grep -iE "approval"` 返回 **46** 行，其中 `f2ed020d1b` (#4970, CI 触发器) 非程序切片 ⇒ **46 − 1 = 45**。从 git 枚举，非清单背诵 |
| Flags | **全程 OFF**，无一次改动（§1.4） |
| 完成标签 | CORE-PARITY: **NO** · DATA-CLOSURE: **NO** · PRODUCT-FINAL: **NO**（三者均需 owner 签署，见 §7.2） |

配套文件：`approval-parity-verification-report-20260818.md`（验证报告）。

> **M11 语言纪律（母锁 §M11）**：本文件一律使用「参考语料未证实（the reference corpus did not evidence）」
> 而非「竞品没有」；一律使用「已实现于默认关闭的开关之后」而非「已交付」。
> 任何未出现在来源中的数字标 `TAIL-PENDING`，不推算、不补齐。M8/M11 纪律承重：本报告不做超额声明，
> 每一条声明都给 provenance（SHA / 文件行 / 闸门 MD），并保留诚实分层。

---

## 0. 与 DRAFT 的差异（尾部结算）

DRAFT（`3335ccc435` = #4972 P1-C 为 head）之后落地的 **6 个审批实现切片**，本 FINAL 逐条结算：

| 切片 | PR | 合并 squash SHA | DRAFT 中的标记 | FINAL 状态 |
|---|---|---|---|---|
| P5 L5-A 逐节点操作策略（操作权限） | #4980 | `d034b1f710` | TAIL-PENDING（OPEN） | **LANDED** — 解除 R7 与 `操作权限` 标签；操作策略轴由「未达」翻「已达」 |
| P5-B 前加签诚实 + `commentRequired` + A-2 镜像 | #4983 | `327ac6427b` | TAIL-PENDING（OPEN，堆叠于 #4980，base 非 main） | **LANDED** — 闸门 3 轮后 CLEAR；base 已 retarget 到 main（解除 DRAFT 的「必需检查压根不跑」）；A-2 仍 **PARTIAL** |
| P7-R2 焦点环对比度 / harness 样式表 / 详情文案 | #4981 | `6488353bf8` | TAIL-PENDING（OPEN） | **LANDED** — 修复 FAIL-2 / FAIL-5 / FAIL-6 + 三个原始 ID 暴露候选 |
| P7-R1 测试覆盖修复（FAIL-0/1/3/4/7） | #4984 | `512f0df608` | TAIL-PENDING（无独立闸门 MD） | **LANDED** — 现有独立闸门 MD（`/tmp/pr4984-p7r1-gate-20260818.md`），APPROVE-with-hardening；**残留 P2-1**（见 §5.8） |
| F4 生产挂载（Designer 2.0，canvasV2 后） | #4994 | `345a1f1c0e` | 未起草（把 P0 钉为不可完成） | **LANDED** — MERGE-CLEAN；**F10 挂载缺席声明 DISCHARGED**（见 §3.2） |
| K1 `user_group` 派单人种类 | #4995 | `6abd241925` | 未落地 | **LANDED** — 第 13 个派单人 union 成员；对标语料的「用户组」审批人行闭合（见 §4） |
| K6 表单内联系人上级/部门负责人（`form_field_user_manager` / `form_field_user_dept_head`，Lock-2 §L2-C） | #4993 | `ffa3a5f595` | DRAFT/上一版 FINAL 记为「唯一在飞行」 | **LANDED** — 第 14、15 个派单人 union 成员（union 15/15 前后端逐字一致）；闸门 MERGE-CLEAN（0 P1），仅 rebase-readiness 需处理且已 clean 解决；trait 表 `user_group: NO_ORG_TRAITS`（避免重开 requester-org wedge）；BE tsc + web 复合 type-check 均 exit 0、BE approval 单测 857/857、FE approval 300、canvas-inspector 48/48、9 required + `approval-realdb-k6-contact` 均绿。**对标派单人种类因此由「部分」翻「已达」（见 §4）** |

另外三个 DRAFT 已入表的切片（#4973 K3、#4974 P6-explanation、#4979 D-1）在 DRAFT head 之前即已落地，本 FINAL 沿用其记录。

**已结算的欠账：**
- **V-3 DISCHARGED**：#4965（L6-A 轮次作用域）曾在 `62140682bc` requalify 为 **NOT-CLEAR**（一个 test-only P2-A：后向跳转下限的消耗判别器缺失），合并为 `57a7443ede`。闭合证据 `/tmp/pr4965-v3-closure-20260818.md` 在**合并后的 main**（`3335ccc435`，其后无提交触及该 floor 区间，逐 blob 核实）上机械跑了两条变异：Mutation D（删 `jump AND backwardReentry` 臂）恰红 `:593`，Mutation A（删 `action='return'` 臂）恰红 `:399`，两条互不重叠 ⇒ **两个后向重入臂各自 load-bearing，已 mutation-proven**。
- 尾部合并列车的 **run-list / vitest.config UNION 存活**（#4980/#4983/#4984/#4994/#4995 依次落地，四个 PR 同改 run-list/guard/exclusion）在当前 head 机械核实为**完整**（见验证报告 §4.5）——这正是 FAIL-0 那一类「静默去接线」的高危窗口，本次未发生。

---

## 1. 目标与治理

### 1.1 目标集

母锁 §1 定义的产品结果：一位**普通管理员**在不接触 JSON、原始 ID、实现术语的前提下能够完成六件事——
① 用点击/键盘/语义拖拽到**精确插槽**搭建类型化表单；② 在一张竖向画布上搭建线性/条件/并行流程；
③ 配置企业派单人、聚合模式、兜底、字段权限与允许操作；④ 预览路径、发布不可变版本、比对版本、恢复为新草稿；
⑤ 按服务端强制的策略提交/同意/驳回/转交/加减签/退回/撤回/催办/查历史；
⑥ 在**独立启用**之后，用已审批的值创建或更新多维表记录，具备持久、幂等、不放大权限的投递。

母锁把完成度**刻意拆成三个互不蕴含的标签**：

| Label | 所需范围（母锁 §1 逐字） |
|---|---|
| `CORE-PARITY` | P0-P5 implemented, exact merged-main verified, browser/a11y passed, Canvas tenant UAT passed, and explicit owner sign-off recorded |
| `DATA-CLOSURE` | P6 implemented, exact DATA matrix passed on merged main, FWB then attachment tenant UAT passed, and explicit owner sign-off recorded |
| `PRODUCT-FINAL` | both labels plus accepted residuals, staged rollout/rollback evidence, and explicit owner sign-off |

以及那句被本程序反复引用的边界：
> **「Merged code behind a default-OFF flag is an engineering asset, not a delivered product capability.」**

### 1.2 锁流水线治理

每个能力切片必须走完整条链，任何一环都不得跳过或用后一环覆盖前一环：

```
起草 draft  →  独立评审 independent review  →  ratify  →  实现 implement
          →  独立对抗闸门 adversarial gate  →  修复轮 fix round  →  合并 merge
```

三条硬性约束（母锁 §6）：

- **一个 PR 一个行为切片**，禁止阶段级巨型 PR。
- **锁与 owner 决策先于新运行时语义**：ledger §0 规则 4——「A Draft/PROPOSED row is not authorized
  runtime work unless the owner-decision column names the ratified lock or explicit implementation authorization.」
- **无自我 ratify**：「No agent self-ratifies, self-enables a flag, or turns CI green into release authorization.」

链条在本程序里是**真的被执行的**，证据是 requalification 轮的存在：#4951 / #4952 / #4954 / #4956 / #4958 / #4961 / #4965
七个切片都产生了独立的 requalification MD；尾部又新增 **#4983 的三轮**（Round-1 FIX-ROUND `464ec8a5c7` → Round-2 NOT-CLEAR `c3e56d0ba3` → Round-3 **CLEAR** `007f71e53b`）与 **#4995 的两轮**（Round-1 FIX-ROUND `f7e2780366` → Round-2 requalify `0b7d0860bf`，抓到一个同类新 P1 harness rot 并要求修复）——都因为 ledger §0 规则 3 规定 **rebase 或冲突解决就使判定失效**。

### 1.3 ⚠️ Provenance 分层纪律（本程序最容易被误读的一点）

**三层，严禁压平成一层。**

| 层 | 定义 | 本程序中的实例 |
|---|---|---|
| **① Owner 亲手动作** | owner 本人书写/操作，不可由代理代写 | **仅一处**：母锁 §9——「Owner: zensgit — explicit in-session instruction on 2026-08-17 to execute the recorded recommendation (**owner requested execution twice and merged #4935 personally**)」。reviewed 单提交 `217b56137e28729c15f671ff4984908e275a8406`，落地 squash `5b31cb4349`，三份文档在两个 SHA 之间**逐 blob 相同**。其自陈：「Runtime authorization: **NONE**」 |
| **② Goal-set provenance（会话内目标集裁定）** | 编排会话按目标集作出的裁定，**记录在案、可逆** | **Lock-0…Lock-8 全部九个锁**，以及 P1-C 的 P2-3 处置、OD-L4-10(a) 边界修正、#4979 的 P3-3 read 轴收窄、K1 的 G-6「不可满足」裁定。ledger 逐字：「goal-set provenance, **not an owner-authored ratification**, and **REVERSIBLE** if an owner later amends the lock text itself」 |
| **③ 闸门修复轮** | 对抗闸门发现问题后的修复 | **既不是 ratification，也不是实现授权**。#4951 的 ledger 行逐字：「**a gate fix round is not that authorization**」 |

**因此本报告中绝不出现「九个锁由 owner ratify」这类表述。** 九个锁的 ratification 属于第 ② 层。
owner 亲写的 ratification 只有母锁 §9 一处，且它只批准**设计程序**本身。

（相关的历史教训在案：把 owner 的「建议」模板文字写进锁文当成「owner instructed verbatim」构成自证循环，
2026-08-12 曾因此产生一次 P1 并撤回。本程序对此采取的形式是：锁文只引用 goal-set provenance，不伪造 owner 署名。）

### 1.4 Flags 全程 OFF

ledger §7 的初值是**策略断言而非环境观测**，且整个程序期间无一次改动：

| Capability | Code default | Staging observed | Production observed | Enable authorization | Rollback verified |
|---|---|---|---|---|---|
| Canvas V2 | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Durable delivery | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Class A action ledger | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Class B action ledger | explicit env gate | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| FWB | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |
| Attachments | OFF | NOT RECORDED | NOT RECORDED | NO | NOT RUN |

F4（#4994）落地生产挂载后，Canvas V2 的默认值仍在 `stores/featureFlags.ts:81` 上机械核为 `approvalCanvasV2: false`（F4 闸门 §4，未被该 PR 触及）。P7 phase-A 复核的三道独立门未变：
`routes/approval-attachments.ts:107` 与 `approval-fwb-activation.ts:146` 都要求字面量 `'true'`；
`routes/approval-attachments.ts:6` 的注释「REGISTERS NOTHING unless …」。

**私有发布前置条件**按母锁 §0.2 的披露纪律，**在本公开程序之外跟踪**；本文件不记录任何私有车道标识、
状态、实现细节或私有证据。

---

## 2. 设计权威层 — 九个锁（Lock-0 … Lock-8）

九个锁全部落在 `origin/main`，**全部 Status: RATIFIED**，且**每一个的 Non-effects 条款都声明「设计授权 only」**
——不授权运行时、flag、UAT 或部署。RATIFIED 属于 provenance 第 ② 层（goal-set provenance），**不是 owner 亲写的 ratification**。

发现命令（可复现）：
```
git ls-tree -r --name-only origin/main | grep -i "approval-lock"
```
OD 计数命令（**按各锁自身前缀**，去重；不加前缀限定会把跨锁引用算进来，例如 Lock-5 会从 11 虚增到 16）：
```
git show origin/main:docs/development/approval-lock<N>-*.md | grep -oE "OD-L<N>-[0-9]+" | sort -u | wc -l
```

| Lock | 范围 | OD 数 | 验收闸门 | 独立评审判定 | 关键处置 |
|---|---|---|---|---|---|
| **Lock-0** D0 交互增量 | **0**（用 `L0-1..L0-6` 增量方案，非 OD 前缀） | **A-1..A-13**（13） | 独立 fable 评审 | 六个增量 L0-1..L0-6 接受；`操作权限` 标签在 Lock-5 落下**至少一个功能性策略**前**不渲染**（空标签 = theater）——该条件已被 #4980 解除 |
| **Lock-1** 企业派单人种类 | **7**（OD-L1-1..7） | **G-1..G-20**（20） | 独立 fable 评审 | K1-K6 契约；K1(`user_group`)/K2/K3/K4/K5-b **已落地**；K6(`sequential`) 仍未落地（母锁 §8 非目标，除非另开能力锁）；group 端点由 K1 #4995 落地 |
| **Lock-2** 组织控件、字段派生派单人、部门路由 | **8**（OD-L2-1..8） | **21 行** | **REQUEST-CHANGES**（#4953 @ `a30970af13`）：1 P1 / 1 P2 / 1 P3 / 4 NIT；P1 = Lock-1 §K4 处置错误重开一个已 ratify 决定；均在评审轮 `a1a932ddc3` 闭合；15 组承重声明抽验，**零条代码声明被推翻** | **§L2-C（form-field 派生的 manager/dept-head 派单人）由 K6 #4993 (`ffa3a5f595`) 落地**；Lock-2 其余（字段派生部门路由、部门/联系人字段类型）**未起始** |
| **Lock-3** 办理/业务操作节点 | **7**（OD-L3-1..7） | **G-1..G-18**（18） | 独立 fable 评审 | 办理节点契约 + 25 行爆炸半径 + Lock-7 接缝；**P4-A #4956 已落地** |
| **Lock-4** 自动决策/兜底/去重/同人 | **10**（OD-L4-1..10） | **22 行** | 独立 fable 评审 | F4-A..E 契约；**退回置空危险被锁定（OD-L4-10）并配 D-3 闸门**；L6-A 轮次作用域 #4965 已落地（V-3 已 DISCHARGE）；`auto_reject` 与 P3-A 剩余语义仍推迟 |
| **Lock-5** 逐节点操作与成员动作策略 | **11**（OD-L5-1..11） | **25 行** | 独立 fable 评审 | **L5-A（操作权限）= #4980 已落地**；**L5-C/L5-D（`commentRequired` 三值键）= #4983 已落地**；**L5-B 的诚实性半边（移除 placebo 前加签）= #4983 已落地**，其**后加签运行时半边（OD-L5-4/5 节点插入 + `addSignAggregation`）仍推迟**；**L5-E（`signaturePolicy` 声明即惰性等）推迟并指定 owner 切片**；L6-E 归属孤儿见 §7.8 |
| **Lock-6** 发起人 + 全局审批/文档策略 | **10**（OD-L6-1..10） | **17 行** | 独立 fable 评审（抽验并证实 L6-P1 已发布缺陷） | L6-A 去重档位 = 第一个全局策略 + 第五步激活器（#4967 已落地）；v1 = L6-A + L6-P1 前置（#4957 已落地）；**L6-B/C/D/E 全部 DEFERRED 并各自具名阻塞点**；**L6-F1（转发范围限制）在 v1 被 REJECTED 为惰性——「This product has no share/forward operation.」**；L6-E 移交 Lock-5 |
| **Lock-7** 具名编辑面的服务端强制 readonly/editable | **12**（OD-L7-1..12） | **18 行** | **REQUEST-CHANGES**（#4955 @ `5c8eae9ec5`）；评审 MD 记 0 P1 / 3 P2 / 3 P3 / 2 NIT，ledger 行记「2 P2」——**计数不一致（见 §6.4 D-6）**；均在 `70ce8773b3` 闭合 | P4-B #4961 落地服务端强制；D-1 read 轴 #4979 收口；**D-5 read-scope 保持 OPEN 的 owner 问题（§7.6）** |
| **Lock-8** 有界额外表单字段词汇 | **9**（OD-L8-1..9） | **21 行** | **「Independent review: (none recorded)」**——九锁里唯一没有记录 ratify 前评审轮（见 §6.4 D-7） | L8-A 说明（#4974）/ L8-B date_range（#4964）/ L8-C formatted-number props（#4959）**全部落地**；**L8-D formula 按设计推迟并带负契约（该成员根本不进入任何 union）**；no-print-substrate 排除；census-not-checklist 教义 |

**Lock-1..Lock-8 自前缀 OD 合计 = 7+8+7+10+11+10+12+9 = 74。**（Lock-0 按构造为 0。）

---

## 3. 实现交付（P0 → P6）

### 3.1 逐 PR 台账（从 `git log --first-parent origin/main` 枚举）

**文档 PR（9 个锁 + 母锁 + 母锁 RATIFY + delta，共 12）：**

| squash SHA | PR | 内容 |
|---|---|---|
| `5b31cb4349` | #4935 | 母锁 `docs(approval): unify parity development program` |
| `0e8ed11671` | #4937 | 母锁 §9 RATIFY 记录，Status PROPOSED→RATIFIED |
| `075d078eb4` | #4938 | Lock-0 D0 交互增量 |
| `b1195b84bc` | #4940 | Lock-1 企业派单人种类 |
| `3c5f0992ba` | #4941 | Lock-4 流程策略 |
| `e0c882220c` | #4943 | Lock-3 办理节点 + 变更边界 |
| `8aa9fb00eb` | #4945 | Lock-6 发起人 + 全局策略 |
| `6c0b9162a9` | #4947 | Lock-5 逐节点操作/成员动作策略 |
| `c9333a4e31` | #4950 | Lock-8 有界额外字段词汇 |
| `0b5c82f655` | #4866 | 表单构建器对标 delta 锁 |
| `8bb237a5de` | #4953 | Lock-2 组织控件/字段路由 |
| `0ccd680862` | #4955 | Lock-7 字段编辑/可见性强制 |

**实现 PR（按阶段，32 个，不含 #5004 residual-hardening）。**（**订正**：先前版本误写 31 个；下表逐行清点为 32 行，加上 §3.3 之前的 9 锁 + 3 治理文档 + 1 residual = 45，与 §0 锚点表一致。）尾部六切片的闸门判定与合并 SHA 见下表加粗行；判定绑 reviewed head SHA，**合并 squash SHA 通常未被重新过闸**（这是形状事实，见验证报告 §3.1）。

| 阶段 | 切片 | PR | squash SHA | 闸门判定（reviewed head） | 修复轮 |
|---|---|---|---|---|---|
| **P0** | F0 抽取 `ApprovalFormInlineEditor` | #4939 | `2f4bf6ce3e` | REQUEST-CHANGES @ `8e65ab166c…`（1P1/3P2/3NIT） | MD 内未执行（见 §6.4 D-4） |
| | F1 命令适配器 + 不透明 ID 分配器 | #4942 | `c7f736b370` | REQUEST-CHANGES @ `c9f7ce3bfd…`（0P1/4P2/3P3/3NIT） | MD 内未执行（见 §6.4 D-4） |
| | F2 精确插槽 + 类型化拖拽编解码 + 浏览器 harness | #4949 | `5a81400ebe` | **APPROVE-with-hardening** @ `53c27520b5…`（0P1/0P2/6P3/3NIT），M1–M10 判别变异 | 不适用 |
| | F3 类型化 retype 命令 + 选中字段检查器 | #4954 | `0766eb35e5` | FIX-ROUND @ `deaaeea983…` → requalified `c7970b396d…` = **CLEAR** | 是 |
| | **F4 生产挂载（Designer 2.0，canvasV2 后）** | **#4994** | **`345a1f1c0e`** | **MERGE-CLEAN @ `8a82978021` — 0 P1, 0 P2**（`/tmp/pr4994-f4-gate-20260818.md`）；flag-OFF 零可见行为变更，两点 mutation-proven（M1/M2） | 不适用 |
| **P1** | P1-A 检查器三标签 + 能力注册表 | #4944 | `a4ee60d290` | REQUEST-CHANGES @ `347c8035ef…`（1P1/3P2/3P3/5NIT） | ledger §4 记录修复轮 + 五项自陈偏差逐条裁定 |
| | P1-A0 基本信息步导问题计数 | #4960 | `a59cf6a7df` | **APPROVE / MERGE-CLEAN** @ `97830ef340…`（0P1/0P2/1NIT） | 不适用 |
| | P1-B 多来源派单人卡片（＋添加审批人） | #4963 | `22ab8c6ada` | **APPROVE-with-hardening** @ `655ee4b0a6…`（0P1/1P2/0P3/1NIT） | 无前置闸门 |
| | P1-C timeout + threshold 前端兼容 | #4972 | `3335ccc435` | CHANGES-REQUESTED（hardening）@ `0b5908ab2d…`（0P1/3P2/2P3/2NIT） | 两轮：`6c2d61c419` → `fa8e92c9b6` |
| | P1-D 扁平卡片 + 分支优先级/默认分支文案 + 版本入口 | #4951 | `ef1ded4573` | CHANGES-REQUESTED @ `5fe9489a0f…`（2P1/6P2/5P3/2NIT） → requalified `1edded1fa9…` = **CLEAR**（其上再叠 residual 轮） | 是 |
| **P2** | K2 `requester_choice` | #4952 | `a35d939fcb` | APPROVE-with-hardening @ `06d7f1d875…` → requalified `1f79be0799…` = **CLEAR** | 是 |
| | K4 `continuous_dept_heads` | #4958 | `a21b274ec1` | APPROVE-with-hardening (FIX-ROUND) @ `eac17df508…` → requalified `bfef499302…` = **CLEAR — 0 P1, 0 P2** | 是 |
| | K5-b `dept_head_at_level` | #4962 | `150cdb0848` | **APPROVE (MERGE-CLEAN)** @ `618ca00688…`（0P1/0P2） | 首轮即净判 |
| | K3 `prior_node_approver` + fail-closed `normalizeApprovalMode` | #4973 | `90c41fbf60` | APPROVE-with-hardening @ `1c315e5a3e…`（0P1/1P2/3P3/1NIT） | 无前置闸门 |
| | **K1 `user_group`（第 13 个 union 成员）** | **#4995** | **`6abd241925`** | Round-1 FIX-ROUND @ `f7e2780366`（P1 self-service bind + P2×3）；Round-2 requalify @ `0b7d0860bf` = **NOT-CLEAR**（抓到同类新 P1 = harness rot）。**两个 P1 均已闭合并 merged**：write-side bind 移到 `ensurePlatformAdmin`（live-probe 403 验证）；harness 5 成员 + `user_group` 分支在当前 head 机械核为**存在**（`approval-inspector-keyboard-harness.ts`）。**残留：G-6「不可满足」= owner 裁；picker 跨命名空间元数据 = 已诚实披露非权限放大** | 是（见 §5.9） |
| | **K6 表单内联系人上级/部门负责人（`form_field_user_manager` / `form_field_user_dept_head`，Lock-2 §L2-C，第 14/15 个 union 成员）** | **#4993** | **`ffa3a5f595`** | **MERGE-CLEAN — 0 P1 @ `093830c4bc`**（3 承重守卫 mutation-proven）；唯一 blocker = rebase-readiness（K6 分叉早于 K1 的 `user_group`），已 clean 解决：15 成员 union / label / order / trait 表对齐，trait 表 `user_group: NO_ORG_TRAITS`；两处 exact-set 测试更新加 `user_group`；合并前 BE tsc + web 复合 type-check exit 0、BE 857/857、FE 300、canvas-inspector 48/48、9 required + `approval-realdb-k6-contact` 均绿 | 仅 rebase-readiness（已完成） |
| **P3** | L6-P1 修复模板编辑策略载体 | #4957 | `0cbae291bc` | **MERGE-CLEAN** @ `99b6e5713a…`（P1:none. P2:none.） | 首个闸门 |
| | L6-A 轮次作用域 dedup（OD-L4-10(a)） | #4965 | `57a7443ede` | FIX-ROUND @ `5f18dec85f…` → requalified `62140682bc…` = NOT-CLEAR（一个 test-only P2）。**V-3 DISCHARGED**：合并后 main 上两条 floor 臂 mutation-proven（§0 / 验证报告 §3.5） | 是（closure evidence `/tmp/pr4965-v3-closure-20260818.md`） |
| | 发布顺序修复 | #4966 | `d002b1883a` | **MERGE-CLEAN** @ `d7a560b3b3…`（0P1/0P2/0P3/0NIT） | 无 |
| | P3-B More-settings 第五步 + L6-A 模板 dedup 档位 | #4967 | `e1dd97bfd4` | APPROVE-with-hardening（1×P2）@ `3d584e1256…` | 单轮 |
| **P4** | P4-A 办理 / 办理节点（Lock-3） | #4956 | `b43025e3b3` | CHANGES-REQUESTED (FIX-ROUND) @ `bdaf8614b0…`（0P1/1P2） → requalified `baeaaf1608…` = **CLEAR — merge-ready** | 是 |
| | P4-B 逐节点字段编辑/可见性强制（Lock-7） | #4961 | `f5c06b35cd` | CHANGES-REQUESTED (FIX-ROUND) @ `f5e7774c11…`（1P1/2P2） → requalified `1d870f7c60…` = **CLEAR — merge-ready** | 是 |
| | D-1 非写入型节点拒收 `fieldPermissions`（read 轴） | #4979 | `6a67eccea1` | **FIX-ROUND** @ `2a17d8358e…`（0P1/1P2/3P3/3NIT），真 PostgreSQL 6 行变异 + 5 探针 | ledger 记录修复轮已应用 |
| | **P5 L5-A 逐节点操作策略（操作权限）+ 派发闸 + 拒绝审计（Lock-5）** | **#4980** | **`d034b1f710`** | **APPROVE-with-hardening @ `d47764d993`**（merge-clean on correctness；**3×P2 by owner call**；0P1/3P2/5P3/3NIT），base `main@385a433821`；含 M10（choke 移到 lock 字面位置 → 恰红那一个测试）（`/tmp/pr4980-p5-gate-20260818.md`） | 无前置闸门 |
| | **P5-B 前加签诚实（B-2）+ `commentRequired`（§1.3）+ A-2 成员操作栏镜像（Lock-5）** | **#4983** | **`327ac6427b`** | **Round-3 CLEAR @ `007f71e53b` — 0 P1, 0 P2**（base `main`，retarget 已完成）；Round-2 NOT-CLEAR `c3e56d0ba3`；Round-1 FIX-ROUND `464ec8a5c7`（`/tmp/pr4983-p5pr2-gate-20260818.md`）。**A-2 被下调为 PARTIAL** | 是（三轮） |
| **P6** | P6-amount 数字字段金额属性（L8-C） | #4959 | `0501529f33` | **MERGE-CLEAN** @ `4853afeda2…`（0P1/0P2；2P3/3NIT） | 单轮 + P3 修复轮 |
| | P6-daterange `date_range`（L8-B） | #4964 | `9d9fbc9dd3` | **MERGE-CLEAN (APPROVE)** @ `31748ddf36…`（0P1/0P2） | 无 |
| | P6-explanation `explanation`（L8-A） | #4974 | `4259d9fde8` | APPROVE-with-hardening（workflow enum: FIX-ROUND）@ `215e2cb570…`（0P1/**2P2 未闭合**/3P3/2NIT）（见 §6.4 D-2） | 见 §6.4 D-2 |
| **P7** | **P7-R1 测试覆盖修复（FAIL-0/1/3/4/7）** | **#4984** | **`512f0df608`** | **APPROVE-with-hardening（MERGE-CLEAN after P2-1）@ 独立闸门 MD**（`/tmp/pr4984-p7r1-gate-20260818.md`）；含 249 文件有界机械扫描。**残留 P2-1**：9 个新接线真库套件里 6 个缺自身 anti-skip-green 哨兵（§5.8） | 见 §5.8 |
| | **P7-R2 焦点环对比度 / harness 样式表 / 详情文案** | **#4981** | **`6488353bf8`** | **APPROVE-with-hardening @ `caa650d26c`**（0P1/3P2/3P3/2NIT）；含 M8（第二个 `<style>` 块绕过全部四条断言）（`/tmp/pr4981-p7r2-gate-20260818.md`） | 无 |
| **UI** | UI-6 详情标签锚点 + 审计派生记录表 | #4946 | `b296b4d6eb` | CHANGES-REQUESTED @ `44005ba8e1…`（0P1/2P2/3P3/5NIT）→ requalified（20260819，reviewer-local）@ `d8ac22c989` = **REQUALIFIED-CLEAN**（见 §6.4 D-3） | 是（reviewer-local，未入库；合入时零记录评审的形状事实不变） |
| | UI-7 审批中心桌面主从面板 | #4948 | `9f50cd46a3` | CHANGES-REQUESTED @ `3fe98e1f13…`（1P1/6P2/5P3/1NIT）→ requalified（20260819，reviewer-local）@ `d8ac22c989` = **REQUALIFIED-CLEAN**（见 §6.4 D-3） | 是（reviewer-local，未入库；合入时零记录评审的形状事实不变） |
| **残留硬化** | **FAIL-0 机械枚举守卫 + I3 判别性反例 + pack1a 接线** | #5004 | `6ace2e5a01` | **MERGE-CLEAN — 0 P1 / 0 P2 @ `3f7ca76a39`**（opus 闸门）；guard 追踪真实 CI 接线且当场抓到真实未接线套件 | 不适用（test-only residual-hardening） |

### 3.2 P0 硬边界 — **DISCHARGED**（F4 #4994 落地）

DRAFT 曾把 P0 钉为「在任何 SHA 上都不能宣告完成」，理由是验收母本 §4：
「**F10 must be collected by the always-on required-web job before P0 can complete.**」
而 F10 的生产挂载被 main 自己的测试钉为缺席。

**F4 #4994（`345a1f1c0e`）落地后，该缺席声明 DISCHARGED：**

1. **生产挂载存在**：`TemplateAuthoringView.vue:333/338` 在 `showFormBuilderV2`（`canvasV2Enabled && formSessionHydrated`）后挂载 `ApprovalFormPalette` + `ApprovalFormBuilder`（当前 head 机械核实）。
2. **旧「缺席钉」已翻**：`approval-form-builder-slots.spec.ts:1118` 现为 **F4 FLIPPED PIN**——「exactly TemplateAuthoringView.vue mounts the new builder/palette, and only inside the flag-gated v2 wrapper」。
3. **F10 由 required job 收集**：**行为级** mounted-iff-flag 证明住在 `apps/web/tests/approvalTemplateAuthoring.spec.ts`（token `approvalTemplateAuthoring` 在 `run-required-web-tests.sh` 的必需列表内），F4 闸门的 M1/M2 变异（移除/中和挂载）**各打红 8 / 9 项，含 flag-OFF pin**。⇒ 挂载受**必需** web job 守卫，不只是浏览器车道。P7 phase-B 另在 fresh `origin/main` 行为级复核两侧闸（flag OFF：Designer 2.0 完全缺席、legacy 存在；flag ON + hydrated：挂载、legacy 缺席），F10 pin **inverted-not-deleted**。

**但 P0 的完成（进而 CORE-PARITY 标签）仍 = NO，因为以下均为 owner 专属且未执行：**
- **分支保护 owner 步**（delta §7.1 item 8）：`approval-browser-verify` 仍**不是**必需检查（F4 闸门 live 复核：必需集仍 9 条，无审批车道）。撤销/重做启用守卫（F4 P3-1）目前**只由非必需浏览器车道**覆盖。
- **四视口义务被窄化**（F4 P3-2）：13 行里 12 行跑在锁未点名的 1280×720 单 Playwright 项目上，仅 B9 遍历四个必需宽度——**记为已披露的偏差，待 owner 接受或加四个 project**。
- **检查器 number-props / date_range 授权缺口**（canvasV2 后）：F4 闸门裁定为 **containment upheld（P3）**——失败模式是 publish 时 fail-closed 拒绝（values-free），**不是静默默认**，已在三处（两份治理文档 + 代码）披露。owner 在关闭该缺口的后续切片落地前，不应为依赖 `date_range` / 数字展示授权的租户启用 `canvasV2`。
- **Canvas 租户 UAT + owner 显式签署**（§7.1/§7.2）。

母锁 M3 的原句仍适用于任何**纯 helper** 证据：「A pure helper test is substrate evidence only; it does not prove the live authoring view uses that path.」——但 F4 的行为级 mount 证明恰恰**不是** helper 证据，而是 required job 里被变异证伪的真挂载。

### 3.3 数据库迁移（本程序窗口内新增，机械枚举）

```
git diff --name-status 5b31cb4349..6abd241925 -- packages/core-backend/src/db/migrations/
```

| 迁移 | 承载切片 | 部署风险 |
|---|---|---|
| `zzzz20260817120000_add_handle_action_to_approval_records.ts` | P4-A #4956（办理动作） | — |
| `zzzz20260817130000_create_approval_form_field_revisions.ts` | P4-B #4961 / Lock-7（字段修订，append-only） | — |
| `zzzz20260818090000_add_policy_denied_action_to_approval_records.ts` | **P5 L5-A #4980**（`policy_denied` 拒绝审计动作，一处纯 CHECK 放宽） | **首次部署顺序风险**：#4980 闸门 P2-1 记录该 CHECK 被测试 helper 的 DDL bootstrap 静默覆盖（回退迁移仍 20/20 通过）⇒ 测试里零承重；**若迁移落后于镜像，一次被拒操作会返回 500 而非 409**。⇒ 迁移必须先于镜像（§7.3） |
| `zzzz20260818120000_create_approval_usable_member_groups.ts` | **K1 #4995**（`user_group` 每-org 绑定表 + `created_by→users` FK + `group_id` 索引） | K1 闸门 P2-c：套件曾自建弱形状 fixture，遮蔽了迁移真形状（已在修复轮加 schema-shape 断言） |

四个迁移**均已合并**，但**生产应用属于 owner 门控的平台 DDL 治理**（P4-A 闸门原话）——合并 + flag OFF + 无部署**改变零生产行为**。`zzzz` 排序陷阱提醒：新列若落在 `zzzz` 表上，其迁移文件名也必须是 `zzzz` 前缀。

---

## 4. 对标结论（Feishu 参考语料 vs 当前审批 head `ffa3a5f595`）

> **M11 强制措辞**：下表左列一律是「参考语料证实了什么」，不是「竞品有/没有什么」。
> 语料自身的边界（母锁 §0.1 逐字）：「The corpus proves documented Feishu behaviors;
> it does not prove the absence of undocumented behavior.」
> **D-8 纪律：本表右列的「Feishu 侧计数」一律不填**——任何比较型数字必须先有语料行支撑。
> 我方的「13 派单人种类」「13 表单字段类型」是**实测数**（BE `approval-product.ts:19` = FE registry 逐字），
> 不得据此推出对方的数。

| 能力族 | 参考语料证实（母锁 §2.1） | 当前审批 head 实测 | 判定 |
|---|---|---|---|
| 表单构建器 | 组件面板、中央表单、属性配置 | F0/F1/F2/F3 底座 + **F4 生产挂载已落地**（`showFormBuilderV2` 后，canvasV2 默认 OFF）；F10 由必需 job 收集 | **部分**（挂载已达；四视口义务窄化 + 检查器 number/date_range 缺口 + 租户 UAT 未跑，见 §3.2） |
| 流程拓扑 | 线性与条件路由 | 线性/条件/并行图 + 受约束语义移动（Canvas flag 后）+ **办理节点**（P4-A） | **已达**（默认 OFF flag 之后；租户 UAT 未跑） |
| 派单人选择 | 上级、部门负责人、用户组、发起人自选/本人、前节点与**字段派生来源** | **15 种，前后端逐字一致**（BE `approval-product.ts:19` = FE `types/approval.ts:21`）：前 13 种 + `form_field_user_manager` + `form_field_user_dept_head`。`user_group`（用户组）K1 #4995 落地；**字段派生来源**已从 `form_field_user` 扩到其 manager / dept-head 派生（K6 #4993 `ffa3a5f595`）；多来源编辑（P1-B）已落地 | **已达** — 语料点名的审批人种类（上级 / 部门负责人 / 用户组 / 发起人自选·本人 / 前节点 / 字段派生来源）**全部在 main**；K6 落地后再无在飞行的派单人切片 |
| 聚合模式 | 全部、任一、顺序 | `single/all/any/threshold`（P1-C 使前后端 4 成员对齐）；`ApprovalMode` 在 BE `approval-product.ts:20` 与 FE `types/approval.ts:29` 均为 4 成员 | **部分** — **`sequential`（依次审批，Lock-1 §K6）未落地**；母锁 §8 已把 ordered-within-node 列为**非目标**，除非另开能力锁（**不由 K6 #4993 承载**——那是 Lock-2 §L2-C 的字段派生种类，非聚合模式） |
| 字段与操作权限 | 字段矩阵 + 节点操作策略 | **字段轴已达**：Lock-7 服务端强制（P4-B #4961），D-1 read 轴收口（#4979）。**操作策略轴已达**：`nodeOperationPolicy` 落地（P5 L5-A #4980），`operationPoliciesByNodeType` 对 `approval` 与 `handler` 已 populate（`approvalCapabilityRegistry.ts`） | **已达**（两轴都落地；A-2 成员栏镜像 PARTIAL，见「成员动作」行） |
| 办理/业务节点 | 有文档记载的办理节点 | P4-A 落地：贯穿所有图遍历、事务边界、版本 | **已达**（flag 后） |
| More settings | 发起人、去重、兜底、快批/批量、转发及相关设置 | 第五步已挂载（P3-B #4967），**其中一个**功能性全局策略：L6-A 模板级审批人去重档位。母锁 M7「不得渲染惰性开关」被遵守 | **部分**（1/5 族；L6-B..E 各自具名推迟） |
| 成员动作 | 动作对话框、转交/加签/退回/评论/催办等 | `commentRequired` 强制（#4983）；**前加签 placebo 已诚实移除（#4983 B-2）**；A-2 成员操作栏镜像**下调为 PARTIAL**——FE 镜像对 role 席位审批人不下发，但**服务端仍正确拒绝**（409/400）⇒ 显示缺口非权限放大；**后加签（`'after'`）运行时未落地**；未统一动作对话框语法（P5-C `NOT STARTED`） | **部分**（A-2 PARTIAL；CR-3 PARTIAL；L5-B 后加签运行时 / L5-E 推迟） |
| 版本治理 | 语料不作为我方实现的权威 | 不可变版本、比对、恢复为新草稿已存在 + 编辑器头部版本入口（P1-D） | **已达** |
| 数据闭环 | 不用作竞品缺席声明 | 持久 FWB 与附件在各自独立 flag 后；`exact_number_mapping_unavailable` 在 5 个生产站点存在并被测试断言 | **部分**（flag OFF）／**精确金额：按 M10 + §8 非目标未达** |
| 表单字段词汇 | 组件面板 | **13 种，前后端逐字一致**：`text textarea number date datetime select multi-select user attachment detail record-link date_range explanation`（K6 加的是**派单人种类**非字段类型，此行不变） | **部分** — 部门/联系人**字段类型**属 Lock-2，未起始（K6 §L2-C 落的是派单人种类，非字段类型）；**公式（L8-D）按设计推迟并带负契约**；精确金额按 M10 排除 |

### 4.1 六项超出对标基线的能力（superiority points）

母本 §9 把这六项当作「smoke rows」跑过，判定见验证报告 §2.1；此处只记能力与其边界。
现在 **派单人 union（15）+ 办理节点(handler) + 去重(dedup) + 字段词汇 + 操作策略(operation policy)** 全部在 main。
**P7 phase-B 在 fresh `origin/main` 对这六项 re-smoke = 6/6 PASS**（FWB 仍是 code 半边，功能半边 owner-only）：

| # | 能力 | 我方形态 | 边界 |
|---|---|---|---|
| 1 | **并行分支** | 并行网关 + 或签（any）首胜 + 兄弟取消；参考语料只证实线性与条件路由 | 或签 oracle `approval-wp1-any-mode.api.test.ts` 曾在零 CI 车道执行（FAIL-4），修复已随 #4984 落地（双点接线）；**phase-B 在全新 DB 复核 1 passed** |
| 2 | **dry-run 路径预览** | 路由预览 API + 子结构 + 模板级预览；画布 `dryRunConditionFormula` 接缝；真库 `realdb-routepreview` 24 passed | 保留陈旧结果与隐藏字段守卫 |
| 3 | **双画布版本对比** | `approval-version-dual-canvas` + 版本 diff + 图覆盖 + 只读摘要 | — |
| 4 | **批量驳回** | 有界并发扇出、逐行隔离、`{succeeded, failed}` 失败清单、重试失败项、必填评论闸 | 内核 spec `useApprovalBatchActions.spec.ts` 曾在零 workflow 执行（FAIL-7），**修复已随 #4984 落地**（进 `run-required-web-tests.sh` + guard，UNION 存活已核实） |
| 5 | **minimap + undo/redo** | 单一工具条（撤销/重做/缩放/适应画布）+ minimap；三视口真 Chromium 目视确认 | F4 撤销/重做启用守卫（P3-1）目前只由非必需浏览器车道覆盖 |
| 6 | **FWB（表单写回）** | 创建/更新/决策值写回多维表，持久投递、幂等、崩溃窗口、bind/GC 竞态 | **`APPROVAL_FWB_WRITEBACK_ENABLED` 默认 OFF**（要求字面量 `'true'`）；flag-OFF 冒烟证明的是 fail-closed 姿态，**不是功能**。功能半边是 P7-C，owner-only。**精确数字映射仍然不可用** |

---

## 5. 缺陷发现与修复（本程序的主要价值线）

本节记录对标程序推进中**顺带发现并修复的已发布（shipped）缺陷**——它们此前就活在 main 上，不是本程序引入的回归。

### 5.1 退回 / 后向跳转置空 —— #4965，已修，**V-3 DISCHARGED**

**缺陷**：去重级联读取**全量未过滤的历史**，因此一个经由退回或后向跳转**重新进入**的节点，可能被上一轮的同意错误自动通过。
**修复**：`to_version` 下限，作用域收窄到后向重入（手动退回 **OR** visited-path 谓词判定的后向 timeout-jump；`adminJump` 结构上只能向前）。
**V-3 闭合**（`/tmp/pr4965-v3-closure-20260818.md`，在合并后 main `3335ccc435`、该 floor 区间逐 blob 未变的隔离 worktree 上）：Mutation D（删 `jump AND backwardReentry` 臂）恰红 `:593`（`approval_c`→`approval_d` 泄漏）、Mutation A（删 `action='return'` 臂）恰红 `:399`（同泄漏形状），两条红**互不重叠** ⇒ 两个后向重入臂各自 load-bearing。CI 车道 `approval-realdb-l6a-roundscoping.yml` 在 `57a7443ede` 与 `6a67eccea1` 均 8/8 绿。

### 5.2 发布顺序导致策略丢失 —— #4966，已修
`confirmPublish` 在 `persistDraft()` 重建草稿**之后**才读策略，令本会话内的 `allowRevoke` 编辑被静默丢弃。修复：在 `persistDraft` 前快照 `buildPublishPolicy(draft)`。闸门 0 P1 / 0 P2 / 0 P3 / 0 NIT。

### 5.3 策略载体在重新发布时被销毁（L6-P1）—— #4957，已修
Lock-6 独立评审 ratify 前抽验并证实：API 设置的 `policy.autoApproval` 被编辑器发布销毁。定为 L6-A 前置修复切片。闸门 MERGE-CLEAN。

### 5.4 路由驱动字段的提权路径 —— P4-B / OD-L7-8(a)，已关
Lock-7 独立评审：路由驱动字段在任何节点都不得 `editable`——「closes a privilege-escalation path」。同轮还纠正 OD-L7-11 的机制错误（`nodeEntryEpoch` 在同轮编辑不触发 → 重新规定为一个 NEW 的 per-edit 标记）。

### 5.5 D-1：`fieldPermissions` 在五种节点类型上被静默丢弃 —— #4979，已修（read 轴按可逆默认收口）
`fieldPermissions` 在 cc / start / end / condition / parallel 节点被静默丢弃。#4979 改为**类型化 400**（覆盖 `readonly`/`hidden`/非数组形状）。
**⚠️ 这是一个可逆的公开 API 收窄，超出 OD-L7-4(a) 字面 ratify 文本**（该文本只把 400 限定在 `editable`），按 goal-set provenance 裁定：fail-closed 更安全（作者现在拿到明确错误而非无形丢配置）；这五种类型上从无模板能持久化该形状，两个方向都不破坏已存数据，reject→honor 是纯放宽零迁移。**「拒绝 vs OD-L7-4(c) 放宽」作为 read 轴永久解，仍待 owner 裁定（§7.4）**，且**与 Lock-7 D-5 read-scope 是两个不同问题（§7.6）**。

### 5.6 前加签（`'before'`）是 placebo —— 诚实性修复 #4983，**已落地**
Lock-5 §0.1：`'before'` 只是审计元数据，两种模式都把会签人放在当前节点、同一 epoch，并行区外两个单选项逐字节相同，而对话框却提供前加签/并加签的选择。**#4983 的 B-2 处置是诚实性**：把 FE 那个选项**移除而不是改标签**（「a radio whose arms cannot be told apart is a fake switch」），并把同一性钉成断言；正控在并行区内两种模式确实分叉。**节点插入式后加签（`'after'`，OD-L5-4）在 Lock-5 中未被 ratify 落地，仍推迟。**

### 5.7 办理节点的惰性控件（母锁 M7 / Lock-3 §2.2 勘误）—— #4956，已修
ledger §9 勘误：Lock-3 §2.2 曾称办理任务批量排除「falls out of §2.1 rather than needing new code」——该声明 FALSE（成员待办中心会对任何活跃待办席位加徽标/批量选中，无节点类型过滤 ⇒ 办理席位暴露惰性同意/驳回，违反 M7）。修复：P4-A / #4956 落地显式节点类型门（pending 列表 DTO `currentNodeType` + `isRowBatchSelectable` + pending 计数排除）。

### 5.8 P7 phase-A 的八个 FAIL —— **P7 phase-B 复核 = 8/8 FIXED（FAIL-0 残留其后由 #5004 DISCHARGED）**

台账承重句逐字：「All seven are evidence-integrity / a11y defects. **None is a product-logic regression.** That distinction is load-bearing and is proven per finding, not asserted.」

**P7 phase-B**（`scratchpad/p7-phaseB-evidence-20260818.md`，在 fresh `origin/main` = `6abd241925`、隔离 worktree + 全新专用 DB、real Chromium、Node 20.20.2）复核这八行：**8/8 FIXED**（7 个完全修复；FAIL-0 当时为 FIXED-with-named-residual，**该残留其后由 #5004 `6ace2e5a01` DISCHARGED，见下表**）。**re-verified 子集内零个新 FAIL**。下表「状态」列已按 phase-B 更新（其边界：PG 本地 15.17 vs CI 16，pnpm 10.33 vs CI 10.16.1，均记录为 delta；这是**子集**复核，非全 127 行矩阵重跑，见验证报告 §2.5 / V-1）。

| # | 一句话 | 修复 PR | phase-B 复核状态（fresh `origin/main`） |
|---|---|---|---|
| **FAIL-0** | 父发现：四个审批面测试制品在零个 CI workflow 中执行 | #4984 `512f0df608` + **#5004 `6ace2e5a01`** | **FIXED，残留已 DISCHARGED**：#4984 把四具名实例 + 6 套件双点接线；**#5004 安装机械枚举守卫**（`approval-ci-coverage-enumeration.test.ts`，258 断言 + `approval-ci-coverage-allowlist.ts`），跨 4 层枚举并断言每个审批 spec 被某 CI 车道/白名单收集，居必需 test 车道、追踪真实接线、非自豁免；落地时当场抓到并闭合一个真实未接线套件 `approval-pack1a-lifecycle`。复发通道机械封死 |
| FAIL-1 (P1) | `approval-inspector-keyboard.spec.ts` 在 main 上红——harness 挂载时抛异常 | #4984 | **FIXED**：real Chromium **1 passed (810ms)**；harness 导入当前 `ApprovalNodeConfigEditorApi` + 生产 CSS；`multitable-browser-verify.yml` path filter 已加宽（含 4 个 `apps/web/src/approvals/**`）——DRAFT 曾提的「#4944-源起运行时红」在 phase-B 复核为**已修** |
| FAIL-2 (P2) | V-6 焦点环对比度：19 个画布控件 13 个低于 ≥3:1 | #4981 `6488353bf8` | **FIXED**：real Chromium 重测三视口 **19 PASS / 0 FAIL / 0 NO-RING**（viewport 4.95、toolbar 族 5.17） |
| FAIL-3 (P2) | `approval-node-entry-epoch.test.ts` 在 main 上 100% 红，fixture 腐烂 | #4984 | **FIXED**：全新 `metasheet_p7b_epoch` DB（无 grant 残留）**5 passed / 1 skipped** |
| FAIL-4 (P2) | `approval-wp1-any-mode.api.test.ts` 同因同签名 | #4984 | **FIXED**：全新 `metasheet_p7b_anymode` DB **1 passed / 1 skipped** |
| FAIL-5 (P2) | 浏览器 harness 不加载生产样式表，令 CSS 断言空转 | #4981 | **FIXED**：两 harness 均 `import` 生产样式表；non-vacuous 重测 form-builder 29 ring-PASS（5.17）、inspector 25 ring-PASS（16.55） |
| FAIL-6 (P3) | `handler` 是七种节点里唯一无 per-type 强调色 | #4981 | **FIXED（fix 选了一个 shape）**：`handler` 用 `--el-color-info`，致 4/7 类型（start/end/parallel/handler）共享 info 强调色——**owner shape 裁定项**（§7.8） |
| FAIL-7 (P3) | `useApprovalBatchActions.spec.ts` 在零 workflow 执行 | #4984 | **FIXED**：进 `approval-web-guard.yml` + `run-required-web-tests.sh`；本地 4 passed；UNION 存活已核实 |

**FAIL-0 的具名残留 —— 已 DISCHARGED @ #5004（`6ace2e5a01`）**：#4984 手动做了普查（249 文件）并把四个具名实例 + 6 个此前未门控套件双点接线，但**没有安装机械枚举守卫**。**#5004（opus 闸门 MERGE-CLEAN 0 P1/0 P2）补上了它**：`approval-ci-coverage-enumeration.test.ts`（258 断言 + `approval-ci-coverage-allowlist.ts`）跨 4 层（`apps/web/tests`、`apps/web/verification`、`core-backend/tests/unit`、`.../integration`）枚举每个审批 spec/test 并断言其被某具名 CI 车道或显式注释白名单收集——闸门证实它在每层对真正未接线的 canary spec 变红、且在真实已接线文件被解除接线时变红（追踪真实 CI 接线，非静态 grep，非自豁免，居必需 test 车道）；**落地时当场抓到一个真实的未接线真库套件** `approval-pack1a-lifecycle.api.test.ts` 并两点接线（`vitest.config.ts` 排除 + 新 `approval-realdb-pack1a-lifecycle` 车道 + `EXPECT_DB` 哨兵）——是守卫有牙的证据。⇒ **FAIL-0 的复发通道机械封死；#4984 闸门 P2-1 的另一面亦随之消解。** #4984 本身有独立闸门 MD（DRAFT 的「修复测试的 PR 没被独立审」闭环缺口已消除）。

### 5.9 K1 的安全形状半边 —— #4995 两轮闸门，两个 P1 已闭合并 merged
K1 的 write-side 曾把 curated per-org 绑定的写路径开给它所约束的 principal（P1 self-service bind）——修复轮移到 `ensurePlatformAdmin`（非管理员 BIND live-probe **403**）。Round-2 抓到同类新 P1 = **harness rot**（K1 给 `ApprovalNodeConfigEditorApi` 加了 5 个必填成员却没更新 `approval-inspector-keyboard-harness.ts`，令必需 `test (20.x)` 在 type-check 步红）——正是 #4984 的编译钉设计要抓的那类，当前 head 已含修复。
**残留（owner）**：G-6 gate 文本**如所写不可满足**（`platform_member_groups.name` 全局唯一，两个同名 group 无法共存；option (a) 只能给 curation namespace 非 tenant 边界）——已诚实记为 goal-set provenance 裁定；picker 跨命名空间会返回 admin-authored 的 group 名+计数（**非成员身份**）——**已在四处诚实披露，是显示语义非权限放大**。

### 5.10 尾部切片自身也在发现缺陷（均已随合并落地）
- **#4980（P5 L5-A）**：Lock-5 §2.1 字面措辞会把策略闸放在钉钉卡片投递块**之后**（该块对 `dingtalk_approval_card_deliveries` 取 `FOR UPDATE` 并置 `card_state='acted'`）⇒ 会为一个被服务端拒绝的操作永久消耗一张活卡片。实现把闸提到卡片块**之上**，真库测试 + M10 变异坐实。另 P2-1 = `policy_denied` 的 CHECK 迁移被测试 helper 的 DDL bootstrap 静默覆盖（部署顺序风险，§7.3）。
- **#4981（P7-R2）**：新守卫的 `extractStyleBlock` 正则只扫第一个 `<style>` 块（M8：第二块可绕过全部四断言且 115/115 全绿）——已用同仓姊妹守卫的全局正则形态修正。另两项原始 ID 暴露候选修复。
- **#4983（P5-B）**：构造式实况 HTTP + 真库探针证明 A-2 FE 镜像对 role 席位审批人不下发（`nodeOperations = undefined`），而**服务端本身仍正确拒绝**（`409 APPROVAL_NODE_OPERATION_DISABLED` / `400 APPROVAL_COMMENT_REQUIRED`）⇒ UI 少显示而非权限放大；A-2 从 FULL 下调为 **PARTIAL**。Round-3 关闭了 Round-2 的两个 blocker（flaky required spec + mirror evaporation），**未把 A-2 提升为 FULL**。

---

## 6. 尾部未竟（已执行批次实现切片全部落地 + 未起草代码切片 + 合并时未闭合的闸门项）

### 6.1 实现切片：**全部落地**（曾唯一在飞行的 K6 已合并）

| PR | 切片 | 状态 | 备注 |
|---|---|---|---|
| **#4993** | **K6 — form-field contact extensions `form_field_user_manager` / `form_field_user_dept_head`（Lock-2 §L2-C）** | **LANDED @ `ffa3a5f595`**（squash merge，2026-08-18T14:58:58Z，auto-merge）；闸门 **MERGE-CLEAN — 0 P1 @ `093830c4bc`**（3 个承重守卫 mutation-proven；唯一 blocker 是 rebase-readiness，已 clean 解决） | 加两个字段派生的 manager/dept-head 派单人种类；rebase 后 exact-set 钉 **13 → 15**（union / label / order / trait 表 / 两处 fingerprint switch）；trait 表 `user_group: NO_ORG_TRAITS`（它从 create-frozen `groupMemberIds` 快照解析、不 arm org detector，给它 org trait 会重开 requester-org wedge）；两处 exact-set 测试（FE A-3 十五成员、BE trait-table 十五成员）更新加 `user_group`。合并前验证：BE tsc + web 复合 type-check（含 verification-approval）均 exit 0、BE approval 单测 857/857、FE approval 300、canvas-inspector 48/48；9 required + `approval-realdb-k6-contact` 均绿。**注意：这是 Lock-2 §L2-C，不是 Lock-1 §K6 `sequential`**（后者是聚合模式，母锁 §8 非目标，仍未落地）。 |

### 6.2 已落地、无需再动的旧 TAIL-PENDING

| 旧标记 | 现状 |
|---|---|
| **F4 / P0-B5 生产挂载** | **LANDED** #4994；F10 缺席声明 DISCHARGED（§3.2） |
| **K1 `user_group`** | **LANDED** #4995（第 13 个 union 成员） |
| **P5 #4980 / #4983（Lock-5 L5-A / L5-B 诚实半边 + L5-C/D）** | **LANDED**；R7 与 `操作权限` 标签解除；#4983 base 已 retarget 到 main（旧「必需检查不跑」已解除） |
| **P7-R1 #4984 / P7-R2 #4981** | **LANDED**；八个 FAIL 修复全部在 main（phase-B 复核 8/8 FIXED，§5.8） |
| **V-3（#4965 NOT-CLEAR-then-merged）** | **DISCHARGED**（§5.1） |
| **K6 #4993（曾唯一在飞行实现切片）** | **LANDED @ `ffa3a5f595`**；派单人 union 15/15；对标派单人种类翻「已达」（§4） |
| **#5004 residual-hardening（FAIL-0 枚举守卫 + I3 判别性反例 + pack1a 接线）** | **LANDED @ `6ace2e5a01`**（opus 闸门 MERGE-CLEAN 0 P1/0 P2）；DISCHARGE 了 FAIL-0 枚举守卫残留（§5.8）与可执行判别性反例债（验证报告 V-12）；捎带闭合一个真实未接线套件 |

### 6.3 未起草 / 未开始的切片（各带缺席证据）

| 切片 | 缺席证据（`ffa3a5f595` 上机械核实） | 它解除什么 |
|---|---|---|
| **K6 `sequential` 审批模式（Lock-1 §K6）** | BE 与 FE `ApprovalMode` 均 4 成员，无 `sequential` | 聚合表「顺序」一行。**母锁 §8 已把 ordered-within-node 列为非目标，除非另开能力锁** |
| **Lock-2 其余实现** | ledger §2 `LOCK RATIFIED — implementation NOT STARTED`；**§L2-C 已由 K6 #4993 (`ffa3a5f595`) 落地**，其余未起始 | 字段派生部门路由、部门/联系人**字段类型** |
| **P3-A（Lock-4 缺失语义）** | ledger §2 `NOT DRAFTED` | 自动通过/拒绝、扩展空派单人兜底、离职兜底、`auto_reject` |
| **P5-C 共享对话框 / 详情表格 / 中心主从（成员动作对话框语法统一）** | ledger §2 `NOT STARTED` | 成员动作对话框语法统一 |
| **L5-B 后加签运行时（OD-L5-4/5）／L5-E（`signaturePolicy` 等）** | Lock-5 §1.5：`'after'` 未落地、`signaturePolicy` 声明即惰性 | 后加签节点插入 + 手写签名 owner 切片 |
| **L6-B / L6-C / L6-D / L6-E** | Lock-6 各自具名阻塞点 | 各自切片；**L6-E 归属孤儿见 §7.8** |
| **L8-D `formula`** | Lock-8 按设计推迟并带负契约（该成员根本不进入任何 union） | 需确定性求值 + 依赖锁 |

### 6.4 合并时未记录闭合的闸门项（**owner / 后续版本须解决**，非本 FINAL 可解）

| # | 事项 | 说明 |
|---|---|---|
| **D-2** | #4974（P6-explanation）带着 **2 个未闭合 P2** 合并（P2-1：`TemplateAuthoringView.vue` 4 个注册点无守卫，N-1 普查够不到活的编辑面板；P2-2：`explanation` 经 Lock-7 handler 字段写入门变成 `form_snapshot` 的键，与 A-1「absent from formSnapshot」冲突） | 来源无闭合记录 |
| **D-3（订正）** | #4946 / #4948 闸门均 CHANGES-REQUESTED，原始合并时未记录闭合 | **requalify 已补跑**（20260819，reviewer-local，`/private/tmp/pr4948-requal-20260819.md`，未入库）：两 PR 各自的 gate-fix-round 请求逐条对照 **main @ `d8ac22c989`**（`b296b4d6eb`/`9f50cd46a3` 均为其祖先）核实，**全部 requested changes ADDRESSED-ON-MAIN**（#4948 1P1+6P2 共 7/7；#4946 2P2 + 一处已撤回的失实声明）——两个判定均为 **REQUALIFIED-CLEAN**（各自留一条已披露的 P3 残留：#4948 P1-01 只有 CSS 源钉、无 CI 接线的真浏览器 harness；#4946 P3-2「dud 全文评论 tab」被有意延后，不属必需变更集）。**但这不是合入时的闭合记录**：`gh api …/pulls/4946/reviews`、`…/pulls/4948/reviews` 仍为 0——两 PR 在合入当时确实**零记录评审**，Codex 指出的形状事实原样成立；requalify 只证明代码今天立得住，不能倒填一个历史上不存在的评审记录。不得写成「合入时闸门 CLEAR」。 |
| **D-4** | #4939 / #4942 闸门 REQUEST-CHANGES，闸门 MD 内未执行修复轮（#4944 的在 ledger §4 有记录，#4939/#4942 没有） | 需补齐 #4939 / #4942 的修复轮证据 |
| **D-6** | Lock-7 独立评审 P2 计数不一致：评审 MD 记 3 个 P2，ledger §4 记「2 P2」 | 确认第三个 P2 是被降级还是漏记 |
| **D-7** | Lock-8 owner 块记「Independent review: (none recorded)」——九锁唯一无 ratify 前独立评审 | owner 裁：是否补一轮 |
| **#4984 P2-1 / FAIL-0 枚举守卫** | 6 个新接线真库套件缺自身 anti-skip-green 哨兵；排除清单无机械枚举守卫 | ✅ **DISCHARGED @ #5004 `6ace2e5a01`**（机械枚举守卫 `approval-ci-coverage-enumeration.test.ts` 落地，闸门证实有牙且当场抓到真实未接线套件 `approval-pack1a-lifecycle`，§5.8） |
| **#4995 残留** | G-6 gate 文本不可满足（owner 裁）；picker 跨命名空间元数据（已披露） | §5.9 |
| **D-9** | 已合并 PR 的合并后 squash SHA 基本都未被重新过闸（闸门绑 pre-merge / requalified head） | 形状事实，不得塌缩成「闸门 CLEAR，已合并」 |
| **D-10（二次订正）** | **原始 user-ID 渲染残留 — class 未闭合**。**member-ACTION 五处已修，落于 #5010（`44e6fe33ea`）**：pane 标签（`ApprovalCenterDetailPane.vue` `assigneeLabel()`）、减签选项（`ApprovalDetailView.vue` `reducibleAssignees`）、加签 chip（`ApprovalDetailView.vue` `onAddSignUserSelected()` + chip 模板回退——本次订正轮在当前 head `62dbc69c76` 机械核实：`:731` 现为 `{{ addSignUserLabels[uid] \|\| 成员 ${chipIndex+1} }}`，`:1975` 起 `onAddSignUserSelected` 只在 `option.name.trim()` 非空时才写入 label，不再回退 `option.id`，这正是 D-10 上一版所记的两处旧址）、picker 下拉（`ApprovalUserPicker.vue` `optionLabel()`）、节点摘要（`assigneeSource.ts` `nodeAssigneeSourceSummary`）。**但 raw-user-id-render 这一整类没有随之闭合**：一轮独立复核（转述；本次订正轮未见其逐字原文，无法署名或标注轮次/日期）在 #5010 的 gate 范围**之外**又发现更多面向查看者的残留点，本次订正轮已在当前 head（`62dbc69c76`）逐处机械核实其仍存在——`apps/web/src/views/approval/TemplateDetailView.vue:140`（`{{ visibilityScope.ids.join(', ') }}`，模板可见范围 ID；任何具备 `approvals:read` 的查看者可见，`canManageTemplates` 只门控其后的编辑按钮，不门控这行渲染本身）与 `:340`（`{{ (node.config as any).assigneeIds?.join(', ') }}`，节点级派单人 ID——同一文件里独立于 #5010 已修的 `assigneeSource.ts` 摘要的另一条代码路径）；`apps/web/src/views/approval/ApprovalNewView.vue:956`（`choiceOptionLabel()` 的自选下拉 `option.name?.trim() \|\| option.id`）。**外加一处 #5010 自身引入的可用性/安全残留**：减签 / 加签 / picker 三处的回退现在统一是「成员 N」序数——#5010 提交信息自陈 repo 内没有任何生产者会写 `assigneeName`（grep 已确认），所以这不是边缘情形而是**常规路径**：生产环境里这三处标签**永远**是序数，管理员无法仅凭标签判断「成员 3」对应哪个真实用户，存在**撤错审批人**的风险。#5010 提交信息称「the raw-user-id-render class...is closed across every surface found by the two-round adversarial gate」——这话在**该轮 gate 已找到的范围内**成立，但 gate 范围不等于这一类的全部范围，上面三处新址正是反例。后续切片（成员显示身份解析器 + 残留处置）**进行中**。**不得写「class closed」**。 | 需要新的修复 PR（**PART FIXED**：member-ACTION 五处已随 #5010 `44e6fe33ea` 闭合；class 本身仍 OPEN——3 处新址 + 「成员 N」身份不可辨识残留，后续切片 IN PROGRESS）；这是**代码工作，不是 owner 专属项** |

### 6.5 OD 勘误候选（汇总，逐条见 §7.4）

| 勘误候选 | 出处 | 当前状态 |
|---|---|---|
| **Lock-3 §2.2**（批量/秒批排除） | ledger §9 勘误表 | **已应用**（声明为 FALSE，改由 P4-A #4956 显式节点类型门强制） |
| **OD-L4-10(a)** 边界（后向重入） | ledger §4 | 已裁定忠于 OD 意图，goal-set provenance，**可逆**（机制 = `to_version` 下限）；仍列为 owner 勘误候选 |
| **Lock-1 §K4** 引用不精确 | ledger §4（Lock-2 ratify 行） | 仅引用不精确，姿态仍有约束力 |
| **OD-L7-4(a)** read 轴 | #4979 P3-3 | 可逆的公开 API 收窄，超出字面 ratify 文本；「拒绝 vs OD-L7-4(c) 放宽」永久解待 owner |
| **G-6（K1 multi-corp negative）** | #4995 闸门 | **gate 文本如所写不可满足**（全局唯一名 + option (a) 无 tenant 边界）——待 owner 记为 UNSATISFIABLE-UNDER-(a) |
| **OD-L5-4（后加签 `'after'`）** | Lock-5 §0.1 / C-4 | 语料语义 MISLABEL 已由 #4983 诚实化（移除 placebo 前加签）；`'after'` 运行时形状仍待具名切片 |
| **验收母本 I14 行措辞陈旧** | P7 phase-A §5 | 该行说「readonly/editable *not enforced until Lock-7*」，而 Lock-7 已落地（#4961）；**需 owner 重新措辞（ledger 规则 3），不由代理给 pass/fail** |

---

## 7. OWNER 事项（全部集中于此）

> 以下每一条都**只能由 owner 完成**。代码代理不执行其中任何一条，本程序也没有执行过任何一条。

### 7.1 租户 UAT 与分级启用（母锁 §P7 / 母本 §10）

顺序被锁定（母锁 §P7 + ledger §3「Flag order」）：
1. **Canvas V2** —— 在精确部署的 merged-main SHA 上重跑 `approval-canvas-data-closure-owner-handoff-20260808.md` 的 **S1–S12**，加 P0 精确插槽表单场景与 P1 来源/阈值场景。**前置**：owner 带外记录 Canvas 相关私有发布前置条件已闭合。
2. **Durable delivery + FWB** —— 仅在写回 UAT 记录了两个必需 flag（`AUTOMATION_DURABLE_DELIVERY_ENABLED` 与 `APPROVAL_FWB_WRITEBACK_ENABLED`）之后，**不得从 Canvas UAT 推断**（独立记录部署 SHA、flag 窗口、证据、观察、回滚）。
3. **Attachments** —— 仅在附件 UAT 之后。

**P7-E 分级 flag 启用 + 回滚证据**：每个能力族一次，各自独立回滚。

### 7.2 完成标签签署

| Label | 当前值 | 所缺 |
|---|---|---|
| CORE-PARITY | **NO** | P0-P5 实现（P0 生产挂载已达；操作策略轴已达；派单人 union 15/15、K6 §L2-C 已落地；**剩成员动作对话框统一 P5-C + Canvas 租户 UAT**）+ 精确 merged-main 验证 + 浏览器/a11y + **owner 显式签署** |
| DATA-CLOSURE | **NO** | 已批准的 P6 范围 + merged main 上精确 DATA 矩阵 + FWB 与附件租户 UAT + **owner 显式签署** |
| PRODUCT-FINAL | **NO** | 上述两标签 + 分级发布/回滚证据 + 已接受的残留项 + **owner 显式签署** |

### 7.3 DDL 部署顺序（**风险项，必须在部署前决定**）

四个已合并迁移（§3.3）的**生产应用属于 owner 门控的平台 DDL 治理**。承重风险与完整加载序、失败模式、部署前只读检查、回滚姿态，见**验证报告附录「DDL 部署序 runbook（owner/ops，授权 nothing）」**（primary-source 逐字核实四个迁移文件名）。要点：
- **#4980 `zzzz20260818090000_add_policy_denied_action_to_approval_records.ts`**：CHECK 在测试里零承重（被 helper DDL bootstrap 覆盖）；**若迁移落后于镜像，一次被拒操作返回 500 而非 409** ⇒ **P5 部署顺序：迁移必须先于镜像**。
- 其余三个（#4956 / #4961 / #4995）按平台 DDL 治理常规先于镜像；四个都只进不退（forward-only）。
`zzzz` 排序陷阱：新列若落在 `zzzz` 表上，迁移文件名也必须 `zzzz` 前缀——四个此处都正确 `zzzz` 前缀且自洽。

### 7.4 OD 勘误候选裁定
见 §6.5 表。Lock-3 §2.2 **已应用**；待裁：OD-L4-10(a) 后向重入边界、Lock-1 §K4 引用不精确、**OD-L7-4(a) read 轴「拒绝 vs OD-L7-4(c) 放宽」永久解**、**G-6 记为 UNSATISFIABLE-UNDER-(a)**、**OD-L5-4 后加签 `'after'` 运行时形状**、验收母本 **I14 行重新措辞**。

### 7.5 OD-L8-7(a) 生产模板语料扫描（**部署前置条件，不是合并阻断项**）

`number` 字段 props allowlist 强制是**服务端的**、不受 flag 门控、不是 opt-in——一旦部署就校验每次 `number` 字段的 publish/restore/clone。OD-L8-7(a) 要求扫描「shipped presets **and a real template corpus**」是**两个**组件：
1. **组件 1/2 已发布预设 / 仓内源扫描：已完成并被闸门独立复核**（`commonTemplatePresets.ts` / `numberFieldProps.ts` / `lineDerivation.ts` 中每个 `number` 字段 props 键恰为 `{min,max,step,precision,derivedFrom}`）。
2. **组件 2/2 真实生产模板语料扫描：未执行，代码代理不可执行**（无界、无法访问）。**这一半是本条 owner 前置条件的实质内容；组件 1 不构成对它的任何覆盖。**

机制已被变异证实（闸门 Mutation 4）：从 allowlist 去掉 `derivedFrom` 会同时打红普查精确集合 / C-2 明细列发布 / `restoreTemplateVersion` 重校验测试——即携带 allowlist 之外 props 键的**存量生产 `number` 字段在部署后下次 publish/restore 都会被拒绝**。
> owner 部署前二选一：(a) 跑真实模板语料扫描并确认/扩展 allowlist；或 (b) 明确接受 allowlist 之外的生产 `number` 字段会在下次 publish/restore 被拒绝。**两者都未发生。**

### 7.6 Lock-7 D-5 read-scope（**独立的 OPEN owner 问题**）
Lock-7 §2.7 把 D-5 read-scope 留作 OPEN 的 owner 问题；P4-B 闸门补充 `getFormFieldRevisions` **没有 HTTP 调用者**（不可达 ⇒ D-5 read-scope 诚实未决）。**⚠️ 与 §7.4 里 #4979 的 P3-3 是两个不同问题，不得合并**（P3-3 = 五种非写入型节点上 `readonly`/`hidden` 该拒绝还是放宽；D-5 = 字段修订**读**面本身范围）。

### 7.7 分支保护：审批车道是否纳入必需检查
当前必需检查 **9 条**（实测，验证报告 §4.1）；`strict=true`、`enforce_admins=true`。**审批线自己的证据车道全部不在其中**（五个 `approval-realdb-*`、`approval-browser-verify`、`approval-web-guard`）。`approval-browser-verify.yml` 头注释：「NOT a required check yet: per delta §7.1 item 8 the branch-protection addition is an explicit OWNER step before the F4 merge …」。⇒ **owner 决策：是否把这些车道加入分支保护**（F4 已合并，此 owner 步仍未执行；F4 P3-1 撤销/重做守卫因此只由非必需车道覆盖）。

### 7.8 其余待裁项

| # | 事项 | 出处 |
|---|---|---|
| 1 | **FAIL-6 裁定**：`handler` per-type 强调色——接受还是关闭（#4981 已按「关闭」实现并落地） | P7 phase-A §13 |
| 2 | **L6-E 归属孤儿**：Lock-6 OD-L6-8(a) 把 L6-E 移交 Lock-5，但 Lock-5 文件里 `L6-E` 零命中 | #4980 闸门 |
| 3 | **#4948 P3-01**：默认开启且无 flag / 无回滚杆就发布，是否可接受 | UI-7 闸门 |
| 4 | **#4952 P3-4**：`mode:'multi'` 无上界——是否需 owner 设上限 | K2 闸门 |
| 5 | **Lock-8 无 ratify 前独立评审**（九锁唯一）——是否补一轮 | Lock-8 owner 块 |
| 6 | **P1-D 的 P2-3**：`parallel` / `start` / `end` 三种类型共用 `--el-color-info`，无 ratify 条款要求六色互异 | ledger §4 |
| 7 | **验收母本 §7「无嵌套卡片」判据不可机械判定**——需 owner 给卡片级定义 | P7 phase-A BLOCKED-ENV-8 |
| 8 | **私有发布前置条件**带外闭合记录 | 母锁 §0.2 / 母本 §2 |
| 9 | **每个 Lock-0..8 与每个阶段闸门自身的 owner 决策仍各自独立保留**——母锁 §9 ratify 不授予其中任何一个 | 母锁 §9 |

---

## 8. 本报告自身的边界

- 本报告是 FINAL 而非完成声明。它**不 ratify、不授权、不启用**任何东西。
- **已执行/已 ratify 批次（45 个 PR，见 §0 锚点表「已合并审批切片」行）内的实现切片全部落地**（K6 #4993 = `ffa3a5f595` 为最后一个能力切片；#5004 `6ace2e5a01` 为 test-only residual-hardening）；**该批次内无一个在飞行的实现切片，无未 discharge 的可执行硬化项**。**⚠️ 这不等于「剩余项全部 owner 专属」——先前版本的这句话与 §6.3 / §6.5 / §7.2 自相矛盾，已订正。** 完整 CORE-PARITY 仍需要**尚未开发的代码切片**，至少包括（逐条缺席证据见 §6.3，非穷举列表）：
  - **P5-C**（成员动作对话框语法统一，`NOT STARTED`）
  - **P3-A**（Lock-4 自动通过/拒绝、扩展空派单人兜底、离职兜底、`auto_reject` 等缺失语义，`NOT DRAFTED`）
  - **Lock-2 其余实现**（字段派生部门路由、部门/联系人字段类型；§L2-C 已由 K6 落地，其余 `NOT STARTED`）
  - **L5-B 后加签（`'after'`）运行时**（OD-L5-4/5，节点插入式后加签仍推迟）
  - **原始 user-ID 渲染残留（class 未闭合）**（§6.4 D-10；member-ACTION 五处已随 **#5010** `44e6fe33ea` 闭合——pane 标签 / 减签 / 加签 chip / picker 下拉 / 节点摘要；本次订正轮在当前 head `62dbc69c76` 机械核实 class 内仍有 **3 处新址**（`TemplateDetailView.vue:140`/`:340`、`ApprovalNewView.vue:956`）+ 一处 #5010 自身引入的「成员 N」身份不可辨识残留；促成新址发现的一轮独立复核为转述，本次订正轮未见其逐字原文/轮次/日期；与 §0/§5.10 中已由 #4981 修复的三个候选不是同一处）

  **上述五项都是代码工作，不是 owner 专属项。** owner 专属项单独集中于第 7 节，两者不得混为一谈。
- 本 FINAL 新做的机械核实（均已在正文标注出处）：尾部六切片的合并 SHA 与闸门判定；派单人/字段/`ApprovalMode`/`nodeOperationPolicy` 的 union 与 registry 实测；F10 挂载与必需 job 收集；四个迁移枚举；run-list / vitest.config UNION 存活；V-3 闭合证据引用。
- 本报告**不记录**任何私有发布前置条件的车道标识、状态、实现细节或私有证据（母锁 §0.2 披露纪律）。
