# Time Machine（Multitable Global History）— 余下开发 · 独立复核 · 剩余顺序规划（2026-07-12 第二轮）

> **性质**：owner `/goal`「审阅 timemachine 开发代码与目标文档；还有哪些未开发；规划剩余开发顺序；可并行开发，按难度选 Fable5/Sonnet5，Fable5 不可用则 Opus4.8；给出开发与验证 MD」一轮的交付。
> **与同日 `multitable-time-machine-remaining-dev-and-verification-20260712.md`（#4147 轮）的关系**：那份是首轮结论（自主 CI/文档池已清空）。本份是**再一次独立复核**（不采信任何未验证断言，含**不采信我自己上一轮的结论**），并**修正了两处认知**——(1) web-spec 覆盖的一处**我自己造成的假缺口**；(2) person 名称解析锁**已从 PROPOSED 变为 RATIFIED**，因此本线**并非「零未开发」**：#4161 是唯一在册的、已授权但未落地的开发项。
> **口径先行（如实，遵守收官措辞纪律）**：功能运行时面**大体闭合但并未全闭**——**owner 复审（2026-07-12）纠正了一处我漏报的 P1 运行时缺口**：**public-form（表单提交）EDIT 直接 `UPDATE meta_records` 写库、不写 record revision**（`univer-meta.ts:~14409`），因此 PIT/restore 重建会**漏掉真实的表单编辑**；对应设计锁 **#4187（D-1c）仍 OPEN/PROPOSED、无实现**。**故不能说「代码开发项全部落地 / 运行时已闭合」。** 其余已在 main：4c-1/4c-2/4c-3 + D-1 + D-6 + D-2（flag 默认 OFF）+ #4161 person 名称解析（已 MERGED，独立审 APPROVE）；CI 覆盖 realdb 43/43 + web 全覆盖。**未落地/未决**：#4187 public-form-edit revision（owner 决策=ratify 后实现 or 明确保留未完成）· O-2 运维启用 · staging 实跑取证 · 4d 见 §8。**这不是「这条线开发完了」。**

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

**处置与落地（更新，含 2026-07-12 闭幕审计 P2-2 自纠）**：**#4161 已 MERGED**（合并提交 `b674dba8c`，合并头 `bd14a541a`）。**⚠️ 我上一版把等价性写成「12 个文件逐字节相同、diff 为空、落后 5 提交不碰本 PR 文件」——这是错的，闭幕审计抓出并已在此更正**：`git log 656c36722..bd14a541a` 实为 **8 个提交（6 实质 + 2 merge）非 5**；`git diff` 该 12 文件**非空**——其中 **10 个 person-resolution 逻辑文件逐字节相同**，另 **2 个 CI 接线文件（`.github/workflows/plugin-tests.yml`、`packages/core-backend/vitest.config.ts`）有差异，且差异仅是 D-2/#4168 的无关白名单行**（`multitable-d2-sidedoor-delete-recoverability-realdb.test.ts`）。**person-resolution 逻辑零 delta** ⇒ gate verdict（APPROVE 0P1/0P2）对落地的逻辑内容仍实质成立；但「diff 为空 / 不碰本 PR 文件」的措辞是伪证，已撤。
> ⚠️ **治理注（如实）**：#4161 由**平行 zensgit session 的 auto-merge** 合入（`armed/merged_by=zensgit`），**绕过了 owner 显式 GO** 那一步——与今日 #4168 同型。owner 裁决保护的**实质**（合并内容须过独立审）**已满足**（落地逻辑 = 所审逻辑，10 逻辑文件逐字节相同、2 CI 文件仅差 #4168 无关行）；但**显式「审后 owner GO」的程序**被自动合入跳过。**我全程没碰 #4161、没 arm、没合**。head-scoped 纪律：合并头≠所审头时**必须**验 rebase 等价——我先前**误报**了这个验证（写成「diff 为空」），闭幕审计的独立复核才是准的。

## 5. 余下开发与顺序规划（含模型分派）

