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

**Window ceiling table**, pinned as of this document's own head so a reader does not have to run
the grep above just to learn the three values (if this table and the live constant ever disagree,
the code is authoritative — re-derive this table via the grep recipe above and update it in the
same commit that changes the constant; NOTE — this replaces a prior version of the code comment
that cited a private, out-of-repo owner rule page by name for these three values; that citation is
retracted as a provenance source here, not because the numbers changed, but because this table is
now the in-repo record the code comment points to instead):

| suite | ceiling (days) | lock clause | why |
|---|---|---|---|
| `attendance` | 180 | lock:143 | closed four-value domain, upper bound per suite |
| `leave` | 90 | lock:143 | closed four-value domain, upper bound per suite |
| `other` | 90 | lock:143 | closed four-value domain, upper bound per suite |
| `forbidden` | 0 | lock:143 | window fixed at 0; `CANCEL_ROUND_SUITE_FORBIDDEN` (lock §14.3 #14, lock:357) blocks instance creation before this number is ever read |

`windowDays ∈ [0, ceiling]` is lock:143's own bound, which is why these are an ENFORCED UPPER
BOUND rather than a default — see the rename rationale above.

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
| `CANCEL_ROUND_SEAT_INELIGIBLE` | 409 | At least one seat could not be re-convened. TWO classes, one code (owner ruling 2026-09-20 — **no new code minted**): (1) **QUALIFICATION** — an attributed subject is refused by the SHARED login gate `evaluateUserAuthenticationGate` (`is_active = FALSE`, `role = 'disabled'`, `activation_status = 'pending_activation'` / not in the closed set, or no `users` row at all) ⇒ `reasons ⊆ {inactive, pending_activation, activation_invalid, not_found}`; (2) **RESOLUTION** — an `approve` row cannot be attributed to a unique 原审批主体 ⇒ `reasons ⊆ {seat_unresolvable, delegate_not_seat}`. `metadata.nodeKey` on a legacy-route row is CALLER-SUPPLIED, so for an actor who held any delegated seat here it is CORROBORATED against `approval_assignments` (it must land on exactly one of that actor's own rows) rather than trusted — 负控 `N11(a)` / 正控 `P20(a)`. `details = { ineligibleCount, reasons }` — categories only, never an id; on the RESOLUTION class `ineligibleCount` counts ROWS (there is no person to count). The admin-facing MESSAGE differs by class: 「restore the account」 for (1), 「review this document」 for (2) — an admin-facing message must not promise a remedy that cannot work. **Judged only on claimed PERSONS**: `system:`-namespaced actors are dropped before attribution, so `reasons: ['not_found']` can no longer mean "a sentinel" (gate round 6, G6-1) and a sentinel row is never judged unattributable | lock §2-G3 (lock:74-76, 「重新验证当前资格…资格不成立的席位 ⇒ 阻断并提示管理员」); the lock names no code ⇒ **implementer erratum**, added 2026-09-19, reason vocabulary extended 2026-09-20 per the owner ruling |

> **实现者勘误,交 owner(2026-09-20)。** 本轮的任务简报另外点名了第三个新 reason 值
> `original_ineligible`。**没有加**,理由写在这里而不是留给人去发现:「原主体…已失格」这件事,
> 对**还原之后**的主体,已经由上面第 (1) 类的四个成员回答了(`负控 N5(a)` 是它的活证人 —— 停权委托人 A
> 现在以 `inactive` 阻断)。再加一个同义成员会造出**一个事实两套词汇**,并且丢掉「为什么失格」这半边信息,
> 正是本仓点名禁止的「另造更窄同类物」。若 owner 要的是「把『失格的是被还原的原主体』这件事也编码进去」,
> 那是一次**扩宽 `details` 形状**的合同变更(例如加一个 provenance 维),须 owner 亲裁 —— 本轮不做。
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
   sentinel actors** (gate round 6 G6-1 — shared predicate `isSystemSentinelActor`).
   (**owner-ruled 2026-09-20, reading (a)**: on this branch the sentinel drop runs FIRST and is then
   followed by the reading-(a) delegation restore, which decides WHO is seated per `approve` ROW and
   may instead report the row as UNSEATABLE. The two sub-steps are the same step 7 as far as the
   ratified order is concerned; the drop moved ahead of the attribution because a sentinel row must
   never be judged 「无法可靠还原」.)

8. **`assertCancelRoundSeatsEligibleInTxn`** (lock §2-G3) → 409 `CANCEL_ROUND_SEAT_INELIGIBLE`.
   **ORDER CHANGED on this branch (owner ruling 2026-09-20)**: this now precedes the zero-seat
   answer below, because a document whose every `approve` row is unattributable resolves to ZERO
   seats and would otherwise be answered `no_human_approver` — false, and the forbidden fallback
   wearing a different code. With zero unseatable rows the gate's own early exit makes the swap a
   no-op for every pre-existing corpus (负控 `N3` / `N6(a)` still answer `no_human_approver`).
9. **seat set empty after the drop and the restore** → 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,
   `details.reason = 'no_human_approver'` (gate round 6 G6-1)
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
- **G3 half C — 历史委托不自动成为当前授权 (RULED by owner 2026-09-20 — reading (a) + BLOCK).**
  **owner 裁决原话,逐字**:「席位回原审批主体,并重验当前资格。原主体无法可靠还原或已失格则阻断,
  不静默回退给历史被委托人;补多人委托同一人的反例。」 本节以下凡与该句冲突的旧措辞,**以该句为准**;
  本分支已按它实现,详见本条末尾的「**owner 裁决后的实现**」。**锁文正文未改**(owner 亲写件)。 The shipped seat derivation read `approval_records(action='approve').actor_id`
  verbatim, so when the original document's seat had been produced by a delegation the seat replayed
  onto the cancel round was the DELEGATEE, and today's delegation state was never consulted. Measured
  on a real DB (independent verification 2026-09-19,
  `reviews/verify-c1-lock-g3-delegation-20260919.md` §2.2): a delegation still active, one revoked
  (`active = FALSE`), one whose window has expired, and one deleted outright all yielded the
  BYTE-IDENTICAL seat set and a 201 — the seat set is insensitive to the clause's own predicate. The
  eligibility gate compounds the asymmetry: deactivating the DELEGATOR did not block, deactivating
  the DELEGATEE did.
  - **Provenance exists and is reachable inside the creation transaction.** NOT in
    `approval_records` (that table has no `delegated_from`-style column, and the approve row's
    metadata carries none) but in `approval_assignments.metadata.delegatedFrom`, written by
    `ApprovalAssigneeResolver.pushResolved` — the repo's single delegation substitution point — and
    KEPT after approve as `is_active = FALSE` audit history. `ApprovalDelegationConfig
    .countDelegatedApprovals` already reads exactly that column, with no `is_active` filter, and its
    own comment calls it an audit trail.
  - **Two readings are open, and they are not interchangeable.** (a) the seat belongs to the
    ORIGINAL APPROVER — 委托 is acting-on-behalf-of, never a transfer of authority; (b) the delegatee
    keeps the seat only if that delegation is still live at the moment the cancel round opens, and
    otherwise the seat returns to the delegator. They differ on exactly one leg (delegation still
    valid) and both differ from the pre-candidate behaviour on all four legs. A third reading —
    「不要把原单冻结的委托映射带到新轮」 — is satisfied BY CONSTRUCTION and is NOT a substitute for
    either: the cancel round's own `requester_snapshot` key set is verbatim
    `["id","name","requesterChoices"]`, with no `delegations` key (measured). If THAT reading is the
    one ratified, it needs a standing positive control pinning that key set, or one future spread
    silently regresses it.
  - **Scope trap, for whichever reading lands.** `resolveActiveDelegationMap` filters
    `scope='template'` rows by templateId. A cancel round runs on its OWN dedicated published
    definition, so any re-resolution must be given the ORIGINAL document's `template_id`; passing the
    round's own would silently narrow support to `scope='all'` rows. `approval_instances.template_id`
    is nullable, so a NULL-template original can only ever match `scope='all'` rows — that semantic
    must be stated, not inherited by accident. Reading (a) below never calls that resolver, so it
    neither hits nor answers this trap; reading (b) would.
  - **Why this bullet stays OPEN even though a candidate is implemented on this branch.** The clause
    is RATIFIED and its reading is not. Landing the candidate does not rule it, and deleting this
    registration would launder an owner decision that has not been made. The bullet is discharged by
    an owner ruling, not by a green suite.

**§2-G3 逐句求值(lock:74 三个分句,第一个分句含两个半边;逐条求值,不按节给一个总状态):**

| # | 锁文原句 | 本 head 的状态 | 证据 |
|---|---|---|---|
| 1a | 分句一:「重新验证当前资格(**在职**…)」 | **SHIPPED** (half A) | `assertCancelRoundSeatsEligibleInTxn`;`§2-G3 正控 P1` / `负控 N1` / `负控 N2` |
| 1b | 分句一:「…**仍在该组织单元**」 | **OPEN** (half B) — 未实现、已登记 | 常驻 `正控 P2`(`org_id IS NULL` 的原单不被拒) |
| 2 | 分句二:「历史委托不自动成为当前授权」 | **RULED by owner 2026-09-20 —— 读法 (a) + 阻断;已在本分支实现** | 独立验证 §2.2 四腿逐字相同;**25 条**真库用例 + 五条 mutation(M-B/M-C/M-D/M-E/M-F,见验证 MD **Part O**;Part N / N-H 的对应读数已被 Part O 取代) |
| 3 | 分句三:「资格不成立的席位 ⇒ 阻断并提示管理员」 | **SHIPPED**(阻断,永不过滤)。owner 2026-09-20 裁决把它的**人口**也定死了:席位要么是**被还原的原审批主体**并在他身上求值,要么**根本坐不下**(行不可归属)⇒ 同样阻断。legacy 无 `nodeKey` 语料上「席位停在 D、该句对 A 不执行」的旧状态**已不复存在** | `负控 N1/N2` 的零行断言;mutation R7-M3 与 **M-C**;legacy 臂 `P12(a)/N7(a)/N8(a)/P13(a)`(现在全部断言 **409 零行**);多人委托臂 `N9(a)/N10(a)` |

分句二那一行是本次新增的一行:在此之前它既不在 SHIPPED 一侧、也不在 OPEN 清单上,而同一条款的组织半边
(half B,上表 1b)一直被明文登记 —— 同条款内处置不对称本身就是披露缺口(独立验证 §8 把它记为 P2,
阻塞的是**登记**而非实现)。

**实现(owner 2026-09-20 裁定 **读法 (a) + 阻断**;原话逐字:「席位回原审批主体,并重验当前资格。
原主体无法可靠还原或已失格则阻断,不静默回退给历史被委托人;补多人委托同一人的反例。」)** —
落在 `feat/approval-cancel-round-phase1-g3-reading-a` 分支上并已真库跑通(验证 MD **Part O**)。
本节其余部分描述的就是落地后的语义。**锁文正文未改** —— 它是 owner 亲写件;本节是切片设计文档,
不是锁文,裁决的权威来源是 owner 的原话,不是这段转述。

The seat query restores the delegatee back to the DELEGATOR before anything else runs: 委托 is
acting-on-behalf-of (履职代理), not a transfer of the seat, so a cancel round re-convenes the person
whose authority the original decision carried. The restore is a LEFT JOIN on
`(instance_id, node_key, assignee_id)` — deliberately not `(instance_id, assignee_id)`: a delegatee
who also holds a seat OF THEIR OWN at another node keeps that seat as their own, which an
instance-wide match would fold into the delegator too (measured both ways, 验证 MD Part N §N3).
`entry_epoch` is deliberately NOT in the join (it is NULL on pre-migration rows, and `NULL = NULL`
would turn the whole restore into a silent no-op for exactly the legacy corpus this method is
likeliest to meet).

**Why the candidate shares ONE eligibility predicate with half A rather than adding a
delegation-specific gate.** The restore is inserted between the approve-trail read and the sentinel
drop, so the rest of the sequence is untouched: sentinel drop → zero-human-seat pre-check →
`assertCancelRoundSeatsEligibleInTxn`. `evaluateUserAuthenticationGate` remains the single seat
predicate; it now simply runs on the person actually being seated. A second, delegation-specific
eligibility rule here would be the narrower-lookalike this slice already refuses elsewhere.

**Behaviour delta, stated rather than discovered later** (the BEFORE column is measured, independent
verification 2026-09-19 §2.2; the AFTER column is measured on this branch, 验证 MD Part N):

**语料是一个独立的维度,必须和表一起读**:`actions` 语料的 approve 行带 `nodeKey`,legacy
`POST /:id/approve` 语料的不带。**owner 2026-09-20 裁决之后,legacy 语料整列的答案变了** —— 那一列
此前记的是「创建成功、席位 `[D]`」,即裁决明文禁止的 **静默回退给历史被委托人**;现在它一律是 **409 阻断、
零行**。下表 AFTER 两列全部是本分支上的**实测**读数(验证 MD Part O)。

| scenario | before(实测) | after, reading (a) RULED —— `actions` 语料 | after —— legacy 无 `nodeKey` 语料 |
|---|---|---|---|
| delegation still active | seat = delegatee | seat = **delegator**(`P4(a)`) | **409 `SEAT_INELIGIBLE` / `delegate_not_seat` / 零行**(`P12(a)`) |
| delegation revoked / expired / out of scope / exactly in scope | seat = delegatee | seat = **delegator**(`P5(a)`–`P7(a)`、`P9(a)`) | revoked 腿实测 **409 / `delegate_not_seat`**(`N8(a)`,该腿另叠了「停权 A」);其余三腿未在此语料构造 |
| DELEGATOR deactivated | creation succeeds | **409 `SEAT_INELIGIBLE` / `inactive` / 零行**(`N5(a)`) | **409 / `delegate_not_seat` / 零行**(`N7(a)`)—— 阻断的理由是行不可归属,不是 A 失格 |
| DELEGATEE deactivated | 409, zero rows | **creation succeeds**, seat = delegator(`P8(a)`) | **409 / `delegate_not_seat` / 零行**(`P13(a)`)—— reason 不再是 `inactive`:D 从未被坐下 |
| 多人委托同一人(A→D、B→D,两节点) | seat = `[D]`(1 席) | seat = **`{A, B}`**(2 席,`P16(a)`) | **409 / `seat_unresolvable` / 零行**(`N9(a)`) |
| 多人委托同一人 × A 已停权 | creation succeeds | **409 / `inactive` / 零行**(`N10(a)`),**不**回退给 D | (同上,先被 `seat_unresolvable` 拦住) |
| legacy 语料但**从来没有过委托** | 201, seat = `[A]` | (不适用) | **201, seat = `[A]`**(`P19(a)`)—— 阻断不外溢到整个历史语料 |
| legacy 请求体伪造 `metadata.nodeKey` 成不存在的节点 | 201, seat = `[D]`(**修复前实测可绕过整组阻断**) | (不适用) | **409 / `seat_unresolvable` / 零行**(`N11(a)`) |
| legacy 请求体带**真实**的 `nodeKey` | 201, seat = `[D]` | (不适用) | **201, seat = `[A]`**(`P20(a)`)—— 传真话不是绕过,是把还原做对 |
| 被委托人用 legacy 给自己的兄弟节点报成被委托节点 | (同形诚实单据 `P11(a)` 答 `{A, D}`) | (不适用) | **201, seat = `[A]`**(`P21(a)`)—— **已登记残留**:他把自己摘了出去,门槛 2→1 |

Reading (a) answers 「原审批人」 uniformly, so a still-valid delegation does NOT route the cancel
round to the delegatee. That is a consequence of the cancel round's own snapshot carrying no
`delegations` key (measured: its `requester_snapshot` key set is verbatim
`["id","name","requesterChoices"]`), i.e. the resolver never re-applies a substitution on the new
round. The alternative reading 「restore, then RE-RESOLVE against today's delegation」 — which would
seat today's delegatee, or a third person if the delegator has since re-delegated — is a DIFFERENT
contract and is not implemented here.

**NOT closed by the candidate (recorded, not laundered):**

- **Approve rows with no `nodeKey` —— `CLOSED IN THE BLOCKING DIRECTION` by the owner ruling
  2026-09-20 (was: registered OPEN).** The legacy `POST /api/approvals/:id/approve` route copies
  `metadata` verbatim out of the request body, so an approve row written there carries no `nodeKey`
  and cannot be attributed to a node seat. Up to the ruling the actor simply KEPT the seat, i.e. the
  historical delegatee held it — which the ruling forbids in as many words. The candidate now
  BLOCKS instead:
  - the actor holds **no** delegated seat on this instance ⇒ the actor IS the subject and is seated
    normally, whatever the row says. **This arm is asked FIRST, is load-bearing, and is pinned by
    正控 `P19(a)`**: without it every document ever approved through the legacy route — the entire
    pre-delegation corpus — would 409;
  - the row has **no `nodeKey`** and the actor holds **exactly one** delegated seat here ⇒ 409
    `CANCEL_ROUND_SEAT_INELIGIBLE`, `details.reasons = ['delegate_not_seat']`, zero rows;
  - the row has **no `nodeKey`** and the actor holds **two or more different** delegators here (the
    owner's own 「多人委托同一人」 counter-example) ⇒ same code, `reasons = ['seat_unresolvable']`;
  - the row **names a node** and the actor holds a delegated seat here ⇒ the name is **CORROBORATED**:
    it must land on **exactly one** of that actor's own assignment rows, delegated or not. Anything
    else ⇒ `reasons = ['seat_unresolvable']`.

  **Why corroboration, and not "trust `nodeKey` when it is present" (the first cut of this fix, which
  was MEASURED to be trivially bypassable).** The legacy route copies the request body's `metadata`
  verbatim into `approval_records.metadata`, so `nodeKey` there is caller-supplied. Trusting it let any
  holder of `approvals:act` walk past this entire block by sending
  `{"metadata":{"nodeKey":"totally_made_up_node"}}` — measured on a real DB: the delegatee was seated
  and nothing blocked. 负控 `N11(a)` is that witness, now blocking; 正控 `P20(a)` sends the TRUE
  `nodeKey` down the same route and gets the honest restore, so the rule rejects **names without
  evidence**, not «metadata in the body».

  Restoring to the single known delegator was considered and NOT chosen: the same actor may also
  have approved a seat OF THEIR OWN through the same node-key-less route, so the restore would be a
  guess. Both candidate answers are unsafe ⇒ neither is taken ⇒ BLOCK. The instance-wide fallback
  registered here previously is therefore also closed out: it would have mis-folded the sibling-seat
  case (正控 `P11(a)`).

  **KNOWN RESIDUAL, registered and pinned rather than left to be found (负控 `P21(a)`, MEASURED).**
  Corroboration proves the named node is one the actor really held; it cannot prove it is the node
  **this particular row settled**. A delegatee who ALSO owns an un-delegated seat at another node can
  therefore send the legacy approve naming the **delegated** node: both rows then restore to the
  delegator and the delegatee **drops out of the cancel round**, taking the 会签 threshold from 2 to 1
  (`P11(a)`, the honest same-shape document, answers `{A, D}`). The failure direction here is the
  actor REMOVING themselves, never gaining a seat, and it needs the actor to genuinely hold both seats.
  Closing it needs either the legacy route to write `nodeKey` itself (a contract change to a shipped
  endpoint) or a 「seats vs approve rows」 reconciliation (which would misfire on honest corpora) —
  **both owner calls, neither done here**. `P21(a)` pins today's answer and will go red when it is fixed.

  **What this does NOT claim.** It does not make the legacy route write `nodeKey`, and it does not
  give an administrator a way to re-open such a document — the error message says 「review this
  document」 rather than 「restore the account」 precisely because there is no account to restore.
  A remediation path (backfilling `nodeKey`, or a per-document override) is **NOT in this slice** and
  is an owner call. **爆炸半径,实测而非估计**:阻断只命中「approve 行无 `nodeKey` **且** 该 actor 在本实例
  上有委托席位」的单据;`P19(a)` 证明无委托的 legacy 单据照常创建。本仓今天没有针对 legacy 语料 ×
  委托 的存量普查(需要生产库,不在本轮授权内)—— 这条**写成缺口而不是写成「影响很小」**。

  The writers that DO carry `nodeKey` were read individually: the template-runtime dispatch's
  `insertApprovalRecord` callers and `insertAutoApprovalEvents`. `ApprovalBridgeService`'s writer
  does not, but bridge instances never pass through `createApproval` and so carry no `delegatedFrom`
  row for the join to find.
- **Seat-count collapse when the same person holds both a role seat and a delegated user seat.**
  Delegation substitutes only `assignmentType === 'user'` seats, so a document approved by A through
  a role node AND by D as A's delegate at a user node has two seats before and one after the restore
  — a genuine reduction of the 会签 threshold. The block-never-filter invariant covers INELIGIBLE
  seats, not this same-person merge. Owner call; **not decided here**.
  **硬化轮 2026-09-20(门审 P3-2):不再是「零用例」。** `正控 P15(a)` 钉的是**今天的答案** ——
  角色节点由 A 本人批、user 节点由代理 D 批 ⇒ 还原后两条 approve 行同指 A ⇒ 席位 **2 → 1**
  (撤销节点是 `approvalMode: 'all'`,所以这就是会签门槛的下降)。该腿**不预判裁决**,理由与 `P12(a)`
  同构:owner 尚未裁的取舍,先把「今天的答案是什么」钉成数据;裁决之后该腿或被改写或被移除,
  但不会是「悄悄变了而没人发现」。
- **Re-entered nodes.** `entry_epoch` is out of the join by design (above), so a node re-entered
  after a reject→resubmit can carry several delegated assignment rows for the same
  `(instance, node_key, assignee)`. Not measured in this round; recorded as the known mirror of the
  collapse risk rather than claimed absent.

  **硬化轮 2026-09-20 —— 这条登记 KEPT OPEN,并说明为什么一条看似充分的普查不足以关掉它。**
  门审 §P3-1 提议用三行普查(`delegatedFrom` 唯一写入方 = `ApprovalAssigneeResolver.pushResolved`;
  `resolveActiveDelegationMap` 生产调用点唯一 = `ApprovalProductService.ts:7947`;解析器纯函数,
  全文 `await` 0 / `async` 0 / `.query(` 0)推出「对固定 `(instance, node_key)` 解析出的原审批人、
  因而 `delegatedFrom`,跨 epoch 恒定 ⇒ 膨胀不可达」。**三行普查本身在本轮复核属实**(逐条重跑,读数相同),
  **但它的推论有一个洞**,而且洞就开在本节下一条登记的那个兄弟界面上:
  `ApprovalAssigneeResolver.ts` 自己的文档写着 —— `prior_node_approver`(Lock-1 §K3)是
  **「the one kind whose input is caller-supplied at activation rather than create-frozen」**。
  也就是说在 15 种 assignee 源里,**至少这一种的输入不是创建时冻结的**:它读的是节点激活时由调用方现算的
  `priorNodeApprovers`(来源是活的 `approval_records`)。对这种节点,「跨 epoch 恒定」的前提不成立。
  (解析器另有一个 late-bound 输入 `getEffectiveSamePersonPolicy`,但它不产出 `delegatedFrom`,
  本条不依赖它;点出来是为了不把「只有一个 late-bound 输入」写成断言。)
  因此本节不写「膨胀不可达」,只写:**普查没有证明不可达**,洞在 §K3。
  一条构造草图(**UNVERIFIED / NOT CONSTRUCTED THIS ROUND**,写出来是为了让后来者能便宜地攻击它):
  两个委托人 A1、A2 都委托给同一个 D;A1/A2 只能经**角色席位**成为 actor(委托只替换
  `assignmentType === 'user'` 的席位,见 `pushResolved` 的 `if (assignmentType === 'user')`——
  这是整条草图最承重的一步);下游 §K3 节点按审计行顺序解析出 [A1, A2] 并 dedup 成一个 D 席位,
  `delegatedFrom` 取**第一个**;若 return 之后第二轮的批准顺序相反,同一 `(instance, node_key, D)`
  就会留下 `delegatedFrom` 分别为 A1 与 A2 的两行 —— 一条 approve 行 join 到两行 ⇒ 席位集合膨胀。
  本轮未构造、未实测,故本条**保持 OPEN**,不按已证伪处理,也不按已证实处理。

  **owner 2026-09-20 裁决之后的变化,写清楚它关掉了什么、没关掉什么。** 席位推导现在对
  「同一 `(instance, node_key, assignee)` 解析出 **>1** 个不同 `delegatedFrom`」的行**阻断**
  (`reasons = ['seat_unresolvable']`),所以**即使**上面那条草图被构造出来,结果也不再是**席位集合膨胀**,
  而是 **409 零行**。这把风险方向从「更宽的席位」翻成了「拒绝」。
  **但本条仍然 OPEN**,理由是两点、都不含糊:① 那条 `>1` 的**具体臂本轮未构造**
  (`idx_approval_assignments_active_unique` 是 `WHERE is_active = true` 的部分唯一索引,需要一次
  真正的节点再入去改写委托才能造出两行),所以「它会阻断」是**按代码推出的**,不是实测 ——
  实测覆盖的是**同一个 reason 值**的另一条臂(`N9(a)`,无 `nodeKey` × 两个委托人);
  ② 「阻断」本身是不是这一格**想要**的答案,是语义裁决:一次再入把一张本来可撤销的单据变成永久不可撤销,
  属 owner。
- **`loadPriorNodeApproverDeciders`(Lock-1 §K3)—— 读法 (a) 是否外推到这个兄弟界面?**
  **OPEN,与 half B 同等待遇:未实现、已登记,由 owner 裁。**
  候选自己的注释点名了这个兄弟界面:仓内有**两处**从同一份 `approval_records(action='approve')`
  推导席位,两处共用同一个 `isSystemSentinelActor` 哨兵谓词,**但只有撤销轮这一处做委托还原**。
  受影响的消费点:`prior_node_approver` 源、admin-jump、timeout-jump、常规派发 —— 它们今天仍把席位
  给**被委托人 D**。
  **建议(仍待 owner 裁):不外推。** 理由是一条站得住的区分:`prior_node_approver` 发生在**同一个实例内**,
  冻结的委托映射**仍然在生效**,D 此刻就是 A 在**这张单据**上的履职代理;而撤销轮是**新实例**,
  冻结映射不适用。这个区分是**语义裁决**,候选既没作它也没登记它 —— 本轮补登记,不代裁。
  今天的答案已被钉成数据:`正控 P14(a)` 在**同一张单据**上同时求值两个界面 ——
  §K3 节点的席位是 **D**(`delegatedFrom` 为空、`resolvedFrom.kind = 'prior_node_approver'`),
  撤销轮的席位是 **{A, D}**。若 owner 裁定**外推**,候选即为**部分应用**,须同 PR 改两处,而该腿会红并点名自己。
- **会签节点上多人委托给同一人 ⇒ 席位在**建单时**就已折叠(NEW registration, 2026-09-20).**
  MEASURED(`正控 P17(a)` / `P18(a)`):`ApprovalAssigneeResolver.pushResolved` 用 `user:<delegatee>`
  做 dedup 键,所以一个 `approvalMode: 'all'` 的三人节点 [A, B, C] 在 A→D、B→D、C→D 全部有效时
  只产生**一条** assignment(`assignee = D`,`delegatedFrom = 第一位委托人 A`)——
  **会签门槛在原单被创建的那一刻就从 3 变成了 1**,与撤销轮无关。撤销轮因此只能还原出 `[A]`(1 席);
  B、C 的席位在审计轨迹里**不留任何痕迹**,还原读不到、也就无从阻断。
  这**不是** `seat_unresolvable`(没有两个候选,只有一个),阻断谓词对它**零判别力**。
  处置:**登记,不在本切片修**——修它要动的是 `pushResolved` 的 dedup 键(全仓唯一的委托替换点,
  爆炸半径覆盖每一条派发路径),属 owner。两条腿钉的是**今天的答案**,若将来被修好它们会红。

- **G3 half B (组织单元)** remains OPEN exactly as registered above.


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

  > **求值标记(候选分支 `feat/approval-cancel-round-phase1-r8`, 2026-09-21)。** 本条的
  > **状态断言**——「no code change made」「`visibility_scope` 取表级默认」「becomes visible to, and
  > launchable by, every user」——在该候选分支上**已失效**:种子迁移现在显式写入一个收窄的
  > `visibility_scope`,并有真 HTTP 用例把两个消费面钉住(见 §11)。本条其余内容**仍然 OPERATIVE**:
  > (a) 机制描述(默认值 + `applyTemplateVisibilityFilter` 第一条析取支)逐字仍成立,是 §11 那个修法
  > 的依据;(b) 「Whether to narrow … is an **owner decision**」这句**没有**因为候选分支动了代码而作废
  > —— 候选分支选的是一种**既有语义**下的临时收窄,把「接线时翻回可见用哪种机制」原封不动留给 owner
  > (§11 末尾把两条路线都写出来,不选)。下面这一整段保留原文,**不**因为候选分支而改写。

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

---

## 10. 部署序与回滚(候选新增,2026-09-21,分支 `feat/approval-cancel-round-phase1-r8`)

本节记录的是**部署耦合**,不是新增设计。它存在的理由:§2.3 的 Q1c 迁移与
`plugins/plugin-attendance/index.cjs` 的写入侧是**双向硬耦合**,而这一点此前只散落在迁移文件头和
测试注释里,没有一处把「先部署哪一侧会怎样」写成可执行的部署说明。以下三种失败模式全部在一次性真库上
实测得到(`metasheet2_c1r8_20260921` / `_pf2`,owner `ms2testbed`,非超级),不是读码推断。

### 10.1 三种失败模式

| # | 部署组合 | Postgres 报错 | 影响面 |
|---|---|---|---|
| (c) | **已迁移的库 + 旧(main)代码** | `23514`,约束 `atr_instance_key_pair` | 旧写入不带 `approval_workflow_key`(列存在但写 NULL),而 `approval_instance_id` 恒为刚建的实例 id(非 NULL)⇒ `(approval_instance_id IS NULL) = (approval_workflow_key IS NULL)` 为假 |
| (b) | **未迁移的库 + 新(合并后)代码** | `42703`,`column "approval_workflow_key" ... does not exist` | 新写入显式列出了尚不存在的列 |
| (a) | 两侧都对,但被引用的 `approval_instances` 行 `workflow_key IS NULL` | `23503`,约束 `attendance_requests_instance_workflow_fkey` | 复合 FK 在 `(id, workflow_key)` 上找不到对应行 |

**(b) 与 (c) 合起来的结论:代码与三条迁移必须同一次发布,且两侧都不能先行。** 任一方向的部署窗口内,
考勤请求提交不是概率性退化,而是 100% 失败。

「5 个写入点」是本轮机械点数,不是转抄:`plugins/plugin-attendance/index.cjs` 内
`approval_workflow_key` 恰好出现 5 次 —— 4 条 `INSERT INTO attendance_requests`(`:33702` / `:33945` /
`:34221` / `:34507`)加 1 条 `UPDATE`(`:34850`)。同一文件另有 4 条 `UPDATE attendance_requests`
(`:35250` / `:35627` / `:37952` / `:37968`)不触及这两列,在已迁移库上不受影响。这 5 处的
`approval_instance_id` 参数取自紧邻上方 `upsertAttendanceApprovalInstance` 新建的实例 id,**恒非
NULL** —— 这正是 (c) 之所以是 100% 而不是「视数据而定」的原因。

### 10.2 preflight:一行悬空 ⇒ 整批回滚

迁移在建任何约束之前先跑一条计数 SELECT(`LEFT JOIN approval_instances` 上
`approval_instance_id IS NOT NULL AND (i.id IS NULL OR i.workflow_key IS NULL)`),非 0 即 `throw`。
实测(`_pf`/`_pf2`):失败后 `kysely_migration` 内该条**没有记录**,四条约束**一条没建**,连
`ADD COLUMN` 的那一列都不存在 —— 回滚干净,无半应用状态。代价是:**生产里只要存在一行这样的历史数据,
整条迁移链就地停摆,`migrate` 非零退出,排在其后的所有迁移一并不落。**

### 10.3 preflight 覆盖不到的第四种(本轮新发现,已实测)

一条 `attendance_requests` 行,若其 `approval_instance_id` 指向的实例
`workflow_key = 'approval.cancel-round'`:

- 它**通过** preflight —— 该谓词只问「悬空」与「键为 NULL」,这行两者都不是,计数返回 `0`;
- 回填把 `'approval.cancel-round'` 逐字写进新列;
- 随后 `ADD CONSTRAINT atr_not_cancel_round` 以 **`23514` / `constraint: 'atr_not_cancel_round'`**
  失败,整批回滚。

实测方式:在一个一次性库上先排除该迁移跑完全量,种入 1 行该形状的数据,再不排除地重跑 `db:migrate`。
**即:只跑 preflight 自带的那条 SELECT 不足以判定「可以部署」。** 今天这一集合**应当**为空(生产无任何
路径能造出该 `workflow_key` 的实例,这一判断由候选分支上两件可执行守卫承担),但它在**入口切片接线之后**
会变成可达集合,因此是接线批次的回归项,不是一次性检查。

给 owner 的只读普查语句(五条 SELECT + 逐条判据 + 非 0 时的处置选项)在
`c1-attendance-coupling-census-pack-20260921.md`,不在本仓。

### 10.4 回滚必须分三层

1. **代码回滚**:回代码不回迁移 ⇒ 立刻退化成 (c) 的 `23514`。代码回滚必须与迁移回滚同批,或不回滚而
   向前修。
2. **迁移回滚**:回迁移不回代码 ⇒ (b) 的 `42703`。另:`down()` DROP 掉新列,已回填的
   `approval_workflow_key` 随之丢失 —— 可由 `approval_instances.workflow_key` 重新推导,但那是一次新的
   回填,不是「撤销」。已应用环境的默认姿势仍是保留 schema、向前修。
3. **业务补偿**:前两层都不恢复窗口期内已失败的考勤提交 —— 那些请求根本没落库。通知与重提属 ops/业务
   动作,不属代码动作。

---

## 11. 种子模板可见性(候选新增,2026-09-21,分支 `feat/approval-cancel-round-phase1-r8`)

### 11.1 改了什么

`zzzz20260918100000_seed_approval_cancel_round_published_definition.ts` 的 `approval_templates`
INSERT 现在**显式**写 `visibility_scope`,取值来自共享常量
`CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE`(`src/db/seeds/approval-cancel-round-published-definition.ts`):

```
{ "type": "user", "ids": ["__approval_cancel_round_system_only__"] }
```

迁移末尾的读回守卫同批扩到这一列 —— `ON CONFLICT (id) DO NOTHING` 本来会让一条既存行的(可能是默认的、
对所有人可见的)scope 原封不动留下而迁移照常报成功,正是该守卫存在的那一类静默错误。

**改的是一条尚未在任何环境应用的迁移正文**,不是新加一条数据迁移。这一点是前提而非可长期依赖的性质:
三条迁移今天在任何环境都未应用(PR 仍是 Draft);一旦某处已应用,同样的收窄就只能用追加迁移做。

### 11.2 为什么是这个取值(三个被否掉的替代)

| 取值 | 隐藏效果 | 否掉的理由 |
|---|---|---|
| 留默认 `{"type":"all","ids":[]}` | 无 | `applyTemplateVisibilityFilter` 第一条析取支 `COALESCE(visibility_scope->>'type','all') = 'all'` 对**每个** actor 命中 |
| `{"type":"ids","ids":[]}`(先前草案里的写法) | SQL 上确实隐藏 | `ids` **不是**合法取值:`APPROVAL_TEMPLATE_VISIBILITY_TYPES` 是 `{all, dept, role, user}`,库级 CHECK `approval_templates_visibility_scope_shape` 同样只认这四个 ⇒ 插入即 `23514`;且 `readTemplateVisibilityScope` 会把未知 type 归回 `{type:'all'}`,DTO 说「对所有人可见」而 SQL 隐藏,两边打架 |
| `{"type":"user","ids":[]}`(空集) | 与选中方案同效 | 写路径校验器 `normalizeTemplateVisibilityScope` 对 scoped 模板拒绝空 `ids`(400 `VALIDATION_ERROR`),而编辑端在**每次**模板保存时都回传这个字段(`apps/web/src/approvals/templateAuthoring.ts` 的 `buildUpdateTemplatePayload` → `buildCreateTemplatePayload` → `buildVisibilityScope`,初值由 `draftFromTemplate` 从 `template.visibilityScope` 取)⇒ 该行对有权限的模板管理员**永久不可编辑**,一次无关的改名会以一句看不懂的可见性错误失败 |
| **`{"type":"user","ids":["__approval_cancel_round_system_only__"]}`(选中)** | 同效 | 通过写路径校验(非空、37 字符 ≤ 128 上限)⇒ 行仍可编辑;`user` 是**既有**已发布语义,不是新造的;哨兵命名沿用同一个过滤器自己的约定(`__approval_template_no_dept__` / `__approval_template_no_role__`) |

**残留,明写不藏:** `users.id` 是 `TEXT`(`packages/core-backend/migrations/054_create_users_table.sql:5`),
所以「无人命中」靠的是约定而非类型层面的不可能 —— 与该过滤器自带的两个哨兵同一类残留。

### 11.3 为什么这个收窄不影响撤销轮本身

撤销轮专用的创建路径**根本不读 `approval_templates`**:它按 `CANCEL_ROUND_PUBLISHED_DEFINITION_ID`
定位,并刻意绕开 `templateVisibleAtCreateBoundary` / `applyTemplateVisibilityFilter`(该方法自己的文档
注释写明了这一点)。因此这条 scope 既不启用也不禁用撤销轮 —— 这正是「今天可以隐藏、接线时再翻回可见」
成立的原因。

### 11.4 可执行证据

`packages/core-backend/tests/integration/approval-cancel-round-seed-template-visibility.db.test.ts`
(真库 + 真服务器 + 真 HTTP,7 条):

- 种子行存在,且 `visibility_scope` 逐字等于共享常量(不是 skip:跑在没应用过该迁移的库上会红,而不是
  空转绿);
- 普通用户(`approvals:read` / `approvals:act` / `approvals:write`,**非** template-manager)翻完**全部**
  分页都取不到种子(按 id 与按名各钉一次);
- `?search=<种子名>` 的响应与 `?search=<恒不匹配的 token>` 的响应**逐字节相同**;
- `GET /api/approval-templates/<种子 id>` 与 `GET /api/approval-templates/<从未存在的 uuid>`
  **状态码与响应体逐字节相同**(404 `APPROVAL_TEMPLATE_NOT_FOUND`);
- `POST /api/approvals` 以种子 templateId 发起,与以从未存在的 templateId 发起**逐字节相同**(404),
  且 `approval_instances` 没有对应新行;
- **正控**:同一 token 用一个对**他**可见的模板发起 ⇒ 201(证明上面的 404 不是写权限门在挡);一个
  scope 指向**别人**的模板对他不可见(证明 `user` 支按 actor 自己的 id 匹配);同样三个端点对
  template-manager **仍然**返回种子(既有管理员语义未变)。

**变异实测(证明这些断言承重,不是空转):** 把种子行的 `visibility_scope` 改回默认
`{"type":"all","ids":[]}` 再跑同一文件 ⇒ **7 条里 5 条红**(DB 形状、全分页缺席、`?search=` 字节等同、
详情 404、创建 404 各红一条),恢复后复绿。该变异同时给出一条**此前未被实测过的事实**:在默认 scope 下,
一个只持 `approvals:read` + `approvals:write` 的普通用户对种子 templateId 发 `POST /api/approvals`
并不是被挡住 —— 它一路走到节点解析层(422 `APPROVAL_REQUESTER_CHOICE_REQUIRED`);补上
`requesterChoices` 后返回 **201**,落下一条 `publishedDefinitionId` 指向该种子定义的真实待办实例。
需要说明清楚的是:这条实例的 `workflow_key` 是 `'approval-product-template'` 而**不是**
`'approval.cancel-round'`,因此 `isCancelRoundInstance` 对它为假、九处出口守卫都不适用 —— 它是「用系统
定义跑出来的普通实例」,属数据形状污染,**不是**守卫被绕过。细节不进 PR body / 提交信息。

### 11.5 接线时如何翻回可见(两条路线,均为 owner 裁决,本文不选)

1. **一条数据迁移**:新加一条迁移,把该行改成目标可见范围,例如
   `UPDATE approval_templates SET visibility_scope = '{"type":"all","ids":[]}'::jsonb WHERE id = <种子 id>`
   —— 或改成真正想要的受众(某个角色 / 某些部门),而不是一步跨回「对所有人可见」。优点:状态在库里,
   一次性、可审计、可回滚(`down()` 写回哨兵)。缺点:不可按环境差异化。
2. **运行期开关**:在 `listTemplates` / `getTemplate` / 创建边界共用的那层加一个「系统模板」标记与开关
   位,由配置决定是否对普通用户呈现。优点:可分环境、可灰度、可即时回退。缺点:新增一条常驻判据面,
   且要同时回答「开关关闭时创建边界是否也拒绝」这个问题,否则两套判据打架。

无论选哪条,接线那一批都必须同时把两件休眠守卫从「零调用方 / reach=0」升级成「恰好 N 个被点名的调用方 /
只有被点名入口能 reach」,否则守卫要么在接线当天变成永久红,要么被顺手删掉。
