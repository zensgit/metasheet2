# 审批对标程序 — 验证报告（FINAL，2026-08-18）

**Status:** FINAL — 实现尾部已全部落地（唯一在飞行的实现切片 = K6 `#4993`，Lock-2 §L2-C；已 rebase、CI 运行中、闸门 MERGE-CLEAN 0 P1）。
**P7 phase-B**（§2.5）在 fresh `origin/main` 真复核了一个子集：**8/8 phase-A FAIL FIXED**（FAIL-0 带一个具名 carried-forward 残留）、**15/15 已落地特性判别检查 PASS**、**6/6 优越性 re-smoke PASS**、**子集内零个新 FAIL**——这是**子集**复核，非全 127 行矩阵重跑（V-1）。
本文件**不是完成声明**，不 ratify 任何东西，不授权任何 flag、部署或 UAT。

| 锚点 | 值 |
|---|---|
| 仓库 | `zensgit/metasheet2` |
| 撰写日期 | 2026-08-18 |
| **审批程序当前 head** | `6abd241925` — `feat(approval): K1 — user_group assignee kind (#4995)` |
| **当前 `origin/main`** | `350325094a`（K1 之后 7 个提交全为非审批 docs/ci） |
| **P7 phase-A 验证执行 SHA** | `680e93c018490b6d98cf7251fe431458c350afb5`（**≠ 当前 head**，见 §2.0） |
| 治理设计权威 | `docs/development/approval-parity-master-design-lock-20260817.md`（RATIFIED，§9） |
| 执行真相 | `docs/development/approval-parity-execution-ledger-20260817.md`（LIVING） |
| 验收矩阵母本 | `docs/development/approval-parity-final-verification-20260817.md`（Status: **NOT RUN**） |
| Phase-A 证据台账 | `scratchpad/p7-phaseA-evidence-20260818.md`（770 行，127 行判定） |
| 主分支必需检查（实测） | 9 条，`strict=true`，`enforce_admins=true`（§4.1） |
| Flags | 全程 OFF（代码默认，非环境观测） |

> **M11 语言纪律**：本文件用「参考语料未证实（the reference corpus did not evidence）」而非「竞品没有」；
> 用「已实现于默认关闭的开关之后」而非「已交付」。任何未出现在来源中的数字一律标 `TAIL-PENDING`，不推算。

> **诚实分层承重（本 FINAL 新增一个显式层）**：`LANDED-VERIFY` = **承载切片已在 merged main；但该矩阵行未在当前 head 重跑**。
> 它**不是 PASS**，**绝不与 PASS 求和**。尾部切片落地后，Phase-A 里被落地取代的行由 `SUPERSEDED-BY-LANDING`
> 升为 `LANDED-VERIFY`（承载在 main，全矩阵重跑待办）。

---

## 1. 验证方法论

### 1.1 对抗闸门纪律（adversarial gate）

每个实现切片走同一条流水线：`draft → 独立评审 → ratify → 实现 → 独立对抗闸门 → 修复轮 → 合并`。规则逐条来自 master §6/§7 与 ledger §0：

| 规则 | 出处 | 本程序执行形态 |
|---|---|---|
| 判定绑 SHA | ledger §0 规则 3 | 每份闸门 MD 头部钉 reviewed head SHA；rebase 后必须 requalify。尾部 **#4983 三轮**（`464ec8a5c7` → `c3e56d0ba3` NOT-CLEAR → `007f71e53b` CLEAR）、**#4995 两轮**（`f7e2780366` → `0b7d0860bf` requalify，抓到同类新 P1）均实际执行 |
| 分离状态位 | ledger §0 规则 2：`CI green`/`review approved`/`merged`/`deployed`/`UAT passed`/`flag enabled` 彼此独立 | §3 每行拆「reviewed SHA + 判定 / 修复轮 / 合并 squash SHA（是否重审）」 |
| 闸门用最强模型 | master §6 | 闸门 Opus；实现切片可用中档模型 |
| 无自我 ratify | master §6 | 见 §6.1 provenance 分层 |
| 外部模型输出不是证据 | master §6 | 闸门必须自跑测试、自构造反例、记录 reviewed SHA |

### 1.2 变异 + 正控（mutation with positive control）

master §7：「Every behavioral guard needs a positive control and a discriminating negative or mutation」。执行细节与踩过的坑：
- **每次变异先断言锚点命中，再断言文件真变（sha256），跑完 `cp` 还原并再次校验。** 全程**禁用 `git checkout --`**（含 targeted 形）。
- **析取式判定必须逐项单删。**（F3 闸门 11 undiscriminated arms → per-arm fixtures）。
- **「断言不发生」必须配正控。**（#4979 P2-1：空数组豁免的正控「Mutation A left 19/19 green」→ 修复后「reds exactly that assertion」）。
- **变异必须打执行点，不是同名声明。**（#4980 M10 把 choke 移到 lock 字面位置「reds exactly that test and nothing else」；V-3 闭合 Mutation D/A 恰红 `:593`/`:399` 两个不重叠测试）。

### 1.3 真库双点接线（real-DB two-point wiring）

五条独立 workflow 的注释逐字同一段：每个真库套件在**加入 workflow 的同一 commit 里**从无库默认 `packages/core-backend/vitest.config.ts` 中**排除**（这样必需 `test (18.x/20.x)` 不再 collect-and-skip-green 它），而这条 workflow 是它**实际执行**处，`EXPECT_DB=1` 武装顶层 anti-skip 哨兵。**单点接线**（只排除不加车道，或只加车道不排除）就是 FAIL-0 那一类缺陷的成因（§2.3）。
**P7-R1 #4984 新增一条 `approval-realdb-p7r1-coverage-repair.yml`**，把两个孤儿真库套件双点接线；其**残留 P2-1** = 该 workflow 的 9 个套件中 6 个缺自身哨兵（§2.4）。

### 1.4 真实 Chromium

master §5：「Drag-and-drop editor：mounted test plus **real Chromium** …；Browser geometry：real Chromium at 1440, 1024, and 390」。Phase-A：Chromium via Playwright 1.57.0，三视口 1440×900 / 1024×768 / 390×844。**jsdom 不算**——P1-D 的 jsdom 证据在 ledger 明记「NOT discharged this slice」，Phase-A 第一次真跑它而它失败（FAIL-2）。

### 1.5 六级诚实分层 + 本 FINAL 的 LANDED-VERIFY

Phase-A 台账用六级（`PASS` / `PASS-POSITIVE-ONLY` / `FAIL` / `NOT-YET-LANDED(slice)` / `OWNER-ONLY` / `BLOCKED-ENV(reason)`）。
`PASS-POSITIVE-ONLY`：套件跑绿但**该行的判别性反例未在本次构造**，所欠反例逐行点名。**这是本程序验证诚实性的承重点**：63 行绿测试没有被写成 PASS。
本 FINAL 追加 **`LANDED-VERIFY`**（承载切片已在 merged main、矩阵行未在当前 head 重跑）——它替代了 DRAFT 里 `SUPERSEDED-BY-LANDING` 的大多数行，**仍不是 PASS**。
**P7 phase-B**（§2.5，`scratchpad/p7-phaseB-evidence-20260818.md`）在 fresh `origin/main` 对**一个子集**（8 个 phase-A FAIL + 15 个已落地特性判别检查 + 6 项优越性）做了真复核，把这些 `LANDED-VERIFY` / `FAIL` 行升为带证据的 **FIXED / PASS**（`FAIL-0` 例外，见下）。**但这是子集复核，不是全 127 行矩阵重跑**——其余行（含 63 个 PASS-POSITIVE-ONLY 所欠反例）仍是 `LANDED-VERIFY` / `PASS-POSITIVE-ONLY`（V-1）。