> 前提：本线**无未 gated 的新功能开发**。下表是**已授权项的落地顺序**与**门后项的执行顺序**（一旦 owner 解锁）。模型按难度分派：Fable5/Sonnet5 优先，Fable5 不可用→Opus4.8；**对抗/设计 gate 恒用 Opus**（[[feedback_model_split_policy]]）。

| # | 项 | 门 | 谁解锁 | 顺序 & 模型 |
|---|---|---|---|---|
| 1 | **#4161 person 名称解析** | 锁 RATIFIED；独立对抗审 APPROVE 0P1/0P2；**已 MERGED `b674dba8c`**（rebase of 所审头：10 逻辑文件逐字节相同，2 CI 文件仅差 #4168 无关白名单行）| — | **① Opus 对抗审 = APPROVE（完成）→ ② 平行 session auto-merge 合入（绕过显式 owner GO，实质经审内容满足）→ 剩：可选 NIT（error 对称性硬化，Sonnet 小切片，owner 定夺）**。**唯一代码路径已落地** |
| 2 | **O-2 运维启用**（`TOMBSTONE_CAPTURE`→`RECORD_UNDELETE_INBOUND`→`PIT_UNDELETE`；retention；**D-2 的 L3.5 侧门可恢复=产品语义变更，owner 单独确认**） | 部署 host env，**非 CI 可设**；代码默认 OFF（「线上是否 OFF」是外部环境状态，代码审阅不核验） | **owner/operator** | 阶梯 L1→L2→L3→L3.5（见 o2-ladder 决策就绪材料 + R11 收官 MD）。**非编码任务**；若需 staging smoke 工具=Sonnet 小切片。⚠ 激活值 footgun：capture/replay 用 `'true'`，retention 用 `'1'` |
| 3 | **4d：已删字段列的值级恢复**（**口径已按源码更正，见 §8**） | 部分**已实现**（capture ON 时未来字段删除可恢复值/链接/自动编号）；**仅** pre-capture / 已过期数据不可恢复 | 已实现部分随 4c-2 capture flag；不可恢复部分=物理边界 | 无新开发（更正的是台账口径，非代码） |

**并行性**：#4161 是单一小切片（读路径、无 flag），**内部无并行拆分空间**；其 gate（Opus 审）与本 MD 起草**已并行**。O-2 是 ops 决策，不占编码并行槽。故本轮真正可并行的只有「审 + 文档」两股，已在跑。**没有可继续 fan-out 的编码工作**——如实报告，不制造并行以显得繁忙。

## 6. 验证台账

| 断言 | 证据 |
|---|---|
| 运行时面在 main 已闭合（含今日 D-2） | #4004 RATIFIED `30228a935`（owner，main 祖先确认）+ #4168 MERGED；flag `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED` 代码/.env*/CI 三处默认 OFF |
| realdb CI 覆盖 43/43 | 逐个对照 `plugin-tests.yml` 白名单；唯一「不在」的是 mock 辅助模块（非测试） |
| **7 个 `*-migration` web spec 已在 required gate 执行**（纠正我的假缺口） | vitest 位置 filter = 路径 substring；`run-required-web-tests.sh` 与 `multitable-web-guard.yml` 带裸 `migration` token；`vitest run migration` → 48 文件/256 测试全绿，7 个目标全在其中 |
| #4059 四决策全落 R11 | #4124/#4120/#4117/#4119 均 MERGED |
| #4161 锁已 RATIFIED、实现已授权 | 锁 `:1,3` = RATIFIED 2026-07-12（owner）；OD-P1=A / OD-P2=carry+render / OD-P3=no-flag（`:10-12,58-60`） |
| #4161 已 MERGED（`b674dba8c`） | 独立审 APPROVE 后经平行 session auto-merge 合入（治理注见 §4）；合并头 `bd14a541a` = 所审 `656c36722` 的 rebase：10 逻辑文件逐字节相同，2 CI 文件仅差 #4168 无关行（§4 已自纠先前「diff 为空」误报） |
| 无未 gated 新功能开发 | 逐条复核 4 个历史「疑似残留」全不成立（首轮 MD §2，本轮复用其 file:line）；死代码扫描零命中；覆盖已满 |
| #4161 gate 结论 = APPROVE 0P1/0P2 | Opus 独立对抗审 @656c3672；OD-P2 render 金测 + LOCK-3 G3 均 mutation-confirmed load-bearing 且 CI-gated；真跑全绿（FE 26/26+63/63、realdb 5/5+6/6、tsc/vue-tsc exit 0）；报告 `/tmp/pr4161-person-resolution-gate-review-claude-20260712.md` |

