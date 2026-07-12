# Automation retry / test-run / notification-redelivery — design refresh (2026-07-12)

**Status: PROPOSED (doc-only; no runtime).** This refreshes the open-questions + delivered-ledger of the
2026-07-09 lock (`approval-automation-retry-and-sample-testrun-design-lock-20260709.md`, PR #4032) against
current `origin/main` (`592be07ec`). The 07-09 lock's **LOCKED contract sections (§4 retry, §5 test-run, §6
permission, §11 acceptance gates G1–G10)** remain the technical contract; this doc **does not re-open or
re-lock them** — it (a) disambiguates three semantics that share verbs, (b) ledgers what has since shipped
so nothing is rebuilt, and (c) re-casts the open questions as an owner-decision menu grounded in shipped code.

> **Scope guard (owner-set, MS-AUTOMATION-RETRY-DESIGN-REFRESH):** docs/design-lock only; stays PROPOSED; no
> runtime; does **not** touch the in-flight approval P1 (#4158); no permission expansion. Implementation is a
> separately-authorized later slice per owner ratify.

---

## 1. Three semantics that share verbs — DO NOT conflate

The words "retry" / "re-send" / "test" appear across three **different** subsystems with **different**
correctness rules. Conflating them is the failure mode this refresh exists to prevent (see the standing
principle: *retry is graded by business semantic, not by the verb* — a network error ≠ "did not execute", and
a side-effecting send is marked `outcome_unknown`, never blindly re-fired).

| # | Semantic | Subsystem / owner line | What it re-does | Idempotency rule | Status |
|---|---|---|---|---|---|
| **S1** | **Automation retry / resume** (B3-10) | multitable automation (`automation-service.ts` `retryExecution` / `resume`) | Re-enters `executeRule` for a **failed/suspended rule execution** | **Per-action applied-ledger** (proposed `meta_automation_action_applied`): re-fire ONLY not-yet-applied actions | **DESIGN PROPOSED — unbuilt** (ledger table absent on main) |
| **S2** | **Sample-record test-run** (B3-12) | same automation path, `testRun` under a side-effect **policy** | Runs a rule against a real `recordId` to validate it pre-enable | `simulate` (default) = ZERO side-effects; `real_fire` = reuse S1's ledger + confirm + capability | **PARTIAL** — G8 permission gate shipped (#4107); `simulate/real_fire` policy unbuilt |
| **S3** | **DingTalk notification redelivery / test-send** | attendance/DingTalk delivery (`AttendanceNotificationRedelivery.ts`, `admin-directory` test-send) | Re-delivers a **failed/unknown notification**, or sends a one-off **test** notification | `redelivery_safe` column gate + `outcome_unknown` (never auto-resend an ambiguous send) | **SHIPPED** — #4085 + #4102 (**separate line**; out of this lock's build scope) |

**The refresh's core assertion:** S1 and S2 share ONE backend path (`executeRule`) and ONE idempotency
substrate (the applied-ledger) and belong to THIS lock. **S3 is a different subsystem** (notification
delivery, not rule execution) with its own already-shipped mechanism; this lock **cross-references** S3 so
future work does not re-implement redelivery inside the automation path, and does not fold S3's `outcome_unknown`
semantics into S1/S2's applied-ledger.

---

## 2. Delivered ledger since the 07-09 lock (avoid rebuild)

| PR | main sha | Semantic | What shipped | Effect on the 07-09 lock |
|---|---|---|---|---|
| **#4107** | `e129a25c4` | **S2** | `POST /sheets/:id/automations/:ruleId/test` now `403`s a caller lacking `canManageAutomation` (`automation.ts:262`); route still real-fires (no simulate policy yet) | **G8 SATISFIED** (the §0.1 "test route has no backend gate" gap is closed). The FE `confirm()` is no longer the security boundary. |
| **#4102** | `7839b73a8` | **S3** | Operator-initiated **safe redelivery** service (`AttendanceNotificationRedelivery.ts`, +`redelivery_safe` column, task_id trace index, admin route) | Delivers S3 redelivery **outside** the automation path. Nothing in §4/§5 to rebuild. |
| **#4085** | `434ba8d58` | **S3** | Work-notification **test-send** returns a **distinct `outcome_unknown`** response (not success/failure) | Establishes S3's "ambiguous send ⇒ outcome_unknown, do not auto-resend" rule — the semantic S1's ledger must NOT copy (S1 tracks *applied*, S3 tracks *delivery outcome*). |

**Not yet built (per semantic):**
- **S1 retry idempotency** — `meta_automation_action_applied` table does not exist on main; `retryExecution`
  (`automation-service.ts:2179`) still re-enters `executeRule` and re-fires **all** actions (whole-rerun).
  G1–G4, G9, G10 unmet. This is the largest remaining slice.
- **S2 simulate/real_fire policy** — `testRun` (`automation.ts:285`) still unconditionally real-fires; no
  `simulate` (dry-run) mode, no `real_fire` opt-in. G5, G6, G7, G9 unmet. G8 (gate) is the only S2 gate met.

---

## 3. Current-code baseline (grounded on `592be07ec`)

- **Retry route** `POST /automation-executions/:id/retry` → `requireAdminRole()` (`automation.ts:422`).
- **Resume route** `POST /automation/resume` → `requireAdminRole()` (`automation.ts:476`).
- **Test-run route** `POST /sheets/:id/automations/:ruleId/test` → `canManageAutomation` per-sheet capability
  (`automation.ts:262`, shipped #4107).
- ⇒ **Asymmetry now REAL on main:** retry/resume = platform-admin; test-run = per-sheet `canManageAutomation`.
  This is the live fact Q1 must decide against (07-09 lock asked it hypothetically; it is now concrete).
- `computeActionFingerprint` exists (`automation-suspension-service.ts`) and is used by resume — the primitive
  the proposed applied-ledger `action_key` would reuse — but **no applied-ledger consumer exists**.

---

## 4. Owner-decision menu — Q1–Q6 re-cast against shipped code

Each item: the 07-09 question, what shipped since that changes it, and a grounded recommendation. **All remain
owner decisions; nothing here is auto-locked.**

- **Q1 — retry permission gate.** *07-09:* keep retry `requireAdminRole()` or unify to `canManageAutomation`?
  *Now:* #4107 made **test-run** `canManageAutomation`, so retry (admin) and test-run (canManage) are
  **asymmetric on main today**. Decision is now "reconcile the asymmetry": **(a)** keep retry admin-only
  (retry replays real production side-effects on real data → stricter is defensible), **(b)** unify retry
  down to `canManageAutomation` to match test-run. **Rec: (a) keep admin** — retry re-fires production
  actions on the live record; test-run is author-scoped validation. If unified later, it is its own opt-in.
- **Q2 — test-run dry-run-by-default.** *Now unchanged & more urgent:* test-run **still real-fires** on main
  (#4107 gated *who* can call it, not *whether it simulates*). Recommend confirming **`simulate` default**;
  `real_fire` = explicit opt-in carrying confirm + capability + S1 ledger. **Rec: dry-run default.**
- **Q3 — applied-ledger crash-window trade** (mark-after-success). Unchanged by deliveries. **Rec: ACCEPT
  at-most-once** (a crash between dispatch and mark re-fires that one action on the next retry — same
  philosophy as the T2-6 claim-then-fire ledger).
- **Q4 — `action_key` = position + type + config-hash; a reorder ⇒ re-fire.** Unchanged. Confirm desired
  semantics (an action moved to a new position counts as "not applied" and re-fires). **Rec: confirm as-is.**
- **Q5 — applied-ledger retention window** (propose 7 days, matching T2-6). Unchanged; only relevant once S1
  is built. **Rec: 7 days, revisit if human retries lag days.**
- **Q6 — `simulate` read-gate** (may simulate against a record the caller can read but not write). Unchanged.
  **Rec: yes** — nothing is written, so a read capability suffices to preview a would-be payload.

**New (raised by the deliveries) — Q7:** should S3 (notification redelivery / test-send) be **explicitly
fenced off** from S1/S2 in the lock's OUT-OF-SCOPE, so a future implementer does not add a "resend notification"
button that routes through `executeRule` (double-dispatch) instead of the shipped `AttendanceNotificationRedelivery`
path? **Rec: yes, add to §10 OUT-OF-SCOPE** — S3 is delivered separately and must not be re-plumbed through automation.

---

## 5. What a future implementation slice would still cover (per semantic, when authorized)

- **S1 (largest):** build `meta_automation_action_applied` + wire `retryExecution` to claim-then-skip per
  action (G1–G4, G9, G10), behind `AUTOMATION_RETRY_IDEMPOTENT_LEDGER` (default OFF). RED tests #1–#6 of the
  07-09 lock §12.
- **S2:** add the `simulate|real_fire` policy to `testRun` (G5–G7, G9); `simulate` = spy-proven zero
  dispatch; `real_fire` reuses S1's ledger + confirm + the already-shipped G8 capability gate. RED tests
  #7–#9 of §12.
- **S3:** nothing — shipped (#4085/#4102). Only a doc cross-reference so it is not rebuilt.

Each slice is separately owner-authorized. This refresh authorizes **no** implementation.

---

## 6. Cross-references
- 07-09 LOCKED contract: `approval-automation-retry-and-sample-testrun-design-lock-20260709.md` (#4032).
- S3 delivered line: #4085 `434ba8d58`, #4102 `7839b73a8` (+ the send-trigger audit doctrine).
- G8 delivery: #4107 `e129a25c4`.
- Standing principle: retry graded by business semantic, not verb; ambiguous send ⇒ `outcome_unknown`.