---

## 2. Phase-A 矩阵结果

### 2.0 ⚠️ SHA 作用域声明（读本节前必读）

Phase-A 全部 127 行在 **`680e93c018`** 上执行。当前审批 head 是 **`6abd241925`**，其间落了一整串审批提交。DRAFT 记的 9 行 `SUPERSEDED-BY-LANDING` 现在其承载切片**都已在 main**：

| 落地提交 | PR | 影响的 Phase-A 行 | 现分层 |
|---|---|---|---|
| `90c41fbf60` | #4973 K3 | §11 NYL K3 行 | LANDED-VERIFY |
| `4259d9fde8` | #4974 L8-A | §11 NYL L8-A 行 | LANDED-VERIFY |
| `6a67eccea1` | #4979 D-1 | 「D-1 STILL PRESENT」行 | **翻转**：read 轴现 400（§2.4 复核） |
| `3335ccc435` | #4972 P1-C | I4/I5/I6/I12/I13、I9 timeout 半边、§10「ApprovalMode BE 4 vs FE 3」 | LANDED-VERIFY |
| `d034b1f710` | #4980 P5 L5-A | **R7（操作策略）** | LANDED-VERIFY |
| `6488353bf8` | #4981 P7-R2 | FAIL-2/5/6 | **FIXED**（phase-B §2.5） |
| `512f0df608` | #4984 P7-R1 | FAIL-0/1/3/4/7 | **FIXED**（FAIL-0 = FIXED-with-named-residual，phase-B §2.5） |
| `345a1f1c0e` | #4994 F4 | §3 gate 5 mount canary、F10 | **翻转**：mount 已达（§2.3 gate 5；phase-B 两侧闸复核 PASS） |
| `6abd241925` | #4995 K1 | 派单人 union、I 族 roster 行 | **PASS**（phase-B §2.5 Part 2） |

已用当前 head 源码机械复核的取代事实（这是取代/翻转，不是重跑矩阵）：

| 复核项 | 命令 / 锚点 | 当前 head 观测 |
|---|---|---|
| FE `ApprovalMode` | `apps/web/src/types/approval.ts:29` | `'single' \| 'all' \| 'any' \| 'threshold'` — **4 成员，与后端一致**（Phase-A 时为 3） |
| BE `ApprovalMode` | `approval-product.ts:20` | 同 4 成员；**`sequential` 未落地** |
| 派单人种类联合 | BE `approval-product.ts:19` + FE `approvalCapabilityRegistry.ts` | **13 种，前后端逐字一致**（K1 `user_group` 落地，Phase-A 时为 11，DRAFT head 12） |
| 表单字段类型联合 | BE / FE | **13 种，前后端逐字一致** |
| `nodeOperationPolicy` | `approvalCapabilityRegistry.ts`（`operationPoliciesByNodeType` 对 `approval`/`handler` populate） | **操作策略轴已落地**（P5 L5-A #4980，解除 R7） |
| D-1 read axis | `ApprovalProductService.ts`（#4979） | 由「静默丢弃」改为对 `readonly`/`hidden`/非数组形状**返回 400**（可逆收窄，§6.2） |
| F10 生产挂载 | `TemplateAuthoringView.vue:333/338`（`showFormBuilderV2` 后）；`approval-form-builder-slots.spec.ts:1118` FLIPPED PIN | **挂载已达**；行为级 mount 证明在必需 `approvalTemplateAuthoring.spec.ts`，F4 闸门 M1/M2 变异各打红 8/9 项；phase-B 两侧闸复核 PASS，F10 pin inverted-not-deleted |

**TAIL-PENDING V-1（仍未解除）：Phase-A 127 行矩阵未在当前 head 重跑。** 只有重跑才能把这些 `LANDED-VERIFY` 行转成带证据的判定。这是本 FINAL 剩下的**最大一块验证债之一**，属 owner/后续版本工作（代码代理已把承载切片全部落地，但全矩阵重跑需要精确部署的 merged-main SHA + 真库 + 组装应用）。

### 2.1 汇总（`680e93c018` 作用域，历史记录）

| Verdict | Count | Where |
|---|---|---|
| PASS | 21 | §3×6, §2×4, F×4, U×1, I×1, R×1, §7-checklist×2, D×1, superiority×1 |
| PASS-POSITIVE-ONLY | 63 | §3×1, §2×3, F×7, U×5, I×7, R×9, M×6, §7-grid×5, §7-checklist×2, V×6, D×7, superiority×5 |
| **FAIL** | **6** | I7, R8, §7-grid flow-canvas ×3, §7-checklist「颜色不是唯一载体」 |
| NOT-YET-LANDED | 8 | §3×1（mount canary）, F10, I4/I5/I6/I12/I13, R7 |
| OWNER-ONLY | 16 | §2×1 + 15 行 owner block |
| BLOCKED-ENV | 13 | §3×2, §2×1, §7-grid×7, §7-checklist×2, V5 |
| **Total** | **127** | |

**⚠️ 尾部落地后的位移**：8 个 `NOT-YET-LANDED` 的承载切片现在**全部在 main**——F10（F4 #4994）、I4/I5/I6/I12/I13（P1-C #4972）、R7（P5 L5-A #4980）、mount canary（F4 #4994）。**P7 phase-B（§2.5）已对其中多数 + 8 个 FAIL + 6 项优越性做真复核**（fresh `origin/main`、real Chromium、全新 DB），把它们从 `LANDED-VERIFY` 升为带证据的 `FIXED` / `PASS`；未被 phase-B 覆盖的行仍是 `LANDED-VERIFY`。**行数 ≠ 发现数**：6 行 FAIL 只引用两个发现；§2 里有 **8 个不同发现**（父发现 FAIL-0 + FAIL-1..7），FAIL-1/4/5/6/7 **不对应任何矩阵行**——它们是执行矩阵时在**验证器具本身**发现的缺陷。

### 2.2 各族分解（`680e93c018` 作用域）

