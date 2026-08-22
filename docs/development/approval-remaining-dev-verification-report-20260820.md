# 审批 / 工作流剩余开发轮 —— 验证报告（2026-08-20）

## 1. 抬头

| 项 | 值 |
|---|---|
| **exact-main SHA（重锚后）** | `5feca2291b7405bc6be8160cab916ba80f7f9df6` —— `feat(approval): node-level required field tier (Lock-7b) (#5026)`，2026-08-20T07:06:10Z。`git rev-parse origin/main` 亲核；仓库非浅克隆 |
| ⚠️ **两个 SHA，不得整体替换** | **本文的全部 W4 收官验证执行（127 行矩阵、四条隔离车道、四个 PG16 库、真 Chromium）以及 V-14 双臂实验，全部发生在 `6cca7ec0ed97732e05723f4c613557087395d022` 上；本次重锚没有重跑其中任何一行。** 两个 SHA 之间的差量恰好是两个 first-parent 提交，逐个具名：`5ab052449b`（#5025）与 `5feca2291b`（#5026） |
| ✅ **重锚在新 head 上确实做过的事（穷举）** | **执行类一条**：在 `5feca2291b` 的独立 detached worktree 内实跑 `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` → `OK` / exit 0（§6.1）。**只读机械复核类**：`git rev-parse origin/main` 与窗口计数；#5025/#5026 的 `state`/`mergedAt`/`headRefOid`/diffstat 与三对 `merge-base --is-ancestor`；两个新合并的单亲性质；`approval-*` 真库套件计数 66 → **67** 并具名新增文件；`ts.createSourceFile` 存在与残留清单 (a)–(j)；执行台账第 114 行文本；Sealed-export 三条 check-run 在三个 head 上的结论；新车道 yml 的 `postgres:16` / `EXPECT_DB` / 硬编码 `DATABASE_URL`；`sealed-export-s5-sqlserver.yml` L46 的 path-filter 与 `id: 'pnpmLock'` 钉点。**以上之外的任何条目一律仍绑 `6cca7ec0ed`，不得当作已在新 head 上复验** |
| **术语（避免一个词指两个 SHA）** | **exact-main** = 重锚后的 head `5feca2291b`，仅此一义；**读取基线 / 收官基线** = `6cca7ec0ed`。⚠️ **逐字引用块内的 `exact-main` 一律照录不改**（那是被引文档自己的用词，指它自己的 `6cca7ec0ed`）——§4.1 / §4.2 的两个 blockquote 即是 |
| **验证执行日期** | 2026-08-20（收官观测 ≤ 12:33 +0800；PG 双臂实验 ≤ 13:08 +0800；重锚补充观测 ≤ 15:20 +0800） |
| **本轮窗口（机械口径，重锚后）** | `git log --first-parent d8ac22c9891253d09212861304f81ec600abb0a6..5feca2291b` = **23 个 first-parent 提交**，其中审批车道 **11 个**（#5010 / #5009 / #5016 / #5019 / #5024 / #5021 / #5022 / #5023 / #5030 / **#5025** / **#5026**），其余 12 个属他线（multitable O-2、attendance、ops/CI），逐个具名以证明窗口是**读完的**而非**扫过的** |
| **实际使用的 PostgreSQL（W4 收官四车道）** | **PostgreSQL 16.14**（Docker `postgres:16`），四条车道各自一个**独立**容器与独立数据库：L1 `ms-l1-pg16`:5433、L2 `ms-l2-pg16`:5434、L3 `ms-l3-pg16`:5436、L4 `ms-l4-pg16`:5437。四库均 **325 迁移 applied / 0 pending**，四个收官 `zzzz` 迁移逐名确认。**这四条车道没有任何一条跑过 PG14 或 PG15 对照臂** |
| **实际使用的 PostgreSQL（收官之后的 V-14 双臂实验）** | **PG14（14.24） ↔ PG16（16.14 / 16.15）**，两条独立车道（Lane A / Lane B）各自 provision 一对臂，跑在 **`6cca7ec0ed`** 上：**66/66 套件双臂、每臂 574 条测试、1148 条合计、0 failed / 0 skipped、DIVERGENT = 0**，逐条 test-name 集合两臂完全相同；同一 **319 条迁移**在两个大版本上以相同顺序 exit 0。⚠️ **重锚后分母是 67 ⇒ 66/67**（#5026 新增第 67 个套件，只有 PG16 单臂），见 §4.2。⚠️ **PG15 仍然从未被跑过**，而生产与预发的 compose 钉的正是 `postgres:15-alpine`（§4.2）。🆕 **2026-08-21 freshness 更正：最后这一句在 `5feca2291b` 上逐字为真，但已被 §11.3 取代** —— `postgres:15-alpine` 生产臂已在 run SHA `13506666dae3` 上跑完 **67/67** 套件、**588** 条测试全通过、**319** 条迁移 exit 0（服务端 `version()` 亲证 `PostgreSQL 15.19 … aarch64-unknown-linux-musl`）。**禁止据此写「生产 PG 兼容性已证」**，逐字禁令见 §11.3 |
| **Node / pnpm（诚实记录，非统一）** | L1 **v20.20.2 / pnpm 10.16.1**（CI-exact，跑任何一行之前主动从 ambient v25.9.0 切换）；L4 **v25.9.0 / pnpm 10.33.0**（未切换 ⇒ 证据保留项 R-1）；**L2 / L3 的版本报告未记录，本文不假设为 20** |
| 🆕 **freshness base（2026-08-21 docs PR 分支基点）** | `c473a079b5ff6389b98f4919bb88607a0baa913b`（`git rev-parse origin/main` 建支时亲取；仓库非浅克隆）。⚠️ **它不是一个新的 exact-main**：本文**没有**在它上面重跑任何一行验证、也**没有**重读任何 `[源读]` 锚点。**§1–§10 里的 `exact-main` 仍然、且仅仅是 `5feca2291b`** |
| 🆕 **freshness 增量窗口** | `git log --first-parent 5feca2291b..c473a079b5` = **14 个 first-parent 提交**：审批相关 **4**（#5033 `c5a4a94f7f` / #5039 `13506666da` / #5040 `627945523b` / #5043 `545b3cadd1`）、multitable **7**、attendance 与 ops **3**。⚠️ **上一行的原窗口（23 提交 / 审批车道 11 个）不改** |
| 🆕 **PG15-alpine 生产臂 run SHA** | `13506666dae30dbeee1fb145392ff7ecfeb3e093` —— **仅** §11.3 的数字绑它；它既不是读取基线、也不是 exact-main、也不是 freshness base |

**本文档确立了什么、没有确立什么（一句话，诚实版）**：本文确立的是——在 `6cca7ec0ed` 上，用四条隔离车道、四个全新 PG16 库与真 Chromium，对 127 行验收母矩阵中的 **101 行发起执行、88 行取得判定**（其中 87 行由执行支撑、1 行仅由源码读取支撑），逐条记录了本轮**十一个**审批切片的门审拦截物，并在收官之后另跑了一次 **PG14↔PG16 双臂实验（66/66 套件、1148 条测试、零差异）**；本文**没有**确立的是——全 127 行矩阵的重跑（35 行不可执行 + 4 行 NOT RUN）、36 行 PASS-POSITIVE-ONLY 所欠的判别性反例、**这套 harness 对 PG 版本差异的灵敏度本身**（无正控）、**PG15（= 生产 compose 所钉的版本）在任何 leg 或任何臂上的执行**、以及 **AC-10（Lock-7b 落地物）在 exact-main 上的判定**。**这是一份验证记录，不是签署。**

🆕 **2026-08-21 freshness 更正（绑 run SHA `13506666dae3`，详见 §11.3）：上面这句「没有确立」清单里的
「PG15（= 生产 compose 所钉的版本）在任何 leg 或任何臂上的执行」一项，在 `5feca2291b` 上逐字为真，
但它已被 `postgres:15-alpine` 生产臂取代** —— 该臂在 `13506666dae3` 上跑完 **67/67** approval 真库套件、
**588 条测试全部通过、0 skipped / 0 failed / 0 pending**、**319 条迁移 exit 0**，服务端 `version()` 亲证
`PostgreSQL 15.19 on aarch64-unknown-linux-musl`。
⚠️ **该清单里的其余各项一律不变**，尤其是「这套 harness 对 PG 版本差异的灵敏度本身（无正控）」——
该臂的负控同样只到连通性层，而且它给出的是**反向证据**（§11.3）。
⚠️ **禁止把这条更正读成「生产 PG 兼容性已被证明」**，三条逐字禁令随行于 §11.3。

---

## 2. 本轮验证做了什么

### 2.1 W4 收官的执行形状

台账：`scratchpad/w4-verification-closeout-20260820.md`（472 行 / 61 173 字节，12:18 写就），合并自四份车道文件 `w4-closeout-L{1,2,3,4}-20260820.md`（11:50–12:03）。**四份文件与本台账均只在 scratchpad，不在仓内**（`git ls-tree` 于 `6cca7ec0ed` 确认缺席）——见 §10。

- **四条隔离车道**：L1 / L2 / L3 / L4，均在**画布之外**（`/private/tmp/l{1,2,3,4}-closeout-*`）检出，以避开 `REPO_ROOT_AMBIGUOUS` 双锚点拒绝。
- **四个互不共享的 PG16 库**：刻意不共享，用以击穿 grant 残留造成的假绿（phase-A FAIL-3 / FAIL-4 的成因）。
- **真 Chromium**：L4 跑 Playwright 30/30（`approval-verification` 配置 20/20 @5175；`verification` 配置 10/10 @5174，其中仅 1 条属审批域）。
- **反假绿纪律**：每条真库命令均 `EXPECT_DB=1` 武装；L4 车道对 `describeIfDatabase|EXPECT_DB|DATABASE_URL` 的 grep **0 命中**、0 skipped；`plugin-tests.yml` 在 L2 跑前跑后各 diff 一次均为空，L3 独立确认自 #5014（`642b765a96`）以来该文件未变。
- **两处变异（G5、AC-9）均以 `cp` 备份/还原，未使用 `git checkout -- <file>`。**
- **执行体量**：真库 PG16 合计 **371 个测试全绿、0 skipped**（L1 110 / L2 129 / L3 132）；BE 单测全量 **671 files / 10017 tests passed**（176 files / 1564 tests skipped）；必需 web 测试 **422 files / 5472 tests，0 failed / 0 skipped**。

### 2.2 六个诚实分层各自的含义（读表之前必须先读这一节）

| 分层 | 含义 | 不得读成 |
|---|---|---|
| **PASS** | 该行有执行支撑的判定，且**判别性反例已构造**（错误输入确实变红） | — |
| **PASS-POSITIVE-ONLY（PPO）** | 套件绿，但**该行的判别性反例本轮未构造**——即"没红"不等于"会为错的东西红" | 不得读成 PASS |
| **FAIL** | 该行被证伪 | — |
| **BLOCKED-ENV** | 缺执行载具或缺环境（真浏览器 spec / 组装应用 / 生产 schema 快照），本轮**未执行** | 不得读成"通过"，也不得读成"失败" |
| **OWNER-ONLY** | 构造上不可由代码代理执行（owner 亲签、判据未定义、或行的前提已被证伪需 owner 改写） | 不得读成覆盖缺口 |
| **NOT RUN** | 该行在任何车道的命令集内**都没有判定机制**，或其声明文本已不可恢复 | **不得推断、不得按 PPO 记** |

另有一个**只用于一行**的分层：**PARTIAL**（AC-11 = PG16 覆盖分数 35/66）。台账明确它**不并入 PPO**，理由逐字：*"它是覆盖分数，不是绿测试欠反例"*。

> **纪律基线（贯穿全文）**：skipped ≠ passed；绿套件若从未行使该声明就不是证据；单臂结果不是 parity 证据；车道没产出的行记 NOT RUN 而非推断。

---

## 3. 分层结果

### 3.1 127 行母矩阵：本轮 vs phase-A

| 分层 | **本轮收官 @ `6cca7ec0ed`** | phase-A @ `680e93c018` | Δ |
|---|---|---|---|
| PASS | **51** | 21 | **+30** |
| PASS-POSITIVE-ONLY | **36** | 63 | **−27** |
| **FAIL** | **1** | 6 | **−5（但换了行，见 §3.3）** |
| NOT-YET-LANDED | **0** | 8 | **−8（全部转为执行支撑判定：6 PASS + 2 PPO）** |
| BLOCKED-ENV | **15** | 13 | **+2（计划预测 −5，被证伪）** |
| OWNER-ONLY | **20** | 16 | **+4** |
| **NOT RUN** | **4** | 0 | **+4** |
| **合计** | **127** | **127** | |

**Δ 的诚实解释**：+30 PASS 与 −27 PPO 的主体来自两件事——(a) phase-A 的 8 行 `NOT-YET-LANDED` 全部拿到执行支撑判定；(b) 本轮为大量既有绿套件补上了判别性反例，把它们从 PPO 抬到 PASS。但 **BLOCKED-ENV 不降反升（13→15）**，且 **NOT RUN 从 0 变 4**——后者不是退步，而是把此前被默认吞掉的"无判定机制"如实显形。

> ⚠️ **phase-B 不做 127 行分层，切勿并排读成"它重新分层了全矩阵"。** phase-B 是一次 **29 行子集**复核（8 个 phase-A FAIL + 15 项已落地特性判别检查 + 6 项优越性 re-smoke），结果 = **8 FIXED + 15 PASS + 6 PASS，子集内 0 FAIL**。其余 98 行在 phase-B 之后仍是 `LANDED-VERIFY` / `PASS-POSITIVE-ONLY`。

### 3.2 ADDED-AT-CLOSEOUT 12 行 + 合计 139 行

**139 不是"127 重新分层"，而是 127 母矩阵与 12 行新增行的并集总数**，两列必须并排读：

| 分层 | ADDED 12 行 | **139 行总计** |
|---|---|---|
| PASS | 8（AC-1 / AC-3 / AC-4 / AC-5 / AC-6 / AC-7 / AC-9 / AC-12） | **59** |
| PASS-POSITIVE-ONLY | 2（AC-2 / AC-8） | **38** |
| FAIL | 0 | **1** |
| **PARTIAL** | 1（AC-11，**不并入 PPO**） | **1** |
| BLOCKED-ENV | 0 | **15** |
| OWNER-ONLY | 0 | **20** |
| NOT RUN | 1（AC-10 Lock-7b） | **5** |
| **合计** | **12** | **139** |

逐行：

