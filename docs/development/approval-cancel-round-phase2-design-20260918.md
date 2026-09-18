# Approval Cancel-Round — Phase 2 (C-2 兑现与收口) Design (2026-09-18)

Branch `feat/approval-cancel-round-phase2` (this document is authored on the sub-lane worktree
`feat/approval-cancel-round-phase2-u1`, which does not itself edit any code — see the header note
below). Base commit for every citation in this document: `a02930896` (`docs(approval): §3.16.1's
posture half is INHERITED, not pinned by its own case`), the head this sub-lane was pinned to at
dispatch — **not** a later head, even if `feat/approval-cancel-round-phase2` has since moved on (the
phase-1 design document's own header names exactly this failure mode: a branch name alone stops
resolving to a slice's actual base the moment sibling lanes push further commits to it).

Source of authority: `approval-change-request-design-lock-draft-20260915.md` v5.9 (RATIFIED
2026-09-18; its 抬头 RATIFY record is quoted verbatim in §6 below, not paraphrased). Goal definition:
`goal-three-locks-full-implementation-20260918.md` (slice "C 撤销 / C-2 兑现与收口"). Supplementary
gate checklist: `impl-supplementary-gate-checklist-20260918.md`. Predecessor: `approval-cancel-round-
phase1-design-20260918.md` (C-1 合同层, Draft PR #5851). Companion verification document, already on
this branch and 2479 lines at this head: `approval-cancel-round-phase2-verification-20260918.md` —
this design document restates its findings at the level the goal document's template asks for
(scope, data flow, interfaces, transactions, seams, owner items) and cites the verification MD's own
§-numbers rather than re-deriving its test evidence a second time. Every code `file:line` citation
below was checked by this document's own `grep`/`sed` against `a02930896` (shown inline where the
⚠️ **2026-09-18 定稿 pass, HEAD `d462677bd`**: every citation below was re-checked a SECOND time,
against the tree AFTER the `u1→u3→u2` merge (`1c98ff937`; `git diff --stat 1c98ff937..HEAD` is
docs-only, so `1c98ff937`'s source is this HEAD's source). Verdict: citations into `index.cjs`,
`ApprovalBridgeService.ts`, `w4c3b-central-approval-hooks.ts`, `w4c3b-request-operation-boundary.ts`,
`w4c0-operation-registry.ts`, and `attendance-cancellation-execution-port.ts` are **byte-accurate,
unchanged**. Citations into `ApprovalProductService.ts` had **drifted** — the u3 merge added 41 net
lines to that one file — and are corrected in place below (`NNNN (was MMMM)`), with the full
methodology and a consolidated before/after table in the new §10 at the end of this document.
check mattered) — not assumed current from the verification MD's own citations, which are head-scoped
to each unit's HEAD at the time it was written (its own §3.15.1 states this explicitly, after phase 1
moved out from under phase 2's base mid-slice). Two sites the verification MD cites were found
DRIFTED at `a02930896` (three line numbers total: the decision adapter's two `FOR UPDATE` lines,
§1.1/§4.3; the `bulkReassignApprovals` call site, one line, §4.3) and are corrected in place with
the verification MD's own number kept alongside for traceability, rather than silently overwritten.

**This document is documentation only.** Per this lane's own mandate, it makes no code or test edit;
every fact below was read off the tree, not written into it by this pass.

## 1. Scope of this slice (C-2 兑现与收口)

Per the goal document's slice table (`goal-three-locks-full-implementation-20260918.md:9`), C-2
covers: **判据 II(C-2 挂点先于 `:11070`,W4 外部事务入口 C-1,账侧字节等价)+ 判据 IV(C-3 收口
`expired`/`blocked`,#5′ 登记)+ R2 反例 + 二切片验收**. What has actually landed on this branch, unit
by unit (verification MD §-numbers in the right column):

| Piece | What it does | Verification MD |
|---|---|---|
| 判据 IV, C-3's `expired` half | new outlet #5′ anchor in `dispatchAction`, immediately before the terminal `UPDATE approval_instances SET status` — the lock's 「先于任何终态状态写」, not 「先于完成事件入队」 | §3.1–§3.8 |
| §2-G2 time anchor | `MIN(created_at)` of the document's own `to_status='approved'` audit rows, refusing to decide (`CANCEL_ROUND_WINDOW_ANCHOR_MISSING`, 409, rollback) rather than closing on missing evidence when a legacy/bridge row has none | §3.2 |
| Deterministic deadlock, MANUFACTURED AND FIXED IN-BRANCH | the #5′ hook's `{round row, original document row}` pair vs. `createCancelRoundInstance`'s own order — a defect this lane shipped (`78d41fb4c`) and fixed in the same lane | §3.3 |
| 判据 II's FIRST prerequisite: the rollout advisory lock ordered at `dispatchAction`'s entry | pre-read before `BEGIN`, conditional `BEGIN ISOLATION LEVEL SERIALIZABLE`, the rollout lock as the transaction's first lock, fail-closed re-assert, `40001`/`40P01` → `503 CANCEL_ROUND_DISPATCH_CONTENDED` (gated) | §3.3b (the blocker), §3.3c (Q-E, the org question), §3.9 (the restructure, Q-F) |
| 判据 II's SECOND prerequisite: the cancel adapter's row-lock reorder | `original document instance` `FOR UPDATE` moved above `attendance_requests` `FOR UPDATE` in `executeRequestCancel`, closing a second, independently-live deadlock | §3.10 (Q-G) |
| 判据 II itself, IMPLEMENTED | the redemption hook (`redeemCancelRoundInTxn`), the new core←plugin port (`AttendanceCancellationExecutionPort`), the `blocked` hand-off from C-1 into 判据 IV's closure writer | §3.11 |
| 判据 II END-TO-END against the REAL W4 boundary | double removed; found and fixed a shipped P1 (non-UUID replay key) on its first run | §3.12 |
| R2 (锁内最终评估失败 ⇒ 零业务取消、零 `approved` 完成事件、C-3 收口已持久化) | built against the real boundary with a live attendance target; row-level negative, not `calls.length === 0` | §3.13 |
| §5 I3 「终结即释放」, its own mutation | a dedicated case whose `createCancelRoundInstance` call is the FIRST statement after the close, so the clause carries the mutation | §3.14 |
| 账侧验收 (lock §8 期 1, lock:169) | twin-fixture byte-compare against the real HTTP W4 path; found a real, disclosed divergence | §3.15 |
| `unrecoverableExpired` 呈现, persistence half | the W4 seal (`sealAttendanceResultOperationV1`) persists the whole adapter response, `data.reversal` included, on the approval side's OWN transaction client, atomically with the approve | §3.16 |
| `attendance-parity.db.test.ts` 退役对账, WIDENED (u3, landed post-merge) | provenance census widened from two sources to four (adds phase-1 verification MD and PR #5851's own body); verdict unchanged, nothing to restore (never existed on any ref) | §3.17 |
| `unrecoverableExpired` 呈现, SURFACE half (u3, landed post-merge) | closed with a flagged DEFAULT, not left open: `UnifiedApprovalDTO.cancellationOutcome` (action response) + the approve audit row's `metadata.cancellationOutcome` (durable); three status tokens so "nothing to reverse" and "no channel" cannot collide | §3.18 |
| §9-9 允许集 `approve` 成员半边 (u2, landed post-merge) | C-1 gate-review round-5 P3-1/R5-M7's member-half closure — a case that measures BOTH sides of the outlet gate on one instance (non-member `handle` refused, member `approve` redeems), so removing `approve` from the allow-set is red on membership itself, not on a downstream consequence | §3.19 |
| §5 I3 「终结即释放」, C-2 half (u2, landed post-merge) | the SECOND of the two terminal `approval_rounds.outcome` writers now has its own I3 probe (§3.14 built the first, for the C-3 closure writer) | §3.20 |
| 账侧七步逐步处置, written as 依据 (u2, landed post-merge) | ①–⑦ each given its own disposition rather than left as table cells; corrects two of its own supporting mechanism claims in the next unit | §3.21 |
| ⑥ 的账侧半边 (`unrecoverableExpired`), MEASURED (u2, landed post-merge) | resolved as a DECLARED DIVERGENCE, not an open item: A (redemption) seals it into `response_snapshot`, B (HTTP path) carries it only in the response body and seals no row at all — no byte-comparable row pair exists, by mechanism (a 2×2 over posture × operationId), not by omission | §3.22 |

### 1.1 Explicitly NOT in this slice (deferred, per §7 below and the verification MD's own §4)

- **The decision adapter's matching reorder.** §3.10 fixes the CANCEL adapter only; the DECISION
  adapter (`executeRequestDecisionInTransaction`, `index.cjs:37626` `attendance_requests FOR UPDATE`
  / `:37647` `approval_instances FOR UPDATE` — re-derived against this tree; the verification MD's
  own §3.10.3 cites `:37596`/`:37617`, its pre-merge head) is *also* `attendance_requests →
  approval_instances` and is
  gated on the same `requestRow.status === 'pending'` population `bulkReassignApprovals` reaches with
  the instance row already held — the **same cycle, same shape, still live** (verification §3.10.3,
  §0 R-3). Pinned by Q-G LEG 4 so a future reorder there must update the census; owed to the
  attendance line as a finding, not taken here.
- **A writer-syntax (`UPDATE …`) lock-order census over the attendance plugin.** Q-G's counts cover
  `FOR UPDATE` reads only; 3 `UPDATE approval_instances` + 5 `UPDATE attendance_requests` statements
  in the plugin are unenumerated (verification §3.10.2, §4).
  Two relations the cancel adapter locks BETWEEN the ratified pair
  (`attendance_schedule_dispatch_requests`, `attendance_request_calculation_snapshots`) have no rank
  in lock:227's class list — flagged for owner registration, not silently ordered (§3.10.1).
- **`filterBulkReassignDiscoveryForAttendance`'s nondeterministic org resolution** (§3.3d) — a real
  defect this census FOUND (an unordered, unfiltered `LEFT JOIN` whose consumer folds duplicates into
  a `Map` keyed by instance id, so whichever row Postgres returns last silently wins the org), on a
  production path unrelated to this lock. Owed to the attendance line as a finding; nothing on this
  branch depends on it.
- **Which user-facing surface renders `unrecoverableExpired`.** ⚠️ HALF CLOSED post-merge: the
  persistence half was already closed (§3.16); u3 (verification §3.18) now closes the DTO/audit-row
  surface too, but with a flagged DEFAULT rather than a ratified choice, and no FE/notification
  surface renders it — see §7 and §8 (updated) for the full statement.
- **`attendance-parity.db.test.ts` as a named artefact.** Retired, not deferred: the filename is an
  implementer invention never named by the lock (`grep -c "attendance-parity" <lock>` → 0), and the
  requirement it stood for is implemented in the already-wired
  `approval-cancel-round-redemption.db.test.ts` (§3.15.0). u3 (verification §3.17) widened the
  provenance census to four sources and reconfirmed the same verdict — see §8 (updated).
- **FE / notification side.** C-3's 「卡片失效、端点返回一致」 column is untouched by this slice
  (verification §4, last bullet); 卡片失效 for a carded cancel round is possible, pre-existing and
  unswept (§3.8).
- Everything phase 1 already deferred and this slice does not pick up: 修改(修订表、amend 轮)、加班
  撤销、批量、legacy 路由承载 cancel 轮功能、委托人发起 — all named out of scope by the lock itself
  (§7, lock:159-162) for the entire first-slice program.

## 2. Data flow and the round's state machine

**Data model**: unchanged from phase 1. This slice adds no migration and no column — `git diff
--stat feat/approval-cancel-round-phase1..HEAD -- 'packages/core-backend/src/db/migrations/*'`
against `a02930896` is empty. The template's "数据模型与约束" heading is therefore covered by
phase-1 design §2 (the `approval_rounds` table, the Q1c FK pairing, the seed chain); what this
slice adds is behaviour over that unchanged schema, hence "data FLOW", not a second data model
section.

### 2.1 The outcome state machine (`approval_rounds.outcome`, lock §4/§14.2/§14.3)

```
                         ┌────────────────────────────────────────┐
                         │                 pending                 │
                         └────────────────────────────────────────┘
   A7 (reject, 判据 III)  │        A4 (revoke, 判据 III)  │        outlet #5 (approve, 判据 II)
   comment required        │        requester + allowRevoke │        original attendance request
   engine → rejected        │       engine → revoked          │       resolvable ⇒ C-1 redeemed
                         ▼                                 ▼                                 ▼
                    rejected                          withdrawn                          applied
                (ended_at set)                    (ended_at set)                (ended_at set;
                                                                                  engine → approved,
                                                                                  original → cancelled)

                         outlet #5′ (锁内最终评估, 判据 IV)
             ┌──────────────────────────┬──────────────────────────┐
             │ 窗口/策略已关               │ 业务不可逆(已消费/结算/    │
             │ (§2-G2 anchor closed,      │  不支持套件 / C-1 声明     │
             │  or missing ⇒ refuse to    │  `business_refused`)      │
             │  decide instead — §3.2)    │                            │
             ▼                            ▼                            
          expired                      blocked
    (engine → rejected,           (engine → rejected,
     reason=round_expired)         reason=business_blocked:<code>)
```

All five terminal transitions release the partial-unique-index slot
(`uq_approval_rounds_pending_document … WHERE outcome='pending'`, I3) by writing a non-`pending`
`outcome` **and** `ended_at` in the same transaction as the corresponding engine-instance write —
`applied`/`rejected`/`withdrawn` in the transaction that also advances the ENGINE instance,
`expired`/`blocked` in the transaction the #5′ closure owns exclusively (it never reaches the
ordinary approve write path — the early `return`, §14.2 判据 IV, is what makes that true; §3.14's
mutation is what proves the round write is load-bearing rather than decorative).

### 2.2 What each transition writes, traced to its own citation

| Transition | Engine instance | Round row | Completion events | Seats | Citation |
|---|---|---|---|---|---|
| `pending → rejected` (A7, judgment III) | `status='rejected'` (real reviewer) | `outcome='rejected', ended_at=now()` | one (ordinary reject completion) | released via engine closure | phase-1 design §5; `ApprovalProductService.ts:11766` (was `:11750`; re-checked post-merge, §10) |
| `pending → withdrawn` (A4, judgment III) | `status='revoked'` | `outcome='withdrawn', ended_at=now()` | one (ordinary revoke completion) | released | phase-1 design §5; `:11279` (was `:11263`; re-checked post-merge, §10) |
| `pending → applied` (outlet #5, judgment II) | `status='approved'` (unchanged fall-through) → **C-1 executes and separately writes the ORIGINAL document's own instance** `approved→cancelled` | `outcome='applied', ended_at=now()` | **exactly one** APPROVAL-domain completion event, measured, and it is the cancel round's OWN — §3.11.6's case does not itself assert the original document's instance produces none (C-1 is an attendance-domain operation and never calls `dispatchAction`/`buildCompletionEvent` on the original, so none is expected by construction, but that is a construction argument here, not a case that asserts a zero on the original). C-1's OWN attendance-domain event, `attendance.request.cancelled`, is a separate thing this row does not cover — §3.15.11 measures it at **0/0 on both twins**, but only because the fixture's org resolves `legacy_projection_only`; the `authoritative`/`shadow` branches are unexercised, so that 0/0 is parity of two skips, not a closed claim that the event never fires | released; cancel round's own seats deactivate through the ordinary approve path | verification §3.11.6 (redeem case), §3.15.11, §3.20 (this cell's own I3 slot-release probe, closed post-merge — see §7.1) |
| `pending → expired` (#5′, judgment IV) | `status='rejected'`, actor=`system:approval-cancel-round`, `metadata.cancelRoundCloseReason='round_expired'` | `outcome='expired', ended_at, block_reason=NULL, policy_snapshot_at_decision` | **zero** | seats deactivated by the closure writer | §3.1, §3.2 |
| `pending → blocked` (#5′, judgment IV, via C-1's `business_refused`) | same system-sentinel shape, `metadata.cancelRoundCloseReason='business_blocked:<code>'`, `cancelRoundBlockDetail` **beside** the bounded reason token, never concatenated into it | `outcome='blocked', block_reason, ended_at, policy_snapshot_at_decision` | **zero** | deactivated | §3.11.6 (`business_refused` case) |

`policy_snapshot_at_decision` is written on **every** terminal branch that runs through the #5′
closure (both `expired` and `blocked`) — lock §4's "在最终评估时同形写入" names both, not only the
success path (§3.1's "decisions taken here" bullet 3).

### 2.3 The redeem branch does NOT return — the one place this slice's state machine diverges from C-3's

Every C-3 closure branch (`rejected`/`withdrawn`/`expired`/`blocked`) is a terminal write followed by
an early `return` inside `dispatchAction`. The `redeem` branch is the opposite: it performs C-1's
execution and, on success, **falls through** into the ORDINARY approve code path below it — the
round's own instance gets its `approved` status write, its approve audit row, and the ONE completion
event 判据 II names, from the SAME code every non-cancel-round approve already runs, not from a
cancel-round-specific write. This is deliberate (verification §3.11.5): C-2's挂点 owns only the
BRANCH DECISION and, on `blocked`, the closure; it does not re-implement the approve write it is
piggy-backing on. The `redeem → blocked` hand-off (§3.11.6) is what lets C-1 downgrade a `redeem`
decision into a C-3 closure mid-transaction when the business evaluation inside C-1 itself refuses.

## 3. Interface and error codes

### 3.1 What this slice adds (module scope, `packages/core-backend/src/services/ApprovalProductService.ts` unless noted; re-derived against `a02930896`)

| Piece | Where (this tree) | Lock clause |
|---|---|---|
| `deriveCancelRoundRoundPolicy` | `:341` (was `:339`) | §4 `roundPolicy={windowDays,suite}` — ONE derivation, shared by `createCancelRoundInstance` (phase 1) and the final evaluation (this slice), so I4's two snapshots cannot drift |
| `APPROVAL_CANCEL_ROUND_SYSTEM_ACTOR = 'system:approval-cancel-round'` | `:861` (was `:859`) | §3 C-3 「actor = 系统终结身份」; same `system:` prefix as the timeout/departure sentinels, so `isSystemSentinelActor` covers it by construction |
| `resolveCancelRoundRolloutLockRequirementV1` | `:922` (exported; was `:920`) | §3 C-2 — "does this dispatch take the rollout lock, and on which org key" — three-hop resolution per §3.3c |
| `evaluateCancelRoundFinalInLock` (private) | `:8753` (was `:8751`) | §3 C-2 step ③ 「锁内最终评估」 |
| `closeCancelRoundSystemTerminalInTxn` (private) | `:8880` (was `:8878`) | §3 C-3 「持久化收口」 |
| `redeemCancelRoundInTxn` (private) | `:8998` (was `:8996`) | §3 C-2 steps ④–⑤; §14.2 判据 II |
| `AttendanceCancellationExecutionPort` + its singleton registry (`register`/`unregister`/`get`/`has`/`clear`) | `packages/core-backend/src/core/attendance-cancellation-execution-port.ts` (new file) | §3 C-1 「审批侧只调用」 — modelled line-for-line on the existing `workday-calendar-port.ts` host↔plugin pattern, the one precedent for approval calling INTO attendance (verification §3.11.1) |
| `deriveCancelRoundW4OperationIdV1(roundId)` | same file, `:69` (re-checked post-merge, unchanged despite the file's own +94-line growth — the insertions landed below this declaration) | the W4 replay key (§14.1's operation-registry contract) — the round's own id, which is why it must be a UUID (the P1 §3.12.1 fixed) |
| the pre-read + conditional `BEGIN ISOLATION LEVEL SERIALIZABLE` + rollout-lock-first + fail-closed re-assert | `ApprovalProductService.ts:10506-10556` (was `:10496-10541`; see §4.2 below and §10) | §3 C-2 全局锁序 |
| outlet #5′ branch + early `return` | `:12166-12233` (was `:12150-12220`; see §4.1 and §2.3 above) | §14.2 判据 IV |

### 3.2 Error codes this slice introduces, each traced to the throw site (this tree)

| Code | HTTP | Condition | Lock anchor / status |
|---|---|---|---|
| `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` | 409 | §2-G2 time anchor unresolvable (no `to_status='approved'` audit row on the original document) — refuses to decide rather than closing `expired` on missing evidence | lock names the anchor but not its absence — **implementer erratum, flagged for owner registration** (§3.2) |
| `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED` | 409 | the pre-read's rollout-lock requirement and the post-row-lock re-assert disagree (org drift between the two reads) | §3.3c point 4 — load-bearing, because `attendance_requests.org_id` is NOT immutable |
| `CANCEL_ROUND_DISPATCH_CONTENDED` | 503 | `40001`/`40P01` on a dispatch that took the `required` rollout-lock branch — gated so a non-cancel-round dispatch keeps its byte-for-byte prior rethrow | §3.9.3 — **UNEXERCISED**: no test drives a real `40001` into it; only a source-scan control (M-15) reddens the mapping's removal |
| `CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE` | 409 | the attendance execution port is unbound at redemption time | §3.11.2 — the ONE deliberate divergence from the `workday-calendar-port` precedent (which fails OPEN); failing open here would write `applied` having performed zero business cancellation |
| `CANCEL_ROUND_BUSINESS_TARGET_MISSING` | 409 | evaluation decided `redeem` but the rollout-lock pre-read never demanded `required` (no attendance request behind the original document, so C-1 has nothing to execute) | §3.11.6's isolated-variant case; names the actual reason rather than letting the entry's own 500 surface |
| (existing, carried forward, unmodified) `CANCEL_ROUND_OUTLET_FORBIDDEN`, `CANCEL_ROUND_SUITE_FORBIDDEN`, `CANCEL_ROUND_ALREADY_PENDING`, `CANCEL_ROUND_INVARIANT_VIOLATION`, `CANCEL_ROUND_DOCUMENT_NOT_APPROVED`, `CANCEL_ROUND_REQUESTER_ONLY`, `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` | — | — | phase-1 design §3.1/§3.2/§5 — **this slice does not touch their throw sites** |
| (disclosed, not this slice's own code) `ATTENDANCE_CALCULATION_ROLLOUT_BUSY` | 503 | `acquireAttendanceCalculationRolloutLock`'s existing budget-exhaustion surface, now reachable from a cancel-round dispatch for the first time because this slice puts it under the rollout lock | §3.9.3 — whether the route layer surfaces this status or flattens it to 500 is **NOT verified**, registered as an open item |

**Error-class discipline unchanged from phase 1**: every code above throws through `ServiceError`
(`handleApprovalsError` only maps `ServiceError`, everything else 500 — lock §14.3, lock:352-353);
none of them is `CancelRoundOutletForbiddenError`'s subclass or a bare HTTP status.

## 4. Transactions and lock order

This is the section the goal template asks to include, verbatim, the deterministic deadlock this
lane constructed and its own resolution, plus the lock-pair this lane closed. Quotes below are
copied from the verification MD, not paraphrased, per the task's instruction; §-numbers are that
document's.

### 4.1 The deadlock this lane MANUFACTURED and FIXED IN-BRANCH (verification §3.3)

> `evaluateCancelRoundFinalInLock` is the **first site in the tree that takes `FOR UPDATE` on an
> `approval_rounds` row at all**… It takes that lock in the same transaction as a `FOR UPDATE` on the
> ORIGINAL document instance — a **{row lock, row lock}** pair across two tables that no census leg
> had a denominator for (Q-A/Q-B/Q-C are all {row lock, advisory lock}).
>
> The counterparty is `createCancelRoundInstance`, which locks the original document **first** and
> only then INSERTs into `approval_rounds`. That INSERT is the hidden second edge: the partial unique
> index `uq_approval_rounds_pending_document … WHERE outcome = 'pending'` makes it **wait on any
> uncommitted change to that document's pending round**. `78d41fb4c` had the closer take the round
> row first ⇒ a cycle.
>
> ```
> REVERSED  (closer: round -> doc, AS SHIPPED IN 78d41fb4c)  = { a: 'A:23505', b: 'B:40P01 deadlock detected' }
> SHIPPED   (closer: doc -> round, after the fix)            = { a: 'A:23505', b: 'B:closed' }
> ```
>
> `40P01 deadlock detected`, deterministic.

**The fix**: the evaluator reads `document_id` off the round row **without a lock**, locks the
**ORIGINAL DOCUMENT INSTANCE first**, then takes the round row `FOR UPDATE` as the authority, and
cross-checks `round.document_id === original.id` so the unlocked probe cannot mislead the locked
read. Soundness rests on `document_id` being immutable in production — measured, not assumed:
**three** production writers to `approval_rounds` set only `outcome`/`ended_at`(+the closure's two
extra columns); **zero** assignments to `document_id` anywhere in `src`/`plugins` (verification
§3.3, the `git grep` block). Registered as census leg **Q-D**
(`tests/integration/approval-cancel-round-lock-order-census.db.test.ts`): the reversed order proven
to deadlock (the standing `40P01` proof), the shipped order proven not to (and both sides reaching a
defined outcome), and a both-ends-anchored source scan asserting the document lock precedes the
round lock in production code. Suite count after this leg: **13 passed (13)**.

### 4.2 判据 II's FIRST prerequisite: the rollout advisory lock, blocked then ordered (verification §3.3b, §3.3c, §3.9)

The lock fixes the global order **rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → …** (lock:110,
lock:227), and the W4 external entry requires the caller already hold the org's rollout SHARED
advisory lock **before any row lock it holds**. §3.3b found `dispatchAction` violates this by
construction — `BEGIN` is immediately followed by `approval_instances … FOR UPDATE` with **nothing**
in between, and the boundary's own `assertExternalTransactionRolloutLockHeldV1` checks *held-ness*
only (`pg_locks`, `granted`), with no notion of acquisition order, so it would **pass** while the
global order is broken — "exactly the shape the repo has a deterministic-deadlock precedent for
(#4899)".

§3.3c then asked the question §3.3b had not: **which org** does the pre-read key the lock by? The
intuitive answer — `approval_instances.org_id`, one hop from the row `dispatchAction` already loads —
is wrong: the W4 entry demands the org `prepareIdentity` resolves from `attendance_requests`, and
census **Q-E** proved with rows that the two columns can hold different values and derive different
class-`00` keys (leg 1), that the repo's own two instance→request joins **disagree** about which
request row is authoritative (leg 3 — `classifyAndLockAttendanceRequestForInstance`'s explicit
`ORDER BY … LIMIT 1` vs. `filterBulkReassignDiscoveryForAttendance`'s unordered `LEFT JOIN`, whose
inconsistency was itself flagged as an out-of-scope finding, §3.3d), and that `attendance_requests
.org_id` is **NOT** immutable (4 `EXCLUDED`-writer upserts), so the post-lock re-assert on it is
load-bearing, not cosmetic.

**What this tree does about it (`ApprovalProductService.ts:10506-10556`, was `:10496-10541` —
re-extracted at HEAD `d462677bd` for this 定稿 pass; see §10 for the full drift account)**:

```
10506  let rolloutLock: CancelRoundRolloutLockRequirementV1 = { kind: 'none' }
10513  client = await pool.connect()
10522  rolloutLock = await resolveCancelRoundRolloutLockRequirementV1(client, id, request.action)   // BEFORE BEGIN
10508→10524  if (rolloutLock.kind === 'required') {
10525    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
10528    await acquireAttendanceCalculationRolloutLock(client, orgKey, 'shared')                     // FIRST lock
10533→10534  } else { await client.query('BEGIN') }
10538  … FOR UPDATE on approval_instances …                                                          // SECOND lock
10550  const rolloutLockUnderRowLock = await resolveCancelRoundRolloutLockRequirementV1(client, id, request.action)  // fail-closed re-assert
10551  if (!cancelRoundRolloutLockRequirementsEqual(rolloutLock, rolloutLockUnderRowLock)) {
10555    'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED',  // inside `throw new ServiceError(…, 409, …)` at :10552-10556
10556  }
```

The extra ~10-15 line growth between the pre-read and the re-assert (vs. the original `a02930896`
snippet) is u3's own `dispatchCancellationOutcome` hoist (§3.18's surface-half plumbing), inserted in
this exact span; nothing about the CONTROL FLOW this snippet documents changed — verified by re-running
the source-order census (Q-F leg 3) itself, which is still green (this file's own §10, `metasheet2_
lock_c2_docs` rerun in the verification MD).

`resolveCancelRoundRolloutLockRequirementV1` is **the same function called twice** (`:922` the
definition, `:10522` the pre-read, `:10550` the re-assert) — never two hand-written conditions
(census Q-F leg 3/4 is the source-order + same-row proof of this). It resolves through
`attendance_requests` via `classifyAttendanceRequestForInstanceV1(client, instance, { lock })`, the
SAME predicate the row-locking path already uses (parameterised with a lock mode rather than
duplicated) — census Q-F's mutation M-11 kills BOTH Q-E leg 3 and Q-F leg 4 in one shot when the
shared `ORDER BY` is broken, which is the measured proof it binds to production rather than a copy.

**The axis §3.9.2 records this lane getting wrong on the first attempt, and fixing in the same
lane**: the resolver as first shipped (`a81c28d97`) took only the instance id, so EVERY action on a
cancel round over an attendance-owned original resolved `required` — including `reject`/`revoke`
(which never call W4 and would have gained SERIALIZABLE and an org-wide advisory lock they never
needed) and the five forbidden verbs (which would have taken the lock **before**
`assertCancelRoundActionAllowed` rejects them). Fixed by making `action` a parameter checked FIRST,
before any query — only `'approve'` can resolve `required` (Q-F leg 5, with its own positive control
on the same fixture).

`40001`/`40P01` mapping to `503 CANCEL_ROUND_DISPATCH_CONTENDED` is gated on
`rolloutLock.kind === 'required'` specifically so a non-cancel-round dispatch's SQLSTATE handling
does not change at all — a repo-wide retry-semantics change smuggled into a cancel-round commit is
exactly what `feedback_retry_semantics_not_verbs.md` names, and this slice does not make it.

### 4.3 判据 II's SECOND prerequisite: the cancel adapter's own row-lock order (verification §3.10)

Independent of the two locks above: the lock's global order also places `attendance_requests`
**after** the original document instance (lock:110, lock:227), and the shipped cancel adapter
(`executeRequestCancel`, `plugins/plugin-attendance/index.cjs`) ran the opposite —
`attendance_requests` first. This is a **second, independently live** cycle (not a hypothetical one):
core's `classifyAndLockAttendanceRequestForInstance` locks `attendance_requests` with the
`approval_instances` row already `FOR UPDATE`-held (`dispatchAction`'s entry, `bulkReassignApprovals`
`ApprovalProductService.ts:9483` (was `:9509` in this document's own `a02930896`-era correction,
itself already a correction of the verification MD's original `:9346`; re-checked a second time
post-merge for this 定稿 pass, §10) — and `w4c3b-central-approval-hooks.ts:247`), while the plugin adapter locked
`attendance_requests` FIRST and `approval_instances` SECOND — both reachable on the SAME `(request,
instance)` pair while the request is `pending`.

**Fix, this tree (`plugins/plugin-attendance/index.cjs`, `executeRequestCancel`)**: the
`approval_instances` (original) `FOR UPDATE` moved to `:35128`, ahead of the `attendance_requests
… FOR UPDATE` now at `:35137` — verified in this tree by `grep -n "FOR UPDATE" ` over the function
body: the instance lock's line index precedes the request lock's.

Census **Q-G**, four legs on the same census file: LEG 1 constructs the PRE-FIX order by hand against
the CURRENT core order and gets a real, deterministic `40P01`; LEG 2 is the positive control (shipped
order, both sides reach a defined outcome, contention proven via `pg_stat_activity.wait_event_type
='Lock'` polling rather than a JS-side flag — §3.10.5 records that the first version of this control
was vacuous and `M-34` (renumbered from `M-12` in the verification MD's 2026-09-18 定稿 pass, §0
R-11 there — it collided with §3.9.5's own `M-12`) is what caught it); LEG 3 is a both-ends-anchored source scan; LEG 4 is the
mechanical enumeration that also **pins the decision adapter as still request-first** (§1.1 above),
so a future reorder there is forced to update this census rather than silently closing or silently
forgetting the shape.

**Disclosed behaviour change** (§3.10.6): under concurrent mutation of both rows between `prepare`
and `execute`, the 409 message changes from `'Request changed during cancellation preparation'` to
`'Approval changed during cancellation preparation'` — same status, same code
(`REQUEST_STATE_CONFLICT`), message only, and only in a race no test asserts the precedence of.

### 4.4 Net lock order this slice achieves, against the lock's suggested abstract order

| Lock's suggested order (lock:110, lock:227) | This slice's actual sites |
|---|---|
| rollout/advisory 锁 | `dispatchAction`'s pre-read + `acquireAttendanceCalculationRolloutLock` (§4.2), FIRST statement after `BEGIN ISOLATION LEVEL SERIALIZABLE` |
| 轮次引擎实例 | the round's own `approval_instances` row — the SAME `FOR UPDATE` `dispatchAction` already took at entry (no second lock; the round IS the dispatched instance) |
| 原单据实例 | `evaluateCancelRoundFinalInLock`'s own lock on the ORIGINAL document (§4.1). When `redeem` proceeds, C-1 runs on the SAME transaction client (lock §3 C-1 「仅移交连接与事务生命周期的所有权」) and its cancel adapter also takes `approval_instances … FOR UPDATE` on that SAME row (§4.3) — this is a **re-acquisition of a lock this transaction already holds**, a no-op under Postgres row-lock semantics (not a second, independent lock, and not a self-deadlock risk), not two separate locks on two different rows |
| `attendance_requests` | the cancel adapter's now-second `attendance_requests` lock (§4.3) |
| 余额批次 | `reverseLeaveBalanceDeduction`'s own row scan — not independently re-ordered by this slice; no lock census leg targets it |

Two residual, disclosed gaps (not silently closed by this table): the **decision** adapter is still
`attendance_requests`-first (§1.1, §4.3's LEG 4), and the two relations
(`attendance_schedule_dispatch_requests`, `attendance_request_calculation_snapshots`) the cancel
adapter locks BETWEEN the ratified pair carry no rank in lock:227's class list (§3.10.1) — both
flagged for owner registration in §7/§8 below, not ordered by invention.

## 5. Seams with existing code (file:line, this tree)

| Seam | File:line | What it does |
|---|---|---|
| Rollout-lock resolver (the "same predicate, different lock mode" seam) | `packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts` — `classifyAttendanceRequestForInstanceV1(client, instance, { lock })`, thin `classifyAndLockAttendanceRequestForInstance` wrapper pinning `lock:'for_update'` | the ONE instance→request predicate, parameterised rather than duplicated (§4.2) |
| `dispatchAction` entry restructure | `ApprovalProductService.ts:10506-10556` (was `:10496-10541`; §10) | pre-read, conditional SERIALIZABLE, rollout-lock-first, fail-closed re-assert (§4.2) |
| Outlet #5′ (new anchor) | `ApprovalProductService.ts:12166-12233` (was `:12150-12220`; §10) (the `if (resolution.status === 'approved' && isCancelRoundInstance(instance))` block at `:12166` through its `closeCancelRoundSystemTerminalInTxn` call and early `return`, closing brace at `:12233`) | judgment IV's branch decision + persistence close; the fall-through for `redeem` (§2.3) |
| C-1 port (new file) | `packages/core-backend/src/core/attendance-cancellation-execution-port.ts` | `AttendanceCancellationExecutionPort` registry — modelled on `core/workday-calendar-port.ts` (§3.1); the registered surface is the WHOLE `AttendanceRequestOperationBoundaryV1`, deliberately not narrowed, per lock §3 C-1's "仅移交连接与事务生命周期的所有权" |
| Attendance cancel adapter, lock reorder | `plugins/plugin-attendance/index.cjs:35107` (`executeRequestCancel`), `approval_instances FOR UPDATE` now at `:35128`, `attendance_requests FOR UPDATE` now at `:35137` | §4.3 |
| The plugin's port bind | `plugins/plugin-attendance/index.cjs`, immediately after `w4RequestOperationBoundary = …` is built | wires the concrete boundary into the new core-side registry (§3.1) |
| W4 seal path (the `unrecoverableExpired` persistence channel) | `packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts:918-921` (`sealAttendanceResultOperationV1(trx, identity, { responseSnapshot: jsonValue(result.response), resolvedRequestId })`) → `w4c0-operation-registry.ts:756-790` (`UPDATE attendance_result_operations SET state='completed', response_snapshot=$4::jsonb …`) | runs UNCONDITIONALLY (only the outbox enqueue above it is posture-gated) on the CALLER's own `trx` — which, on the redemption path, is the approval side's transaction, so the seal commits atomically with the approve (§3.16.1) |
| Bridge / trigger surfaces this slice does **not** touch | `ApprovalBridgeService.ts:1077` (outlet #8's guard, phase-1), completion-event build/enqueue (`buildCompletionEvent` / `enqueueApprovalEventIfDurable`, the ordinary approve path the `redeem` branch falls through into, §2.3) | listed here to make the negative explicit: this slice adds no new Bridge dispatch path and no new completion-event shape — `redeem` reuses the existing enqueue verbatim, and #5′'s `blocked`/`expired` branches enqueue nothing (that IS 判据 IV's 「零完成事件」) |
| The 账侧 twin-fixture compare | `packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts` (appended, §3.15) | drives the REAL `POST /api/attendance/requests/:id/cancel` route (`plugins/plugin-attendance/index.cjs:38634`) as fixture B against the redemption path as fixture A |

## 6. Owner-ratified decisions this slice relies on (quoted verbatim from the lock's own RATIFY header)

Per instruction, this section quotes the lock's 抬头 RATIFY record without paraphrase —
`approval-change-request-design-lock-draft-20260915.md:3-8`:

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:
>   分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、
>   #5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审
>   全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **漂移核对(85ddd2926 → 00781e68b)**:本锁引用的核心文件(`routes/approvals.ts`、
>   `ApprovalProductService.ts`、`approval-seat-authorization.ts`、`AuthService.ts`、`rbac/*`、
>   `plugin-attendance/index.cjs`、迁移目录既有文件、`plugin-tests.yml`)**字节相同**;唯二有位移的是
>   `packages/core-backend/src/index.ts`(整体 +8 行:`:1719→:1727` jwt 中间件、`:1725→:1733`
>   correlation 增强、`:1777→:1785` `app.use(approvalsRouter(`、`:2046→:2054`
>   correlationErrorHandler、插件 `addRoute` 的 catch `:705-711→约 :712-718`)与
>   `multitable/automation-service.ts`(import 行 `:108` 不变,布尔消费方 `:1298-1310→约 :1316` 区);
>   `run-required-web-tests.sh` 的 exec 行只多了 stock-prep 令牌;新增迁移
>   `…create_recovery_archive_derived_effects.ts` 与本锁无关。锁文正文保留基线行号,以本条为准换算。
> - **裁决结果(按建议值)**:§9-1 模型与三份契约按 v5.9 ratify;§9-8 Q1 轮次身份 =
>   `workflow_key='approval.cancel-round'` + `source_system='platform'`(**采纳**);§9-9 允许集 =
>   {approve, reject, revoke, comment},拒 transfer/add_sign/reduce_sign;§9-10 首期 DDL/seed 三件 +
>   迁移与写入方同一发布 = **接受**;§9-11 C-3 情形 2 边界**接受引擎现状**,专用定义 `approvalMode` 取
>   会签 `'all'`(与 §9-3 G3 联动:一个定义一种模式);§9-2/3/4/5/6/7 按锁文正文的建议值(C-1 status 择定;
>   **G1–G4 按 §2 收敛版确认**,其中 G3 与 §9-11 联动——一个专用定义一种模式、首期会签 `'all'`,G2 的
>   时间锚按 §2 正文;锁序全局约定;策略默认值与 `suite` 映射/多套件优先级;首期范围 = 请假撤销;
>   L6-B/L6-C 解冻方式)。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR
>   一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

**This slice's implementation choices that fall inside the ratified decisions above**: the C-3
情形 2 边界「接受引擎现状」(§9-11) is what makes 判据 IV's `expired`/`blocked` outcomes land on the
EXISTING `rejected` engine state with a system sentinel rather than a new engine-level state (lock §3
C-3 row 3/4, restated in §2.2 above); §2-G2's time anchor (§3.2) implements the RATIFY bucket's "G2
的时间锚按 §2 正文" line directly.

**Owner items named by lock §9 that this slice does NOT resolve** (unchanged from phase 1's own list,
carried forward because this slice's diff does not touch any of them): §9-4 锁顺序全局约定 remains a
review suggestion per lock §13's own framing — this slice's Q-D/Q-E/Q-F/Q-G legs SUPPORT the
suggested order and demonstrate two live cycles closed by following it, but do not convert the
suggestion into a ratified fact; §9-5 production `suite` mapping source is untouched (still the
phase-1 `metadata.suite` fixture placeholder); §9-7 L6-B/L6-C thaw mechanism is untouched.

## 7. 留给后续切片的项

Lock §3's **C-3 轮次终结契约** is, in the lock's own three-contract naming (C-1/C-2/C-3), fully
delivered by this slice's 判据 IV work (§2.2's `expired`/`blocked` rows, §3.1–§3.8 of the
verification MD) — there is no separate future "C-3 slice" in the goal document's own slice table
(`goal-three-locks-full-implementation-20260918.md:9` lists only C-1 合同层 and C-2 兑现与收口 under
线 "C 撤销"). What follows are the genuine residuals the C-3 contract's own delivery left open,
listed under this heading because the task instruction names it "留给 C-3 的项" and these are the
items that attach to that contract specifically — plus, in the second table, the broader residual
list that attaches to 判据 II / the slice as a whole rather than to C-3 narrowly.

### 7.1 Items specific to the C-3 (轮次终结) contract's own delivery

- **卡片失效 for a carded cancel round** (C-3 row 3's third column) — possible, pre-existing, unswept
  (verification §3.8). Not a regression this slice introduces; not verified closed either.
- **⚠️ CLOSED post-merge (u2, verification §3.20) — was "only ONE of the two terminal outcome
  writers for the `applied` transition is probed".** §3.14's I3 mutation drives the round through
  the #5′/C-3 closure writer; the C-2 success writer (`ApprovalProductService.ts:9118-9131`, was
  `:9106-9112`, inside `redeemCancelRoundInTxn`, `SET outcome = 'applied'` at `:9120` (was `:9109`);
  re-checked post-merge, §10) now has its own probe too: a
  dedicated case whose `createCancelRoundInstance` call is the FIRST statement after the redemption
  returns, so the I3 clause itself — not `round.outcome === 'applied'`'s later end-state check —
  carries the mutation (M-30: the `applied` write and its `rowCount` guard deleted together, same
  shape as §3.14's M-21; 5 red / 14 green, all four other reds dying on their own `applied`
  assertions, confirming none of them could have carried it). What this probe does NOT establish,
  stated as its own fixture premise: it measures the SLOT release with a test-double cancellation
  port that writes nothing, so whether a REAL-boundary second round would instead be refused for a
  document-status reason is unanswered (verification §3.20, §4).
- **R1's count (lock §8 期 1, "9 处") does not yet include the new #5′ anchor.** #5′ is an outlet
  anchor for judgment IV, not a chokepoint guard, so it takes no `CANCEL_ROUND_OUTLET_FORBIDDEN`
  negative control by construction — whether §8 期 1's R1 count should grow to 10 to register it is
  an owner question, raised alongside the #5′ registration itself (verification §4).
- **`CANCEL_ROUND_WINDOW_ANCHOR_MISSING`'s refuse-to-decide design choice** (§3.2) is an implementer
  choice the lock does not dictate (the lock names the §2-G2 anchor, not its absence) — flagged for
  owner registration in the same class as the redemption suite's other erratum-flagged choices.

### 7.2 Broader residuals (attendance line, next slice, or owner scope decisions)

- The decision-adapter reorder and the writer-syntax lock census (§1.1, §4.3/§4.4) — owed to the
  attendance line.
- `filterBulkReassignDiscoveryForAttendance`'s nondeterministic org resolution (§1.1, §3.3d) — owed
  to the attendance line as a finding, same family as
  `finding_attendance_two_authorization_sources_diverge.md`.
- The two unranked relations under lock:227's class list (§4.4) — owed to owner registration, not
  invented an order for.
- `posture resolution` and `authorization` as assertions in their own right inside the real W4
  boundary — they RUN on every case that exercises the real boundary (§3.12, §3.16) but nothing pins
  their outcome as a dedicated assertion (verification §4).
- A twin pair in a non-`legacy_projection_only` (i.e. `authoritative`/`shadow`) org for the 账侧
  compare (§3.15.11) — needs rollout-registry fixture work no case in this file does today.
- FE / notification: C-3's 「卡片失效、端点返回一致」 column, entirely untouched.

## 8. Owner 待裁项

- **`unrecoverableExpired` 的用户面呈现 — ⚠️ HALF CLOSED post-merge (u3, verification §3.18), was
  fully OPEN.** The PERSISTENCE half was already closed at this document's own base:
  `sealAttendanceResultOperationV1` writes the whole adapter response — `data.reversal`, and
  therefore `unrecoverableExpired`, included — into `attendance_result_operations.response_snapshot`
  on the approval side's own transaction, committing atomically with the approve (§3.16.1, measured
  at **120**, not `0 === 0`). u3 closes the SURFACE half with a flagged DEFAULT rather than leaving
  it open: `UnifiedApprovalDTO.cancellationOutcome` (immediate, action-response scope) and the
  approve audit row's `metadata.cancellationOutcome` (durable, read back via the history endpoint) —
  THREE status tokens, not two (`cancelled` / `cancelled_with_unrecoverable_expired` /
  `cancelled_reversal_unreported`), so a caller can never confuse "nothing to reverse" with "the
  channel isn't wired". This IS an owner-visible default, not a ratified contract: `getApproval`
  does not project the field (a reload reads it from the history endpoint, not the DTO itself), and
  no FE surface renders it (`grep -rn "cancellationOutcome\|unrecoverableExpired" apps/web/src` → 0
  hits, verification §3.18.4). An owner who wants a different shape — or the field projected onto
  `getApproval` itself, a hot read path this default deliberately does not touch — replaces it; the
  choice is documented on the type and the DTO field themselves, not only here (verification
  §3.18.3, §3.18.7).
- **`attendance-parity.db.test.ts` 退役 — ⚠️ VERDICT UNCHANGED post-merge, census WIDENED (u3,
  verification §3.17).** The filename is retired as a deliverable (§3.15.0: it is an implementer
  invention the phase-1 design MD mis-attributed to lock:169, which names a requirement and no
  filename), and the requirement it stood for is implemented in the already-wired
  `approval-cancel-round-redemption.db.test.ts` (§3.15). u3 widened the provenance census from two
  sources to four — the lock (0 hits), phase-1 design MD (4), phase-1 verification MD (8), **and PR
  #5851's own body (1, not previously checked)** — and found the filename named in that fourth,
  implementer-authored source too. The verdict does not move: a Draft PR body opened by this same
  implementation lane is the identical provenance class as the other three, not an owner
  ratification, so 「只有任务书文本点名」 would have been false but 「no owner-ratified source names
  it」 still holds. u3 also confirmed there is nothing TO restore — `find . -iname
  "*attendance-parity*"` and `git log --all --diff-filter=A -- '*attendance-parity*'` both return
  empty, so no ref ever created the file — and re-measured all four CI pins against the final
  seven-file set (unperturbed; §3.17.3).
- **The acting identity for C-1's audit row** (`approval_records.actor_id` on the `revoke` audit row
  C-1 writes) — this slice's redemption hook passes the cancel round's REQUESTER (verification
  §3.11.4), argued from 账侧 parity (the existing W4 path's actor is the requester) and from
  `prepareRequestCancelIdentity`'s cross-user posture requirement (the approver lacks
  `attendance_admin`, so passing the approver would dead-end the branch for exactly the population it
  exists for) — but the lock itself never names whose actor id this row carries. **The 账侧 compare
  in §3.15 is CONDITIONAL on this**: if the owner rules the audit row must instead carry the approver
  or a system sentinel, `approval_records.actor_id` stops normalising against the W4-path fixture and
  that case goes RED BY DESIGN (§3.15.7) — that is the case's oracle, not a bug to silently fix by
  widening its exclusion table.
- **账侧 provenance divergence — `approval_records.ip_address`/`user_agent`** are `null` on the
  redemption path (there is no HTTP request of the requester's own to attribute) and populated on the
  W4 HTTP path (§3.15.5). Whether 逐字节等价 (lock §8 期 1) is satisfied by this honest absence, or
  whether the audit row must instead carry a synthetic provenance marker so the two paths are
  distinguishable by INTENT rather than by an absence, is an owner call; nothing on this branch
  depends on which way it is settled.
- **Adopting `classifyAndLockAttendanceRequestForInstance` as the rollout-lock pre-read's org
  source, over `filterBulkReassignDiscoveryForAttendance`** (§4.2, verification §3.3c point 3) — Q-E
  leg 3 shows the two predicates disagree, and the rejected one ADMITS an org the adopted one
  REJECTS, so this is flagged as a contract-shaped choice
  (`feedback_second_narrower_artifact_is_contract_narrowing.md`, applied in the direction of widening
  what would have been accepted) rather than a routine "reuse the existing helper" implementation
  decision. Nothing on this branch depends on the other predicate; raised so it is an owner-visible
  choice, not a silent one.
- **§8 期 1's R1 count** (see §7.1) — whether it should grow from 9 to 10 to register outlet #5′.

## §9 合流后待更新 — ⚠️ DONE (merge commit `1c98ff937`, verified against the merged tree, not re-guessed)

This document was written from the sub-lane's own read of `a02930896`. u1/u2/u3 have since been
merged `u1 → u3 → u2` onto `feat/approval-cancel-round-phase2`; every update this section originally
called for has now been made, in place, at the citations named below (not re-summarized only here):

- **u2 (tests)**: 账侧字节等价 + I3 + the `approve`-成员钉, landed. **§2.2's `pending → applied` row**
  now cites §3.20 for the round-row's own I3 probe; **§7.1's "only one terminal writer is probed"
  bullet flipped** to closed (M-30, 5 red / 14 green); **§4.4's net-lock-order table needed no
  change** — u2 added no lock reordering, only test coverage over locks §4.1–§4.3 already ordered.
  Two NEW `it()` cases landed in the existing `approval-cancel-round-redemption.db.test.ts` (no new
  suite file, no census/s6a re-pin owed): the §9-9 member-pin (§3.19) and the C-2 I3 half (§3.20),
  plus §3.21's step-by-step disposition and §3.22's ⑥ divergence measurement (both prose + assertions
  inside the existing 账侧 case, not new `it()` blocks). §1's main table gained four rows for these.
- **u3 (呈现 + 对账)**: `unrecoverableExpired`'s surface half and the `attendance-parity.db.test.ts`
  retirement follow-through, landed. **§8's first two bullets are rewritten** (呈现: HALF CLOSED with
  a flagged default, not OPEN; parity retirement: verdict UNCHANGED, census WIDENED to four sources).
  **§1.1's two matching bullets updated** to point at the same resolution instead of a placeholder.
  §1's main table gained two rows (§3.17, §3.18).

**Merge-time collision this section did not anticipate, resolved separately, not by this document**:
u2 and u3 each independently numbered their own new verification-MD sections `3.17`–`3.20` (and
mutation IDs `M-25`–`M-28`) starting from the SAME base (`a02930896`'s last section, `3.16`, and last
mutation, `M-24`). The merge kept u3's numbers as-is (`3.17`/`3.18`, `M-25`–`M-27`, since u3 was
merged first) and renumbered every one of u2's own sections and mutation IDs — headers, forward
references in earlier tables (two stray cells outside the git-conflicted hunks), and the running §4
summary — to `3.19`–`3.22` / `M-29`–`M-32`. This document's own citations above already use the
POST-RENUMBER values; the verification MD's "合流记录" section (end of file) has the full account.

## §10 逐 file:line 复核(2026-09-18 定稿 pass, HEAD `d462677bd`)

**Why this pass exists**: this document's header states every citation was checked against
`a02930896`. That commit predates the `u1→u3→u2` merge (`1c98ff937`), whose own diff stat shows
`ApprovalProductService.ts` changed by **41 net lines**, `attendance-cancellation-execution-port.ts`
by **94**, and `approval-bridge-types.ts` by **17** — none of which this document's citations had been
re-checked against until now. `git diff --stat 1c98ff937..HEAD` is docs-only, so checking against the
current tree is equivalent to checking against the merge commit itself.

**Method**: for each named symbol or code block this document cites, `grep -n` (or `sed -n` for a
specific line's content) against the current tree — not a re-derivation of the claim, only of the
line number. A citation is "drifted" when the symbol/statement still exists, semantically unchanged,
at a different line; this pass found none that had actually moved in MEANING, only in POSITION.

**Files confirmed UNCHANGED (byte-accurate citations, re-verified, nothing to correct)**:
`plugins/plugin-attendance/index.cjs` (`:35107`, `:35128`, `:35137`, `:37626`, `:37647`, `:38634`),
`ApprovalBridgeService.ts` (`:1077`), `w4c3b-central-approval-hooks.ts` (`:247`),
`w4c3b-request-operation-boundary.ts` (`:918-921`), `w4c0-operation-registry.ts` (`:756`, the
`sealAttendanceResultOperationV1` definition; `:790` its closing brace), and
`attendance-cancellation-execution-port.ts:69` (`deriveCancelRoundW4OperationIdV1`'s definition,
despite that file's own 94-line growth — the growth landed below this line). None of these were
touched by u2's merge (test-file-and-doc only) or appear in u3's own diff list except the port file,
whose specific cited line held.

**`ApprovalProductService.ts` — every citation this document makes into that file, corrected**:

| Symbol / citation | This document said | Verified real (HEAD `d462677bd`) | Command |
|---|---|---|---|
| `deriveCancelRoundRoundPolicy` def | `:339` | `:341` | `grep -n "function deriveCancelRoundRoundPolicy"` |
| `APPROVAL_CANCEL_ROUND_SYSTEM_ACTOR` const | `:859` | `:861` | `grep -n "APPROVAL_CANCEL_ROUND_SYSTEM_ACTOR ="` |
| `resolveCancelRoundRolloutLockRequirementV1` def | `:920` | `:922` | `grep -n "export async function resolveCancelRoundRolloutLockRequirementV1"` |
| `evaluateCancelRoundFinalInLock` def | `:8751` | `:8753` | `grep -n "private async evaluateCancelRoundFinalInLock"` |
| `closeCancelRoundSystemTerminalInTxn` def | `:8878` | `:8880` | `grep -n "private async closeCancelRoundSystemTerminalInTxn"` |
| `redeemCancelRoundInTxn` def | `:8996` | `:8998` | `grep -n "private async redeemCancelRoundInTxn"` |
| C-2 success writer (`SET outcome = 'applied'`) | `:9109`, block `:9106-9112` | `:9120`, block `:9118-9131` | `sed -n` around `outcome = 'applied'` |
| `dispatchAction` restructure — pre-read var → re-assert throw | `:10496-10541` | `:10506-10556` (method itself opens `:10494`) | `grep -n` on each of: `let rolloutLock`, `BEGIN ISOLATION LEVEL SERIALIZABLE`, `acquireAttendanceCalculationRolloutLock(`, the `FOR UPDATE` literal, the re-assert call, `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED` |
| `bulkReassignApprovals`'s `approval_instances FOR UPDATE` | `:9509` (this doc's own prior correction of verification MD's `:9346`) | `:9483` | `grep -n "async bulkReassignApprovals("` then `sed -n` forward to the `FOR UPDATE` literal |
| `pending → rejected` round-outcome write | `:11750` | `:11766` | `grep -n "outcome = 'rejected', ended_at"` |
| `pending → withdrawn` round-outcome write | `:11263` | `:11279` | `grep -n "outcome = 'withdrawn', ended_at"` |
| outlet #5′ if-block (open → `closeCancelRoundSystemTerminalInTxn` call → `return` → close) | `:12150` / — / — / `:12220` | `:12166` / `:12211` / `:12232` / `:12233` | `grep -n "isCancelRoundInstance(instance)) {"`, `grep -n "await this.closeCancelRoundSystemTerminalInTxn(client, {"`, `grep -n "return closedApproval$"` |

**What this table does NOT claim**: it does not re-verify every prose sentence's SUBSTANCE — only
that the cited line still holds the cited content. Every drifted citation above was checked to still
name the SAME symbol or statement the surrounding prose describes; none turned out to point at
unrelated code after the merge. The corrected numbers are also applied in place at each citation's
own location earlier in this document (`NNNN (was MMMM)`), so this table is a consolidated summary,
not the only place the fix lives.

**One puzzle this table does not resolve, and does not need to**: the offset is not uniform (+2 near
the top of the file, growing to +14/+16 by the redemption/outlet region, and a non-monotonic -26 at
`bulkReassignApprovals`, whose own citation had already been corrected once before, at `a02930896`,
for reasons unrelated to this merge). The mechanism (where u3's ~41 new lines landed) was not traced
line-by-line beyond what the table above needed; the verified REAL numbers are what matters for a
reader following a citation, not a reconstruction of every intermediate edit.