## 7. 收官口径（如实）

- **功能运行时面大体闭合但并未全闭**（owner 复审 P1 纠正）：#4161（person 名称解析）独立对抗审 APPROVE 0P1/0P2、已 MERGED（`b674dba8c`；合并头 = 所审头 rebase，10 逻辑文件逐字节相同、2 CI 文件仅差 #4168 无关行——见 §4 自纠）——⚠️经平行 session auto-merge 合入、绕过 owner 显式 GO（治理注见 §4）。**但本线仍有一个已知未落地的运行时缺口**：**public-form EDIT 不写 record revision**（`univer-meta.ts:~14409`；设计锁 **#4187 OPEN/PROPOSED 无实现**）⇒ PIT/restore 会漏掉表单编辑。**因此「代码开发项全部落地」是错的（我上一版误报，已改）。** 准确表述：**除 #4187 一个未决/未实现的运行时缺口外，其余代码项已落地并过独立审**；#4187 的解决=owner 决策（ratify 后实现，或明确保留为未完成）；production 启用（O-2，含 D-2 L3.5 产品语义变更）与 staging 取证与 4d（§8）均在 owner-ops 门后；「线上是否 OFF」是本文未核验的外部环境状态。
- 本轮相对首轮的两处更正已如实记录：(a) web-spec 覆盖的假缺口是我的 basename 检索误报，实测 7 spec 早在跑；(b) person 锁已 RATIFIED，池非空。**（owner 补充第三处更正见 §8：4d「值级恢复不可能」的旧口径不精确。）**
- **不 arm auto-merge、不开任何 env flag、不自合。**

## 8. 4d 口径更正（owner P2，2026-07-12，按源码逐条核对）

首轮/本轮早前把 **4d = 已删字段列的值级恢复** 一律写成「不可能 / 永不承诺」——**不精确**。源码事实（`packages/core-backend/src/routes/univer-meta.ts` `recreateFieldFromConfig`，4c-2 R1）：

- **capture flag（`MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`）开启后发生的字段删除，其 undelete 会 rehydrate**：① 列值（**仅**写入尚无该 key 的记录——**绝不覆盖** recreate 之后写入的新值）② 链接边（**仅**在两条当前均存活的记录之间）③ 自动编号序列的 `next_value`。锚定由字段删除 revision 自身的 id（`deleteRevisionId`）界定，不误取同 id 的更早/更晚 capture。
- **真正不可恢复的只有两类**：(a) **capture flag 曾经开启之前**被销毁的数据（无 tombstone，`recreateFieldFromConfig` 退化为 pre-4c-2 的 **definition-only** 重建，C1 forward-only）；(b) tombstone 已按 retention **过期**老化的数据。
- 因此**精确口径**：4d **不是**「值级恢复不可能」，而是「**pre-capture 或已过期**的字段列值级恢复不可能；**capture 开启后**的未来字段删除**可**值级恢复（值/链接/自动编号）」。这是物理边界（无捕获即无源），不是未开发的功能。
- **同源纠正**：#4147 台账（`multitable-time-machine-remaining-dev-and-verification-20260712.md` §5）与本 MD 早前版本的「4d 永不承诺」措辞，**均以本 §8 为准**；#4147 作为历史记录保留、其 4d 行以此指针更正。

## 9. R12 Closeout 轮（owner /goal「完成上条信息的开发」，2026-07-12）

