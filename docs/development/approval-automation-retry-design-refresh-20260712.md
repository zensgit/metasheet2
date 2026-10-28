# Automation retry / test-run / notification-redelivery — design refresh (2026-07-12, Rev 2)

**Status: PROPOSED (doc-only; no runtime).** Refresh of the 2026-07-09 lock
(`approval-automation-retry-and-sample-testrun-design-lock-20260709.md`, PR #4032) against `origin/main`
`592be07ec`.

> **AMENDMENT / SUPERSEDING AUTHORITY.** This document is an **amendment** to the 07-09 lock, not a parallel
> note. Where the two conflict, **this Rev-2 refresh is authoritative** for: the three-semantic split (§1),
> the delivered ledger (§2), the idempotency-identity + write-semantics + retention corrections (§4 C1–C3),
> the `action_key` definition (§4 C4), the retry-vs-resume boundary (§4 C5), and the open-question menu (§5).
> The 07-09 lock's §4.2 "at-most-once" wording is **factually wrong and is corrected both here (§4 C2) and in
> the 07-09 lock itself** (this PR edits that file too). The 07-09 §4.1/§4.3/§4.4/§4.5/§5/§6/§11 remain in
> force except where §4 below explicitly overrides them.
>
> **Scope guard (owner-set, MS-AUTOMATION-RETRY-DESIGN-REFRESH):** docs/design-lock only; stays PROPOSED; no
> runtime; does **not** touch the in-flight approval P1 (#4158); no permission expansion; implementation is a
> separately-authorized later slice.

---

## 1. Three semantics that share verbs — DO NOT conflate

"retry" / "resume" / "re-send" / "test" span **four** distinct behaviours across two subsystems. Conflating
them is the failure mode this refresh prevents (standing principle: *retry is graded by business semantic, not
by verb*; an ambiguous side-effecting send is `outcome_unknown`, never blindly re-fired).

| # | Behaviour | Subsystem / path | Re-does | Idempotency identity | Status |
|---|---|---|---|---|---|
| **S1** | **Automation retry** (B3-10) | `automation-service.ts` `retryExecution` → re-enters `executeRule` | Re-runs a **failed/skipped** execution from step 0 | `(root_execution_id, action_key)` applied-ledger; root = the **lineage root** (stable across retries of one original) | **DESIGN PROPOSED — unbuilt** |
| **S1′** | **Automation resume** (A6-2/A6-3-3, EXISTING) | `resumeExecution` → token claim → `continueExecution`/`continueBranchExecution` | Runs **only the remaining tail** of a suspended execution | single-use resume token + fingerprint drift guard (already shipped) | **SHIPPED; NOT in B3-10 scope — G10 must protect it from regression** |
| **S2** | **Sample-record test-run** (B3-12) | same `executeRule` path via `testRun` under a side-effect **policy** | Runs a rule against a real `recordId` to validate pre-enable | `simulate` = zero business side-effects; `real_fire` = needs a **caller-supplied stable idempotency id** (§4 C1) — testRun does NOT get a lineage root | **PARTIAL** — G8 gate shipped (#4107); `simulate/real_fire` unbuilt |
| **S3** | **Attendance notification redelivery / test-send** | notification-delivery subsystem (`AttendanceNotificationRedelivery.ts`, `admin-directory` test-send) — **NOT the automation path** | Redelivers **one** failed outbox row / sends one test notification | `redelivery_safe=true` + DingTalk-row gate; `outcome_unknown` is **rejected** | **SHIPPED** (#4085/#4102); narrow, single-row, operator-route |

**Corrections vs Rev 1:** S1 is **retry only** — resume (S1′) is a *different, already-shipped* mechanism
(tail-continuation, not whole re-run) and is explicitly **out of B3-10's build**; it appears here only so G10
regression-guards it. S3 is **not** a general redelivery entry (see §4 C6).

---

## 2. Delivered ledger since the 07-09 lock (avoid rebuild)

| PR | main sha | Semantic | What shipped | Effect on the 07-09 lock |
|---|---|---|---|---|
| **#4107** | `e129a25c4` | S2 | `/sheets/:id/automations/:ruleId/test` `403`s a caller lacking `canManageAutomation` (`automation.ts:262`); route still real-fires | **G8 SATISFIED**; FE `confirm()` no longer the boundary |
| **#4102** | `7839b73a8` | S3 | Operator route redelivering **one** `attendance_notification_deliveries` row that is DingTalk + `status='failed'` + `redelivery_safe=true`; `outcome_unknown`/other channels **rejected** | S3 lives **outside** automation; nothing in §4/§5 to rebuild |
| **#4085** | `434ba8d58` | S3 | Work-notification **test-send** returns a distinct `outcome_unknown` (not success/failure) | Establishes "ambiguous send ⇒ `outcome_unknown`, never auto-resend" — a **delivery-outcome** marker, NOT the S1 *applied* marker |

---

## 3. Current-code baseline (grounded on `592be07ec`)

- Retry `POST /automation-executions/:id/retry` → `requireAdminRole()` (`automation.ts:422`); resume
  `POST /automation/resume` → `requireAdminRole()` (`:476`); test-run `POST …/test` → `canManageAutomation`
  (`:262`, #4107). **Asymmetry now REAL on main** (retry/resume admin vs test-run canManageAutomation).
- `retryExecution` (`automation-service.ts:2179`) gates ONLY on `status ∈ {failed, skipped}` — **no age cap**
  (this is the C3 gap). Its `rootExecutionId = lineageIds.at(-1) ?? original.id` (`:2199`) is stable across
  retries of one original.
- `testRun` (`:2962`) `return this.executeRule(...)` with **no** `rootExecutionId` argument ⇒ each call mints a
  fresh execution ⇒ **no stable idempotency root** (this is the C1 gap). `executeRule` **persists an execution
  row/log** ⇒ a "simulate" run is NOT write-free (this is the Q6 correction).
- `computeActionFingerprint` (`automation-suspension-service.ts:60`) = `sha256(actions.map(a => a.type)
  .join('|'))` — **types-only**: no config, no position, no branch/parallel step path (this is the C4 gap).
- `meta_automation_action_applied` table: **absent** — retry whole-reruns, re-firing already-succeeded actions.

---

## 4. BLOCKING design corrections (must land before any S1/S2 implementation)

These are the review-blockers; each is a contract fix, not just wording.

**C1 (P1) — `real_fire` test-run has no stable idempotency identity.** Retry inherits a lineage
`root_execution_id`; **test-run does not** (fresh execution per call). So the 07-09 claim that real_fire "reuses
the `(root_execution_id, action_key)` ledger" is unsatisfiable — two real-fires get different roots and
G6/G10 dedup cannot hold. **Fix:** `real_fire` MUST carry a **caller-supplied stable
`testRunOperationId` (Idempotency-Key)** that becomes the ledger `root_execution_id` for that test-run;
repeat/concurrent real-fires with the same key dedupe via the applied-ledger, a new key is a new run. **Tests
(RED-first):** two *independent HTTP requests* with the same key ⇒ second is `already_applied`; two concurrent
requests with the same key ⇒ exactly one dispatch; different keys ⇒ independent.

**C2 (P1) — write-semantics is at-LEAST-once, not at-most-once (corrected in BOTH docs).** `mark-after-success`
(dispatch, then `INSERT … ON CONFLICT DO NOTHING`) means a crash in the `dispatched-OK → before-mark` window
leaves the row unmarked ⇒ the next retry **re-fires** that one action ⇒ **at-least-once / duplicate window**.
The 07-09 §4.2 called this "at-most-once-favoured" and compared it to the T2-6 *claim-then-fire* idiom — both
wrong (claim-*before*-fire would be at-most-once, and would risk a *skip*, the opposite failure). **Fix:** the
07-09 §4.2 is edited in this PR to state at-least-once; and the *choice of trade* is re-opened as **Q3** below
(mark-after-success at-least-once, vs claim-before-fire at-most-once, vs two-phase claim→commit reconciliation
for closer-to-exactly-once).

**C3 (P1) — retry eligibility not bound to ledger retention.** With no age cap on `retryExecution` and a
7-day ledger sweep, a >7-day-old failed execution retried after its ledger rows are gone re-fires **every**
already-succeeded action. **Fix — pick ONE (owner decision, Q5):** (a) cap retry eligibility to **≤ ledger
retention** (reject older with a distinct code); or (b) **retain the ledger until the execution is no longer
retryable** (retention keyed to eligibility, not a fixed 7 days); or (c) **fail-closed**: if the ledger flag
is ON and no ledger rows exist for an eligible-but-aged root, refuse the retry rather than silently
whole-rerun. Rev-2 recommends **(a)** (simplest, bounded) with **(c)** as the safety net.

**C4 (P2) — `action_key` needs a real structural identity.** `computeActionFingerprint` hashes only the
*sequence of action types* — it cannot distinguish two same-type actions, config edits, or nested
branch/parallel children. **Fix:** `action_key` = a **normalized full structural step path** (top-level index
**and** branch/parallel child `step_key`, matching the A6-3-3 branch cursor's `step_key`, not a bare
`positionIndex`) **+ a stable canonical hash of that action's `config`** (canonicalised key order). Add a
**nested-action conflict test**: two distinct branch children that would collide under a naive top-level index
must get distinct `action_key`s.

**C5 (P2) — retry and resume are different mechanisms; B3-10 = retry only.** `resumeExecution` claims a
single-use token then runs the **tail** via `continueExecution`/`continueBranchExecution`; `retryExecution`
re-enters `executeRule` from step 0. B3-10's applied-ledger applies to **retry**; resume keeps its existing
token/fingerprint guards **unchanged**, and **G10 must assert resume is not regressed** by the ledger work.
Resume permission is explicitly **not** adjusted by this slice (owner Q1 ruling).

**C6 (P2) — S3 narrowed to its delivered boundary.** #4102's `AttendanceNotificationRedelivery` is
**operator-initiated redelivery of a single `attendance_notification_deliveries` row** that is a DingTalk row
with `status='failed'` **and** `redelivery_safe=true`; it **rejects `outcome_unknown`** (a `markOutcomeUnknown`
row keeps `redelivery_safe=false`), other channels, and non-failed rows; it flips exactly that one row
`failed→pending`. It is **NOT** a general redelivery entry for automation or DingTalk messages. §1/§2 rows and
Q7 are worded to that boundary.

---

## 5. Owner-decision menu (rulings applied; open items re-framed per §4)

- **Q1 — retry permission.** **RULED: (a) retry stays `requireAdminRole()`** (retry replays production
  side-effects on the live record; test-run is author-scoped validation). Resume permission **not** adjusted
  here. The retry(admin)/test-run(canManage) asymmetry is thus **intentional**, documented.
- **Q2 — test-run dry-run default.** **RULED: agreed — `simulate` is the default**; `real_fire` is an explicit
  opt-in carrying confirm + capability + the C1 idempotency key + the applied-ledger.
- **Q3 — write-semantics trade (re-framed by C2).** Choose the durability trade: **(i)** mark-after-success =
  at-least-once (bounded single-action duplicate window; simplest); **(ii)** claim-before-fire = at-most-once
  (risks a silent skip); **(iii)** two-phase claim→commit + reconciliation (closest to exactly-once, most
  code). **OPEN — owner decides.** Rev-2 leans **(i)** with `confirmSideEffects` as the human gate, but flags
  that for irreversible egress (email/DingTalk) some owners prefer (ii).
  > Q3 席位: 本节写语义/重投递权衡已由 `approval-automation-retry-action-classification-designlock-20260712.md` (#4196) 的按 action 类型分类方案取代 (PROPOSED)。
- **Q4 — `action_key` re-fire-on-reorder (re-framed by C4).** With the corrected structural key, a reordered
  action (new step path) counts as not-applied and re-fires. **OPEN — confirm this is desired**, or pin
  identity to a stable per-action id instead of position.
- **Q5 — ledger retention (bound to C3).** Not an independent number: the retention window is now **coupled to
  retry eligibility** per C3. **OPEN — owner picks C3 (a)/(b)/(c)**, which sets retention.
- **Q6 — simulate gate (corrected).** **RULED (corrected framing): `simulate` requires `canManageAutomation` +
  record-READABLE (not writable)**, and it MAY write **values-free audit / execution-log** rows, but MUST
  perform **zero business writes, egress, notifications, or approvals** (spy-proven). "Nothing is written" was
  inaccurate — the execution-log write is expected and permitted.
- **Q7 — fence S3 out of the automation path.** **RULED: agreed, isolate** — a future "resend notification"
  affordance MUST route through the shipped, **narrow** `AttendanceNotificationRedelivery` (single failed
  DingTalk `redelivery_safe` row), **not** through `executeRule`, and S3 must **not** be described as a general
  redelivery path.

---

## 6. What a future (separately-authorized) implementation slice covers
- **S1 retry:** `meta_automation_action_applied` + claim/skip wiring with the **C4** structural key, **C2**
  chosen durability trade, **C3** retention/eligibility coupling; behind `AUTOMATION_RETRY_IDEMPOTENT_LEDGER`
  (default OFF). RED tests: 07-09 §12 #1–#6 **plus** a resume-not-regressed test (C5) and a nested-action
  conflict test (C4).
- **S2 test-run:** `simulate|real_fire` policy on `testRun`; `simulate` = spy-proven zero business dispatch
  (Q6 framing); `real_fire` = C1 idempotency key + S1 ledger + shipped G8 gate. RED tests: 07-09 §12 #7–#9
  **plus** the C1 two-request / concurrent-request tests.
- **S3:** nothing — shipped; doc cross-reference only (C6 boundary).

Each slice separately owner-authorized. This refresh authorizes **no** implementation.

## 7. Cross-references
- 07-09 LOCKED contract (amended here at §4.2): `approval-automation-retry-and-sample-testrun-design-lock-20260709.md` (#4032).
- S2 G8 delivery: #4107 `e129a25c4`. S3 deliveries: #4085 `434ba8d58`, #4102 `7839b73a8`.
- Standing principle: retry graded by business semantic, not verb; ambiguous send ⇒ `outcome_unknown`.