| Family | rows | PASS | PPO | FAIL | NYL | OWNER | BLOCKED |
|---|---|---|---|---|---|---|---|
| §3 gate battery | 10 | 6 | 1 | 0 | 1 | 0 | 2 |
| §2 static/contract | 9 | 4 | 3 | 0 | 0 | 1 | 1 |
| §4 F1–F12 form builder | 12 | 4 | 7 | 0 | 1 | 0 | 0 |
| §4.1 U1–U6 shell | 6 | 1 | 5 | 0 | 0 | 0 | 0 |
| §5 I1–I14 inspector | 14 | 1 | 7 | 1 | 5 | 0 | 0 |
| §6 R1–R12 runtime | 12 | 1 | 9 | 1 | 1 | 0 | 0 |
| §6.1 M1–M6 detail/center | 6 | 0 | 6 | 0 | 0 | 0 | 0 |
| §7 viewport grid (3×5) | 15 | 0 | 5 | 3 | 0 | 0 | 7 |
| §7 a11y checklist | 7 | 2 | 2 | 1 | 0 | 0 | 2 |
| §8 V1–V7 version/migration | 7 | 0 | 6 | 0 | 0 | 0 | 1 |
| §9 D1–D8 data closure（代码半边） | 8 | 1 | 7 | 0 | 0 | 0 | 0 |
| 六项优越性声明 | 6 | 1 | 5 | 0 | 0 | 0 | 0 |
| Owner block (§0/§10/§12) | 15 | 0 | 0 | 0 | 0 | 15 | 0 |
| **Total** | **127** | **21** | **63** | **6** | **8** | **16** | **13** |

### 2.3 闸门电池（母本 §3 的十行，`680e93c018` 执行 + 当前 head 复核）

| # | Gate | 结果 | Tier |
|---|---|---|---|
| 1 | Web type check | **rc=0** | PASS |
| 2 | Web build | **rc=0** | PASS |
| 3 | Required web tests | **rc=0** — 368 files / 4628 tests（Phase-A）；F4 head 上 **370 files / 4727 tests**（F4 闸门复核） | PASS |
| 4 | Approval guard canaries | **rc=0**（Canvas-V2 + FWB + targeted 三列表，均在 required-web 内） | PASS |
| 5 | **Production-command mount canary** | **翻转 → LANDED**：F4 #4994 落地生产挂载；行为级 mounted-iff-flag 证明在必需 `approvalTemplateAuthoring.spec.ts`，M1/M2 变异各打红 8/9 项（含 flag-OFF pin）；phase-B 两侧闸复核 PASS | **PASS**（phase-B §2.5，原 NOT-YET-LANDED (F4)） |
| 6 | Backend type check | **rc=0**（CI-exact） | PASS |
| 7 | Backend unit | **650 files passed / 185 skipped；9422 tests passed / 1622 skipped，333.35s** | PASS |
| 8 | Approval real DB | 16/18 绿；2 车道带 FAIL-3 / FAIL-4（Phase-A）；**phase-B 在全新专用 DB 复核 FAIL-3 = 5 passed、FAIL-4 = 1 passed** | PASS-POSITIVE-ONLY → **FIXED**（phase-B §2.5） |
| 9 | Migration replay | replay 绿；upgrade 半边不可执行 | BLOCKED-ENV-4 |
| 10 | Root required checks | **本 FINAL 撰写时实测**：9 条 + `strict=true` + `enforce_admins=true`（§4.1） | 离散关闭 BLOCKED-ENV-5（当前 head 读，不改写 Phase-A 那行） |

### 2.4 八个 FAIL 及其修复 PR —— **P7 phase-B 复核 = 8/8 FIXED**

> 台账承重句逐字保留：「All seven are **evidence-integrity / a11y** defects. **None is a product-logic regression.** That distinction is load-bearing and is proven per finding, not asserted.」

**P7 phase-B**（§2.5）在 fresh `origin/main` = `6abd241925`（隔离 worktree + 全新专用 DB + real Chromium + Node 20.20.2）逐行复核这八个 FAIL：**8/8 FIXED，re-verified 子集内零个新 FAIL**。

| # | 严重度 | 一句话 | 修复 PR（合并 SHA） | phase-B 复核状态（fresh `origin/main`） |
|---|---|---|---|---|
| **FAIL-0** | 父发现 | 四个审批面测试制品在零 CI workflow 执行 | #4984 `512f0df608` | **FIXED-with-named-residual**：四个具名实例全接线 + 6 个此前未门控套件双点接线；**残留 = 无机械枚举守卫**（排除清单手工维护，下一个未接线 spec 会复发）——carried-forward 硬化项，**非活缺陷（无一复现）**；与 #4984 闸门 P2-1 同一面 |
| FAIL-1 | P1 | `approval-inspector-keyboard.spec.ts` 在 main 红——harness 挂载抛异常 | #4984 | **FIXED**：real Chromium **1 passed (810ms)**；harness 导入当前 `ApprovalNodeConfigEditorApi` + 生产 CSS；path filter 加宽 4 个 `apps/web/src/approvals/**`。**DRAFT 曾提的「#4944-源起运行时红」在 phase-B 复核为已修** |
| FAIL-2 | P2 | V-6 焦点环对比度 13/19 低于 ≥3:1 | #4981 `6488353bf8` | **FIXED**：real Chromium 重测三视口 **19 PASS / 0 FAIL / 0 NO-RING**（viewport 4.95、toolbar 族 5.17） |
| FAIL-3 | P2 | `approval-node-entry-epoch.test.ts` 在 main 100% 红 | #4984 | **FIXED**：全新 `metasheet_p7b_epoch` DB **5 passed / 1 skipped** |
| FAIL-4 | P2 | `approval-wp1-any-mode.api.test.ts` 同因 | #4984 | **FIXED**：全新 `metasheet_p7b_anymode` DB **1 passed / 1 skipped** |
| FAIL-5 | P2 | 浏览器 harness 不加载生产样式表 | #4981 | **FIXED**：两 harness 均 `import` 生产样式表；non-vacuous 重测 form-builder 29 ring-PASS（5.17）、inspector 25 ring-PASS（16.55） |
| FAIL-6 | P3 | `handler` 无 per-type 强调色 | #4981 | **FIXED（fix 选了一个 shape）**：`handler` 用 `--el-color-info`，4/7 类型共享 info 强调色——**owner shape 裁定项**（§6.3 / 开发报告 §7.8） |
| FAIL-7 | P3 | `useApprovalBatchActions.spec.ts` 在零 workflow 执行 | #4984 | **FIXED**：进 run-list + guard；本地 4 passed；UNION 存活已核（§4.5） |

**✅ TAIL-PENDING V-2 —— DISCHARGED（8/8 FIXED），带一个具名 carried-forward 残留：** 八个 FAIL 的修复不仅合并进 main，且在 fresh `origin/main` 被 phase-B 逐行真复核为 FIXED（real Chromium / 全新 DB，defeat grant 残留 false-green）。**唯一残留** = FAIL-0 的机械枚举守卫（#4984 闸门 P2-1 的另一面）：现无一复现，但复发通道未被机械封死——记为 carried-forward 硬化项（owner/后续版本），**不是活缺陷**。边界：phase-B 是**子集**复核（8 FAIL + 15 特性 + 6 优越性），非全 127 行矩阵重跑（V-1）；且跑在本地 PG 15.17（V-14）。