owner 复审给出 5 项 finding + A–E 收尾计划。**完成判据（owner 明定）= 代码与台账一致 · operator 工具不误报 · staging 全链路有证据 · 生产开关仍逐项审批**——**不是**「所有 flag 上生产」。本轮我方交付 A/B/C/E(文档面) + D(runbook)，**staging 实跑与浏览器证据=owner/ops 门**（部署 host env + 全栈，本会话不可达）。

| 子项 | 内容 | 本轮处置 | 模型 |
|---|---|---|---|
| **R12-A** 落地 #4161 | person 名称解析上 main | **已完成**：MERGED `b674dba8c`；OD-P1/P2/P3 均在 origin/main 实证（`HistoryBatchChangesList.vue:196` inactive marker 渲染；history-projection personNames/fieldTypes）；对抗审 APPROVE。残留旧注释→R12-B | Opus gate |
| **R12-B** 工程加固 | G17 定时 sleep→确定性 barrier（正控证伪）· #4004 OD-7 两/三层措辞 · production-status 外部可验证边界 · #4161 旧「person hidden no-op」注释 | **Draft PR（Sonnet lane，进行中）** — 折入见下 | Sonnet impl + Opus gate |
| **R12-C** O-2 operator-contract | 单一 flag manifest（激活值/依赖/危险级，逐条 `// source:` 溯源）· status helper 展示全部 flag + `--strict` 拒绝非法组合（lossy 无 base / side-door 无 capture / PIT-reset 撞 retention）· 依赖矩阵测试 · 修 o2-ladder 文档 | **Draft PR（Sonnet lane，进行中）** — 折入见下 | Sonnet impl + Opus gate |
| **R12-D** staging 顺序验收 runbook | 见下方顺序 | **runbook 已写（本 §9.1）**；**实跑=owner/ops** | — |
| **R12-E** 收官证据 + AS-BUILT | 本 MD 即 AS-BUILT 主文；浏览器/API 证据 | 文档面本 MD；**浏览器/API 实证=owner/ops（需全栈+staging）** | — |

**combo 规则均来自源码（非文档，避免继承漂移）**：lossy 双门 `lossy-retype-oracle.ts:isLossyRetypeRevertEnabled` · side-door 需 capture `side-door-delete-trash.ts:130 isSideDoorTombstoneCaptureEnabled = sideDoor && capture` · PIT-reset 撞 retention `univer-meta.ts:10276 PIT_RESET_RETENTION_BLOCKED = RETENTION_ENABLED==='1'` · retention 激活值 `'1'` 非 `'true'` `meta-revision-retention.ts:60`。

### 9.1 R12-D staging 顺序验收 runbook（**串行**，execution = owner/operator）

> 每级：先跑 `node scripts/ops/multitable-global-history-flag-status.mjs --strict`（R12-C 交付后可拒非法组合）→ 开该级 flag → 跑验证 → 记证据。**Retention 最后单独决定，不与恢复能力顺手一起开。**

| 级 | 开启 | 验证 |
|---|---|---|
| 0 | 全关基线 | 所有 flag OFF；helper 全绿；恢复类响应形状 = 现状 byte-identical |
| 1 | lossless sheet config revert / retype（`SHEET_CONFIG_REVERT`；`FIELD_RETYPE_REVERT` 仅无损） | 无损 revert 生效；无值销毁 |
| 2 | tombstone capture（`TOMBSTONE_CAPTURE_ENABLED='true'`） | 删被引用记录→`meta_link_tombstones` 出 `reason='record_delete'` 组；trash 行带 `delete_revision_id` |
| 3 | config undelete 补水 + inbound replay（`CONFIG_UNDELETE`、`RECORD_UNDELETE_INBOUND='true'`） | 恢复记录→`inbound.replayed≥1`；邻居单元格重现；字段 undelete 补水值/链接/自动编号（§8） |
| 4 | PIT undelete / reset（`PIT_UNDELETE='true'`；`PIT_RESET`——**须确认 retention 仍 OFF**，否则 STOP-SHIP） | revert-execute confirm='undelete'→`undeleteInbound`；reset 受 `PIT_RESET_RETENTION_BLOCKED` 保护 |
| 5 | config uncreate / permission revert（`CONFIG_UNCREATE`、`PERMISSION_REVERT`） | 对应恢复面生效 |
| 6 | lossy retype（`FIELD_RETYPE_REVERT_LOSSY='true'` **且** base 已开——**双门**） | 有损 revert 走 loss-oracle + 413 cap；base 未开时 helper `--strict` 拒绝 |
| 7 | side-door delete（`SIDE_DOOR_DELETE_TRASH_ENABLED='true'`，**前置 capture 已开**；**D-2 产品语义变更，owner 单独确认**） | automation/plugin 删被引用记录→进回收站、`inboundEdgesRecoverable:true`；restore 后邻居重现；机器删除自此可被任何 `canDeleteRecord` 者恢复、restore 重放事件——**须确认可接受** |
| — | **retention（`META_REVISION_RETENTION_ENABLED='1'`，注意值是 `'1'` 非 `'true'`）** | **最后单独决定**；与 `PIT_RESET` **互斥**（撞则 reset STOP-SHIP）；地板-A 增长风险回 owner 桌面 |

