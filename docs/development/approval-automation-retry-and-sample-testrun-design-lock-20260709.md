# Approval/Automation — one-click retry (B3-10) + sample-record test-run (B3-12) — design-lock (2026-07-09)

**Status: PROPOSED** (doc-only; no runtime code in this change). Ratify before any implementation slice.

Scope: TWO backlog items on the approval/automation line that share ONE replay / side-effect substrate.

- **B3-10 — 自动化失败一键重试** (automation-failure one-click retry): surface and harden retry of a failed
  execution so an operator can recover a transient failure without hand-rebuilding the trigger.
- **B3-12 — 测试运行接受可选样本记录** (test-run with an optional real `recordId`): let a rule author validate
  a rule against representative real data before enabling it.

They are locked in ONE document because they land on the SAME dangerous seam and MUST NOT ship as a naked
re-execute (see §2).

---

## 0. What exists today (scouted on `origin/main`, cite file:line)

### 0.1 `testRun` really fires real actions

`packages/core-backend/src/multitable/automation-service.ts:2951` — `testRun(ruleId, sheetId)` builds a
**synthetic event** with an empty record and calls `executeRule` **directly**:

```
recordId: 'test_record', data: {}, actorId: 'system', _triggeredBy: 'manual_test'   // lines 2957–2963
return this.executeRule(execRule, syntheticEvent)                                    // line 2964
```

`executeRule` (`automation-service.ts:2074`) drives the executor, which dispatches **every** action for
real (`automation-executor.ts:1673` `executeSingleAction` switch, lines 1681–1733). There is **no** dry-run /
simulate parameter anywhere on that path. So a test-run today already fires real side-effects; it is only
"safe-ish" because the record is empty (`data: {}`, `recordId: 'test_record'`) so most writes/egress resolve
to nothing meaningful. **Giving test-run a real `recordId` removes that accidental safety** — write targets,
recipients, webhook URLs and DingTalk targets all become live and real.

The only current guard on test-run is **frontend-only**: a browser `confirm()` in
`MetaAutomationRuleEditor.vue` that fires **only when the saved rule contains a DingTalk send action**
(`docs/development/dingtalk-test-run-confirm-development-20260421.md`). The backend test route
(`packages/core-backend/src/routes/automation.ts:216`) has **no `confirmSideEffects` body flag and no
`requireAdminRole()`** — unlike retry/resume below. That is a gap this lock closes.

### 0.2 Retry (A5) already exists but is NOT action-idempotent

`automation-service.ts:2168` — `retryExecution(executionId, initiatedBy)` re-runs the **whole** execution
from step 0 via `executeRule` with the original **stored (redacted) trigger_event** (line 2201), producing a
NEW execution linked by `rerun_of_execution_id`. Eligibility guards already present:

- only `failed` / `skipped` originals (line 2176);
- `isRetryableStoredTriggerEvent` — fail-closed if no usable stored trigger (line 2183);
- blocked if the lineage already created an approval (`START_APPROVAL_ALREADY_CREATED`, line 2189);
- rule must exist and be enabled (line 2197);
- `collectExecutionLineageIds` already walks the `rerun_of` chain (line 2209).

Route `packages/core-backend/src/routes/automation.ts:355` — `requireAdminRole()` **and** requires
`confirmSideEffects === true` (else `400 CONFIRM_SIDE_EFFECTS_REQUIRED`, lines 362–368). Resume (A6-2) mirrors
this at `automation.ts:409`.

**The gap B3-10 must close:** retry re-fires **all** actions from step 0, including actions that already
**succeeded** in the original partial run. Example: original ran `update_record` OK, then `send_webhook`
timed out → `failed`. A retry re-writes the record **and** re-sends any earlier notification, then re-tries
the webhook. `confirmSideEffects` only *warns* the human; it does **not** prevent the double-apply.

### 0.3 The idempotent ledger (T2-6) exists — but only gates the EVENT path

`meta_automation_event_fires(rule_id, dedup_key)` with a claim-then-fire idiom:

```
INSERT INTO meta_automation_event_fires (rule_id, dedup_key)
VALUES (${ruleId}, ${dedupKey}) ON CONFLICT DO NOTHING RETURNING dedup_key   // automation-service.ts:1541
```

