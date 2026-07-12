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

**处置与落地（更新 2026-07-12 15:17Z）**：**#4161 已 MERGED**（合并提交 `b674dba8c`）。合并头 `bd14a541a` = 我审的 `656c36722` 的**纯 rebase**——12 个 person-resolution 文件**逐字节相同**（实证：两头对这些文件的 diff 为空），落后的 5 个提交是 D-2（#4168）等 main 增量、不碰本 PR 文件 ⇒ **gate verdict（APPROVE 0P1/0P2）对落地内容实质成立**，落地代码 = 我独立审过的代码。
> ⚠️ **治理注（如实）**：#4161 由**平行 zensgit session 的 auto-merge** 合入（`armed/merged_by=zensgit`），**绕过了 owner 显式 GO** 那一步——与今日 #4168 同型。owner 裁决保护的**实质**（合并内容须过独立审）**已满足**（byte-identical rebase of the approved head）；但**显式「审后 owner GO」的程序**被自动合入跳过。**我全程没碰 #4161、没 arm、没合**；这是 head-scoped verdict 纪律的一次实践——合并头≠所审头时**必须**验 rebase 等价（已验），不能让旧 verdict 默认平移。

## 5. 余下开发与顺序规划（含模型分派）

> 前提：本线**无未 gated 的新功能开发**。下表是**已授权项的落地顺序**与**门后项的执行顺序**（一旦 owner 解锁）。模型按难度分派：Fable5/Sonnet5 优先，Fable5 不可用→Opus4.8；**对抗/设计 gate 恒用 Opus**（[[feedback_model_split_policy]]）。

| # | 项 | 门 | 谁解锁 | 顺序 & 模型 |
|---|---|---|---|---|
| 1 | **#4161 person 名称解析** | 锁 RATIFIED；独立对抗审 APPROVE 0P1/0P2；**已 MERGED `b674dba8c`**（纯 rebase of 所审头，byte-identical）| — | **① Opus 对抗审 = APPROVE（完成）→ ② 平行 session auto-merge 合入（绕过显式 owner GO，实质经审内容满足）→ 剩：可选 NIT（error 对称性硬化，Sonnet 小切片，owner 定夺）**。**唯一代码路径已落地** |
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
| #4161 当前 head 未获合并授权 | owner：实现授权≠当前 head 合并授权，需独立审 + 两侧 shape-lock；PR OPEN @656c36722 auto=OFF |
| 无未 gated 新功能开发 | 逐条复核 4 个历史「疑似残留」全不成立（首轮 MD §2，本轮复用其 file:line）；死代码扫描零命中；覆盖已满 |
| #4161 gate 结论 = APPROVE 0P1/0P2 | Opus 独立对抗审 @656c3672；OD-P2 render 金测 + LOCK-3 G3 均 mutation-confirmed load-bearing 且 CI-gated；真跑全绿（FE 26/26+63/63、realdb 5/5+6/6、tsc/vue-tsc exit 0）；报告 `/tmp/pr4161-person-resolution-gate-review-claude-20260712.md` |

## 7. 收官口径（如实）

- **功能运行时面已闭合、CI 覆盖已满**——**唯一的代码开发项 #4161（person 名称解析）独立对抗审 APPROVE 0P1/0P2，已 MERGED（`b674dba8c`，纯 rebase of 所审头、byte-identical，gate 实质成立）**。⚠️但它由平行 session auto-merge 合入、**绕过了 owner 显式 GO**（治理注见 §4）。**至此本线的代码开发项全部落地**；但**仍不能说「这条线全做好了」**：production 启用（O-2，含 D-2 L3.5 产品语义变更）与 4d 红线均在 owner-ops 门后，且「线上是否 OFF」是本文未核验的外部环境状态。准确表述：**代码面无剩余未 gated 开发（#4161 已落地并过独立审）；余下全部需 owner 动作。**
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

**combo 规则均来自源码（非文档，避免继承漂移）**：lossy 双门 `lossy-retype-oracle.ts:isLossyRetypeRevertEnabled` · side-door 需 capture `side-door-delete-trash.ts:131 isSideDoorTombstoneCaptureEnabled = sideDoor && capture` · PIT-reset 撞 retention `univer-meta.ts:10264 PIT_RESET_RETENTION_BLOCKED = RETENTION_ENABLED==='1'` · retention 激活值 `'1'` 非 `'true'` `meta-revision-retention.ts:60`。

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

现存三份「余下开发」文档：#4147（merged，§5 4d 口径已被本 §8 更正）· 本 #4186（AS-BUILT 主文）· **#4185（平行 session，armed，我不可控——将落一份 stale 竞品**，见下）。**本 MD（#4186）为 R12 AS-BUILT 唯一权威**；#4147 保留为历史。⚠️ **#4185 未受本轮 partition 约束**，若先合入会与本文并存造成漂移——**建议 owner 择一为准并把另一份降为指针**。