### 9.2 台账去重（doc-drift 处置，owner R12-E「旧台账只保留历史指针」）

现存三份「余下开发」文档：#4147（merged，§5 4d 口径已被本 §8 更正）· 本 #4186（AS-BUILT 主文）· **#4185 已 MERGED（`d52d7ba59`，15:45Z）**——平行 session 的「remaining-development inventory」竞品**已在 main 上**（闭幕审计 P2-3 自纠：先前写成「armed，将落」，实为已合）。**本 MD（#4186）拟为 R12 AS-BUILT 权威**；#4147/#4185 保留为历史。⚠️ **漂移已实际发生（非假设）**：main 上现并存 #4147 + #4185 两份 remaining-dev 台账，加本 #4186 共三份——**建议 owner 指定唯一权威、把另两份降为指向它的历史指针**（这是 owner-decision，我不擅自改已合并文档）。

### 9.3 R12-B / R12-C lane 交付 + 独立 Opus 对抗审 gate（均完成）

| lane | Draft PR | 独立 Opus gate 结论 | 关键实证 |
|---|---|---|---|
| **R12-B** 工程加固 | **#4197**（draft） | **APPROVE-with-fixes → fixes 已折并推** | G17 barrier 正控**独立复跑**：neuter `ensureRecordNotLocked` → 50ms 内 **assertion 红**（非 timeout/hang）；barrier 经 iteration-counter 证非空、`pg_blocking_pids`↔自身 pid 相关不会误配、5000ms 有界超时、raw client 恒 `finally` 释放；full file 38/38。OD-7 三层措辞 + 每层 goldens（G3 / G18+G15 / G16）一致且通过；production-status 边界勘误准确。gate 抓出 **P3-1**：R12-B「found exactly one」漏了**第二条**present-tense stale 注释（`multitable-history-person-names-realdb.test.ts:120`「does NOT actually hide」= #4165 后**假**）+ NIT-1（line 76 `(G4 tripwire)`）——**我已修两处并推**（sweep 确认无第三条） |
| **R12-C** O-2 operator-contract | **#4199**（draft） | **APPROVE 0 P1 / 0 P2** | 4 条 combo 规则**均源码独立复核**：lossy 双门（`lossy-retype-oracle.ts:105`）· side-door 需 capture（`side-door-delete-trash.ts:130`）· PIT-reset 撞 retention（`univer-meta.ts:10276`，真实行 = `PIT_RESET_RETENTION_BLOCKED` 常量；brief 的 10264 与我先前误写的 10275 都错，闭幕审计 P3-1 已纠）· retention 激活 `'1'` 非 `'true'`（`meta-revision-retention.ts:60`）；18 flag 全含、2 个无关 flag 正确排除；32/32 + mutation（删 lossy `dependsOn` → 4 红）；`--strict` 三类非法组合**双模式**拒 + 具体违规名；`retention='true'` footgun 正确判 OFF（advisory，非假 STOP）。**bonus**：修了旧 helper 测试的一个**假阳**（旧 heuristic 把 `RETENTION='true'` 误判为触发 PIT_RESET stop，而源码需精确 `'1'`）——这是 manifest 修真实 footgun 的最硬证据 |