#### FAIL-0 的机制（本次验证最有价值的发现，保留）
四个制品，一个缺陷类：真库套件没从无库 vitest 配置排除 ⇒ 被必需无库 `test (20.x)` 收集并 `describeIfDatabase`-**skip-green**，且不在任何真库车道；浏览器/单测制品被 workflow 的 **path filter** 漏掉（打破它的 PR 改 `apps/web/src/approvals/**`，守卫车道只过滤 `apps/web/verification/**`）。skip-green 群体实测规模 **9422 passed / 1622 skipped**，跨 **650 / 185** 文件——**CI 里没有任何东西区分「会在具名真库车道被重跑」和「哪里都不跑」这两种 skipped**。台账自陈这四个**不是穷举**；#4984 做了一次有界机械扫描（`approval*` 命名的 111 web + 138 backend = **249 文件**），该扫描**已随 #4984 落地**——但因 P2-1，**类别记 LANDED-VERIFY 而非关闭**。

#### FAIL-2 的实测数据（真 Chromium，加载生产样式表；修复前，保留为证据）
判据 `approval-canvas-v2-interaction-design-lock-20260721.md:412`（V-6）：「visible 2px focus ring at ≥ 3:1 contrast」。修复前 token `--el-color-primary-light-5: #92b1f5` ⇒ canvas viewport 2.05 / node cards 2.14 / toolbar 2.14 全部 FAIL（13 FAIL / 6 PASS，三视口一致）；三种候选相邻面（2.14 / 1.99 / 1.84）全部不过 ≥3:1，表里报最有利者。**#4981 修复后换到 `--el-color-primary`（4.49/4.95/5.17），全 ≥3:1。**

#### FAIL-3 / FAIL-4 的产品状态：**未坏**（证明的不是断言的）
两套件都是 fixture 腐烂而非产品回归：`POST /api/approvals` 从 DB 侧 `approvals:write` 授权，26 个集成套件通过 `grantApprovalWriteForIntegrationActor()` 播种，这两套件调用它 0 次；诊断变异加上 grant 后 FAIL-3 **5/5 全绿**、FAIL-4 **1 passed**。所以 epoch 轮次作用域、transfer/reassign epoch 保持、双 epoch fail-closed、NULL-epoch 双读——产品行为完好。**phase-B 在全新专用 DB（无 grant 残留）复现：FAIL-3 5 passed / 1 skipped、FAIL-4 1 passed / 1 skipped。**

### 2.5 P7 phase-B 增量复核（fresh `origin/main`，子集）

Phase-B（`scratchpad/p7-phaseB-evidence-20260818.md`）是对 phase-A 里 `NOT-YET-LANDED` / `SUPERSEDED-BY-LANDING` / `FAIL` 那一子集的增量真复核，**不是全 127 行矩阵重跑**。环境：verified SHA `6abd241925`（#4995 K1）；隔离 worktree、全新专用 DB（`metasheet_p7b_epoch/_anymode/_d1`，刻意不复用 phase-A DB 以 defeat grant 残留 false-green）；real Chromium（Playwright 1.57.0）；Node 20.20.2。**边界 delta（如实记录）**：本地 PG **15.17** vs CI `postgres:16`（V-14）；pnpm 10.33 vs CI 10.16.1。

| 组 | 行数 | PASS/FIXED | FAIL | carried-fwd | 说明 |
|---|---|---|---|---|---|
| Part 1 — 8 个 phase-A FAIL | 8 | **8 FIXED**（7 完全；FAIL-0 = FIXED-with-named-residual） | **0** | 1（FAIL-0 枚举守卫） | §2.4 |
| Part 2 — 已落地特性判别检查 | 15 | **15 PASS** | **0** | 0 | P1-C×7（含 I12 coercion 分支**已删**、BE/FE `ApprovalMode` divergence CLOSED）+ K3 + L8-A + D-1（真库 values-free 400，read 轴 CLOSED）+ K1（union 13/13）+ Lock-5 操作策略 choke + L6-A/P3-B + F4 两侧闸 |
| Part 3 — 六项优越性 re-smoke | 6 | **6 PASS** | **0** | 0 | 全部仍可用；FWB 仅 code 半边（功能半边 owner-only） |
| Part 4 — carried-forward（owner/env） | — | — | — | ~14 | 按设计未执行（§6.3/§6.4） |
| **phase-B 内新 FAIL** | | | **0** | | 仅限 re-verified 子集，非全面无回归声明 |

几处判别证据（逐字/锚点）：**I12** 的无守卫 coercion 分支在 `templateAuthoring.ts:707-715` **被删**（out-of-union `approvalMode` 强制 read-only，不再静默塌缩 `single`）；**§10** BE=FE `ApprovalMode` 均 4 成员（phase-A 点名的唯一 FE/BE divergence CLOSED）；**D-1** 真库「every access value on every non-write-capable node type is REJECTED with a typed values-free 400」，read 轴 CLOSED（`ApprovalProductService.ts:2582-2587`）；**F4** 两侧行为闸（`approvalTemplateAuthoring.spec.ts:3453` flag OFF 仅 legacy、Designer 2.0 完全缺席；`:3478` flag ON+hydrated 挂载、legacy 缺席），F10 pin **inverted-not-deleted**（`slots.spec.ts:1146-1155`）。**I10/R12 absence-list 已刷新**：FE 与 BE `ApprovalAssigneeSourceKind` 是**同一 13 成员 union**（resolver case-arm 奇偶未机械再确认——裸串 regex 不可靠，该行只落在实测到的两个事实上）；`sequential`（K6）+ Lock-6 B–F 标识符仍缺。

**这不推翻 §6.5 的 PASS-POSITIVE-ONLY 债**：phase-B 是子集复核，那 63 行绿测试所欠的判别性反例（33 显式点名子集）**没有**在 phase-B 构造——V-1 / V-12 仍 OPEN。

---

## 3. 逐切片闸门证据

### 3.1 读表规则（承重）
三列而不是两列：闸门大多在「合并前某个 head」上判 CLEAR，上面还叠了修复轮，而合并进 main 的 squash SHA **通常没有被重新过闸**。把这三件事塌缩成「闸门 CLEAR，已合并」就是超额声明。缩写 SHA 一律逐字照抄闸门 MD，**不手工扩全**。

### 3.2 P0 表单构建（delta §5 F0–F4）

| 切片 | PR | Reviewed SHA + 判定 | P1/P2/P3/NIT | 修复轮 | 合并 squash SHA | 合并后重审? |
|---|---|---|---|---|---|---|
| F0 抽取 `ApprovalFormInlineEditor` | #4939 | `8e65ab166c…` — REQUEST-CHANGES | 1/3/0/3 | MD 内未执行 | `2f4bf6ce3e` | 否 |
| F1 命令适配器 + ID 分配器 + 引用提供者 | #4942 | `c9f7ce3bfd…` — REQUEST-CHANGES | 0/4/3/3 | MD 内未执行 | `c7f736b370` | 否 |
| F2 精确插槽 + 拖拽编解码 + 浏览器 harness | #4949 | `53c27520b5…` — APPROVE-with-hardening | 0/0/6/3 | 不适用 | `5a81400ebe` | — |
| F3 类型化 retype + 选中字段检查器 | #4954 | `deaaeea983…` — FIX-ROUND → requalified `c7970b396d…` = **CLEAR** | 0/3/4/2 | 是 | `0766eb35e5` | 是（绑 requalified head） |
| **F4 生产挂载（canvasV2 后）** | **#4994** | **`8a82978021` — MERGE-CLEAN — 0 P1, 0 P2**（`/tmp/pr4994-f4-gate-20260818.md`） | 0/0/4/4 | 不适用（无阻断） | `345a1f1c0e` | — |

