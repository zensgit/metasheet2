# Approval Cancel-Round — Phase 1 (C-1) Design (2026-09-18)

Branch `feat/approval-cancel-round-phase1`. Originally written at HEAD `a32b2e015`; edited by several
later fix passes since (Part F's fix, round-2's Part G, round-3's Part H among them), each of which
re-derived the specific citation(s) it touched against its own HEAD at the time — not a claim that
every pass re-swept every citation in this document; each pass's own verification-MD Part states what
it actually re-derived. **This header
deliberately no longer pins a single "HEAD as of" SHA** — every prior version of that line went stale
the moment a later pass landed without also rewriting it here, which is itself a finding the
verification MD's Part F1 and Part G's G3 both record, and which round-3's gate report §9 item 8
suggested resolving exactly this way ("改成「见 git 历史」这种不会腐烂的写法"), adopted here in
round-3's own fix pass (verification MD's Part H4). For the citations' actual currency, read the
verification document's own Part covering the pass in question (each Part states and verifies its own
starting HEAD) rather than this header.
Source of authority: `approval-change-request-design-lock-draft-20260915.md` v5.9 (RATIFIED
2026-09-18; see its own 抬头 RATIFY record, quoted verbatim in §7 below — this document does not
restate or paraphrase it). Goal definition: `goal-three-locks-full-implementation-20260918.md`
(slice "C 撤销 / C-1 合同层"). Supplementary gate checklist:
`impl-supplementary-gate-checklist-20260918.md`.

All lock line-number citations below use the form `lock:NNN`, meaning "line NNN of the lock file as
it stands today" (the lock's own §-numbers are the stable identity; line numbers can drift between
lock revisions, so every citation here was re-read against the copy on disk at the time of writing,
not carried over from an older draft). All *code* file:line citations **in this document's own
prose** were re-derived by `grep`/`sed` against the tree at the HEAD named above at the time each
passage was last edited, not copied from the lock's own evidence table (§10/§14), which is pinned to
the lock's pre-implementation baseline `f274316f6` and was stale by `+447` lines in
`ApprovalProductService.ts` alone as of `a32b2e015` (`git diff --stat 89f1ecdee...HEAD`). This
claim covers citations written into *this file*; it is not a claim that every `file:line` comment
anywhere in the source tree has been swept for accuracy — that broader sweep is what
`impl-gate-C-slice1-round2-20260918.md` did mechanically (121 citations across this document and the
verification MD), and it is what found the two source-code comment pointers this document does not
itself contain (fixed instead in `ApprovalBridgeService.ts` and `apps/web/src/approvals/api.ts`
directly; see verification MD Part G, §G3). Where a lock citation gives a baseline line number for
context, this is marked.

## 1. Scope of this slice (C-1 合同层)

Per the goal document's slice table (`goal-three-locks-full-implementation-20260918.md:9`), C-1 covers:
**轮次表 + Q1c 包 + 定义 seed + `createCancelRoundInstance` + 九处守卫 + 判据 I/I″/III + 六个真库测试
+ CI 接线 + 锁序 census 四对**. Mapped to the lock's own phase table (§8, lock:169, 期 1):