### 9.4 待 owner 定夺 / 收尾项（如实，不自行拍板）

- **R12-C P3（owner call）**：manifest 把 `side-door 未配 capture` 定为**硬 STOP**。gate 溯源发现该组合**代码上合法但降级**——trash 行无条件写、记录仍可恢复，**仅** inbound 边捕获需双 flag。你 R12-C 指令**明列**「side-door 未配 capture」为要拒的组合 ⇒ 当前 STOP **符合你的意图**；gate 建议降为 `--strict`-only WARN。**二选一请你定**（prose 已准确标「降级非损坏」）。
- **R12-C 两个 P3（低风险收尾）**：① `flagEnabled`/`TRUE_VALUES` 现为运行时死代码（易误导后来读者）建议删/注；② helper 两个测试仅 `node --test` 本地、无 CI workflow 亦无 `verify:*:test` npm script（与兄弟 ops helper 不对等）——ops 只读工具，可接受但建议补 npm script。**均可留作 fix-forward，不阻断。**
- **PR 状态（闭幕审计 P2-4 自纠——先前误写「两 PR 均 Draft」）**：**#4197 已 Ready**（我按你对 #4197 的 APPROVE + 「rebase+green 即可合」武装了 `--auto`，落地中——这是你对 **#4197** 的显式 GO，**不**代表 #4199/#4186 的 GO）；**#4199 仍 Draft**（等你 GO 再转 Ready）；**#4186 本身仍 Draft、最后落地**。合前顺手 rebase。
- **R12-B head-scoped 说明（对自己套用同一纪律）**：gate 的 APPROVE-with-fixes 判在 head `50c4b93a`；我随后推的 P3-1/NIT-1 修复使 head 前移=**技术上 gate 之后**。但该 commit **恰是 gate 要求的两处 comment-only 修复本身**⇒ verdict 是被**满足**（apply the fixes），非被推翻；comment-only、零 runtime 字节，**无需重跑 gate**。（对比 #4161：那是**平行 session** 移了 head 需验 rebase 等价；这里是**我按 gate 自身指令**应用修复。）
- **R12-D staging 实跑 + R12-E 浏览器/API 证据 = owner/ops 门**（部署 host env + 全栈，本会话不可达）。runbook（§9.1）已备；实跑与证据归档由你/operator 执行。

### 9.5 R12 完成判据对账（owner 明定）

| 判据 | 状态 |
|---|---|
| 代码与台账一致 | ⚠️→✅ 4d 口径按源码更正（§8）；**闭幕审计（§10）抓出并修正了本 MD 自身多处伪证/过时**（byte-identical 误报、#4185 已合、两 PR Draft、line-cite）+ o2-ladder 文档已修；#4147 §5 以 §8 为准（历史指针；§10 列出的 merged-doc 内联指针 = owner-decision）；person/D-2 状态已同步（§4/§9） |
| operator 工具不误报 | ✅ R12-C helper 展示全部 **19** flag（补 `SHEET_REVERT_MAX_RECORDS`）+ `--strict` 拒非法组合 + **源码派生完整性测试（非重言，mutation-proven）** + **接 required CI** + 修了旧假阳；o2-ladder 文档已指向 manifest 为单一真源；gate **APPROVE-with-hardening**（§10） |
| staging 全链路有证据 | ❌ **未满足**：目前**无** staging/API/browser 实跑证据。仅**执行准备完成**（runbook §9.1）；**runbook ≠ 证据**（owner 复审 P2 纠正）。实跑取证 = owner/ops（本会话不可达 staging），本判据在证据归档前**保持未满足** |
| 生产开关仍逐项审批 | ✅ 零 flag 翻转；**#4197 Ready（你对 #4197 的显式 GO）落地中；#4199/#4186 仍 Draft 待你 GO**；D-2 L3.5 明标产品语义变更需单独确认 |
| **运行时全闭** | ❌ **未满足**：#4187 public-form EDIT + attachment-delete 两条路径不写 revision（§10 P2-1）= owner ratify 决策 |