**P0 硬边界 —— DISCHARGED**（F4 落地）：F10 挂载现存（`TemplateAuthoringView.vue:333/338`，`showFormBuilderV2` 后），旧「缺席钉」`slots.spec.ts:1115` 已翻为 `:1118` FLIPPED PIN，行为级 mounted-iff-flag 证明在**必需** `approvalTemplateAuthoring.spec.ts`（M1/M2 变异各打红 8/9 项；phase-B 两侧闸复核 PASS）。**但 CORE-PARITY 仍 NO**：分支保护 owner 步（delta §7.1 item 8，`approval-browser-verify` 仍非必需）、四视口窄化（F4 P3-2）、检查器 number/date_range 缺口（P3 containment upheld，fail-closed 非静默默认）、Canvas 租户 UAT + owner 签署——均 owner-only（开发报告 §3.2 / §7）。

### 3.3 P1 检查器与已发布能力对标

| 切片 | PR | Reviewed SHA + 判定 | P1/P2/P3/NIT | 合并 squash SHA | 合并后重审? |
|---|---|---|---|---|---|
| P1-A 三标签检查器 + 能力注册表 | #4944 | `347c8035ef…` — REQUEST-CHANGES | 1/3/3/5 | `a4ee60d290` | 否（ledger §4 记修复轮） |
| P1-A0 基本信息步导问题计数 | #4960 | `97830ef340…` — APPROVE / MERGE-CLEAN | 0/0/—/1 | `a59cf6a7df` | — |
| P1-B 多来源派单人卡片 | #4963 | `655ee4b0a6…` — APPROVE-with-hardening | 0/1/0/1 | `22ab8c6ada` | — |
| P1-C timeout + threshold 前端兼容 | #4972 | `0b5908ab2d…` — CHANGES-REQUESTED (hardening) | 0/3/2/2 | `3335ccc435` | 否（两轮修复 `6c2d61c419`→`fa8e92c9b6`） |
| P1-D 扁平卡片 + 分支优先级/默认文案 + 版本入口 | #4951 | `5fe9489a0f…` — CHANGES-REQUESTED → requalified `1edded1fa9…` = **CLEAR** | 2/6/5/2 | `ef1ded4573` | 是（绑 requalified head） |

### 3.4 P2 企业派单人语义（Lock-1 K 系列）

| 切片 | PR | Reviewed SHA + 判定 | P1/P2/P3/NIT | 合并 squash SHA |
|---|---|---|---|---|
| K2 `requester_choice` | #4952 | `06d7f1d875…` — APPROVE-with-hardening → requalified `1f79be0799…` = **CLEAR** | 0/2/5/4 | `a35d939fcb` |
| K4 `continuous_dept_heads` | #4958 | `eac17df508…` — APPROVE-with-hardening (FIX-ROUND) → requalified `bfef499302…` = **CLEAR — 0 P1, 0 P2** | 0/1/—/3 | `a21b274ec1` |
| K5-b `dept_head_at_level` | #4962 | `618ca00688…` — APPROVE (MERGE-CLEAN) — 0 P1, 0 P2 | 0/0/—/2 | `150cdb0848` |
| K3 `prior_node_approver` + fail-closed `normalizeApprovalMode` | #4973 | `1c315e5a3e…` — APPROVE-with-hardening | 0/1/3/1 | `90c41fbf60` |
| **K1 `user_group`（第 13 个 union 成员）** | **#4995** | Round-1 `f7e2780366` FIX-ROUND（P1 self-service bind + P2×3）；Round-2 requalify `0b7d0860bf` = **NOT-CLEAR**（同类新 P1 = harness rot）。**两个 P1 均已闭合 merged**（bind → `ensurePlatformAdmin` live-probe 403；harness 5 成员 + `user_group` 分支当前 head 存在）。**残留 owner：G-6 UNSATISFIABLE；picker 跨命名空间元数据（已披露非权限放大）** | **`6abd241925`** |

**K 系列尾部**：**K1（`user_group`）已落地** ⇒ 语料点名的最后一个审批人种类闭合；**K6（Lock-1 §K6 `sequential`）未落地**（母锁 §8 非目标）；**K6 slice #4993（Lock-2 §L2-C 字段派生 manager/dept-head）在飞行**（不同于 §K6 sequential）。

### 3.5 P3 流程策略 / More settings

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| L6-P1 修复模板编辑策略载体（P3-B 前置） | #4957 | `99b6e5713a…` — MERGE-CLEAN（P1:none. P2:none.） | `0cbae291bc` |
| L6-A 轮次作用域 dedup（OD-L4-10(a)） | #4965 | `5f18dec85f…` — FIX-ROUND；requalified `62140682bc…` = **NOT-CLEAR（一个 test-only P2）**。**V-3 DISCHARGED**（下） | `57a7443ede` |
| 发布顺序修复 | #4966 | `d7a560b3b3…` — MERGE-CLEAN — 0/0/0/0 | `d002b1883a` |
| P3-B More-settings 第五步 + L6-A 模板 dedup 档位 | #4967 | `3d584e1256…` — APPROVE-with-hardening (1×P2) | `e1dd97bfd4` |

> **✅ V-3 DISCHARGED**（`/tmp/pr4965-v3-closure-20260818.md`）：#4965 requalify 判定逐字 **NOT-CLEAR**（「One P2（untested guard, recurrence）。One-test fix；the code is CORRECT.」），合并为 `57a7443ede`。闭合证据在**合并后 main `3335ccc435`**（该 floor 区间 `4195–4210` 逐 blob 未变，实况隔离 worktree + 隔离本地 DB）机械跑两条变异：**Mutation D**（删 `jump AND backwardReentry` 臂）恰红 `approval-dedup-return-round-scoping.db.test.ts:593`（`approval_c`→`approval_d` 泄漏）；**Mutation A**（删 `action='return'` 臂）恰红 `:399`（同泄漏形状）；两条红**互不重叠** ⇒ 两个后向重入臂各自 load-bearing、mutation-proven at merged main。CI 车道在 `57a7443ede` 与 `6a67eccea1` 均 8/8。**这一行现在可以写「floor mutation-proven」，但仍不是「闸门 CLEAR」——它是合并后的独立闭合证据。**

### 3.6 P4 办理节点、字段编辑强制、操作策略

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| P4-A 办理节点（Lock-3） | #4956 | `bdaf8614b0…` — CHANGES-REQUESTED (FIX-ROUND) → requalified `baeaaf1608…` = **CLEAR — merge-ready** | `b43025e3b3` |
| P4-B 逐节点字段编辑/可见性强制（Lock-7） | #4961 | `f5e7774c11…` — CHANGES-REQUESTED (FIX-ROUND — 1 P1 + 2 P2) → requalified `1d870f7c60…` = **CLEAR — merge-ready** | `f5c06b35cd` |
| D-1 非写入型节点拒收 `fieldPermissions`（read 轴，Lock-7） | #4979 | `2a17d8358e…` — **FIX-ROUND: 0 × P1, 1 × P2, 3 × P3, 3 × NIT**；真 PostgreSQL 6 行变异 + 5 探针 | `6a67eccea1` |
| **P5 L5-A 逐节点操作策略 + 派发闸 + 拒绝审计（Lock-5）** | **#4980** | **`d47764d993` — APPROVE-with-hardening**（merge-clean on correctness；**3×P2 by owner call**；0/3/5/3），base `main@385a433821`；含 M10（choke 移到 lock 字面位置 → 恰红那一个测试） | `d034b1f710` |