- **DDL/seed** (lock §4, lock:134-144; three-part list per lock §14.1, lock:333): `approval_rounds`
  table (lock:136-142) + the Q1c attendance FK pairing (lock §14.3 #10/#11, lock:371-372) + the
  dedicated published-definition seed chain (lock §14.1, lock:333).
- **Creation path**: `createCancelRoundInstance` — judgment I (lock §14.1, lock:339, "经专用路径 ⇒
  谓词真") and I″ (lock §14.1, lock:336-337, run-time-completeness judgment).
- **Outlet guards**: the 8 chokepoints of lock §14.3's table (lock:359-376) that must reject a
  cancel-round instance outright, *plus* the creation-time suite gate (#14, lock:375).
- **判据 III** (lock §14.2, lock:344): the two *allowed* non-approve outlets (A4 revoke, A7 reject)
  terminating the round row in the same transaction.
- **Lock-order census**: Q-A/Q-B/Q-C (lock §12, lock:281-297) constructed with real Postgres
  connections, forward + reversed order, positive controls.

### 1.1 Explicitly NOT in this slice (deferred to C-2 "兑现与收口")

Per the goal document (`goal-three-locks-full-implementation-20260918.md:10`) and this lane's own
verification record (round-2 doc, §5 "Decision 3"):

- **判据 II** (lock §14.2, lock:347 — the approve-redemption contract: C-1's real attendance
  cancellation executing through the W4 external transaction entry point, the round moving to
  `applied`, the original instance to `cancelled`, exactly one completion event). **Not
  implemented.** The C-2 挂点 (lock:346, "先于 `:11070`" at the lock's baseline — the approve
  fall-through outlet, #5 in §14.3) is not yet wired to any cancel-round-specific branch in this
  tree: `grep -n "isCancelRoundInstance" src/services/ApprovalProductService.ts` shows it consulted
  only at outlet #3 (`:9627`, node-timeout scanner) and nowhere between the action-judgment site
  (`:9928`) and the approve-outlet's own state write — confirmed by inspection, not merely absent
  from a grep for a made-up symbol.
- **判据 IV** (lock §14.2, lock:345 — C-3's system-side `expired`/`blocked` close, outlet #5′). **Not
  implemented.** No code path in this tree writes `approval_rounds.outcome` to `'expired'` or
  `'blocked'`: `grep -n "outcome = 'expired'\|outcome = 'blocked'" src/services/*.ts` → 0 matches
  outside the DDL's own CHECK-clause enumeration.
- **C-1's own business-side change** (lock §3, lock:87-90 — the W4 external transaction entry point
  the attendance line must add so an *external* client can drive `requestCancelAdapter.execute`
  under the same W4 operation protocol while only taking over connection/transaction ownership).
  Not touched: `git diff 89f1ecdee...HEAD -- plugins/plugin-attendance/index.cjs` shows exactly two
  edits (the mirror constant + the defensive assertion in `upsertAttendanceApprovalInstance`, and
  the five FK-pairing writer edits) — no new external-entry-point function, no call into
  `w4c3b-request-operation-boundary.ts` from this slice's own code.
- **`attendance-parity.db.test.ts`** (byte-identical-outcome test named in the lock's phase-1 door,
  lock:169). Does not exist in this tree: `find . -iname "*attendance-parity*"` → 0 results.
- **R1's #14 suite-forbidden negative control's production `suite` source** (lock §9-5, lock:176):
  phase 1 reads `suite` off the *original instance's own* `metadata.suite`
  (`ApprovalProductService.ts:8365`), defaulting to `'leave'` when absent — a fixture/seed
  input, not a production template→suite mapping table. The lock itself defers "生产映射表" to §9-5
  (an item the RATIFY header's §9-2..§9-7 bucket covers only at the *policy* level, not "which
  table joins template to suite" at the *schema* level) — left as an owner/implementer item for a
  later slice, not silently assumed closed.
- **修改 (amend 轮)**, **加班撤销**, **批量**, **legacy 路由承载 cancel 轮功能**, **委托人发起** — all
  named out of scope by the lock itself (§7, lock:159-162) for the *entire* first-slice program, not
  specific to this branch's cut.

## 2. Data model and constraints

Three-part DDL/seed set per lock §4 (lock:134, "首期 DDL/seed **三件**"), all three landed as
migrations in this tree:

### 2.1 `approval_rounds` (`src/db/migrations/zzzz20260918090000_create_approval_rounds.ts`)

| Column / constraint | Lock line | This tree |
|---|---|---|
| Column list, types, `kind IN ('cancel')`, `outcome` 6-value CHECK, nullable `ended_at`/`block_reason`/`policy_snapshot_at_decision` | lock:136-139 | migration lines 102-113 — verbatim column-for-column match |
| `id` is app-generated `apr_…`, not DDL-level | lock:140 | not in DDL; generated at `ApprovalProductService.ts:8317` (`` `apr_${crypto.randomUUID()}` ``) |
| FK column types follow the referenced column (`approval_instances.id` is `text`) | lock:141 | `document_id TEXT NOT NULL REFERENCES approval_instances(id)`, `engine_instance_id TEXT NULL REFERENCES approval_instances(id)` — migration lines 103, 105 |
| Partial unique index `uq_approval_rounds_pending_document` (I3) | lock:142 | migration lines 120-122, `WHERE outcome = 'pending'` |
| `policy_snapshot_at_create` content = `{ definitionPolicy: <original instance's policy_snapshot verbatim>, roundPolicy: { windowDays, suite } }` | lock:143 | `ApprovalProductService.ts:8505-8506` — object literal matches exactly; no `capPerDocument` key (lock v5.5 struck it as an amend-only field, lock:323) |
| Non-blank CHECK convention: unanchored `col ~ '[!-~]'`, not the anchored `^[!-~]+$` form | lock:141 (via migration's own doc comment, which cites the two repo precedents) | migration lines 115-117, three CHECKs on `id`/`document_id`/`requested_by` — a **deliberate, disclosed divergence** from the file's first cut (commit `c9c3af9b7` switched conventions after finding the anchored form would reject any non-ASCII `requested_by`), not a silent choice |
| Lock names exactly one index (the partial unique) | lock:142 | migration's own doc comment (lines 87-92) records that an earlier draft carried two extra convenience indexes and that commit `32ec1a1e8` dropped them as beyond-lock scope — the DDL-gate discipline (lock is read as an exhaustive DDL list) applied literally |

### 2.2 Dedicated published-definition seed chain (lock §14.1, lock:333)

`src/db/migrations/zzzz20260918100000_seed_approval_cancel_round_published_definition.ts` inserts
exactly one `approval_templates` row, one `approval_template_versions` row, one
`approval_published_definitions` row, content sourced from
`src/db/seeds/approval-cancel-round-published-definition.ts` (shared with the creation path and any
test fixture, so there is one definition, not two hand-copied JSON literals). Idempotent by fixed
literal id with an `ON CONFLICT DO NOTHING` **plus a read-back verifying the existing row's content
matches**, not idempotency-by-silence.

Runtime-policy values pinned, each traced to its lock citation:

| Value | Lock citation | Seed file |
|---|---|---|
| `allowRevoke: true` | lock §14.1, lock:334 ("不置 `allowRevoke = true`…判据 III 的 revoke 半边永远到不了锚点") | `approval-cancel-round-published-definition.ts:111` |
| `revokeBeforeNodeKeys` absent (nil ⇒ fail-open, not restrictive) | lock §14.1, lock:334 ("撤回窗口键…不设(nil ⇒ 不限制,fail-open,第 7 轮 P3-3)") | line 112, intentionally omitted (doc comment says so) |
| Node `nodeOperationPolicy.commentRequired: 'reject_only'` (explicit, not relying on the `createApproval` default) | lock §14.1, lock:332 (v5.3 struck "惰性要求" framing but the seed still writes it explicitly, matching the seed file's own doc comment lines 20-24) | line 84 |
| One node, `approvalMode: 'all'` (会签) | lock §14.1, lock:335 (v5.8, "专用定义**一个**审批节点…`approvalMode` 取会签 `'all'`") | `approvalMode: 'all'` at seed file line 83; node key constant `CANCEL_ROUND_APPROVAL_NODE_KEY = 'cancel_approval'` defined at line 55 |
| Assignee source = `requester_choice`, fed by `requesterChoices[CANCEL_ROUND_APPROVAL_NODE_KEY]` | lock §14.1, lock:328-331 (seats "经正常 `ApprovalAssigneeResolver` 解析") | `ApprovalProductService.ts:8396-8410` builds this input from the original document's own `approval_records.action='approve'` distinct actor ids (lock:328's seat source), not from possibly-deactivated `approval_assignments` rows |

### 2.3 Q1c attendance FK pairing (lock §14.3 #10/#11, lock:371-372)

`src/db/migrations/zzzz20260918110000_add_attendance_requests_approval_workflow_key.ts`:

| Requirement | Lock line | This tree |
|---|---|---|
| New column `attendance_requests.approval_workflow_key TEXT` | lock:371 | migration line 252 |
| Preflight: `SELECT count(*) … LEFT JOIN … WHERE r.approval_instance_id IS NOT NULL AND (i.id IS NULL OR i.workflow_key IS NULL)`, non-zero ⇒ abort | lock:371 (v5.1, "迁移前置断言…非 0 即 abort") | migration lines 254-272, verbatim shape |
| Backfill before constraint | lock:371 | migration lines 284-292, runs before any `ADD CONSTRAINT` |
| `UNIQUE (id, workflow_key)` on `approval_instances` + composite FK `(approval_instance_id, approval_workflow_key) REFERENCES approval_instances(id, workflow_key)` | lock:371 | migration lines 295-307, constraint names `uq_approval_instances_id_workflow_key` / `attendance_requests_instance_workflow_fkey` |
| CHECK `atr_instance_key_pair`: `(approval_instance_id IS NULL) = (approval_workflow_key IS NULL)` | lock:371 | migration lines 320-322, name matches lock verbatim |
| CHECK `atr_not_cancel_round`: `approval_workflow_key <> 'approval.cancel-round'` | lock:371 | migration lines 332-334, name matches lock verbatim |
| **Five active writers same-PR** (`index.cjs:33634-33638`, `:33876-33880`, `:34151-34155`, `:34436-34440`, `:34776-34781` at lock baseline) each pair the new column with the existing `approval_instance_id` write | lock:371 ("五个活写入方同 PR 改写") | `git diff 89f1ecdee...HEAD -- plugins/plugin-attendance/index.cjs` shows five INSERT-statement edits adding `approval_workflow_key`/`approvalPayload.workflowKey`; real-DB test `approval-cancel-round-attendance-fk-migration.db.test.ts` asserts "exactly 5 occurrences… (census: no undocumented 6th writer, no dropped writer)" and independently pins each writer function name |

### 2.4 Constants and the identity predicate

`packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts:27` — `export const
APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'` (lock §14.1, lock:328: "该值今天全仓 0
命中"). `:34-38` — `isCancelRoundInstance(instance) := instance.workflow_key ===
APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` (lock §14.1, lock:338, judgment I). Placement rationale recorded
in the file's own doc comment (lines 18-26): this module has zero imports, so it is the only home
that adds no new require edge between `ApprovalProductService.ts` and `ApprovalBridgeService.ts`
(both already import from it; `ApprovalProductService.ts` also imports `ServiceError` FROM
`ApprovalBridgeService.ts`, so the reverse direction would cycle). `ApprovalProductService.ts:4242`
re-exports it; `ApprovalBridgeService.ts:48` imports it directly.

`ApprovalProductService.ts` also owns the suite/window constants (re-derive with `grep -n
"^const CANCEL_ROUND_SUITES\|^const CANCEL_ROUND_SUITE_WINDOW_DAY_CEILINGS\|^const
CANCEL_ROUND_DEFAULT_SUITE\|^function deriveCancelRoundRoundPolicy" <file>` rather than trusting a
pinned literal here): `CANCEL_ROUND_SUITES` (lock:143's closed four-value domain),
`CANCEL_ROUND_SUITE_WINDOW_DAY_CEILINGS` (**renamed 2026-09-19** from
`CANCEL_ROUND_SUITE_DEFAULT_WINDOW_DAYS` — lock:143 makes the table an enforced UPPER BOUND, and the
old identifier named it a default, which is exactly the contract the code then failed to keep), and
`CANCEL_ROUND_DEFAULT_SUITE`.

CJS-side mirror (lock's own convention, "插件侧镜像常量…由测试钉逐字相等", lock:338):
`plugins/plugin-attendance/index.cjs:167` — `const APPROVAL_CANCEL_ROUND_WORKFLOW_KEY =
'approval.cancel-round'`, pinned byte-identical to the core constant by
`tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts`.

## 3. Interface and error codes

### 3.1 `createCancelRoundInstance` (`ApprovalProductService.ts`, `async createCancelRoundInstance(` at `:8543` @ `5da9e5310`)

> **Anchor discipline (gate round 6).** Every `file:line` in this document is a CONVENIENCE; the
> SYMBOL is what is authoritative. Line numbers in this file had drifted by 200+ lines before this
> round (the §8 table still said `:8308-8542` for a method that now opens at `:8543`, and `:4242`
> for a re-export now at `:4477`), and this round's own comment insertions moved more. Every
> anchor below and in §8 was re-derived mechanically against the committed head `5da9e5310`;
> re-derive by symbol, not by line, when they disagree.

```
async createCancelRoundInstance(
  documentId: string,
  actor: { userId: string; userName?: string },
  options: { reason?: string | null } = {},
): Promise<UnifiedApprovalDTO>
```

No HTTP route wires this method in this slice (the goal document's C-1 scope is the service-layer
contract; a route/UI entry point is not named in this slice's checklist and is not added here —
flagged in §5 below as left to a later slice). Error codes it can throw, all dedicated (none reuse a
generic HTTP-status-only shape):

| Code | HTTP | Condition | Lock anchor |
|---|---|---|---|
| `APPROVAL_NOT_FOUND` (existing `APPROVAL_ERROR_CODES`) | 404 | `documentId` does not resolve to an `approval_instances` row | — (pre-existing code, reused for a pre-existing condition) |
| `CANCEL_ROUND_DOCUMENT_NOT_APPROVED` | 409 | Original instance `status !== 'approved'` | lock §0/§1 (no lock-anchored code — **implementer erratum**, flagged in-code and in §6 below) |
| `CANCEL_ROUND_REQUESTER_ONLY` | 403 | `actor.userId` does not match `requester_snapshot.id` on the original instance | lock §6 (lock:157, "仅原 requester"); **implementer erratum** — lock names no code for this rejection |
| `CANCEL_ROUND_SUITE_FORBIDDEN` (own class `CancelRoundSuiteForbiddenError extends ServiceError`) | 409 | `metadata.suite === 'forbidden'` on the original instance | lock §14.3 (lock:357, v5.8) — **lock-anchored**, dedicated error class required verbatim |
| `CANCEL_ROUND_ALREADY_PENDING` | 409 | A `pending` round already exists for this document (pre-check, and the authoritative 23505-translation backstop on `uq_approval_rounds_pending_document`) | lock §5 I3 / §14.1 I3 discipline; erratum — no explicit code named, chosen for symmetry with the constraint it backstops |
| `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` | 409 | **(a)** every `approve` row on the original carries a `system:` sentinel, so no human seat survives the namespace drop — `details = { reason: 'no_human_approver' }`, a category, never an id (gate round 6, G6-1); **(b)** the graph executor's initial-state resolution does not land on `pending`/the cancel node — no `details` (see §3.4: the "≥1 assignment" leg of (b) is unreachable, because the executor throws `400 APPROVAL_ASSIGNEE_EMPTY` first) | fail-closed backstop per lock §14.1's "NEVER auto-approve, NEVER zero seats" discipline (lock:335 席位 N ≥ 1, lock:337 I″ 至少一个活动席位); erratum. One code, two arms — a fifth code is deliberately NOT minted |
| `CANCEL_ROUND_SEAT_INELIGIBLE` | 409 | At least one original approver is no longer eligible to hold a seat, judged by the SHARED login gate `evaluateUserAuthenticationGate` (`is_active = FALSE`, `role = 'disabled'`, `activation_status = 'pending_activation'` / not in the closed set, or no `users` row at all). `details = { ineligibleCount, reasons }` — categories only, never an id. **Judged only on claimed PERSONS**: `system:`-namespaced actors are dropped before this gate runs, so `reasons: ['not_found']` can no longer mean "a sentinel" (gate round 6, G6-1) | lock §2-G3 (lock:74-76, 「重新验证当前资格…资格不成立的席位 ⇒ 阻断并提示管理员」); the lock names no code ⇒ **implementer erratum**, added 2026-09-19 |
| `CANCEL_ROUND_SUITE_UNKNOWN` | 409 | `metadata.suite` is present but outside the closed set `{attendance, leave, other, forbidden}`. `details = { allowedSuites }` — never the offending value | lock:143 (`suite ∈ {四值}`); the lock names no code ⇒ **implementer erratum**, added 2026-09-19 |
| `CANCEL_ROUND_WINDOW_OUT_OF_RANGE` | 409 | `metadata.windowDays` is present but is not an integer in `[0, suite ceiling]`. `details = { suite, ceiling }` — never the offending value | lock:143 (`windowDays ∈ [0, 上限]`, 「由模板管理员在上限内设」); the lock names no code ⇒ **implementer erratum**, added 2026-09-19 |
| `CANCEL_ROUND_CREATE_FAILED` | 500 | Post-commit read-back of the newly created approval returns nothing (should not happen; defensive) | not a lock condition — implementation defensive branch |

**Disclosed gap**: seven of the throw sites above (`DOCUMENT_NOT_APPROVED`,
`REQUESTER_ONLY`, `ALREADY_PENDING`, `NO_ELIGIBLE_APPROVER`, and the three added on 2026-09-19 —
`SEAT_INELIGIBLE`, `SUITE_UNKNOWN`, `WINDOW_OUT_OF_RANGE`) have no lock-anchored code — the lock
only names dedicated codes for the 8 outlet-guard chokepoints (`CANCEL_ROUND_OUTLET_FORBIDDEN`) and
the suite gate (`CANCEL_ROUND_SUITE_FORBIDDEN`). This is recorded in-code at each throw site
("flagged as an implementer erratum for owner/gate registration") and repeated here rather than
silently presented as lock-mandated. All four are still *dedicated, non-generic* codes (not bare
403/404/409), so the checklist's "错误码不得降级成裸 HTTP 状态" rule (item 4) is satisfied even where
the lock itself is silent on the exact string.

### 3.2 Outlet-guard error classes (`ApprovalBridgeService.ts:1586-1611`)

```
export class CancelRoundOutletForbiddenError extends ServiceError {
  constructor(message: string) { super(message, 409, 'CANCEL_ROUND_OUTLET_FORBIDDEN') }
}
export class CancelRoundSuiteForbiddenError extends ServiceError {
  constructor(message: string) { super(message, 409, 'CANCEL_ROUND_SUITE_FORBIDDEN') }
}
export function rejectIfCancelRound(instance, outletLabel: string): void
```

`CancelRoundOutletForbiddenError extends ServiceError`, **not** `AttendanceCentralApprovalError` —
lock §14.3 (lock:357) names this explicitly ("不得继承或复用
`AttendanceCentralApprovalError`…会把后者吞成 `skipped_stale`"); the class's own doc comment
(`ApprovalBridgeService.ts:1577-1584`) repeats the reasoning and cites the exact absorption line
(`ApprovalProductService.ts:9637`, the `if (error instanceof AttendanceCentralApprovalError) { … }`
branch inside `applyNodeTimeoutEffect` (`:9568`), whose body's `return 'skipped_stale'` lands at
`:9640` — re-derived fresh against this pass's own HEAD, not copied from the round-2/round-3 gate
reports' citations, per the correction those reports made to this section's earlier `:9246` pointer,
which was never the absorption line: `:9246` falls inside `applyApprovalDepartureTransfer`'s manager
resolution `catch`, an unrelated fail-closed no-manager path).

### 3.3 The allowed action set (lock §14.2, lock:342)

`ApprovalProductService.ts` (design-time sketch; re-derive this tree's actual lines with the grep
below rather than trusting a pinned literal here — P3 hygiene round, 2026-09-19, gate round-5 P3-2
found this section's `:4253-4264` and §7's `:4253-4272` both off by a few lines from this tree's
real block, `:4251-4256` (const) / `:4258-4266` (function); per
`feedback_digest_pin_is_not_a_behavioural_gate`, re-deriving rather than re-pinning a corrected
literal is the fix, since a fresh literal drifts the same way on the next edit):

```
grep -n "^const CANCEL_ROUND_ALLOWED_ACTIONS\|^function assertCancelRoundActionAllowed" packages/core-backend/src/services/ApprovalProductService.ts
```

```
const CANCEL_ROUND_ALLOWED_ACTIONS: ReadonlySet<ApprovalActionType> =
  new Set(['approve', 'reject', 'revoke', 'comment'])

function assertCancelRoundActionAllowed(instance, action): void {
  if (!isCancelRoundInstance(instance) || CANCEL_ROUND_ALLOWED_ACTIONS.has(action)) return
  throw new CancelRoundOutletForbiddenError(...)
}
```

Matches lock:342 exactly (`{approve, reject, revoke, comment}`; `handle`/`return`/`transfer`/
`add_sign`/`reduce_sign` fall through to the throw). Single call site: `dispatchAction`,
`ApprovalProductService.ts:9928` (this tree's current line; lock's baseline citation is `:9533`).

### 3.4 Creation-time guard order, and the two G3 halves (added 2026-09-19)

Two independently-verified Codex findings against this slice were fixed on 2026-09-19. Both defects
were born in C-1 (evidence: the independent verification reports
`verify-codex-cancel-finding1-20260919.md` §5.1 and `verify-codex-cancel-finding2-20260919.md` §7,
which trace both to `c4dc4b928`'s own function body).

**Guard order inside the creation transaction.** Every one of these runs under the SAME
`SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE` and BEFORE the first INSERT, so a stale
read can never authorize a round. The order is deliberate, and it also fixes which code wins when
several conditions hold at once:

1. instance exists → else 404 `APPROVAL_NOT_FOUND`
2. `status = 'approved'` → else 409 `CANCEL_ROUND_DOCUMENT_NOT_APPROVED`
3. WI-16 requester identity → else 403 `CANCEL_ROUND_REQUESTER_ONLY`
4. **`deriveCancelRoundRoundPolicy(metadata)`** — suite domain, then window domain → 409
   `CANCEL_ROUND_SUITE_UNKNOWN` / `CANCEL_ROUND_WINDOW_OUT_OF_RANGE`
5. §14.3 #14 suite gate (`suite === 'forbidden'`) → 409 `CANCEL_ROUND_SUITE_FORBIDDEN`.
   Step 4 short-circuits the window check for `forbidden` and returns lock:143's fixed
   `windowDays = 0`, so this LOCK-ANCHORED code always wins over a window complaint for that suite.
6. no pending round → else 409 `CANCEL_ROUND_ALREADY_PENDING`
7. read the seat set off `approval_records(action='approve')`, **dropping `system:`-namespaced
   sentinel actors** (`:8656`, gate round 6 G6-1 — shared predicate `isSystemSentinelActor`)
8. **seat set empty after the drop** → 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,
   `details.reason = 'no_human_approver'` (`:8677`, gate round 6 G6-1)
9. **`assertCancelRoundSeatsEligibleInTxn`** (`:8686`, lock §2-G3) → 409 `CANCEL_ROUND_SEAT_INELIGIBLE`
10. resolver / initial-state backstop → 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` (no `details`)
11. first INSERT

Step 8 is an EXPLICIT check and not a fall-through to step 10, because step 10's
`initialAssignmentCount === 0` leg is **unreachable**: with zero seats
`ApprovalGraphExecutor.resolveInitialState` throws `400 APPROVAL_ASSIGNEE_EMPTY` from the
`assignments.length === 0` arm of `resolveFromNode` (`ApprovalGraphExecutor.ts:1390`) before returning (the dedicated seed graph
deliberately omits `emptyAssigneePolicy`). What step 10 actually guards is `initial.status !==
'pending'` / a wrong `currentNodeKey` — a seed graph edited into auto-approving or re-routed. The
round-6 erratum is recorded at both sites in the source; mutation R7-M2 (delete step 8) turns 负控 N3
into a `400 APPROVAL_ASSIGNEE_EMPTY`, which is the probe that proves step 8, not the executor,
produces the contract code.

Step 7's drop is namespace-scoped and nothing more. 负控 N4 (auto-approval + one DEACTIVATED human)
pins that a human survives the drop and is still re-qualified — it answers
`SEAT_INELIGIBLE`/`inactive`, never `NO_ELIGIBLE_APPROVER` and never a partial 会签 roster. Mutation
R7-M3 (replace the step-9 block with a filter-and-continue that then leans on step 8) turns N1, N2
and N4 red together, so step 8 did not become a laundering path for the filter the lock forbids.

Config errors (4/5) are therefore reported before state errors (6): a document that is BOTH
mis-tagged AND already has a pending round answers `SUITE_UNKNOWN`, not `ALREADY_PENDING`.

**G3 half A — 在职 (shipped).** The gate reuses `validateAndFreezeRequesterChoices`'s company-scope
IDIOM (read the directory for the ids, refuse if any id is not in the eligible set ⇒ a missing
`users` row fails closed by construction) with `evaluateUserAuthenticationGate`'s PREDICATE (the
shared gate for password login, token refresh/verify, DingTalk SSO and API tokens). It is therefore
**wider**, never narrower, than the normal create path: it additionally refuses `role = 'disabled'`
and `activation_status = 'pending_activation'`, which a bare `is_active = TRUE` check would seat
even though the person cannot log in.

**OPEN (owner call), not shipped, not silently skipped:**

- **G3 half B — 仍在该组织单元.** No `user_orgs` (or any other) seat-eligibility predicate exists
  anywhere in this repo today, so adding one is NEW behaviour, not parity with the normal path.
  `approval_instances.org_id` is nullable with no default
  (`zzzz20260821100000_add_approval_instance_org_id.ts`), so its NULL semantics must be defined
  before any such predicate lands (recommended, not decided here: NULL ⇒ skip the org half rather
  than refuse everyone). The binding verification report's own instruction is: 「If unruled, ship A
  alone and record B as OPEN」. A standing positive control (`§2-G3 正控 P2`) pins that the shipped
  half does not refuse an `org_id IS NULL` original, so a future org predicate cannot land without
  facing that question. Note that `grantApprovalOrgMembership` already seats every integration
  fixture actor in org `default`, so half B would be additive for the corpus, not a fixture rewrite.
- **Aligning the NORMAL create path to the login gate.**
  `validateAndFreezeRequesterChoices`'s company baseline is `is_active = TRUE` alone, i.e. narrower
  than the shared login gate. Widening it is a behaviour change to a shipped endpoint
  (`POST /api/approvals`) and is an owner call; it is deliberately NOT made in this slice. The
  divergence is recorded here rather than laundered into a claim of parity.
- **Three new error codes** — see §3.1; the lock file is owner-authored and is not edited from here.

**Two things the fix deliberately does NOT do**, both of which the binding report names explicitly:

- It never filters an ineligible id out of the seat list and continues. The cancel node is
  `approvalMode: 'all'`, so a filter would silently lower the co-sign threshold — the opposite of
  「阻断并提示管理员」. Pinned by the `§2-G3 负控 N1/N2` zero-row assertions (mutation M2 below).
- It never clamps an out-of-range `windowDays` to the ceiling. A clamp turns a misconfiguration into
  a silent 「悄悄按 90 算」, which contradicts lock:143's 「由模板管理员在上限内设」 auditability; the
  repo's own narrowing-fix discipline is write-path REJECT. A second, decision-time clamp is
  rejected for a further reason: lock §5 I4 / §2-G4 require the creation and decision points to use
  ONE derivation, and a second one必然 drifts.

**Pre-existing, out of scope, disclosed:** the seat query's own
`.filter((id) => typeof id === 'string' && id.length > 0)` silently drops a NULL `actor_id`. That is
a filter-and-continue of exactly the kind the report forbids, it predates this fix, and it is NOT
closed here.

> **RETRACTED 2026-09-19 (gate round 6, G6-2).** This paragraph previously continued: "A mechanical
> census of every `action='approve'` record writer (`ApprovalProductService.ts` **×4** via
> `insertApprovalRecord`, `ApprovalBridgeService.ts:1148`,
> `plugin-attendance/index.cjs:35197/:35577/:37793`) shows all of them pass a real acting user id,
> and auto-approve-at-create writes `action:'created'`, not `'approve'`
> (`multitable/approval-record-projection-service.ts:376-377`) — so **no synthetic-actor seat is
> known to be reachable today**, and **this fix does not make any previously-cancellable document
> un-cancellable on that account**." Both clauses were **false**, and the sentence is withdrawn in
> full — not amended by changing a number. Three separate errors produced it:
> 1. The census was a single-syntax literal grep (`action: 'approve'`), so it could not see the one
>    writer that is a ternary.
> 2. The rebuttal citation was misread: `approval-record-projection-service.ts:375-377` is a
>    READ-model comment about which row `loadTerminalDecision` excludes when picking the terminal
>    decider. It says nothing about what the create path WRITES. (「注释断言 ≠ 不变量」.)
> 3. Two of the three `plugin-attendance` anchors cited as evidence are not `approve` writers at all
>    (at this head they are `'revoke'` and `'reject'`).
>
> The absolute claim was falsified by a real-DB A/B before the fix and is now falsified in-repo: the
> three new cases (正控 P3 / 负控 N3 / 负控 N4) are RED against the pre-fix implementation and green
> against the fix. Retraction propagation: this paragraph, the verification MD §M, and the PR body
> (see §M6 for the verbatim replacement text — the body is not edited from this lane).

**The census, redone by closing the world instead of grepping a literal (2026-09-19).** The
denominator is "every writer of an `approval_records` row", enumerated three ways:

| How the world is closed | Count | Approve-capable |
|---|---|---|
| (i) every `insertApprovalRecord(...)` call site (the helper is `private` to `ApprovalProductService.ts`; 0 call sites in any other file), reading the `action` EXPRESSION each passes — not a literal match | 28 | **5** |
| (ii) every raw `INSERT INTO approval_records` statement (case-insensitive, whitespace-tolerant), across `routes/approvals.ts` ×3, `approval-comment-service.ts`, `ApprovalBridgeService.ts`, `ApprovalProductService.ts` (the helper's own INSERT), `plugin-attendance/index.cjs` ×3 | 9 | **3** |
| (iii) kysely `insertInto('approval_records')` | 0 | 0 |

The five approve-capable helper call sites — **five, not four**:

| Site | `action` expression | `actorId` | Actor kind |
|---|---|---|---|
| `ApprovalProductService.ts:11483` | `'approve'` | `actor.userId` | real person |
| `:11521` | `'approve'` | `actor.userId` | real person |
| `:11664` | `'approve'` | `actor.userId` | real person |
| `:11863` | `'approve'` | `actor.userId` | real person |
| **`:12864`** (`insertAutoApprovalEvents`) | **`skipped ? 'sign' : 'approve'`** | **`actorIdForAutoApprovalEvent(event)`** | **synthetic `system:auto-approval` unless `metadata.actorMode === 'original_approver'`** |

The three approve-capable raw-SQL writers: `routes/approvals.ts:2966` (literal `'approve'`, actor =
the authenticated `userId`), `ApprovalBridgeService.ts:1148` (`request.action`, actor =
`actor.userId`), `plugin-attendance/index.cjs:37824` (`action` variable, actor = `requesterId`). All
three are real people. The other six raw writers are hardcoded `'remind'` / `'reject'` / `'comment'`
/ `'revoke'` and never reach the seat query.

**How "×4" was manufactured, so the shape is recognizable next time:** `grep -n "action: 'approve'"`
on `ApprovalProductService.ts` returns 6; two of those (`:11239`, `:11921`) are `buildCompletionEvent`
arguments — instance-level completion events, not audit rows — leaving 4. The arithmetic was
self-consistent and entirely blind to `:12864`, because a ternary contains no such literal. This is
the repo's own 「写入点审计要双语法」 rule, and what it missed here was precisely the only writer that
emits a non-user actor.

**Measured statement replacing the retracted one.** Exactly one `approval_records` writer in the repo
produces a synthetic actor: `insertAutoApprovalEvents` at `ApprovalProductService.ts:12864`. It is
reachable from production authoring — `createApproval` itself cascades into it, and the shipped
template editor owns `mergeWithRequester` (`apps/web/src/types/approval.ts`,
`apps/web/src/approvals/templateAuthoring.ts`) while never writing `actorMode`, so
`getAutoApprovalActorMode`'s `?? 'system'` default applies. Its rows therefore DID land in the cancel
round's seat query, and before this round they made every such document permanently un-cancellable.
The fix drops the `system:` namespace (shared predicate `isSystemSentinelActor`) before the seat gate
and answers `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` / `reason: 'no_human_approver'` when nothing human
remains. Under `actorMode: 'original_approver'` the row carries a real id, which is kept and
re-qualified like any other seat.

**Near-miss, disclosed rather than closed:** the helper's own INSERT
(`ApprovalProductService.ts:13143`) falls back to `record.actorId || 'system'` — a BARE `'system'`,
outside the `system:` namespace, so `isSystemSentinelActor` would not drop it. It is unreachable from
any approve-capable site today (all five pass a non-empty id), and the two sites that do pass a
literal `'system'` write `action: 'sign'` (`:11877`, `:11896`), which the seat query never reads.
Recorded here so that a future writer moving `'sign'` to `'approve'`, or passing a blank actor, is
seen as a re-opening of G6-1 rather than a new mystery.

## 4. Outlet guards — the lock's §14.3 table, re-derived against this tree

The lock's own account (§14.3, lock:356): chokepoint population = 7 sites sharing the
`assertAttendanceCentralMutationFailClosed` / `guardAttendanceCentralMutationOrThrow` family + 1
site (#12) that calls `classifyAndLockAttendanceRequestForInstance` directly = **8**; guard call
points = 1 (action-judgment) + 6 (`rejectIfCancelRound`) + 1 (shared identity predicate at #3) =
**8/8**. Re-derived mechanically against this tree (not copied from the lock's baseline-pinned
numbers):

```
$ grep -n "assertAttendanceCentralMutationFailClosed(client\|guardAttendanceCentralMutationOrThrow(client" \
    src/services/ApprovalProductService.ts src/routes/approvals.ts src/services/ApprovalBridgeService.ts
```
→ 8 matches: `ApprovalProductService.ts:458` (the `guardAttendanceCentralMutationOrThrow` **wrapper
definition itself**, not a call site — excluded from the count), `:8580`, `:9318`, `:9635`, `:9924`,
`ApprovalBridgeService.ts:1083`, `routes/approvals.ts:2936`, `:3108`. Net: **7 call sites** (matches
the lock's 7) + the #12 direct-classifier call at `ApprovalProductService.ts:8928` = **8/8**,
unchanged from the lock's own count.

| # | Outlet | This tree's anchor | Guard call (this tree) | Contract |
|---|---|---|---|---|
| 1 | `createApproval` creation-time cascade | not applicable to cancel-round (proven by judgment I's negative direction) | — | Reverse of judgment I: a public-path instance never carries the cancel-round `workflow_key`. Not a chokepoint for this outlet table. |
| 2 | `adminJump` | `ApprovalProductService.ts:8713` (state write inside `adminJump`, unchanged by this lane) | `guardAttendanceCentralMutationOrThrow` at `:8580`, then `rejectIfCancelRound(instance, 'adminJump')` at `:8582` | 409 `CANCEL_ROUND_OUTLET_FORBIDDEN` before any admin-jump DML |
| 3 | `applyNodeTimeoutEffect` (scanner) | `:9635` region (the `assertAttendanceCentralMutationFailClosed` call immediately below the cancel-round check) | `isCancelRoundInstance(instance)` check at `:9627`, returning `consumeAndSkip('skipped_cancel_round', 'cancel_round_instance')` at `:9628` — **not** a throw (this outlet's contract is a returned scanner outcome, per its own doc comment at `:9622-9626`) | Deadline is consumed (not merely skipped) so the scanner does not re-pick the same instance next tick; outcome literal `'skipped_cancel_round'` added to the union at `:793` |
| 4 / 6 | `dispatchAction` `handle` / `return` branches | `:9928` (single action-judgment site upstream of both branches) | `assertCancelRoundActionAllowed(instance, request.action)` at `:9928` | 409 `CANCEL_ROUND_OUTLET_FORBIDDEN` before the branch dispatch that would otherwise reach either state write |
| 5 | approve fall-through (the single `approved` outlet) | not reached by any of this slice's cancel-round-specific code (see §1.1 — 判据 II deferred) | `assertCancelRoundActionAllowed` at `:9928` still runs upstream (action `'approve'` is in the allowed set and passes through) | **Deliberately unguarded beyond the allowed-action gate** in this slice — a cancel-round instance that reaches this outlet today runs the *ordinary* approve path with no C-1 redemption, no round-outcome write. This is the single largest functional gap left to C-2 (see §5) |
| 7 | legacy `POST /:id/approve` | `routes/approvals.ts:2954` (guard call) / catch at `:3011-3016` | `rejectIfCancelRound(instance, 'legacy POST /:id/approve')` at `:2954`; catch block's **first statement** is `if (error instanceof CancelRoundOutletForbiddenError) return handleApprovalsError(res, error, 'APPROVAL_APPROVE_FAILED', 'Failed to approve request')` | Legacy catch does not call `handleApprovalsError` by default (would 500 any `ServiceError`) — the lock-mandated pass-through (lock:352) is present, first statement, before any error-text branch, using the real 4-arg signature confirmed at `routes/approvals.ts:431` |
| 7′ | legacy `POST /:id/reject` | `routes/approvals.ts:3126` (guard call) / catch at `:3185-3188` | `rejectIfCancelRound(instance, 'legacy POST /:id/reject')` at `:3126`; catch's first statement mirrors #7 | Same pass-through discipline; lock:368 additionally requires this outlet be rejected because legacy reject never writes the round row (only A7 does, under 判据 III) |
| 8 | `ApprovalBridgeService.dispatchAction` | `ApprovalBridgeService.ts:1077` (state write) / guard at `:1077` region | `rejectIfCancelRound(instance, 'ApprovalBridgeService.dispatchAction')` at `:1077` | 409 before the Bridge's own WHERE-clause-driven update, which the lock notes "会命中 pending 的 cancel 轮" (lock:369) absent this guard |
| 9 | `upsertPlmMirror` | not a guard — a **constant assertion** (lock:370 reclassifies this from a v5.0 mutation-untestable "guard") | none (structural: `source_system='platform' ∧ external_approval_id IS NULL` on the creation path) | `createCancelRoundInstance`'s INSERT hardcodes both `source_system='platform'` and `external_approval_id = NULL` as literals in the same VALUES row (`:8447`: `` `($1, $2, 0, 'platform', NULL, $3, $4, $5, …)` ``) — not independently re-verified by a dedicated test in this slice beyond the creation test's own row read-back |
| 10 / 11 | Attendance FK pairing / `ON CONFLICT` reset | see §2.3 | DB-level CHECK/FK, not application code | Covered in §2.3 |
| 12 | `bulkReassignApprovals` seat write | `ApprovalProductService.ts:8850+` region (no state write for a rejected instance — it is a guard point, not an outlet with its own write) | `rejectIfCancelRound(instance, 'bulkReassignApprovals')` at `:8916`, **before** `classifyAndLockAttendanceRequestForInstance` at `:8928` | Typed skip `reason: 'cancel_round'` (catch shape at `:8917-8922` mirrors the lock-mandated existing `:8937-8941`-style catch — **not** the generic catch that would turn it into an unnamed `skipped_stale` |
| 13 | `applyApprovalDepartureTransfer` seat write | `ApprovalProductService.ts:9294-9296` region | `rejectIfCancelRound(instance, 'applyApprovalDepartureTransfer')` at `:9300`, before `assertAttendanceCentralMutationFailClosed` at `:9318` | Same typed-skip discipline as #12, own catch at `:9301-9307` |
| 14 | `createCancelRoundInstance`'s own suite gate | `ApprovalProductService.ts:8367-8370` | `CancelRoundSuiteForbiddenError` thrown before any INSERT | 409 `CANCEL_ROUND_SUITE_FORBIDDEN`; suite read from `metadata.suite` (see §1.1's disclosed gap on the production mapping source) |

Sentinel/negative-control coverage for each row above lives in the real-DB acceptance suites named
in the verification MD's §1 table; this section is the design mapping, not the test inventory.

## 5. 判据 III — the two allowed non-approve terminal outlets (lock §14.2, lock:344)

**A4 (revoke)** — `ApprovalProductService.ts:10641-10654`: inside the same transaction as the
instance's `revoked` state write, when `isCancelRoundInstance(instance)`:
```
UPDATE approval_rounds SET outcome = 'withdrawn', ended_at = now()
WHERE engine_instance_id = $1 AND outcome = 'pending'
```
`rowCount !== 1` throws `CANCEL_ROUND_INVARIANT_VIOLATION` (409) rather than silently committing an
orphaned `pending` round — an **implementer erratum** (no lock-anchored code for this branch,
disclosed in-code at `:10638-10640` with the same discipline as WI-16's create-time check).

**A7 (reject)** — `ApprovalProductService.ts:11128-11141`, same shape: `outcome = 'rejected'` on the
matching pending round, same invariant-violation guard, same erratum disclosure.

**Exact sequence, both branches (re-derived against this document's own HEAD `8b8aa8a5e`, not
carried over from an earlier commit) — status write → audit row → completion-event build → in-txn
durable enqueue → round-row write → `COMMIT`:**

| Step | A4 (revoke) | A7 (reject) |
|---|---|---|
| Instance status write | `:10592-10602` | `:11079-11088` |
| `insertApprovalRecord` (audit row) | `:10603-10613` | `:11090-11104` |
| `buildCompletionEvent` | `:10614-10625` | `:11105-11116` |
| `enqueueApprovalEventIfDurable` (in-txn durable enqueue) | `:10627` | `:11118` |
| **Round-row `UPDATE approval_rounds SET outcome = …`** | `:10641-10654` | `:11128-11141` |
| `COMMIT` | `:10655` | `:11142` |

All six rows in each column share one `client` and one transaction — no intervening `COMMIT`/`BEGIN`
between the round-row UPDATE and the instance-transition COMMIT in either branch — but the round
write is the **last** write before `COMMIT`, not the first, and not "before" the status write.

**Gate finding P3-A — disclosed, OPEN, owner 备案 (not accepted, no code changed by this document):**
lock:344 ratifies "挂点 = 各自状态写之前、同事务" — literally, before each branch's own instance
status write, same transaction. The table above shows the actual hook point sits **after** the
status write, the audit row, and the completion-event enqueue — a literal deviation from the ratified
text, found by the independent gate review (`impl-gate-C-slice1-round1-20260918.md`, finding P3-A)
and reconfirmed here against the current tree. The reviewer walked the rollback path and could not
construct a behavioral difference: all six writes share the transaction, so the round write's own
fail-closed 409 (`CANCEL_ROUND_INVARIANT_VIOLATION`) rolls back the status write, the audit row, and
the in-txn event enqueue together — there is no window where the instance transitions without its
round terminating, or vice versa. Whether that absence-of-observed-difference is enough to accept the
literal deviation as-is, or whether the write should be moved to match lock:344's text exactly, is an
interpretation of the ratified clause and is **left to the owner**, not decided by this document. If
a reorder is ever made, it must be re-verified against the real-DB redemption suite — mutation M2 in
the gate report already showed the round write is load-bearing at its current position, which does
not by itself prove it stays load-bearing (or safe) at a different position in the same transaction.

Legacy `/reject` (#7′) is explicitly excluded from ever reaching A7's round-terminating write (it is
rejected at the route layer per §4's outlet #7′ row) — per lock:368, "cancel 轮的 reject **只**经 A7,
因为轮次 outcome 只在那里写".

## 6. Transactions and lock order

### 6.1 The ratified abstract order (quoted, not derived — lock §11①, lock:205-227, and §9-4, lock:110)

> 每条继续执行的 source 与 rollback 经同一个 fail-closed 助手取 class-`00` 的组织 rollout 共享锁,先于
> class-`10` 的操作身份、行/批,以及 class-`11` 的目标锁;transition 与 closure 先取 rollout 排他锁。
> (`docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`,
> OD-W4C-40 / W4C-R41 / W4C-R42)

> 建议全局顺序 rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → attendance_requests → 余额批次,现有
> 适配器改为同序 (lock §3 C-2, lock:110)

Q-A/Q-B/Q-C's suggested concrete positioning (lock §13, lock:299-307, **review suggestions, not
owner ratify** — the lock's own header says so and this document repeats that framing rather than
upgrading it):

| Question | Suggested value (unratified) |
|---|---|
| Q-A | `class-00 → class-10 → W4 operation rows → cancel 轮实例 → 原实例 → attendance_requests` |
| Q-B | `attendance_requests` after `class-10`/operation claim, before calc/balance rows; no class-11 fiction if it does not exist yet |
| Q-C | `record-link:row-auth` **禁止** with W4 locks in the same transaction for phase 1 — creation must reject auto-approve, C-2 only runs the redemption path outside instance-creation |

### 6.2 This slice's actual lock-taking sites

**Creation (`createCancelRoundInstance`)** takes exactly **one** lock, and it is not a rollout/W4
lock at all:

```
ApprovalProductService.ts:8329 — SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE
```

The method's own doc comment (`:8325-8327`) states why this is correct under Q-A's suggested order
rather than an omission: "creation never touches W4 attendance calculation — the only row this
transaction must serialize against is the original document instance itself." No `attendance_requests`
row, no rollout/advisory lock, and no `record-link:row-auth` lock are ever acquired inside this
method — confirmed by reading the full method body (`:8308-8542`), not by a symbol-absence grep
alone.

**判据 III (A4/A7)** takes the pre-existing `dispatchAction` lock order unchanged: the top-level
`approval_instances … FOR UPDATE` at `:9915` (this tree), then (for a cancel-round instance) the
`approval_rounds` row via a bare `UPDATE … WHERE engine_instance_id = $1 AND outcome = 'pending'`
with no separate row-lock statement (the UPDATE's own row-level lock is implicit). No W4/rollout
lock is taken on this path either, since revoke/reject never touch attendance calculation.

**Net for this slice**: the only net-new lock-order fact this slice introduces into the *real*
production call graph is "`approval_instances` (original document) locked alone, with nothing else
held" at creation, and "`approval_instances` (round's own instance) then `approval_rounds`" at A4/A7
termination — both are **degenerate** cases of the suggested Q-A order (a strict prefix of it), not
counterexamples to it. This slice does **not** yet exercise the case that would actually test Q-A/Q-B/
Q-C's cross-lock ordering under contention (round-instance lock while a rollout/advisory lock is
concurrently held) — that only happens once C-2's redemption path calls into the W4 external entry
point while still holding the round + original-instance locks. This is disclosed, not silently
implied covered.

### 6.3 The lock-order census file's own honesty about what it tests

`tests/integration/approval-cancel-round-lock-order-census.db.test.ts` is **not** a census of the
real call graph above for Q-B/Q-C — its own header (lines 1-60) discloses that Q-A's harness
"constructs the two lock acquisitions BY HAND with two real Postgres connections" using the real
production key-derivation helper against a real `approval_instances FOR UPDATE`, cloned from the
`attendance-w7-3-context-source-transition.db.test.ts` precedent technique, **because** WI-4's real
call graph (§6.2 above) does not itself contend against a rollout lock — there is nothing in
production code to observe contending. The file's own addendum (added after WI-4 landed) states this
explicitly: "at CREATE time…only ONE `approval_instances` row exists…there is nothing yet to take a
second `FOR UPDATE` on." Q-B and Q-C are the same technique, hand-constructed, not driven through
`createCancelRoundInstance` or `dispatchAction`. What the census proves is: **the suggested order
does not deadlock when followed, and the reversed order deterministically does** (`40P01`) — i.e.,
the ordering is internally consistent and worth committing to, not that this slice's actual code
currently exercises the contended case. See the verification MD §6 for the fresh test output.

## 7. Owner-ratified decisions this slice relies on (quoted verbatim from the lock's own RATIFY header)

Per instruction, this section quotes the lock's抬头 RATIFY record without paraphrase or rewrite —
`approval-change-request-design-lock-draft-20260915.md:3-8`:

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:
>   分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、
>   #5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审
>   全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **漂移核对(85ddd2926 → 00781e68b)**:本锁引用的核心文件…**字节相同**;唯二有位移的是
>   `packages/core-backend/src/index.ts`…与 `multitable/automation-service.ts`…新增迁移
>   `…create_recovery_archive_derived_effects.ts` 与本锁无关。
> - **裁决结果(按建议值)**:§9-1 模型与三份契约按 v5.9 ratify;§9-8 Q1 轮次身份 =
>   `workflow_key='approval.cancel-round'` + `source_system='platform'`(**采纳**);§9-9 允许集 =
>   {approve, reject, revoke, comment},拒 transfer/add_sign/reduce_sign;§9-10 首期 DDL/seed 三件与
>   迁移与写入方同一发布 = **接受**;§9-11 C-3 情形 2 边界**接受引擎现状**,专用定义 `approvalMode` 取
>   会签 `'all'`(与 §9-3 G3 联动:一个定义一种模式);§9-2/3/4/5/6/7 按锁文正文的建议值(C-1 status 择定;
>   **G1–G4 按 §2 收敛版确认**…锁序全局约定;策略默认值与 `suite` 映射/多套件优先级;首期范围 = 请假
>   撤销;L6-B/L6-C 解冻方式)。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR
>   一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

**This slice's implementation choices that fall inside the ratified decisions above** (not
independently re-litigated here): the `workflow_key`/`source_system` identity pair (§9-8, adopted
verbatim as `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'` +
`source_system = 'platform'`); the allowed-action set (§9-9, `CANCEL_ROUND_ALLOWED_ACTIONS`); the
three-part DDL/seed set shipped in the same lane as the writer edits (§9-10); `approvalMode: 'all'`
on the single seeded node (§9-11).

**Owner items named by lock §9 that this slice does NOT resolve** (left open, not decided by this
implementation):

- §9-2 (lock:175): C-1's `status`-field choice for the original instance — this slice writes
  `approved → cancelled` per the lock's own "我方建议…owner 择一" framing (lock:93-95), but that
  choice is C-2's territory (the actual status transition happens at redemption, not creation) —
  **not exercised by any code in this slice** (§1.1).
- §9-4 (lock:175): "锁顺序全局约定" — this slice's own lock-order census (§6.3) explicitly frames its
  Q-A/Q-B/Q-C conclusions as unratified review suggestions (lock §13's own header), not as a closed
  owner decision; this document does not claim §9-4 is settled by this slice's work.
- §9-5 (lock:176): production `suite` mapping source and multi-suite priority — this slice's
  `metadata.suite` read is a **phase-1 placeholder**, disclosed in §1.1 and §4 (#14), not a resolution
  of §9-5.
- §9-7 (lock:176): L6-B/L6-C thaw mechanism — not touched by any file in this slice's diff
  (`git diff --stat 89f1ecdee...HEAD` shows no `L6-B`/`L6-C`-named file).
- §9-2/§3 in the RATIFY header's own text ("C-1 status 择定") is listed as decided by the RATIFY
  record's "按锁文正文的建议值" bucket — but per the carve-out in the RATIFY record's first bullet
  ("owner 未点名的项…不在本授权内"), this document treats only the items the RATIFY record's own
  prose explicitly names as settled, and flags anything this slice's code had to choose without an
  explicit lock-anchored code or explicit RATIFY-bucket mention as an **implementer erratum** (§3.1,
  §5) rather than silently treating implementer discretion as ratified policy.

## 8. Seams with existing code (file:line, this tree)

| Seam | File:line | What it does |
|---|---|---|
| Identity predicate, zero-import leaf module | `attendance/w4c3b-central-approval-hooks.ts` — `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` `:27`, `isCancelRoundInstance` `:34` | `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY`, `isCancelRoundInstance` |
| Re-export into the service file every chokepoint imports from | `ApprovalProductService.ts:4477` (was `:4242` — stale before this round) | `export { isCancelRoundInstance } from '../attendance/w4c3b-central-approval-hooks'` |
| Action-allow gate, single call site | `ApprovalProductService.ts` — `CANCEL_ROUND_ALLOWED_ACTIONS` `:4486-4491`, `assertCancelRoundActionAllowed` `:4493`, sole call site `:10222` (gate round 6 re-derivation; the `:4251-4266` / `:9928` this row previously carried were both stale) | `CANCEL_ROUND_ALLOWED_ACTIONS`, `assertCancelRoundActionAllowed` |
| Creation method | `ApprovalProductService.ts` — `async createCancelRoundInstance(` at `:8543` (was `:8308-8542` — stale before this round) | `createCancelRoundInstance` |
| A4 (revoke) round-close | `ApprovalProductService.ts:10937` — `UPDATE approval_rounds SET outcome = 'withdrawn', ended_at = now()` | 判据 III half 1 |
| A7 (reject) round-close | `ApprovalProductService.ts:11424` — `UPDATE approval_rounds SET outcome = 'rejected', ended_at = now()` | 判据 III half 2 |
| Outlet #2 | `ApprovalProductService.ts:8876` — `rejectIfCancelRound(instance, 'adminJump')` | `adminJump` guard |
| Outlet #3 | `ApprovalProductService.ts:9922` — `consumeAndSkip('skipped_cancel_round', …)` | node-timeout scanner skip |
| Outlets #4/#6 | `ApprovalProductService.ts:10222` — `assertCancelRoundActionAllowed(instance, request.action)` | `dispatchAction` action-judgment |
| Outlet #12 | `ApprovalProductService.ts:9210` — `rejectIfCancelRound(instance, 'bulkReassignApprovals')` | `bulkReassignApprovals` typed skip |
| Outlet #13 | `ApprovalProductService.ts:9594` — `rejectIfCancelRound(instance, 'applyApprovalDepartureTransfer')` | `applyApprovalDepartureTransfer` typed skip |
| Sentinel-namespace predicate, now shared (gate round 6, G6-1) | `ApprovalAssigneeResolver.ts:102` `isSystemSentinelActor` — changed from module-private to **exported**; imported by `ApprovalProductService.ts:93`, called at `:8656` (cancel-round seat filter) and `:12759` (`loadPriorNodeApproverDeciders`) | The repo-wide `system:` non-user actor namespace. Two seat-derivation sites now call it: the cancel round's own filter, and `loadPriorNodeApproverDeciders` (Lock-1 §K3), whose inline `id.startsWith('system:')` was swapped to the import. That swap is behaviour-identical and is named here rather than left silent — leaving a hand-rolled copy in the same file that imports the shared predicate is what next round's finding would be |
| Error classes | `src/services/ApprovalBridgeService.ts:1586-1611` | `CancelRoundOutletForbiddenError`, `CancelRoundSuiteForbiddenError`, `rejectIfCancelRound` |
| Outlet #8 | `ApprovalBridgeService.ts:1077` — `rejectIfCancelRound(instance, 'ApprovalBridgeService.dispatchAction')` (verified unchanged) | `ApprovalBridgeService.dispatchAction` guard |
| Outlet #7 | `src/routes/approvals.ts:2954` (guard), `:3011-3016` (pass-through catch) | legacy `/approve` |
| Outlet #7′ | `src/routes/approvals.ts:3126` (guard), `:3185-3188` (pass-through catch) | legacy `/reject` |
| `handleApprovalsError` real signature | `src/routes/approvals.ts:431-434` | 4-arg `(res, error, fallbackCode, fallbackMessage)` — both pass-through call sites use this exact shape |
| Attendance mirror constant + defensive check | `plugin-attendance/index.cjs:170` (mirror constant), `:24333` (`assertAttendanceApprovalPayloadNotCancelRound`) | `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` mirror, `assertAttendanceApprovalPayloadNotCancelRound` |
| Five FK-pairing writers | `plugins/plugin-attendance/index.cjs` (five INSERT sites; exact line numbers drift per edit — see the FK-migration real-DB test's own per-writer assertions for the current five) | pairs `approval_instance_id` with the new `approval_workflow_key` column |

## 9. Items left for later slices

- **C-2 (兑现与收口)**: 判据 II (approve redemption, C-1's W4 external transaction entry point,
  the round → `applied`, the instance → `cancelled`, one completion event, R2's negative control);
  判据 IV (C-3's `expired`/`blocked` system close, outlet #5′ registration in §14.3); the C-1
  business-side change to `w4c3b-request-operation-boundary.ts` allowing an external transaction
  owner. All per §1.1 above.
- **`attendance-parity.db.test.ts`**: byte-identical-outcome acceptance for the completed cancel path
  vs. the existing W4 route, including `unrecoverableExpired` presentation — cannot be written before
  C-2 exists to produce an outcome to compare.
- **Production `suite` mapping** (§9-5): a real template→suite table/column, replacing this slice's
  `metadata.suite` fixture-input placeholder, and the multi-suite-per-template priority rule.
- **An HTTP route (or equivalent entry point) for `createCancelRoundInstance`**: this slice's method
  is service-layer only; no route file in this tree calls it (`grep -rn
  "createCancelRoundInstance" src/routes/` → 0 matches). A caller (route, or another slice's UI
  entry) is not part of this slice's checklist and is not added here.
- **Seven implementer-erratum error codes** (§3.1: `CANCEL_ROUND_DOCUMENT_NOT_APPROVED`,
  `CANCEL_ROUND_REQUESTER_ONLY`, `CANCEL_ROUND_ALREADY_PENDING`, `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,
  `CANCEL_ROUND_SEAT_INELIGIBLE`, `CANCEL_ROUND_SUITE_UNKNOWN`, `CANCEL_ROUND_WINDOW_OUT_OF_RANGE`)
  plus the two 判据 III `CANCEL_ROUND_INVARIANT_VIOLATION` throw sites: registered here for
  owner/gate sign-off, since the lock names no code for any of these nine conditions.
- **G3 half B (组织单元) and the normal-path login-gate alignment** — both OPEN owner calls, stated
  in full in §3.4.
- **Q-A/Q-B/Q-C as owner-ratified lock order** (§9-4): still a review suggestion per lock §13's own
  framing; this slice's census (§6.3) supports the suggestion but does not convert it into a ratified
  fact, and does not yet exercise the real contended case (see §6.2's closing paragraph).
- **W7-R10 attendance-lane census, per-sibling `*-ci-wiring` census** (supplementary checklist items
  13/1): the migration file's own addendum (§2 above) closes the four attendance census pins for
  *this* lane's files; the checklist's broader caution about all 45 sibling `*-ci-wiring` guards is a
  different failure mode (a sibling guard's own hardcoded array missing this lane's files) and was
  not swept in this slice — left for the pre-PR door review.
- **Seed-visibility exposure in the template center (gate P2-B) — disclosed here as the deployment
  note the future PR body must carry; no code change made, narrowing decision left to the owner.**
  The dedicated seed migration
  (`zzzz20260918100000_seed_approval_cancel_round_published_definition.ts:73-81`) inserts the
  `approval_templates` row via `INSERT INTO approval_templates (id, key, name, description, status)`
  — it does **not** list `visibility_scope`, so the column takes its table-wide default, set by an
  unrelated, earlier migration:
  `zzzz20260423162000_add_approval_template_visibility_scope.ts:7`,
  `DEFAULT '{"type":"all","ids":[]}'::jsonb`. `applyTemplateVisibilityFilter`
  (`ApprovalProductService.ts:4469-4497`) passes any row whose `visibility_scope->>'type' = 'all'`
  unconditionally (`:4485`), and `listTemplates` (`:5757-5797`) calls it with no other visibility
  gate. First verified live on a fresh DB by the gate review
  (`impl-gate-C-slice1-round1-20260918.md`, finding P2-B, at HEAD `95eccb89b`); reconfirmed unchanged
  at this document's own HEAD (`git diff 95eccb89b..HEAD --stat` over the seed migration file and the
  whole `migrations/` directory is empty — the load-bearing facts have not moved). Net effect once
  this migration is *applied* (it is not applied anywhere today — this slice's DDL is Draft-only per
  the ratify header, and this document does not change that): the dedicated "撤销审批" template
  becomes visible to, and launchable by, every user in the template center, not only reachable
  through `createCancelRoundInstance`'s dedicated, code-only path. The node's own
  `requester_choice`/`scope:{type:'company'}` assignee configuration means a user-launched instance
  is a real, completable approval (not inert) — see the gate review's three-branch reachability
  argument for why the other two branches (missing choice, `emptyAssigneePolicy`) are unreachable via
  `createApproval` but this one is not. Nothing in lock §14.1 specifies template-center visibility
  for this seed, so this is not a lock violation — but it is a real, previously-undisclosed
  user-visible behavior change at apply time. Whether to narrow `visibility_scope` (e.g. an
  `ids`-scoped empty set, or a new "system template, hidden from the template center" category) is a
  scope addition beyond what lock §14.1 specifies, and is an **owner decision**, not made here.

Full status of every checklist line (including which of the above are 未做 vs. 已做-with-caveat) is
in the companion verification document, §10 ("checklist" table).