**收官口径**：R12 代码/文档面本会话已交付并各过独立对抗审（B=#4197 APPROVE-with-fixes 已合；C=#4199 经 owner REQUEST-CHANGES→修 5 项→重审 **APPROVE-with-hardening**，见 §10）；**闭幕审计（§10）又抓出本 MD 自身的伪证/过时并已自纠**。**staging 实跑 + 浏览器/API 证据 + 生产启用 + #4187 ratify = owner 门**，非本会话可完成。**不是「全做好上生产」，也不是「运行时全闭」**（#4187 缺口在册）——是「可自动化的开发与验证已完成且过独立审 + 闭幕审计，其余逐项待你」。

## 10. Owner REQUEST-CHANGES 轮 + 闭幕审计（2026-07-12 第二遍）

> owner 对 R12 首轮下了 REQUEST-CHANGES（#4199 + #4186），并逐项判：#4197 APPROVE。随后我又跑了一轮**独立闭幕审计**（Opus×3 workflow）复核本 MD 自身。两者的结果如下——**§9.3 首轮 lane 表以本节为准**（#4199 已从 18→19 flag 且经二次重审）。

### 10.1 owner 5 项 finding → 已修（#4199）→ 二次独立重审 = APPROVE-with-hardening

| owner finding | 修法 | 二次 gate |
|---|---|---|
| **P1 #4186 误称运行时闭合** | 撤回「代码开发项全部落地」；#4187 public-form-edit 缺口记为已知未落地（§1/§7/§10.3） | — |
| **P2 #4199 漏第 19 个 flag** | 补 `MULTITABLE_SHEET_REVERT_MAX_RECORDS`（`restore-caps.ts:15,17-19`；caps 退型/表撤/reset/undelete 记录数上限） | ✅ 19/19，MISSING=[]/PHANTOM=[] |
| **P2 CONFIG_UNDELETE 语义过时** | 改为 tombstone-gated rehydration（`univer-meta.ts:6469`，与 §8 一致），非「definition-only」 | ✅ 逐行核对 |
| **P2 完整性测试重言（硬编码同表）** | 改为**源码派生**（grep `packages/core-backend/src` + 显式 denylist）；**mutation 证伪**：删一 flag → 测红「MISSING」 | ✅ 独立复跑 mutation |
| **P2 32 测未进 CI** | 接入 **required `test` job**（`plugin-tests.yml`，node 18/20，无 pnpm/DB 依赖，早失败）+ npm script | ✅ docker node:18 复跑 32/32 |
| **wording：side-door 无 capture** | 改称「operator rollout-policy STOP / degraded recoverability」（非 code-illegal），两模式恒 STOP | ✅ |
| **（新）o2-ladder 文档未修**（审计 P2-5，本是 R12-C 声称的交付） | 修 line 15 lossy 误标 + line 100 4d 过时口径 + 加 manifest 单一真源指针（19 flag） | 文档，随 #4199 |

二次 gate（Opus 独立）= **APPROVE-with-hardening，0 P1/0 P2**；4 个 NIT（line-anchor 溯源、both-modes 措辞、denylist 前缀注、micro）已折入。报告 `/tmp/pr4199-r12c-fix-gate-review-claude-20260712.md`。

### 10.2 闭幕审计（Opus×3）抓出**本 MD 自身**的伪证/过时 → 已自纠

