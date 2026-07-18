# Time Machine W0 「built-to-trust」 — 开发与验证 MD（最终版，2026-07-17 更新）

**这是 owner /goal「完成所有开发，完成后给出开发及验证 MD」的交付物。** 结论先行：

> **W0 信任基底（L3→L6-a）+ L5-wire 激活入口 + L4-cov-services 服务写者围栏已全部合入 main；恢复权威链（L6-b→L7→L8，含 P1 token 合约 + pre-wiring gate items）已全部建成、独立对抗门禁通过，作为 held Draft PR 栈等待 owner。** 所有 flags 保持 default-OFF；`RECONSTRUCTION_CAUSALITY_LANDED` **held `false`**（owner 裁决：flip 留给未来接线 Revert/Reset 的同一 PR）；未 arm 任何东西。剩余未完成项只有一类：**owner 的接线 + flip + 启用决策本身**（见 §5）。

## §0 授权基础（ratified basis）

**#4331 v3.7 §9 七项建议**（owner-ratified 设计基础；ratification 只授权 **default-off 实现切片** —— 不授权 strict/Revert/Reset 启用、host 变更、staging 切换或生产 rollout）：
1. **可执行锚点**：仅 committed history batch/event；**禁止自由挂钟时间的破坏性执行**。
2. **手动日期时间**：只读近似导航（`reconstructRecordsAtT` 保留为 display 用途）。
3. **世代**：**target-generation A**（锚点所在世代的状态，非 terminal-only）。
4. **围栏**：保留 auto-number key，泛化为 canonical sheet-state fence；canonical → PIT 锁序。
5. **执行**：围栏内完整 target/schema/set 重算 + 预览校验。
6. **批次终点**：**sealed operation ledger** —— server-minted、sheet-scoped、单事务组；exact `anchorSeq` 冻入签名身份。
7. **Bigint**：string/bigint 端到端；**测试禁止 mutate 生产序列**。

**owner 二审（2026-07-17）追加两条 P1 硬阻断（已实现，见 §3）**：token 必须绑 `mode`；权限/schema-drift 是内核裁决非路由松散。

**owner UN-FLIP 裁决（2026-07-17）**：不要仅凭 `MULTITABLE_HISTORY_CONTIGUITY_STRICT=UNSET` 就合原栈；`RECONSTRUCTION_CAUSALITY_LANDED` 保持 `false`，flip-to-true 留给「legacy Revert/Reset 真正接入 L8 的同一 PR」（backstop 移除 + 其消费者 = 一个 reviewable change）。#4417/#4445/#4446 继续 held。

## §1 信任模型（v3.7 exact-anchor，一段话版）

放弃挂钟时间 T 作为恢复权威（`created_at` 是 txn-start，非 commit 序 —— C2 类错误的根源）。信任链为：**opaque `anchorOperationId`（sealed operation endpoint，L6-a）或 History-Center `historyBatchId`→server 解析的 sealed 终末 operation（MAX `endpoint_seq`）→ 不可变 `endpoint_seq` = exact `anchorSeq`（共享因果 bigint 序 `meta_record_chain_seq`，L3）→ 覆盖该锚的 trust checkpoint（`trusted_since_seq ≤ anchorSeq`，L5）→ HMAC 签名预览身份（绑定 anchorSeq/checkpointId/scopeHash/liveSetHash/mode/authorizedScopeHash/actor/sheet）→ 围栏内执行（L4 all-writer fence + L8 单事务 apply，token-bound anchorSeq，绝不重算 `MAX(seq)`）**。因果性只在全体写者围栏 + checkpoint 截断此前历史时成立 —— 但**此因果重建路径尚未成为破坏性恢复权威**：`RECONSTRUCTION_CAUSALITY_LANDED` held `false` 直到接线 PR，strict-on 对每张表（含 checkpoint-bearing）仍 fail-closed 拒绝。

## §2 已合入 main 的信任基底（每层：完整 required CI + 独立对抗门禁）