### 3.7 P5-B 成员动作（Lock-5，堆叠切片，已 retarget + 落地）

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| **P5-B 前加签诚实（B-2）+ `commentRequired`（§1.3）+ A-2 成员操作栏镜像** | **#4983** | **Round-3 CLEAR @ `007f71e53b` — 0 P1, 0 P2**（base `main`；「queue-ready」）；Round-2 NOT-CLEAR `c3e56d0ba3`（两 blocker）；Round-1 FIX-ROUND `464ec8a5c7`。**A-2 被下调为 PARTIAL** | `327ac6427b` |

> **✅ V-10 DISCHARGED**：#4983 曾堆叠在 #4980 之上、base 非 `main`（DRAFT 记「必需检查压根不跑，须 retarget」）。Round-3 head `007f71e53b` 的 **base = `main`** ⇒ retarget 已完成、必需检查已跑、已合并。
> **⚠️ V-16 保留（形状不变）**：#4983 的 A-2 被闸门从 FULL 下调为 **PARTIAL**，构造探针证明 FE 镜像对 role 席位审批人不下发（`nodeOperations = undefined`），而**服务端仍正确拒绝**（409/400）⇒ **UI 少显示而非权限放大**，不得写成安全缺陷。Round-3 只关闭了 Round-2 的两个 blocker（flaky required spec + mirror evaporation），**未把 A-2 提升为 FULL**。

### 3.8 P6 字段词汇（Lock-8）

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| P6-amount 数字字段金额属性（L8-C） | #4959 | `4853afeda2…` — MERGE-CLEAN — 0 P1, 0 P2 (2 P3, 3 NIT) | `0501529f33` |
| P6-daterange `date_range`（L8-B） | #4964 | `31748ddf36…` — MERGE-CLEAN (APPROVE) — 0 P1, 0 P2 | `9d9fbc9dd3` |
| P6-explanation `explanation`（L8-A） | #4974 | `215e2cb570…` — APPROVE-with-hardening（workflow enum: FIX-ROUND — 0 P1, **2 P2 outstanding**） | `4259d9fde8` |

> **⚠️ D-2 保留**：#4974 合并时带 2 个未闭合 P2（P2-1：`TemplateAuthoringView.vue` 4 注册点无守卫；P2-2：`explanation` 经 handler 写入门变成 `form_snapshot` 键，与 A-1 冲突）。来源无闭合记录。

### 3.9 P7 覆盖 / a11y 修复（已落地）

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| **P7-R1 测试覆盖修复（FAIL-0/1/3/4/7）** | **#4984** | **APPROVE-with-hardening（MERGE-CLEAN after P2-1）**（`/tmp/pr4984-p7r1-gate-20260818.md`）；含 249 文件有界扫描 + `approval-realdb-p7r1-coverage-repair.yml`。**残留 P2-1**（6/9 套件缺哨兵，§2.4） | `512f0df608` |
| **P7-R2 焦点环对比度 / harness 样式表 / 详情文案** | **#4981** | **APPROVE-with-hardening @ `caa650d26c`** — 0/3/3/2；含 M8（第二 `<style>` 块绕过全部四断言） | `6488353bf8` |

### 3.10 UI 切片

| 切片 | PR | Reviewed SHA + 判定 | 合并 squash SHA |
|---|---|---|---|
| UI-6 详情标签锚点 + 审计派生记录表 | #4946 | `44005ba8e1…` — CHANGES-REQUESTED（0/2/3/5）；12/12 变异全红 | `b296b4d6eb` |
| UI-7 审批中心桌面主从面板 | #4948 | `3fe98e1f13…` — CHANGES-REQUESTED（1/6/5/1）；真 Chromium 布局测量 | `9f50cd46a3` |

> **⚠️ D-3 保留**：#4946 / #4948 闸门均 CHANGES-REQUESTED 且无 requalification 段，均已合并。如实记为「合并时闸门项未记录闭合」，不得写成「闸门 CLEAR」。

---

## 4. CI / 覆盖态势

### 4.1 必需检查集（实测，非背诵）

`gh api repos/zensgit/metasheet2/branches/main/protection`，当前 head：
```
required_status_checks.contexts (9):
  contracts (strict) · contracts (dashboard) · pr-validate · test (20.x)
  contracts (openapi) · web-tests · stock-prep PowerShell 5.1 acceptance
  attendance-web-guard · integration-guard
required_status_checks.strict = true
enforce_admins.enabled       = true
```
**这个集合会增长——每次读 API，别背数字。** `strict=true` 意味着合入任何一个 PR 之后其余全 BEHIND，九门须重跑。

### 4.2 §3 偏差披露 — 审批线的独立车道都**不是**必需检查

| 车道 | 必需? | 覆盖 |
|---|---|---|
| `approval-realdb-acceptance.yml` | **否** | Lock-1 K2 / K4 / K5-b / K3 / **K1** |
| `approval-realdb-field-edit.yml` | **否** | Lock-7 field-edit |
| `approval-realdb-handler.yml` | **否** | Lock-3 handler |
| `approval-realdb-l6a-roundscoping.yml` | **否** | Lock-4 OD-L4-10(a) / L6-A gate A-7 |
| `approval-realdb-node-operation-policy.yml` | **否** | **Lock-5 L5-A 操作策略（#4980）** |
| `approval-realdb-p7r1-coverage-repair.yml` | **否** | **P7-R1 孤儿真库套件（#4984）** |
| `approval-template-policy-carrier-realdb.yml` | **否** | L6-P1 policy carrier |
| `approval-browser-verify.yml` | **否** | F2 / F4 真 Chromium DataTransfer |
| `approval-web-guard.yml` | **否** | 定向审批 FE helper/round-trip specs |

`approval-browser-verify.yml` 头注释：「**NOT a required check yet**: per delta §7.1 item 8 the branch-protection addition is an explicit **OWNER step before the F4 merge**; until that owner action is visible, this lane's evidence is exact-head but not 'required'.」
**为什么是独立文件而非 `plugin-tests.yml` 白名单**：后者是 s6a sha256 钉住的 provenance 输入，每改一次强制一次 s6a 重钉 + 合并串行化竞态。因此所有真库车道保持 `plugin-tests.yml` 逐字节不变。
**边界（FAIL-0 利用的正是这一条）**：这些车道**只在其具名路径触发**；经由未列入路径的通道发生的行为变更拿不到真库证据。

### 4.3 覆盖修复（**已随 #4984 / #4981 落地**）