`claimEventDelivery` returns `true` only if the row was newly inserted (line 1547). It is consulted **only**
in `handleEvent` (line 2058) and the two approval-event paths (lines 2543, 2603), keyed by
`${eventType}:${_eventId}` (`automation-event-dedup.ts:buildAutomationEventDedupKey`). **`executeRule` never
consults it.** Therefore both `retryExecution` and `testRun` — which call `executeRule` directly — bypass the
ledger entirely. Retention: 7 days, opportunistic sweep (`sweepEventDedupLedger`, line 1513).

### 0.4 Action-type inventory (the side-effect surface)

From the executor dispatch (`automation-executor.ts:1681`):

| Action type | Class | Real-world effect |
|---|---|---|
| `update_record`, `create_record`, `delete_record`, `lock_record` | **WRITE** | mutates real records |
| `send_webhook`, `send_email` | **EGRESS** | outbound to external targets |
| `send_dingtalk_group_message`, `send_dingtalk_person_message`, `send_dingtalk_approval_card` | **EGRESS** | posts to real chats / creates cards |
| `send_notification` | **NOTIFY** | writes a real user inbox notification |
| `start_approval` | **CREATE-APPROVAL** | creates a real approval instance (needs `workflow_job_v1`) |
| `condition_branch`, `parallel_branch`, `wait_for_callback` | **CONTROL-FLOW** | routing / suspend; children still side-effect |
| `record_click` | **INERT** | audit-only, zero business effect (`automation-executor.ts:1719`) |

### 0.5 Permission capability that already exists

`canManageAutomation` (`packages/core-backend/src/multitable/access.ts:107`,
`sheet-capabilities.ts:80`) = `isAdminRole || workflow:all || workflow:write || workflow:create ||
workflow:execute`. This is the natural "automation manage" gate for both features.

---

## 2. Why these two are LOCKED together

Both a **naked retry** and a **test-run against a real record** re-enter `executeRule`, which fires the
**same** real actions (`write_back` / `send_notification` / `send_webhook` / `send_email` /
`dingtalk_*` / `start_approval`) onto **real** data and **real** targets. Neither may ship as a naked
re-execute:

- A retry that re-runs a partially-succeeded execution **double-applies** already-successful actions.
- A test-run that accepts a real `recordId` becomes a **live production event** — a "test" that emails real
  people, overwrites a real record, or posts to a real DingTalk group.

They share ONE substrate — reconstruct-context → dispatch actions with a **side-effect policy** + an
**idempotent claim ledger** + a **`confirmSideEffects` human gate** + an **`initiatedBy` audit stamp**. This
lock defines that shared substrate once and applies it to both, rather than letting each grow a parallel,
inconsistent re-execute path.

---

## 3. Flow-governance dual gate (both items pass BOTH gates)

Per the flow-governance rule (flow work needs a **demand gate** = a named use-case, and a **governance gate**
= a shared, reusable substrate):

| | Demand gate (named use-case) | Governance gate (shared substrate) |
|---|---|---|
| **B3-10 retry** | Operator recovers a transient automation failure (webhook 503, DingTalk timeout, deadlock) without re-triggering the source event or hand-editing data. | Reuses the A5 replay substrate: `confirmSideEffects` + stored-trigger reconstruction + `rerun_of_execution_id` lineage + `initiatedBy` audit, **plus** the new per-action idempotent applied-ledger (extends the T2-6 claim-then-skip idiom). |
| **B3-12 test-run** | Rule author validates a new/edited rule against a representative real record before enabling — catches field-mapping / condition bugs pre-production. | Same substrate: one `executeRule` path parameterised by a **side-effect policy** (`simulate` default \| `real_fire` opt-in); real-fire reuses retry's `confirmSideEffects` + idempotency + capability gate verbatim. |

Neither introduces a second dispatch engine. Both flow through `executeRule` with an explicit side-effect
policy, so there is exactly one place where side-effecting actions are gated.

---

## 4. LOCKED — B3-10 retry contract

**L4.1 Eligibility (unchanged, keep all existing guards — do NOT weaken).** Retryable = original status
`failed | skipped`; `isRetryableStoredTriggerEvent` true; lineage has NOT created an approval
(`START_APPROVAL_ALREADY_CREATED`); rule exists and is enabled. These stay exactly as today.

