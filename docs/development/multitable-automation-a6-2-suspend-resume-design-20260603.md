# A6-2 — suspend/resume runtime (generic webhook-resume v1) — design-lock (2026-06-03)

> Type: **design-lock for a gated runtime rung.** Wires the C1 `workflow-job-contract.ts` (#1889)
> suspend/resume primitive into the linear automation executor. Backend-first; frontend is a follow-up.
> Re-entry signal (per A6-0 #2065): rung = **A6-2 suspend/resume**; why A5/A3 can't solve it = they
> operate on a *whole, completed* execution (A5 re-runs it, A3 reads it) — neither can **pause mid-execution
> and re-enter at the next step on an external signal**. Demand = the converged-engine roadmap (RFC #1885),
> built capability-first as the owner chose; first consumer (DingTalk-approval callback) layers on later.

## 0. What exists (scouted on origin/main `690686e71`)

- **Contract (#1889, `workflow-job-contract.ts`) — NOT wired.** `WorkflowJobStatus` includes `suspended`;
  `WorkflowJob.suspend = { reason: 'manual_task'|'delay'|'external_event', resumeToken }`;
  `normalizeWorkflowJob` enforces `suspended ⇔ suspend descriptor`.
- **Executor (`automation-executor.ts`)** — `execute(rule, triggerEvent, jobLifecycleFactory?)` runs
  `executeActions()` **synchronously to completion** (onStart→run→onSettled, fail-stop, mark-rest-skipped).
  `AutomationExecution.status = running|success|failed|skipped`; `AutomationStepResult.status =
  success|failed|skipped`. `executeActions` always starts at index 0.
- **Job plane (A6-1, `automation-job-service.ts`)** — opt-in (`execution_mode='workflow_job_v1'`) writes one
  `multitable_automation_jobs` row per action (id `${exec}:job:${i}`, `upstream_job_id` chain). The A6-1
  comment already reserves the `queued`/worker states "for A6-2".
- **Read API (`routes/automation.ts`)** — `GET /automation-executions(/:id)` (admin) already lists
  `C1_FUTURE_STATUSES = {queued, suspended, rejected, errored}` (`:38`); A5 `POST .../retry` is the
  closest mounting precedent.
- Migration tier: highest is `zzzz20260603120000`.

## 1. The architectural change

Break run-to-completion: a designated step **suspends** — the executor persists enough to resume (a
suspension row + a `suspended` C1 **job** row) and **returns early**, with the legacy execution left
`running` (the suspended state is tracked out-of-band per D2, not on `execution.status`). A separate
**resume** entry-point re-enters `executeActions` at the next step and runs to a terminal state
(`success|failed`).

## 2. Locked decisions (the things to get right before code)

- **D1 — suspend trigger = a new action type `wait_for_callback`** (reason `external_event`). NOT
  `delay` (a timer forces a durable scheduler/worker — deferred) and NOT `manual_task` (that's approval
  territory = A6-5). v1 is purely "pause until an external POST arrives."
- **D2 — track `suspended` OUT-OF-BAND in the C1 job plane; do NOT widen the legacy unions** (revised per
  review — the original "widen `AutomationExecution.status`" was a compile landmine: `LegacyAutomationStatus
  = AutomationExecution['status']` (contract:29) feeds `legacyAutomationStatusToJobStatus`'s switch
  (contract:171) which has **no `suspended` case and no default** → widening makes it non-exhaustive and
  ripples through the A2/A3 read mappers). Instead: the `suspended` state lives **only** where it's
  C1-native — the `multitable_automation_jobs` wait row (`status='suspended'` + the `suspend` descriptor,
  the plane the A3 view already prefers/renders) **and** the suspension table. The legacy
  `AutomationExecution.status` **stays `running`** while suspended (lossy-consistent with the existing
  reverse bridge `suspended→running`) and settles to `success|failed` on resume; `AutomationStepResult`
  stays 3-state — the wait step produces **no legacy step result** until it settles on resume. Net: both
  unions + both bridges + the read mappers are **UNCHANGED** (zero compile ripple). `C1_FUTURE_STATUSES`
  (`automation.ts:38`) already lists `suspended`, so the job-level read tolerates it. *Pre-edit gate:* grep
  every consumer of `AutomationExecution['status']` / `LegacyAutomationStatus` to confirm none assumes the
  execution is terminal once non-`running`.
- **D3 — durable suspension state = new table `multitable_automation_suspensions`** keyed by a UNIQUE
  `resume_token`. Columns: `id, execution_id, rule_id, sheet_id, record_id, step_index` (resume *after*
  this index), `resume_token (UNIQUE)`, `reason`, `trigger_event (jsonb, A1-redacted)`, `status
  (pending|resumed|cancelled)`, `created_at, resumed_at`. Migration `zzzz2026060312####`.
- **D4 — resume RE-DERIVES context, it does not replay a stored snapshot** (the A5 discipline, #2039 D1):
  on resume, re-load the **current** enabled rule + **re-fetch the record** by `record_id`; use the stored
  (redacted) `trigger_event` only for fields not on the record. *Rationale:* never persist unredacted
  `recordData` (no new secret plane — honors the A1 4-channel redaction invariant), and "current data on
  resume" is the right semantic for a wait (the record may have changed during the wait). **Tradeoff to
  confirm:** remaining actions run against *resume-time* record data, not *suspend-time*.
- **D4b — rule-drift guard (review, highest-risk hole).** `step_index` is only meaningful against the
  action array **at suspend time**. A5's "current rule" precedent does NOT transfer cleanly: A5 re-runs the
  *whole* execution so it never indexes; here resume indexes into the array, and if an admin edits the
  rule's actions during the wait, `step_index+1` now points at a **different** action → wrong side effect.
  So persist a **non-secret action fingerprint** at suspend — `{ count: actions.length, hash:
  sha256(actions.map(a => a.type).join('|')) }` (types only; configs may hold secrets, and types+arity are
  enough to detect a re-sequence) — and on resume **fail closed `409 rule_changed`** when the current
  rule's fingerprint differs. Full re-alignment (resume despite an edit) is deferred; the fail-closed guard
  is v1-mandatory.
- **D5 — resume auth = (a) admin-gated for v1 (LOCKED — owner decision 2026-06-03).** Resume is `POST
  /api/multitable/automation/resume` behind **`requireAdminRole()`** (mirrors A5 retry). The body carries a
  `randomUUID()`-grade **single-use** `resume_token` (unknown→`404`, already-resumed→`409`); touches **no
  central RBAC**. **Reasoning (owner):** (1) v1 has **no token-emitter** — since `wait_for_callback` doesn't
  yet hand the token to any external system, a public token endpoint would be a *dormant, unauthenticated,
  side-effecting* public route that nothing calls; not worth landing early. (2) A6-2's hard parts — suspend
  persistence, resume idempotency, the D4b rule-drift guard, tail continuation, failure settle — are fully
  provable through an **admin-gated** endpoint. (3) Consistent with A5: admin-only first to prove the
  mechanism. (4) Cleaner security posture — one fewer dormant unauthenticated side-effecting route + a
  smaller review surface. **The public resume/webhook endpoint is DEFERRED until a real token-emitter + a
  real consumer exist** (a separate explicit opt-in promotes the surface then). TTL/expiry sweep deferred
  regardless.
- **D6 — `executeActions` gains a `startIndex`** so resume continues at `step_index + 1`; index 0 default
  preserves the normal path byte-for-byte. Job ids stay `${exec}:job:${i}` so the chain is contiguous
  across suspend.
- **D7 — opt-in gate: suspend/resume only for `execution_mode='workflow_job_v1'` rules.** A legacy rule
  containing a `wait_for_callback` action **fails closed** (clear error: "wait_for_callback requires
  workflow_job_v1") — legacy has no job plane to suspend; do not silently run-to-completion ignoring it.
- **D8 — fail-closed + idempotent.** Suspend writes the suspension row + the suspended job before returning;
  the execution row stays `running` (D2) so a crash mid-suspend leaves an observable in-flight run, never a
  fake success. Resume claims the token transactionally (`UPDATE … SET status='resumed' WHERE
  resume_token=$1 AND status='pending'` → 0 rows ⇒ 409) **before** continuing, so a double-POST can't
  double-run the tail. **Resumed-tail failure (review):** the claim flips `resumed` *before* the tail runs,
  so a tail that throws settles the execution `failed` (observable, the failed step/job recorded) and the
  suspension stays non-re-runnable (further resume → 409). v1 = **no auto-retry of a resumed tail** —
  documented, not a bug (re-running would need A5-style replay, out of scope).

## 3. Surface (v1, backend-first)

- `automation-actions.ts`: add `wait_for_callback` action type + config (`{ reason?: 'external_event' }`;
  v1 has no params — the callback URL/token is *emitted*, not configured).
- `automation-executor.ts`: detect `wait_for_callback` in `executeActions`; instead of running it, persist
  the suspension (via an injected `SuspensionLifecycle`, mirroring `ActionJobLifecycle` so the executor
  stays DB-agnostic), write the `suspended` C1 job row, and **stop** (return early). Per D2 the legacy
  `execution.status` is **left `running`** (NOT set to `suspended`). Add `startIndex` param.
- `automation-suspension-service.ts` (new): `suspend(...)` persists the row + returns the `resumeToken`;
  `resume(resumeToken, callbackPayload?)` claims the token (D8), re-derives context (D4), settles the
  suspended job → `resolved`, and calls back into the executor with `startIndex`.
- `routes/automation.ts`: `POST /api/multitable/automation/resume` behind **`requireAdminRole()`** (D5
  locked (a)); `resume_token` in the body. Returns the continued execution's terminal status. (Mounted
  beside the A5 retry route.)
- Migration `zzzz20260603HHMMSS_create_automation_suspensions.ts` — HHMMSS strictly **later than the
  same-day `zzzz20260603120000`** so it sorts last (e.g. `zzzz20260603130000`). Columns per D3 + the D4b
  `action_fingerprint` (jsonb/text).

## 4. Test matrix (real-DB, plugin-tests.yml — wire-vs-fixture discipline)

- **T1** opt-in rule with `[update_record, wait_for_callback, update_record]` → execute → execution
  `suspended`; suspension row `pending` with a token; job[1] `suspended`+descriptor; job[2] absent (not yet
  run); first `update_record` ran.
- **T2** resume(token) → execution `success`; job[1]→`resolved`; job[2] written+`resolved`; suspension
  `resumed`; the second `update_record` actually applied (re-fetched record).
- **T3** resume(token) twice → second → `409 already_resumed`, no double-write (assert record version).
- **T4** resume(unknown) → `404`.
- **T5** legacy rule (no `execution_mode`) with `wait_for_callback` → execute → **fail-closed** (execution
  `failed`, clear error), no suspension row.
- **T6** stored `trigger_event` is **redacted** (seed a secret-shaped value → assert scrubbed in the row).
- **T7** resume re-derives the **current** rule (disable rule between suspend+resume → resume fails closed
  409/`rule_disabled`, mirroring A5 D7).
- **T8** rule-drift guard (D4b): **edit the rule's actions** between suspend+resume → resume → `409
  rule_changed`, tail does NOT run (assert no second-action side effect).
- **T9** record deleted between suspend+resume → resume fails closed `404 record_gone` (no crash, no tail).

## 5. Runtime red lines (LOCKED — do NOT build in A6-2; each is a separate later opt-in)

**Hard red lines (owner-locked 2026-06-03):**
- **No `delay`/timer suspends** — would force a durable scheduler.
- **No worker/claim queue** — A6-2 suspends *inline*; the `queued` C1 state stays vestigial.
- **No branch/parallel (DAG)** — that is A6-3.
- **No BPMN** — designer/adapter only, never a runtime (A6-4).
- **No approval-as-job** — that is A6-5 (double-gated, last).
- **No public resume endpoint / no token emitter** — admin-gated only (D5); promote later, separate opt-in.
- **No K3 / central RBAC / integration-core / contract touch.**

**Also deferred (smaller follow-ups, not red lines):** frontend UI (configure the action + show suspended
runs = A6-2b) · callback **payload → record write** (v1 ignores the body beyond resuming) · token
TTL/expiry sweep · multiple concurrent waits per execution (v1 = exactly one wait point).

## 6. TODO checklist

- ⬜ migration `…_create_automation_suspensions` (incl. `action_fingerprint`, HHMMSS > 120000)
- ⬜ `wait_for_callback` action type + config (`automation-actions.ts`)
- ⬜ `suspended` tracked OUT-OF-BAND (D2): job-plane + suspension table only; **legacy unions/bridges
  UNCHANGED** (pre-edit grep of `AutomationExecution['status']` / `LegacyAutomationStatus` consumers)
- ⬜ executor: `startIndex` + `wait_for_callback` suspend detection + `SuspensionLifecycle` injection
- ⬜ `automation-suspension-service.ts` (suspend + action-fingerprint + token-claim resume + re-derive)
- ⬜ resume endpoint = **admin-gated `POST /automation/resume`** (D5 locked (a); no public endpoint/emitter)
- ⬜ gates: D4b rule-drift `409` · D7 opt-in fail-closed · D8 idempotent token-claim
- ⬜ real-DB tests T1–T9 (wired into plugin-tests.yml)
- ⬜ verification doc