| 层 | 内容 | merge SHA |
|---|---|---|
| **L3** | 因果 `seq` 域（共享 bigint 序列迁移 + backfill-非信任语义）+ loud marker + strict 世代感知 contiguity precheck（gen-0 hole 修复）| `cc35b2599` (#4339) |
| **L4** | canonical per-sheet write fence（保留 auto-number key；fence-before-check；durable writer-block 状态机无卡死吸收态）+ recovery-vs-recovery 双向闭合 | `502b1df1c` (#4346) |
| **L4-cov** | univer-meta/records/auto-number 写者族全围栏 + **owner 复审抓获的真 P1**（forward field-delete 无围栏）修复 + B6/B7 mutation-proven | `f2020509a` (#4362) |
| **L5** | trust checkpoint（激活/选择/保留；非伪造 `system_kind`；最新 vintage by 因果 seq；unattributable trash 中止激活；anchor-covering retention 地板；strict-enablement precondition 无条件拒绝接线）| `5b0ccf791` (#4347) |
| **L6-a** | sealed operation-endpoint ledger（`meta_record_history_operations`；DEFERRABLE FK；endpoint 校验/UPDATE-拒/DELETE-拒触发器；H1/H2/H3 owner 硬化；batch_id 与 operation_id 永久解耦）| `2f456571e` (#4409) |
| **L5-wire** | trust-checkpoint 激活路由（`activateCheckpoint` 的生产 caller）+ M1/M2 fail-closed（无围栏铸造 torn baseline 的持久工件拒绝）+ 持久双连接并发激活 golden | `ab43b3869` (#4447) |
| **L4-cov-services** | 4 服务写者类上 canonical fence（automation actions/writeback/formula/approval-projection）+ deferred plugin **D-1 delete → H1-DELETE 实现矩阵**（owner 指令闭环）+ retention-GUC transaction-local（G1/G2 P3-R）+ **formula TOCTOU v2**（引擎内 fenced txn）| `9048c27e2` (#4438) |
| **GF8-ON** | formula 引擎 fenced-txn 内非-block 失败**传播**（`FormulaFencedWriteError`，B6 abort failed:true）+ flag-ON golden（trigger 真注入进引擎事务，per-record 零提交/保留/未执行语义）| `3e21f6d13` (#4451) |

历史注记：L3-L6a 本轮曾被 owner 三轮对抗复审证伪（4 P1 + 2 P2，含 L3 gen-0、可伪造 system 身份、任意 trash vintage、retention 删除必要 checkpoint 等），全部根修后重新门禁再合入 —— 上表即修复后的最终状态。

## §3 建成 + 门禁通过 + HELD 的恢复权威栈（Draft PR，等待 owner）

**栈拓扑（restacked onto main `3e21f6d13`，2026-07-17）**：#4417（base main）⊂ #4445（base #4417）⊂ #4446（base #4445）。三分支按文件最终态重构，使**栈底 #4417 自身满足 seam=false 不变量**（即便被 squash-merge 也不带 flipped 态）；tree-diff vs 线性 rebase tip = 空（内容等价）。**独立对抗门禁在重排后 exact-head 复跑 = 三个全 CLEAR（0 P1/0 P2）。**

### R4 = L6-b：exact-anchor 恢复解析 + 因果重建器 + P1 token 合约（#4417，head `93f00a822`）
- **因果重建器** `reconstructRecordsAtSeq`（`seq <= $::bigint`，DISTINCT ON seq DESC，LOCK-9 delete-aware，世代正确 —— MULTI-GEN golden 证明锚点在第 1 世代时重建到 G1 状态）；`created_at` 路径保留为只读导航。
- **解析/执行权威** `resolveExactAnchor`/`executeExactAnchorRecovery`：挂钟请求 `exact-anchor-required` 拒绝（DB 读之前，no-oracle）；未知锚/无覆盖 checkpoint fail-closed；execute 只用 **token-bound anchorSeq，绝不重算 MAX(seq)**。
- **P1-1 token 绑 mode**（owner 二审）：签名 claims 增 `mode`（revert|reset）+ `authorizedScopeHash`；`anchorBatchId`→`anchorOperationId`（L6-a finding#1 解耦）；`verify()` 对任何 pre-contract token（无 mode/无 auth basis/越界 mode）**fail-closed INVALID** = 硬 cutover（模块 unwired 无 live token 预存）。
- **ruling-⑤/⑧ resolver**：新 `historyBatchId` 请求 → server 解析 batch 的 sealed 终末 operation（同 sheet MAX endpoint_seq）；legacy/unsealed/unknown batch 统一拒 `exact-anchor-required`（无 unknown-vs-unsealed oracle）。
- **P1-2 内核 full-read 裁决**：REQUIRED `evaluateFullReadAccess` 依赖（生产 evaluator = 路由 4c-1 U-L8 gate，config-derived）。preview 在任何 anchor 查找前拒 `forbidden`（无存在性 oracle）；execute 围栏内 FRESH 重裁决 + 重算 v1 authorization basis 对照 token 的 `authorizedScopeHash`（token echo 绝非权威）。
- **F4 shared baseline 合成** `composeBaselineOverlay`：preview 与 L8 apply hash 同一 baseline-composed set = what-you-see-is-what-applies。
- **⚠️ seam HELD false（owner 裁决）**：`RECONSTRUCTION_CAUSALITY_LANDED` **不 flip** —— 因果重建机制已落地，但此常量是 strict enablement 最后一道 fail-closed backstop，owner 裁决它只在**接线 Revert/Reset 的同一未来 PR** flip。held-false 时 strict-on 对每张表（含 checkpoint-bearing）仍拒 `reconstruction_non_causal`；单测 seam 绊线 + WIRED 层 real-DB goldens 钉住此姿态（premature flip 必红）。
- 验证：unit 30/30（identity 13 + checkpoint 17）；exact-anchor recovery real-DB 15/15；checkpoint/strict-seq real-DB 49/49（held-posture goldens）；**8 突变各命中靶**（M-1 mode-bind/M-2 in-fence evaluate/M-3 auth echo/M-4 drift partial/M-5 preview 裁决/M-6 resolver terminal + MF4 preview 合成 + MG1 burn floor + seam flip→true）逐一还原；**#4417 单独 tsc exit 0**（不依赖 L7/L8）。

### R5 = L7：exact-anchor 恢复 PLAN（#4445，stacked on #4417，head `37fd6b3c3`）
- §5 目标集重算的分类层：revert / resurrect（锚后删除，从 revision 链取 at-anchor 快照，绝非 trash vintage）/ stays-deleted（LOCK-9）/ `deletedAtAnchorLiveNow` + `createdAfterAnchor`（**caller-picks —— plan 层绝不选择销毁**）/ schema-drift 排除+计数（`driftCount` 供只读 preview 披露）。
- 验证：10 goldens；4-mutation 矩阵（drop LOCK-9⇒3 红/drop drift⇒1/vacuous equals⇒3/skip resurrect⇒1）。未接线任何路由。

### R6 = L8：exact-anchor 破坏性 APPLY + token-bound mode + pre-wiring gate items（#4446，stacked on #4445，head `5824c4cb1`）
- **单外层事务、all-or-nothing**：fence-first → **anti-replay burn**（`meta_recovery_token_burns`，PK=at-most-once，拒绝时随事务回滚=零写入）→ **围栏内 P1-2 授权重裁决**（fresh full-read + authorizedScopeHash 重算，forbidden 时 burn 回滚 token 不半死）→ **围栏内 checkpoint 重解析**（不信任 token echo）→ **双哈希漂移校验**（`scopeHash`=锚权威 + `liveSetHash`=预览新鲜度）→ **F4 baseline 合成**（与 preview 同一 `composeBaselineOverlay`）→ L7 plan → **P1-2 schema-drift 整体拒**（`driftCount>0` ⇒ 整 apply 零写入含 burn）→ 上锁校验（rank-8）的原子 apply（revision-emitted `source:'restore'` + ledger-tagged，**apply 自身 seal 出新 endpoint = 未来 exact anchor**）→ COMMIT once。
- **P1-1**：mode 从 **VERIFIED CLAIMS** 读（caller 无 mode 入参 —— revert-preview token 结构性无法驱动 reset）。
- **pre-wiring gate items（全 mutation-proven）**：**F4** preview/apply hash 对称（MF4 preview 去 composition⇒BASELINE 红）· **G1** `pruneExpiredRecoveryTokenBurns`（15m floor clamp = token TTL 10m + skew 正确性边界；MG1 去 floor⇒红）· **G2** resurrect-vs-trash vintage · **G3** 双 token 构造竞态（两连接并发 apply 恰一赢/loser preview-drift/一 burn，Promise.all + 独立 pool 连接 + fence 串行化）· **NIT-2** DRIFT-REJECT inline 正控。
- 验证：11+ goldens 含 LIVE-DRIFT / INJECTED-FAILURE（中段崩溃回滚一切）/ FENCE-PARK（pg_locks 证 parked）/ REPLAY / CHECKPOINT-GONE/CHANGED / BASELINE / LOCKED；6+2 mutation 矩阵全承重；三 exact-anchor real-DB 套件在 L8 tip **43/43**。legacy Revert/Reset 路由切换到本模块 = **owner 的接线决策**（其 flags 依旧 OFF）。

## §4 验证方法论（本轮所有层共用）

1. **Mutation-proven goldens**：每个承重断言先证 mutation 落地（红）再恢复（绿）；拒绝 count-guard/假开关空转（C2 counterexample、version-reset、no-MAX、mode-bind、in-fence-evaluate、auth-echo、drift-partial、resolver-terminal、preview-composition、burn-floor、seam-flip 等 20+ mutation 类）。
2. **构造性竞态**：raw pg clients + pg_locks/pg_blocking_pids（FENCE-PARK、G3 双 token、L4cov §AF）；顺序论证不作为竞态证据。
3. **独立对抗门禁**：每层 refute-first lens（各自隔离 DB）+ synthesis 完整性批判；verdict 绑 head SHA；重排/改动后对**新 head** 复门禁（gate CLEAR 后不再往 gated head 加 commit，NIT carry-forward）。
4. **两点接线**：每个 real-DB golden 同时进 plugin-tests.yml 白名单 + vitest glob；fail-not-skip sentinel；mutation-red 证明 CI 真跑。
5. **Flag-off parity**：每层证 flag-OFF byte-identical（app 层 + DB-trigger 层）。
6. **结构守卫**：OD-6 revision-disposition / rank-8 lock / rich-longtext sink 三守卫强制每个新写点带真实处置。
7. **栈底不变量**：restack 后栈底 PR（#4417）自身必须满足 held-false，不靠上层 commit 补 —— squash-merge 顺序安全。

## §5 诚实剩余（全部是 owner 决策，非未完开发）

1. **接线 + flip PR（唯一保留的开发闸门）**：把 legacy Revert/Reset 路由切换到 L8 exact-anchor apply 模块（含 masking/row-deny/size ceilings/link 副作用等 route 层义务，义务清单已在两模块 LAYERING CONTRACT 枚举）**并在同一 PR 内** flip `RECONSTRUCTION_CAUSALITY_LANDED` false→true。这是移除最后 backstop + 其消费者的**一个 reviewable change**（owner 裁决）。**enablement-adjacent = owner-reserved，本轮不建不 arm。**
2. **#4417/#4445/#4446 合并决策**：栈序 rebase-merge（gate CLEAR + full CI）；合并与否是 owner 决策。
3. **strict/Revert/Reset flag 启用**、staging/prod —— 一直是独立 owner 决策（合 #4417 前须核实 staging/prod `MULTITABLE_HISTORY_CONTIGUITY_STRICT` 环境状态，env 值代码审阅不可见）。
4. 门禁枚举的非阻断 follow-ups（接线 PR 内清理）：F1 mode/strategy 绑入身份（已由 P1-1 完成）· F2 driftCount 路由语义（已由 P1-2 整体拒完成）· F3 strict 链完整性 precheck 接入 preview+apply · G3 双 token 竞态（已补）· G4 路由级规模上限。

## §6 PR/branch 索引

| PR | 内容 | 状态 |
|---|---|---|
| #4339/#4346/#4362/#4347/#4409 | L3/L4/L4cov/L5/L6-a | **MERGED**（§2 SHAs）|
| #4447 | L5-wire 激活路由 | **MERGED** `ab43b3869` |
| #4438 | L4-cov-services + D-1→H1 + formula TOCTOU v2 | **MERGED** `9048c27e2` |
| #4451 | GF8-ON formula fenced-txn 失败传播 | **MERGED** `3e21f6d13` |
| #4417 | L6-b exact-anchor + P1 token 合约 + seam **held false** | Draft，gate CLEAR，**HELD（owner 决策）** |
| #4445 | L7 plan（stacked #4417）| Draft，mutation-proven，gate CLEAR，HELD |
| #4446 | L8 apply（stacked #4445）+ pre-wiring gate items F4/G1/G2/G3/NIT-2 | Draft，gate CLEAR(0P1/0P2)，HELD |
| #4332 | 本 MD | 最终版（2026-07-17 更新）|

## §7 本轮（2026-07-17）新增开发摘要

1. **P1 token 合约**（owner 二审两硬阻断）：mode 绑定 + authorizedScopeHash + anchorOperationId 改名 + ruling-⑤ resolver + 内核 full-read 裁决 + schema-drift 整体拒 + burn 生命周期。跨 #4417/#4445/#4446 一次改完，6 mutation 各命中靶。
2. **UN-FLIP**（owner 裁决）：`RECONSTRUCTION_CAUSALITY_LANDED` 保持 false + 全耦合面反转措辞 + 三 golden 反转为 held-posture pin。
3. **pre-wiring gate items**：F4/G1/G2/G3/NIT-2（纯正确性+测试）。
4. **RESTACK**：整栈 rebase 到当前 main + 按文件最终态重构三分支（栈底自满足 held 不变量）；两轮独立对抗门 CLEAR。
5. **旁路合入**（非本栈，同线支撑）：#4447 L5-wire、#4438 L4-cov-services、#4451 GF8-ON 全 MERGED（各自 full required CI 绿）。

——完——
