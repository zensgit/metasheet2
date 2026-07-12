# Time Machine（Multitable Global History）— 余下开发 · 独立复核 · 剩余顺序规划（2026-07-12 第二轮）

> **性质**：owner `/goal`「审阅 timemachine 开发代码与目标文档；还有哪些未开发；规划剩余开发顺序；可并行开发，按难度选 Fable5/Sonnet5，Fable5 不可用则 Opus4.8；给出开发与验证 MD」一轮的交付。
> **与同日 `multitable-time-machine-remaining-dev-and-verification-20260712.md`（#4147 轮）的关系**：那份是首轮结论（自主 CI/文档池已清空）。本份是**再一次独立复核**（不采信任何未验证断言，含**不采信我自己上一轮的结论**），并**修正了两处认知**——(1) web-spec 覆盖的一处**我自己造成的假缺口**；(2) person 名称解析锁**已从 PROPOSED 变为 RATIFIED**，因此本线**并非「零未开发」**：#4161 是唯一在册的、已授权但未落地的开发项。
> **口径先行（如实，遵守收官措辞纪律）**：功能运行时面**已完整**（4c-1/4c-2/4c-3 + D-1 + D-6 + D-2 全在 main，flag 默认 OFF）；CI 覆盖**已完整**（realdb 43/43 + web 全覆盖，含 7 个 `*-migration` spec）；**唯一的代码开发项 = #4161 person 名称解析**（锁 2026-07-12 RATIFIED，实现已授权，正在过独立对抗审 gate）；其余全部是 **owner-ops 门**（O-2 运维启用 / 4d 值级恢复=不可能红线）。**这不是「这条线开发完了」。**

## 1. 方法

对 `origin/main` 只读审计（Sonnet 广度 survey + Opus 独立对抗审 gate + 我逐条 primary-source 实证）。
**canonical 工作树被平行 session 污染（403 staged files）且落后 main**——全程从 `origin/main` 经 `git show` 读，改动在**独立 worktree** `/tmp/ms2-tm-md`（off origin/main）里做，不碰 canonical。
**关键纪律**：不采信文档头部、不采信 memory、不采信上一轮 MD 的结论——每条断言都回到 `git show origin/main:<file>` 或真跑。

## 2. 线的现状（primary-source 复核）

R11（2026-07-11）+ 今日 D-2 落地后，运行时面在 main 上已闭合：

| 层 | 落地物 | flag |
|---|---|---|
| 读面（PIT view / History Center / diff / 反查） | 全链 write→read→render 无孤儿列（`restored_from_version` / `batch_id` / `delete_revision_id` 三列均已审） | — |
| 4c-2 forward tombstone capture | `meta_field_value_tombstones` + `meta_link_tombstones`，capture-before-destroy | `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` OFF |
| 4c-1 lossy retype revert | full-read gate + 三桶 loss-oracle + HMAC lossHash + 413 cap + per-cell 记录 revision | `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` OFF |
| 4c-3 record-undelete inbound replay | Option-A 邻居同意；A′ vintage-exact 锚（#4117）；#4059 四决策全落 R11 | `MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND` OFF |
| D-1 delete-revision parity | automation/plugin-SDK 侧门删除写 delete revision（PIT-as-of-T 不再谎报存活） | 无 flag（纯正确性） |
| **D-2 侧门删除可恢复性（今日）** | #4004 锁 owner RATIFIED；#4168 runtime MERGED（trash + tombstone parity，双 flag 嵌套，运行时 fail-closed 拒非事务/schema 缺失/超 cap） | `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` OFF |
| R9/R10/R11 UX·CI·金测增量 | TM+ 恢复轮 + 反查回链 + all-tables-B masked fieldNames + 地板-A + TrashModal 双层过滤 | — |

**#4059 四决策全部落 R11**（复核）：#4124 restore 回链 · #4120 field-value tombstone 地板-A · #4117 A′ vintage-exact 锚 · #4119 all-tables-B masked `fieldNames`。**均 MERGED。**

## 3. CI 覆盖独立复核（本轮实质内容）

### 3.1 realdb 真库测试：43/43 全部在 CI 白名单（无缺口）