| ID | 行 | 分层 | 判定机制 | 车道 |
|---|---|---|---|---|
| **AC-1** | Lock-4 **F4-A** 节点级 `auto_approve` | PASS | `approval-lock4-f4a-auto-decision.db.test.ts` **11/11** `[真库]` + 同名单测 | L2 |
| **AC-2** | Lock-4 **F4-B** designated 空派单人兜底 | **PPO** | 4 个单测全绿；**无真库车道**（F4-A/C/E 都有）⇒ 覆盖形状缺口 = **FS-3** | L2 |
| **AC-3** | Lock-4 **F4-C** 同人策略 | PASS | `approval-lock4-f4c-same-person.db.test.ts` **7/7** `[真库]` + 单测 | L2 |
| **AC-4** | Lock-4 **F4-E** 离职自动转交 | PASS | `approval-departure-transfer.db.test.ts` **9/9** `[真库]` | L2 |
| **AC-5** | 原始用户 ID 渲染类闭合 | PASS | `approval-member-identity-coverage-enumeration.spec.ts` **12/12**（TIER A 具名回归 + DECOY；TIER B 机械模式普查 + 非空性 + allowlist 过期 + 合成夹具 DECOY；scope-leak 清扫）`[挂载]`。**作用域逐字：仅 `src/approvals/**` + `src/views/approval/**`、仅那 6 个模式，不是「全部原始 ID 渲染」** | L4 |
| **AC-6** | 授权域显示名解析器（#5016） | PASS | `approval-directory-resolve.api.test.ts` **11/11** `[真库]` + `searchApprovalDirectoryUsers.spec.ts` `[挂载]` | L2 + L4 |
| **AC-7** | `GET /api/approvals/:id/history` 守卫对齐（#5024） | PASS | **8/8**：2 条判别性反例（无 `approvals:read` 的 values-free 拒绝；已填充但资源错配的 perms 声明被拒）+ 2 条正控（同形状主体授权后可读；通配授权亦满足）`[真库]` + `approval-history-routing.test.ts`（在 G7 内） | L3 |
| **AC-8** | P5-C 成员动作对话框语法 + chrome（#5030） | **PPO** | 三套件 **52/52** `[挂载]`；**继承 R9 的 focus / cancel 两项未兑现** | L4 |
| **AC-9** | #5004 CI 覆盖枚举守卫仍有牙 | PASS | **变异**：`cp` 备份 `run-required-web-tests.sh`，删一个 token（`approval-amount-in-words`，`git diff --stat` 证非空转），重跑 → **269 中恰好 1 条失败**并具名报 "UNCOVERED — collected by NO required lane"，其余 267 条保持绿；还原后 269/269 `[变异]` —— specific，非烟雾报警 | L3 |
| **AC-10** | **Lock-7b 节点级必填层** | **NOT RUN**（⚠️ 阻塞理由在重锚中被替换，**分层不变**） | ~~#5026 仍 OPEN~~ ⇒ **重锚更正：#5025 已合 `5ab052449b`、#5026 已合 `5feca2291b`。但 AC-10 仍是 NOT RUN**——**在两个 SHA 上都没有被任何收官车道判过**（收官跑在读取基线 `6cca7ec0ed`，彼时它还没落地；重锚后的 exact-main `5feca2291b` 上没有跑过收官车道）。它现有的证据只有：(a) PR 自己在 `29b28b1f50` 上的 CI（全部 check-run success，含它自己的新车道 `approval-realdb-required-at-node`，`image: postgres:16` + `EXPECT_DB: '1'`）与 (b) requalification #4 在 `a96ab8ae2b` 上的验证电池（真库 14/14、census 50/50、`bash apps/web/scripts/run-required-web-tests.sh` 387 files / 4923 passed）。**两者都绑 pre-squash head，都不是对 exact-main 的判定**，故**不作任何断言** | — |
| **AC-11** | PG16 真库一致性 | **PARTIAL（35/66）** ⇒ ⚠️ **收官时点的分数；已被收官之后的双臂实验超越（66/66 双臂 @ `6cca7ec0ed`；重锚后分母 67 ⇒ 66/67）。本表是收官时点的分层快照，故不改数** | 见 §4.2 的 V-14 处置 | 全部 |
| **AC-12** | 收官 SHA 上的分支保护上下文 | PASS | `gh api …/branches/main/protection` 实测：**11 条必需上下文、`strict:false`、`enforce_admins:true`、零个审批车道在必需集中** `[执行]`。**仅观测**——把审批车道**加入**必需集是 OWNER-ONLY（V-13） | L3 |

### 3.3 FAIL 从 6 降到 1 **不等于**"问题解决了"

| phase-A FAIL 行 | 本轮分层 | 诚实读法 |
|---|---|---|
| I7（阈值 re-entry 陈旧票） | **PASS**（L2 真库，两个独立反例） | **真修了** |
| R8（返回/重入/并发 epoch） | **PASS**（L3 真库 8/8，含方向性正控） | **真修了** |
| §7-grid flow-canvas @1440 | **BLOCKED-ENV** | **未在读取基线 `6cca7ec0ed` 上重新验证** |
| §7-grid flow-canvas @1024 | **BLOCKED-ENV** | **未在读取基线 `6cca7ec0ed` 上重新验证** |
| §7-grid flow-canvas @390 | **PPO**（jsdom 逻辑层替代品） | **未在真浏览器重新验证** |
| §7-checklist #4「颜色不是唯一载体」 | **PPO**（5 个载体中 3 个证实） | validation / diff 两个载体未找到断言 |
| — | **§7-checklist #1 =「新 FAIL」** | phase-A 时这行是 BLOCKED-ENV |

**三格 flow-canvas 的最后一次正向证据来自 phase-B 在 `6abd241925` 的真 Chromium 跑，不是 exact-main。计数不得暗示它们在本 SHA 上通过。**

### 3.4 三条对"计划"的证伪，随表带走

1. **BLOCKED-ENV 预测被证伪**：计划预测 13 → 8，实测 **15**（比 phase-A 还差 2）。计划称 #4994 的 mounted harness 已收复 §7 grid，L4 核查发现该 harness 只驱动 form-builder 面板，**Flow-canvas ×2 + Inspector ×3 共 5 格从未被收复**。
2. **台账更正自己的车道报告**：L4 的"仓内任何地方都不存在渲染 `ApprovalFlowCanvas` 的 harness"是**悲观方向的过强表述**。实测 `apps/web/verification/approval-form-builder-mounted-harness.ts` 挂载**完整生产 `TemplateAuthoringView.vue`** + 真 Vue Router + 真 Element Plus，`canvasV2` **默认 ON**（`params.get('canvasV2') !== 'off'`），而 `TemplateAuthoringView.vue:379` 正是 `<ApprovalFlowCanvas>` 挂载点 ⇒ *"真 Chromium 载具已存在，缺的是断言 grid 声明的 spec，不是 harness"*。⚠️ **这是源码读取结论，不是执行结论**——flow 步是否可达、画布是否真绘制**未执行验证**。
3. **各车道的指令列表本身欠覆盖**：L3 发现 D3/D4/M2/SUP-6 的判定器不在计划给的命令块里；L4 发现 M3/M4 的真正判定器是 `approval-center.spec.ts` + `approvalMobileResponsive.spec.ts`（由 `approval-center-master-detail.spec.ts` 自己的头注释点名），不跑它们就会 green-against-nothing。*"这种「切片排除说明里点名了另一个文件」的构造很可能同样欠覆盖其他车道的行。"*

### 3.5 两处算术更正（台账拒绝抹平，本文照传）

- **L2 报告内部算术不自洽，不予传播**：其 grand total 写 **41 files / 539 tests**，而按其自己的分项 16+5+9 = **30 files**；测试数 129+221+189 = **539 对得上**，文件数对不上。**本文按分项记 30 文件，非 41。**
- **套件数对账**：L1 9 = 7 approval + 2 fwb；L2 16 = 16 + 0；L3 14 = 12 + 2 ⇒ approval 前缀去重后 **35**，fwb 去重后 **3**。**9+16+14 = 39 是含重复且含非 approval 的原始数，不得直接与 66 对比。**

---

## 4. V-1 处置 与 V-14 处置（逐字引用，不得软化）

> ⚠️ **两条处置在重锚后状态不同，不得并读。**
> **V-1 仍然 NOT DISCHARGED**，逐字引用不变（§4.1）。
> **V-14 已在它自己点名的那条轴上解除**——收官 §6 那段「零对照臂 / 35-of-66 / 部分兑现」的措辞**已作废**，
> 被 `scratchpad/v14-pg-parity-verdict-20260820.md` 取代（§4.2 整段改写）。
> **这不是软化：解除的只是「缺对照臂」这一条，而取代它的裁决同时列了五条禁止过度声明的限制**，
> 其中最重的一条是**生产实际在跑的大版本从未被任何 CI leg、也没被任何一臂测过**。

V-1 的处置**逐字引用**自收官台账 `w4-verification-closeout-20260820.md` §5，原文为 blockquote 形式，此处保留引用边界；**原文中的粗体嵌套写法一并照录，未作任何修补**。V-14 的处置逐字引用自取代它的那份裁决的 §5。

### 4.1 V-1 —— NOT DISCHARGED（引自台账 §5）

> **V-1 —— 未解除（NOT DISCHARGED）。仅对可执行子集解除。**
>
> 本次收官在 exact-main `6cca7ec0ed97732e05723f4c613557087395d022` 上，对 127 行母矩阵中的 **101 行发起执行**（四条隔离车道 / 四个全新 PG16 库 / 真 Chromium）。其中 **9 行在执行过程中被重新判定为不可执行**（L1：U6、superiority#5 → BLOCKED-ENV；U1、F12 → OWNER-ONLY；L4：Flow-canvas ×2、Inspector ×3 → BLOCKED-ENV），另 **4 行 NOT RUN**（V6、V7、L2 承接的两项优越性）。
>
> ⇒ **88 行在本 SHA 上取得判定**，其中 **87 行由执行支撑**、**1 行（§7 a11y #1 = 唯一 FAIL）仅由源码读取支撑**。
>
> ⇒ **39 行未取得执行支撑判定**：BLOCKED-ENV 15 + OWNER-ONLY 20 + NOT RUN 4。占母矩阵 **30.7%**。
>
> ⇒ 已取得判定的 88 行中，**只有 51 行是无保留的 PASS**；**36 行是 PASS-POSITIVE-ONLY**，即"套件绿、但该行的判别性反例本轮未构造"。**因此 V-12 / V-7（判别性反例债与 63-vs-33 计数不自洽）并未被本次重跑解除**，仅由 phase-A 的 63 收窄到 36。
>
> **仍然欠着的部分及其原因**：
> 1. **15 行 BLOCKED-ENV** —— 归两个根因：(a) 无生产/staging schema 快照（G9 旧库升级半边、V5）；(b) 缺少断言相应声明的真浏览器 spec（Flow-canvas ×2、Inspector ×3、U6、superiority#5）或缺少组装应用（Version ×3、Member-detail ×3）。**注意根因 (b) 中有 7 行的载具其实已存在**（见 §2.3-2 与 §8），成本远低于计划记载。
> 2. **20 行 OWNER-ONLY** —— 15 行 owner block + §2#7 + a11y#5（判据未定义）+ I14 与 U1 与 F12（三行的**前提在本 SHA 已被落地或 ratify 决策证伪**，需改写或退休，属 owner 裁决非代码修复）。
> 3. **4 行 NOT RUN** —— V6 / V7 在任何车道的命令集内都没有判定机制；L2 承接的两项优越性其**声明文本本身不可恢复**（phase-A/B 逐行证据文件 `scratchpad/p7-phase{A,B}-evidence-20260818.md` 已确认灭失，四处 scratchpad 搜索零命中）。
>
> **不得声明 V-1 已闭合。** 准确表述：**V-1 对可执行子集（88/127 行）解除，对其余 39 行仍 OPEN。**

**处置的精确边界**：V-1 **仅对可执行子集（88/127 行）解除**，对其余 **39 行（BLOCKED-ENV 15 + OWNER-ONLY 20 + NOT RUN 4，占母矩阵 30.7%）仍 OPEN**。并且——已取得判定的 88 行里只有 **51 行是无保留 PASS**，**36 行是 PPO** ⇒ **V-12 / V-7（判别性反例债与 63-vs-33 计数不自洽）并未被本轮重跑解除**，只从 phase-A 的 63 收窄到 36。

### 4.2 V-14 —— **DISCHARGED，就它自己点名的那条轴而言**（整段改写；取代草稿的 NOT DISCHARGED）

> **本节整段改写。** 草稿写就时对照臂一条都没跑，故当时的 NOT DISCHARGED 是正确的。此后两条独立车道
> （Lane A / Lane B）各自 provision 了一对臂并跑完。**收官台账 §6 的措辞（「零对照臂 / 35-of-66 / 部分兑现」）
> 由此作废**，取代它的是 `scratchpad/v14-pg-parity-verdict-20260820.md`（**scratchpad-only，非仓内**）。

**⚠️ 先说 SHA，因为它改变分母：** 双臂实验跑在 **`6cca7ec0ed`** 上，那里
`packages/core-backend/tests/integration/approval-*` = **66** 个文件。本文重锚后的 head 是 `5feca2291b`，
那里是 **67** 个——#5026 新增了 `approval-lock7b-required-at-node.db.test.ts` `[执行]`。
⇒ **在重锚后的 head 上，双臂覆盖是 66/67，不是 66/66。** 第 67 个套件只有**单臂**证据：其车道
`approval-realdb-required-at-node.yml` 用 `image: postgres:16`（并设 `EXPECT_DB: '1'` + 硬编码 `DATABASE_URL`），
**PG14 侧从未跑过**。裁决原文里的每一处 `66/66` 都必须读作「在 `6cca7ec0ed` 上」。

**处置全文（逐字，取自裁决 §5，不得改写、不得摘要）：**

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

**处置的精确边界（本文的口径，不改写裁决）：**

1. **分母是 67 不是 66**（见本节开头）；第 67 个套件只有 PG16 单臂。
2. **五条限制里，第 2 条（灵敏度未演示）是最重的，因为它攻的是判据本身。**
   两条车道的负控只证明了「连不上会红」（Lane A 停 PG14 容器 → 同一套件 `vitest_exit=1` / `ECONNREFUSED port: 5461`；
   Lane B 打死端口 `:5999` → `rc=1` / `success:false`），**没有任何一次实验演示「一个真实的大版本行为差异会被这套
   harness 判红」**。按 `feedback_positive_control_not_failclosed`：**「断言不发生」必须配正控**，
   而这里的正控缺席。⇒ 零差异只能读成「在本平台、本 locale 下，这 66 个套件所行使的行为里没有一处在 14 与 16 之间不同」，
   **不能**读成「有差异就会被抓到」。
3. 🔴 **本节最该让 owner 看见的一条是运营面的**：**生产与预发的 compose 钉 `postgres:15-alpine`；
   CI Leg A 是 `postgres:16`；CI Leg B（封存 `plugin-tests.yml` 内的 38 个套件）是 **PostgreSQL 14**。
   ⇒ 生产实际在跑的那个大版本，从未被任何一条 CI leg、也没被本轮任何一臂测过。**
   叠在同一句上的还有两条本轮完全未行使的轴：**musl（alpine）vs glibc（Debian）**、**x86_64 vs aarch64**。
   ⚠️ 口径：以上均为**仓内 compose 文件的文本断言**，线上 `server_version` **未亲查**（沙箱到不了部署主机），
   且 `DEPLOY_COMPOSE_FILE` 是可被 env 覆盖的默认值。
   🆕 **2026-08-21 freshness 更正（绑 run SHA `13506666dae3`，详见 §11.3）：上面这句在 `5feca2291b` 上逐字为真，作为历史观测保留，但它已被 `postgres:15-alpine` 生产臂取代** —— 该臂已跑完 **67/67** approval 真库套件、**588** 条测试全通过、**319** 条迁移 exit 0（服务端 `version()` 亲证 `PostgreSQL 15.19 … aarch64-unknown-linux-musl`，镜像即三份部署 compose 所钉的同一 tag）。**V-14 残留第 1 轴（PG15 从未被跑过）已关闭、第 3a 半轴（服务端 musl）首次行使**；**第 2 / 3b / 4 / 5 轴仍未被触及，另新增第 6 条残留（lock7b 无跨大版本基线）**；**线上 `server_version` 仍未亲查**。⚠️ **禁止据此写「生产 PG 兼容性已证」/「musl 轴已关闭」/「生产数据库版本已验证」**，三条逐字禁令随行于 §11.3。
4. **一个状态的转变要与「不是免票」一起记**：Leg B 的 PG14 在本轮之前是**未验证的风险**，之后是**已测量的选择**。
   ⇒ 「要不要把 Leg B 搬到 PG16」是**排期与保真度问题，不再是正确性未知问题**；而且裁决明确**不建议**把它排在最前
   ——因为 **PG16 也不是生产版本**。owner 的三选一（按性价比）：**A** 加一条 PG15 臂（最便宜，填的正是唯一
   「生产在跑却从未被测」的版本，不动 `plugin-tests.yml`）；**B** 加一条 `postgres:15-alpine`（musl）臂对照 glibc 臂，
   直击 collation 轴（暴露面最大）；**C** 把 Leg B 与 11 条独立 workflow 一并对齐到 15（触封存文件，须走安静窗口，排最后）。
   **三条都不是代码代理可自行执行的。**
   🆕 **2026-08-21 freshness 更新（绑 `13506666dae3`，§11.3）：A 与 B 已由同一次执行一并兑现** ——
   跑的正是 `postgres:15-alpine`（既是 15、也是 musl），**67/67 套件、588 测试全通过、319 迁移 exit 0**。
   **C 仍未做**，且该臂给 C 增加了一条依据：应对齐 `postgres:15-alpine`（musl）而不是 `postgres:15`（Debian glibc），
   因为二者 collation 行为**可测地不同**。**x86_64 那条轴仍完全未行使。**

