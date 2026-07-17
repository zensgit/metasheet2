# Time Machine W0 「built-to-trust」 — 开发与验证 MD（最终版，2026-07-17）

**这是 owner /goal「完成上面给出所有开发，完成后给出开发及验证 MD」的交付物。** 结论先行：

> **W0 信任基底（L3→L6-a）已全部合入 main；恢复权威链（L6-b→L7→L8)与服务写者围栏（L4-cov-services）已全部建成、独立对抗门禁通过、required CI 全绿，作为 held Draft PR 栈等待 owner 的合并决策。** 所有 flags 保持 default-OFF；未 arm 任何东西；strict/Revert/Reset/staging/prod 的启用是 owner 单独保留的决策。剩余未完成项只有一类：**owner 的合并与启用决策本身**（见 §7）。

## §0 授权基础（ratified basis）

**#4331 v3.7 §9 七项建议**（owner-ratified 设计基础；ratification 只授权 **default-off 实现切片** —— 不授权 strict/Revert/Reset 启用、host 变更、staging 切换或生产 rollout）：
1. **可执行锚点**：仅 committed history batch/event；**禁止自由挂钟时间的破坏性执行**。
2. **手动日期时间**：只读近似导航（`reconstructRecordsAtT` 保留为 display 用途）。
3. **世代**：**target-generation A**（锚点所在世代的状态，非 terminal-only）。
4. **围栏**：保留 auto-number key，泛化为 canonical sheet-state fence；canonical → PIT 锁序。
5. **执行**：围栏内完整 target/schema/set 重算 + 预览校验。
6. **批次终点**：**sealed operation ledger** —— server-minted、sheet-scoped、单事务组；exact `anchorSeq` 冻入签名身份。
7. **Bigint**：string/bigint 端到端；**测试禁止 mutate 生产序列**。

## §1 信任模型（v3.7 exact-anchor，一段话版）

放弃挂钟时间 T 作为恢复权威（`created_at` 是 txn-start，非 commit 序 —— C2 类错误的根源）。信任链为：**opaque `anchorBatchId`（sealed operation endpoint，L6-a）→ 不可变 `endpoint_seq` = exact `anchorSeq`（共享因果 bigint 序 `meta_record_chain_seq`，L3）→ 覆盖该锚的 trust checkpoint（`trusted_since_seq ≤ anchorSeq`，L5）→ HMAC 签名预览身份（绑定 anchorSeq/checkpointId/scopeHash/liveSetHash/actor/sheet）→ 围栏内执行（L4 all-writer fence + L8 单事务 apply，token-bound anchorSeq，绝不重算 `MAX(seq)`）**。因果性只在全体写者上围栏 + checkpoint 截断此前历史时成立 —— 这正是 L4/L4cov/L4-cov-services 覆盖全部写者、L5 建立信任地板的原因。

## §2 已合入 main 的信任基底（每层：完整 required CI + 独立对抗门禁）