**L4.2 Per-action idempotency (the new guard).** Introduce a durable **applied-ledger** that records each
**side-effecting** action that has **succeeded** anywhere in the retry lineage, so a retry re-fires ONLY the
not-yet-applied tail:

- New table (proposed) `meta_automation_action_applied(root_execution_id, action_key, applied_at)` with
  `UNIQUE(root_execution_id, action_key)`, mirroring `meta_automation_event_fires` (short retention keyed to
  the retry window; opportunistic sweep like `sweepEventDedupLedger`).
- `root_execution_id` = the lineage root already computed by `collectExecutionLineageIds` /
  `rootExecutionId` (`automation-service.ts:2188`).
- `action_key` = a **stable per-position action fingerprint** = `positionIndex` + `action.type` + a hash of
  `action.config` (reuse the `computeActionFingerprint` primitives already used by resume at
  `automation-service.ts:2259`). A rule edit that changes an action's config changes its `action_key`, so the
  edited action is correctly treated as NOT-yet-applied and re-fires (safe).
- **Write semantics = mark-after-success.** After a side-effecting action **succeeds**, `INSERT ... ON
  CONFLICT DO NOTHING` its `(root_execution_id, action_key)`. On a retry, **before dispatching** a
  side-effecting action, check the ledger; if present, **SKIP** dispatch and record the step as a new
  outcome `already_applied` (distinct from `success`/`skipped` so the run detail is honest).
- **Never claim** CONTROL-FLOW / INERT actions (`condition_branch`, `parallel_branch`, `wait_for_callback`,
  `record_click`) — they are pure/repeatable and must re-run to re-derive routing.
- **Documented residual gap** — **⚠ CORRECTED 2026-07-12 (see the Rev-2 refresh `…-design-refresh-20260712.md`
  §4 C2/C4, which is the authoritative amendment):** the mark is written *after* a successful dispatch, so a
  crash in the narrow window `dispatched-OK → before-mark` leaves the row unmarked and the next retry
  **re-fires** that one action. That is **at-LEAST-once (a bounded single-action *duplicate* window)** — the
  original text here wrongly called it "at-most-once-favoured" and compared it to the T2-6 *claim-then-fire*
  idiom; claim-*before*-fire would be at-most-once and would risk a silent *skip* (the opposite failure), so
  the comparison was also wrong. The **choice of durability trade is re-opened** (mark-after-success
  at-least-once ∣ claim-before-fire at-most-once ∣ two-phase claim→commit) as Rev-2 **Q3** — do not treat
  mark-after-success as settled. Also **⚠**: the `action_key = reuse computeActionFingerprint` note above is
  insufficient — `computeActionFingerprint` hashes only the *sequence of action types* (no config, no
  per-action position, no branch/parallel `step_key`); Rev-2 **§4 C4** replaces it with a normalized
  structural step path + canonical config hash. `confirmSideEffects` still gates the human; stronger
  cross-target idempotency (webhook `Idempotency-Key`, DingTalk dedup) stays OUT OF SCOPE v1 (§10).

**L4.3 `confirmSideEffects` (keep).** The route keeps requiring `confirmSideEffects === true` (else `400
CONFIRM_SIDE_EFFECTS_REQUIRED`). The confirm UX MUST state that retry re-fires only the **not-yet-applied**
actions when the ledger flag is ON (see §7), so the operator's mental model matches the new semantics.

**L4.4 Audit (keep + surface).** `initiatedBy` is already stamped on the new execution
(`automation-service.ts:2090`). The one-click UI MUST show *who* retried and link `rerun_of_execution_id`
lineage in the run detail. No new audit table needed; the execution row is the audit record.

**L4.5 "One-click" surface.** B3-10 adds a **Retry** button on each failed/skipped row of the executions
list (`AutomationExecutionsView.vue`) that opens the existing `confirmSideEffects` confirm and calls the
existing `POST /automation-executions/:id/retry`. It is UI convenience over the SAME hardened backend — it
does NOT add a second retry path.

---

## 5. LOCKED — B3-12 sample-record test-run contract

**L5.1 Optional real `recordId`.** `testRun` gains an optional `recordId`. When supplied, the executor loads
that record's **real** `data` into the synthetic event (replacing `data: {}`), so conditions and action-input
resolution evaluate against real values (this is the whole point — surface field-mapping bugs). The record
MUST be read-authorized for the caller on that sheet (re-use the sheet read gate; fail-closed 404/403 if the
record is not readable — mirror `requireRecordReadable`).

