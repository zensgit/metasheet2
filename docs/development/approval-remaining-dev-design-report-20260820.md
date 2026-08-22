# 审批 / 流程 —— 剩余开发轮 设计报告（2026-08-19 → 2026-08-20）

**Status:** DESIGN RECORD — 本文档**不批准（ratify）任何东西、不授权任何运行时、不开启任何开关、不签署任何完成标签**。
它是对「2026-08-18 交付之后这一轮剩余开发」的设计记录：记录本轮实现了哪些已 ratify 的契约、设计上做了哪些取舍、
哪些方案被否决因而不应被重新提出、以及哪些工作仍然停在设计（而非实现）阶段。任何读者若从本文读出「可以上线 /
可以开开关 / 可以宣告对标完成」，那是误读——本文明确不承载那三件事（见 §8）。

**exact-main（重锚后）:** `5feca2291b7405bc6be8160cab916ba80f7f9df6`
（`feat(approval): node-level required field tier (Lock-7b) (#5026)`，2026-08-20T07:06:10Z；仓库非 shallow，`git rev-parse origin/main` 亲核）

**freshness base（本 docs PR 的分支基点）:** `c473a079b5ff6389b98f4919bb88607a0baa913b`
（`git rev-parse origin/main` 于建支时亲取；仓库非 shallow）

🆕 **2026-08-21 freshness pass —— 三件落地物迟于本文定稿，逐条记在 §9。本段只做锚点分层，不改本文任何既有句子的 SHA 绑定。**

| 层 | SHA | 含义 |
|---|---|---|
| 读取基线 | `6cca7ec0ed97732e05723f4c613557087395d022` | 本文绝大多数 `[源读]` 锚点与全部验证执行所依据的 SHA |
| **重锚 head（= exact-main）** | `5feca2291b7405bc6be8160cab916ba80f7f9df6` | **正文 §0–§8 里每一处 `exact-main` 仍然、且仅仅指这一个 SHA**（含 §7.1 / AC-10 的阻塞理由与 66/67 分母论证）。freshness pass **没有**重绑这个词 |
| PG15-alpine 生产臂 run SHA | `13506666dae30dbeee1fb145392ff7ecfeb3e093` | **仅** §9.3 的数字绑它。本文此前从未出现过这个 SHA |
| **freshness base** | `c473a079b5ff6389b98f4919bb88607a0baa913b` | 本 PR 的分支基点。§9.1 / §9.2 的两条声明绑它 |

⚠️ **术语不变更。** freshness base **不是**一个新的 exact-main：本文**没有**在 `c473a079b5` 上重读任何 `[源读]` 锚点，
**也没有**在它上面重跑任何一行验证。**§9 之外的任何句子都不得被读成「已在 `c473a079b5` 上复验」。**

**freshness 增量窗口（机械口径）：** `git log --first-parent 5feca2291b..c473a079b5` = **14 个 first-parent 提交**，
逐个具名：**审批相关 4 个**（#5033 `c5a4a94f7f`、#5039 `13506666da`（staging 迁移处置文档）、#5040 `627945523b`、#5043 `545b3cadd1`）、
multitable **7 个**（#5032 / #5036 / #5037 / #5038 / #5042 / #5045 / #5048）、attendance 与 ops **3 个**（#5041 / #5046 / #5047）。
⚠️ **本文开头的原窗口（`d8ac22c989..5feca2291b` = 23 提交 / 审批车道 11 个）不改** —— 那是本轮的窗口，在它自己的 SHA 上仍然逐字为真。

⚠️ **两个 SHA，必须分开读 —— 本文不做整体性替换。**
本文绝大多数 `[源读]` 锚点（§2 的 file:line 表、§5.6 的 FAIL 锚点、§8.2 的 flag 默认值）与全部验证执行、
以及 §7.4 的 PG14↔PG16 双臂实验，**都是在 `6cca7ec0ed97732e05723f4c613557087395d022` 上读取 / 执行的**，
本次重锚**没有**把它们重跑一遍。两个 SHA 之间的差量**恰好是两个 first-parent 提交**，逐个具名：
**`5ab052449b`（#5025，Lock-7b 锁文 + 两条台账行）** 与 **`5feca2291b`（#5026，Lock-7b 实现）**。
凡本次重锚**亲自重核过**的条目均已就地标注；未标注者一律仍绑 `6cca7ec0ed`，**不得当作已在新 head 上复验**。

**术语（本文自用，避免一个词指两个 SHA）：**
- **exact-main** = **重锚后的 head `5feca2291b`**，仅此一义。
- **读取基线** = **`6cca7ec0ed`**，即本文绝大多数 `[源读]` 锚点与全部验证执行所依据的那个 SHA。
- ⚠️ **例外：逐字引用块内的 `exact-main` 一律照录不改**（那是被引文档自己的用词，指它自己的 `6cca7ec0ed`），
  例如 §7.4 引的 V-14 裁决 §5。**引文内外不是同一个词义，读时须留意 blockquote 边界。**

**本次重锚亲自执行 / 亲自机械重核过的条目（穷举，其余一律未重跑）** `[执行]`：
1. `git rev-parse origin/main` → `5feca2291b…`；`git log --first-parent` 窗口 = 23 提交 / 审批车道 11 个；
2. #5025 / #5026 的 `state` / `mergedAt` / `headRefOid` / diffstat，及三对 `merge-base --is-ancestor`；
3. 两个新合并的单亲（squash）性质；`git diff 5ab052449b 29b28b1f50 -- package.json pnpm-lock.yaml` = 空；
4. `approval-*` 真库套件计数 66 @ `6cca7ec0ed` → **67** @ `5feca2291b`，并具名新增文件；
5. `5feca2291b` 上普查制品内 `ts.createSourceFile` 的存在与残留清单 (a)–(j)；
6. `5feca2291b` 上执行台账第 114 行的文本（漂移，§7.1）；
7. Sealed-export 三条 check-run 在 `c3a0a9441a` / `a96ab8ae2b` 上的 `failure`、在 `29b28b1f50` 上的**零 check-run**；
8. **在 `5feca2291b` 的独立 detached worktree 内实跑** `sealed-export-package-provenance.test.cjs` → `OK` / exit 0；
9. `approval-realdb-required-at-node.yml` 的 `image: postgres:16` / `EXPECT_DB: '1'` / 硬编码 `DATABASE_URL`；
10. `sealed-export-s5-sqlserver.yml` 的 path-filter 含 `pnpm-lock.yaml`（L46）与 `sealed-export-package-provenance.cjs` 的 `id: 'pnpmLock'` 钉点。

**执行日期:** 2026-08-20（原始观测 ≤ 2026-08-20 12:33 +0800；本次重锚的补充观测 ≤ 2026-08-20 15:20 +0800）

**本轮窗口（机械界定，重锚后）:** `git log --first-parent d8ac22c9891253d09212861304f81ec600abb0a6..5feca2291b`
= **23 个 first-parent 提交**，其中**审批车道 11 个**（#5010 / #5009 / #5016 / #5019 / #5024 / #5021 / #5022 / #5023 / #5030
/ **#5025** / **#5026**），其余 12 个属其他线（ops / attendance / multitable O-2 / CI），逐个具名排除以证明窗口是**读闭合的**而非抽样的。
窗口下界 `d8ac22c989` = #4997，即 2026-08-18 两份交付报告落地的那一次合并。

---

## 0. 证据记法与本文的诚实约束

### 0.1 证据等级标注

本文每条实质断言都带一个来源标记，**不混用**：

| 标记 | 含义 |
|---|---|
| `[执行]` | 由一次真实执行支撑（真库测试 / CI check-run / 变异跑 / 探针） |
| `[源读]` | 由**读取基线 `6cca7ec0ed`** 上的源码或文档文本支撑（除非就地另行标注为重锚复核），**没有**执行支撑 |
| `[制品]` | 引自某份闸门 / 复核 / 收官制品的原文（制品自身 head-scoped） |
| `[未核]` | 本文作者未能核实，按原样记录并标注 |

`[源读]` 与 `[执行]` 的区别在本文中是**结论性**的，不是修辞性的：本轮唯一的 FAIL（§5.6）就是一条纯 `[源读]` 结论，
而它之所以是缺陷，恰恰因为**仓内不存在任何会为它变红的测试**。

### 0.2 合并机制 —— 任何「闸门覆盖了落地物」的句子都必须先过这一关

**本轮十一个审批合并全部是 squash 合并**（`git rev-list --parents -n1 <merge>` 恒返回两个词 ⇒ 单亲；
#5025 `5ab052449b` 与 #5026 `5feca2291b` 于本次重锚逐条复核 `[执行]`）。因此**闸门裁决 SHA
与落地 SHA 之间的祖先关系在 SHA 层面不可建立**，逐对机械核实如下 `[执行]`：

```
5021 verdict 1dadde2ba6 → merge da0d1ca79e : NOT-ancestor
5022 verdict 5bd2e20a55 → merge 5df20d769b : NOT-ancestor
5023 verdict 4944bdee5f → merge 0f70783a2c : NOT-ancestor
5023 head    efaa553d71 → merge 0f70783a2c : NOT-ancestor
5030 verdict 90725bbe37 → merge 2e2683cda9 : NOT-ancestor
5030 head    563fbb2772 → merge 2e2683cda9 : NOT-ancestor
5024 verdict 0e0ea65118 → merge a0edbe39a4 : NOT-ancestor
5026 verdict a96ab8ae2b → merge 5feca2291b : NOT-ancestor      ← 本次重锚补入
5026 head    29b28b1f50 → merge 5feca2291b : NOT-ancestor      ← 本次重锚补入
5025 head    207162573e → merge 5ab052449b : NOT-ancestor      ← 本次重锚补入
```

⇒ 本文一律采用如下诚实句式：**「裁决绑 pre-squash head X，以 squash commit Y 落地；SHA 层面无法建立祖先关系」**。
本文任何地方都没有写「闸门覆盖了被合入的提交」。这一形状同时**复现**了 2026-08-18 报告 §6.4 D-9 记的那件事
（「已合并 PR 的合并后 squash SHA 基本都未被重新过闸」）——本轮十一个合并无一例外。

🔴 **#5026 另有一条比 squash 更重的事实，必须与上表并读：没有任何一份闸门裁决绑定实际落地的那个 head。**
requalification #4 的 **MERGE-CLEAN 绑 `a96ab8ae2b`**；该分支随后**又前进了一个提交**到 **`29b28b1f50`**
（`fix(approval): remove @vue/compiler-sfc devDependency, restore sealed-export pin`），`5feca2291b` 是它的 squash。
机械核实 `[执行]`：`git merge-base --is-ancestor a96ab8ae2b 29b28b1f50` = **ANCESTOR**（分支内，**不是**对合并提交的祖先声明）；
`git diff --stat a96ab8ae2b 29b28b1f50` = **3 文件 / +94 −39**。
⇒ 本文对 #5026 的诚实句式是：**裁决绑 pre-squash head `a96ab8ae2b`；其后的 `29b28b1f50` 未被任何闸门审阅过；
最终以 squash commit `5feca2291b` 落地。** 那一个未过闸的提交做了什么、为什么它是本轮最值得记的一条治理事故，见 **§3.8.2**。

唯一的例外性证据是 **#5023 的内容等价证明** `[执行]`：其裁决 SHA `4944bdee5f` 是 rebase **前**的 head，落地 head 是
`efaa553d71`；`git diff a0edbe39a4 4944bdee5f` 与 `git diff 5df20d769b efaa553d71` 均为 2465 行，**新增行多重集完全相同
（2121 = 2121，`diff` 空）、删除行多重集完全相同**，差异只在 hunk 偏移与 #5021/#5022 引入的上下文行。这证明的是
**内容等价**，不是祖先关系——两者不可互换。

### 0.3 制品存放位置（引用时必须一并声明）

- 各闸门 / 复核 MD 位于 `/tmp`，**均 head-scoped**，非仓内记录。
- 验证收官 `w4-verification-closeout-20260820.md`（472 行 / 61,173 字节）及其四份车道文件 `w4-closeout-L{1,2,3,4}-20260820.md`
  位于本会话 scratchpad，`git ls-tree` 于 `6cca7ec0ed` 确认**不在仓内**。
- `approval-comments-decision.md`、`fwb-enablement-runbook.md` 同样**仅在 scratchpad**，非仓内记录。
- **本文档本身也只在 scratchpad**，不开 PR，由 owner 先行审阅。

### 0.4 一条必须随行的处理约束

#5024 的闸门 MD 自带处理约束：其 §Residual 与 mutation-B 结果**不得**出现在任何公开面（记录类别
`feedback_no_public_vuln_disclosure_on_prs`；该文件另记 FINDING-1(P3)：公开 PR 面在 main 尚未修复时点名了修复前的缺口）。
**本文不复现该文件的 §Residual 与 mutation-B 任何内容。**

---

## 1. 本轮设计权威

### 1.1 provenance 分层 —— 管住两份锁文的那一条约束

**两份锁文都不是 owner 亲署的批准。** 两者都在 §4 记录 **session-recorded goal-set provenance**，并自声明「在实现落地前可撤回」。

Lock-4 §4 原文 `[源读]`（`docs/development/approval-lock4-flow-policies-20260817.md` @ `6cca7ec0ed`）：

```
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-17): complete the approval-parity program
  per its documents, executing recorded recommendations. Recorded by the executing session with this
  provenance; reversible on owner request before implementation lands. …
Runtime authorization: NONE — ratifying this document authorizes design only. Each F4-family slice
  still needs its own PR, required checks, adversarial gate, and ledger row. No flag, no UAT, no
  deployment, and no fifth wizard step.
```

Lock-7b §4 原文 `[制品]`（`/tmp/l7b-branch.md:495-546`，与两份本地副本逐字节相同）：

```
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-20,「这个对标完善」— the owner directed
  completion of the node-level required-field parity item, including the 必填 × hidden ruling), executing
  the recorded recommendations; recorded by the executing session with this provenance; reversible before
  implementation lands.
…
Runtime authorization: NONE. Design authority only. No runtime code, no feature flag, no tenant UAT, no
  deployment, and no completion label is authorized by this document.
```

⇒ **两份锁文均不得被渲染为 owner 署名批准。** 这一约束与 2026-08-18 开发报告 §1.3 一致（「锁文只引用 goal-set provenance，
不伪造 owner 署名」），其先例是 2026-08-12 的那次 P1 与撤回（把 owner 的建议模板文字写进锁文当作「owner instructed verbatim」
构成自证循环）。本文在这里说明它，而不是只放到边界章，是因为它决定了**下面所有「已 ratify 的契约」这句话的强度**。

### 1.2 Lock-4 —— RATIFIED 且在 main 上

- 文件：`docs/development/approval-lock4-flow-policies-20260817.md`，**在 main 上** `[源读]`。
- 头部：`**Status:** RATIFIED (2026-08-17 — §4 record; design authorization only, per-family slices still gated)`。
- 基线：`origin/main@075d078eb42dc133b1164902c95f5775863bd8ec`。
- §P3-A 绑定作用域原文：*"preserve the shipped merge flags and ratify only the missing Lock-4 semantics …
  Do not rebuild `mergeWithRequester`, `mergeAdjacentApprover`, or `dedupeHistoricalApprover`."*

**本轮实现所援引的 OD 支臂（逐字引自 §4）：**

| OD | 选定支臂原文 | 本轮 |
|---|---|---|
| OD-L4-1 (a) | *"`approvalType` config field on type:'approval' · (b) new node type(s) (three executor walks + totalSteps + parallel guards = Lock-3 blast radius)"* | #5023 |
| OD-L4-2 (a) | *"auto_approve only in v1, auto_reject deferred to its own owner decision"*；Decisions-recorded 行补：*"(parity residual tracked: the 审批类型 radio ships 人工/自动通过 only — no inert third option)"* | #5023（延期被遵守） |
| OD-L4-3 (a) | *"'designated' only, 转审批管理员 expressed by designating the approval-admin role · …(c) permission-code reverse enumeration [rejected §F4-B: no shipped reverse query, three grant channels, wildcard holders, no org scoping]"* | #5021 |
| OD-L4-4 (a) | *"node-level enum inside the existing autoApprovalPolicy override precedence · (b) template-level only · (c) a new, separately-shaped precedence rule [rejected §F4-C: two precedence rules for one composing family]"* | #5023 |
| OD-L4-5 (a) | *"seat not produced, emptyAssigneePolicy governs · (b) fail create 422 · (c) fall back to self_approve [rejected §F4-C: hands the approval to the person the policy exists to exclude]"* | #5023 |
| OD-L4-8 (a) | *"directory deprovision `user_changed` effect, with the mark_inactive-only, globallyClear-only and DIRECTORY_DEPROVISION_ENABLED limits disclosed in the authoring copy · (b) local users.is_active=false (an ops suspension, not a departure)"* | #5022 |
| OD-L4-9 (a) | *"out-of-band on the departure signal, modelled on the SLA transfer effect, resolver stays pure · (b) at dispatch via a live read [breaks Lock-1 §2.1 purity for every approval] · (c) at action-attempt [the departed user can never act, so the task deadlocks until an admin intervenes — today's behavior]"* | #5022 |
| **OD-L4-6 (a)** | *"frontend 3-way radio projected over the two shipped booleans, both-ON state read-only, zero contract change · (b) discrete `dedupTier` enum deriving the booleans (a fifth key and two sources of truth)"* | **F4-D，本轮未落** |
| **OD-L4-7 (a)** | *"exempt prior_node_approver from BOTH history-derived flags, mergeWithRequester still applies"* | **F4-D，本轮未落** |
| **OD-L4-10 (a)** | *"scope the history the flags read to the current post-return round using the existing nodeEntryEpoch machinery … Gate D-3 cannot be written until this is decided; shipping a dedup switch without either is forbidden."* | **F4-D，本轮未落** |

**P3-A 是部分落地，这是本节最重要的诚实约束。** Lock-4 定义**五个族**；本轮落地 **F4-A / F4-B / F4-C / F4-E 四族**。
机械核实于 `6cca7ec0ed` `[执行]`：`git log --first-parent d8ac22c989..6cca7ec0ed --format='%s' | grep -iE 'F4-|P3-A'`
恰好三条提交（#5021 F4-B、#5022 F4-E、#5023 F4-A+F4-C），**无 F4-D 提交**；`git grep -c "dedupTier" 6cca7ec0ed -- packages apps scripts`
= **0**；`ApprovalType` 联合只有两个成员。

⇒ **正确表述是「P3-A 五族中的四族（F4-A/B/C/E）落地；F4-D 与被延期的 `auto_reject` 未落地」。**
写「P3-A 已落地」或「Lock-4 已实现」都与锁文自身的批准块矛盾。

### 1.3 Lock-7b（节点级必填）—— RATIFIED，且**已在 main 上**（本次重锚更正）

> **本节在重锚中被更正。** 草稿写就时 #5025 仍 OPEN，故当时的正确表述是「RATIFIED-and-not-on-main」。
> 该状态**已经改变**：#5025 于 2026-08-20T06:33:24Z 合并。**下面是更正后的状态，草稿的旧表述作废。**

- 文件：`docs/development/approval-lock7b-required-at-node-20260820.md`，**585 行**，**在 main 上** `[执行]`
  （`git show 5feca2291b:docs/development/approval-lock7b-required-at-node-20260820.md` 亲读）。
- **PR #5025 已 MERGED**（`mergedAt: 2026-08-20T06:33:24Z`），落地 squash commit **`5ab052449b`**，
  pre-squash head **`207162573e11981b50a2a21f3a8cd82346ff649d`**（⚠️ **不是**草稿记的 `a1549ce303` —— 该分支在草稿观测之后
  又前进过；`a1549ce303` 是草稿时点的 head，二者均非合并提交的祖先，见 §0.2）。**+587 / −0，3 个文件**：
  锁文本体 + `approval-parity-master-design-lock-20260817.md` 的 Lock-7b 注册行 + `approval-parity-execution-ledger-20260817.md` 的批准行。
- ⚠️ **锁文在 main 上并不改变它的 provenance 等级。** §4 仍是 **session-recorded goal-set provenance**、
  仍自声明「在实现落地前可撤回」、`Runtime authorization: NONE`。**「已合入 main」= 文本已进入 repo-of-record，
  ≠ owner 亲署批准**（§1.1）。这两件事在本文任何地方都不合并。
- 头部原文：*"**Status:** RATIFIED 2026-08-20 — §4 records the owner decision under goal-set provenance …
  **Design authority ONLY**: no runtime code, no flag, no UAT, no deployment, and no completion label is authorized here."*
  基线 `origin/main@a0edbe39a488909c156ca7a6aaf757f4e78cfd7f`。
- 评审轮：独立 opus refute-first 评审对草稿 head `b85987d3ed77bf09866ffd63b39d89a6d185ae77` 返回 **REQUEST-CHANGES**
  （2 P1 / 4 P2 / 5 P3 / 4 NIT，`/tmp/lock7b-review-20260820.md`）；585 行是**评审后**文本。
- Parents：master lock M4/M7/M8/M11；**Lock-7**（本锁是它的 delta，十二条 OD-L7-* 逐条扫过）；Lock-3 §2.2/§3 + OD-L3-1(a)；Lock-8 A-1；Lock-0 L0-6。

⇒ **准确说法（更正后）：Lock-7b 是 main 上的一份 RATIFIED 锁文，但其 §4 的 provenance 是 session-recorded goal-set，
不是 owner 亲署批准，且它只授权设计。** 草稿的旧句「不得把 Lock-7b 描述为『main 上的一份已批准锁文』」
在「已批准 = owner 亲署」这个意义上**仍然成立**，在「在不在 main 上」这个意义上**已作废**。

**十三条 OD-L7B 支臂（逐字引自 §4）：**

- **OD-L7B-1 (a)** *"`required` is a FOURTH member of the shipped `NodeFieldAccess` enum; 必填 × hidden is unrepresentable by construction via the one-state-per-field dedup guard (`:1616-1618`)."*
  被否决的 (b)：*"an orthogonal `requiredAtNode: boolean` … it CREATES the `hidden` + `required` combination … A criterion that cannot be expressed cannot be bypassed; a criterion enforced by a check can."*