### 4.3 附带发现：`EXPECT_DB=1` 对 66 个套件中的 **41 个完全惰性** —— 一次 skip 可以在那些车道里冒充 pass

这是双臂实验的副产品，**不属于 V-14 的处置，但属于本文的验证纪律面**，逐条机械得出（对 `6cca7ec0ed` 逐文件 `grep`）：

| 分类 | 数量 | `EXPECT_DB=1` 的效果 |
|---|---|---|
| 顶层 `itIfExpectDb` 哨兵（位于 `describeIfDatabase` **之外**） | **25 / 66** | **生效**：`DATABASE_URL` 缺失 ⇒ 该条判红，整文件不会 skip-green |
| 无 `EXPECT_DB`，但有一条**形似哨兵**的 `it('sentinel: DATABASE_URL …')`，坐在 `describeIfDatabase` **内部** | **29 / 66** | **无效**：整块 `.skip`，哨兵连同被跳过 |
| 无 `EXPECT_DB` 且无任何哨兵 | **12 / 66** | **无效** |

**分布不是随机的**：41 个惰性套件里有 **38 个恰好就是 Leg B 全集**；25 个 live 哨兵**全部**在 Leg A。

⚠️ **今天这不是一个活的 CI 洞，这一点必须与上表并读**：`plugin-tests.yml` 的 approval 步在 step env 里**硬编码**
`DATABASE_URL`，且 run 首行是 `: "${DATABASE_URL:?…}"` ⇒ 该 leg 上「缺 `DATABASE_URL` 导致 skip-green」这条路径是关的；
Leg A 的 10 条 workflow 设了 `EXPECT_DB: '1'`，且**不存在**「声称 `sentinelArmed=EXPECT_DB=1` 却点名一个无哨兵套件」的假证据行
（逐条核过，本来预期会抓到，实测没有）。

**收窄后的残余风险有三条**：
1. **`DATABASE_URL` 存在但指向「错误却活着」的库** —— 上述所有防线都不覆盖。本地的具体载体已被实测到：
   `packages/core-backend/.env` **被仓库跟踪**且写死 `DATABASE_URL` ⇒ **本地「不设变量」不会 skip，而是静默连上
   `:5432` 上任何在听的东西**。**负控必须用打死的端口构造，不能用「不设变量」。**
2. **下一条新车道** —— 今天的安全性完全依赖「每条 lane 都记得硬编码 `DATABASE_URL`」这个**惯例**，
   不是套件自身的性质；惯例可以被下一条新 workflow **静默**打破。
3. **grep 假阳性** —— 那 29 条 in-describe 的 `it('sentinel: …')` 会命中 `grep sentinel`，
   让审查者误判该文件已有反 skip-green 保护。**一个不能开火的哨兵比没有哨兵更危险。**

**修法形状（仓内已有先例，且必须是单一机械门而不是逐点补哨兵）**：先例逐字见
`approval-wp1-any-mode.api.test.ts:104-110`（`itIfExpectDb` 顶层哨兵，位于 `describeIfDatabase(` **之前**）。
配套的门是**一条断言**：枚举 `tests/integration/approval-*`，断言每个文件都存在 `itIfExpectDb` 且其行号小于首个
`describeIf(Database|Db)(` 的行号；**再加一条车道侧断言**——凡点名这些文件的 workflow step 必须同时设 `EXPECT_DB: '1'`。
**第二条才是治本的**：它把「靠硬编码 `DATABASE_URL` 的惯例撑着」变成机器强制。
⚠️ **优先级按实测而非形状定**：这是**潜在的形状问题**，不是今天正在漏的洞 ⇒ **不作 P1**，
应作为一次机械枚举门一次性收掉（`feedback_trap_enumeration_does_not_converge`：逐点堵陷阱不收敛，单一 inert 门才收敛）。

---

## 5. FAIL 与修复切片

### 5.1 唯一 FAIL：`§7 a11y #1` —— flow-canvas 节点卡片截断摘要缺 hover/focus tooltip

**车道 L4。排序为 P1 修复切片 FS-1。**

⚠️ **证据性质（逐字带走）**：*"**源码读取得出，非执行得出。** L4 的 repro 原文即 'read-only, no test framework needed'。**仓内不存在任何会为此变红的测试**——这一点本身就是缺陷的一部分。"*

**被违反的 RATIFIED 判据**：`docs/development/approval-canvas-v2-interaction-design-lock-20260721.md:366`（§14 表 "Long labels" 行，作用域逐字含 "Node cards, branches, pickers, timeline"）：

> "Truncate with ellipsis at component limits (§14); full text on hover/focus tooltip, in the inspector, and in accessible names. Longest supported labels must fit without layout break (G0)"

这是**三腿**要求，**FAIL 严格限定在第一腿**：

| 腿 | 状态 |
|---|---|
| hover/focus tooltip | **MISSING —— 这就是 FAIL** |
| in the inspector | **看起来满足**（`ApprovalCanvasNodeInspector.vue` 零条 `text-overflow` 规则）——**未在实时会话点击穿透验证** |
| in accessible names | **另一个更微妙的缺口，明确不作为本 FAIL 的依据** ⇒ 单独列为 **FS-7** |

**Repro 锚点（只读）**：

- `apps/web/src/approvals/components/ApprovalFlowCanvas.vue:253-256` —— 截断元素 `<span>`，**无 `title`、无 `aria-label`**
- `apps/web/src/approvals/components/ApprovalFlowCanvas.vue:577-584` —— `overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`
- `apps/web/src/views/approval/TemplateAuthoringView.vue:1896-1903` —— `canvasNodeCardSummary()` 返回业务内容（如 `审批人：指定角色（3 个）`）
- `apps/web/src/approvals/conditionSummary.ts:60-66` —— 条件分支摘要由字段标签 + 操作符拼成或原样返回公式表达式，**长度无界**

**失效场景**：模板作者写一条长条件分支谓词（多规则拼接或一段公式），画布卡片以 `…` 视觉裁掉，hover 该卡片**拿不到原生 title tooltip**，无法恢复完整字符串。

**作用域限制（逐字）**：*"只核查了 `ApprovalFlowCanvas.vue` 与 `ApprovalCanvasNodeInspector.vue`。设计锁把 Form-builder / Version-diff / Member-detail 同样列入 'Long labels' 作用域，**这三处未做同模式普查**。"*

**修复必须两部分**：(a) 给截断元素加 hover/focus 可及的完整文本；(b) **加一条会为它变红的测试**——*"只做 (a) 等于把同类缺陷的复发通道原样留着。"*

### 5.2 不是 FAIL、但必须成为修复切片的三项（**不计入 FAIL 计数**）

| ID | 事项 | 为什么不是 FAIL | 需要什么 |
|---|---|---|---|
| **FS-3** | **AC-2 / R3：Lock-4 F4-B `designated` 空派单人兜底没有真库车道**（F4-A / F4-C / F4-E 都有）。L2 确认只有 4 个单测；R3 的运行时"未知状态 fail-closed"半边**没有真库证明** | *"是覆盖形状缺口，不是被证伪的行为；造车道属新工作，需独立评审"* | 为 F4-B designated 兜底建一条真库车道与套件，覆盖运行时 fail-closed 半边 |
| **FS-4** | **V4：并发 restore 竞态从未构造。** L2 逐字引用 FINAL 报告自己的欠债措辞 *"a constructed concurrent-restore race"*，并**在全仓范围确认此测试不存在**（最接近的一条竞的是 **publish** 不是 **restore**） | *"顺序论证对竞态无效，但现有 mocked 测试并未被证伪"* | 构造真并发的 restore 竞态（顺序论证对竞态无效） |
| **FS-7** | **accname 覆盖问题**：父级 `role="button"` div 的 `aria-label="编辑{name}节点"` 按标准 accname 规则覆盖整个子树，故摘要文本（截断或完整）**根本没有经由 accessible name 暴露** | *"与 tooltip 腿是两个问题，混成一条就会重蹈「错归类被命名成天花板」"* | 独立切片；**不得与 FS-1 合并** |

### 5.3 修复切片完整排序（台账 §8.4）

**FS-1**（唯一 FAIL，两部分缺一不可）→ **FS-2** 在已有 mounted harness 上写画布三视口 spec（*"最高杠杆"*，连带抬升 a11y#3 / a11y#7 / Flow-canvas@390）→ **FS-3** → **FS-4** → **FS-5** Inspector spec 改三视口 + 布局模式断言 → **FS-6** 在 Node 20.20.2 下重跑 L4 的 vitest 列表（*"极低成本"*，解除 R-1）→ **FS-7** → ~~**FS-8** 补齐 PG16 剩余 31 个套件并**首次构造 PG14↔PG16 对照臂**~~ **⇒ 两半均已完成（66/66 双臂、零差异，§4.2），FS-8 可关闭；接替它的是 owner 排期的三选一：加一条 PG15 臂 / 加一条 `postgres:15-alpine`（musl）臂 / 把两条 CI leg 对齐到生产的 15** → **FS-9** 给 V6/V7 指派判定器、恢复两项优越性的声明文本。

⚠️ **FS-1（那条唯一的 FAIL）与 FS-3 / FS-4 / FS-7 本轮零推进，全部保持原状。** 本节只有 FS-8 的状态改变了。

---

## 6. 门审拦下的缺陷 —— 门审纪律是承重的，不是仪式

### 6.0 先读两条口径约束

**(1) 十一个审批合入**全部是 **squash merge**（`git rev-list --parents -n1` 返回两词 ⇒ 单亲；#5025 `5ab052449b` 与 #5026 `5feca2291b` 于本次重锚逐条复核 `[执行]`）。**十对** verdict/head 逐个机械核验，**全部 NOT-ancestor**：

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

🔴 **#5026 还带着一条比 squash 更重的事实：MERGE-CLEAN 绑的是 `a96ab8ae2b`，而落地的是它之后的 `29b28b1f50`。
⇒ 没有任何闸门裁决绑定实际落地的那个 head**（`git merge-base --is-ancestor a96ab8ae2b 29b28b1f50` = ANCESTOR，
**分支内**，不是对合并提交的祖先声明）。详见 §6.1 与 §9.1。

⇒ **不得写"该 verdict 覆盖已合入的提交"这种祖先断言。** 诚实形式：**verdict 绑定 pre-squash head X，落地为 squash 提交 Y，SHA 层面无法建立祖先关系。** 唯一有内容等价证明的是 **#5023 的 rebase**：`git diff a0edbe39a4 4944bdee5f` 与 `git diff 5df20d769b efaa553d71` **各 2465 行，新增行多重集完全相同（2121 = 2121，`diff` 为空），删除行多重集亦相同**，仅 hunk 偏移与上下文行不同。其余各 PR 未做同类证明，因为它们的 verdict SHA **就是**最终 head。

**(2) #5010 / #5016 / #5019 没有门审工件。** `/tmp` 内不存在这三个 PR 的 gate/requal MD（`ls /tmp/*.md` + 内容 grep 零命中）。**不得给它们安一个门审 verdict**——它们的事后验证是收官的 **AC-5 / AC-6** 行，不是门审 MD。

### 6.1 逐切片：verdict 与其绑定的 SHA

| PR | 落地 squash SHA | 门审工件 | Verdict（绑定 SHA） |
|---|---|---|---|
| **#5024** history 守卫对齐 | `a0edbe39a4` | `/tmp/approval-history-guard-gate-20260819.md` | **MERGE-CLEAN** @ `0e0ea65118`（= PR headRefOid），0 P1 / 0 P2，3×P3 + 4×NIT。审查库为 **PostgreSQL 15.17** 而 CI 车道是 `postgres:16`（NIT-3 已披露）；`test (20.x)` 在闭门时仍 pending（NIT-2） |
| **#5021** F4-B designated 兜底 | `da0d1ca79e` | gate `/tmp/p3a-f4b-gate-20260819.md` → requal `/tmp/p3a-f4b-requal-20260820.md` | gate **FIX-ROUND** @ `591ab22aa6`（1 P1 / 3 P2 / 4 P3 / 3 NIT）→ requal **MERGE-CLEAN** @ `1dadde2ba6`（= headRefOid）。base 对 `a0edbe39a4` 重测，未用陈旧 merge-base `cc55195461` |
| **#5022** F4-E 离职转交 | `5df20d769b` | gate `/tmp/p3a-f4e-gate-20260819.md` → requal `/tmp/p3a-f4e-requal-20260820.md` | gate **FIX-ROUND** @ `108f09bc0b`（2 P1 / 1 P2）→ requal **MERGE-CLEAN** @ `5bd2e20a55`（= headRefOid）。修复链 `8e5ba9970c` / `519a145762` / `5bd2e20a55` |
| **#5023** F4-A + F4-C | `0f70783a2c` | gate `/tmp/p3a-f4a-f4c-gate-20260819.md` → requal `/tmp/p3a-f4a-f4c-requal-20260820.md` | gate **FIX-ROUND** @ `260e39fe4c`（0 P1 / 3 P2 / 2 P3）→ requal **MERGE-CLEAN** @ `4944bdee5f`（0 P1 / 0 P2 / 3 P3 / 3 NIT）。审查库销毁重建为**全新** `postgres:16`；BE 单测全量 **531 files / 8063 tests**；新增真库套件 **18/18**；FAIL-0 守卫 **265/265**；raw-id 普查 **12/12**；attendance P26 普查 **58/58** |
| **#5030** P5-C-1 对话框语法 | `2e2683cda9` | gate `/tmp/p5c-gate-20260820.md` → requal `/tmp/p5c-requal-20260820.md` | gate **FIX-ROUND** @ `0a61dd8521`（1 P2 / 1 P3 / 4 NIT）→ requal **FIX-ROUND** @ `90725bbe37`，0 P1 / 0 P2，仅一条 NEW-P3-1 |
| **#5010 / #5016 / #5019** raw-id 渲染类 | `44e6fe33ea` / `6ae6304f17` / `cc55195461` | **无门审工件（见 §6.0-2）** | —— 事后验证 = AC-5 / AC-6 |
| **#5025** Lock-7b 锁文 + 两条台账行 | `5ab052449b` | `/tmp/lock7b-review-20260820.md`（对**草稿**的独立评审） | **REQUEST-CHANGES** @ 草稿 head `b85987d3ed`（2 P1 / 4 P2 / 5 P3 / 4 NIT）。落地的 585 行是**评审后**文本；⚠️ **落地 head `207162573e` 本身没有过闸** |
| **#5026** Lock-7b 实现 | `5feca2291b` | 五份，逐份绑 head：`lock7b-impl-gate` → `-requal` → `-requal2` → `-requal3` → **`-requal4`** | `0a4827214d` FIX-ROUND → `f17cfef923` FIX-ROUND → `57e8dd6673` FIX-ROUND → `a48b447886` FIX-ROUND → **`a96ab8ae2b` MERGE-CLEAN**（取代前四份）。🔴 **落地的 head 是 `29b28b1f50`，比 MERGE-CLEAN 绑的那个多一个提交，且那一个提交未经任何闸门审阅** |