**#4984（P7-R1，`512f0df608`）**：新增 `apps/web/tsconfig.verification-approval.json` 把 harness 纳入 `vue-tsc` 编译面并链入 `apps/web` 的 `type-check`（必需 `test (20.x)` 里已跑的 `pnpm type-check` 现在编译期抓这一类）；给 `multitable-browser-verify.yml` path filter 加 4 个 `apps/web/src/approvals/**` 文件；新增 `approval-realdb-p7r1-coverage-repair.yml` + 双点接线；把 `useApprovalBatchActions.spec.ts` 加进 `run-required-web-tests.sh` **和** `approval-web-guard.yml`；两 fixture 补 `grantApprovalWriteForIntegrationActor`；249 文件有界扫描。**编译钉在飞行中被真实后续回归验证**：#4973（K3）新增带必填额外字段的成员，编译钉要求更新 harness——「exactly the rot-class mechanism working as designed, caught before push」；**#4995（K1）再次触发同一钉**（Round-2 P1-NEW），坐实机制活着。
**#4981（P7-R2，`6488353bf8`）**：V-6 焦点环换到 `--el-color-primary`；两 harness 补生产样式表；`handler` 补 per-type 强调色；三个原始 ID 暴露候选 values-free 修复；守卫从「两具名行号」升为**机制级枚举**（遍历每条 `:focus-visible` 规则）。

### 4.4 approval-web-guard 的健康度（收窄，未完全解决）
P1-C 闸门 MD 记录 `approval-web-guard` 自 #4957 起在 main 上是无效 workflow 且非必需检查。本程序三项实测：(a) 最近 6 个版本 YAML 均 PARSES 且含 `jobs` ⇒ 无效性不在 YAML 语法层；(b) `pull_request` 与 `push:main` 路径现跑得通；(c) 判别项是 event/branch 非文件版本（两条失败运行 `headBranch` 为空 = GitHub 侧「无效 workflow 文件」签名）。**TAIL-PENDING V-6：无效窗口起止 / 归因 PR / 受影响 PR 仍无权威结论**（应查 `headBranch` 空的失败运行 annotation，而非二分文件版本）。

### 4.5 ✅ 尾部合并列车的 run-list / vitest.config UNION 存活（本 FINAL 新做的机械核实）

F4 与 K1 两份闸门各自独立点名：#4994 / #4984 / #4983 同改 `run-required-web-tests.sh` **和** `approval-web-guard.yml`；`packages/core-backend/vitest.config.ts` 被 **#4995 / #4993 / #4984 / #4983 四个** PR 触及——「a dropped exclusion line silently removes a suite from the no-DB job with no CI signal」，**正是 FAIL-0 那一类**。四个 PR 已依次落地。本 FINAL 在当前 head（`origin/main`）机械核实 **UNION 完整**：

| 文件 | 应含 token | 当前 head 观测 |
|---|---|---|
| `apps/web/scripts/run-required-web-tests.sh` | `approval-form-builder-slots`、`approval-form-builder-route-leak`、`approval-node-operation-policy`、`approval-member-bar-operation-policy`、`useApprovalBatchActions` | **全部存在** |
| `.github/workflows/approval-web-guard.yml` | `approval-form-builder-route-leak`、`approval-member-bar-operation-policy.spec.ts`、`useApprovalBatchActions.ts`+`.spec.ts` | **全部存在**（path filter + run 命令两处） |
| `packages/core-backend/vitest.config.ts` | `approval-node-operation-policy.db`、`approval-dedup-return-round-scoping.db`、`approval-user-group.db`、`approval-node-entry-epoch`、`approval-wp1-any-mode.api` | **全部存在** |

⇒ **合并列车没有静默去接线任何一个套件**。这是一个**真正的 DISCHARGE**：FAIL-0 那一类「守卫不守卫」在这轮四-PR 竞态里被防住了。（`approval-node-entry-epoch` / `approval-wp1-any-mode` 的**内容**是否在合并后 head 变绿仍属 V-2/V-1；此处只证明它们没有从收集面消失。）

---

## 5. TAIL-PENDING 行与它们的解除条件（FINAL 结算）

| # | TAIL-PENDING 行 | 现状 |
|---|---|---|
| **V-1** | Phase-A 127 行**完整**矩阵未在当前 head 重跑 | **收窄，未全解**：phase-B（§2.5）已在 fresh `origin/main` 真复核**子集**（8 FAIL + 15 特性 + 6 优越性）；**其余行（含 63 个 PASS-POSITIVE-ONLY）仍 LANDED-VERIFY / PPO**，全 127 行重跑需精确部署 merged-main SHA + PG16 真库 + 组装应用（owner/后续版本） |
| **V-2** | 八个 FAIL 在 main 上仍活 | ✅ **DISCHARGED（8/8 FIXED，phase-B §2.4）**，带一个 carried-forward 残留 = FAIL-0 机械枚举守卫（#4984 P2-1 的另一面，非活缺陷）。**DRAFT 的 FAIL-1 运行时红在 phase-B 复核为已修（real Chromium 1 passed）** |
| **V-3** | #4965 requalify NOT-CLEAR，合并后闭合无记录 | ✅ **DISCHARGED**（§3.5，两 floor 臂 mutation-proven at merged main） |
| **V-4** | #4974 带 2 个未闭合 P2 合并 | **OPEN**（= D-2，合并时闸门项未记录闭合） |
| **V-5** | #4946 / #4948 CHANGES-REQUESTED 无 requalification 合并 | **OPEN**（= D-3，同上） |
| **V-6** | `approval-web-guard` 无效窗口未定 | **OPEN**（§4.4） |
| **V-7** | PPO 计数不自洽：§1 汇总 **63**，§15 第 4 条写「the discriminating-negative half of **33**」 | **OPEN**：**63 = 绿测试总行数**；**33 = 显式点名了所欠反例的子集**。本 FINAL 保留两个数并保留 V-7 为**未解决**（不静默塌缩成 33）；owner/后续版本机械重算 |
| **V-8 / F10** | F10 / P0 完成度 | ✅ **DISCHARGED（挂载半边）**：F4 #4994 落地，F10 由必需 job 收集（§2.3 gate 5）；CORE-PARITY 仍 NO（owner UAT/签署/分支保护步） |
| **V-9** | K1（`user_group`）、K6（`sequential`）未落地 | **K1 ✅ LANDED（#4995）**；**K6 `sequential`（Lock-1 §K6）仍 OPEN**（母锁 §8 非目标）；**K6 slice #4993（Lock-2 §L2-C 字段派生 manager/dept-head）唯一在飞行**——已 rebase 到当前 main、CI 运行中、闸门 MERGE-CLEAN 0 P1 @ `093830c4bc`；落地后 union 13→15 |
| **V-10** | P5 #4980 + 堆叠 #4983 均 OPEN；R7 NOT-YET-LANDED；#4983 base 非 main | ✅ **DISCHARGED**：两 PR 合并（`d034b1f710` / `327ac6427b`）；R7 LANDED；#4983 retarget 到 main（§3.7） |
| **V-11** | Lock-6 B–F 零命中 | **OPEN**（各自切片；L6-F1 v1 REJECTED 为惰性） |
| **V-12** | 33 个 PASS-POSITIVE-ONLY 行所欠判别性反例（每行点名） | **OPEN**——本程序公开的最大一块验证债，主动标注非被发现（§6.5） |
| **V-13** | `approval-realdb-*` / `approval-browser-verify` 均非必需检查 | **OPEN（owner 动作）**：分支保护里加入（delta §7.1 item 8 = F4 合并前 owner 步，已合并但步仍未执行） |
| **V-14** | PG 大版本差：Phase-A 127 行 + **phase-B 子集**均跑在本地 PG **15.17**，CI 用 `postgres:16` | **OPEN**（phase-B 亦记录本地 PG15；对照：#4983 闸门跑在本地 PG16 但只覆盖 P5-B；PG16 上重跑真库车道待办） |
| **V-15** | #4984 尚未过独立对抗闸门 | ✅ **DISCHARGED**：#4984 现有独立闸门 MD（`/tmp/pr4984-p7r1-gate-20260818.md`，APPROVE-with-hardening (MERGE-CLEAN after P2-1)）；残留 = P2-1 本身（§2.4） |
| **V-16** | #4983 A-2 下调 PARTIAL；FE 镜像对 role 席位不下发（服务端仍拒 ⇒ 显示缺口非权限放大） | **保留形状**（§3.7）：合并后仍是 PARTIAL；owner/后续切片补 role 席位镜像 |