- **OD-L7B-2 (a)** *"masks are per node and independent: `hidden` at node A + `required` at node B is LEGAL."*
- **OD-L7B-3 (a)** *"`required` is satisfiable on HANDLER nodes only in v1; on an approval node publish REJECTS it values-free (no inert acceptance, M7/M8)."*
- **OD-L7B-4 (a)** *"publish REJECTS `required` on a routing-driver field, through the SHARED `collectRoutingDriverFieldIds` — one derivation, no second one."*
- **OD-L7B-5 (a)** *"enforcement at handler SUBMIT, AFTER `applyHandlerFieldWrites`; emptiness is `isEmptyValue` (`AGE:205-210`) verbatim, holes and all; a requester-filled value satisfies it."* → 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`
- **OD-L7B-6 (a)** *"restate and assert the shipped invariant: `hidden` at a node is not writable there, and `required` at that same node is unrepresentable."*
- **OD-L7B-7 (a)** *"the fourth option renders on handler nodes only, in the canvas inspector; on approval nodes it is ABSENT, not disabled-greyed (M7); the linear editor gains nothing."*
- **OD-L7B-8 (a)** *"non-goals: no DDL, no new action verb, no bootstrap-version bump, no feature flag; the DTO / OpenAPI enum widening is the one deliberate in-slice exception."*
- **OD-L7B-9 (a)** *"publish REJECTS `required` on `explanation` / `record-link` / `attachment`, with the recorded reopen condition when each type's handler write support lands."*
- **OD-L7B-10 (a)** *"ONE mechanical enumeration over `NODE_FIELD_ACCESS_VALUES` replaces every literal chain; the §0.4 census is asserted by exact set over NINE source sites; the four generated copies are regenerated by CI, never hand-edited."*
- **OD-L7B-11 (a)** *"the frozen-schema `SELECT` is hoisted out of the `fieldWrites` key-presence guard (`:8848`) and re-gated on `fieldWrites` present OR a non-empty `required` candidate set at this node — closing the one-key bypass without charging legacy graphs an extra read."*
  被否决的 (b) 原文：*"`fieldWrites` is detected by key PRESENCE … so omitting ONE JSON key would skip the load, skip the check, and discharge every 必填 obligation at the node — a zero-cost client bypass of this lock's only enforcement surface."*
- **OD-L7B-12 (a)** *"the visibility skip is evaluated on the UNION of the pre-write and post-write snapshots, so the actor cannot discharge the obligation by hiding the field with the same submit."*
- **OD-L7B-13 (a)** *"under 会签 the obligation binds every SUBMIT, not only the node's completing submit."*

**Gate G-14 的已批准属性（逐字，`/tmp/l7b-branch.md:490`）** —— 它是 §4 与 §8 的承重点：
*"the NINE §0.4 sites are asserted equal by exact set — not count, not subset — and the site LIST itself is asserted,
so **a tenth copy added later fails the census rather than passing unnoticed**."*

#### 1.3.1 必填 × 隐藏 的裁定：为什么「不可表达」强于「被校验」

这是 Lock-7b 的核心设计判断，值得单独说明，因为它决定了整份锁文的形状。

一个字段在某节点上同时被标记为 **hidden**（此处不可见、不可写）与 **required**（此处必须非空）是一个**自相矛盾**的配置：
它要求执行者填写一个他看不见、也写不进去的字段。两种可选设计：

- **(b) 正交布尔位** `requiredAtNode: boolean`，与既有 `NodeFieldAccess`（`editable`/`readonly`/`hidden`）并列，
  再加一条发布期校验「若 access === 'hidden' 则 requiredAtNode 必须为 false」。
- **(a) 第四个枚举成员** `required`，与 `editable`/`readonly`/`hidden` 互斥地占据**同一个**「每字段一状态」的槽位。

选 (a)。理由不是省一个键，而是**判据本身的可攻击性**：

1. **(b) 先创造了这个组合，再去禁止它。** 组合在数据模型里是**可表达**的；禁止它的只有一处校验。那处校验就成了唯一的
   承重点——它有没有覆盖所有写入路径（publish / PATCH / 后端 rebuild / 前端 allowlist / 迁移导入 / 遗留图）就成了一个
   必须被逐路径证明的问题。这正是本仓反复吃亏的形状（`feedback_changing_the_convention_is_not_changing_the_invariant`：
   「让正确做法成为可能 + 把调用方改成那样」并不关闭旧的错误路径；判据是「错误配置现在会被拒绝吗」而不是「我们还会那样做吗」）。
2. **(a) 让组合根本不存在。** `required` 与 `hidden` 争夺同一个槽位，既有的 **one-state-per-field dedup guard**（`:1616-1618`）
   保证同一字段在同一节点上只能有一个状态。**没有一条写入路径能构造出这个组合**，因此也不需要证明「所有写入路径都被校验覆盖」。
   锁文自己的措辞最准确：*"A criterion that cannot be expressed cannot be bypassed; a criterion enforced by a check can."*
3. **代价被诚实记账，而不是被掩盖。** (a) 的代价是枚举**加宽**：DTO / OpenAPI 枚举必须跟着加宽（OD-L7B-8 明确把这
   列为「本切片唯一一个刻意的例外」），而且仓内每一份手写的三成员字面量副本都会成为潜在的**漂移点**。
   这正是 **OD-L7B-10 + G-14 普查**存在的原因：一次机械枚举取代所有字面量链，九处源站点按**精确集合**断言，
   **站点清单本身也被断言**，从而「第十份副本会让普查变红，而不是无声通过」。

⇒ 换言之：(a) 把「组合非法」从**运行期校验问题**转成了**类型系统问题**，代价是把风险转移到「枚举副本会不会漂移」，
而那个风险原计划由一个**机械普查**兜底。**普查因此曾被当作这份锁的承重件**——而它恰恰是 §3.8 那条四轮未收敛的
规避链的主角。

🔴 **本次重锚必须更正这一句的落点：最终落地的形状不是「普查兜底」，而是「编译器承重 + 普查降级为尽力而为的兜底」。**
第五轮把机制换掉之后，制品自己把声明降级为 *"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP,
NOT THE PRIMARY GUARANTEE"*。这对上面第 3 点的论证是一次**实质性弱化**：`Record<NodeFieldAccess, …>` 站点的漂移
现在由 `tsc` / `vue-tsc` 兜住（已由第五成员变异双向证明，§3.8），但**手写字面量副本**这一类仍然只有一个
自认尽力而为的文本扫描器在看。**这是否仍然满足 G-14 已批准的属性（「九处站点按精确集合断言 …
第十份副本会让普查变红」），是一条 owner 裁决项，不是本文可以自证的事**（§6.4）。

### 1.4 无锁文授权的三项 —— 权威来源必须被逐条标明

| 项 | 设计权威 | 收官行 |
|---|---|---|
| 原始用户 ID 渲染类（#5010/#5016/#5019） | 2026-08-18 对抗审 **F1** + 开发报告 **§6.4 D-10**（raw user-ID render residual）。**无锁文。** | AC-5 / AC-6 |
| `/api/approvals/:id/history` 授权对齐（#5024） | 与兄弟路由 `GET /api/approvals/:id` 的 **parity**。**无锁文。** | AC-7 |
| P5-C 成员动作对话框语法（#5030） | 台账行 `docs/development/approval-parity-execution-ledger-20260817.md:60`（P5-C 行）；开发报告 §6.3 于 08-18 记为 `NOT STARTED`。**无锁文。** | AC-8 |

### 1.5 权威总表

| PR | 已批准锁文 | 援引的 OD / 闸门 | 锁文在 main 上？ |
|---|---|---|---|
| #5010 / #5016 / #5019 | **无** | 08-18 对抗审 F1；开发报告 §6.4 D-10 | n/a |
| #5024 | **无** | 兄弟路由 parity；收官 AC-7 | n/a |
| #5021 | Lock-4 | §1 F4-B、§2.1–2.4、§3 B-1/B-2/B-3/X-2/X-3/X-4、**§4 OD-L4-3(a)** | ✅ RATIFIED，在 main |
| #5022 | Lock-4 | §1 F4-E、§2 cross-cutting、§3 E-1/E-2/E-3、**§4 OD-L4-8(a)/OD-L4-9(a)** | ✅ |
| #5023 | Lock-4 | §1 F4-A/F4-C、§2、§3、**§4 OD-L4-1(a)/-2(a)/-4(a)/-5(a)** | ✅ |
| #5030 | **无** | 台账 `approval-parity-execution-ledger-20260817.md:60` P5-C 行 | n/a |
| #5026（**MERGED `5feca2291b`**） | **Lock-7b** | OD-L7B-1…13；gates G-3 / G-10c / G-12b / G-14 / G-15 / G-16 | ✅ **PR #5025 已 MERGED `5ab052449b`，在 main**（provenance 仍为 goal-set，§1.1/§1.3） |

---

## 2. 落地能力逐条

每条按同一模板给出：**契约 / 引擎接点（file:line）/ 发布期咽喉（publish-time choke）/ 派发期咽喉（dispatch-time choke）/
fail-closed 姿态 / 落地 SHA + 闸门裁决 / 残留**。所有 `file:line` 若无特别说明均为 **读取基线 `6cca7ec0ed` 上的 `[源读]`**（**不是**重锚后的 exact-main `5feca2291b`；本节未在新 head 上逐条复读）；
闸门制品中给出的行号是**闸门时点**的，二者不混用。

### 2.1 F4-A —— 节点级 `auto_approve`（自动通过）· #5023

- **契约** `[源读]`：`packages/core-backend/src/types/approval-product.ts:92` →
  `export type ApprovalType = 'manual' | 'auto_approve'`。它是 `type:'approval'` 节点上的**配置字段**
  （`:251` `approvalType?: ApprovalType`），**不是**新节点类型（OD-L4-1(a)）。
- **发布期咽喉** `[源读]`：`ApprovalProductService.ts:631` 的 `APPROVAL_TYPES` 集合（导出，供单测直接钉精确集合；其上 `:626-630` 是记录 OD-L4-2(a) 的注释），
  `normalizeApprovalType` 拒绝集合外的任意字符串；`ApprovalProductService.ts:2400`
  `APPROVAL_NODE_AUTO_TYPE_PARALLEL_UNSUPPORTED` —— **并行区内的非 `'manual'` 节点在发布期被拒**（v1 限制，
  但非 `'manual'` 节点**仍可**作为条件分支的目标，见 `types/approval-product.ts:249` 注释）。
- **派发期咽喉** `[源读]`：`ApprovalGraphExecutor.ts:144`（`config.approvalType === 'auto_approve'` 才走自动判定；
  `'manual'`/缺省一律仍需真人）与 `:1274` 的执行分支。
- **fail-closed 姿态**：`auto_reject` **在联合类型里根本不存在**，因此在发布期「不可达」而无需在任何地方声明它。
  代码注释逐字 `[源读]`（`ApprovalProductService.ts:626-630`）：*"Deliberately does NOT contain `'auto_reject'`: §4's
  RATIFIED text is 'auto_approve only, auto_reject deferred… no inert third option' — the type union itself makes
  `'auto_reject'` 'NOT reachable' at publish (OD-L4-2(a)) without declaring it anywhere."*
  且注释显式说明 Set 与联合类型「永不漂移」的理由。
- **落地**：merge `0f70783a2c78784838822b7439097b380bc5e99d`（2026-08-20T00:22:15Z）。
- **闸门**：`/tmp/p3a-f4a-f4c-gate-20260819.md` = **FIX-ROUND**，绑 `260e39fe4c`（0 P1 / 3 P2 / 2 P3）；
  复核 `/tmp/p3a-f4a-f4c-requal-20260820.md` = **MERGE-CLEAN**，绑 `4944bdee5f`（0 P1 / 0 P2 / 3 P3 / 3 NIT）。
  复核在**全新销毁重建的 virgin `postgres:16`**（`p3a-requal-pg`:55501）上跑：后端单测全扫 **531 文件 / 8063 测试**、
  新真库套件 **18/18**、FAIL-0 守卫 **265/265**、raw-id 普查 **12/12**、attendance P26 普查 **58/58** `[执行]`。
- **裁决 SHA ≠ 落地 head**（§0.2）：`4944bdee5f` 是 rebase 前 head，落地 head `efaa553d71`，二者**内容等价已机械证明**。
  落地 head `efaa553d71` 的 required checks 全绿 `[执行]`（38 runs；含全部 17 条 `approval-realdb-*` 车道；
  仅 `Strict E2E with Enhanced Gates` = skipped）。
- **验证**：收官 **AC-1 = PASS**，`approval-lock4-f4a-auto-decision.db.test.ts` **11/11** `[执行·真库]` + 单测。
- **残留**：`auto_reject` 按 OD-L4-2(a) 仍**延期**，需 owner 单独裁决（§6）。

### 2.2 F4-B —— `emptyAssigneePolicy: 'designated'` 空审批人指定回退 · #5021

- **契约** `[源读]`：`types/approval-product.ts:65` →
  `export type EmptyAssigneePolicy = 'error' | 'auto-approve' | 'designated'`（`'error'` 仍是缺省的「缺席等价值」）；
  新增**唯一**承载键 `emptyAssigneeFallback`（`types/approval-product.ts:236` 附近；类型注释 `:62` 逐字记录
  OD-L4-3(a)「**没有反向 admin 角色查询，本切片也不建**」）。形状刻意镜像 `static_user`/`static_role`，
  以便**复用同一条 resolver 路径** `resolveApprovalAssignees`，不手工另建一条。
- **发布期咽喉** `[源读]`：
  - `ApprovalProductService.ts:2319` —— `emptyAssigneeFallback` 出现而 `emptyAssigneePolicy !== 'designated'` ⇒ 拒；
  - `ApprovalProductService.ts:2331` —— `'designated'` 而 `emptyAssigneeFallback` 缺失/为空 ⇒ 拒（跨字段规则，B-s10）；
  - `normalizeEmptyAssigneeFallback`（`:750` 定义、`:3054` 调用）—— 形状归一化；
  - **FE 侧四条 allowlist**（见下文 P1-1）。
- **派发期咽喉** `[源读]`：`ApprovalGraphExecutor.ts` 的 `resolveDesignatedFallbackAssignments`（约 `:1858` 起）：
  `userIds`/`roleIds` 皆空 ⇒ 返回 `[]` ⇒ 直落既有 `APPROVAL_ASSIGNEE_EMPTY`（`:1320` / `:1355` / `:1665`）。
  T2-4 threshold 可达性同样施加于**回退集合**。
- **fail-closed 姿态：部分，且这是本轮最需要 owner 看见的一条。** 执行器自身的 Gate B-2 披露原文
  `[源读]`（`ApprovalGraphExecutor.ts:1840-1856`）：锁文 B-2 点名**三种**零审批人情形
  —— *"empty list, deactivated ids, role with no members"* —— 但**只有第一种**被这里的早返回覆盖；
  另两种不被过滤，因为 `static_user`/`static_role` 经 `resolveApprovalAssignees` **不做 active 校验、不做角色成员展开**。
  于是「指定回退指向一个已停用 id 或一个空角色」会**派发出一个没人能处理的座位**，而不是像 B-2 文本承诺的那样
  终止在 `APPROVAL_ASSIGNEE_EMPTY`；**而 OD-L4-3(a) 自己推荐的用法（指定审批管理员 ROLE 来表达转审批管理员）
  恰好就是空角色那一种情形。** 代码把它归类为「与每个 `static_user`/`static_role` 源共有的继承属性，不是本回退引入的回归」——
  **这个归类本身正是 owner 需要裁决的东西**（§6.4 第 1 项）。修好它需要 resolver 内的实时目录/角色读
  （被 Lock-1 §2.1 明文禁止）或一套新的 frozen-snapshot 机制，两者都超出本切片。
- **落地**：merge `da0d1ca79e4d805ff428b8010a94b0d6761f1c80`（2026-08-19T23:52:26Z）。
- **闸门**：`/tmp/p3a-f4b-gate-20260819.md` = **FIX-ROUND**，绑 `591ab22aa6`（1 P1 / 3 P2 / 4 P3 / 3 NIT）；
  复核 `/tmp/p3a-f4b-requal-20260820.md` = **MERGE-CLEAN**，绑 `1dadde2ba6`（= PR headRefOid）。
  修复链 `aa5a791129` → `1dadde2ba6`；基线按 `a0edbe39a4` **重测**，而不是用陈旧的 merge-base `cc55195461`。
- **验证覆盖形状缺口（不是缺陷）**：收官 **AC-2 = PASS-POSITIVE-ONLY** —— **只有 4 条单测，没有真库车道**，
  而 F4-A / F4-C / F4-E **三族都有**。R3 的运行期「unknown-state fail-closed」那一半**没有真库证明**。
  这被排为修复切片 **FS-3**，收官措辞逐字：*"是覆盖形状缺口，不是被证伪的行为；造车道属新工作，需独立评审"*。
- **⇒ 四族中 F4-B 最弱**：fail-closed 只覆盖三种零人情形中的一种，且缺真库车道。本文明确这样记，不做圆整。

### 2.3 F4-C —— 同一审批人策略 `samePersonPolicy` · #5023

- **契约** `[源读]`：`types/approval-product.ts:663` →
  `export type SamePersonPolicy = 'self_approve' | 'auto_skip' | 'transfer_direct_manager' | 'transfer_dept_head'`。
  它住在**既有的** `autoApprovalPolicy` 覆盖优先级里（OD-L4-4(a)），**不是**第二套优先级规则。
- **发布期咽喉** `[源读]`：`ApprovalProductService.ts:844-847` —— 非枚举值一律 422 值自由拒绝；
  `SAME_PERSON_POLICIES`（`:636` 起，导出以便单测直接钉集合）。
- **归一化与优先级** `[源读]`：`ApprovalProductService.ts:801-859` `normalizeAutoApprovalPolicy`，
  其中 `:852` `const effectiveMergeWithRequester = samePersonPolicy === 'auto_skip' ? true : mergeWithRequester`。
- **启用谓词加宽** `[源读]`：`ApprovalProductService.ts:4253-4272` —— `samePersonPolicy !== undefined && !== 'self_approve'`
  是加宽项；**`'self_approve'` 被刻意排除在加宽之外**，这样节点上写 `{samePersonPolicy:'self_approve'}` 仍能
  **遮蔽/关闭**模板级策略（保住 opt-out 语义）。
- **派发期接点** `[源读]`：晚绑定提供者 `getEffectiveSamePersonPolicy`
  （`ApprovalProductService.ts:7171` 与 `:7758` 两处装配）→ 由 `ApprovalAssigneeResolver.ts:37` 消费，
  即「**本节点上生效的** `samePersonPolicy`，晚绑定」，resolver 保持纯净。
- **fail-closed 姿态**：OD-L4-5(a) —— 座位不产生时由 `emptyAssigneePolicy` 治理；
  被否决的 (c)「回落到 `self_approve`」的理由逐字：*"hands the approval to the person the policy exists to exclude"*。
- **落地 / 闸门**：同 #5023（§2.1）。
- **残留（owner 项）** `[源读]`：`ApprovalProductService.ts:808-811` 记录了一条**未经批准的优先级微决策** ——
  *"`samePersonPolicy:'auto_skip'` WINS over an explicit `mergeWithRequester` in the same payload"*。
  锁文**没有**裁定矛盾载荷该怎么办。闸门 P3-2 的措辞：应当写进锁文（或反过来让显式布尔位胜出），
  而不是留作实现者选择。
- **验证**：收官 **AC-3 = PASS**，`approval-lock4-f4c-same-person.db.test.ts` **7/7** `[执行·真库]` + 单测。

### 2.4 F4-E —— 离职自动转上级 · #5022 · **写入器已落地，派发未接线**

- **契约** `[源读]`：新写入器 `ApprovalProductService.applyApprovalDepartureTransfer`（`:8272`），
  哨兵行动者 `APPROVAL_DEPARTURE_SYSTEM_ACTOR = 'system:approval-departure'`（`:669`），
  结果类型 `ApprovalDepartureTransferResult`（`:470`）与逐实例跳过原因 `ApprovalDepartureTransferSkipReason`（`:454`）。
  DML 形状（逐座位、epoch 分桶插入、审计行）仿照 `bulkReassignApprovals`，但**不经过**它
  —— 锁文原文：*"does not duplicate `bulkReassignApprovals`, which stays the admin-driven path"*。
- **审计动词是 `'reassign'`，绝不是 `'transfer'`** —— 见 §3.7，这是本轮最有价值的一条跨线取舍。
- **fail-closed 姿态** `[源读]`（`:8216` 起的 Contract 块，本条在 `:8233`）：解析不到 ACTIVE 上级时，**座位原地保留**，
  写一条审计行（`outcome: 'no_manager_resolved'`）**加**一条 operator warning；**绝不自动通过、绝不丢弃、绝不升格为管理员座位**。
  委派豁免（Gate E-3）：委派人离职不重转已被委派替换的座位（`pushResolved` 已把 `assignee_id` 改写为受托人），
  受托人本人离职**会**转（断言落在座位的**当前** assignee 上，而不是离职 id）；另有一条
  `(metadata ->> 'delegatedFrom') IS DISTINCT FROM $departedUserId` 作为纵深防御。
- **P26 attendance 边界** `[源读]`：attendance-central 实例被跳过（`:8357` `'attendance-central-unsupported'`），
  镜像 SLA 超时转派所跑的同一条 `assertAttendanceCentralMutationFailClosed` 守卫。
- **🔴 接线状态 —— 本文对证据包的一处收窄，`[源读]`：`applyApprovalDepartureTransfer` 在**读取基线 `6cca7ec0ed`** 上没有任何生产调用方。**
  机械核实（**无 pathspec 的全仓 grep**，以免扫描窗口自己骗人）：
  `git grep -n "applyApprovalDepartureTransfer\|DepartureTransfer\|APPROVAL_DEPARTURE_SYSTEM_ACTOR" 6cca7ec0ed`
  去掉测试目录后，命中只有：其自身定义/类型/文档注释（`ApprovalProductService.ts`）、`vitest.config.ts:367` 的注释、
  P26 分类表 `scripts/attendance/w4c0-dml-inventory/p26-approval-assignment-classification.cjs:42`、
  以及车道文件 `.github/workflows/approval-realdb-departure-transfer.yml:10` 的注释——**该注释本身逐字说**：
  *"`applyApprovalDepartureTransfer` is invoked only by this suite's explicit test-visible …"*。
  第二个方向的核实：`directory-sync.ts` / `deprovision-planner.ts`（`user_changed` / `usersDeactivatedCount` 的产出方）
  内**没有**任何对 `ApprovalProductService` 的调用（grep 命中全是无关的 `ApprovalDirectoryOrg` / approval-card 文本）。
  而方法自身的文档注释也主动声明了这一点，逐字：
  *"this method is deliberately NOT wired to that consumer in this slice (P3-A scope — the wiring + operator-warning
  surface is a separate slice per the Lock-4 P3-A briefs). Any authoring/disclosure copy describing this feature MUST
  carry that limit and MUST NOT claim universal coverage."*
  另有一条**独立**的可达性限制：目录 deprovision 的 `user_changed` 效应本身受 `DIRECTORY_DEPROVISION_ENABLED` 门控，
  **按 org 默认 OFF**。
  ⇒ **正确表述：F4-E 的写入器与其真库验收已落地；从离职信号到该写入器的派发链在本 SHA 上未接线，
  operator-warning 面属另一切片。** 「离职自动转上级已达成」是过强声明；收官 AC-4（9/9 真库 PASS）证明的是**写入器**，
  不是**这条链**（记录类别：`feedback_verified_one_link_generalised_to_the_chain`；同型先例：#4556 闸 C = 转换写入器零生产调用方）。
- **落地**：merge `5df20d769b679767b29be5a7343a449b93cb74e1`（2026-08-19T23:52:49Z）。
- **闸门**：`/tmp/p3a-f4e-gate-20260819.md` = **FIX-ROUND**，绑 `108f09bc0b`（2 P1 / 1 P2 / 若干 P3）；
  复核 `/tmp/p3a-f4e-requal-20260820.md` = **MERGE-CLEAN**，绑 `5bd2e20a55`（= PR headRefOid）。
  修复链：`8e5ba9970c`（P26 普查 + sentinel）→ `519a145762`（两处静默跳过补审计+warn）→ `5bd2e20a55`（doc-vs-code 更正）。
- **残留**：**N-1（P3）—— P26 attendance-central 跳过是唯一仍然「座位原地保留但无 operator warning」的结局**；
  N-2 / N-3 为 NIT；P3-2 / P3-5 不变。

### 2.5 原始用户 ID 渲染类 —— #5010 → #5016 → #5019（三个 PR，一个类）

**#5010**（merge `44e6fe33eadaa689f5b4a3afef8d00c97095e614`，head `e7123ff6d0`）
- 三处停止渲染原始 id：`ApprovalCenterDetailPane.vue assigneeLabel()`；`ApprovalDetailView.vue reducibleAssignees`（减签选择器标签）；
  `ApprovalDetailView.vue onAddSignUserSelected()`（加签 chip）。回退文案 = **按列表稳定序号**「成员 N」。
- **线协议未变**：`assigneeId` 仍然是选择器选项的 **VALUE**，只改可见标签。
- 根因（PR body，`d8ac22c989` 上 grep 确认）：**仓内根本不存在 `metadata.assigneeName` 的生产方**。
- 显式**排除并标注**：`ApprovalUserPicker.vue optionLabel()`（被 4 处调用点共享）。

**#5016**（merge `6ae6304f171523f5c3a87f7cc6d59fc4ac9132b6`，head `c9c4322d43`）
- 补上缺失的生产方：`GET /api/approvals/directory/resolve?userIds=`，走**与既有 `/directory/users` 搜索完全相同**的
  `approvalParticipantDirectoryGuard` 权限并集（`approvals:read|write|act`）——**没有新开授权面**。
- FE 共享缓存 `directoryResolve.ts`，**三态**：未解析 / 已确认无法解析 / 真实姓名；每请求 ≤ 50 个 id。
- **关键交互设计**：**会改变流程的选择器，对「无法解析」的成员是 disable 该选项**，而不是让用户对着一个盲序号
  做人事变更；纯展示位才显示解析出的姓名或一个值自由的计数。
- 新车道 `.github/workflows/approval-realdb-directory-resolve.yml`；新套件 `approval-directory-resolve.api.test.ts`。
- ⚠️ 该 PR body 自带一段 **SUPERSEDED 划除块**：`resolveDirectoryRolesByIds` 已被**删除**，路由是 **users-only**，
  且其中「11/11 green against real PostgreSQL 15」那句*"describes a version of the test file that no longer exists at head."*
  **本文不引用那个 11/11。**

**#5019**（merge `cc55195461880e6aeda0512efe3fe50bf8f60e99`，head `6467d8bd1b`）
- 再补两处**旧人工清单里根本没有**的站点：`ApprovalNewView.vue choiceOptionLabel`
  （requester_choice 提交期选择器，**面向发起人**）→「成员 N」+ `isChoiceOptionUnidentifiable` 置灰 +
  `firstUnidentifiableChoiceNode` 提交期拦截；`ApprovalMetricsView.vue` 按发起人汇总
  （admin 门控，后端 `keyExpr = requester_snapshot->>'id'`）→「发起人 N」。
- **把人工清单换成机械普查**（这是本项真正的设计变更）：
  `apps/web/tests/approval-member-identity-coverage-enumeration.spec.ts` 从手写 `SITES` 数组重建为两层——
  **TIER A** 具名回归守卫；**TIER B** 测试期 `readdirSync` 遍历 `apps/web/src/approvals/**` +
  `apps/web/src/views/approval/**`，6 条原始 id 渲染正则，**每一处命中都必须有显式 `ALLOWLIST` 条目**
  （`VALUES-FREE-FIXED` 或 `OUT-OF-SCOPE` + 理由），**未分诊命中 ⇒ 红**。
- `directoryResolve.ts` P3-3：有界原地重试（3 次，**刻意不用 `setTimeout`** —— 该模块是会话级单例，真定时器会污染后续测试）；
  终局 401/403 不重试。
- 变异证明（PR body）：还原 `choiceOptionLabel` 会让**两套独立机制下的 4 条测试**变红。

**闸门状态（必须如实记）**：⚠️ **#5010 / #5016 / #5019 没有任何 `/tmp` 闸门或复核制品**
（本会话第一手复核 `[执行]`：`/tmp` 下现有 **31** 份 `.md`，其中提及 `#5010`/`#5016`/`#5019` 的为 **0** 份 —— 即目录非空而这三个 PR 无制品，两者不是同一件事）。**因此本文不为它们归属任何闸门裁决。**
它们的事后验证是**收官 AC-5 / AC-6 行**：
- **AC-5 = PASS** —— `approval-member-identity-coverage-enumeration.spec.ts` **12/12** `[执行·挂载]`
  （TIER A 具名回归 + DECOY；TIER B 机械模式扫 + 非空性 + allowlist 陈旧检测 + 合成夹具 DECOY；作用域外泄扫）。
- **AC-6 = PASS** —— `approval-directory-resolve.api.test.ts` **11/11** `[执行·真库]` + `searchApprovalDirectoryUsers.spec.ts` `[执行·挂载]`。

**🔴 作用域更正（必须随行）**：#5016 的标题写「close raw-id render class」，**台账不同意，且台账是对的**：
- 开发报告 §6.4 D-10：*"class 本身不宣告闭合"*；
- 收官 **AC-5 逐字**：*"**作用域逐字**：仅 `src/approvals/**` + `src/views/approval/**`、仅那 6 个模式，**不是「全部原始 ID 渲染」**"*；
- #5019 PR body：*"本次核实只覆盖 … 不等于「所有原始 id 渲染问题」的全域穷尽；下次同类回归的第一道防线是上述枚举守卫，而非人工记忆。"*

### 2.6 `/api/approvals/:id/history` 授权对齐 · #5024

- **契约** `[源读]`：`packages/core-backend/src/routes/approval-history.ts:50` →
  `r.get('/api/approvals/:id/history', authenticate, rbacGuard('approvals','read'), …)`，与兄弟路由 `GET /api/approvals/:id` 对齐。
- **设计要点** `[源读]`（`:47-48` 注释）：守卫**放在 `isPlmApprovalId` 分支之前**（`:53`），
  于是**两种 id 形状（平台 id 与 `plm:` 前缀）拿到同一姿态**——这正是「别自造分支再逐个补洞」的做法。
- **fail-closed 姿态**：无 `approvals:read` ⇒ 值自由拒绝（不泄露实例是否存在）。
- **落地**：merge `a0edbe39a488909c156ca7a6aaf757f4e78cfd7f`（2026-08-19T16:24:18Z）。
- **闸门**：`/tmp/approval-history-guard-gate-20260819.md` = **MERGE-CLEAN**，绑 `0e0ea65118`（= PR headRefOid，
  故裁决绑最终分支 head）；0 P1 / 0 P2；3× P3、4× NIT。
  披露项：评审库是 **PostgreSQL 15.17** 而 CI 车道是 `postgres:16`（NIT-3）；闸门收口时 `test (20.x)` 仍 pending（NIT-2）。
- **验证**：收官 **AC-7 = PASS**，**8/8** `[执行·真库]`：**两条判别性反例**（缺 `approvals:read` 的值自由拒绝；
  有权限声明但不匹配的主体被拒）+ **两条正控**（同形状但已授权的主体通过；通配符也满足）+
  `approval-history-routing.test.ts`（在 G7 内）。
- **处理约束**：该闸门 MD 的 §Residual 与 mutation-B **不得**出现在任何公开面（§0.4），本文遵守。
- **新车道**：`.github/workflows/approval-realdb-history-guard.yml`（`EXPECT_DB=1`）；
  `plugin-tests.yml` 未被触碰（diff 验证为空）。

### 2.7 P5-C-1 —— 成员动作对话框语法与 detail/center chrome 统一 · #5030

- **契约**：统一 `ApprovalDetailView.vue` + `ApprovalCenterDetailPane.vue` 六个成员动作对话框的语法与 chrome；
  新增 spec `apps/web/tests/approval-member-action-dialog-grammar.spec.ts`；新增十处 `aria-label` 绑定；
  `actionDialogError` 从只支撑两个对话框扩为**支撑全部六个**。
- **落地**：merge `2e2683cda9e7373f6db8ce7646b8e4b9d8174df5`（2026-08-20T03:14:41Z）。
- **闸门**：`/tmp/p5c-gate-20260820.md` = **FIX-ROUND**，绑 `0a61dd8521`（1 P2 / 1 P3 / 4 NIT）；
  复核 `/tmp/p5c-requal-20260820.md` = **FIX-ROUND**，绑 `90725bbe37`，**0 P1 / 0 P2，一条 P3（NEW-P3-1）**，
  处方唯一：删除 `apps/web/scripts/run-required-web-tests.sh:301-302` 里那句已被撤回的 focus-on-open 覆盖声明。
- **处方即落地物** `[执行]`：裁决之后的最后一个提交 `563fbb27729a846a468451248fe88b2dc7c9b95a` 正是它，
  `git diff --stat 90725bbe37 563fbb2772` = `apps/web/scripts/run-required-web-tests.sh | 3 +--`
  —— **1 文件、1 增 2 删、非生产代码**。落地 head `563fbb2772` 的 checks 全绿（18 runs，仅 Strict E2E skipped）`[执行]`。
- ⚠️ **没有任何制品晚于 10:44 复证本地 `bash apps/web/scripts/run-required-web-tests.sh`**；
  站在它位置上的是 `563fbb2772` 处 CI `web-tests` + `approval-web-guard` 的成功。
- **🔴 台账行不闭合**：复核 OBSERVATION 逐字 —— 台账 `approval-parity-execution-ledger-20260817.md:60` 要求
  *"mounted/browser/mobile/a11y"* 四腿；本 PR 只交付 **mounted** 一腿；browser 推迟至 P5-C-3；
  mobile 未由本 PR 跑（`approvalMobileDetailActions.spec.ts` 属该必跑脚本声明的 19 个既有红文件之一，
  在 head 重跑：**3 failed / 8 passed，失败标题与换成 `origin/main` 版本后逐字节相同 ⇒ 既有红、非回归**）；
  **a11y 那一腿现在是空的，而本 PR 恰恰新增了十处 a11y 属性**。且本 PR **未修改台账行**（changeset 内无 docs 文件）。
- **验证**：收官 **AC-8 = PASS-POSITIVE-ONLY** —— 3 套件 **52/52** `[执行·挂载]`，**继承 R9 未兑现的 focus / cancel 两半**。

---

## 3. 设计取舍与被否决的方案

本节存在的目的只有一个：**让被否决的方案不被重新提出**。每条给出「被否决的是什么 / 否决理由（尽量逐字）/ 若重提需要先推翻什么」。

### 3.1 `auto_reject` 延期，而不是作为惰性第三选项发货（OD-L4-2(a)）

- **被否决**：在 `ApprovalType` 里同时声明 `auto_reject`，前端「审批类型」单选里放上第三个（当前不生效的）选项。
- **理由**：§4 的已批准文本是 *"auto_approve only, auto_reject deferred… **no inert third option**"*。
  实现侧把这条落成了**类型层面**的事实：联合类型与 `APPROVAL_TYPES` Set 都不含它，`normalizeApprovalType` 拒绝集合外任意字符串，
  于是它在发布期「不可达」而**无需在任何地方声明它**（代码注释逐字见 §2.1）。
- **为什么这比「声明但禁用」更好**：一个声明了却不生效的枚举成员是一份**对外承诺**——DTO/OpenAPI 会带上它、
  客户端会看见它、后续的兼容性论证会被它绑住；而它背后并没有一个已批准的语义。M7/M8 的诚实语言要求
  「不做惰性接受」。这与 Lock-7b OD-L7B-3 的同型判断一致：审批节点上的 `required` 是**发布期值自由拒绝**，
  而不是「接受了但不生效」。
- **重提前提**：owner 对 `auto_reject` 的独立裁决（拒绝语义、审计动词、与 `emptyAssigneePolicy` 的交互）。

### 3.2 `'designated'` 独此一种，且**不建**反向管理员查询（OD-L4-3(a)）

- **被否决 (c)**：按权限码**反向枚举**出「谁是审批管理员」。
  理由逐字：*"no shipped reverse query, three grant channels, wildcard holders, no org scoping"*。
- **选定 (a)**：转审批管理员由**指定**该 admin 角色来表达（作为 `static_user`/`static_role` 形状的回退目标），
  复用同一条 `resolveApprovalAssignees` 路径。
- **必须一并记的代价**：OD-L4-3(a) 推荐的那个用法（指定审批管理员**角色**）**恰好落在 Gate B-2 未覆盖的空角色情形上**
  （§2.2）。所以「不建反向查询」是对的取舍，但它把「角色成员为空」这一情形推给了一个**尚未存在的机制**
  （resolver 内实时读被 Lock-1 §2.1 禁止；frozen-snapshot 机制未建）。**这是设计缺口，不是实现疏漏**，需 owner 裁决。

### 3.3 `approvalType` 是配置字段，不是新节点类型（OD-L4-1(a)）

- **被否决 (b)**：新增节点类型。理由逐字：*"three executor walks + totalSteps + parallel guards = Lock-3 blast radius"*。
- **含义**：新节点类型会迫使三处执行器遍历、`totalSteps` 计算、并行守卫同时改动——那是 Lock-3 的爆炸半径。
  作为配置字段则只需要一个发布期归一化 + 一个派发期分支（§2.1），且天然继承既有的并行/条件分支规则。

### 3.4 `samePersonPolicy` 住进既有优先级，而不是另开一套（OD-L4-4(a)）

- **被否决 (b)** 只做模板级；**被否决 (c)** 新开一套形状不同的优先级规则，理由逐字：
  *"two precedence rules for one composing family"*。
- **同族能力有两套优先级 = 作者永远算不清最终生效值**。选定 (a) 后，节点级 enum 落在既有 `autoApprovalPolicy`
  覆盖优先级里，晚绑定由 `getEffectiveSamePersonPolicy` 统一提供（§2.3）。
- **未决的边角**：同一载荷内 `samePersonPolicy:'auto_skip'` 与显式 `mergeWithRequester` 冲突时谁胜——
  实现选了前者胜，**锁文没裁**（§6.4 第 2 项）。

### 3.5 空审批人时「座位不产生」，而不是创建期 422、更不是回落 `self_approve`（OD-L4-5(a)）

- **被否决 (b)** 创建期 422：把一个**运行期**才可知的条件提前到创建期，会拒掉大量合法模板。
- **被否决 (c)** 回落 `self_approve`，理由逐字：*"hands the approval to the person the policy exists to exclude"*
  —— 把审批交给这条策略本来就是为了排除掉的那个人。这是**fail-OPEN**，方向性错误。
- **选定 (a)**：座位不产生，由 `emptyAssigneePolicy` 治理（`'error'` 缺省 ⇒ `APPROVAL_ASSIGNEE_EMPTY`）。

### 3.6 离职检测挂在目录 deprovision 信号上，而不是派发期实时读、也不是动作尝试期（OD-L4-8(a) / OD-L4-9(a)）

- **被否决 OD-L4-8(b)**：用本地 `users.is_active=false` 当离职信号。理由逐字：*"an ops suspension, not a departure"*
  —— 停用是运维动作，不等于离职，语义不同不可混用。
- **被否决 OD-L4-9(b)**：派发期实时读。理由逐字：*"breaks Lock-1 §2.1 purity for every approval"*
  —— 为了一个小概率场景，让**每一次**审批派发都付出一次目录读，并破坏 resolver 的纯净性（Lock-1 明文禁止）。
- **被否决 OD-L4-9(c)**：动作尝试期处理。理由逐字：*"the departed user can never act, so the task deadlocks until an
  admin intervenes — today's behavior"* —— 这正是**今天的行为**，也就是这个能力要修的那件事。
- **选定 (a)**：带外（out-of-band）挂在离职信号上，仿照 SLA 转派效应，**resolver 保持纯净**。
  代价已在 §2.4 记账：**派发链本切片未接线**，且 `DIRECTORY_DEPROVISION_ENABLED` 按 org 默认 OFF。

### 3.7 F4-E 的审计动词是 `reassign` 而不是 `transfer` —— 一条跨线钉点取舍

这是本轮设计上最漂亮的一条，因为它避开的是一个**跨线的、静默的**破坏。原文 `[源读]`
（`ApprovalProductService.ts:8219-8224`）：

> *"Audit verb is `'reassign'`, NEVER `'transfer'` — `'transfer'` is one of the four actions the revoke-window guard
> counts (`action IN ('approve','reject','transfer','handle')`, scoped to `metadata->>'nodeKey'`); a departure writing
> `'transfer'` would silently close the requester's revoke window as a side effect of an approver leaving. `'reassign'`
> is the verb `bulkReassignApprovals` already uses and is already admitted by the CHECK constraint — no new verb,
> no bootstrap bump, no migration."*

拆开看它同时满足了三件事：

1. **语义正确**：撤回窗口的关闭条件是「**有人真的处理过**」。审批人离职是**系统事件**，不是处理动作；
   若写 `'transfer'`，发起人的撤回窗口会因为「某个审批人离职了」而被悄悄关掉——一个用户完全无法归因的行为变化。
   顺序上它甚至不会报错，只会**少一个本来可以做的操作**，属于最难被发现的一类缺陷。
2. **零爆炸半径**：`'reassign'` 是 `bulkReassignApprovals` 已在用的动词，**已被 CHECK 约束接纳** ⇒
   **不新增动词、不 bump bootstrap 版本、不加迁移**。本仓有明确记录（`finding_approval_action_verb_pinned_copy_blast_radius`）：
   新增一个 action verb 会撞上七处钉点，包括 attendance P26 的 union 守卫与 bootstrap 版本 pin，而**审批门看不见 attendance 线**。
3. **可复用既有分类**：审计消费方无需为一个新动词写分支。

**重提前提**：若将来确实需要区分「离职转派」与「管理员批量转派」，正确做法不是改动词，而是在 `metadata` 上加判别位，
或先做一次完整的 verb-union 全仓 census 并把七处钉点一并更新。

### 3.8 普查机制的五轮演进：为什么「形状模式枚举」被放弃，以及第五轮为什么换的是机制而不是正则

这是 Lock-7b（#5026）的核心工程叙事，也是本轮最贵的一课。**草稿写就时这条链停在第四轮（FIX-ROUND）；
本次重锚补入第五轮与其后的收尾提交，链条已闭合并落地。** 目标物是
`packages/core-backend/tests/unit/approval-field-access-enum-mirror.test.ts`；被守护的已批准属性是 **G-14**
（九处 §0.4 站点按**精确集合**断言，且**站点清单本身**也被断言 ⇒ 后来新增的第十份副本会让普查变红，而不是无声通过）。

| 轮次 | 制品 | head（裁决作用域） | 裁决 | 该 head 上的机制 | 找到的规避通道 |
|---|---|---|---|---|---|
| **0（文档评审）** | `lock7b-review-20260820.md` | 草稿 `b85987d3ed` | **REQUEST-CHANGES**（2 P1 / 4 P2 / 5 P3 / 4 NIT） | — | P1-1：在主流载荷形状下执行点够不到冻结 schema ⇒ 一键 client bypass ⇒ 促成 **OD-L7B-11** |
| **1（实现闸）** | `lock7b-impl-gate-20260820.md` | `0a4827214d` | **FIX-ROUND**（0 P1 / 1 P2 / 3 P3 / 2 NIT） | 六条 `shapePatterns`，**只匹配四成员形式**（`:155-159`） | **P2-1**：一份陈旧的**三成员**副本——正是普查存在的意义所在的那个漂移类——不被识别为载体。探针（3 成员 union + Set + guard）→ 普查 **14 passed (14)**；四成员正控 → **1 failed \| 13 passed**。逐字：*"The gate detects only copies that are already correct."* |
| **2（复核 #1）** | `lock7b-requal-20260820.md` | `f17cfef923` | **FIX-ROUND**（P2-1 真闭合；新增 R1 / R2 两条 P2） | **成员数无关**，但仍限于六个具名形状族 | **R1 —— 仍有 8 种形状可规避**，每一种普查都停在 `23 passed (23)`：B1 双引号 union · **B2 `!==`/`&&` 链 —— 恰恰是 C-4 自身在 Lock-7 上已发货的写法，也就是这条普查要防的那一个历史漂移实例的原始语法** · B3 `switch` · B4 匿名 rank map · B5 注释穿插 · B6 const 间接 · B7 块式 YAML（OpenAPI 的常规写法） · **B8 `.vue` 模板属性 —— 真正的作者面用的就是这个形状**（`ApprovalGraphNodeConfigEditor.vue` 就在被扫描的树里带着一份四成员手写副本，且不可见）。三条控制探针确实变红 ⇒ 探针非空转 |
| **3（复核 #2）** | `lock7b-requal2-20260820.md` | `57e8dd6673` | **FIX-ROUND（一条 P2）**；R1 的十一种形状**全部变红** —— *"the rebuild met its stated goal"* | **字面量共现** + 邻近聚类（`PROXIMITY_WINDOW` 150 B） | **R7 —— cluster-merge 吞并**。`clusterOccurrences` 传递地串联，且逐簇判定短路：`isComplete` 为真就**根本不查 allowlist**。一份陈旧三成员副本只要落在**任意**一个 `'required'` 出现点 150 B 内，就会并入四成员簇而**在完全不涉及 allowlist 的情况下通过**。**七次复现**，其中 N5a（把陈旧 const 放在真源文件里 `NODE_FIELD_ACCESS_VALUES` 正上方）→ `42 passed`；N5-CONTROL（同一 const 放到 ~4.9 KB 外的文件尾）→ `1 failed`。制品**两处自述与事实相反** |
| **4（复核 #3）** | `lock7b-requal3-20260820.md` | **`a48b447886`** | **FIX-ROUND（一条 P2）** | v3 `TS_DECLARATION_BOUNDARY_RE` + v4 逐文件完整计数 pin。基线普查 **43 passed (43)** | **R8 —— 共享声明攻击**。`TS_DECLARATION_BOUNDARY_RE = /^(export\s+)?(const\|let\|var\|type\|interface\|enum\|function\|class)\b/gm` **只在第 0 列触发** ⇒ 两个第 0 列声明之间的一切算作**同一个单元**，**整个函数体也在内**；同单元内的陈旧副本永不跨界，`spansDeclarationBoundary` 恒为 `false`，合并后的簇取 `isComplete`；又因为这次合并是**扩展一个已计数的簇**，v4 的计数 pin 同样什么也不说 |
| **5（复核 #4，终局）** | `lock7b-requal4-20260820.md` | **`a96ab8ae2b`** | **MERGE-CLEAN**，取代前四份裁决 | **机制修复 v5（`c3a0a9441a`）：换掉机制，不是再改正则。** 三件事同时做：(i) 手写副本**塌缩成从规范 tuple 派生的单一元组**（消灭载体本身，而不是更好地检测载体）；(ii) `.ts` 与 `.vue` 的 `<script>` 用 **TypeScript AST**（`ts.createSourceFile` + 最内层语句包含判定）给出声明边界，取代第 0 列正则；(iii) **声明本身被降级**为 *"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP, NOT THE PRIMARY GUARANTEE"*。基线普查 **50 passed (50)** | **不再是「找到新通道」，而是「承认这条路径有一族固有残留并逐条具名」**：残留 (a)–(j) 写在制品自己的 docstring 里，其中 **(i) SAME-STATEMENT SHARING 被评审现场复现且静默（50 passed）**——制品**自己**已逐字披露 *"the compiler does NOT catch this either"*。评审判定这是「尽力而为路径的固有形状、已被精确具名、且树内无活载体」，**不阻塞** |
| **6（裁决之后、落地之前）** | **无制品——没有任何闸门审过它** | **`29b28b1f50`** | **未过闸** | 移除 `@vue/compiler-sfc` 依赖，改用内联 `<script>` 块抽取器；TS-AST 归属路径不动。新增残留 **(j)** | **这一个提交本身就是一次治理事故的修复**，见 **§3.8.2**。它是**实际落地的那个 head**，而 MERGE-CLEAN 绑的是它的**父提交** |

**R8 的证据（requal3 §2，当前的阻塞发现）：**

| 探针 | 放置位置 | 结果 |
|---|---|---|
| **P-A1** | 在 C-6 的四成员规范检查**正下方**再放一份陈旧 `if (['editable','readonly','hidden'].includes(...))`，同一个 `validateApprovalNodeEdits` 函数体内 | **43 passed —— 静默** |
| **P-A4** | 同一函数体内、该检查上方的缩进 `const LEGACY_ACCESS = […]` | **43 passed —— 静默** |
| **P-A5** | `ApprovalGraphNodeConfigEditor.vue` `<script setup>` 内紧邻 `FIELD_ACCESS_LABELS` 的缩进 `const LEGACY_LABELS = {…}` | **43 passed —— 静默**（评审者自标为「机制演示，非现实漂移」） |
| **P-A1-CONTROL** | 字节等价的清单放进它**自己的**第 0 列 `export function`（文件尾） | **1 failed** —— `approvalNodeEdit.ts @30780-30812 :: {editable, hidden, readonly}` |
| **Y1**（YAML 半边） | `packages/openapi/src/base.yml` 中 C-8 下的 `x-legacyFieldAccess: [editable, readonly, hidden]` | **变红** —— `base.yml @109609-109635` |

机制由**插桩**确认而非推断：P-A1 下 `scanned` 转储给出单簇
`{"s":26285,"e":26485,"m":["editable","hidden","readonly","required"],"span":false}`，
对照基线 `@26285-26329`（44 字节）—— **起点相同、跨度向后延伸 156 B 把陈旧副本吞掉**，`isComplete === true`，
`completeCounts[...]` 仍为 **1**（= 它的 pin）。
爆炸半径也被记下以防修复被特判成只针对 C-6：`isNodeFieldAccess`（`apps/web/src/approvals/templateAuthoring.ts:536`）属同一类；
探针 P-A2 **确实变红了，但走的是 C-7 SITES 抽取器正则，不是被测的普查机制** ——
逐字：*"extractor fragility, not the boundary gate doing its job."*

**作用域纪律（逐字随行）**：*"No live site is masked today: at this head every SITES mutation still reds (§4),
and R8 requires a NEW stale copy."* —— 也就是说 R8 是**复发通道**，不是当下的活漏洞。

#### 3.8.1 从这条链得到的设计结论

1. **形状模式枚举不收敛。** **前四轮**里每一轮都关掉了上一轮的机制，又立刻暴露出下一条通道
   （只认四成员 → 只认六个形状族 → 字面量共现 → 邻近聚类 → 列 0 边界）。这正是本仓已记录的
   `feedback_trap_enumeration_does_not_converge`：*"逐点堵陷阱每轮出新通道；正解 = 单一 inert 门 + 遍历导出表的机械断言"*
   —— **复核 #1 自己就引用了这条**，而机制随后仍然沿着枚举方向又走了两轮。
2. **判据本身要被攻击。** 每一轮的失败都不是「测试没跑」，而是「测试跑了、判据够不着」。
   `feedback_gate_the_mechanism_not_the_claim` 与 `feedback_attack_your_own_criterion` 在这里同时成立。
3. **改名不等于关闭。** R1 与 R8 两轮都被点名了同一条：把测试改名/缩小声明只是**记录**了缺口而不是**关闭**它；
   而**收窄 G-14 的已批准属性是 owner 处置，不是自证式修复**（`feedback_second_narrower_artifact_is_contract_narrowing`）。
4. **🔴 本条在重锚中被更正。** 草稿说「编译器优先 + TS-AST 兜底不是已发货的机制」——那句话在草稿的观测时点
   （`a48b447886`，2026-08-20 12:25–12:33 +0800）**是对的**，但它**现在已经作废**。
   TS-AST 于 **`c3a0a9441a`**（机制修复 v5）落地，随 #5026 以 `5feca2291b` 进入 main。**在 main 上机械复核** `[执行]`：
   `git show 5feca2291b:…/approval-field-access-enum-mirror.test.ts` 内 `ts.createSourceFile` 命中，
   残留清单 (a) 至 (j) 十条逐条在案（`(f)` 与 `(g)` 自标 CLOSED，其余八条为开放残留）。
   **这是本文档里唯一一条从「未核实 ⇒ 明确不是既成事实」翻转为「已落地」的条目**，草稿的旧结论必须整段作废，
   不得被后续文档以任何形式继承。
5. **第五轮的关键不是「用了 AST」，而是「换了机制而不是再改一次正则」——这才是可复用的那条教训。**
   前四轮每一轮都在**同一个机制家族内**做得更细（只认四成员 → 只认六个形状族 → 字面量共现 → 邻近聚类 →
   第 0 列边界），因此每一轮都必然存在一个更窄的规避形状。第五轮同时改了三处**层级**：
   - **消灭载体，而不是更好地检测载体**：手写副本塌缩成从规范 tuple 派生的单一元组 ⇒ 没有副本，就没有副本漂移；
   - **换掉判据的来源**：`.ts` 与 `.vue` `<script>` 的声明边界由 **TypeScript 解析器**给出（`ts.createSourceFile`
     + 最内层语句包含判定），不再由「第 0 列正则」近似 ⇒ 不再依赖 150 字节这种魔数；
   - **把声明降到它实际担得起的强度**：*"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP,
     NOT THE PRIMARY GUARANTEE"*。
   **「编译器是主门」这一句是被证明过的，不是被声称的** `[制品]`：评审亲手往规范 tuple 里加了第五个成员
   `'archived_TEETH_PROBE'`，四个格子逐一变异并 `cp` 还原 + sha256 校验：后端 tuple + `tsc --noEmit` → **RED，
   `TS2741` at `approval-form-redaction.ts` 的 `NODE_FIELD_ACCESS_RANK`**；FE tuple + `vue-tsc -b` → **RED，
   `TS2741` at `ApprovalGraphNodeConfigEditor.vue` 的 `FIELD_ACCESS_LABELS`**。
   ⚠️ **同时必须带走该证明自己的两条边界**（评审逐字，本文不取干净版）：
   - 交叉格 **B / D 是绿的** —— 后端与 FE 是两份独立字面量，往一侧加成员**不会**让另一侧的 `Record` 站点变红。
     制品里那句 *"Add a fifth member to **either** tuple and `tsc`/`vue-tsc` red at **every** `Record<NodeFieldAccess, …>`
     site immediately"* 按严格全称读**是假的**；跨侧一致性是由普查自己的 `SITES` 等值断言兜住的（探针 X1 实测变红）。
   - `NODE_FIELD_ACCESS_WRITABLE_VALUES` **会**静默吸收第五个成员——它是**刻意的子集**，在其声明处已披露，
     且「编译器主门」那句声明本身就限定了 *"for the sites it covers"*。记录在案，**下一轮不得把它当作新发现**。
6. **降级声明之后，G-14 是否仍被满足，是 owner 裁决项。**
   G-14 的已批准属性是「九处站点按**精确集合**断言、站点清单本身也被断言 ⇒ 第十份副本会让普查变红」。
   一个自认 *best-effort backstop* 的扫描器**是否仍然承得起这条已批准属性**，正是
   `feedback_second_narrower_artifact_is_contract_narrowing` 点名的那个形状（锁点名 A，交付了 A'）。
   **本文把它记为 owner 裁决项（§6.4），不记为已解决。** 注意这与 requal3 当初给 R8 开的补救路径 (2)
   （「收窄 G-14 的已批准属性 ⇒ owner 处置」）**是同一条**——第五轮换掉机制并没有让这条消失，只是让它换了个位置出现。

#### 3.8.2 治理钉点事故：一个 devDependency 让三条 Sealed-export 闸门变红，而闸门把它归错了因

**这一节记的是本轮最值得带走的一次事故**，因为它同时命中三条已记录的教训，且**闸门没有抓住它**。

**因果链，逐条机械核实** `[执行]`：

1. 机制修复 v5（`c3a0a9441a`）为了用真 SFC 解析器切分 `.vue` 的 `<script>` 块，把 **`@vue/compiler-sfc`
   加为 `packages/core-backend` 的 devDependency** ⇒ **`pnpm-lock.yaml` 被改动**（`git show 29b28b1f50` 反向可见：
   `package.json` −1 行、`pnpm-lock.yaml` −3 行）。
2. **`pnpm-lock.yaml` 同时是两样东西**：
   - `.github/workflows/sealed-export-s5-sqlserver.yml` **L46 的 path-filter 触发项**；
   - `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` 里
     **`id: 'pnpmLock'` 的 digest 钉点**（L211-214）。
3. ⇒ 改一行 devDependency 同时**触发**了那条 workflow **并且打破**了它要校验的钉点。
   **三个作业变红**，在 `c3a0a9441a` 与 `a96ab8ae2b` 上均为 `failure` `[执行]`：
   `Sealed-export S5 evidence and S6-A runtime-authority gate` · `Sealed-export S5 SQL Server 2019 product action` ·
   `Sealed-export S5 SQL Server 2022 product action`。
4. 🔴 **闸门把它归错了因。** requalification #4（绑 `a96ab8ae2b`）把这三条红判为
   *"non-required, pre-existing … not attributable to this PR"*，理由逐字是 *"this PR changes no file under `plugins/`"*。
   **这条推理在结构上是错的**：钉点的**输入**是一个仓根文件（`pnpm-lock.yaml`），不是 `plugins/` 下的文件。
   闸门同时正确地核到了 *"`plugin-tests.yml` 与 origin/main 逐字节相同（0 行 diff），所以已知的 s6a re-pin 不适用"*——
   **它检查了上一次同类事故的那个钉点，而这次踩的是另一个钉点。**
   ⇒ 这正是 `feedback_search_for_the_mechanism_before_building_it` 的镜像形态：**闸已存在、也被查了，
   但查的是隔壁那一条**。
5. **修复发生在裁决之后**（`29b28b1f50`，无任何闸门审过它）：移除该 devDependency，把
   `package.json` 与 `pnpm-lock.yaml` **还原到与 main 逐字节相同**（`git diff 5ab052449b 29b28b1f50 --
   packages/core-backend/package.json pnpm-lock.yaml` = **空** `[执行]`），并用一个**内联的 `<script>` 块抽取器**
   替代该依赖；**TS-AST 归属路径（本轮真正的收获）原样保留**。新定位启发式作为残留 **(j)** 登记在制品自己的清单里。
6. **修复的验证形状要如实记，不得取巧**：
   - **决定性闸门** `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`
     → `OK`，**exit 0**。⚠️ 本次重锚**在重锚后的 exact-main（`5feca2291b`）的独立 detached worktree 上亲跑了这一条** `[执行]`
     （worktree @ `5feca2291b`，跑前跑后 `git status --porcelain` 均空）——**不是**在会话工作树上跑的
     （后者与 main 差 762 个文件、`plugin-tests.yml` 差 194 行，在那里跑出来的绿**没有任何证据力**）。
   - 提交自述另有一条机械证明：新抽取器在**当前普查行走的全部五个 `.vue` 文件**上给出的字节偏移与
     `@vue/compiler-sfc` **完全相同** `[制品 —— 本文未复算]`。
   - ⚠️ **在 `29b28b1f50` 上，Sealed-export 车道的 check-run 数是零** `[执行]`。也就是说它的「绿」是
     **因为 path-filter 不再匹配而根本没触发**，**不是**一次重跑变绿。**这两件事不可互换**，
     本文按前者记（`feedback_triggered_is_not_verified`：没跑过的 workflow 不构成证据）。

**这条事故属于哪一类（这是它值得单列的原因）**：它与 §4.4 记的 `plugin-tests.yml` s6a digest-pin 事故
**是同一类，不是一次性意外**——**「一个看起来纯粹是本地开发依赖的改动，改到了另一条线用作 provenance 输入的文件」**。
这一类的共同特征是：(a) 触发面与钉点面是**同一个文件**，所以改动会同时点火并打破它；(b) 承受方是**另一条线**
（stock-prep / sealed-export），审批线的闸门**看不见**它；(c) 症状是若干条**非必需**检查变红，因此很容易被
「不是必需项 + 不是我改的目录」两步推理放过去。**正确的动作是：任何触碰 `pnpm-lock.yaml` /
`package.json` / 任一 `.github/workflows/*.yml` 的审批切片，合并前必须对全仓 provenance 钉点表做一次
机械枚举**（`sealed-export-package-provenance.cjs` 的 pinned-file 列表 + `plugin-tests.yml` 的 s6a sha256 pin），
**而不是按目录归因**。这与仓内既有教训
`finding_approval_action_verb_pinned_copy_blast_radius`（新增 action verb 撞七处钉点，审批门看不见 attendance 线）
是同一个形状的第二个实例。

### 3.9 被闸门拦下的四个设计错误（记录为「不要再这样做」）

这些不是实现瑕疵，它们各自都是一个**设计判断**被做错了，因此写在取舍章而不是缺陷附录。

**(a) 一个新 KEY 必须在一个切片里移动四条 allowlist —— 否则它是惰性的，或者更糟。**
F4-B 的 `emptyAssigneeFallback` 最初只加进了后端 rebuild 展开（allowlist 1），
`templateAuthoring.ts:873-890`（`BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS`）与 `:1193-1218`（线性编辑器 `allowedConfigKeys`）没带。
后果是：**一次受支持的 API 保存就让模板在两个编辑器里都变成只读**，且 UI 上没有任何路径能移除该键（恢复需要再调一次 API）；
同时画布上那句只读文案「后端不会保留的配置（保存将丢失）」**变成事实错误**。
闸门用四路探针表证明了这一点（正控：已知惰性键 `signaturePolicy` 给出逐字节相同的字符串；负控：普通审批节点 → `null` 可编辑
⇒ 谓词是**按键选择**的而不是一刀切）。**闸门拒绝了「§2.1 后端优先」这条辩解**：§2.1 说的是**已渲染开关**，
而 §2.3 是关于**新增键**的另一条不变量——*"both move four sites in ONE slice"*；紧邻的前一个切片
（Lock-5 `nodeOperationPolicy`）就是这么做的，并且在 `templateAuthoring.ts:884-889` / `:1210-1216` 白纸黑字写着。
闸门定性逐字：*"narrowing a mandatory gate (X-2) to 'allowlist 1 of 4' is a contract change, not a reviewer-waivable scoping call."*
**闭合方式不是削弱**：M1（从 allowlist 2 删）**恰好**红 COMPLEX 那条；M2（allowlist 3）**恰好**红 LINEAR 那条；
M3（`emptyAssigneeFallbackHasBackendDrop → false`）**恰好**红 backend-reject-shapes 那条；删掉 allowlist 1 ⇒ 6 条红
⇒ **四条 allowlist 各自承重**。
另需记：**天真的修法会让情况更糟** —— 只补 allowlist 而不动别处，会把 P3-2 的 X-3 flatten 隐患**暴露出来**
（同轮通过删除 `templateAuthoring.ts:777` 的强制转换一并关闭）。

**(b) 一个「已渲染的开关」会自我还原 —— 这是活的 fail-OPEN，且由本切片引入。**
F4-C 的 PR body 曾断言「手工携带 `approvalType` 或 `samePersonPolicy` 的模板在两个 FE 编辑器里都只读往返」。
闸门机械证伪：线性图上 `autoApprovalPolicy.samePersonPolicy` → `unsupportedTemplateAuthoringReason` 为
**`null`（可编辑）**，而 `totallyUnknownKey` 正控非空、baseline 负控为 `null`。
机制：线性分支（`templateAuthoring.ts:1194-1218`）**只看顶层键**，而 `autoApprovalPolicy` 是被允许的顶层键，
于是复杂路径才跑的嵌套 `BACKEND_AUTO_APPROVAL_POLICY_KEYS` 检查（`:1067`）在这条路径上根本不跑。
接着：作者把「自动跳过」**关掉** → `buildApprovalGraph` 发出 `autoApprovalPolicy:{"samePersonPolicy":"auto_skip"}` →
后端 `normalizeAutoApprovalPolicy`（`ApprovalProductService.ts:732`）**重新合成 `mergeWithRequester:true`**。
**经真实 HTTP API + Postgres 端到端复现**（不是推断）：`PATCH` 用 apps/web 在开关关掉后**恰好会发的那份配置** → **200 OK**，
存储值**未变**。逐字：*"The save succeeds and the deleted flag is back."*
影响逐字：*"the requester's seat keeps being auto-approved away against the author's explicit instruction. That is a
fail-OPEN on an already-rendered control, and it is **introduced by this slice**"* —— 在此之前 `samePersonPolicy` 根本存不进去。
**闸门拒绝了「只改文档」的处置**：*"an accurately disclosed self-reverting toggle is still a self-reverting toggle"*。
教训与 (a) 同源：§2.3 的四 allowlist 算术落在了「或者更糟」那一侧。

**(c) 一个断言「相同结局」的控制组没有任何判别力。**
Gate A-3 的已批准命题是：在一个 `auto_approve` 节点之后，指派给任意真人的后继节点**不会**被
`dedupeHistoricalApprover` 自动通过；其控制组应当是「同一位置上的**真人审批****会**触发去重 —— 豁免是按事件选择的」。
发货的夹具断言的却是**另一个命题**（真人审批发生在自动节点**之前**），且其配对测试断言的是*"the IDENTICAL outcome"*。
逐字：*"A control that asserts the same outcome as the test cannot discriminate anything"*。
闸门自己对着真 Postgres 把已批准的那一对构造了出来（`start → auto1(auto_approve) → manual2(P,…)` → `pending`、座位 = P ✅；
控制组换成真被审批的节点 → `approved` ✅）。
**更值得记的是修复轮在自己的修复里复现了同一个缺陷并自捉**（提交 `4944bdee5f` 的 message 逐字）：
*"the MERGE arm matched first and the dedup arm was never reached. The control's `approved` outcome therefore proved
nothing about `dedupeHistoricalApprover` specifically — **reproducing the exact 'outcome asserted, mechanism unverified'
defect this fix round exists to close**."* 最终修法是两份配置都去掉 `mergeAdjacentApprover` 并断言
`metadata.reason === 'auto-dedupe-historical'`，并给出**双向**变异证明。
（记录类别：`feedback_not_this_error_is_not_an_outcome_assertion`、`feedback_ineffective_mutation_looks_like_a_useless_test`、
`feedback_scope_deferral_shield_does_not_cover_new_lines` —— 修复轮引入同类新缺陷是常态，因此必须重跑全门。）

**(d) 车道自称的 anti-skip-green 哨兵是结构性惰性的 —— 删掉功能，而不是保留一个测不到的功能。**
F4-E 的 `approval-departure-transfer.db.test.ts` 起初对 `EXPECT_DB` **零引用**；其唯一哨兵（`:246`）被声明在
`describeIfDatabase(…)` **内部**（`:109` = `process.env.DATABASE_URL ? describe : describe.skip`）⇒
`DATABASE_URL` 缺失时整个 describe 跳过，**哨兵跟着跳过，永远不可能触发**。
机械证明（用车道自己的命令减去 DB）：`env -u DATABASE_URL EXPECT_DB=1 … run tests/integration/approval-departure-transfer.db.test.ts`
→ `Test Files 1 skipped (1) / Tests 7 skipped (7) / EXITCODE=0` —— **绿色退出，七条闸门测试静默跳过**。
两处虚假声明被定位（workflow 注释与 PR body 的「EXPECT_DB=1 armed」）。
它之所以是 P1 而非 nit：`vitest.config.ts` 的 exclude 把该套件从 `test (18.x/20.x)`（唯一默认跑它的车道）移除，
而替代车道**无法察觉自己的 DB 丢失** —— 逐字：*"This is the two-point wiring failing as a pair, not two separate nits."*
仓内已有正确范式：`approval-dedup-return-round-scoping.db.test.ts:45-46` 的 `itIfExpectDb`，是**顶层**的、在
`describeIfDatabase` 之外。逐字：*"The slice copied the workflow half of the pattern and not the test half."*

**同族的第五条（P5-C）**：focus-on-open 在生产里**可证明是死代码**，而它的四条测试之所以绿，是因为**夹具里没有真正的焦点陷阱**。
Element Plus 的 `<el-dialog>` 带 `focus-start-el="container"`，`ElFocusTrap.startTrap()` 链了**两个** `nextTick`
并以无条件 `tryFocus(trapContainer)` 收尾；而 `focusPrimaryControl` 只用了**一个** `nextTick` ⇒ **陷阱恒胜**。
三条控制：正控（jsdom 里裸 `textarea.focus()`）→ textarea；负控（发货 spec 的 **stub** `ElDialog`）→ textarea ✅（说明发货的绿是真的，但是在 stub 下）；
**真 `ElDialog`** → `DIV.el-dialog[...]` ⇒ 断言为假。判别性变异：neuter 掉该函数，stub 夹具下四条测试变红（说明它们对 stub 确实有牙），
**真 `ElDialog` 下则与保留该代码时逐字节相同**。
**选定的补救是「remedy 1：删干净」，而不是「让它工作」**：删除函数、四个 ref、四处模板绑定、`nextTick` 导入、四处调用点与整个 describe 块；
**结构性证明它不是被禁用而是被删除** —— stub 工厂 `makeFocusable`（当初 `expose({focus:…})` 才使那条断言得以存在）被换成**没有 `expose`** 的
`makeFieldStub`，逐字：*"the harness can no longer express the assertion."* 全仓 grep 六个符号 → 零命中；spec 18 → **14** 条，
必跑车道 4942 → **4938**（恰好 −4）。
**并且撤回扫描本身又被审了一遍，发现漏了一处** —— `run-required-web-tests.sh:301-302` 仍在声称该覆盖（NEW-P3-1），
由合并前最后一个提交 `563fbb2772` 修掉。
（记录类别：`feedback_mock_is_not_the_contract`、`feedback_css_verify_in_real_browser_not_jsdom`、
`feedback_absolute_claim_sweep_must_be_mechanical` —— 撤回必须机械地传播，**包括传播到 CI 的必跑清单**。）

---

## 4. 跨线爆炸半径与如何避开

审批线的每一次改动都要穿过若干条**别的线**钉住的对象。本轮显式导航过的有下面五处。

### 4.1 不新增 action verb

- **F4-E** 用既有的 `'reassign'`（§3.7）：不新增动词 ⇒ 不撞 CHECK 约束、不 bump bootstrap 版本、不加迁移、
  不撞 attendance P26 的 verb-union 守卫。
- **Lock-7b OD-L7B-8** 把「no new action verb」写进非目标；
- **Lock-9 草案 G-10** 更进一步，把 `APPROVAL_ACTION_TYPES`（`types/approval-product.ts:60-73`）**逐字节不变**做成一条闸门断言
  （*"adding a verb to the const reds an exact-set census test"*）`[源读，PR #5011 head]`。
- **背景记录**：`finding_approval_action_verb_pinned_copy_blast_radius` —— 新增 `handle` 类动词曾一次撞上七处钉点
  （含 attendance P26 union 守卫、bootstrap 版本 pin、admin-jump 测试），而**审批门看不见 attendance 线**。

### 4.2 不 bump bootstrap 版本、不加 DDL

- F4-A / F4-B / F4-C / F4-E 全部**没有迁移**：新语义都落在既有 JSON 配置与既有列上。
- Lock-7b 的 OD-L7B-8 明确：无 DDL、无新动词、无 bootstrap bump、无 flag；
  **DTO / OpenAPI 枚举加宽是本切片唯一一个刻意的例外**，且由 OD-L7B-10 约束——四份**生成**副本由 CI 重新生成，**永不手改**。
- 反例（供对照）：Lock-9 草案自己承认它**需要**一次新迁移，并把它标为「ordered late, one-way-once-ON」的 DDL 隐患
  `[源读，PR #5011 head]`——这也是为什么它至今仍是 DRAFT。

### 4.3 attendance P26 普查碰撞 —— 本轮最典型的一次跨线事故与它的正确修法

**事故**：`test (20.x)` 与 `test (18.x)`（**required contexts**）在 head 上变红，由本 diff 引起 `[执行]`。
W4C-3b 的 **P26 普查**（`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:940` / `:991`，
由 `.github/workflows/plugin-tests.yml:741` 执行）要求**每一个 `approval_assignments` DML 站点都被显式分类**，
而本切片新增了一个未分类站点。两条子测试失败：普查本身**以及它自己的计数漂移自测**（`2 !== 1`）。

**三点、按 diff 选择的证据** `[执行]`：GH Actions run `32272353058` 在 head → 两条腿 FAILURE；
本地 head → 2 failed，断言文本相同；本地干净 `origin/main` → `tests 58 / pass 58 / fail 0`。

**实现者为何漏掉**：PR body 引用了 `git diff origin/main -- .github/workflows/plugin-tests.yml` 为空。
**这句是真的，但不相关** —— workflow 没变，可它的 collector 步骤读的是**整个工作树的普查**。
闸门逐字点名了类别：*"the recorded 'CI green = run the CI steps' failure mode, and specifically the recorded
cross-line hazard 「审批门看不见 attendance 线」."*

**更深的缺陷是碰撞**（修复提交 `8e5ba9970c` 的 message 逐字）：
*"`applyApprovalDepartureTransfer`'s local `skip` closure collided, under the P26 census's nearest-preceding-declaration
heuristic, with `bulkReassignApprovals`'s own `skip` closure in the same file — both `UPDATE approval_assignments` sites
resolved to the identical key `ApprovalProductService.ts :: skip :: update`, **silently folding the new F4-E writer into
the already-reviewed `bulk_reassign_contract` entry** (count drift 1->2)."*

**正确修法 —— 在源头关闭碰撞，而不是在断言上放松**：把闭包**改名**为 `skipDepartureTransfer`，让每个写入器拥有
自己诚实归属的键，再把该键加进 `P26_APPROVAL_ASSIGNMENT_CLASSIFICATIONS`
（`scripts/attendance/w4c0-dml-inventory/p26-approval-assignment-classification.cjs:35-42`，owner `departure_transfer_fail_closed`）`[源读，已在 main 上核实]`。
逐字：*"No census assertion was weakened; the collector's own count-expectation tests needed no edits once the underlying
collision was removed"* —— 复核独立确认：collector 自测文件**不在 diff 里**，故 `:991`/`:997` 逐字节未变。

**归属方向被验证而非假定**（改名式修复完全可能一边保持绿一边把写入器归错档）：带物理行号的原始普查转储给出
`7813 update skip → bulkReassignApprovals` / `8237 update skipDepartureTransfer → F4-E`；四条探针 `[执行]`：
**C1**（改 F4-E 那条的表名）只红**它自己**那条而不是邻居；**C2**（改闭包名）同时红 `unclassified` 与 `stale`；
**C3**（注入一个真正新的写入器）**逐字复现原始 P1-1 的失败签名** ⇒ 守卫未被 neuter；
**C4**（同一符号作用域内放第二个写入器）红 `countDrift expected 1, actual 2`
⇒ **`count: 1` 这个 pin 是承重的，新条目无法悄悄吸收未来的第二个写入器**。
**残留脆弱性被记录而非隐藏**：该启发式是「最近的前置声明」（`collector.cjs:302-338`），插入一个声明会导致重新归属并**变红** ⇒ fail-closed；
C3 还显示该启发式**不认识 TS 类方法** —— *"the exact mechanism the original collision arose from; a pre-existing property
of the collector, not of this diff."*
**交叉污染控制**：`UNREL-BULK` —— 变异 `bulkReassignApprovals` 自己的 `skip` 闭包体（F4-E 曾与之碰撞的那个符号）→ **9/9 绿**。

### 4.4 封存且 digest-pin 的 `plugin-tests.yml` —— 以及它其实只是**钉点面**的一半

> ⚠️ **本节在重锚中被扩写。** 本轮实际被撞到的钉点**不是** `plugin-tests.yml` 的 s6a pin（那条经核实是
> **0 行 diff**），而是 `pnpm-lock.yaml` 的 `pnpmLock` provenance 钉点。**同一类，另一个入口**，
> 详见 **§3.8.2**。因此本节的正确读法是：**「封存文件」不是一份可以背下来的名单，而是一张必须每次机械枚举的表。**

- 该 workflow 被封存并按 digest pin，**同改它必撞 s6a pin**（已记录：`feedback_s6a_pin_is_a_merge_bottleneck`）。
  本轮所有新真库套件都走**各自独立的 `approval-realdb-*.yml` 车道**，`plugin-tests.yml` diff 保持为空
  （#5024 显式验证过）。
- **代价与陷阱**：这样做把套件从 `test (18.x/20.x)` 的默认执行面移走，替代车道必须**自证 DB 未丢**
  —— 这正是 §3.9(d) 那条 P1 的成因。**正确范式**是 workflow 侧 `EXPECT_DB=1` + 测试侧**顶层** `itIfExpectDb` 哨兵，
  **两半缺一不可**（`feedback_realdb_test_two_point_wiring`）。
- 另需持续记账：Leg B（只在这条封存 workflow 内运行的）套件在 CI 上用的是 **PostgreSQL 14**，
  与 Leg A 独立车道的 `postgres:16` 不同。**草稿把这条记为「V-14 的真实债」；本次重锚必须更正它的性质**：
  PG14↔PG16 双臂实验跑完之后，这 38 个套件在两个大版本上**每臂 301 条测试、38/38 逐条同名同态、零差异**
  ⇒ 它**不再是一个未验证的正确性风险，而是一个已测量的配置选择**（§7.4）。**真正的债换了位置**：
  生产与预发的 compose 钉的是 **`postgres:15-alpine`**，而 CI 两条 leg 一条 14、一条 16，
  **没有任何一条、也没有本轮任何一臂跑过 15**。
  🆕 **2026-08-21 freshness 更正（绑 `13506666dae3`，详见 §9.3）：上面这句在 `5feca2291b` 上逐字为真，但它的两半今天都需要修订。**
  (i)「本轮任何一臂跑过 15」**已不成立** —— `postgres:15-alpine` 生产臂已在 `13506666dae3` 上跑完 **67/67** 套件、**588** 条测试全通过、**319** 条迁移 exit 0。
  (ii)「CI 两条 leg 一条 14、一条 16」仍成立，但把它当作「没有任何 CI leg 跑过 PG15」的证据是**不精确的**：
  `.github/workflows/smoke-verify.yml:11` 确实钉着 `image: postgres:15`（Debian glibc），只是它 **`workflow_dispatch` only、非 required check、不跑任何 approval 套件**；
  `.github/workflows/` 下 **alpine 出现次数 = 0**。⇒ 准确表述 = **没有任何 CI leg 在 PG15 上跑过 approval 真库套件，也没有任何 CI leg 用过 alpine 镜像**。
  ⚠️ 这条更正**不**授权任何「生产 PG 兼容性已证」的说法，禁令逐字见 §9.3。
- **§3.9(d) 那条 P1 的一般化形态，本轮被量化了**：`EXPECT_DB=1` 对 66 个 approval 真库套件中的 **41 个完全惰性**
  （它们根本不含任何 `EXPECT_DB` 引用；其中 29 个另有一条**看起来像**反 skip-green 守卫的
  `it('sentinel: DATABASE_URL …')`，但它坐在 `describeIfDatabase` **内部**，会连同整块一起被跳过）。
  分布不是随机的：**41 个惰性套件里有 38 个恰好就是 Leg B 全集**，25 个 live 哨兵**全部**在 Leg A。
  ⚠️ **这在今天的 CI 里不是活洞**（`plugin-tests.yml` 的 approval 步在 step env 里**硬编码** `DATABASE_URL`
  且 run 首行是 `: "${DATABASE_URL:?…}"`），**但它今天的安全性完全依赖「每条车道都记得硬编码 `DATABASE_URL`」
  这个惯例，而不是套件自身的性质**——惯例可以被下一条新 workflow 静默打破。
  **正确修法是单一机械门，不是逐点补哨兵**（`feedback_trap_enumeration_does_not_converge`）：枚举
  `tests/integration/approval-*`，断言每个文件都有一条 `itIfExpectDb` 且其行号**小于**首个
  `describeIf(Database|Db)(` 的行号；再加一条**车道侧**断言——凡点名这些文件的 workflow step 必须同时设
  `EXPECT_DB: '1'`。仓内已有可照抄的先例：`approval-wp1-any-mode.api.test.ts:104-110`。
  ⚠️ 另有一条必须随行的负控纪律：`packages/core-backend/.env` **被仓库跟踪**且写死 `DATABASE_URL`，
  所以**本地「不设 `DATABASE_URL`」不会 skip，而是静默连上 :5432 上任何在听的东西**——
  **负控必须用打死的端口构造。**

### 4.5 前端四条 allowlist 的算术

审批模板配置的每一个**新键**必须在**同一个切片**里穿过四条 allowlist（后端 rebuild 展开、
`BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS`、线性编辑器 `allowedConfigKeys`、以及后端 drop 判定），
否则它**要么是惰性的，要么更糟**（§3.9(a)/(b) 各是一个方向的实例）。这条不变量在仓内有前例可循
（Lock-5 `nodeOperationPolicy` 在 `templateAuthoring.ts:884-889` / `:1210-1216` 写着理由）。

### 4.6 required check 集合本身是一条时间序列，而且**审批车道不在其中**

| 观测时刻 | 数量 | 来源 |
|---|---|---|
| 2026-08-19（#5009 提交正文） | **9** 条，`strict=false`，无审批专属项 | `cf830d6736` commit message |
| 2026-08-19（F4-E 闸门，完整枚举） | **10** 条（含 `ssh host-key pin contract`） | `/tmp/p3a-f4e-gate-20260819.md:18` |
| 2026-08-20（收官 AC-12 / G10） | **11** 条，`strict:false`，`enforce_admins:true`，**required 集合里零条审批车道** | 收官 §3 闸池 G10 / AC-12 `[执行]` |
| **2026-08-20 12:33:13 +0800（本会话实测）** | **11** 条：`contracts (strict)`、`contracts (dashboard)`、`pr-validate`、`test (20.x)`、`contracts (openapi)`、`web-tests`、`stock-prep PowerShell 5.1 acceptance`、`attendance-web-guard`、`integration-guard`、`ssh host-key pin contract (fail-closed known_hosts)`、`observation-kit contract (read-only SQL census + runbook gating)`；`strict:false`、`enforce_admins:true` | `gh api repos/zensgit/metasheet2/branches/main/protection` `[执行]` |

**⇒ 设计含义（不是行政含义）**：本轮新增的 17 条 `approval-realdb-*` 车道**都不是 required**。
一条审批真库车道变红**今天不会挡住合并**。因此「合并时车道全绿」这件事在本轮是**观察到的事实**（#5023 的
`efaa553d71`、#5030 的 `563fbb2772` 都逐条核过），**不是被制度保证的**。是否把审批车道加入 required 集合
= **OWNER-ONLY（V-13）**。
⚠️ 实测 `strict:false` 与记忆记录「2026-08-14 strict=true 已恢复」**冲突**；收官把它记为**线上漂移**，非本轮失败；
成因未调查 `[未核]`。

---

## 5. 对标飞书 —— 本轮推进了哪些行

### 5.0 本节的基础与一条方法约束

本节**不**引用任何独立的「飞书对标行表」——本轮证据里没有这样一张表。下表严格由三处推导：
2026-08-18 开发报告 **§6.3 / §6.4** 的未完成清单、本轮 **11** 个审批合并的实际契约（§2 记 9 个 + §7.1 记 #5025/#5026 两个）、以及验证收官的 ADDED-AT-CLOSEOUT 行。
**凡是证据不足以支持「已达」的，一律记为「部分」或「未达」，不做向上圆整。**

### 5.1 本轮**移动了**的行（四条，且没有一条整行闭合）

| 行 | 08-18 态 | 本轮落地 | 本轮后的准确态 |
|---|---|---|---|
| **成员身份显示（不暴露原始用户 ID）** | 开发报告 §6.4 **D-10** 残留；对抗审 **F1** | #5010 / #5016 / #5019 | **部分达成。** 三处已知站点 + 两处新发现站点（含 requester_choice 提交期选择器、按发起人汇总）已修；缺失的姓名生产方已建（授权域内 `/directory/resolve`，复用既有权限并集）；人工清单已换成**机械枚举普查**（TIER A + TIER B `readdirSync`，未分诊命中即红）。**类不宣告闭合** —— 作用域逐字：仅 `src/approvals/**` + `src/views/approval/**`、仅那 6 个模式，**不是「全部原始 ID 渲染」** |
| **审批历史查询的授权姿态** | 与兄弟路由不一致 | #5024 | **已达（限 parity 这一件事：两种 id 形状拿到同一姿态；不含更广的 history 授权域）。** AC-7 = **8/8** `[执行·真库]`，含**两条判别性反例** + 两条正控 |
| **节点自动通过 / 同一审批人策略**（Lock-4 F4-A / F4-C） | §6.3 P3-A `NOT DRAFTED` | #5023 | **F4-A 已达（`auto_approve`）；`auto_reject` 未达（按 OD-L4-2(a) 延期，且刻意不作为惰性选项发货）。F4-C 已达（四值枚举 + 晚绑定生效值 + opt-out 保留）** |
| **成员动作对话框语法与 chrome**（P5-C） | §6.3 `NOT STARTED` | #5030 | **部分达成（P5-C-1）。** 台账行要求 mounted / browser / mobile / a11y **四腿**，本轮只交付 **mounted**；browser 推迟至 P5-C-3；mobile 未由本 PR 跑（既有红，非回归）；**a11y 腿为空而本轮恰恰新增了十处 a11y 属性**。**行不闭合，且台账行未被修改** |

### 5.2 本轮**看似移动、实则未达**的一行 —— 必须单列

| 行 | 表面 | 准确态 |
|---|---|---|
| **离职自动转上级**（Lock-4 F4-E） | #5022 落地；收官 AC-4 = **PASS，9/9 真库** | **未达（能力不可达）。** 落地的是**写入器** `applyApprovalDepartureTransfer`（`:8272`）及其真库验收；**从离职信号到该写入器的派发链在读取基线 `6cca7ec0ed` 上未接线** —— 全仓无 pathspec grep 显示零生产调用方，方法自身文档注释与车道注释都逐字这么说（§2.4）`[源读]`。另有独立限制：`DIRECTORY_DEPROVISION_ENABLED` 按 org **默认 OFF**。operator-warning 面属另一切片 |

**这一行的写法是本节的方法示范**：一个真库套件 9/9 全绿，证明的是**这一环**，不是**这条链**
（`feedback_verified_one_link_generalised_to_the_chain`：能构造 ≠ 能被调用 ≠ 能拿到数据）。

### 5.3 本轮**完全未动**的行

- **Lock-4 F4-D**（审批人去重档位）：OD-L4-6 三态单选投影、OD-L4-7 K3 接缝、OD-L4-10 回退轮次作用域 —— **一条未落**。
  且 **OD-L4-10 自带阻塞条款**：*"Gate D-3 cannot be written until this is decided; shipping a dedup switch without either
  is forbidden."* ⇒ F4-D **不是「还没写代码」，是「设计上被自己封住了」**，需先决 OD-L4-10。
- **`auto_reject`**（OD-L4-2 的延期项）。
- **Lock-2 剩余**：字段驱动的部门路由、department / contact **字段类型**（§L2-C 已由 K6 #4993 落地，其余 NOT STARTED）。
- **L5-B 后加签运行时**（OD-L5-4/5；Lock-5 §1.5：`'after'` 未实现、`signaturePolicy` 声明为惰性）/ **L5-E**。
- **K6 `sequential` 审批模式**（Lock-1 §K6；后端与前端 `ApprovalMode` 仍是四成员；且 master §8 把**节点内有序**列为
  **non-goal**，除非另开一份新的能力锁）。
- **L6-B / L6-C / L6-D / L6-E**、**L8-D `formula`**。
- ~~**Lock-7b 节点级必填**~~ —— **本条在重锚中移出「完全未动」清单**：锁文 #5025 与实现 #5026 均已落地
  （`5ab052449b` / `5feca2291b`），终局裁决 **MERGE-CLEAN**（§3.8 / §7.1）。⚠️ **但这不等于该对标行整行闭合**：
  v1 的可满足面**只有 handler 节点**（OD-L7B-3(a)），`explanation` / `record-link` / `attachment` 三种类型
  在发布期被显式拒绝并各自记了 reopen 条件（OD-L7B-9(a)）；且落地物的验证行 **AC-10 仍是 NOT RUN**
  ——没有任何收官车道判过它：**收官发生在读取基线 `6cca7ec0ed`（那时它还没落地），而重锚后的 exact-main `5feca2291b` 上没有跑过任何收官车道**（§7.1）。

### 5.4 与 08-18 两份报告的对账

两份报告在 `6cca7ec0ed` 上都在仓内（`docs/development/approval-parity-development-report-20260818.md` 与
`…-verification-report-20260818.md`），由 **#4997 `d8ac22c989`** 落地（2026-08-19T02:51:29Z）。

**#5009（`cf830d673612bf9a12789efb387adc84967c73ba`）是本节的脊梁**：Codex 对这两份 FINAL 报告返回
**REQUEST-CHANGES（verified）**，指其**过度宣称完成**。修复**只动措辞、不动证据**（提交正文逐字）：
*"No evidence, SHAs, PR numbers, gate verdicts, or counts were altered — only framing/summary sentences that misstated
what the underlying sections already say."* 四项更正：

1. 开发报告 §8 原说「所有剩余项都是 owner 专属」，与 §6.3（P5-C / P3-A / Lock-2 剩余 / L5-B 为 NOT STARTED 或 NOT DRAFTED）
   及 §7.2（CORE-PARITY 仍需 P5-C）矛盾。§8（及头部块、§6 标题里的同一断言）改写为把「全部落地」限定到
   **已执行/已批准的 45-PR 批次**，并列出**未开发的代码切片**：**P5-C、P3-A、Lock-2 剩余、L5-B 后加签运行时**，
   外加新识别的**原始用户 ID 渲染残留**（作为 **§6.4 D-10** 加入）。
2. 「12 文档锁」是错的 —— main 上恰好 **9** 份锁文档（Lock-0…Lock-8）。从 git 核出：
   **45 个已合并 PR = 9 个锁文 PR + 3 个其他文档 PR（#4935 / #4937 / #4866）+ 32 个能力实现 PR + 1 个残留硬化（#5004）**。
3. 验证报告加了文件头 caveat：**FINAL 指的是文档定稿，不是验证完成** —— 127 行矩阵未在**该报告自己的** exact-main 上重跑（V-1）、
   三类 UAT 全 NOT RUN、审批真库/浏览器车道不在分支保护的 required 集合内、PG15↔PG16 parity 未决（V-14）。
4. **三个完成标签全部维持 NO。**

**本轮相对这两份报告的净变化：**

| 08-18 项 | 本轮 | 之后的态 |
|---|---|---|
| §6.3 **P5-C** `NOT STARTED` | #5030 | **子切片 P5-C-1 落地，行不闭合**（§5.1） |
| §6.3 **P3-A** `NOT DRAFTED` | #5021 / #5022 / #5023 | **五族中四族落地（F4-A/B/C/E）**；F4-D 与 `auto_reject` 未落；**F4-E 是写入器落地而非链落地** |
| §6.4 **D-10** 原始 id 渲染残留 | #5010 / #5016 / #5019 | 五处站点修复 + 普查机械化；**类不宣告闭合** |
| V-1 / V-12 / V-7 / V-14 | 收官重跑 | **收窄但均未解除**（§5.5–§5.6） |
| flag 表（全 NOT RECORDED / NO / NOT RUN） | 未变 | 收官补了 attachments/FWB 的**行为级**核查与 Canvas 的源级核查（§8.2） |

**§6.4 仍未闭合的闸门项**（不得静默丢弃）：D-2（#4974 带两条未闭 P2 合入）、
**D-3（更正：#4946/#4948 已于 2026-08-19 对 `d8ac22c989` 复核为 REQUALIFIED-CLEAN，但
`gh api …/pulls/{4946,4948}/reviews` 仍为 0 ⇒ 不得写成「合入时闸门 CLEAR」）**、D-4、D-6、D-7、
D-9（*"已合并 PR 的合并后 squash SHA 基本都未被重新过闸"* —— 本轮**十一个**审批合并**全部复现**这一形状，
且 **#5026 是最严重的一例：连 pre-squash head 本身都没被过闸**，§0.2 / §7.1）、#4995 残留。

### 5.5 本轮验证态（对标声明的地基，必须与对标行一起读）

验证收官 `w4-verification-closeout-20260820.md`（472 行 / 61,173 字节，12:18 写成，**scratchpad-only，非仓内**）
在**读取基线 `6cca7ec0ed`** 上重跑，硬事实如下 `[执行]`：

- **PostgreSQL 16.14**（Docker `postgres:16`），四个**互相独立**的容器/库（L1 :5433 / L2 :5434 / L3 :5436 / L4 :5437），
  四库均 **325 迁移已应用 / 0 pending**。**「没有任何车道跑过 PG14 或 PG15 对照臂。」**
  ⚠️ **这句话只描述 W4 收官那四条车道，且在重锚中被后续工作部分超越**：收官之后另跑了一次
  **PG14 ↔ PG16 双臂实验**（两条独立车道 Lane A / Lane B），结果见 §7.4。**PG15 仍然从未被跑过**，
  而 PG15 恰好是部署 compose 所钉的版本。
  🆕 **2026-08-21 freshness 更正（绑 run SHA `13506666dae3`，详见 §9.3）：上面这句在 `5feca2291b` 上逐字为真，作为历史观测保留，但它已被 `postgres:15-alpine` 生产臂取代** —— 该臂已跑完 **67/67** approval 真库套件、**588** 条测试全通过、**319** 条迁移 exit 0（服务端 `version()` 亲证 `PostgreSQL 15.19 … aarch64-unknown-linux-musl`，镜像即三份部署 compose 所钉的同一 tag）。**V-14 残留第 1 轴（PG15 从未被跑过）已关闭、第 3a 半轴（服务端 musl）首次行使**；**第 2 / 3b / 4 / 5 轴仍未被触及，另新增第 6 条残留（lock7b 无跨大版本基线）**；**线上 `server_version` 仍未亲查**。⚠️ **禁止据此写「生产 PG 兼容性已证」/「musl 轴已关闭」/「生产数据库版本已验证」**，三条逐字禁令随行于 §9.3。
- Node/pnpm **不统一且如实记**：L1 **v20.20.2 / pnpm 10.16.1**（CI-exact，跑任何东西之前先切过来）；
  L4 **v25.9.0 / pnpm 10.33.0**（未切 ⇒ 证据保留项 **R-1**）；**L2 / L3 未记录 —— 不假设为 20** `[未核]`。

**127 行母矩阵分层（收官 @ `6cca7ec0ed` vs phase-A @ `680e93c018`）：**

| 层 | 收官 | phase-A | Δ |
|---|---|---|---|
| PASS | **51** | 21 | +30 |
| PASS-POSITIVE-ONLY | **36** | 63 | −27 |
| **FAIL** | **1** | 6 | −5（**但那一行换人了**，见 §5.6） |
| NOT-YET-LANDED | **0** | 8 | −8（全部转成有执行支撑的判定） |
| BLOCKED-ENV | **15** | 13 | **+2**（计划预测 −5，被证伪） |
| OWNER-ONLY | **20** | 16 | +4 |
| **NOT RUN** | **4** | 0 | +4 |
| 合计 | 127 | 127 | |

加上 **ADDED-AT-CLOSEOUT 12 行**后总计 **139**：PASS 59 / PPO 38 / FAIL 1 /
**PARTIAL 1（AC-11 = 收官时点的 PG16 覆盖 35/66，刻意不记为 PPO —— *"它是覆盖分数，不是绿测试欠反例"*；
⚠️ **该分数已被后续的双臂实验超越，见 §7.4；但本表是收官时点的分层快照，故不改数**）** /
BLOCKED-ENV 15 / OWNER-ONLY 20 / NOT RUN 5。

⚠️ **phase-B 不是一次 127 行重分层** —— 它是 **29 行子集**复核（8 条 phase-A FAIL + 15 条已落地特性的判别性核查 +
6 条优越性复烟）= **8 FIXED + 15 PASS + 6 PASS，子集内 0 FAIL**；其余 98 行仍是 `LANDED-VERIFY` / `PASS-POSITIVE-ONLY`。

**V-1 处置（逐字，收官 §5）：未解除。** 101 行发起执行，其中 9 行执行中被重判为不可执行、4 行 NOT RUN
⇒ **88 行在本 SHA 取得判定**（87 行由执行支撑、1 行仅由源码读取支撑）；**39 行未取得执行支撑判定**
（BLOCKED-ENV 15 + OWNER-ONLY 20 + NOT RUN 4），占母矩阵 **30.7%**。
且 88 行判定中**只有 51 行是无保留 PASS**，36 行是 PASS-POSITIVE-ONLY（套件绿、判别性反例本轮未构造）
⇒ **V-12 / V-7 未被本次重跑解除**，仅由 63 收窄到 36。
**准确表述：V-1 对可执行子集（88/127）解除，对其余 39 行仍 OPEN。**

**V-1 与 V-14 在重锚后的状态不同，必须分开读：**

- **V-1 仍然 NOT DISCHARGED**（上一段），**没有任何改变**。
- **V-14 已在它自己点名的那条轴上解除**（DISCHARGED），因为**对照臂真的跑了**。收官 §6 那段
  「零对照臂 / 35-of-66 / 部分兑现」的措辞**已作废**，被 `scratchpad/v14-pg-parity-verdict-20260820.md` 取代。
  ⚠️ **这不是软化，方向相反**：解除的是「缺对照臂」这一条，而该裁决同时列了**五条禁止过度声明的限制**，
  其中最重的一条是**生产实际在跑的大版本从未被任何 CI leg、也没被本轮任何一臂测过**。
  🆕 **2026-08-21 freshness 更正（绑 `13506666dae3`，§9.3）：这条「最重的限制」的后半已解除** —— 部署 compose 所钉的
  `postgres:15-alpine` 本身已被跑过（67/67 套件、588 测试全通过）。**前半仍成立**：没有任何 **CI leg** 在 PG15 上跑过 approval 真库套件
  （精确化后的表述见 §9.3；`smoke-verify.yml:11` 钉 `postgres:15` 但 dispatch-only、非 required、零 approval 套件）。
  **这不授权任何「兼容性已证」的写法。**
  完整逐字处置见 **§7.4**。**在本文任何地方都不得把它简写成「PG 大版本兼容性已被证明」。**

### 5.6 本轮唯一的 FAIL —— 且它是一条 `[源读]` 结论

- **行**：`§7 a11y #1` —— 流程画布节点卡片的截断摘要**缺少 hover/focus 提示**。车道 L4。排为 P1 修复切片 **FS-1**。
- ⚠️ **证据性质逐字**：*"**源码读取得出，非执行得出。** L4 的 repro 原文即 'read-only, no test framework needed'。
  **仓内不存在任何会为此变红的测试** —— 这一点本身就是缺陷的一部分。"*
- **被违反的已批准判据**：`docs/development/approval-canvas-v2-interaction-design-lock-20260721.md:366`
  （§14 表「Long labels」行，作用域逐字 "Node cards, branches, pickers, timeline"）：
  *"Truncate with ellipsis at component limits (§14); full text on hover/focus tooltip, in the inspector, and in
  accessible names. Longest supported labels must fit without layout break (G0)"*。
- **三条腿，FAIL 严格限于第一条**：hover/focus tooltip = **缺失（即本 FAIL）**；
  "in the inspector" = **看起来满足**（`ApprovalCanvasNodeInspector.vue` 无任何 `text-overflow` 规则）——**未经真实点击验证**；
  "in accessible names" = **另一个更细的缺口，明确不作为本 FAIL 的依据** → 拆出为 **FS-7**。
- **锚点** `[源读]`：`ApprovalFlowCanvas.vue:253-256`（截断的 `<span>`，**无 `title`、无 `aria-label`**）；
  `:577-584`（`overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`）；
  `TemplateAuthoringView.vue:1896-1903`（`canvasNodeCardSummary()` 返回业务内容）；`conditionSummary.ts:60-66`（**长度无上界**）。
- **作用域限制逐字**：*"只核查了 `ApprovalFlowCanvas.vue` 与 `ApprovalCanvasNodeInspector.vue`。设计锁把
  Form-builder / Version-diff / Member-detail 同样列入 'Long labels' 作用域，**这三处未做同模式普查**。"*
- **修法必须两部分**：(a) 让截断元素带上可访问的完整文本；(b) **一条会为它变红的测试** ——
  *"只做 (a) 等于把同类缺陷的复发通道原样留着。"*

### 5.7 三个**不是 FAIL** 的修复切片项（不得并进 FAIL 计数）

| ID | 项 | 为什么不是 FAIL |
|---|---|---|
| **FS-3** | AC-2 / R3：**F4-B `designated` 回退没有真库车道**（F4-A / F4-C / F4-E 都有）。L2 确认只有 4 条单测；R3 的运行期「unknown-state fail-closed」那一半**无真库证明** | *"是覆盖形状缺口，不是被证伪的行为；造车道属新工作，需独立评审"* |
| **FS-4** | V4：**并发恢复竞态从未被构造**。L2 逐字引用 FINAL 报告自己的欠债措辞 *"a constructed concurrent-restore race"*，并全仓确认该测试**不存在**（最接近的一个跑的是 *publish* 竞态，不是 *restore*） | *"顺序论证对竞态无效，但现有 mocked 测试并未被证伪"* |
| **FS-7** | accname 覆盖：父级 `role="button"` div 的 `aria-label="编辑{name}节点"` 按标准 accname 规则覆盖整个子树，故摘要文本（截断或完整）**永远不会**经 accessible name 暴露 | *"与 tooltip 腿是两个问题，混成一条就会重蹈「错归类被命名成天花板」"* |

**修复切片排序（收官 §8.4）**：FS-1（那条 FAIL）· **FS-2 在既有 harness 上写画布三视口 spec（*"最高杠杆"*）** ·
FS-3 · FS-4 · FS-5 Inspector 三视口 + 布局模式断言 · FS-6 用 Node 20.20.2 重跑 L4 的 vitest 清单（*"极低成本"*）·
FS-7 · ~~**FS-8 补齐剩余 31 个 PG16 套件 + 构造首次 PG14↔PG16 对照臂**~~ **⇒ 两半均已完成，FS-8 可关闭（§7.4）；
接替它的是 owner 排期的三选一：PG15 臂 / musl(alpine) 臂 / CI 版本对齐** · FS-9 给 V6/V7 指派裁决者并恢复两条优越性声明文本。

⚠️ **FS-1 / FS-3 / FS-4 / FS-7 全部保持原状，本轮零推进**：那条唯一的 FAIL 没有被修，三个修复切片项也没有被动。

### 5.8 收官坚持随行、不得抹平的对账口径

- **收官 §9 算术**：*"⚠️ **L2 报告内部一处算术不自洽，本台账不予传播**：其 'grand total' 写 **41 files / 539 tests**，
  而按其自己的分项 16+5+9 = **30 files**。测试数 129+221+189 = **539 对得上**，文件数对不上。本表按分项记 30 文件，非 41。"*
- **套件计数对账**：L1 9 = 7 approval + 2 fwb；L2 16 = 16 + 0；L3 14 = 12 + 2 ⇒ approval 前缀去重 **35**；fwb 去重 **3**。
  *"9+16+14 = 39 是**含重复且含非 approval**的原始数，**不得**直接与 66 对比。"*
- **收官 §7 分桶**：*"**R9 被刻意拆到两个桶** —— cancel 半边（廉价）与 focus 半边（需真 focus trap ⇒ 真浏览器）。
  AC-8 继承 R9，故与 cancel 半边同列。这是有意拆分，不是重复计数；三桶按**行**计仍为 21 + 8 + 4 + 3（owner-only）= **36**。"*
- **收官 §3.0**：FAIL 由 6 降到 1 **不是「问题解决了」** —— I7 与 R8 是真修好了；flow-canvas @1440/@1024 转入 BLOCKED-ENV
  （**未在读取基线 `6cca7ec0ed` 上重新验证**）；@390 变成 jsdom PPO 替身；a11y-checklist #4 只有 3/5 载具；**并且冒出了一条新 FAIL**
  （§7-checklist #1，phase-A 时它还是 BLOCKED-ENV）。
  *"三格 flow-canvas 的最后一次正向证据来自 phase-B 在 `6abd241925` 的真 Chromium 跑，不是 exact-main。
  计数不得暗示它们在本 SHA 上通过。"*
- **三处对「计划」的证伪**：(1) BLOCKED-ENV 预测 13→8，实测 **15**（比 phase-A 还差 2）——计划称 #4994 的挂载 harness
  已恢复 §7 网格，L4 发现该 harness 只驱动表单构建面板，**Flow-canvas ×2 + Inspector ×3 = 5 格从未被恢复**；
  (2) **收官更正了自己的车道报告** —— L4 的「仓内没有任何 harness 渲染 `ApprovalFlowCanvas`」**过强（悲观方向）**：
  `apps/web/verification/approval-form-builder-mounted-harness.ts` 挂载的是**完整生产 `TemplateAuthoringView.vue`** +
  真 Vue Router + 真 Element Plus，`canvasV2` **默认 ON**，且 `TemplateAuthoringView.vue:379` **就是**
  `<ApprovalFlowCanvas>` 的挂载点 ⇒ *"真 Chromium 载具已存在，缺的是断言 grid 声明的 spec，不是 harness"*
  —— ⚠️ **这是源读结论不是执行结论**，flow 步是否可达 / 画布是否真绘制**未执行验证**，收官自己把它列为动工前第一件事；
  (3) **车道自己的命令清单欠覆盖** —— L3 发现 D3/D4/M2/SUP-6 在给定命令块内没有裁决者；L4 发现 M3/M4 的真正裁决者是
  `approval-center.spec.ts` + `approvalMobileResponsive.spec.ts`（由 `approval-center-master-detail.spec.ts` 自己的
  头部注释点名），没有它们 M3/M4 就是绿测空转。*"这种「切片排除说明里点名了另一个文件」的构造很可能同样欠覆盖其他车道的行。"*

---

## 6. 剩余设计工作（**设计**，不是实现）

本节只列「还需要**决定**什么」，不列「还需要写多少代码」。凡是能靠写代码解决的，都不在这里。

### 6.1 审批评论 —— D1 是结构性阻塞，其余在它下游

来源：`scratchpad/approval-comments-decision.md`（**scratchpad-only，非仓内记录**）。

**必须保留的框定（逐字）**：*"真正的第一决策不是「共表还是新表」。A 和 B 都需要同一件当前**不存在**的东西——
一个 **per-instance 的可读性谓词** … 它被结构性地卡在 `approval_instances` **没有 `org_id` 列**上
（`db/types.ts:974-1001`，23 列无 org，且无任何迁移添加）… **所以本文的第一个 owner 决策是 D1「org 锚点从哪来」，
存储选择在它下游。**"*

| 决策 | 支臂 | 后果 |
|---|---|---|
| **D1 org 锚点** | (i) 给 `approval_instances` 加 `org_id` | 谓词最干净；代价 = 回填决策 + NOT NULL vs nullable 的裁定，且受记忆规则约束：**`org_id` 禁 DB 默认值、fail-closed** |
| | (ii) 经 `template_id` 推导 | **`template_id` 可为空**（`db/types.ts:993`），且 PLM/bridge 实例根本没有 ⇒ 对这两类实例谓词无解 |
| | (iii) 经 `requester_snapshot->>'id'` 推导 | **用户换组织时会漂移**，把当前 pin 正在关闭的「跨组织陈旧成员」问题原样重新引入 |
| **D2 存储姿态**（含「到底允不允许删除」） | (a) 维持 append-only（`approval_records` 生产侧 0 UPDATE / 0 DELETE，有正控） | ⇒ **永不**编辑/删除/串线程/软删；且 `/history` 的 `total`/分页算术**假定行不会消失**（`routes/approval-history.ts:92-96`） |
| | (b1) 可变 `approval_comments` + 审计行只存指针 | 必须**同时**裁定墓碑（tombstone）策略 |
| | (b2) 审计行存正文 + 一份可变的展示副本 | 文档**建议明确否决**，属合规陷阱：*"「删除」只是化妆：原文仍在 `approval_records.comment`，`/history` 仍逐字返回"* |
| | 附带问题 | **评论是否仍写一条 `approval_records` 行？** 若不写，每一个读 CC/history-actor 支臂的成员谓词都会**改变含义**（`isInstanceParticipant:231-237`、`listApprovals:514-525,531-533`） |
| **D3 评论写入作用域** | (a) 维持 `approvals:act` + 当前被指派（`ApprovalProductService.ts:8247-8254`） | 发起人**不能**评论自己的申请，CC 接收人与历史审批人也不能 |
| | (b) 放宽到 `approvals:write` + 参与者并集 | **硬依赖 D1**；且这是对**已发货动词**的行为变更 ⇒ 必须 **ratify-first**（`feedback_tests_freeze_change_not_approve_it`） |
| **D5 @提及候选作用域** | (a) 全组织，与多维表现状一致（`CommentService.ts:453-517` —— `listMentionCandidates(spreadsheetId,…)` **收了 `spreadsheetId` 却从不使用**，只做非空守卫，随后 `selectFrom('users').where('is_active','=',true)`） | 零新原语；但**任何人都能被 @ 进任何一个申请** |
| | (b) 参与者作用域 | 仓内**没有**现成原语（`ApprovalAssigneeResolver` 回答的是「谁被指派到这一步」，不是「这里可以 @ 谁」——`:154,:81,:106`）⇒ 全新代码，**且依赖 D1** |

**同样待裁**：**D4**（成员并集的形状必须统一而不是再分叉一次 —— `isInstanceParticipant` 的五个支臂 vs `listApprovals`
含 `source_queue` 的更宽并集；**Lock-7 D-4 禁止出现第四个谓词**）；**D6**（卫星表：共享 vs 审批自有 + 真 FK 级联，文档建议 (b)）；
**D7**（第 2 腿由哪条线出人出钱 —— *"不裁的后果是三条线互相等"*）；
**D8**（评论附件是否并入 Lock-9，文档建议是，**但必须先收窄 OD-L9-13(a) 的措辞** —— 它「原样复用 `isInstanceParticipant`」
的说法对附件成立，**一旦同一谓词被用于评论正文就不成立**；`[执行]` 探针：零附件实例 → 发起人 0、管理员 0）；
**D9**（多维表 R-1/R-2 硬化作为独立轨）。

**显式 OPEN 项**：**O-1** R-1 的绕过链是静态读，**从未端到端执行过** —— 任何建立其上的绝对断言必须先跑一次；
**O-2** 每一个 Lock-9 行号都来自 PR #5011 的基线，**从未与此处任何基线共同验证**；
**O-3** `di/identifiers.ts:161-162` 是否被任何测试/lint 钉住**未查**；
**O-4** 生产 `meta_comments` 里遗留 `target_type` 值的**真实行数未测**，而 R-7 白名单支臂的后果依赖它；
**O-5** 方案 0 与方案 C 的产品价值差属 owner 的产品判断。

### 6.2 Lock-9（审批过程附件）—— DRAFT，§4 批准块为空

本文对该项做了独立核实 `[执行 + 源读]`（因为任务措辞里的「ratify-ready」需要验证）：
- PR **#5011 OPEN**（`mergedAt: null`，非 draft PR，`updated_at: 2026-08-19T04:03:13Z`），head `b7858709dab04c74048899ef94353dd429f63a0e`；
  变更只有一个文件：`docs/development/approval-lock9-handler-process-attachments-20260819.md`（581 行）。
- 文档头部逐字：*"**Status:** DRAFT — design authority only. This document authorizes, enables, and implements NOTHING …
  §4's ratification block is deliberately BLANK — it is filled by the owner (or by goal-set in-session provenance) and is
  reversible before any implementation lands."* 基线 `origin/main@2a3b8033f5dc25a87e5bb3098ddc467f2f26cd63`。
- §4 实测为空：`Decision:` / `Owner:` / `Date:` / `Document SHA:` / `Decisions recorded:` **五行全空**，
  其下是 **OD-L9-1 … OD-L9-14** 的待裁清单（`[R]` 标注本文档的推荐支臂）。
⇒ **准确表述：Lock-9 是一份「推荐已填、批准未填」的 DRAFT，不在 main 上，等待 owner 对十四条 OD 的裁决。**
说它「ratify-ready」只在「推荐列已完备」这个意义上成立；**它没有被 ratify，也没有 §4 记录。**
其中 **OD-L9-13(a)** 的措辞已被 §6.1 的 D8 点名需要**先收窄**。

### 6.3 F4-D 的设计前置（不是实现前置）

- **OD-L4-10 必须先决**：*"scope the history the flags read to the current post-return round using the existing
  nodeEntryEpoch machinery … **Gate D-3 cannot be written until this is decided; shipping a dedup switch without either
  is forbidden.**"* ⇒ 在 OD-L4-10 裁定之前，F4-D **在设计上就不允许发货**。
- 其余两条（OD-L4-6 三态单选投影 / OD-L4-7 `prior_node_approver` 对两个历史派生布尔位的豁免）已有推荐支臂，
  但都挂在 OD-L4-10 之后。

### 6.4 本轮闸门**新产生**的 owner 裁决项（五条，不得丢弃）

1. **#5021 gate B-2 —— 契约与代码不一致，且这件事只记在一条代码注释里。**
   复核逐字：*"the RATIFIED Lock-4 text is unamended, so code and contract disagree with only a code comment recording it —
   **the owner must ratify which half moves before gate B-2 counts as discharged.** That is the one thing an owner must see;
   it is not something the implementer can close."*
   证据：`git diff a0edbe39a4 -- ApprovalGraphExecutor.ts ApprovalAssigneeResolver.ts` 滤掉注释后**为空**（纯注释修复）；
   `git diff a0edbe39a4 -- docs/` **为空**，故 §F4-B 仍逐字写着 *"If `'designated'` itself resolves to zero active assignees
   — empty list, **deactivated ids, role with no members** — the node terminates at the shipped `APPROVAL_ASSIGNEE_EMPTY` 400"*，
   而 §3 的 gate B-2 仍是强制项。被**另一份已批准文档**堵住（Lock-1 §2.1 禁止 resolver 内的 DB 读）⇒ 必须 owner 裁。
2. **#5023 gate P3-2 —— 一条未经批准的优先级微决策。** `ApprovalProductService.ts:808-811`：
   *"`samePersonPolicy:'auto_skip'` WINS over an explicit `mergeWithRequester` in the same payload."*
   锁文没有裁定矛盾载荷。*"It should be named in the lock (or reversed so the explicit flag wins) rather than left as an
   implementer choice."*
3. **🔴 Lock-7b 的 G-14 收窄 —— 本条在重锚中改写，且它的紧迫性变高而不是变低。**
   草稿写的是「R8 的补救路径 (2) 会收窄 G-14 ⇒ owner 处置」。**R8 已经不是通过路径 (2) 关闭的**——
   第五轮换掉了机制（§3.8）。但**收窄本身仍然发生了，只是换了形式**：落地物把自己的声明降级为
   *"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP, NOT THE PRIMARY GUARANTEE"*，
   而 G-14 的已批准属性写的是「九处站点按**精确集合**断言、站点清单本身也被断言 ⇒ **第十份副本会让普查变红，
   而不是无声通过**」。
   ⇒ **owner 必须裁的那个问题是**：一个自认 best-effort、并逐条具名了 (a)–(j) 十条残留（其中 (i) 被评审现场
   复现且**静默**）的文本扫描器，**是否仍然承得起 G-14 那句「第十份副本会变红」**？
   两个可能的答案都需要 owner 落笔，不能自证：**(甲)** 判定编译器主门 + 载体塌缩已实质替代 G-14 的意图，
   于是**改写 G-14 的措辞**使其与落地物一致；**(乙)** 判定 G-14 仍按字面生效，于是这条属性目前**未被满足**，
   需要另立切片。**本文不替 owner 选。** 依据 `feedback_second_narrower_artifact_is_contract_narrowing`：
   锁点名 A 而交付了 A'，只能升 owner 裁，不能由交付方自证「这不是弱化」。
   ⚠️ 附带一条必须一起裁的：**残留 (j)（`.vue` `<script>` 块定位启发式）是在 MERGE-CLEAN 裁决之后新增的**
   （`29b28b1f50`），**没有任何闸门审过它**（§3.8.2）。
4. **两份锁文都以 session-recorded goal-set provenance 批准**（§1.1），自声明在实现落地前可撤回，**均非 owner 亲署**。
   owner 若要把它们升格为正式批准，需要亲写的记录；本文不代写。
5. **分支保护（V-13）**：是否把审批车道加入 required 集合是 **OWNER-ONLY**（§4.6）。

🆕 **2026-08-21 freshness 增补（绑 `c473a079b5`）：本小节标题里的「五条」不改** —— 那是对 `5feca2291b` 处闸门产出的逐字计数，仍然为真。
在**这五条之外**，#5043（`545b3cadd1`）的闸门又产生了**第六条**，逐字见 §9.2.2：
*"If this check is wanted, it needs an owner-authored §K2 amendment covering both create and preview before it lands again."*
⇒ 截至 freshness base，owner 裁决项合计 **6** 条（5 @ `5feca2291b` + 1 @ `c473a079b5`），**一条也未关闭**。

### 6.5 仍欠 owner 的既有项（20 行 OWNER-ONLY，收官 §8.2）

- **owner block ×15**：master §10 Canvas UAT **S1–S12**、独立 FWB UAT、独立附件 UAT、P7-E 分级 flag 启用与回滚、
  §0 三标签声明清单、§12 最终 owner 记录，外加 **Lock-5 / Lock-1 K1·K3·K6 / Lock-8 L8-A 的运行时启用授权**、
  OD-L8-7(a) 生产模板语料扫描、FAIL-6 形状裁定。
  *"构造上不可由代码代理执行，phase-A 与本轮均一行未执行。"*
  （注：K1/K3/L8-A 的**实现**切片本身已落地；这里欠的是它们的**运行时启用**。）
- **§2#7** 私有发布前置——owner 带外结清并记录。
- **a11y #5**（「无嵌套卡片 / 无溢出 / 无重叠」）—— **判据未定义**；收官坚持 *"判据缺失是 owner 决策，不是环境阻塞"*。
- **I14 / U1 / F12 —— 同一类，而且把它们记成别的类本身就是错。** 逐字：
  *"**这三行是同一类**：矩阵行描述了一个在本 SHA 已不成立的世界。**这不是代码缺陷，也不是覆盖缺口，
  把它们记成任何一种都是错归类。**"*
  - **I14**：文本写「Lock-7 之前不强制」，但 Lock-7 已落地（P4-B #4961）⇒ **按原文不可满足**。
  - **U1**：前提（「更多设置没有功能性策略」）被 L6-A 去重档位落地证伪。
  - **F12**：前提被**已批准的 FB-D6** 证伪 —— `CompleteFormReferenceInventory` 文档注释逐字：
    *"Production callers pass no inventory (**RATIFIED FB-D6**)"*；FWB 映射由 `sourceTemplateVersionId` 钉住而非实时引用，
    因此**不存在**会「变得不可用」的提供方。owner 须改写 F12 使之与 FB-D6 对齐，或裁定版本钉住不足并委任建那个提供方。

### 6.6 需要设计答案（而不只是执行）的验证欠债

- **NOT RUN 5 行**：**V6**（遗留编辑器回退不得抹掉未知配置）与 **V7**（编辑器入口可从授权页头到达）—— 任何车道的命令清单里
  **都没有指派裁决者**，候选已具名（`approval-ui-workspace.spec.ts`、`approvalTemplateAuthoring.spec.ts`）但未确认；
  **优越性 ×2（L2 的）** —— L2 自述**「无法说出这两条具体是哪两条优越性声明」**，且逐行证据文件
  `scratchpad/p7-phase{A,B}-evidence-20260818.md` 经四次搜索**确认灭失** ⇒ 声明文本须从开发报告 §4.1 重建或由 owner 提供，
  否则无法给出任何裁定；**AC-10** Lock-7b —— ⚠️ **重锚更正：#5026 已落地（`5feca2291b`），但 AC-10 仍是 NOT RUN，
  阻塞理由从「尚未落地」换成「已落地，但**在两个 SHA 上都没有被任何收官车道判过**——收官跑在读取基线 `6cca7ec0ed`（彼时它还没落地），而重锚后的 exact-main `5feca2291b` 上没有跑过任何收官车道」**。它现有的唯一证据是该 PR
  自己的 CI 与 requalification #4 的验证电池，**两者都绑 pre-squash head**（前者绑 `29b28b1f50`、后者绑 `a96ab8ae2b`），
  **都绑 pre-squash head，都不是对读取基线或重锚后 exact-main 的判定**。⇒ **139 行分层计数本轮不重推**（没有发生重跑），AC-10 留在 NOT RUN 桶内。
- **BLOCKED-ENV 15 行按根因归四类**：RC-1 缺的是**断言画布声明的真 Chromium spec**（**不是缺 harness**，4 行 + 影响另 3 行的分层，
  **最高杠杆**，但动工前**第一件事**是执行验证 harness 里 flow 步是否可达 / 画布是否真绘制）；
  RC-2 Inspector harness 视口与声明不对（3 行，低成本）；RC-3 缺组装应用（6 行，高成本，**属新工作需独立评审**）；
  RC-4 缺生产/staging schema 快照（2 行，**不是代码工作**，沙箱到不了部署主机，需 ops/owner 提供）。
- **PASS-POSITIVE-ONLY 36 行**按成本分桶：**廉价 21 行**（一条断言/一次变异即可，含 §2#5、F11、U2、U5、I1、I2、I4、I9、I10、
  R2、R7、R9(cancel 半)、R10、R12、M1、M3、M5、V1、V3、D5、AC-8）；**需真浏览器 spec 但载具已存在 8 行**；
  **需组装应用/新基建 4 行**；**owner-only 3 行**（R1、superiority#6、G8）。
  **证据保留 R-1**：L4 的 **463 vitest 测试 / 20 文件** 跑在 **Node v25.9.0**，L1 切换到 20.20.2 的理由逐字
  *"vitest 1.6.1 is far outside v25's support window and any result under it would have been suspect."* ⇒ 廉价的解除方式是 **FS-6**。
- **一条需要裁定而不是需要执行的**：`'TRUE'`（大写）**会**开启开关，因为三个解析器都先 `.toLowerCase()`；
  同时**没有任何测试钉住 truthy-非-`'true'`（`'1'`/`'yes'`）被拒**。收官措辞：*"这本身值得先裁决是否为预期"* `[未核 —— 无人裁定]`。

### 6.7 FWB 启用 runbook —— owner/ops 的五个问题

来源 `scratchpad/fwb-enablement-runbook.md`（**scratchpad-only，非仓内**；机械基线 `origin/main = a0edbe39a4`）。逐字五项：
1. staging（`:8082`）`docker/app.staging.env` 的当前实际内容 —— 仓内只有 `example`。
2. staging 的库是否已应用三个 FWB/outbox 迁移 —— 仓内的 staging 对账文档早于它们。
3. 生产主机 `<DEPLOY_PATH>/docker/app.env` 的当前内容 —— gitignored，从仓库不可见。
4. **是否授权在生产开启 `AUTOMATION_DURABLE_DELIVERY_ENABLED`**（= 把审批/记录/webhook 三条线的投递底座整体换掉）。
5. 若 durable 曾开后关：重开之前是否必须清理/审计 `meta_automation_outbox_consumer` 里的陈旧 pending 行
   （**该声明没有时间截止 ⇒ 全量重放**）。

**runbook 自带的开关计数更正（值得随行）**：记忆中的「P2 四个 flag」= DURABLE + CLASSA + CLASSB + FWB；
**实测其中只有 2 个对 FWB 承重**。`AUTOMATION_CLASSA_CLAIM_ENABLED` 与 `AUTOMATION_CLASSB_OUTBOUND_ENABLED`
**不在 FWB 的执行路径上**（FWB 用自己的账本 `meta_fwb_action_applied`）。
另有一条硬性负向约束：durable 开着时，`WEBHOOK_RETRY_SCHEDULER_DISABLED=1` 会让 `assertDurableRuntimeDependency` 抛错
⇒ **后端启动直接中止**（`index.ts:3164-3175`）。

---

## 7. 尾部四项的结清状态 —— 两项已结清，两项仍 owner-pending

> **本节在重锚中改写。** 草稿把这四项统一记为 `TAIL-PENDING`。其中**两项已经结清**（§7.1 Lock-7b、§7.4 V-14 对照臂），
> **两项仍然悬着且都只能由 owner 解**（§7.2 Lock-9、§7.3 审批评论 D1/D2/D3/D5 与 FWB 启用）。
> **结清 ≠ 完成标签**：本节任何一条都不改变 §8 的三个 NO 与六个 OFF。

### 7.1 Lock-7b（#5025 锁文 / #5026 实现）—— **已结清并落地**，但带三条必须随行的限定

**落地事实** `[执行]`：

| PR | 状态 | pre-squash head | 落地 squash commit | 规模 |
|---|---|---|---|---|
| **#5025** 锁文 + 两条台账行 | **MERGED** 2026-08-20T06:33:24Z | `207162573e11981b50a2a21f3a8cd82346ff649d` | **`5ab052449b`** | +587 / −0，3 文件 |
| **#5026** 实现 | **MERGED** 2026-08-20T07:06:10Z | `29b28b1f50e8f0e4a86ca5a5678904f3522ef7c1` | **`5feca2291b`**（= 当前 origin/main） | +3015 / −142，24 文件 |

**裁决谱系（五份，逐份绑 head，末份取代前四份）**：`lock7b-impl-gate`（`0a4827214d`，FIX-ROUND）→
`lock7b-requal`（`f17cfef923`，FIX-ROUND）→ `lock7b-requal2`（`57e8dd6673`，FIX-ROUND）→
`lock7b-requal3`（`a48b447886`，FIX-ROUND）→ **`lock7b-requal4`（`a96ab8ae2b`，MERGE-CLEAN）**。
全部位于 `/tmp`，**均 head-scoped，非仓内记录**。

**三条限定，缺一条这一节就变成过强声明：**

1. 🔴 **没有任何闸门裁决绑定实际落地的那个 head。** MERGE-CLEAN 绑 `a96ab8ae2b`；分支随后又走了一个提交到
   `29b28b1f50`（**未过闸**），`5feca2291b` 是它的 squash。诚实句式：**裁决绑 pre-squash head `a96ab8ae2b`，
   以 squash commit `5feca2291b` 落地；SHA 层面无法建立祖先关系**（§0.2）。**不得写「闸门覆盖了落地物」。**
   那个未过闸的提交并非无关紧要——它修的是一次治理钉点事故，并新增了残留 (j)（§3.8.2）。
2. 🔴 **闸门在这一轮漏判了一件事，而且是被后手抓住的，不是被闸门抓住的。** requalification #4 把三条
   Sealed-export 红判为「pre-existing、与本 PR 无关」，理由是「本 PR 不改 `plugins/` 下任何文件」——
   **这条推理结构上是错的**，钉点的输入是仓根的 `pnpm-lock.yaml`。**闸门清了它，后面一个提交才发现并修好。**
   记法必须是「**后手抓住的**」，不是「闸门抓住的」（§3.8.2）。
3. ⚠️ **验证侧仍是 NOT RUN。** 收官行 **AC-10** 在**两个 SHA 上都没有**被任何收官车道判过（收官跑在读取基线 `6cca7ec0ed`，彼时它还没落地；重锚后的 exact-main `5feca2291b` 上没有跑过收官车道）；它现有的证据是
   PR 自己的 CI（绑 `29b28b1f50`：全部 check-run success，含 20 条 `approval-realdb-*` 车道与它自己的新车道
   `approval-realdb-required-at-node`）与 requalification #4 的电池（绑 `a96ab8ae2b`）。**两者都绑 pre-squash head，都不是对任一 exact-main / 读取基线的判定。**

**另有一条文档漂移，属 owner/记账面，不是本文可改的** `[执行]`：
`docs/development/approval-parity-execution-ledger-20260817.md` 的 Lock-7b 行（`5feca2291b` 上第 **114** 行）
仍逐字写着 *"Implementation NOT STARTED and NOT authorized"* —— 那是 #5025 写就时点的正确表述，
而 **#5026 落地时没有为自己补一条台账行**（其 24 个改动文件中**零个** `docs/`）。
⇒ **main 上的台账目前与 main 上的代码不一致。** 本文只记录，不修（本文不开 PR）。

🆕 **2026-08-21 freshness 更新：这条 open item 现已 CLOSED（绑 `627945523b`，#5040）。**
上面那段描述在 `5feca2291b` 上逐字为真，作为历史观测保留；但该漂移已由 #5040 结清 —— 它只改那**一个** Residual 单元格
（1 insertion / 1 deletion，pipe 数不变 = 9），把 *"Implementation NOT STARTED and NOT authorized"* 替换为落地记录。
**因此本文（§6.5、§7.1）与验证报告（§9.1）中凡把「台账漂移」列为 pending 的地方，一律读作 CLOSED。**
⚠️ **它只关闭台账文本这一件事**：AC-10 仍是 **NOT RUN**（上面第 3 点不变），§6.4 第 3 条 G-14 也**没有**被它关闭 ——
#5040 自己就把 G-14 逐字记为 *OPEN OWNER DECISION, not ruled here*。逐条内容见 §9.1。

### 7.2 PR #5011 —— Lock-9 文档：**仍 OPEN，仍 DRAFT，§4 批准块五行全空** ⏳ **OWNER-PENDING**

状态自草稿以来**未变**，本次重锚复核 `[执行]`：`state: OPEN`、`mergedAt: null`、`isDraft: false`。
**不得计入「已批准的锁文」。** 它在等 owner 对 **OD-L9-1 … OD-L9-14** 十四条的裁决（§6.2）。

### 7.3 其余 owner-pending 项（本轮**没有**推进，逐条保持原状）⏳

- **审批评论 D1 / D2 / D3 / D5** —— D1 是结构性阻塞，其余在它下游（§6.1）。**本轮零推进。**
- **FWB 启用的五个 owner/ops 问题** —— 含「是否授权在生产开启 `AUTOMATION_DURABLE_DELIVERY_ENABLED`」
  与「durable 曾开后关时是否必须先清理/审计陈旧 pending 行（无时间截止 ⇒ 全量重放）」（§6.7）。**本轮零推进。**
- **§6.4 的五条闸门新产生的 owner 裁决项**，其中第 3 条在重锚中被改写并**加重**（G-14 收窄，§6.4）。
- **§6.5 的 20 行既有 OWNER-ONLY**。

### 7.4 V-14 的 PG14↔PG16 对照臂 —— **已跑，V-14 在它自己点名的那条轴上解除**

> **本节整段取代草稿的「未开工（NOT STARTED）」。** 草稿写就时对照臂确实一条都没跑；此后两条独立车道
> （Lane A / Lane B）各自 provision 了一对臂并跑完。裁决全文：`scratchpad/v14-pg-parity-verdict-20260820.md`
> （**scratchpad-only，非仓内**）。**该裁决取代收官 §6「零对照臂 / 35-of-66 / 部分兑现」的措辞，后者已作废。**

**⚠️ 裁决绑的 SHA 与本文重锚后的 head 不是同一个，这一条必须先说：**
双臂实验跑在 **`6cca7ec0ed`** 上，那里 `packages/core-backend/tests/integration/approval-*` = **66** 个文件。
本文重锚后的 head 是 `5feca2291b`，那里是 **67** 个——#5026 新增了
`approval-lock7b-required-at-node.db.test.ts` `[执行]`。
⇒ **在重锚后的 head 上，双臂覆盖是 66/67，不是 66/66。** 第 67 个套件只有**单臂**证据：
它自己的车道 `approval-realdb-required-at-node.yml` 用 `image: postgres:16`（且设 `EXPECT_DB: '1'`
并硬编码 `DATABASE_URL`，两点接线齐全）——**PG14 侧从未跑过**。**本文按 66/67 记，不按 66/66 记。**

**§5「V-14 处置」逐字全文（裁决原文，不得改写、不得摘要）：**

> **V-14 —— 已解除（DISCHARGED），就它自己所声明的那个轴而言。**
>
> **V-14 的实质由被取代的那份文档自己定义，不由本裁决定义。** `w4-verification-closeout-20260820.md` L454 的 follow-up 规格逐字写道：
> > `| **FS-8** | 补齐 PG16 剩余 31 个 approval 真库套件；并**首次构造 PG14↔PG16 对照臂**（V-14 的实质) | V-14 |`
>
> 即该文档把 V-14 的实质定义为 **PG14↔PG16 对照臂**。本轮构造的正是这个，且做到 66/66。
>
> V-14 在同一文档 §6（L337–351）中的原文所指同样是**证据轴**：「四条车道**全部只跑了单一 PG16 臂**，**没有任何一条跑过 PG14 或 PG15 的对照臂**」「35/66 = 53%，31 个套件在本 SHA 上从未在 PG16 跑过」「大版本一致性本身完全未验证（零对照臂）」。**该轴现已闭合。**
>
> **精确范围**：在 exact-main `6cca7ec0ed97732e05723f4c613557087395d022` 上，`packages/core-backend/tests/integration/approval-*` 的**全部 66 个**真库套件，各自在 **PostgreSQL 14（14.24）与 PostgreSQL 16（16.14 / 16.15）**上各执行一次，**每臂 574 条测试全部通过、0 skipped、0 failed，逐条 test-name 集合两臂 66/66 完全相同，DIVERGENT = 0**；同一 319 条迁移在两个大版本上均以相同顺序执行完毕并 exit 0。执行环境为本地 Docker、Debian-13 `postgres` 官方镜像、DB locale `en_US.utf8`（宿主架构：Lane A 为 aarch64，Lane B 未记录）。
>
> **仍缺双臂结果的套件：无（zero）。** 66 个全部有双臂结果，Leg A 28/28、Leg B 38/38，两车道零交叠、并集机械核对等于全 66 名单。**这是完整覆盖，不是部分覆盖，故不作部分处置。**
>
> **以下是对该 null 结果之强度的限制，不是覆盖缺口**（逐条独立成立，均不改变上面的 DISCHARGED 判定）：
> 1. **PG15 从未被跑过。** 而 `docker-compose.app.yml`（`docker-build.yml` 部署作业 L202 实际使用的 compose 文件）与 `docker-compose.app.staging.yml`、`docker-compose.dev.yml` 三者都钉 **`postgres:15-alpine`** ⇒ **compose 所钉的部署版本（15），两条 CI leg 与本轮双臂全都没有测过**（详见 §7；线上 `server_version` 未亲查，此为文件文本断言）。
> 2. **灵敏度未演示。** 无任何正控证明"一个真实的 PG 大版本差异会被这套 harness 判红"；两车道的负控只到连通性层（§4）。
> 3. **collation / 架构轴未行使。** 四个臂同为 Debian-13 glibc 官方镜像 + `en_US.utf8`，故 glibc/ICU collation 漂移根本没被行使；而部署 compose 钉的是 **alpine（musl libc）**、CI runner 是 x86_64（Lane A 为 aarch64，Lane B 架构未记录）。
> 4. **无 schema 级比对。** 未取 `pg_dump --schema-only` 做两臂 diff，故不断言列类型/默认值/索引形状相同。
> 5. **无重复轮。** 每套件每臂各跑一次，非 flake-hardened。
>
> **一个态的转变（须与上面并读）**：`plugin-tests.yml` 承载的 Leg B 38 个套件在 CI 上仍跑 PostgreSQL 14。在本轮之前这是**未验证的风险**；在本轮之后它是**已测量的选择**——这 38 个套件在 14 与 16 上行为完全相同（Leg B 每臂 301 条测试、38/38 SET-IDENTICAL）。是否改动 CI 配置因此是排期与保真度问题，不再是正确性未知问题。
>
> **不得声明的表述**：不得写"approval 线的 PG 大版本兼容性已被证明"。准确表述为——**V-14 所指的对照臂缺失已解除（66/66 双臂、零差异）；PG15（即部署 compose 所钉的版本）、musl/collation、x86_64、schema-diff、重复轮五个轴仍未被触及。**

**本文对上文的三条附加约束（不改写裁决，只把它放进本文的坐标系）：**

1. **重锚后的分母是 67 不是 66**（见本节开头）。裁决里每一处 `66/66` 都要读成「在 `6cca7ec0ed` 上」。
2. **第 2 条限制（灵敏度未演示）是这五条里最重的一条，因为它攻的是判据本身。**
   两条车道的负控只证明了「连不上会红」（Lane A 停容器 → `ECONNREFUSED`；Lane B 打死端口 `:5999` → `rc=1`），
   **没有任何一次实验演示「一个真实的大版本行为差异会被这套 harness 判红」**。
   按 `feedback_positive_control_not_failclosed` 与 `feedback_attack_your_own_criterion`：
   **一个从来没为「该红的东西」红过的判据，它的 null 结果强度是未知的**——零差异因此只能读成
   「在本平台本 locale 下这 66 个套件所行使的行为里没有一处不同」，**不能**读成「有差异就会被抓到」。
3. 🔴 **最值得 owner 看见的一条是运营面的，不是测试面的**：**生产与预发的 compose 钉 `postgres:15-alpine`，
   而 CI Leg A 是 `postgres:16`、CI Leg B（封存 `plugin-tests.yml` 内的 38 个套件）是 **PostgreSQL 14**。
   ⇒ 生产实际在跑的那个大版本，从未被任何一条 CI leg、也没被本轮任何一臂测过。**
   同一句话上还叠着两条本轮完全没行使的轴：**musl（alpine）vs glibc（Debian）** 与 **x86_64 vs aarch64**。
   裁决给 owner 排了三选一（A 加一条 PG15 臂，最便宜且填的正是这个唯一「生产在跑却从未被测」的版本；
   B 加 `postgres:15-alpine`（musl）臂直击 collation 轴，暴露面最大；C 把 Leg B 与 11 条独立 workflow
   一并对齐到 15，触 `plugin-tests.yml` 须走安静窗口，排最后）。**三条都不是本文可自行执行的。**
   ⚠️ 口径纪律：以上 compose 版本是**仓内文件的文本断言**，线上 `server_version` **未亲查**（沙箱到不了部署主机），
   且 `DEPLOY_COMPOSE_FILE` 是可被 env 覆盖的默认值。
   🆕 **2026-08-21 freshness 更新（绑 `13506666dae3`，§9.3）：三选一里的 A 与 B 现已被同一次执行一并兑现** ——
   跑的正是 `postgres:15-alpine`（既是 15，也是 musl），**67/67 套件、588 测试全通过、319 迁移 exit 0**。
   ⇒ **V-14 第 1 轴关闭、第 3a 半轴首次行使**；**C（把 Leg B 与 11 条独立 workflow 对齐到 15）仍未做**，
   而且该臂给 C 增加了一条新依据：应对齐 `postgres:15-alpine`（musl）而非 `postgres:15`（Debian glibc），
   因为二者的 collation 行为**可测地不同**（§9.3）。**x86_64 那条轴仍完全未行使**（该臂同为 aarch64）。
   ⚠️ **上面这段口径纪律不变：线上 `server_version` 仍未亲查。**

**FS-8 的处置**：其前半（补齐剩余 31 个 PG16 套件）与后半（首次构造对照臂）**均已完成**，
**FS-8 可以关闭**。接替它的不是同一条，而是上面那三选一（PG15 / musl / CI 对齐），**属 owner 排期**。
🆕 **2026-08-21 freshness 更新（§9.3）：三选一中的 A + B 已由 `postgres:15-alpine` 生产臂一并兑现；只剩 C（CI 版本对齐）仍属 owner 排期。**

## 8. 本文档边界

### 8.1 完成标签 —— 全部 NO

开发报告头部在 `6cca7ec0ed`（即 #5009 之后）：
`完成标签 | CORE-PARITY: **NO** · DATA-CLOSURE: **NO** · PRODUCT-FINAL: **NO**（三者均需 owner 签署，见 §7.2）`。
**本轮没有签署任何标签。本文档也不签署任何标签。**

### 8.2 开关 —— 全部 OFF，且「初值是策略断言而非环境观测」

开发报告 §1.4 表逐字：*"ledger §7 的初值是**策略断言而非环境观测**，且整个程序期间无一次改动"* ——
Canvas V2 / Durable delivery / Class A ledger / Class B ledger / FWB / Attachments 每一行都是
`Staging observed: NOT RECORDED`、`Production observed: NOT RECORDED`、`Enable authorization: NO`、`Rollback verified: NOT RUN`。

本轮在 `6cca7ec0ed` 上**机械重核了代码内的默认值** `[源读]`：

| Flag | 锚点 | 默认 |
|---|---|---|
| `APPROVAL_FWB_WRITEBACK_ENABLED` | `packages/core-backend/src/multitable/approval-fwb-activation.ts:145-146`；docblock *"Runtime flag, default OFF"* | **OFF** |
| `AUTOMATION_DURABLE_DELIVERY_ENABLED` | `automation-durable-delivery.ts:20-21`；docblock *"Master gate for the whole P2 durable-delivery runtime. **Default OFF.**"* | **OFF** |
| `APPROVAL_ATTACHMENTS_ENABLED` | `apps/web/src/stores/featureFlags.ts:24`（*"D5, default OFF"*）；后端 `routes/approval-attachments.ts` | **OFF** |
| `APPROVAL_CANVAS_V2_ENABLED` | `packages/core-backend/src/services/approval-canvas-flag.ts:6`；FE `stores/featureFlags.ts:81` `approvalCanvasV2: false` | **OFF** |
| `AUTOMATION_CLASSA_CLAIM_ENABLED` / `AUTOMATION_CLASSB_OUTBOUND_ENABLED` | `automation-execution-ledger.ts:37-39` / `automation-outbound-intent.ts:63-65` | **OFF**（且**不在 FWB 路径上**，§6.7） |

⚠️ 收官 §2#5 的 caveat 对以上全部适用：*"欠：无任何测试钉住 truthy-非-`'true'`（`'1'`/`'yes'`）被拒"*，
而 `'TRUE'` **会**开启（三个解析器都先 lowercase）—— 是否为预期**无人裁定**（§6.6）。

### 8.3 本文档不做的事

- **不批准（ratify）任何东西。** Lock-4 已批准（在 main）、**Lock-7b 已批准（重锚更正：**已在 main**，`5ab052449b`）**、
  Lock-9 **未批准**（DRAFT，§4 五行空，PR #5011 仍 OPEN）—— 这三种状态由各自文档决定，本文只记录。
  ⚠️ 前两份的批准 provenance 都是 **session-recorded goal-set**，**不是 owner 亲署**（§1.1）；「在 main 上」
  只说明文本进了 repo-of-record。
- **不授权任何运行时。** 两份锁文的 §4 都写着 `Runtime authorization: NONE`。
- **不开启任何开关，不签署任何完成标签，不宣告对标完成。**
- **不开 PR。** 本文只写进 scratchpad，由 owner 先行审阅。
- **不是仓内记录。** 本文与它引用的验证收官、`approval-comments-decision.md`、`fwb-enablement-runbook.md`、
  `w4-closeout-L{1..4}`、以及 **`v14-pg-parity-verdict-20260820.md` 与两份车道报告 `v14-arms-opus-{A,B}-20260820.md`**
  都只在 scratchpad；`git ls-tree` 于 `6cca7ec0ed` 确认它们**不在 `docs/`**（重锚未改变这一点：
  §7 引用的全部制品仍在 `/tmp` 或 scratchpad）。

### 8.4 本文明确**未能核实**的事项（不得被后续文档当作已知事实继承）

1. **#5010 / #5016 / #5019 的闸门/复核制品** —— `/tmp` 内不存在（第一手：31 份 `.md` 中 0 份提及这三个 PR，§2.5）。**不得为它们归属任何闸门裁决**；
   其事后验证是收官 AC-5/AC-6 行。
2. **任何裁决 SHA 到任何合并 SHA 的祖先关系** —— 构造上不可能（**十一个**合并全是 squash）。只有 #5023 的
   rebase 内容等价被证明；其余各 PR 的裁决 SHA **本身就是最终 head**，故未做同类证明——
   ⚠️ **#5026 是唯一的例外，且是反方向的例外**：它的裁决 SHA `a96ab8ae2b` **不是**最终 head
   （最终 head 是 `29b28b1f50`），而这两者之间的那个提交**从未被任何闸门审过**，本文也**未**为它构造内容等价证明（§7.1）。
3. **08-18 的 phase-A/phase-B 逐行证据文件是否曾以可恢复形式存在** —— L2 与收官都报告
   `scratchpad/p7-phase{A,B}-evidence-20260818.md` **确认灭失**（四次搜索、零命中）；两条 L2 优越性声明文本因此无法从仓内恢复。
4. **`approval-form-builder-mounted-harness.ts` 的 flow 步是否可达 / 画布是否真绘制** —— 收官自述为**源读结论、非执行结论**，
   并把它列为动工前的第一件事。
5. **车道 L2 / L3 的 Node / pnpm 版本** —— *"报告未记录，不假设为 20"*。
6. ~~**任何「TS-AST + 载体消除」实现**~~ —— **本条在重锚中作废并翻转**：TS-AST 已于 `c3a0a9441a` 落地，
   随 #5026 以 `5feca2291b` 进入 main，`ts.createSourceFile` 在 main 上可直接读到 `[执行]`。
   **草稿的「不存在」结论对其观测时点（`a48b447886`）成立，对当前 head 不成立**，不得被后续文档继承。
   （这正是 `feedback_verify_against_current_main_not_stale_base` 的形状：对旧基点做的「不存在」断言，
   会把已落地的东西写成 gap。）**接替它成为未核实项的是**：`29b28b1f50` 提交自述的
   「新抽取器与 `@vue/compiler-sfc` 在五个 `.vue` 文件上字节偏移完全相同」**本文未复算**（`[制品]`），
   以及残留 (j) **未经任何闸门审阅**。
7. **被合并的 PR 是否用过 `--admin` 或任何绕过** —— **未查**。已核实的只是 `efaa553d71` 与 `563fbb2772` 处的
   check-run 全为 success/skipped。
8. **`563fbb2772` 之后本地重跑 `bash apps/web/scripts/run-required-web-tests.sh`** —— 无制品晚于 10:44；
   站在其位置上的只有合并 head 处的 CI 成功。
9. **收官 139 行合计与 L1–L4 并集的独立对账** —— 本文作者读了合并后的收官全文与四份车道头部，
   但**未**从四份车道表独立重导行数。收官自述了三处对其车道的更正（§5.8）。
10. **`'TRUE'`（大写）开启开关是否为预期** —— 收官提出需裁定，**无人裁定**。
11. **2026-08-14 的 `strict=true` 记忆与实测 `strict:false` 哪个对** —— 收官记为线上漂移，成因**未调查**。
12. **#5024 闸门的 §Residual 与 mutation-B 内容** —— 依该文件自身的处理约束与 FINDING-1，**刻意不在本文复现**。

---

## 9. 2026-08-21 freshness pass —— 本文定稿之后落地的三件事

> **本节是纯增量。** 它不改写 §0–§8 的任何一条结论、不软化任何一条诚实声明、不重开任何已裁定的事。
> §0–§8 里的 `exact-main` 仍然、且仅仅是 `5feca2291b`（见抬头的锚点分层表）。
> **本节每一条声明都在开头具名它所绑的 SHA；未具名的声明不存在。**

### 9.1 #5040 —— 执行台账的 Lock-7b 漂移 **已结清（CLOSED）**

**绑落地 SHA `627945523b`**（`docs(approval): sync execution ledger — Lock-7b implementation landed (#5040)`），**在 freshness base `c473a079b5` 上机械复核** `[执行]`。

§7.1 末尾把台账漂移记为「main 上的台账与 main 上的代码不一致 …… 本文只记录，不修」。**那条 open item 现已关闭。**
#5040 的 diff 只碰 `docs/development/approval-parity-execution-ledger-20260817.md` 的 Lock-7b 那**一个** Residual 单元格
（1 insertion / 1 deletion；pipe 数不变 = 9，与表头一致）。新单元格逐条记录了什么：

| 记录项 | 内容 |
|---|---|
| 两个合并 SHA | #5025 锁文 → `5ab052449b`；#5026 实现 → `5feca2291b` |
| 合并前终裁 | MERGE-CLEAN，**绑 pre-squash head `a96ab8ae2b`**（requalification #4，取代此前四轮 FIX-ROUND verdict） |
| squash 纪律 | 逐字写入：*"verdicts bind pre-squash heads; ancestry from `a96ab8ae2b` to the merge commit is NOT establishable by SHA"* —— **不得**被读成祖先关系（`feedback_squash_merge_voids_ancestry_evidence`） |
| squash 内未审提交 | `29b28b1f50`（sealed-export pnpm-lock revert + 内联脚本抽取器）逐字记为 **landed UNREVIEWED inside that squash** |
| 合并后 requalification | 在落地 SHA `5feca2291b` 上 CLEAN-at-landed-SHA，3 条 P3 声明诚实性发现，由 #5033 `c5a4a94f7f` 修复 |
| **G-14** | 逐字记为 **OPEN OWNER DECISION, not ruled here** —— 普查在规避轮中被诚实降级为 best-effort backstop、编译器为主门；**这个降级后的形状是否仍满足 as-ratified 的 G-14，未解决** |
| 两条残留 | 仍逐字记为 **DISCLOSED, not closed**：不可满足的 `required` 产生一个行为人无法清除的 422（修法 = 重新发布）；`template_version_id` 为 NULL 的已启用模板在无 `fieldWrites` 提交时可达 409 `APPROVAL_FROZEN_SCHEMA_NOT_FOUND`（该列允许 NULL；线上是否存在这样的实例 **UNSWEPT**） |

⚠️ **这条只关闭「台账文本漂移」这一件事。** §6.4 第 3 条（G-14 收窄的 owner 裁决）**没有**因此关闭 ——
#5040 明确把 G-14 记为 *not ruled here*，与 §6.4 的结论一致，不是取代它。
**AC-10 仍是 NOT RUN**（§7.1 第 3 点、验证报告 §8.3），本条**不触碰**它。

### 9.2 #5043 —— Codex 第 4 轮评审的结清，以及一次被闸门抓住的**契约保真挽救**

**绑落地 SHA `545b3cadd1`**（`fix(approval): requester-choice identity epoch + stale-cache deletion + resolve backoff (#5043)`），**在 freshness base `c473a079b5` 上机械复核** `[执行]`。

#### 9.2.1 落地的三件（前端 / 模块层）

1. **requester-choice 的 per-node 身份 epoch。** `searchChoiceCandidates` 此前没有 per-node 顺序守卫，
   一个乱序到达的网络响应可以静默覆盖更新的、已渲染的一页结果。现引入 **per-node 请求代次计数器**
   （照抄 `routePreviewController.ts` 里既有的竞态守卫形状，而不是另造机制），丢弃任何已非该节点最新的响应。
2. **过期缓存的删除 + 「可见但不可提交」的撤回语义。** `choiceConfirmedNames` 此前只追加、从不修剪，
   于是一次早期搜索确认过的姓名可以活过一次**明确对同一 id 返回空名**的更晚搜索 ——
   在两次搜索之间被改名 / 匿名化 / 停用的目录记录，仍然既可选又可提交。现在：最新一页对该 id 返回空名即**删除**其条目；
   `isChoiceOptionUnidentifiable` 被重定义为**只**基于 `choiceConfirmedNames`（freshest-wins），
   移除「当前选中项豁免禁选」这个特例 —— 该特例原本要保住的性质（早先页确认过的选择不因后续页省略该 id 而失效）仍然成立。
   ⇒ 一个已被撤回确认的选项现在是**可见但不可提交**的，而不是静默地带着旧姓名提交。
3. **`directoryResolve` 的可取消延迟退避。** 原有 3 次有界重试背靠背、无真实时间间隔 ⇒ 从瞬时故障恢复实际上依赖
   别处再发一次 `ensureUserNamesResolved`，而消费页面没有任何一处会自动这么做。改为**有界、可取消、带延迟**的退避
   （累计约 0 / 300 / 1500 ms）；每个退避定时器都被跟踪，`__resetResolvedDirectoryNamesForTests` 取消全部。
   ⚠️ **修复自身引入的两个同类新洞在同一 PR 内被后续轮次抓住并关闭**
   （`feedback_scope_deferral_shield_does_not_cover_new_lines` 的一个实例）：退避窗口期的**重试放大**
   （一个持续失败的 id 被触碰两次 ⇒ 6 次请求而非 3 次，以 `inFlightUserIds` 关闭），
   以及该修复的 **per-group（每 50 id 分块）标记又在上一层重开了同一类缺口**
   （60-id flush 下 9 次而非 6 次，改为对整个 flush 的 id 集合一次性标记 / 清除）。
   两者均以 mutation 复证（`cp` + sha256 备份还原，从不用 `git checkout --`）。

#### 9.2.2 ⭐ 后端 identifiability 臂被**中途撤回** —— 记为一次闸门抓住的契约保真挽救

PR 过程中曾加入一条后端 `validateAndFreezeRequesterChoices` 的 identifiability 臂
（新错误码 `APPROVAL_REQUESTER_CHOICE_UNIDENTIFIED`，values-free），用来拒绝目录行姓名为空 / 缺失的被选审批人。
2026-08-21 的闸门把它判为 **P1 契约保真**并要求**整臂撤回**，理由是它**直接抵触已 RATIFIED 的
`approval-lock1-enterprise-assignees-20260817.md` §K2 创建期契约** —— 逐字：*"company accepts any active local user"* ——
且**没有任何 owner 亲署的批准**为它背书。撤回同时消解了三个只存在于该臂内部的问题：
它**还收窄了只读的 preview 面**、制造了一个**错误码 oracle**（检查顺序导致的跨作用域信息泄露），
以及一个 **200-id resolver 上限**造成的**假 422**。

撤回方式是把 `ApprovalProductService.ts`、`approval-requester-choice.db.test.ts`（G-20 测试 + fixture 重新播种）
与 workflow 的 `gates=` 行**逐字节还原**到 `13506666da`（fix round 之前）的状态；
复证方式是真库套件回到 **13/13** 且每个 K2 fixture 用户重新变回无名 ——
**只有在不再存在任何 identifiability 拒绝时才可能通过**（这是一条判别性正控，不是「不是错误 X」式的断言）。

> **必须逐字随行的 owner 开放项：**
> *"If this check is wanted, it needs an owner-authored §K2 amendment covering both create and preview before it lands again."*

⇒ 这是 §6.4 那**五条之外**的**第六条** owner 裁决项。**§6.4 标题里的「五条」不改** —— 那是对 `5feca2291b` 处闸门产出的
逐字计数，仍然为真；本条绑 `c473a079b5`。**本文不裁定这个检查该不该存在**，只记录它被撤回的理由与复活条件。

#### 9.2.3 普查守卫的**诚实性收窄**（不是能力扩张）

同一 PR 的 P2-2 修的是**守卫自己的 docstring**，不是守卫的能力。docstring 此前声称 *"this rebuild closes"*
「冻结清单漏掉新站点」这一失败模式，而它实际上只抓得到**原始 ID 访问在同一行内文本可见、且命中六个词法模式之一**的新站点；
**一个函数调用之外的渲染（内部读 `.id` / `.key` 的 helper）对逐行 grep 是结构性不可见的**。修法是：
把声明**收窄**到真实范围（known render patterns），补入一个**具名的已知规避例**（helper-function canary，**只文档化、未实现**），
并具名真正的后续方案 —— **统一的 person-label 组件 + AST 级禁令**，作为**类级**解法。**本轮未新增任何扫描器。**

⚠️ **这一条不改变 §2.5 / §5.1 对该类的判定。** 交付报告此前的口径本来就是诚实的
（*"类不宣告闭合"*；作用域逐字 = 仅 `src/approvals/**` + `src/views/approval/**`、仅那 6 个模式）。
**#5043 让工件的自述追平了报告的口径，没有让这个类更接近闭合**，也不构成把 §5.1 那一行改写成「已达」的依据。

### 9.3 `postgres:15-alpine` 生产臂 —— V-14 残留第 1 轴关闭、第 3a 半轴首次行使

**绑 run SHA `13506666dae30dbeee1fb145392ff7ecfeb3e093`**（该臂两条独立车道各自 `git rev-parse origin/main` 于开跑时取得）。
⚠️ **这个 SHA 既不是本文的读取基线，也不是本文的 exact-main，也不是 freshness base。本节的每一个数字只绑它。**

- **镜像与服务端亲证**：`postgres:15-alpine` @ digest `sha256:fe0737ba…e57f1b`
  （= 三份部署 compose 与 `docker/dev-postgres.yml` 所钉的同一 tag）；`select version()` 逐字 =
  `PostgreSQL 15.19 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit`。
  **`unknown-linux-musl` 出现在服务端自报的 `version()` 里 ⇒ 这是服务端亲证，不是文件文本断言。**
- **覆盖**：`approval-*` 真库套件清单在该 SHA 上已由 66 增至 **67**（新增件 = Lock-7b 的
  `approval-lock7b-required-at-node.db.test.ts`）；⚠️ **一处对该裁决的更正**：其 §2.1 的括注把这个新增件归给 20260819 硬化 PR #5004，
  **这不成立** —— `git log --diff-filter=A` 显示该文件由 **#5026 `5feca2291b`** 首次加入（本文 §1 抬头与 §7.4 的 66 → 67 计数亦然：
  `6cca7ec0ed` 已晚于 #5004 而彼时仍是 66）。数字与结论不受影响，归属更正在此。
  **67/67 全部执行，零 skip、零 error、零 NOT-RUN、零 pending**；**588 条测试全部通过**（315 + 293 − 20 交叠）；
  **319 条迁移 exit 0**，迁移名单与 V-14 的 PG14 臂 diff 为空。
- **与 V-14 的对齐**：66 个 V-14 可比套件的**逐套件已执行数与 V-14 双臂完全相同**（合计 574 = 574）。
  ⚠️ **本轮 oracle 是「逐套件已执行数等势 + pass/fail + zero-pending」，不是逐条 test-name 集合同一性** ——
  **不得**声称逐条 test-name 与 V-14 相同。

**该裁决 §5 的处置逐字引用（不得改写、不得摘要）：**

> **不得写"approval 线在生产 PG 上的兼容性已被证明"，不得写"musl / collation 轴已关闭"，不得写"生产数据库版本已验证"。**
>
> 准确表述为 —— **V-14 残留清单的第 1 轴（PG15 从未被跑过）已关闭，第 3a 半轴（服务端 musl libc）已首次行使且行使出了一个可测的底座差异（`COLLATE "en_US.utf8"` 在生产镜像上不存在、musl 走 codepoint 序），而这 67 个套件对该差异全无反应；第 2 轴（灵敏度正控）、第 3b 半轴（x86_64 / 客户端架构）、第 4 轴（schema-diff，含未对账的 296 vs 301）、第 5 轴（重复轮，仅 1/67 达 n=2）四条仍未被触及，另新增第 6 条残留（lock7b 无跨大版本基线）。**
>
> 附加禁令三条：
> 1. **不得把 §3.4 的"零套件失败"写成"musl 差异无害"。** 已证的只有"这些套件不敏感"；"生产里无害"没有证据 —— 二者是两句话。
> 2. **不得声称本轮与 V-14 的逐条 test-name 集合相同。** 本轮 oracle 是**逐套件已执行数等势 + pass/fail + zero-pending**，没有跑 name-set diff（见 §2.4）。
> 3. **不得把 296 vs 301 写成"已确认无差异"或"已知无害"。** 准确态是**未对账**（§4 轴 4）。

**🆕 新增的 latent / CI-blind 前向风险（该臂最有价值的产出；记录，不"修复"）：**
15-alpine 的 `pg_collation` **不含任何 libc `en_US.utf8` 行**（只有 `C` / `POSIX` / ICU 条目）
⇒ SQL 里写 `COLLATE "en_US.utf8"` 会在**生产镜像上运行时报错**，却能**通过全部 CI 臂与 V-14 四臂**（Debian glibc）。
同时 `lc_collate` 的**名字**两边相同（`en_US.utf8`）而**行为**不同 —— musl 走 codepoint 序：
`ORDER BY` over `('a','B','b','A','z','Z')` → `A B Z a b z`（Debian glibc 为 `a A b B z Z`）；
`select 'a' < 'B'` 在 15-alpine 为 **false**、在 `postgres:14` 为 true。
分类：**latent**（该 SHA 处仓内仅有的两处活的显式 COLLATE 都是 `"C"`，且都在这 319 条里被实际执行并通过）、
**CI-blind**（该 SHA 处 `.github/workflows/` 下 alpine 出现次数 = **0**）、
**forward hazard**（新写一句 `COLLATE "en_US.utf8"` 会全绿合入、部署时才炸）。
**不是活漏洞，不改变本轮的 PASS 结论；不在此处加守卫**（regex 守卫可被删 —— `feedback_asserted_invariant_is_a_bug`），
解法选项交 owner 裁。

**一条对本文既有事实的更正（该裁决 §3.5，必须随行）：** 本文 §4.4 与验证报告 §1 / §4.2 把
「没有任何 CI leg 跑过 PG15」写成了无条件句。精确化之后：`.github/workflows/smoke-verify.yml:11` 确实钉着
`image: postgres:15`（Debian glibc），但它是 **`workflow_dispatch` only、非 required check、不跑任何 approval 套件**。
⇒ 准确表述 = **没有任何 CI leg 在 PG15 上跑过 approval 真库套件，也没有任何 CI leg 用过 alpine 镜像**。
**alpine 那一半成立且比原句更强；PG15 那一半需要这条限定。**

⚠️ **线上 `server_version` 仍未亲查。** compose 钉 `postgres:15-alpine` 是**文件文本断言**；
「线上确实跑着它」这一步**没有证据**（`feedback_source_text_assertions_are_not_behaviour`）。

### 9.4 本节新增声明的 SHA 作用域一览（逐条）

| 新增声明 | 绑定 SHA | 明确**不**绑什么 |
|---|---|---|
| §9.1 台账漂移 CLOSED | `627945523b`（于 `c473a079b5` 复核） | 不改 AC-10 的 NOT RUN；不关闭 G-14 |
| §9.2.1 三项前端修复已落地 | `545b3cadd1`（于 `c473a079b5` 复核） | 不是对本文任何 `[源读]` 锚点的重读 |
| §9.2.2 后端臂撤回 + §K2 owner 开放项 | `545b3cadd1`；被引契约 = 已 RATIFIED 的 Lock-1 §K2 | 不裁定该检查是否应当存在；不改 §6.4 的「五条」计数 |
| §9.2.3 普查 docstring 收窄 | `545b3cadd1` | **不**改变 §2.5 / §5.1 的「类不宣告闭合」 |
| §9.3 67/67 · 588 测试 · 319 迁移 | **`13506666dae3`**（该臂 run SHA） | 不绑 `6cca7ec0ed`、不绑 `5feca2291b`、不绑 `c473a079b5`；**不**是「生产 PG 兼容性已证」 |
| §9.3 `COLLATE "en_US.utf8"` 前向风险 | `13506666dae3` | 未修复、未加守卫；**不**判定为活漏洞 |
| §9.3 smoke-verify 钉 `postgres:15` 的更正 | `13506666dae3` | 不改变任何处置 |

### 9.5 freshness pass **没有**改变的事（逐条重申，不得被读成软化）

1. **V-1 仍是 NOT DISCHARGED**（验证报告 §4.1）。本节零行矩阵重跑。
2. **完成标签全部 NO；开关全部 OFF**（§8.1 / §8.2）。本节不开任何开关、不签任何标签、不批准任何东西。
3. **squash 祖先纪律**（§0.2 与验证报告 §6.1 的十对 NOT-ancestor）逐字不变；#5040 自己也把这条纪律写进了台账。
4. **#5024 闸门工件的 §Residual 与 mutation-B 内容仍刻意不复现**（§8.4 第 12 条）——
   freshness pass **没有**扩大任何披露面，也没有在本 PR 的任何公开面上复述它们。
5. **AC-10 仍是 NOT RUN**；§6.4 的五条 owner 裁决项**一条未关闭**，§9.2.2 只是在其**之外**新增第六条。
6. **本节没有在 `c473a079b5` 上重读任何 `[源读]` 锚点、也没有在它上面重跑任何一行验证。**

---

*本文档终。它记录设计，不改变任何东西的状态。*

---

## 10. 2026-08-21 → 08-22 第二波 freshness pass —— 评论线四切片 + S1 + Lock-9 附件全部落地

**本段与 §9 同规:只做锚点分层与事实追加,不改本文任何既有句子的 SHA 绑定;不重跑此前任何验证行;
不批准任何东西、不开启任何开关。** 各 PR 的门审/复审判定一律绑各自 **pre-squash head**,落地为 squash
提交——两者之间的祖先关系按房例不可由 SHA 建立,逐对具名如下。

### 10.1 六个落地物(合并序)

| PR | 内容 | 判定链(绑 pre-squash head) | squash 落地 |
|---|---|---|---|
| #5072 | S3a:共享评论 FE kit 抽取(`apps/web/src/shared/comments/`,CommentsApiClient 接口;multitable 行为冻结 4954 测试) | FIX-ROUND@`d95e2f05ba` → 修复 → requal MERGE-CLEAN@`7c16f33e3a`(冻结 HI-1 扫描换锚判**记账修复**——锁文无路径可抵触;发现 P3-A importer 豁免静默继承,绊线随 #5088 落地) | `25385331b8` |
| #5078 | 六项 owner 裁决记录(第二次 by-reference)+ L9-AMEND arm (a) 执行(Lock-10 §5.1.1、Lock-9 §4.1、台账 §3) | FIX-ROUND@`9b6a80bc9a`(2P1:§4.1 曾越权列入 bind-time 面、§L9-C 站点级增注缺)→ CLEAN@`57cfc5508c` → 锚点校正 CLEAN@`e621f147fe` | `dd7fa8630248` |
| #5070 | **S1**:`canReadApprovalInstance` 五臂谓词、`org_id` 六类有序 backfill 迁移(仅阶段 1-2)、detail/history 同切片 404(仅平台 id)、metrics 放宽、`isInstanceParticipant` 删除 | 门审 FIX-ROUND@`343377946e` → 修复@`75417497c7` → requal FIX-ROUND(P1-NEW 红 CI 等)→ 修复轮 2 + 第三次裁决记录 → requal round-3 MERGE-CLEAN@`f163ad708b` | `9fcccd69c3` |
| #5087 | **S2**:`approval_comments`(真 FK+CASCADE、双墓碑 CHECK)、五函数 service、读写同谓词(OD-S1-14)、audit 指针行 + `/history` 双查询排除(HISTORY-TIMELINE arm (i))、mention seam fail-closed | 门审 FIX-ROUND@`87323c90d1`(P2-1 mentions-cleared 臂零载荷)→ 修复 → requal MERGE-CLEAN@`2911e3e4a0`(3-cell 矩阵证独立载荷) | `b2b4198e01` |
| #5088 | **S3b**:审批评论页签(kit 适配器 + 包装面板)、census importer 绊线(P3-A 闭环)、S2 随行硬化(D-1 parity+级联门/fixture 拆分/幂等) | 门审 FIX-ROUND@`c9b058bc4a`(2P2:截断窗保错端、settle race)→ 修复@`6e1959be00` → requal FIX-ROUND(N-1 mock 队列位置型)→ 修复轮 2 → requal round-2 MERGE-CLEAN@`e7c5b29691` | `1efebe9504` |
| #5089 | **Lock-9 附件**:放宽迁移(NULL-safe CHECK 再表达,亲探 Postgres 三值逻辑证明必要)、过程上传(真实办理席位判定,含并行区 frontier 修复)、staged→bind 提交(rowCount 等值回滚)、`/download`+`/refs` bind_kind 分支、过程域预算、G-1..G-16(G-4 用 §4.1 修正态) | 门审 FIX-ROUND@`a252cacad5`(P2-1 flag-OFF 非字节 no-op 违 G-12(b);P2-2 并行区上传全 403)→ 修复 → requal MERGE-CLEAN@`acff7eb754`(行级 parity:双 boot 三表快照 sha256 同值;16 门全重 mutation,15 载荷) | `f15b4252df` |

### 10.2 三次 by-reference 裁决(均 2026-08-21,owner 亲写「按建议执行」,建议文全部会话作)

第一次(§9 已录):§K2 不改 / G-14 accepted-as-amended / Lock-9 ratify / 评论 D 臂。
**第二次**(Lock-10 §5.1.1 逐字引用):L9-AMEND arm (a)、OD-S1-12 确认、OD-S1-7/C-2 确认、OD-S1-17(c)=(c-i) 并集、OD-S1-8(d) KEEP、HISTORY-TIMELINE arm (i)。
**第三次**(Lock-10 §5.1.2 逐字引用):P2-1 org pin **蛰伏态确认**(`APPROVAL_S1_ORG_PIN_ENABLED` 默认 OFF;激活=backfill 验证后独立授权步骤,需自己的台账行)、P2-2(b) **G-S1-12-PARTIAL**(落地测试钉 `is_nullable='YES'`;阶段 3 `SET NOT NULL` 为具名后续切片,独立授权)。

### 10.3 本波之后仍然悬着的(不因本段而减少)

- **owner 授权点(三,均未执行)**:org pin 激活;阶段 3 `SET NOT NULL`;`APPROVAL_ATTACHMENTS_ENABLED` 开启(其部署前置——放宽迁移——已随 #5089 落地,但开关仍 OFF,G-12 证 OFF=字节级 no-op)。
- **owner 开放行**:Lock-10 §5.1 feed-branch 行(§5.2 (i)(i-b)(i-c))仍 OPEN,G-S1-8 expected-red 只记不落;S2 P3-1(arm-5→arm-3 铸造,首例路由)知会;S2 P3-2(mention CTE 无 org 合取,仅 pin-ON 可见);S3b census `authorId` token 缺口(记 PR body,owner-scope)。
- **carried 非阻断残项(具名,防「全清」误读)**:S3b N2-1(截断守卫缺 2150 非对齐 total)、N2-2(短页分支端点未钉,今日不可达);Lock-9 P3-1(上传预算 TOCTOU——与 shipped form 路径同族,bind 权威成立)、P3-2(G-13 正控年龄混杂,mutation 存活)、P3-3(G-1 正控缺失)、NIT-1..4。
- **C-5 plm: 姿态、§5.2(iii) 残留、#5024 披露约束**:全部照旧,本段不改。