🔴 **#5026 这一行必须单独说清楚，因为它是本轮门审纪律唯一一次真正失手的地方：**
requalification #4（绑 `a96ab8ae2b`）把三条 `Sealed-export S5 …` 红判为 *"non-required, pre-existing … not attributable
to this PR"*，理由是 *"this PR changes no file under `plugins/`"*。**这条推理结构上是错的**——被打破的 digest 钉点
（`sealed-export-package-provenance.cjs` 的 `id: 'pnpmLock'`）**输入的是仓根的 `pnpm-lock.yaml`**，
而该 PR 的机制修复 v5 恰恰为了用真 SFC 解析器而加了一个 devDependency，改动了它；`pnpm-lock.yaml` **同时**是
`sealed-export-s5-sqlserver.yml` 的 path-filter 触发项（L46），所以那次改动**同时点火并打破了**它。
**闸门清了它，是后面一个提交（`29b28b1f50`）才发现并修好的。** 记法必须是「**后手抓住的**」，
**不是**「闸门抓住的」。修复方式是移除该依赖、把 `package.json` 与 `pnpm-lock.yaml` 还原到与 main 逐字节相同
（`git diff 5ab052449b 29b28b1f50 -- …` = **空** `[执行]`），改用内联 `<script>` 块抽取器，
**保留 TS-AST 归属路径**，并把新的定位启发式登记为残留 **(j)**。
✅ **本次重锚亲跑了决定性闸门** `[执行]`：在**重锚后的 exact-main（`5feca2291b`）**的**独立 detached worktree**（跑前跑后
`git status --porcelain` 均空）内 `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`
→ `OK`，**exit 0**。⚠️ **不是**在会话工作树上跑的（后者与 main 差 762 文件、`plugin-tests.yml` 差 194 行，
在那里跑出的绿没有任何证据力）。
⚠️ **同时必须记**：在 `29b28b1f50` 上 Sealed-export 车道的 check-run 数是 **零** `[执行]` ——
它的「绿」是**因为 path-filter 不再匹配而根本没触发**，**不是**一次重跑变绿（`feedback_triggered_is_not_verified`）。

两条与合入头相关的正向观测：**#5023 的合入头 `efaa553d71`** 38 个 check-run 全 success（含全部 17 条 `approval-realdb-*` 车道、`contracts (strict\|dashboard\|openapi)`、`integration-guard`、`migration-replay`、`coverage`、`e2e`），仅 `Strict E2E with Enhanced Gates` = skipped；**#5030 的合入头 `563fbb2772`** 18 个 check-run 同样全 success / 一条 skipped。**#5023 的 verdict SHA `4944bdee5f` 不在最终提交列表内**（是 rebase 前的 head），其内容等价性由上文多重集证明支撑；**#5030 的 verdict 之后只落了一条非生产提交** `563fbb2772`（`git diff --stat 90725bbe37 563fbb2772` = `apps/web/scripts/run-required-web-tests.sh | 3 +--`，1 文件 / 1 增 / 2 删），**正是 requal 处方的那一条**。

> ⚠️ **#5024 的门审工件带有明确的处置约束**（文件自带头部声明 + FINDING-1）：其 §Residual 与 mutation-B 内容**刻意不在本文复现**。本文只记录可公开的形状：守卫已对齐、verdict MERGE-CLEAN、AC-7 真库 8/8（2 判别性反例 + 2 正控）。

### 6.2 被拦下的真缺陷（每一条都附"修复不是靠削弱"的证明）

#### (1) F4-B P1-1 —— 携带新键的模板在**两个编辑器里都被砖成只读**

`emptyAssigneeFallback` 只加进了 allowlist 1（后端 rebuild spread），allowlist 2（`templateAuthoring.ts:873-890`）与 allowlist 3（`:1193-1218`）没有。门审复用 Lock-5 A-3 夹具形状对 `unsupportedTemplateAuthoringReason` 打**四路探针表**：`linear_f4b` → `"审批节点含暂不支持的配置：审批人 1"`；`complex_f4b` → `"节点含后端不会保留的配置（保存将丢失），已锁定为只读：审批人 1"`；**正控** `signaturePolicy`（已知惰性键）→ 逐字节相同串；**负控**普通审批节点 → `null`（可编辑）⇒ 谓词是键选择的，不是一刀切。

**新可达性即回归向量**：此提交之前后端 rebuild spread 会丢掉该键，故没有模板能携带它；而实现者**自己的通过测试**（`emptyAssigneeFallback SURVIVES the backend rebuild spread on create`）恰恰证明它现在会持久化 ⇒ **一次受支持的 API 保存就让模板在两个编辑器里都不可编辑，且 UI 上无路径移除该键**（恢复需再调一次 API）。同因的次生缺陷：画布只读文案 `后端不会保留的配置（保存将丢失）` 变得**事实上不成立**。

门审拒绝了实现者援引 §2.1 的辩解（那条讲的是**已渲染开关**的后端优先），指出 §2.3 是关于**新 KEY** 的独立不变量——*"both move four sites in ONE slice"*，紧邻的前一个同类切片（Lock-5 `nodeOperationPolicy`）就照做了并在 `templateAuthoring.ts:884-889` / `:1210-1216` 写明。门审定性：*"把一条强制门（X-2）窄化成「四个 allowlist 里的第 1 个」是合同变更，不是评审可豁免的作用域裁量。"*

**闭合证明（不是靠削弱）**：探针逐字重跑 → `linear_f4b → null`、`complex_f4b → null`，`signaturePolicy` 正控不变；变异 M1（从 allowlist 2 删，`:913`）**恰好**红 COMPLEX 那条、M2（allowlist 3，`:1261`）**恰好**红 LINEAR 那条、M3（`emptyAssigneeFallbackHasBackendDrop → false`，`:985`）**恰好**红后端拒绝形状那条，删 allowlist 1（`ApprovalProductService.ts:2920`）⇒ 6 条红 ⇒ **四个 allowlist 逐个承重**。附带：P3-2 的 X-3 flatten 隐患本会被"只补 allowlist"的天真修法**揭开**，同轮以删除 `templateAuthoring.ts:777` 的强制转换一并闭合。

#### (2) F4-E P1-1 —— P26 普查的**同名闭包碰撞**把新写入器折叠进已审过的分类

`test (20.x)` 与 `test (18.x)`（**必需上下文**）在 head 上是红的，由本 diff 引起：W4C-3b 的 **P26 census**（`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:940`/`:991`，由 `plugin-tests.yml:741` 执行）要求每个 `approval_assignments` DML 站点被显式分类，而本切片新增了一个未分类站点。两条子测试失败：普查本身**及其自身的 count-drift 自测**（`2 !== 1`）。三点 diff 选择性证据：GH Actions run `32272353058` 两腿 FAILURE；本地 head 2 fail 同断言文本；本地全新 `origin/main` → `tests 58 / pass 58 / fail 0`。

**实现者为何漏掉**：PR body 援引 `git diff origin/main -- .github/workflows/plugin-tests.yml` 为空——**真但无关**，workflow 没变而其 collector 步骤读的是**整个工作树的普查**。门审逐字点名类别：*"the recorded 'CI green = run the CI steps' failure mode, and specifically the recorded cross-line hazard 「审批门看不见 attendance 线」。"*

**更深的缺陷是碰撞**（修复提交 `8e5ba9970c` message 逐字）：*"`applyApprovalDepartureTransfer` 的局部 `skip` 闭包，在 P26 普查的 nearest-preceding-declaration 启发式下与同文件内 `bulkReassignApprovals` 自己的 `skip` 闭包碰撞，两个 `UPDATE approval_assignments` 站点解析到同一个键 `ApprovalProductService.ts :: skip :: update`，**把新的 F4-E 写入器静默折叠进了已审过的 `bulk_reassign_contract` 条目**（count drift 1->2）。"*

**闭合在源头而非断言处**：把闭包**重命名**为 `skipDepartureTransfer`，使每个写入器有自己诚实归属的键，再把该键加入 `P26_APPROVAL_ASSIGNMENT_CLASSIFICATIONS`（`p26-approval-assignment-classification.cjs:35-42`，owner `departure_transfer_fail_closed`）。*"没有削弱任何普查断言；碰撞一旦从底层移除，collector 自己的 count 期望测试一处都不用改"* —— requal 独立确认：collector 自测文件**不在 diff 内**，`:991`/`:997` 逐字节未变。

**归属方向经验证而非假定**（重命名式修复可能一边绿一边错归档）：带物理行号的原始普查 dump → `7813 update skip → bulkReassignApprovals` / `8237 update skipDepartureTransfer → F4-E`。四个探针：**C1**（改 F4-E 的表名）只红**它自己**的条目而非邻居；**C2**（改闭包名）同时红 `unclassified` 与 `stale`；**C3**（注入一个真正的新写入器）**精确复现原始 P1-1 失败签名** ⇒ 守卫未被 neuter；**C4**（同一符号作用域内放第二个写入器）红 `countDrift expected 1, actual 2` ⇒ **`count: 1` 这个钉子承重，新条目不会静默吸收未来的第二个写入器**。交叉污染控制 **UNREL-BULK**（变异 `bulkReassignApprovals` 自己的 `skip` 闭包体）→ **9/9 绿**。残余脆弱性如实记录：启发式是 nearest-preceding-declaration（`collector.cjs:302-338`），插入声明会重归属并**变红** ⇒ fail-closed；C3 亦显示该启发式不认识 TS 类方法——*"这正是原碰撞产生的机制，属 collector 的既有性质，非本 diff 引入"*。

#### (3) F4-E P1-2 —— 车道自称的 anti-skip-green 哨兵**结构性惰性**

`approval-departure-transfer.db.test.ts` 对 `EXPECT_DB` **零引用**；其唯一哨兵（`:246`）声明在 `describeIfDatabase(…)`（`:109` = `process.env.DATABASE_URL ? describe : describe.skip`）**内部** ⇒ `DATABASE_URL` 缺失时整个 describe 跳过，**哨兵跟着跳过，它永远不可能触发**。

**机械证明（用车道自己的命令去掉库）**：

```
env -u DATABASE_URL EXPECT_DB=1 … run tests/integration/approval-departure-transfer.db.test.ts
→ Test Files 1 skipped (1) / Tests 7 skipped (7) / EXITCODE=0
```

**绿色退出，七条门审测试静默跳过。** 两处虚假声明被定位：workflow 注释（*"a run in this lane with a missing/broken DATABASE_URL goes RED instead of silently reporting the whole file as skipped"*）与 PR body（*"EXPECT_DB=1 armed"*）。它照抄的先例只抄了一半：`approval-dedup-return-round-scoping.db.test.ts:45-46` 的 `itIfExpectDb` 是**顶层** `it`、在任何 `describeIfDatabase` 之外——*"切片抄了这个模式的 workflow 一半，没抄测试那一半。"* 之所以是 P1 而非 nit：`vitest.config.ts` 的 exclude 把该套件从唯一默认运行它的 `test (18.x/20.x)` 里移除了，而替代车道**无法察觉自己丢了库**——*"这是两点接线作为一对失效，不是两个独立的 nit。"* 闭合方式：把 `EXPECT_DB` 哨兵提升到 `describeIfDatabase` 之外的顶层，负向重跑必须非零退出。

#### (4) F4-E P2 —— 两种非转交结局让离职者**继续占位且无审计行、无操作者告警**

Lock-4 的 fail-closed 条款对**证据**是明写的：*"The assignment is LEFT IN PLACE and **an audit row plus operator warning is emitted** — never auto-approved, never dropped, never escalated to an admin seat."* `no_manager_resolved` 遵守了；实现者新加的两个跳过理由（`target-is-requester` `:8116`、`target-already-assignee` `:8133`）都只 `ROLLBACK` + `skip(...)`，**无 `insertApprovalRecord`、无 `warn`**——可观测终态相同，**零持久痕迹**，唯一信号是一个**没有任何生产调用方消费**的 `skipped[]` 数组。由 `519a145762` 闭合；requal 变异台账 P2-M2/M4/M6 各自**只**红 `:636`/`:654` 的碰撞守卫测试 ⇒ specific，非烟雾报警。**残余 N-1（P3）**：P26 attendance-central 跳过是唯一仍无操作者告警的占位结局。

#### (5) F4-A/F4-C P2-1 —— `samePersonPolicy` **自我回滚开关：已渲染控件上的活体 fail-OPEN**

PR body 断言 *"A template hand-carrying `approvalType` or `samePersonPolicy` round-trips **read-only** in both FE editors."* 被机械证伪：

| LINEAR 图上的节点配置 | `unsupportedTemplateAuthoringReason` |
|---|---|
| baseline | `null`（可编辑）—— 负控 |
| `totallyUnknownKey` | 非 null —— 正控，守卫是活的 |
| `approvalType:'auto_approve'` | 非 null ✅ 与披露一致 |
| `autoApprovalPolicy.samePersonPolicy` | **`null` —— 可编辑** ❌ |

机制：linear 分支（`templateAuthoring.ts:1194-1218`）只查**顶层键**而 `autoApprovalPolicy` 是允许的顶层键，它从不跑 complex 路径跑的嵌套 `BACKEND_AUTO_APPROVAL_POLICY_KEYS` 检查（`:1067`）。于是：作者把自动跳过**关掉** → `buildApprovalGraph` 发出 `autoApprovalPolicy:{"samePersonPolicy":"auto_skip"}` → 后端 `normalizeAutoApprovalPolicy`（`ApprovalProductService.ts:732`）**重新合成 `mergeWithRequester:true`**。**经真 HTTP API + Postgres 端到端复现**（非推断）：`POST /api/approval-templates` 存 `{"samePersonPolicy":"auto_skip","mergeWithRequester":true}`；用 apps/web 在开关关掉后实际发出的配置 `PATCH` → **200 OK**，存储值**未变**——*"保存成功了，而被删掉的标志又回来了。"* 影响逐字：*"请求人的席位继续被违背作者明确指令地自动通过掉。那是已渲染控件上的 fail-OPEN，而且是**本切片引入的**"*（此前 `samePersonPolicy` 根本无法持久化）。门审拒绝只改文档：*"(a) …这才是真修复，因为一个被准确披露的自我回滚开关仍然是自我回滚开关；**并且** (b) 改正 PR body……单改文档不解除本条。"* requal 记为 **CLOSED with evidence**。

#### (6) F4-A/F4-C P2-2 —— Gate A-3 的"控制组"是**同结局控制组，零判别力**，且**修复轮在自己的修复里复现了同一缺陷并自捕**

已 ratify 的 A-3：*"after an `auto_approve` node, a later node assigned to any real user is **NOT** auto-approved by `dedupeHistoricalApprover`"*，控制组：*"a genuine human approval at that same position **DOES** trigger the dedup — the exemption is event-selected."* 而交付的夹具断言的是**另一个命题**（人工审批在自动节点**之前**），其配对测试还断言*"完全相同的结局"*——*"一个断言与被测同样结局的控制组不能判别任何东西"*，被 ratify 的夹具从未被构造。门审自己对着活 Postgres 建了这对：`start → auto1(auto_approve) → manual2(P,…)` → **`pending`、席位 = P** ✅；控制组换成真被人工批准的节点 → **`approved`** ✅。

**然后修复轮在自己的修复里复现了同一缺陷并自捕**（提交 `4944bdee5f` message 逐字）：*"MERGE 那条臂先匹配上了，dedup 那条臂根本没被走到。控制组的 `approved` 结局因此并未证明关于 `dedupeHistoricalApprover` 的任何事——**恰好复现了本修复轮存在的理由：结局被断言、机制未被验证**。"* 修法：两个配置都去掉 `mergeAdjacentApprover` 并断言 `metadata.reason === 'auto-dedupe-historical'`；双向变异证明（去掉 dedup 的 actor-equality 子句只红正例；禁掉整条 dedup 臂只红控制组）。requal：**CLOSED with evidence，且不是靠削弱抓到它的那条测试。**

#### (7) P5-C P2-1 —— focus-on-open 在生产中**可证惰性**，其四条测试之所以绿只因夹具省掉了真正的 focus trap