`packages/core-backend/tests/integration/` 下 Time Machine 相关真库测试文件 **43 个**，逐个对照 `plugin-tests.yml` 白名单：**43/43 命中**（唯一「不在 CI」的 `config-revision-mock.ts` 是 mock 辅助模块、非测试文件，正确排除）。**上一轮 #4147 补入的 `multitable-history-before-hydration-realdb.test.ts` 现已在白名单**（✅ 复核确认）。

### 3.2 web spec 覆盖：完整 —— 并修正**我自己上一轮引入的一处假缺口**

- **我的初查错误**：按**精确 basename** 检索三处 gate（required `run-required-web-tests.sh` + `multitable-web-guard` + `approval-web-guard`），把 7 个 Time Machine `*-migration.spec.ts` 标成「❌ ZERO GATE」。
- **实证纠正**：**vitest 位置参数是对文件路径的 substring 匹配，不是 basename 精确匹配**。`run-required-web-tests.sh` 与 `multitable-web-guard.yml` 都带一个**裸 `migration` token** ⇒ 它 substring-匹配并运行**全部** `*-migration.spec.ts`。独立子代理两处实证：(i) 隔离 scratch repro（vitest 1.6.1，pinned 版）证明 `migration` filter 命中 `*-migration.spec.ts`；(ii) 真库 clean worktree 跑 `vitest run migration` ⇒ **48 文件 / 256 测试全绿**，7 个目标 spec 全在其中（JSON reporter 文件清单确认）。
- **结论**：7 个 `*-migration.spec.ts` **早已在 required gate 里执行且通过**，**无需接线**（接了是 CI 噪音）。其中 2 个（`history-center-modal-migration`、`trash-modal-migration`）经 repo-wide grep 证实是其按钮 wiring 的**唯一** DOM 级证明（siblings 只测 composable，不 mount 组件）——但它们**已在跑**，所以是「覆盖已确认」，不是「待接线」。
- 2 个 `spreadsheet-cell-version*` spec = **legacy Univer 单元格版本**，与 multitable Time Machine 无关，**out of scope**。
- **教训已入 memory**：审「某 spec 在不在 gate」时，除精确 basename 外必须查其路径含的任何 substring/catch-all token（`migration`/`multitable`/…），并**真跑 filter 看收集集**，别只对 token 清单推理。

## 4. 唯一在册的授权开发项：#4161 person diff before-side 名称解析

**这是本轮相对首轮 MD 的最重要更正**：person 名称解析设计锁在 main 上**已从 PROPOSED 变为 RATIFIED（2026-07-12 owner）**，实现授权**已授予**。因此本线**存在**一个已授权、未落地的开发项。

**锁的裁决（`…person-before-side-name-resolution-design-lock-20260711.md`，RATIFIED）**：
- **OD-P1 = A**：服务端 `personNames` 随批次详情下发（`loadHistoryBatchDetail`），复用 `resolveUserDisplayNames`（与 `actorName` 同源），单一真源、**零新端点**，与 all-tables-B `fieldNames`（#4119）同构。
- **OD-P2 = 携带 `inactive` 且必须渲染标记**：map 值 = `{ display, inactive? }`（**非**裸 string）；停用用户在 diff 里**必须仍可见且渲染出停用标记**。**锁明文警告**：「携带但不渲染」会让只断言 payload 的测试全绿却违反裁决 ⇒ **必须有金测钉住 `inactive:true` 的 userId 在 DOM 里渲染出标记**，不是只在 payload 里带 `inactive`。
- **OD-P3 = 无 flag**：只读目录元数据，与 `fieldNames`/`actorName` 同级。
- **wire 增量两项**：`personNames`（OD-P2 形状）+ `fieldTypes`；两侧 shape-lock。

**当前状态**：PR #4161 OPEN @ `656c36722`（平行 session 交付，先前 606 行 runtime），auto=OFF。**实现授权 ≠ 当前 head 合并授权**——owner 明确：需**独立对抗审 + wire shape-lock 两侧同步**后才可合。