**L5.2 Side-effect policy — DRY-RUN by default (RECOMMENDED).** Test-run defaults to **`simulate`**: every
**side-effecting** action (all WRITE / EGRESS / NOTIFY / CREATE-APPROVAL rows in §0.4) is **recorded-but-not-
dispatched**. The executor produces a `simulated` step outcome describing *what would have happened* — target
record id, resolved payload (redacted), webhook URL **host** (not full URL/secret), notification recipient
ids, DingTalk target — **without** performing the write / egress. CONTROL-FLOW actions run to derive routing;
`wait_for_callback` in `simulate` mode records "would suspend" and does **not** actually suspend or emit a
real resume token. INERT `record_click` is unaffected.

Classification the implementation MUST honour:

| Action | `simulate` (default) | `real_fire` (opt-in) |
|---|---|---|
| `update_record` / `create_record` / `delete_record` / `lock_record` | **suppress**, record intended target+payload | dispatch (real write) |
| `send_webhook` / `send_email` | **suppress**, record host/recipient | dispatch (real egress) |
| `send_dingtalk_group_message` / `send_dingtalk_person_message` / `send_dingtalk_approval_card` | **suppress**, record target | dispatch (real post) |
| `send_notification` | **suppress**, record recipient ids | dispatch (real inbox) |
| `start_approval` | **suppress**, record "would create approval" | dispatch (real approval) |
| `condition_branch` / `parallel_branch` | run routing (no side-effect); children obey policy | same |
| `wait_for_callback` | record "would suspend" (no token) | real suspend (real_fire only) |
| `record_click` | inert | inert |

**L5.3 `real_fire` opt-in.** An explicit `mode: 'real_fire'` restores today's real dispatch. In `real_fire`
mode test-run MUST carry the **same** guards as retry: `confirmSideEffects === true` **and**
`canManageAutomation` (§6) **and** the L4.2 applied-ledger idempotency (so a real-fire test-run repeated
against the same real record cannot double-apply). If the owner rejects a `simulate` default (§9 Q2), the
fallback is: keep real-fire as the only mode BUT add the backend `confirmSideEffects` gate + capability gate +
idempotency — i.e. never a naked backend real-fire regardless.

**L5.4 Simulated runs never touch the applied-ledger.** A `simulate` run applied nothing, so it MUST NOT
write `meta_automation_action_applied`. It still writes a redacted execution-log row flagged `dryRun: true`
with `simulated` steps for the run-detail view.

**L5.5 Rebuild env.** `_triggeredBy` stays a distinct marker (e.g. `manual_test` / `manual_test_dryrun`) so
test-run executions are filterable and never confused with production runs.

---

## 6. LOCKED — permission gate

- **Retry** keeps its existing `requireAdminRole()` (do NOT weaken). The one-click button renders only when
  the viewer would pass that gate.
- **Test-run (both modes)** gains a backend capability gate: require **`canManageAutomation`** on the sheet
  (`access.ts:107`). This **strengthens** today's test route, which has no backend role/capability gate at
  all (only a frontend DingTalk confirm). `real_fire` additionally requires `confirmSideEffects === true`.
- Whether to **unify** retry's gate down to `canManageAutomation` (broader than admin) is an OPEN question
  (§9 Q1) — this lock does NOT unilaterally broaden it, because broadening a gate = weakening it.

---

## 7. LOCKED — default-OFF rollout flags

Both new behaviours ship behind default-OFF flags; when OFF, behaviour is byte-identical to today
(zero regression):

- `AUTOMATION_RETRY_IDEMPOTENT_LEDGER` (default OFF) — when OFF, retry re-runs the whole execution exactly as
  today (still admin + `confirmSideEffects`); when ON, the L4.2 applied-ledger skips already-applied actions.
- `AUTOMATION_TESTRUN_SAMPLE_RECORD` (default OFF) — when OFF, `testRun` ignores any `recordId` and behaves as
  today (empty record). When ON, the optional real `recordId` + dry-run policy of §5 apply.