站点：`ApprovalDetailView.vue:1547-1570`（`focusPrimaryControl` @ `:1568`，四个 ref @ `:1554-1557`），调用于 `:1976`/`:1993`/`:2003`/`:2189`，由 `approval-member-action-dialog-grammar.spec.ts:440-500` 的 4 条测试守卫。机制被精确命名：Element Plus 以 `focus-start-el="container"` 渲染 `<el-dialog>`（`dialog2.mjs:111`），`ElFocusTrap.startTrap()`（`focus-trap.mjs:175-203`）串了**两个** `nextTick` 并以无条件 `tryFocus(trapContainer)` 收尾（`:199-201`）；`focusPrimaryControl` 只用**一个** `nextTick` ⇒ **trap 永远赢**。三个经验控制：正控（jsdom 里裸 `textarea.focus()`）→ textarea；负控（交付 spec 自己的**桩** `ElDialog`）→ `TEXTAREA.el-textarea__inner is-focus` ✅ *交付的绿在桩下是真的*；**真 `ElDialog`** → `DIV.el-dialog[data-testid="approval-comment-dialog"]` ⇒ `activeElement === textarea` 为**假**。判别性变异：neuter `focusPrimaryControl` → 桩夹具红那 4 条（说明它们对桩确实有牙）；**真 `ElDialog` 下，有没有这段代码结果逐字节相同**⇒ 死代码 + 一条夹具省掉了决定结局的组件的绿测试。之所以是 P2 不是 NIT：PR body 宣称 *"'focus moves to the primary control on open' (**mutation-tested**)"* 并把它列进变异证据表，而 C7 披露只切掉了 focus-**trap** / focus-**return** / **ESC**——*"缺陷 = 声明 + 惰性代码。"*

**闭合走的是首选补救 1，且是彻底的**：`90725bbe37` 删掉 `focusPrimaryControl` 及其文档注释、四个 ref、四处模板 `ref=` 绑定、`nextTick` import、四个调用点，以及整个 `describe` 块。**"不是只被禁用"的结构性证明**：桩工厂 `makeFocusable`（当初 `expose({focus: …})` 才使那条断言得以存在）被换成**没有 `expose`** 的 `makeFieldStub`——*"夹具已经无法表达那条断言了。"* 全仓 grep 六个符号于 `apps/web/src|tests|scripts`、`.github`、`docs` → **零命中**；spec 18 → **14** 条，必需车道 4942 → **4938**（恰好 −4）。**撤回清扫本身随后又被审计，并抓到一处遗漏**——`run-required-web-tests.sh:301-302` 仍在声明该覆盖（NEW-P3-1），由合入前最后一条提交 `563fbb2772` 修掉。

#### (8) Lock-7b —— **五轮普查逃逸链**：前四轮每一轮关掉上一轮的机制然后找到下一条通道，第五轮换掉了机制本身

目标件 `packages/core-backend/tests/unit/approval-field-access-enum-mirror.test.ts`；被守护的 ratified 属性 = **G-14**：*"the NINE §0.4 sites are asserted equal by exact set — not count, not subset — and the site LIST itself is asserted, so **a tenth copy added later fails the census rather than passing unnoticed**."*

| 轮 | 工件 | 绑定 head | Verdict | 该 head 的机制 | 找到的逃逸 |
|---|---|---|---|---|---|
| **0（文档审）** | `lock7b-review-20260820.md` | 草稿 `b85987d3ed` | **REQUEST-CHANGES**（2 P1 / 4 P2 / 5 P3 / 4 NIT） | — | P1-1：执行点在主流 payload 形状下够不到冻结 schema ⇒ 一键客户端旁路 ⇒ 成为 **OD-L7B-11** |
| **1（实现门）** | `lock7b-impl-gate-20260820.md` | `0a4827214d` | **FIX-ROUND**（0 P1 / 1 P2 / 3 P3 / 2 NIT） | 六个 `shapePatterns`，**只匹配四成员形式**（`:155-159`） | **P2-1**：陈旧的**三成员**副本——正是普查存在所要防的漂移类——不被识别为载体。三成员探针文件 → 普查 **14 passed (14)**；四成员正控 → **1 failed \| 13 passed**。*"这个门只能发现已经正确的副本。"* |
| **2（requal #1）** | `lock7b-requal-20260820.md` | `f17cfef923` | **FIX-ROUND**（P2-1 真闭合；新增 R1 / R2 两条 P2） | 在六个具名形状族**内**做成员数无关匹配 | **R1 —— 仍有 8 种形状可逃逸**，普查对每一种都停在 `23 passed (23)`：B1 双引号联合 · **B2 `!==`/`&&` 链——正是 C-4 已交付的那份 Lock-7 形式，即本普查所要防的那一次漂移的确切历史语法** · B3 `switch` · B4 匿名 rank map · B5 注释穿插 · B6 常量间接 · B7 块式 YAML（OpenAPI 的普通写法） · **B8 `.vue` 模板属性——真实创作面所用的形状**（`ApprovalGraphNodeConfigEditor.vue` 就以此形式在被扫描树内带着一份活的四成员手抄件，却隐形）。三个控制探针确实变红 ⇒ 探针非空转 |
| **3（requal #2）** | `lock7b-requal2-20260820.md` | `57e8dd6673` | **FIX-ROUND（一条 P2）**；R1 的十一种形状全部变红——*"重建达成了它自述的目标"* | **字面共现** + 邻近聚类（`PROXIMITY_WINDOW` 150 B） | **R7 —— 聚类合并吞噬。** `clusterOccurrences` 传递成链且 per-cluster 测试短路：`const isComplete = c.members.length === MEMBERS.length; const matches = isComplete ? [] : matchingAllowlistEntries(...)`。陈旧三成员副本只要落在**任何** `'required'` 出现点 150 B 内，就并进四成员簇并**完全不经过 allowlist** 通过。**七个复现**，含 N5a（陈旧 const 紧贴真源文件里的 `NODE_FIELD_ACCESS_VALUES` 上方）→ `42 passed`；N5-CONTROL（同一 const 放 EOF、约 4.9 KB 外）→ `1 failed`。工件本身还**两次声称了相反的结论** |
| **4（requal #3）** | `lock7b-requal3-20260820.md` | **`a48b447886`** | **FIX-ROUND（一条 P2）** | v3 `TS_DECLARATION_BOUNDARY_RE` + v4 per-file complete-count 钉 | **R8 —— 共享声明攻击**（见下） |
| **5（requal #4，终局）** | `lock7b-requal4-20260820.md` | **`a96ab8ae2b`** | **MERGE-CLEAN**，取代前四份 | **机制修复 v5（`c3a0a9441a`）：换机制，不再改正则。** (i) 手写副本**塌缩成从规范 tuple 派生的单一元组**（消灭载体，而非更好地检测载体）；(ii) `.ts` 与 `.vue` `<script>` 的声明边界改由 **TypeScript AST**（`ts.createSourceFile` + 最内层语句包含判定）给出；(iii) 声明**降级**为 *"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP"*。基线普查 **50 passed (50)** | **不是新通道，而是承认一族固有残留并逐条具名 (a)–(j)**。其中 **(i) SAME-STATEMENT SHARING 被评审现场复现且静默（50 passed）**，制品自己已逐字披露 *"the compiler does NOT catch this either"*。评审判为「尽力而为路径的固有形状 + 树内无活载体」⇒ **不阻塞** |
| **6（裁决后、落地前）** | **无工件——没有任何闸门审过它** | **`29b28b1f50`** | **未过闸** | 移除 `@vue/compiler-sfc`，改内联 `<script>` 块抽取器；TS-AST 归属路径不动；新增残留 **(j)** | **这个提交本身是一次治理钉点事故的修复**（§6.1）。它是**实际落地的 head**，而 MERGE-CLEAN 绑的是它的父提交 |

**R8 的证据（requal3 §2）**：`TS_DECLARATION_BOUNDARY_RE = /^(export\s+)?(const|let|var|type|interface|enum|function|class)\b/gm` **只在第 0 列触发** ⇒ 两个第 0 列声明之间的一切算作**一个单元**，**包括整个函数体**；陈旧副本落在同一单元内就从不跨界，`spansDeclarationBoundary` 保持 `false`，合并后的簇取 `isComplete`，而因为这次合并是扩展一个**已计数**的簇，v4 的 count 钉也什么都说不了。

| 探针 | 放置 | 结果 |
|---|---|---|
| **P-A1** | 第二份陈旧 `if (['editable','readonly','hidden'].includes(...))`，**紧贴** C-6 的四成员权威检查下方，同一 `validateApprovalNodeEdits` 函数体 | **43 passed —— 静默** |
| **P-A4** | 缩进的 `const LEGACY_ACCESS = [...]`，同一函数体内该检查上方 | **43 passed —— 静默** |
| **P-A5** | 缩进的 `const LEGACY_LABELS = {…}`，紧邻 `ApprovalGraphNodeConfigEditor.vue` `<script setup>` 内的 `FIELD_ACCESS_LABELS` | **43 passed —— 静默**（评审自标为机制演示，非现实漂移） |
| **P-A1-CONTROL** | 字节等价的列表放进自己的第 0 列 `export function`（EOF） | **1 failed** —— `approvalNodeEdit.ts @30780-30812 :: {editable, hidden, readonly}` |
| **Y1**（YAML 半边） | `x-legacyFieldAccess: [editable, readonly, hidden]` 置于 `base.yml` C-8 下 | **变红** —— `base.yml @109609-109635` |

机制由**插桩确认而非推断**：P-A1 下 `scanned` dump 给出单簇 `{"s":26285,"e":26485,"m":["editable","hidden","readonly","required"],"span":false}`，对比 44 字节的基线 `@26285-26329` —— **同一起点、跨度被延长 156 B 把陈旧副本吞了进去**，`isComplete === true`，`completeCounts[...]` 仍是 **1** 即其钉值。爆炸半径也记录在案，使修复不能只特判 C-6：`isNodeFieldAccess`（`templateAuthoring.ts:536`）属同一类，探针 P-A2 **确实**变红但**是经由 C-7 SITES 提取器的正则，而非被测的普查机制**——*"是提取器脆性，不是边界门在起作用。"*

**作用域纪律（逐字带走）**：*"No live site is masked today: at this head every SITES mutation still reds (§4), and R8 requires a NEW stale copy."* requal3 的标题句同样逐字：*"**The six reported R7 INSTANCES are closed. The R7 CLASS is not** — it has been *re-scoped* from 'an adjacent **column-0** declaration' to 'an adjacent **non-column-0** declaration', which is at least as likely in real code."*

**第五轮：「编译器是主门」是被证明过的，不是被声称的** `[制品]`。评审亲手把第五个成员 `'archived_TEETH_PROBE'` 加进规范 tuple，四个格子逐一变异、`cp` 还原并 sha256 校验：

| 格 | 变异 | 检查器 | 结果 |
|---|---|---|---|
| **A** | 后端 `NODE_FIELD_ACCESS_MEMBERS` += 第五成员 | `tsc --noEmit` | **RED（exit 2）** — `TS2741` at `approval-form-redaction.ts` 的 `NODE_FIELD_ACCESS_RANK` |
| **B** | 后端 tuple += 第五成员 | `vue-tsc -b` | GREEN — FE 有自己的 tuple |
| **C** | FE `NODE_FIELD_ACCESS_MEMBERS` += 第五成员 | `vue-tsc -b` | **RED（exit 2）** — `TS2741` at `ApprovalGraphNodeConfigEditor.vue` 的 `FIELD_ACCESS_LABELS` |
| **D** | FE tuple += 第五成员 | `tsc --noEmit` | GREEN |

⚠️ **该证明自己的两条边界必须一起带走，本文不取干净版**：
- **B / D 是绿的** ⇒ 制品里那句 *"Add a fifth member to **either** tuple and `tsc`/`vue-tsc` red at **every** `Record<NodeFieldAccess, …>` site immediately"* **按严格全称读是假的**；跨侧一致性由普查自己的 `SITES` 等值断言兜住（探针 X1 实测变红）。评审判为**措辞不精确，不是覆盖缺口**。
- `NODE_FIELD_ACCESS_WRITABLE_VALUES` **会**静默吸收第五成员——**刻意的子集**，在其声明处已披露，「编译器主门」那句声明本身也限定了 *"for the sites it covers"*。**记录在案，下一轮不得当作新发现。**

⏳ **这条链结清之后留下的 owner 裁决项**：落地物把声明降级为 best-effort backstop，而 **G-14 的已批准属性**写的是「九处站点按精确集合断言 ⇒ **第十份副本会让普查变红，而不是无声通过**」。**一个自认尽力而为、并逐条具名了 (a)–(j) 残留（其中 (i) 现场复现且静默）的扫描器是否仍承得起 G-14，是 owner 裁决，不是交付方可自证的事**（`feedback_second_narrower_artifact_is_contract_narrowing`：锁点名 A 而交付 A'，只能升 owner 裁）。附带一条同样待裁：**残留 (j) 是在 MERGE-CLEAN 之后加的，未经任何闸门审阅。**

### 6.3 这一节的结论口径

七个切片级缺陷 + 一条跨**五轮**的普查逃逸链，全部**在交付前**被拦下，且每一条的闭合都附有"不是靠削弱"的机械证明（逐 allowlist 单删、collector 自测文件字节未变、真 `ElDialog` 下的字节相同对照、双向变异、控制探针红/绿分离）。其中两条尤其说明门审不是仪式：**F4-A/F4-C 的修复轮在自己的修复里复现了同一类缺陷并自捕**；**P5-C 的撤回清扫本身被再审计并抓到一处遗漏**。

⚠️ **但本节的结论不得写成「门审没有失手」——它失手过一次，且被记在 §6.1**：requalification #4 把
Sealed-export 三条红**归错了因**（按目录归因，而钉点的输入是仓根文件），是**后面一个未过闸的提交**发现并修好的。
⇒ 准确口径：**门审拦下了七个切片级缺陷与一条五轮逃逸链；它同时漏判了一次治理钉点事故，那一次是后手抓住的。**
两句必须并排读。

⚠️ **本节不含"P3-A 已落地"或"Lock-4 已实现"的任何形式**。机械核验于 `6cca7ec0ed`：`git log --first-parent d8ac22c989..6cca7ec0ed` 中匹配 `F4-|P3-A` 的恰好三个提交（#5021 F4-B、#5022 F4-E、#5023 F4-A+F4-C），**无 F4-D 提交**；`git grep -c "dedupTier"` → **0**；`ApprovalType` 联合只有两个成员。⇒ 准确形式：**P3-A 五族中四族（F4-A / F4-B / F4-C / F4-E）落地；F4-D（OD-L4-6 / OD-L4-7 / OD-L4-10）与被延后的 `auto_reject`（OD-L4-2(a)）本轮未落地。**

---

## 7. 仍欠的判别性反例（PASS-POSITIVE-ONLY，36 行）

**分桶合计 = 21 + 8 + 4 + 3 = 36 行（按行计）。**

> ⚠️ **R9 被刻意拆到两个桶**——cancel 半边（廉价）与 focus 半边（需真 focus trap ⇒ 真浏览器）；AC-8 继承 R9，故与 cancel 半边同列。**这是有意拆分，不是重复计数。**

### 7.1 廉价可解除（在已有机制上补一条断言 / 一次变异）—— 21 行