---

## 6. 诚实边界 — 明确**没有**被验证的东西

### 6.1 provenance 分层（不得压平）
三层，严格区分：① **Owner 亲手动作 — 只有一处**（master §9，`217b56137e…` → `5b31cb4349`，逐 blob 相同，「Runtime authorization: NONE」）。② **Goal-set provenance — Lock-0..8 与若干处置**（「not an owner-authored ratification, and REVERSIBLE」，**绝不写成「九个锁由 owner ratify」**）。③ **闸门修复轮 — 既不是 ratification 也不是授权**（「a gate fix round is not that authorization」）。

### 6.2 三处显式可逆的默认（不是决议）
- **P1-C 的 P2-3**：删除 `: 'single'` fallback 一项，「executes master lock §P1-C's flatten-branch-deletion clause verbatim … GOAL-SET PROVENANCE, not an owner-authored ratification, and REVERSIBLE」。
- **#4979 的 P3-3**：read 轴 400 是「a **REVERSIBLE** public-API narrowing beyond OD-L7-4(a)'s literal ratified text」。OD-L7-4(c) 放宽方向仍可用。**与 Lock-7 D-5 read-scope 是两个不同 owner 问题，不得合并。**
- **#4995 的 G-6**：gate 文本如所写不可满足（全局唯一名 + option (a) 无 tenant 边界）——裁为 goal-set provenance，picker 跨命名空间元数据已诚实披露（非权限放大）。

### 6.3 OWNER-ONLY —— 16 行，一行未执行
母本 §10 Canvas UAT（S1–S12）· 独立 FWB UAT · 独立附件 UAT · P7-E 分级 flag 启用 + 回滚 · §0 声明清单（三标签）· §12 最终 owner 记录 · §2 私有发布前置条件带外闭合 · Lock-5 / Lock-1 K1·K3·K6 / Lock-8 L8-A 的实现授权 · OD-L8-7(a) 生产模板语料扫描 · 陈旧 I14 行重新措辞 · FAIL-6 裁定。**None is executable by a code agent, and none was executed.**（注：K1/K3/L8-A 的实现切片本身已落地；此处指其运行时启用授权仍 owner-only。）

### 6.4 BLOCKED-ENV —— 13 行，附确切理由（保留）
§7 Version/Member-detail 两列 ×3 视口（需组装应用）· 最长业务标签（需真实长标签）· Form builder @ 390×844（harness fixture 非产品）· V5 升级半边（无生产快照）· §3 Root required checks（本 FINAL §4.1 已补）· Deployed staging SHA（沙箱到不了主机）· PG 大版本一致性（本地 15.17 vs CI 16）· §7「无嵌套卡片」判据不可机械判定（需 owner 卡片级定义）· §2「无普通用户界面暴露 JSON/原始 ID」——在 `ApprovalDetailView.vue` 找到三个模板可达原始暴露点（记为**候选而非 FAIL，不计入 FAIL 总数**）。

三个候选（按优先级，已与 #4981 修复对齐）：`nodeLabel`（`:1617`，最高优先级，普通模板漂移即触发）；`cancelledAssigneesLabel`（`:1612`）；`formatFieldValue`（`:1629` `JSON.stringify`）。另管理面 `TemplateAuthoringView.vue:1793` 把原始 role id 插进可见公式文本。**#4981 已按 values-free 修复三个成员面候选**（合并后重判属 V-2）。

### 6.5 PASS-POSITIVE-ONLY 的欠债（保留，最大一块公开验证债）
63 行绿测试**没有**被写成 PASS。示例（原样）：F1 欠「neuter the allocator to a length-derived index and prove a duplicate-ID red」；R1 欠「distinguish "denied" from "denied for a different reason"（`notEqual` 族陷阱）」；R5 欠「an injected-failure probe I did not construct」；V4 欠「a constructed concurrent-restore race」；D2 欠「a constructed interleaving」。**这是被主动标注出来的，不是被发现的。**（源内 33 vs 63 不自洽 = V-7，未解决。）

### 6.6 完成标签的当前值（母本 §0 / §12）

| Claim | 当前值 |
|---|---|
| CORE-PARITY | **NO** |
| DATA-CLOSURE | **NO** |
| PRODUCT-FINAL | **NO** |
| Canvas UAT / FWB UAT / Attachment UAT | NOT RUN |
| Flags enabled | 无（代码默认 OFF；源码读数，非环境观测） |

母本自陈：「This file is intentionally not a completion claim.」本报告同样不是。

---

## 7. 本报告自身的边界

- 本报告是 FINAL 而非完成声明。它**没有**重跑 phase-A 的**完整** 127 行矩阵；§2.1–2.3 的判定绑 `680e93c018`，§2.0 逐条标出落地取代/翻转的行。**P7 phase-B（§2.5）在 fresh `origin/main` 真复核了一个子集**（8 FAIL + 15 特性 + 6 优越性），把这些行升为带证据的 FIXED/PASS；其余行仍 `LANDED-VERIFY` / `PASS-POSITIVE-ONLY`。
- 本 FINAL **新做/纳入**的机械核实：① 当前 head 必需检查集（9 条）；② 前后端 union 计数（`ApprovalMode` 4、派单人 13、字段类型 13、`nodeOperationPolicy` populate）；③ F10 挂载 + 必需 job 收集 + slots FLIPPED PIN；④ 本程序窗口迁移枚举（4 个）；⑤ **run-list / vitest.config UNION 存活**（§4.5）；⑥ V-3 闭合证据引用（§3.5）；⑦ **P7 phase-B 子集复核（8/8 FAIL FIXED + 15/15 特性 + 6/6 优越性，§2.5）**。
- 本报告**不记录**任何私有发布前置条件的车道标识、状态、实现细节或私有证据（母锁 §0.2 披露纪律）。
- 本报告**不 ratify、不授权、不启用**任何东西。所有 owner 事项集中在开发报告 §7。