### 9.3 R12-B / R12-C lane 交付 + 独立 Opus 对抗审 gate（均完成）

| lane | Draft PR | 独立 Opus gate 结论 | 关键实证 |
|---|---|---|---|
| **R12-B** 工程加固 | **#4197**（draft） | **APPROVE-with-fixes → fixes 已折并推** | G17 barrier 正控**独立复跑**：neuter `ensureRecordNotLocked` → 50ms 内 **assertion 红**（非 timeout/hang）；barrier 经 iteration-counter 证非空、`pg_blocking_pids`↔自身 pid 相关不会误配、5000ms 有界超时、raw client 恒 `finally` 释放；full file 38/38。OD-7 三层措辞 + 每层 goldens（G3 / G18+G15 / G16）一致且通过；production-status 边界勘误准确。gate 抓出 **P3-1**：R12-B「found exactly one」漏了**第二条**present-tense stale 注释（`multitable-history-person-names-realdb.test.ts:120`「does NOT actually hide」= #4165 后**假**）+ NIT-1（line 76 `(G4 tripwire)`）——**我已修两处并推**（sweep 确认无第三条） |
| **R12-C** O-2 operator-contract | **#4199**（draft） | **APPROVE 0 P1 / 0 P2** | 4 条 combo 规则**均源码独立复核**：lossy 双门（`lossy-retype-oracle.ts:105`）· side-door 需 capture（`side-door-delete-trash.ts:130`）· PIT-reset 撞 retention（`univer-meta.ts:10275`，真实行，brief 的 10264 已漂移、manifest 记的是真实行）· retention 激活 `'1'` 非 `'true'`（`meta-revision-retention.ts:60`）；18 flag 全含、2 个无关 flag 正确排除；32/32 + mutation（删 lossy `dependsOn` → 4 红）；`--strict` 三类非法组合**双模式**拒 + 具体违规名；`retention='true'` footgun 正确判 OFF（advisory，非假 STOP）。**bonus**：修了旧 helper 测试的一个**假阳**（旧 heuristic 把 `RETENTION='true'` 误判为触发 PIT_RESET stop，而源码需精确 `'1'`）——这是 manifest 修真实 footgun 的最硬证据 |

### 9.4 待 owner 定夺 / 收尾项（如实，不自行拍板）

- **R12-C P3（owner call）**：manifest 把 `side-door 未配 capture` 定为**硬 STOP**。gate 溯源发现该组合**代码上合法但降级**——trash 行无条件写、记录仍可恢复，**仅** inbound 边捕获需双 flag。你 R12-C 指令**明列**「side-door 未配 capture」为要拒的组合 ⇒ 当前 STOP **符合你的意图**；gate 建议降为 `--strict`-only WARN。**二选一请你定**（prose 已准确标「降级非损坏」）。
- **R12-C 两个 P3（低风险收尾）**：① `flagEnabled`/`TRUE_VALUES` 现为运行时死代码（易误导后来读者）建议删/注；② helper 两个测试仅 `node --test` 本地、无 CI workflow 亦无 `verify:*:test` npm script（与兄弟 ops helper 不对等）——ops 只读工具，可接受但建议补 npm script。**均可留作 fix-forward，不阻断。**
- **两 PR 均 Draft**：等你 GO 再转 Ready + 合。R12-B 修复后 head 已前移；合前顺手 rebase。
- **R12-D staging 实跑 + R12-E 浏览器/API 证据 = owner/ops 门**（部署 host env + 全栈，本会话不可达）。runbook（§9.1）已备；实跑与证据归档由你/operator 执行。

### 9.5 R12 完成判据对账（owner 明定）

| 判据 | 状态 |
|---|---|
| 代码与台账一致 | ✅ 4d 口径按源码更正（§8）；#4147 §5 以 §8 为准（历史指针）；person/D-2 状态已同步（§4/§9） |
| operator 工具不误报 | ✅ R12-C helper 展示全部 18 flag + `--strict` 拒非法组合 + 修了旧假阳；gate APPROVE |
| staging 全链路有证据 | 🧭 runbook 已备（§9.1）；**实跑证据 = owner/ops 执行**（本会话不可达 staging） |
| 生产开关仍逐项审批 | ✅ 零 flag 翻转；两 PR Draft 待 owner GO；D-2 L3.5 明标产品语义变更需单独确认 |

**收官口径**：R12 代码/文档面 A/B/C/E(文档)/D(runbook) **本会话已交付并各过独立对抗审**（B=APPROVE-with-fixes 已修，C=APPROVE 0P1/0P2）；**staging 实跑 + 浏览器/API 证据 + 生产启用 = owner/ops 门**，非本会话可完成。**不是「全做好上生产」**——是「可自动化的开发与验证已完成且过审，生产启用逐项待你」。