| 行 | 所欠判别性反例 | 备注 |
|---|---|---|
| §2 #5 | truthy-非-`'true'`（`'1'`/`'yes'`/`'TRUE'`）被三个 flag 解析器拒绝 | ⚠️ 三者都用 `.toLowerCase()==='true'`，故 **`'TRUE'` 会启用**——*"这本身值得先裁决是否为预期"* |
| F11 | 删字段 → 撤销 → 再分配 的 ID 组合碰撞 | 纯单测 |
| U2 | 向基础信息选择器喂裸逗号分隔串并断言被拒 | 纯挂载 |
| U5 | 断言不存在第二套 / 重复 gallery 实现 | 机械枚举 |
| I1 | `static_role` / `requester` / `form_field_user` 三种的真库 round-trip | 跨车道对账即可 |
| I2 | 同节点两个重叠 source → 并集去重后名册 | 需新测试，纯真库 |
| I4 | timeout 到期真正触发（"executes" 半边） | 机制在 `approval-node-sla-remind`，跨车道对账 |
| I9 | 点名 timeout/threshold 卡片的 diff / restore | 纯单测 |
| I10 | 审批节点派单人注册表的**精确集合**断言 | 照抄 handler 版本的 `toEqual(new Set(...))` |
| R2 | 发布后目录变更写审计行的断言（"is audited" 半边） | 真库 |
| R7 | FE"按钮消失"半边跨车道对账 | 机制已在 L4 |
| R9（cancel 半边） | cancel 按钮关闭且零变更 | — |
| R10 | 逐动作键盘 Enter/Space 真触发 handler | 挂载 |
| R12 | ordered-within-node / after-sign 缺席半边跨车道对账 | 机制已在 L3 |
| M1 | 变异证明时间线分组断言承重 | 一次变异 |
| M3 | 批量**审批**的专属行为测试标题（现与批量驳回共用路径，属推断） | 纯挂载 |
| M5 | 节点等待 chip 取自 `detail.updatedAt` 而非客户端 `Date.now()` | 挂载 |
| V1 | 历史版本行在后续发布后逐字节未变（现由 insert/swap 模式**推断**不可变性） | 真库 |
| V3 | 真库确认 restore + "已发布/运行中版本不受影响" | 真库 |
| D5 | 真库"只写一次"持久化 / 幂等半边 | 真库 |
| AC-8 | 随 R9 一并 | — |

### 7.2 需要真浏览器 spec（**载具已存在**，写 spec 即可）—— 8 行

| 行 | 所欠 | 载具 |
|---|---|---|
| Form builder @1440 / @1024 / @390（3 行） | 在**该视口**重跑完整交互；@390 尤其欠"点按插入可完成"（B1 / B10 都跑在默认桌面视口） | `approval-form-builder-mounted-harness`（已有，`setViewportSize` 后重跑 B1/B10） |
| Flow canvas @390 | 真浏览器确认窄布局本身不强制拖拽（现仅 jsdom 逻辑层替代品） | 同上（导航到 flow 步） |
| a11y #2 | move / delete / close / restore 焦点归位 + **画布节点**焦点归位（现兑现 add + undo 且仅限表单字段） | 需真 focus trap ⇒ 真浏览器 |
| a11y #3 | flow-canvas 节点 / 分支 / 汇合的键盘可达（现只有 jsdom aria-label 源断言） | 同上 |
| a11y #7 | 真 Chromium **解析后**的 computed CSS——现守卫只比未解析的 `var(--…)` token 文本，**祖先作用域按节点类型重定义 token 即可逃逸而守卫仍绿** | 同上 |
| R9（focus 半边） | 对话框打开时焦点落位 | 文件自述需 P5-C-3 harness；实为在已有 mounted harness 上扩展 |

### 7.3 真正需要组装应用 / 新基础设施 —— 4 行

| 行 | 为什么 |
|---|---|
| a11y #4（validation / diff 两个载体） | 需要一个能进入**校验失败态**与**版本 diff 态**的真实装配视图 |
| a11y #6（端到端切入并停留在结构化模式） | 需完整 `TemplateAuthoringView` 会话级交互 |
| D3 / D4（触发链半边） | 需"活审批实例终态决策 → `automation-service` allowlist → FWB 执行器"的端到端装配（现接线点 `:150`/`:1960` 仅 `[源读]`） |

### 7.4 明确 owner-only、不可由代码解除 —— 3 行

**R1**（#5004 已判"非债"，L2 无法从夹具独立复现该判断，需 owner 拍板是否接受——夹具只构造了同 org 内的 deactivated / nameless / nonexistent 三类，**未构造真正属于另一个 corp/org 的 id**）、**superiority#6**（端到端 / 活租户功能半边 = P7-C）、**G8**（全闸跨四车道 + 66/66 PG16，属 V-14 而非本行）。

### 7.5 证据保留项 R-1（务必随债一起带走）

L4 的 **463 个 vitest 测试 / 20 个文件**（含 §2#4 / AC-5 原始 ID 普查、M1、M3、M4、M6、R9、R10、a11y#2、a11y#7、superiority#4）**跑在 Node v25.9.0 / pnpm 10.33.0** 下。L1 在跑任何一行之前主动切到 v20.20.2，理由逐字：*"vitest 1.6.1 is far outside v25's support window and any result under it would have been suspect."* ⇒ **L4 这批结果带一条环境保留，廉价可解除 = FS-6。L2 / L3 的 Node 版本报告未记录，不假设为 20。**

---

## 8. BLOCKED-ENV（15 行）与 OWNER-ONLY（20 行）

### 8.1 BLOCKED-ENV —— 按根因归并，逐条给出解除条件

| 根因 | 受阻行 | 解除条件 | 成本 |
|---|---|---|---|
| **RC-1：缺少断言画布声明的真 Chromium spec（不是缺 harness）** | Flow-canvas @1440、@1024（2）、U6（1）、superiority#5（1）= **4 行**；另**封顶** a11y#3 画布半边、a11y#7 真 CSS 半边、Flow-canvas@390 三行的分层 | 在**已存在的** `apps/web/verification/approval-form-builder-mounted-harness.ts` 上写 spec（它挂完整生产 `TemplateAuthoringView.vue` + 真 Router + 真 Element Plus，`canvasV2` 默认 ON，`:379` 即 `<ApprovalFlowCanvas>`）：导航到 flow 步并在三个具名视口断言 | **低——单一最高杠杆项（FS-2）**。⚠️ 台账**未执行验证**该 harness 内 flow 步是否可达 / 画布是否真绘制（源读结论）；**这是动工前的第一件事** |
| **RC-2：Inspector harness 视口与声明都不对** | Inspector @1440 / @1024 / @390 = **3 行** | `approval-inspector-keyboard-harness.ts` 已挂真 `ApprovalCanvasNodeInspector.vue`；把 spec 从固定 **1000×800**（与三个具名视口**均不符**）改为三视口，并新增 docked / overlay / bottom-sheet 布局模式断言（现测试**从不断言**布局模式） | 低（FS-5） |
| **RC-3：无组装应用** | Version ×3、Member-detail ×3 = **6 行** | 把版本工作区挂到"已发布模板 + 活实例行"上、把 `ApprovalDetailView` 挂到真实例上——即组装应用，或新建两个 harness | **高（新工作，需独立评审）** |
| **RC-4：无生产 / staging schema 快照** | G9 旧库升级半边、V5 = **2 行** | 一份生产或 staging 的旧 schema dump。沙箱到不了部署主机 `23.254.236.11`，仓内亦无 dump ⇒ **ops / owner 供给** | 高，且**非代码工作** |

### 8.2 OWNER-ONLY —— 20 行，逐条解除条件

| 行 | 解除条件 |
|---|---|
| **Owner block ×15**：母本 §10 Canvas UAT S1–S12、独立 FWB UAT、独立附件 UAT、P7-E 分级 flag 启用 + 回滚、§0 三标签声明清单、§12 最终 owner 记录，以及 Lock-5 / Lock-1 K1·K3·K6 / Lock-8 L8-A 的**运行时启用授权**、OD-L8-7(a) 生产模板语料扫描、FAIL-6 形状裁定 | owner 亲自执行 / 亲自签署。*"构造上不可由代码代理执行，phase-A 与本轮均一行未执行。"*（注：K1 / K3 / L8-A 的**实现切片本身已落地**，此处指其**运行时启用授权**） |
| **§2 #7** 私有发布前置条件 | owner 带外闭合并记录 |
| **§7 a11y #5**「无嵌套卡片 / 溢出 / 重叠」 | **owner 给出卡片级判据定义**——*"判据缺失是 owner 决策，不是环境阻塞"* |
| **I14** 字段权限诚实性 | 行文写"直到 Lock-7 才强制"而 Lock-7 已落地（P4-B #4961）⇒ **按原文不可满足**。owner 改写或退休该行 |
| **U1** 四步 legacy 草稿 | 前提"更多设置无功能策略"被 L6-A dedup 分层落地证伪 ⇒ owner 改写或退休 |
| **F12** 引用权威不可用 → fail-closed | 前提被 **RATIFIED FB-D6** 证伪（`CompleteFormReferenceInventory` 文档注释逐字 *"Production callers pass no inventory (**RATIFIED FB-D6**)"*；FWB 映射按 `sourceTemplateVersionId` 版本钉死而非活引用 ⇒ 不存在可"不可用"的 provider）⇒ owner 二选一：改写 F12 对齐 FB-D6，或判定版本钉死不足并立项造该 provider |

> **I14 / U1 / F12 是同一类，逐字带走**：*"矩阵行描述了一个在本 SHA 已不成立的世界。**这不是代码缺陷，也不是覆盖缺口，把它们记成任何一种都是错归类。**"*

### 8.3 NOT RUN —— 5 行（**母矩阵 4 行 + ADDED-AT-CLOSEOUT 的 AC-10 = 5**；§3.1 的 Δ 列 `+4` 只数母矩阵，两处并不矛盾）

| 行 | 状态与解除条件 |
|---|---|
| **V6**（旧编辑器兜底不擦除未知配置） | 任何车道的命令集内**都没有判定机制**。候选 `approval-ui-workspace.spec.ts` 存在但不在任一车道命令列表；需先确认它是否真的判定本行。**不推断、不按 PPO 记** |
| **V7**（编辑器入口从授权页头可达且不重复版本存储） | L2 逐字自述 *"zero direct positive evidence … treat this specifically as **NOT EXERCISED BY L2**"*。候选在 `approvalTemplateAuthoring.spec.ts`（L1 域）但 L1 未把它记到本行 |
| **优越性 ×2**（L2 承接） | **声明文本本身不可恢复**：L2 逐字自述 *"cannot cite which two specific superiority claims these are"*；逐行证据文件 `scratchpad/p7-phase{A,B}-evidence-20260818.md` 经四处 scratchpad 搜索**零命中、确认灭失** ⇒ 需 owner 或从开发报告 §4.1 重建逐字声明文本，否则无从判定 |
| **AC-10** Lock-7b 节点级必填层 | ⚠️ **重锚更正：#5026 已落地（`5feca2291b`），本行仍是 NOT RUN，阻塞理由从「尚未落地」换成「已落地，但在两个 SHA 上都没有被任何收官车道判过」**——收官跑在读取基线 `6cca7ec0ed`（彼时它还没落地），而重锚后的 exact-main `5feca2291b` 上没有跑过任何收官车道。解除条件 = 在重锚后的 exact-main 上真跑一次 `approval-lock7b-required-at-node.db.test.ts`（新增的第 67 个 approval 真库套件）并按其所载机制判定。**在此之前不作断言**；已有的 PR 侧 CI 与 requal#4 电池都绑 pre-squash head，不顶替 |

### 8.4 必需检查状态是一条时间序列，不是一个事实

| 观测时点 | 条数 | 来源 |
|---|---|---|
| 2026-08-19（#5009 提交正文） | **9** 条，`strict=false`，无审批专属 | `cf830d6736` commit message |
| 2026-08-19（F4-E 门审，逐条枚举） | **10** 条（含 `ssh host-key pin contract`） | `/tmp/p3a-f4e-gate-20260819.md:18` |
| 2026-08-20（收官 AC-12 / G10） | **11** 条，`strict:false`，`enforce_admins:true`，**零个审批车道在必需集中** | 台账 §3 G10 / AC-12 |
| **2026-08-20 12:33:13 +0800（本会话实测）** | **11** 条：`contracts (strict)` · `contracts (dashboard)` · `pr-validate` · `test (20.x)` · `contracts (openapi)` · `web-tests` · `stock-prep PowerShell 5.1 acceptance` · `attendance-web-guard` · `integration-guard` · `ssh host-key pin contract (fail-closed known_hosts)` · `observation-kit contract (read-only SQL census + runbook gating)`；`strict:false`，`enforce_admins:true` | `gh api repos/zensgit/metasheet2/branches/main/protection` |

⚠️ 实测 `strict:false` 与既往记忆"2026-08-14 恢复 strict=true"冲突——**记为线上漂移，非本轮失败**；成因未调查。把审批车道**加入**必需集是 **OWNER-ONLY（V-13）**。

---

## 9. 两项尾部工作的结清状态 —— **均已结清**；仍悬着的是另外几项 owner-only

> **本节整段改写。** 草稿把两项记为 TAIL-PENDING：§9.1 的 Lock-7b（当时在飞）与 §9.2 的 PG14↔PG16 对照臂（当时未开工）。
> **两项现在都已结清。** 但**结清不等于完成**：本节逐条给出「结清到什么程度」与「结清之后剩下什么」。

### 9.1 Lock-7b（#5025 文档 / #5026 实现）—— **两者均已 MERGED**

| PR | 状态 | pre-squash head | 落地 squash SHA |
|---|---|---|---|
| **#5025** | **MERGED** 2026-08-20T06:33:24Z | `207162573e11981b50a2a21f3a8cd82346ff649d`（⚠️ **不是**草稿记的 `a1549ce303`——分支在草稿观测后又前进过） | **`5ab052449b`** |
| **#5026** | **MERGED** 2026-08-20T07:06:10Z | **`29b28b1f50e8f0e4a86ca5a5678904f3522ef7c1`** | **`5feca2291b`**（= 当前 origin/main） |

**终局裁决**：`/tmp/lock7b-requal4-20260820.md` = **MERGE-CLEAN**，绑 **`a96ab8ae2b`**，
取代前四份（`impl-gate` @ `0a4827214d`、`requal` @ `f17cfef923`、`requal2` @ `57e8dd6673`、`requal3` @ `a48b447886`）。
该 head 上基线普查 **50 passed (50)**、`tsc --noEmit` exit 0、`vue-tsc -b` exit 0、真库 **14/14**、
`run-required-web-tests.sh` **387 files / 4923 passed / EXIT=0**、十一条必需检查全绿。

**四条必须随行的限定（缺一条本节就变成过强声明）：**

1. 🔴 **没有任何闸门裁决绑定实际落地的那个 head。** MERGE-CLEAN 绑 `a96ab8ae2b`；分支随后又前进一个提交到
   `29b28b1f50`（**未过闸**），`5feca2291b` 是它的 squash。诚实句式：**裁决绑 pre-squash head `a96ab8ae2b`，
   以 squash commit `5feca2291b` 落地；SHA 层面无法建立祖先关系。** 机械核实 `[执行]`：
   `git merge-base --is-ancestor a96ab8ae2b 29b28b1f50` = ANCESTOR（**分支内**，不是对合并提交的祖先声明）；
   `a96ab8ae2b → 5feca2291b` 与 `29b28b1f50 → 5feca2291b` 均 **NOT-ancestor**。
2. 🔴 **那一次门审失手（Sealed-export 归因错误）逐条记在 §6.1**，此处不重复；结论口径是「**后手抓住的**」。
3. ⚠️ **草稿那条「TS-AST 我无法证实」的观察已翻转。** TS-AST 于 `c3a0a9441a` 落地并进入 main
   （`ts.createSourceFile` 在 `5feca2291b` 上可直接读到 `[执行]`）。**草稿的结论对其观测时点（`a48b447886`）成立，
   对当前 head 不成立**，不得被后续文档继承（`feedback_verify_against_current_main_not_stale_base`）。
4. ⚠️ **验证侧仍是 NOT RUN（AC-10）。** 见 §8.3：**已落地，但在读取基线与重锚后的 exact-main 两个 SHA 上都没有被任何收官车道判过。**

**结清之后新出现的 owner 裁决项（不是遗留，是这一轮产生的）** ⏳：
- **G-14 是否仍被满足。** 落地物把自己降级为 *"THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT
  BACKSTOP, NOT THE PRIMARY GUARANTEE"*，而 G-14 的已批准属性写的是「九处站点按精确集合断言 ⇒ 第十份副本会让普查变红」。
  **一个自认 best-effort、并逐条具名了 (a)–(j) 残留（其中 (i) 被评审现场复现且静默）的扫描器是否还承得起那句话，
  是 owner 裁决，不能自证**（`feedback_second_narrower_artifact_is_contract_narrowing`）。