| 层 | 内容 | merge SHA |
|---|---|---|
| **L3** | 因果 `seq` 域（共享 bigint 序列迁移 + backfill-非信任语义）+ loud marker + strict 世代感知 contiguity precheck（gen-0 hole 修复）| `cc35b2599` (#4339) |
| **L4** | canonical per-sheet write fence（保留 auto-number key；fence-before-check;durable writer-block 状态机无卡死吸收态）+ recovery-vs-recovery 双向闭合 | `502b1df1c` (#4346) |
| **L4-cov** | univer-meta/records/auto-number 写者族全围栏 + **owner 复审抓获的真 P1**（forward field-delete 无围栏）修复 + B6/B7 mutation-proven | `f2020509a` (#4362) |
| **L5** | trust checkpoint（激活/选择/保留;非伪造 `system_kind`;最新 vintage by 因果 seq;unattributable trash 中止激活;anchor-covering retention 地板;strict-enablement precondition 无条件拒绝接线）| `5b0ccf791` (#4347) |
| **L6-a** | sealed operation-endpoint ledger（`meta_record_history_operations`;DEFERRABLE FK;endpoint 校验/UPDATE-拒/DELETE-拒触发器;H1/H2/H3 owner 硬化;batch_id 与 operation_id 永久解耦）| `2f456571e` (#4409) |

历史注记：本轮曾被 owner 三轮对抗复审证伪（4 P1 + 2 P2，含 L3 gen-0、可伪造 system 身份、任意 trash vintage、retention 删除必要 checkpoint 等），全部根修后重新门禁再合入 —— 上表即修复后的最终状态。

## §3 建成 + 门禁通过 + HELD 的恢复权威栈（Draft PR，等待 owner）

### R4 = L6-b：exact-anchor 恢复解析 + 因果重建器（#4417，head `ef7ea497b`，rebase 到 main 后 range-diff 全 `=`）
- **因果重建器** `reconstructRecordsAtSeq`（`seq <= $::bigint`,DISTINCT ON seq DESC,LOCK-9 delete-aware,世代正确 —— MULTI-GEN golden 证明锚点在第 1 世代时重建到 G1 状态）;`created_at` 路径保留为只读导航。
- **解析/执行权威** `resolveExactAnchor`/`executeExactAnchorRecovery`：挂钟请求 `exact-anchor-required` 拒绝（DB 读之前,no-oracle）;未知锚/无覆盖 checkpoint fail-closed;execute 只用 **token-bound anchorSeq，绝不重算 MAX(seq)**。
- **⚠️ 后果级变更**：`RECONSTRUCTION_CAUSALITY_LANDED false→true` —— 移除最后一道 fail-closed backstop，**把 strict flag 从「无效双锁」变为「单锁」**（flag-ON + checkpoint-bearing sheet 即进入 strict comparator）。flag 本身仍 default-OFF。**这正是 #4417 held 待 owner 明确合并决策的原因（enablement-adjacent = owner-reserved）。**
- 验证：5 类 mutation 全承重（C2 seq-序/exact-bigint/no-MAX-recompute/version-reset/constant-flip）;W0 real-DB cluster 82/82;unit 5556/5556。**独立 4-lens 门禁 CLEAR（0 P1/0 P2）**;7 required checks 全绿。

### R7 = L4-cov-services：服务写者围栏 + D-1→H1-DELETE 落实（#4438，head `dc6849b20`，独立于 R4、基于 main）
- 4 个服务写者类上 canonical fence：automation actions（单 seam `withTransaction(sheetId,…)` + 无事务时 fail-closed）、result-writeback、formula 物化（bare-pool 残余诚实注记）、approval-projection reconcile（canonical→projection 锁序）。
- **owner 指令闭环**：deferred plugin **D-1 delete 分支纳入 H1-DELETE 实现矩阵**（flag-ON：OD-7 事务契约 + fence + mint/seal，endpoint H1-不可变;flag-OFF byte-identical）+ retention-GUC 钉为 transaction-local（G1）。
- 验证：15 real-DB goldens;**8-mutation 矩阵全承重**;**3-lens 门禁 0 P1**，两 P2 覆盖缺口按门禁自身验收标准修毕（MUT-B/C 现红）;回归 172 + unit 5546;8 required checks 全绿。

### R5 = L7：exact-anchor 恢复 PLAN（#4442，stacked on #4417，head `60c2d41b9`）
- §5 目标集重算的分类层：revert / resurrect（锚后删除,从 revision 链取 at-anchor 快照,绝非 trash vintage）/ stays-deleted（LOCK-9）/ `deletedAtAnchorLiveNow` + `createdAfterAnchor`（**caller-picks —— plan 层绝不选择销毁**）/ schema-drift 排除+计数。
- 验证：10 goldens;4-mutation 矩阵（drop LOCK-9⇒3 红/drop drift⇒1/vacuous equals⇒3/skip resurrect⇒1）。未接线任何路由。

### R6 = L8：exact-anchor 破坏性 APPLY（#4444，stacked on #4442，head `11639712d`）
- **单外层事务、all-or-nothing**：fence-first → **anti-replay burn**（新表 `meta_recovery_token_burns`,PK=at-most-once,拒绝时随事务回滚=零写入）→ **围栏内 checkpoint 重解析**（不信任 token echo）→ **双哈希漂移校验**（`scopeHash`=锚权威[不可变重建] + **`liveSetHash`**=预览新鲜度[live {id,version} 指纹] —— 后者是本层新增,因为锚哈希在 append-only 历史下永远看不见并发活写）→ **baseline 合成**（replay 地平线以下的记录用 resolved checkpoint 的不可变 baseline）→ L7 plan → 上锁校验（rank-8）的原子 apply（revision-emitted `source:'restore'` + ledger-tagged,**apply 自身 seal 出新的 sealed endpoint = 未来的 exact anchor**）→ COMMIT once。
- mode 语义：`revert` 保留 caller-picks 两清单;`reset` 删除之（带 delete revisions）。legacy Revert/Reset 路由切换到本模块 = **owner 的接线决策**（其 flags 依旧 OFF）。
- 验证：11 goldens 含 **LIVE-DRIFT**（预览-执行间并发已提交写 ⇒ 409 + 零写入含 burn;漂移撤销后同一 token 可用=拒绝零写入的构造性证明）、**INJECTED-FAILURE**（apply 中段崩溃回滚一切）、**FENCE-PARK**（raw client 持围栏,apply 真实 parked,pg_locks 证明）、REPLAY、CHECKPOINT-GONE/CHANGED、BASELINE（trashed 保持删除）、LOCKED（他人锁中止全 apply）;**6-mutation 矩阵全承重**;unit 5556/5556;结构守卫（OD-6/rank-8/rich-longtext）真实处置绿。
- **独立 4-lens 门禁（atomicity / drift+replay / rechecks+baseline / plan+mode+回归）：OVERALL CLEAR —— 0 P1、0 unrebutted P2**（gated head `899849054`;F6 fixture + F2 doc 修复 → `11639712d`）。承重正证全部构造性确认：双客户端 burn PK 竞态 at-most-once;burn 在每类拒绝下随事务回滚（把 drift throw 改成 return 会泄漏 burn 且 LIVE-DRIFT 变红 = throw 承重）;seal 腿回滚;checkpoint-echo 不可信（X2 红）与 baseline 合成（X5 红）承重;FENCE-PARK pg_locks 证明;plan 桶不相交（exists-at-anchor 行永不进删除集）。**pre-wiring gate list**（owner 接线前必清,不阻本 unwired draft）：F1 mode/strategy 绑入签名身份（T8-2 纪律）· F2 driftCount>0 的路由语义（拒绝 vs 显式部分确认）· F3 strict 链完整性 precheck 接入 preview+apply（§5 step 5）· F4 preview 显示层合成 baseline · G1 burn 表保留清扫 · G2 resurrect-vs-trash-row golden · G3 双 token 并发 apply 构造竞态 · G4 路由级规模上限。

## §4 验证方法论（本轮所有层共用）

1. **Mutation-proven goldens**：每个承重断言先证 mutation 落地（红）再恢复（绿）;拒绝 count-guard/假开关空转（C2 counterexample、version-reset、no-MAX、flip、burn、baseline 等 20+ 个 mutation 类）。
2. **构造性竞态**：raw pg clients + pg_locks/pg_blocking_pids（FENCE-PARK、L4cov §AF）;顺序论证不作为竞态证据。
3. **独立对抗门禁**：每层 3-4 个 refute-first lens（各自隔离 DB）+ synthesis 完整性批判;verdict 绑 head SHA;门禁 blocks 按其自身验收标准修复并复证（R7 的 MUT-B/C、R4 的 P3-A/P3-C）。
4. **两点接线**：每个 real-DB golden 同时进 plugin-tests.yml 白名单 + vitest glob;fail-not-skip sentinel;mutation-red 证明 CI 真跑。
5. **Flag-off parity**：每层证 flag-OFF byte-identical（app 层 + DB-trigger 层）。
6. **结构守卫**：OD-6 revision-disposition / rank-8 lock / rich-longtext sink 三守卫强制每个新写点带真实处置。

## §5 诚实剩余（全部是 owner 决策，非未完开发）

1. **#4417 合并决策**（constant flip 移除最后 backstop —— enablement-adjacent，owner-reserved）→ 合并后 #4442/#4444 依栈序 rebase-merge。
2. **#4438 合并决策**（非 enablement-adjacent 的覆盖加固,可独立先合）。
3. **strict/Revert/Reset flag 启用**、staging/prod —— 一直是独立 owner 决策。
4. **路由接线**（legacy Revert/Reset 切换到 L8 模块,含 masking/deny/ceilings/link 副作用等 route 层义务）—— owner 接线决策,义务清单已在两模块 LAYERING CONTRACT 中枚举。
5. 门禁枚举的非阻断 follow-ups：formula bulk-recompute txn-wrap;multi-sheet fence 序 probe;writer-vs-recovery 构造竞态（现已可构造 —— L8 落地了 block producer 的对应物）。

## §6 PR/branch 索引

| PR | 内容 | 状态 |
|---|---|---|
| #4339/#4346/#4362/#4347/#4409 | L3/L4/L4cov/L5/L6-a | **MERGED**（§2 SHAs）|
| #4417 | L6-b exact-anchor + flip | Draft,gate CLEAR,CI 绿,**HELD（owner 决策）** |
| #4438 | L4-cov-services + D-1→H1 | Draft,gate 0P1+修毕,CI 绿,HELD |
| #4442 | L7 plan（stacked #4417）| Draft,mutation-proven,HELD |
| #4444 | L8 apply（stacked #4442）| Draft,gate CLEAR(0P1/0P2)+F6/F2 修毕,HELD |
| #4332 | 本 MD | 最终版 |

——完——