**独立对抗审 gate 结论：APPROVE — 0 P1 / 0 P2**（Opus adversarial-reviewer，refute-first，逐条对 PR-head 全文源 + 真跑，报告 `/tmp/pr4161-person-resolution-gate-review-claude-20260712.md`，scoped @ `656c3672228be7493912c7e41fc2a5e35fc5ffb1`）。锁标出的两处 trap-prone guard 各由**一个 mutation-confirmed、CI-gated 金测**钉住：

| 门 | 结论 | mutation 证据 |
|---|---|---|
| **OD-P1 = A** | PASS：`personNames` 在既有 `loadHistoryBatchDetail` 下发（零新端点），只从 **post-mask** `changes` 里 allowed `type='person'` 字段收集，`resolvePersonDirectoryEntries` 复用 `users` 目录（与 `actorName` 同源），单查询无 N+1 | — |
| **OD-P2 = carry + render** | PASS：map 值 `{display, inactive?}` 两侧一致；**inactive 用户渲染出停用标记** | **neuter `inactivePersonDisplay` ⇒ DOM 金测恰按锁警告的形态变红**（`'…deactivated'` 不再出现、removed person 仍可见）；该金测在 **required `web-tests` gate** 里跑，非仅本地 |
| **OD-P3 = no flag** | PASS：该路径 grep `process.env`/flag = 零 | — |
| **wire shape-lock** | PASS：`personNames` + `fieldTypes` 在服务端投影/FE 类型/组件 props 三处一致；realdb 钉 `fieldTypes` keys === `fieldNames` keys（同一 masked 集） | — |
| **权限安全 (LOCK-3)** | PASS：realdb G3（layer-3 denied）+ G4（layer-2 hidden）**整体断言** masked 用户的 **id 与 name 均不出现** | **G3 mutation-confirmed**：改为从 raw 未掩码 snapshot 收集 ⇒ `personNames[P_SECRET]` 泄漏、G3 变红 |

**真跑（throwaway worktree @ PR head，fresh PG + 全量迁移）**：FE `…inline-diff` 26/26 + person/field-display 回归 63/63；realdb `…person-names` 5/5 + `…alltables-fieldnames` 6/6；`tsc` + `vue-tsc -b --force` 均 exit 0；源码无 `any`。

**一个 NIT（非阻断，作者已在码内自评 P3-1）**：`resolvePersonDirectoryEntries` 对非 `42P01` 错误 rethrow，而同端点的 `resolveUserDisplayNames`（actorName）吞掉所有错误——故 `users` 特定的瞬时故障可能 500 掉 history-detail 视图而非降级到 raw id。**安全上 fail-closed（永不泄名）**，与 parity sibling `buildPersonSummaries` 一致，锁只要求 table-absent 情形优雅降级（已处理）。可选对称性硬化（Sonnet 小切片），留作 owner 定夺；保持现状可接受。

**处置**：gate PASSED + 两侧 shape-lock 已验 ⇒ **#4161 已达 landing-ready**。但 owner 明确「实现授权≠当前 head 合并授权」⇒ **保持 OPEN / 不 arm / 不自合，等 owner 一句 GO**。合入前顺手 rebase（当前落后 main 5 个提交，均不碰本 PR 文件、G4 依赖的 #4165 layer-2 修复已在 head 内，落后属**良性**）。

## 5. 余下开发与顺序规划（含模型分派）

> 前提：本线**无未 gated 的新功能开发**。下表是**已授权项的落地顺序**与**门后项的执行顺序**（一旦 owner 解锁）。模型按难度分派：Fable5/Sonnet5 优先，Fable5 不可用→Opus4.8；**对抗/设计 gate 恒用 Opus**（[[feedback_model_split_policy]]）。