- **残留 (j) 未经任何闸门审阅**（它是在 MERGE-CLEAN 之后加的）。
- **台账漂移** `[执行]`：`docs/development/approval-parity-execution-ledger-20260817.md` 的 Lock-7b 行
  （`5feca2291b` 上第 **114** 行）仍逐字写着 *"Implementation NOT STARTED and NOT authorized"*，
  而 **#5026 落地时没有为自己补一条台账行**（24 个改动文件中零个 `docs/`）⇒ **main 上的台账与 main 上的代码不一致。**
  本文只记录，不修（本文不开 PR）。
  🆕 **2026-08-21 freshness 更新：本条已 CLOSED（绑 `627945523b`，#5040）。** 上面这段在 `5feca2291b` 上逐字为真，
  作为历史观测保留；该漂移已由 #5040 结清（只改那一个 Residual 单元格，pipe 数不变 = 9）。逐条内容见 §11.1。
  ⚠️ **只关闭台账文本这一件事**：本 bullet 之上的两条 owner 裁决项（**G-14 是否仍被满足**、**残留 (j) 未经任何闸门审阅**）
  **一条未关闭** —— #5040 自己就把 G-14 逐字记为 *OPEN OWNER DECISION, not ruled here*；**AC-10 仍是 NOT RUN**。

### 9.2 V-14 的 PG14↔PG16 对照臂 —— **已跑完**，处置见 §4.2

- **结果**：66/66 套件双臂（Leg A 28/28、Leg B 38/38，零交叠、并集机械等于全 66 名单）、每臂 **574** 条测试、
  合计 **1148**、**0 failed / 0 skipped / DIVERGENT = 0**、逐条 test-name 集合两臂完全相同；
  同一 **319 条迁移**在两个大版本上以相同顺序 exit 0。
- **⚠️ 重锚后分母是 67**：#5026 新增了第 67 个 approval 真库套件，它只有 **PG16 单臂**证据 ⇒ **66/67**。
- **V-14 已在它自己点名的那条轴上解除**；收官 §6 的「零对照臂 / 35-of-66 / 部分兑现」措辞**作废**。
- **五条禁止过度声明的限制、以及「生产钉 PG15 而无任何 leg 或臂跑过 15」这条头号运营发现，全部逐字记在 §4.2。**
  **本节不复述，也不得被简写成「PG 大版本兼容性已被证明」。**
  🆕 **2026-08-21 freshness 更正（绑 `13506666dae3`，§11.3）：那条头号运营发现的后半「无任何臂跑过 15」已不成立** ——
  `postgres:15-alpine` 生产臂已跑完 67/67 套件、588 测试全通过。**前半（无任何 CI leg 在 PG15 上跑过 approval 真库套件）仍成立**，
  且被精确化（`smoke-verify.yml:11` 钉 `postgres:15` 但 dispatch-only / 非 required / 零 approval 套件；workflows 下 alpine 出现次数 = 0）。
  **五条禁止过度声明的限制一条未解除**，另换成该臂自己的六轴清单与三条附加禁令（§11.3）。
- **FS-8 两半均已完成 ⇒ 可关闭**；接替它的是 owner 排期的三选一（PG15 臂 / musl 臂 / CI 版本对齐）。
  🆕 **2026-08-21 freshness 更新（§11.3）：三选一中的 A + B 已一并兑现；只剩 C（CI 版本对齐）属 owner 排期。**
- **副产品**：`EXPECT_DB=1` 对 66 个套件中 41 个完全惰性——逐条记在 **§4.3**。

### 9.3 仍然悬着的，逐条 ⏳ **OWNER-PENDING**（本轮零推进）

- **Lock-9（PR #5011）**：**仍 OPEN、仍 DRAFT、§4 批准块五行全空**（重锚复核 `[执行]`：`state: OPEN`、
  `mergedAt: null`、`isDraft: false`）。**不得计入「已批准的锁文」。** 等 owner 裁 OD-L9-1 … OD-L9-14。
- **审批评论 D1 / D2 / D3 / D5**：D1 是结构性阻塞，其余在其下游。**本轮零推进。**
- **FWB 启用的五个 owner/ops 问题**：含 staging/生产 env 的实际内容、staging 是否已应用三个 FWB/outbox 迁移、
  **是否授权在生产开启 `AUTOMATION_DURABLE_DELIVERY_ENABLED`**、以及「durable 曾开后关时是否必须先清理/审计
  `meta_automation_outbox_consumer` 里的陈旧 pending 行（该声明无时间截止 ⇒ 全量重放）」。**本轮零推进。**
- **§8.2 的 20 行 OWNER-ONLY** 与 **§8.1 的 15 行 BLOCKED-ENV** 全部保持原状。
- **V-13（把审批车道加入必需检查集）**：仍 OWNER-ONLY。
- **唯一的 FAIL（FS-1）与 FS-3 / FS-4 / FS-7**：**全部保持原状，本轮一行未改。**

---

## 10. 本文档边界

### 10.1 完成标签与 flag

**三个完成标签全部 NO**（开发报告头部 @ `6cca7ec0ed`，即 #5009 更正之后）：`CORE-PARITY: **NO**` · `DATA-CLOSURE: **NO**` · `PRODUCT-FINAL: **NO**`，三者均需 owner 签署。**本轮没有任何标签被签署。**

**六个 flag 全部 OFF**，且开发报告 §1.4 表逐行为 `Staging observed: NOT RECORDED` / `Production observed: NOT RECORDED` / `Enable authorization: NO` / `Rollback verified: NOT RUN`（该表初值*"是策略断言而非环境观测，且整个程序期间无一次改动"*）。本轮在 `6cca7ec0ed` 上机械复核了代码内默认值：

| Flag | 锚点 | 默认 |
|---|---|---|
| `APPROVAL_FWB_WRITEBACK_ENABLED` | `packages/core-backend/src/multitable/approval-fwb-activation.ts:145-146`，docblock *"Runtime flag, default OFF"* | **OFF** |
| `AUTOMATION_DURABLE_DELIVERY_ENABLED` | `automation-durable-delivery.ts:20-21`，docblock *"Master gate for the whole P2 durable-delivery runtime. **Default OFF.**"* | **OFF** |
| `APPROVAL_ATTACHMENTS_ENABLED` | `apps/web/src/stores/featureFlags.ts:24`（*"D5, default OFF"*）+ 后端 `routes/approval-attachments.ts` | **OFF** |
| `APPROVAL_CANVAS_V2_ENABLED` | `packages/core-backend/src/services/approval-canvas-flag.ts:6`；FE `stores/featureFlags.ts:81` `approvalCanvasV2: false` | **OFF** |
| `AUTOMATION_CLASSA_CLAIM_ENABLED` / `AUTOMATION_CLASSB_OUTBOUND_ENABLED` | `automation-execution-ledger.ts:37-39` / `automation-outbound-intent.ts:63-65` | **OFF**（且**不在 FWB 执行路径上**） |

⚠️ §2#5 的欠账对以上全部适用：**无任何测试钉住 truthy-非-`'true'` 被拒**，而三个解析器都先 `.toLowerCase()`，故 **`'TRUE'` 会启用**——是否为预期**尚无人裁决**。

### 10.2 本文档是什么、不是什么

**这是一份验证记录，不是签署。** UAT（母本 §10 Canvas S1–S12、独立 FWB UAT、独立附件 UAT）、flag 的分级启用与回滚（P7-E）、以及三个完成标签，**全部是 owner-only，本轮一行未执行**。本文不授权任何运行时启用、任何部署、任何完成标签。

### 10.3 存放位置与引用效力

**本文与其所依据的台账、以及取代其 §6 的那份 V-14 裁决，均只在 scratchpad，不是 repo-of-record。** `git ls-tree` 于 `6cca7ec0ed` 确认以下文件在仓内**缺席**：`w4-verification-closeout-20260820.md`、`w4-closeout-L{1,2,3,4}-20260820.md`、`approval-comments-decision.md`、`fwb-enablement-runbook.md`、**`v14-pg-parity-verdict-20260820.md` 与两份车道报告 `v14-arms-opus-{A,B}-20260820.md`**，以及本文档本身。五份 Lock-7b 闸门 MD 位于 `/tmp`，同样非仓内且**均 head-scoped**。**任何引用它们的交付物必须声明这一点。**

### 10.4 本轮**未能**核实的事项（不得由本文补齐或推断）

1. **#5010 / #5016 / #5019 的门审 / 复核工件不存在**（`/tmp` 零命中）。其事后验证是 AC-5 / AC-6 行，**不是门审 MD**；不得给它们安 verdict。
2. **任何 verdict SHA → merge SHA 的祖先关系**：构造上不可能（**十一个**审批合入全是 squash）。唯一做过的是 #5023 rebase 的**内容等价**证明；其余各 PR 未做同类证明（因其 verdict SHA 就是最终 head）——⚠️ **#5026 是唯一的反向例外**：它的 verdict SHA `a96ab8ae2b` **不是**最终 head（最终 head 是 `29b28b1f50`），两者之间那一个提交**从未过闸**，本文也**未**为它构造内容等价证明（§9.1）。
3. **phase-A / phase-B 逐行证据文件是否曾以可恢复形式存在**：L2 与台账均报告 `scratchpad/p7-phase{A,B}-evidence-20260818.md` **确认灭失**（四次搜索零命中）⇒ L2 承接的两条优越性声明文本从仓内不可恢复。
4. **`approval-form-builder-mounted-harness.ts` 内 flow 步是否可达 / 画布是否真绘制**：台账 §2.3-2 与 §8.1 RC-1 均声明这是**源码读取结论，不是执行结论**，并点名为"动工前第一件事"。
5. **L2 / L3 的 Node / pnpm 版本**：*"报告未记录，不假设为 20"*。
6. ~~**任何 "TS-AST + carrier elimination" 实现**~~ —— **本条在重锚中作废并翻转**：TS-AST 已于 `c3a0a9441a` 落地，随 #5026 以 `5feca2291b` 进入 main（`ts.createSourceFile` 在 main 上可直接读到 `[执行]`）。**草稿的「不存在」结论对其观测时点（`a48b447886`）成立，对当前 head 不成立**，不得被后续文档继承。**接替它成为未核实项的是**：`29b28b1f50` 自述的「新抽取器与 `@vue/compiler-sfc` 在五个 `.vue` 文件上字节偏移完全相同」**本文未复算**，以及残留 (j) **未经任何闸门审阅**。
7. **合入是否用过 `--admin` 或任何绕过**：未核查。已核查的是 `efaa553d71` 与 `563fbb2772` 上的 check-run 全为 success / skipped。
8. **`563fbb2772` 之后是否本地重跑过 `bash apps/web/scripts/run-required-web-tests.sh`**：无任何工件晚于 10:44；只有合入头上的 CI `web-tests` + `approval-web-guard` success 顶替。
9. **台账 139 行总计与 L1–L4 四份车道表的独立重推**：本文读完了合并台账全文与四份车道头部，但**未**从四份车道表独立重新推导行数总计。台账自述了三处对车道的更正（§2.3-2、§9 两处），已逐条转录于 §3.4 / §3.5。
10. **`'TRUE'`（大写）启用 flag 是否为预期**：台账把它提为待裁决问题，**无人裁决**。
11. **2026-08-14 的 `strict=true` 记忆与实测 `strict:false` 孰是孰非**：台账记为线上漂移，成因未调查。
12. **#5024 门审工件的 §Residual 与 mutation-B 内容**：依该文件自带的处置约束与其 FINDING-1，**刻意不在本文复现**。
13. **线上 `server_version`**：`postgres:15-alpine` 是**仓内 compose 文件的文本断言**，**线上未亲查**（沙箱到不了部署主机），且 `DEPLOY_COMPOSE_FILE` 是可被 env 覆盖的默认值（§4.2）。
14. **这套真库 harness 对 PG 版本差异的灵敏度**：**无正控**，两条车道的负控只到连通性层 ⇒ 零差异的强度未知（§4.2 第 2 点）。
15. **第 67 个 approval 真库套件（`approval-lock7b-required-at-node.db.test.ts`）在 PG14 上的行为**：**从未跑过**（§9.2）。
16. **`29b28b1f50` 的字节偏移等价证明**：引自提交自述，**本文未复算**（§9.1）。

### 10.5 与 2026-08-18 两份报告的关系（一句话）

本轮**推进但未闭合**：P5-C 落地了子切片 **P5-C-1**（ledger `approval-parity-execution-ledger-20260817.md:60` 要求 *"mounted/browser/mobile/a11y"*，本 PR 只交付 **mounted**，且 **a11y 现在是空的而十个 a11y 属性已交付** ⇒ **该 ledger 行不能凭此证据关闭，PR 亦未修改该行**）；P3-A 落地**四族 / 五族**；D-10 原始 ID 渲染残留修了三个具名站点 + 两个新发现站点并把手写普查重建成机械模式扫描，但 **类本身未宣告闭合**（§6.4 D-10 明写 *"class 本身不宣告闭合"*，AC-5 逐字锁定作用域）。**§6.3 仍未开工的编码项**（Lock-2 剩余、L5-B 后加签 runtime / L5-E、K6 `sequential`、L6-B/C/D/E、L8-D `formula`）与 §6.4 的未闭合门审项（D-2、**D-3**、D-4、D-6、D-7、D-9、#4995 残留）**均未被本轮改变**，不得静默丢弃。

**重锚补记（一句）**：本轮另有一件 08-18 清单上没有的新工作落地——**Lock-7b 节点级必填（#5025 锁文 + #5026 实现）**，
它是本轮唯一一条从零到落地的新能力线。⚠️ **但它同样「推进而未闭合」**：v1 只在 handler 节点可满足，
验证行 **AC-10 仍是 NOT RUN**，**G-14 是否仍被满足是新产生的 owner 裁决项**，且**没有任何闸门绑定它实际落地的那个 head**（§9.1）。

---

## 11. 2026-08-21 freshness pass —— 定稿之后的三条落地物

> **纯增量。** 本节不重跑任何一行矩阵、不改任何一行的分层、不软化 §4.1 / §10 的任何一句诚实声明。
> **§1–§10 里的 `exact-main` 仍然、且仅仅是 `5feca2291b`。** 每条新增声明在开头具名它所绑的 SHA。

**锚点分层（四层，不得互相替换）：**

| 层 | SHA | 含义 |
|---|---|---|
| 读取基线 / 收官基线 | `6cca7ec0ed97732e05723f4c613557087395d022` | §3 的 127 行矩阵、四条隔离车道、真 Chromium、V-14 双臂全部发生在这里 |
| **重锚 head（= exact-main）** | `5feca2291b7405bc6be8160cab916ba80f7f9df6` | **§1–§10 每一处 `exact-main` 仍指这一个**，含 AC-10 的阻塞理由与 66/67 分母 |
| PG15-alpine 生产臂 run SHA | `13506666dae30dbeee1fb145392ff7ecfeb3e093` | **仅** §11.3 的数字绑它 |
| **freshness base** | `c473a079b5ff6389b98f4919bb88607a0baa913b` | 本 docs PR 的分支基点（`git rev-parse origin/main` 建支时亲取）；§11.1 / §11.2 绑它 |

**freshness 增量窗口：** `git log --first-parent 5feca2291b..c473a079b5` = **14 个 first-parent 提交** ——
审批相关 **4**（#5033 `c5a4a94f7f`、#5039 `13506666da`、#5040 `627945523b`、#5043 `545b3cadd1`）、
multitable **7**、attendance 与 ops **3**。⚠️ **§1 抬头的原窗口（23 提交 / 审批车道 11 个）不改。**

### 11.1 #5040 —— §9.1 的「台账漂移」条目 **CLOSED**（绑 `627945523b`）