| 审计 finding | 我原来的错 | 已改 |
|---|---|---|
| **P2-2** rebase 等价性 | 「12 文件逐字节相同、diff 为空、落后 5 提交不碰本 PR」 | **伪证**：实为 8 提交(6 实质)、10 逻辑文件相同 + 2 CI 文件仅差 #4168 无关行（§4 自纠） |
| **P2-3** #4185 | 「armed，将落 stale 竞品」 | **已 MERGED** `d52d7ba59`（§9.2 自纠） |
| **P2-4** PR 状态 | 「两 PR 均 Draft」 | **#4197 已 Ready**（§9.4 自纠；#4197 Ready=你对它的 GO，非 #4199/#4186 的 GO） |
| **P3-1** PIT-reset line-cite | §9 写 10264、§9.3 写 10275（自相矛盾） | 均 → **10276**（§9/§9.3 自纠） |
| **NIT-1** side-door line-cite | §9 :131 vs §9.3 :130 | 统一 **:130** |

审计判定：这些自纠后，**本 MD 无结构性阻断**，可作为 AS-BUILT 落地（仍待 owner GO，最后落）。

### 10.3 🔒 OWNER-DECISION：#4187 uncaptured-revision 缺口（含新发现的第二条路径）

审计的 #4187 blast-radius 复核（独立确认到源码站点）：**两条**已认证用户内容 EDIT 路径写 `meta_records.data` + version 但**不写** `meta_record_revisions`：
1. **form-submit EDIT**（`univer-meta.ts:14423`；owner 首轮指出）
2. **attachment-delete record edit**（`univer-meta.ts:15693`；**闭幕审计新发现的同类第二条**，应并入同一 ratify 决策）

**Blast radius**（owner ratify 用）：live 读面永远正确；但所有 snapshot 重建面（PIT view T7 / restore-preview·execute / revert / PIT-Reset，均汇于 `reconstructRecordsAtT` record-reconstructor.ts:34）在窗口内返回**编辑前**快照；History Center 时间线/diff（`history-projection.ts`）**永远看不到**该编辑（审计不可见）；且 restore/reset 落在窗口内会**静默丢弃**该编辑并当作忠实回档呈现。窗口在**下一次常规编辑**时自愈（afterImage 折入 live `previousData`），但若表单编辑是该记录**最后一次写**则**永不自愈**。可达性：认证成员 + `canEditRecord` + 提交已存在 recordId；**非匿名/公开**（public 调用在 ~14198 被 400 挡）；**无 env flag**。**严重度：P2**（永久审计缺口 + PIT 谎报 + 真实的静默 restore-丢失向量；缓解=live 数据不丢 + 下次编辑自愈）；若 form-share 编辑既有记录被推广、或 restore/PIT-Reset 面向终端用户，则**升 P1**。**我不实现**（#4187 设计锁 OPEN/PROPOSED 未 ratify=红线 #1）；修法（owner 授权后）= 两站点在同 txn 补 `recordRecordRevision(source:'public-form', action:'update', 全 afterImage + changedFieldIds + patch)`，镜像 `record-write-service.ts:998`。审计确认其余 9 处 `UPDATE meta_records` 均非缺口（派生值/系统表/已被 config-revision+tombstone 捕获）——缺口**精确界定为这两条**。

### 10.4 🔒 OWNER-DECISION：已合并/冻结文档的旧「4d 永不承诺」措辞（注解，勿改写）

审计全仓扫出旧 overbroad 口径的残留，**均为已合并的 point-in-time 记录或冻结设计锁**，按「勿改写历史，只注解」doctrine 处置（owner 定）：
- **#4147 台账 line 94**（4d row）：同文 §5 的 D-2 行已有内联更正标记，4d 行没有 → 建议补一行内联指针（「口径已按源码更正，见 #4186 §8」）。**注解**，非改写。
- **4c-2 设计锁 line 100**（「4d(不可能项)」）：冻结 ratified 锁；4c-2 R1 恰是使 forward 值恢复成立的机制，措辞自相矛盾但在窄读（4d=retroactive/pre-capture）下可辩护。**留或注解**。
- **NIT 批**：r11-closeout / destruction-path gap-audit(20260708) / parallel-round(20260705，早于 4c-2) / 4c1·4c3·d1 锁的 scope-exclusion——point-in-time + 窄域冻结，**按 doctrine 保留**。live 真值已由 #4186 §8 + #4199 manifest + o2-ladder 承载。