| # | 项 | 门 | 谁解锁 | 顺序 & 模型 |
|---|---|---|---|---|
| 1 | **#4161 person 名称解析** | 锁已 RATIFIED，实现已授权；**独立对抗审已 APPROVE 0P1/0P2** | **owner GO 合入**（仅剩这一步） | **① Opus 对抗审 gate = APPROVE（已完成）** → ② 无阻断 finding；一个可选 NIT（error 对称性硬化，Sonnet 小切片，owner 定夺）→ ③ **owner GO 后 rebase+合（不自合、不 arm）**。**这是唯一的代码路径，现已 landing-ready** |
| 2 | **O-2 运维启用**（`TOMBSTONE_CAPTURE`→`RECORD_UNDELETE_INBOUND`→`PIT_UNDELETE`；retention；**D-2 的 L3.5 侧门可恢复=产品语义变更，owner 单独确认**） | 部署 host env，**非 CI 可设**；代码默认 OFF（「线上是否 OFF」是外部环境状态，代码审阅不核验） | **owner/operator** | 阶梯 L1→L2→L3→L3.5（见 o2-ladder 决策就绪材料 + R11 收官 MD）。**非编码任务**；若需 staging smoke 工具=Sonnet 小切片。⚠ 激活值 footgun：capture/replay 用 `'true'`，retention 用 `'1'` |
| 3 | **4d：已删字段列的值级恢复** | **红线，永不承诺**（无 tombstone 可依） | — | 无开发 |

**并行性**：#4161 是单一小切片（读路径、无 flag），**内部无并行拆分空间**；其 gate（Opus 审）与本 MD 起草**已并行**。O-2 是 ops 决策，不占编码并行槽。故本轮真正可并行的只有「审 + 文档」两股，已在跑。**没有可继续 fan-out 的编码工作**——如实报告，不制造并行以显得繁忙。

## 6. 验证台账

| 断言 | 证据 |
|---|---|
| 运行时面在 main 已闭合（含今日 D-2） | #4004 RATIFIED `30228a935`（owner，main 祖先确认）+ #4168 MERGED；flag `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` 代码/.env*/CI 三处默认 OFF |
| realdb CI 覆盖 43/43 | 逐个对照 `plugin-tests.yml` 白名单；唯一「不在」的是 mock 辅助模块（非测试） |
| **7 个 `*-migration` web spec 已在 required gate 执行**（纠正我的假缺口） | vitest 位置 filter = 路径 substring；`run-required-web-tests.sh` 与 `multitable-web-guard.yml` 带裸 `migration` token；`vitest run migration` → 48 文件/256 测试全绿，7 个目标全在其中 |
| #4059 四决策全落 R11 | #4124/#4120/#4117/#4119 均 MERGED |
| #4161 锁已 RATIFIED、实现已授权 | 锁 `:1,3` = RATIFIED 2026-07-12（owner）；OD-P1=A / OD-P2=carry+render / OD-P3=no-flag（`:10-12,58-60`） |
| #4161 当前 head 未获合并授权 | owner：实现授权≠当前 head 合并授权，需独立审 + 两侧 shape-lock；PR OPEN @656c36722 auto=OFF |
| 无未 gated 新功能开发 | 逐条复核 4 个历史「疑似残留」全不成立（首轮 MD §2，本轮复用其 file:line）；死代码扫描零命中；覆盖已满 |
| #4161 gate 结论 = APPROVE 0P1/0P2 | Opus 独立对抗审 @656c3672；OD-P2 render 金测 + LOCK-3 G3 均 mutation-confirmed load-bearing 且 CI-gated；真跑全绿（FE 26/26+63/63、realdb 5/5+6/6、tsc/vue-tsc exit 0）；报告 `/tmp/pr4161-person-resolution-gate-review-claude-20260712.md` |

## 7. 收官口径（如实）

- **功能运行时面已闭合、CI 覆盖已满**——**唯一的代码开发项 #4161（person 名称解析）独立对抗审已 APPROVE 0P1/0P2、已 landing-ready，但按 owner 裁决尚未获当前 head 合并授权，故未落地**。因此**不能说「这条线开发完了」**；准确表述是：**#4161 一个已授权小切片已过独立审、待 owner 一句 GO 即可合；除此之外功能面无新的未 gated 开发；其余全部需 owner 动作（O-2 运维启用 / 4d 红线）**。
- 本轮相对首轮的两处更正已如实记录：(a) web-spec 覆盖的假缺口是我的 basename 检索误报，实测 7 spec 早在跑；(b) person 锁已 RATIFIED，池非空。
- **不 arm auto-merge、不开任何 env flag、不自合。** #4161 的合入以 owner GO 为唯一前置。