§9.1 最后一条 bullet 把台账漂移记为 open。**该条现已关闭**：#5040 只改 Lock-7b 那**一个** Residual 单元格
（1 insertion / 1 deletion，pipe 数不变 = 9），写入两个合并 SHA、绑 pre-squash head `a96ab8ae2b` 的 MERGE-CLEAN 终裁、
逐字的 squash 纪律（*"ancestry … is NOT establishable by SHA"*）、squash 内**未经审阅**落地的 `29b28b1f50`、
落地 SHA 上的 post-merge requalification（CLEAN-at-landed-SHA + 3 条 P3，由 #5033 `c5a4a94f7f` 修复），
以及把 **G-14 逐字记为 OPEN OWNER DECISION, not ruled here**；两条残留仍是 **DISCLOSED, not closed**。
⚠️ **只关闭台账文本这一件事**：**AC-10 仍是 NOT RUN**（§8.3 不变），§9.1 的另两条 owner 裁决项
（G-14 是否仍被满足、残留 (j) 未经闸门审阅）**一条未关闭**。设计报告 §9.1 有逐条表。

### 11.2 #5043 —— Codex 第 4 轮评审结清（绑 `545b3cadd1`）

- **已落地（前端 / 模块层）**：requester-choice 的 **per-node 请求代次守卫**（乱序响应不再覆盖更新页）；
  `choiceConfirmedNames` 的**过期条目删除** + 移除「当前选中项豁免禁选」特例 ⇒ 被撤回确认的选项变为
  **可见但不可提交**；`directoryResolve` 的**有界、可取消、带延迟**退避（约 0/300/1500 ms）。
  该退避修复自身引入的**重试放大**与其 per-group 修复在**上一层重开的同类缺口**，均在同一 PR 内被后续轮次抓住并关闭，
  全部以 mutation 复证（`cp` + sha256 还原）。
- **⭐ 后端 identifiability 臂被中途撤回 —— 一次闸门抓住的契约保真挽救。**
  `validateAndFreezeRequesterChoices` 曾新增 `APPROVAL_REQUESTER_CHOICE_UNIDENTIFIED`（values-free）拒绝无名审批人；
  闸门判 **P1**：它**抵触已 RATIFIED 的 Lock-1 §K2 创建期契约**（*"company accepts any active local user"*），
  且**另外**收窄了只读 preview 面、制造了**错误码 oracle**、并因 **200-id resolver 上限**产生**假 422**。
  整臂**逐字节还原**到 `13506666da`；复证 = 真库套件回到 **13/13** 且 K2 fixture 用户全部重新无名
  （**只有在不存在任何 identifiability 拒绝时才可能通过**）。
  > **owner 开放项，逐字：** *"If this check is wanted, it needs an owner-authored §K2 amendment covering both create and preview before it lands again."*
- **普查守卫的诚实性收窄**：P2-2 修的是**守卫自己的 docstring**（原称 *"this rebuild closes"* 该失败类），
  收窄为 **known render patterns**、补入**具名的 helper-function canary 规避例（只文档化、未实现）**，
  并具名类级后续 = **统一 person-label 组件 + AST 级禁令**。**未新增扫描器。**
  ⚠️ **这不改变 §7 / §10.5 对 D-10 类的判定**：本报告此前的口径本来就是诚实的（*"类本身未宣告闭合"*，AC-5 逐字锁定作用域）——
  **#5043 让工件自述追平了报告口径，没有让这个类更接近闭合。**

### 11.3 `postgres:15-alpine` 生产臂（绑 run SHA `13506666dae3`）—— §1 与 §4.2 的两句 PG15 断言需在此处修订

**⚠️ §1 抬头表与 §1 一句话诚实版里的「PG15 从未被跑过 / PG15 在任何 leg 或任何臂上的执行未被确立」，
在 `5feca2291b` 上逐字为真，作为历史观测保留；截至本节所绑的 run SHA `13506666dae3`，它们已被下述结果取代。**

- **服务端亲证**：`select version()` = `PostgreSQL 15.19 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit`；
  镜像 = `postgres:15-alpine` @ `sha256:fe0737ba…e57f1b`，即三份部署 compose 所钉的同一 tag。
- **结果**：该 SHA 处 `approval-*` 真库套件清单已由 66 增至 **67**（新增件 = Lock-7b 的
  `approval-lock7b-required-at-node.db.test.ts`）；⚠️ **一处对该裁决的更正**：其 §2.1 括注把该新增件归给 #5004，
  **不成立** —— `git log --diff-filter=A` 显示它由 **#5026 `5feca2291b`** 首次加入，与本文 §1 / §4.2 的 66 → 67 计数一致。
  数字与结论不受影响。**67/67 全部执行**，
  **588 条测试全部通过、0 skipped、0 failed、0 pending、0 error**；**319 条迁移 exit 0**，迁移名单与 V-14 PG14 臂 diff 为空；
  66 个 V-14 可比套件的**逐套件已执行数与 V-14 双臂完全相同**（574 = 574）。
  ⚠️ **oracle 是「逐套件已执行数等势 + pass/fail + zero-pending」，不是逐条 test-name 集合同一性。**
- ⇒ **§10.4 第 15 条**（第 67 个套件在 PG14 上的行为从未跑过）**不变** —— 该臂跑的是 15，不是 14；
  lock7b 仍然**没有**跨大版本基线（该裁决把这条列为**新增的第 6 条残留**）。

**该裁决 §5 的处置逐字引用（不得改写、不得摘要）：**

> **不得写"approval 线在生产 PG 上的兼容性已被证明"，不得写"musl / collation 轴已关闭"，不得写"生产数据库版本已验证"。**
>
> 准确表述为 —— **V-14 残留清单的第 1 轴（PG15 从未被跑过）已关闭，第 3a 半轴（服务端 musl libc）已首次行使且行使出了一个可测的底座差异（`COLLATE "en_US.utf8"` 在生产镜像上不存在、musl 走 codepoint 序），而这 67 个套件对该差异全无反应；第 2 轴（灵敏度正控）、第 3b 半轴（x86_64 / 客户端架构）、第 4 轴（schema-diff，含未对账的 296 vs 301）、第 5 轴（重复轮，仅 1/67 达 n=2）四条仍未被触及，另新增第 6 条残留（lock7b 无跨大版本基线）。**
>
> 附加禁令三条：
> 1. **不得把 §3.4 的"零套件失败"写成"musl 差异无害"。** 已证的只有"这些套件不敏感"；"生产里无害"没有证据 —— 二者是两句话。
> 2. **不得声称本轮与 V-14 的逐条 test-name 集合相同。** 本轮 oracle 是**逐套件已执行数等势 + pass/fail + zero-pending**，没有跑 name-set diff（见 §2.4）。
> 3. **不得把 296 vs 301 写成"已确认无差异"或"已知无害"。** 准确态是**未对账**（§4 轴 4）。

**🆕 latent / CI-blind 前向风险（记录，不"修复"）：** 15-alpine 的 `pg_collation` **零条 libc `en_US.utf8` 行**
⇒ `COLLATE "en_US.utf8"` **在生产镜像上运行时报错**，却**通过全部 CI 臂与 V-14 四臂**（Debian glibc）；
且 `lc_collate` **名字相同、行为不同**（musl codepoint 序：`('a','B','b','A','z','Z')` → `A B Z a b z`；
`select 'a' < 'B'` 在 15-alpine 为 **false**、在 `postgres:14` 为 true）。
**latent**（仓内仅有的两处活 COLLATE 都是 `"C"`，均已执行通过）、**CI-blind**（该 SHA 处 workflows 下 alpine 出现次数 = **0**）、
**forward hazard**（新写一句会全绿合入、部署时才炸）。**不是活漏洞**，不改变 PASS 结论。

**对 §10.4 第 14 条的加强（不是解除）：** 「这套真库 harness 对 PG 版本差异的灵敏度：**无正控**」——
该臂的负控同样**只到连通性层**，且它给出的是**反向证据**：一个**真实存在**的底座差异（musl codepoint 序 vs glibc 词典序）
摆在那里，而这 67 个套件**全绿、毫无反应**。**这是关于该套件群对 collation 类差异不敏感的负面数据点，不是部分学分。**

**对本报告既有事实的一处更正（该裁决 §3.5）：** §1 与 §4.2 把「没有任何 CI leg 跑过 PG15」写成无条件句。
精确化后：`.github/workflows/smoke-verify.yml:11` 确实钉着 `image: postgres:15`（Debian glibc），
但它 **`workflow_dispatch` only、非 required check、不跑任何 approval 套件**；workflows 下 alpine 出现次数 = 0。
⇒ **准确表述 = 没有任何 CI leg 在 PG15 上跑过 approval 真库套件，也没有任何 CI leg 用过 alpine 镜像。**

⚠️ **线上 `server_version` 仍未亲查**（compose 的钉法是文件文本断言，不是行为断言）。

### 11.4 freshness pass **没有**改变的事

1. **V-1 仍是 NOT DISCHARGED**（§4.1 逐字不变）。本节零行 127 行矩阵重跑，**139 行分层计数不重推**。
2. **AC-10 仍是 NOT RUN**（§3.2 / §8.3）；解除条件不变。
3. **完成标签与 flag 全部不变**（§10.1：标签全 NO、flag 全 OFF）。
4. **§6.1 的十对 squash NOT-ancestor 与整套 squash 纪律**逐字不变。
5. **#5024 闸门工件的 §Residual 与 mutation-B 内容仍刻意不复现**（§10.4 第 12 条）——
   freshness pass **没有**扩大任何披露面。
6. **§7 的 36 行 PASS-POSITIVE-ONLY、§8.1 的 15 行 BLOCKED-ENV、§8.2 的 20 行 OWNER-ONLY、§8.3 的 5 行 NOT RUN**，
   本节一行未解除。§11.2 的 §K2 修订项是在 §9.1 之外**新增**的 owner 项，不是其中任何一行的替代。
7. **本节没有在 `c473a079b5` 上重跑任何验证、也没有在它上面重读任何 `[源读]` 锚点。**

---

*本节终。它记录三条晚到的落地物，不改变任何一行的验证分层。*

---

## 12. 2026-08-21 → 08-22 第二波 freshness pass —— 六 PR 的验证事实(与 §11 同规:分层追加,不重跑既有行)

**本段不重跑本文任何既有验证行;§1-§11 的全部 SHA 绑定原样成立。** 以下每行证据由其所属 PR 的独立
门审/复审代理在**隔离 detached worktree + 一次性 postgres:16** 中亲跑产生,判定绑 **pre-squash head**
(落地 squash 与之的祖先关系按房例不可由 SHA 建立);报告文件逐一具名。**本段没有任何一行是「上线判据」
——三个开关(org pin / attachments / durable-delivery 族)全部 OFF,无一行 UAT。**

### 12.1 判定链与电池数字(运行时 PR 逐门 mutation 实证;docs-only 的 #5078 为机械文本核——其门报自记「无守卫可 mutate」,不在「mutation 实证」口径内)

| PR(squash) | 终判(绑 head) | 关键电池 | 报告 |
|---|---|---|---|
| #5072(`25385331b8`) | MERGE-CLEAN@`7c16f33e3a` | 冻结 HI-1 扫描 Probe A 1 failed/12(反演恰好);census SCAN_ROOTS 13 条 triage 逐条对源码核真;Probe D 证豁免静默继承(→P3-A) | /tmp/s3a-requal-20260821.md |
| #5078(`dd7fa8630248`) | MERGE-CLEAN@`e621f147fe` | 逐字引用 cmp=IDENTICAL;additive word-diff 0 内容删除 token;五处锚点落点亲核;台账↔锁一致性逐行核(该门 item-6 表 9 行,其中 1 处失配 P3-B 已在绑定 head 前修复) | /tmp/s1-rulings-gate-20260821.md |
| #5070(`9fcccd69c3`) | round-3 MERGE-CLEAN@`f163ad708b` | S1 lane 48/48;真库全量 74 files/729 passed(CI 步骤逐字复现);8 mutations(M8 证 CC 臂放行非 blanket-admin;M13 证回归门;MP31-b 构造 500-vs-404 oracle);行级三表 parity 由 #5089 requal 补强;11 条 required 逐一 pass | /tmp/s1-gate-20260821.md + /tmp/s1-requal-20260821.md(3 轮同文件) |
| #5087(`b2b4198e01`) | MERGE-CLEAN@`2911e3e4a0` | 47/47 PG16 fresh db:migrate;P2-1 3-cell 矩阵(CHECK 在场红在 500、CHECK 移除红在 mentions 断言、单独移除 CHECK 绿→NIT);/history 双查询排除 mutation 双侧红;677 files/10191 no-DB | /tmp/s2-gate-20260822.md + /tmp/s2-requal-20260822.md |
| #5088(`1efebe9504`) | round-2 MERGE-CLEAN@`e7c5b29691` | MUT-D 红在 **id 断言**(offset-keyed mock;round-1 曾被队列位置型 mock+计数短路吞掉);MUT-A/C/R 三红;census 双向 set-equality+DECOY 正控;required web lane 394 files/5021;web-tests 无 paths 过滤亲核 | /tmp/s3b-gate-20260822.md + /tmp/s3b-requal-20260822.md(2 轮) |
| #5089(`f15b4252df`) | MERGE-CLEAN@`acff7eb754` | G-2..G-16 共 15 门重 mutation、其中 14 门载荷(M15/G-13 存活→P3-2 具名);G-1 正控缺失、无从 mutate(→P3-3);P2-1 关闭证据=双 boot(main vs head,flag 均未设)10-payload 三表快照 **sha256 同值 `8772e79d19fc…`** + 原始证伪 payload 复跑 400/400 同因;M1b 亲探证 NULL-safe CHECK 必要(字面 CHECK 在 SQL 三值逻辑下放行 form_field/NULL);Lock-9 真库 28/28 + 邻接 14 套件 197 passed | /tmp/lock9-gate-20260822.md + /tmp/lock9-requal-20260822.md(耐久副本:~/.claude/projects/<proj>/soak-working/) |

### 12.2 门审拦下后又被复审拦下的(纪律承重的新证)

- #5070:修复轮 1 的 requal 抓出 **P1-NEW**(required `test (20.x)` 红、PR 未披露、系「repo-wide grep 无其他处」被第四处证伪)——grep 自扫≠车道实跑,该句已在 PR body 撤回并换成车道证据。
- #5088:round-1 requal 抓出 **N-1**——修复自带的测试因 mock 队列位置型 + 计数断言前置短路而对 MUT-D 失明;round-2 换 offset-keyed mock 并将 id 断言前移后,MUT-D/MUT-E/MUT-OVL 全部红在 id 断言。
- #5089:门审抓出 **P2-1**(flag-OFF 下 reject/approve 带 rider 从 main 的 200 变 400——G-12(b) 的字面违背,且被自己的测试固化、PR body 标 ✅)——「fail-closed 且无客户端发该字段」不豁免 no-op 契约。
- 判读教训(已记 memory):`gh pr checks --json name,state` 会把 pending 读成全绿;判别一律 `--json name,bucket` + `mergeStateStatus`。

### 12.3 本段之后的「未验证」清单(防止本段被读成收尾)

阶段 3 `SET NOT NULL` 未落(G-S1-12 处于 PARTIAL,ratified 断言的 `is_nullable='NO'` 半边从未在任何库上跑过);
org pin 激活路径只在测试内 flag-ON 探过,无 staging/prod 证据;`APPROVAL_ATTACHMENTS_ENABLED` ON 的
端到端 UAT 为零(G 门是真库合成 fixture,非租户数据);G-S1-8(feed ⊆ admission)从未落地为绿测试
(expected-red,owner 行未裁);Lock-9 P3-2/P3-3 具名的两个门缺口(G-13 年龄混杂、G-1 正控缺失)在
本波结束时仍在。**S1 证据车道无 required 信号**(#5070 requal NIT-2 尖锐化):`approval-realdb-instance-readability-s1.yml` 非 required lane,且该套件不在 required `test (20.x)` 的 74 文件清单内——NEW-1 回归门、G-S1-12-PARTIAL 与全部谓词臂门只在非 required 车道有信号;即使 org pin 将来开启,这一车道缺口独立存在。V-1(§4.1)与 §7 的 36 行 PASS-POSITIVE-ONLY、§8 的 BLOCKED-ENV/OWNER-ONLY 清单
不因本段而减少。