Confirm-copy MUST reflect the active flag state (e.g. retry confirm says "re-fires only not-yet-applied
actions" only when the ledger flag is ON).

---

## 8. Surface (v1, backend-first)

- `POST /api/multitable/automation-executions/:executionId/retry` — UNCHANGED shape; body `confirmSideEffects:
  true`. Behaviour gains the applied-ledger skip when the flag is ON. New step outcome `already_applied` in the
  response run-detail.
- `POST /api/multitable/sheets/:sheetId/automations/:ruleId/test` — body extended (all optional):
  `{ recordId?: string, mode?: 'simulate' | 'real_fire', confirmSideEffects?: boolean }`. Defaults:
  `mode='simulate'`, no `recordId` → today's empty-record behaviour under the flag-OFF path. New backend
  `canManageAutomation` gate. `real_fire` requires `confirmSideEffects: true`. Response run-detail carries
  `dryRun: boolean` and per-step `simulated: boolean`.
- No change to `executeRule`'s public contract other than a new internal side-effect-policy parameter
  (`simulate | real_fire`) threaded to the executor; the event/handleEvent path always passes `real_fire`
  (its current behaviour), so production automation is untouched.

---

## 9. Open questions for owner ratify

- **Q1** — Should **retry** stay `requireAdminRole()` (status quo) or unify to `canManageAutomation` (matches
  test-run, but broader than admin)? Lock keeps admin unless owner says otherwise.
- **Q2** — Confirm the **dry-run-by-default** recommendation for test-run (§5.2). If rejected, fallback is
  real-fire-only but with backend `confirmSideEffects` + `canManageAutomation` + idempotency (never a naked
  backend real-fire).
- **Q3** — Applied-ledger residual gap (§4.2 mark-after-success crash window): accept the at-most-once trade,
  or invest in a claim-before/commit-after two-phase mark in v1? Lock proposes ACCEPT.
- **Q4** — `action_key` = position + type + config-hash. Should a rule edit that reorders actions (same
  config, new position) count as "not applied" (re-fire) — yes under this key. Confirm that is desired.
- **Q5** — Retention window for `meta_automation_action_applied` (propose 7 days, matching T2-6) vs a
  longer window if retries can lag days behind the original failure.
- **Q6** — Should `simulate` test-run be allowed to READ a record the caller can read but NOT write, purely to
  preview a write action's would-be payload? Lock says yes (read-gate only, since nothing is written).

---

## 10. OUT OF SCOPE for v1 (each a separate later opt-in)

- Cross-target external idempotency: webhook `Idempotency-Key` header, DingTalk message dedup, email dedup —
  the internal applied-ledger is the only v1 guarantee.
- Automatic / scheduled retry (backoff, dead-letter auto-replay) — v1 retry is human-initiated only.
- Bulk / multi-execution "retry all failed" — one execution per click in v1.
- Retry of executions that already created an approval — stays blocked (`START_APPROVAL_ALREADY_CREATED`).
- Public/unauthenticated resume-token emission — unchanged from A6-2 (still deferred).
- Editing the trigger payload / record data before retry ("edit-and-retry") — v1 replays the stored
  (redacted) trigger verbatim; the redaction limitation is documented at `automation-service.ts:2161`.
- Test-run against MULTIPLE sample records / a saved fixture set — v1 is a single optional `recordId`.
- Partial-action test-run ("test only action #3") — v1 runs the whole rule under the policy.

---

## 11. Acceptance gates (implementation must satisfy ALL)

- **G1** Retry with the ledger flag ON, on a partially-succeeded original, re-fires ONLY the not-yet-applied
  actions; already-succeeded WRITE/EGRESS/NOTIFY actions are SKIPPED and reported `already_applied`.
- **G2** Retry with the ledger flag OFF is byte-identical to today (whole re-run; admin + `confirmSideEffects`
  still enforced).
- **G3** Retry without `confirmSideEffects` still returns `400 CONFIRM_SIDE_EFFECTS_REQUIRED` (guard not
  weakened). Non-admin still `403`.
- **G4** Control-flow / inert actions are NEVER written to the applied-ledger and always re-run.
- **G5** `simulate` test-run with a real `recordId` performs ZERO writes/egress/notifications/approvals —
  provably (spy every side-effecting handler; assert zero real dispatch) — yet still evaluates conditions and
  resolves action inputs against the real record, and returns `dryRun: true` with `simulated` steps.
- **G6** `real_fire` test-run requires BOTH `confirmSideEffects: true` and `canManageAutomation`; missing
  either → `400` / `403` respectively; and it applies the L4.2 idempotency (repeat real-fire against the same
  record does not double-apply).
- **G7** Test-run without the sample-record flag ignores `recordId` and is byte-identical to today.
- **G8** Backend test route rejects a caller lacking `canManageAutomation` (`403`) — closing the current
  no-backend-gate gap; the existing FE DingTalk confirm is NOT relied upon as the security boundary.
- **G9** `simulate` runs write NO applied-ledger rows.
- **G10** No existing guard weakened: retry eligibility set, `START_APPROVAL_ALREADY_CREATED`, redaction of
  stored trigger, resume's fingerprint guards, and the T2-6 event-dedup path are all unchanged.

## 12. RED-before test list (write these failing FIRST)

1. `retry_skips_already_applied_action` — original: `update_record` success → `send_webhook` failed. Retry
   (flag ON) does NOT re-invoke the update handler; webhook handler invoked once; step marked
   `already_applied`. **RED** until the ledger exists.
2. `retry_ledger_off_reruns_whole` — flag OFF ⇒ update handler invoked again (documents/keeps current
   behaviour behind the flag).
3. `retry_missing_confirm_still_400` — no `confirmSideEffects` ⇒ `400 CONFIRM_SIDE_EFFECTS_REQUIRED`.
4. `retry_non_admin_403`.
5. `retry_control_flow_not_claimed` — a rule with `condition_branch`; assert no applied-ledger row for the
   branch action and it re-runs on retry.
6. `retry_action_config_edit_refires` — edit an action's config between original and retry ⇒ new `action_key`
   ⇒ that action re-fires (not treated as applied).
7. `testrun_simulate_zero_side_effects` — real `recordId`, `mode` default; spies on update/create/delete/
   webhook/email/dingtalk_*/notification/start_approval all assert ZERO calls; response `dryRun:true`.
8. `testrun_simulate_still_resolves_inputs` — a field-mapping error in the real record surfaces in the
   simulated step payload (proves the record was actually loaded and resolved).
9. `testrun_realfire_requires_confirm_and_capability` — `mode:'real_fire'` without `confirmSideEffects` ⇒
   `400`; without `canManageAutomation` ⇒ `403`.
10. `testrun_realfire_idempotent` — real-fire against the same record twice does not double-apply (ledger).
11. `testrun_flag_off_ignores_recordid` — sample-record flag OFF ⇒ `recordId` ignored, empty-record behaviour.
12. `testrun_backend_capability_gate` — caller lacking `canManageAutomation` ⇒ `403` even with a DingTalk-free
    rule (FE confirm is not the boundary).
13. `testrun_wait_for_callback_simulated` — a `wait_for_callback` rule in `simulate` records "would suspend"
    and creates NO suspension row / NO resume token.
14. `simulate_run_writes_no_applied_ledger` — after a `simulate` run, `meta_automation_action_applied` is
    empty for that root.

---

## 13. TODO checklist (gated; implement only after RATIFY)

- 🔒 **RATIFY** this design-lock (owner) — blocks everything below.
- ⬜ Migration: `meta_automation_action_applied(root_execution_id, action_key, applied_at)` + unique + sweep.
- ⬜ Executor: thread a `sideEffectPolicy: 'simulate' | 'real_fire'` param; suppress+record side-effecting
  handlers under `simulate`.
- ⬜ Service: `retryExecution` consults + writes the applied-ledger (mark-after-success, skip-on-replay) behind
  `AUTOMATION_RETRY_IDEMPOTENT_LEDGER`.
- ⬜ Service: `testRun` accepts optional `recordId` + `mode`; loads real record (read-gated); default
  `simulate`; behind `AUTOMATION_TESTRUN_SAMPLE_RECORD`.
- ⬜ Route: test endpoint gains `canManageAutomation` gate + `confirmSideEffects` for `real_fire`.
- ⬜ FE: one-click Retry button on failed rows (reuse confirm); test-run mode toggle + sample-record picker;
  confirm-copy reflects flag state.
- ⬜ Tests: the 14 RED-before cases above (real-DB where the ledger/record load is exercised).
- ⬜ Verification doc + adversarial review before merge.
