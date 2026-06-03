# A6-2 — suspend/resume runtime (admin-gated v1) — verification (2026-06-03)

> Verifies the impl against the design-lock `multitable-automation-a6-2-suspend-resume-design-20260603.md`
> (#2236). Backend-first; frontend (A6-2b) deferred. Built on a fresh worktree off `origin/main`.

## What shipped

- **`wait_for_callback` action** (`automation-actions.ts`) — union + `ALL_ACTION_TYPES` + config (no params; v1).
- **Migrations** — `zzzz20260603130000_create_automation_suspensions` (the suspension table, D3) +
  `zzzz20260603140000_add_wait_for_callback_automation_action` (widen `chk_automation_action_type`).
- **Executor** (`automation-executor.ts`) — `executeActions` gains `startIndex` + `wait_for_callback`
  detection (suspend via `onSuspend`, else **D7 fail-closed**); `executeActions` now returns
  `{ suspended }`; `execute()` leaves the execution `running` on suspend (D2); new `continueExecution()`
  settles the wait step + runs the tail from `startIndex`.
- **Job plane** (`automation-job-service.ts`) — `writeSuspendedJob()` (the `suspended` C1 job, D2);
  resume settles it via the existing `onSettled` (suspended→resolved).
- **Suspension service** (`automation-suspension-service.ts`, NEW) — `create()` (suspension row +
  suspended job, A1-redacted trigger_event), `findByToken()`, transactional single-use `claim()` (D8),
  `computeActionFingerprint()` (D4b).
- **Service** (`automation-service.ts`) — `onSuspend` wired into the opt-in `jobLifecycleFactory`;
  `resumeExecution()` (discriminated result mirroring `retryExecution`): re-load current rule (D4) →
  fingerprint guard (D4b) → re-fetch record (D4) → claim (D8) → `continueExecution` → persist.
- **Route** (`routes/automation.ts`) — `POST /api/multitable/automation/resume`, **`requireAdminRole()`**
  (D5), `confirmSideEffects` gate, persisted-redacted serialization (same as retry).
- **DB types** (`db/types.ts`) — `MultitableAutomationSuspensionsTable` registered.

## Test results (real Postgres `metasheet_test`, local)

- **A6-2 real-DB T1–T9 — 10/10 PASS** (`tests/integration/multitable-automation-suspend-resume.test.ts`,
  wired into `plugin-tests.yml`): T1 suspend (execution `running`, suspension `pending`+token, job[1]
  `suspended`, job[2] absent, job[0] resolved) · T2 resume → success, all jobs resolved, suspension
  `resumed`, `initiatedBy` stamped · T3 double-resume → 409 · T4 unknown token → 404 · T5 legacy
  fail-closed (no suspension) · T6 trigger_event redacted · T7 rule-disabled → 409 (token NOT consumed) ·
  T8 rule-changed → 409 (D4b) · T9 record-missing → 404. **T1 also asserts the suspended READ path** —
  `listByExecution` surfaces the descriptor-less `suspended` job view without throwing.
- **No regressions:** A6-1 jobs real-DB **5/5**; action-type migration tests **6/6** (send_email delta +
  new wait_for_callback sync); `automation-runs-api` **24/24** (admin-gate count 3→4 confirms the resume
  route IS gated; **a suspended execution renders via the detail route** — 200, status `running`, suspended
  step visible, no `normalizeWorkflowJob` throw; resume route confirm-gate 400s / 404 / 200);
  backend **`tsc --noEmit` 0 errors**; full unit sweep **2673+ pass**.
- **Pre-existing env-only failures (NOT A6-2):** `data-source-scope` (mysql2 driver) +
  `multitable-e2e-helper-env` (@playwright/test) fail to *module-load* in the symlinked-node_modules
  worktree; both files are untouched by A6-2 and pass under CI's real `pnpm install`.

## Deltas / as-built notes vs the design-lock

1. **Action-type CHECK constraint (not in the design).** `automation_rules.action_type` has a
   `chk_automation_action_type` CHECK constraint kept in sync with `ALL_ACTION_TYPES` by a unit test.
   Adding `wait_for_callback` required a 2nd migration to widen it; the sync test moved to the new
   migration's spec (the send_email spec now locks only its own delta). Caught by the existing test, not
   in prod.
2. **D2 validated against the read path (pre-edit gate).** `routes/automation.ts:119`
   (`execution.status !== 'running' && jobs.some(non-terminal)`) short-circuits for a suspended-but-
   `running` execution (legitimate, jobs view preferred), and `C1_FUTURE_STATUSES` already lists
   `suspended` (filter → empty). So the legacy unions/bridges are UNCHANGED — zero ripple, as designed.
3. **A3 list filter (inherited).** Under D2 the runs **list** filter `status=suspended` returns empty
   (suspended runs list as `running`); the suspended state shows in the **detail** via the job plane.
   Pre-existing intentional contract — carry into A6-2b (surface a derived "suspended" indicator there).
4. **T9 reframed.** `meta_records` has a FK to `meta_sheets`, so insert-then-delete needs a sheet; a
   recordId absent at resume exercises the **same** `404 record_gone` code path (re-fetch → 0 rows).

## Review round 1 — REQUEST CHANGES addressed (2026-06-03)
Owner diff-review flagged 3 state-consistency / C1-contract blockers; all fixed and re-verified (counts above):
- **B1 — C1 contract:** a `suspended` job view was descriptor-less, so it would be rejected by
  `normalizeWorkflowJob` (a shape that only *resembled* C1). Fix: `listByExecution` attaches the
  `suspend: { reason, resumeToken }` descriptor from the suspension table (single source of truth) → a
  VALID C1 WorkflowJob. T1 now asserts `normalizeWorkflowJob(suspendedView)` does **not** throw. The token
  in this admin-gated read is also how a v1 admin obtains it to resume (no external emitter).
- **B2 — atomicity:** the suspension row + the `suspended` C1 job are now written in ONE transaction
  (`AutomationSuspensionService.create` via `db.transaction`), so a half-written suspend can't leave a
  dangling pending-suspension-without-job (or vice versa) that a later resume could observe.
- **B3 — token consumed too early:** `resumeExecution` now reads the execution row **before** the claim
  (a missing/unreadable execution no longer consumes the single-use token — it stays `pending`,
  recoverable), and `continueExecution` settles the execution to a terminal `failed` on ANY post-claim
  failure (the wait-step settle moved INSIDE the try) instead of bubbling a 500 with the token consumed
  and the tail unrun.

## Red lines honored
No delay/timer · no worker/claim · no branch/parallel · no BPMN · no approval-as-job · **no public
endpoint / no token emitter** (admin-gated only) · no K3 / central RBAC / integration-core / contract.

## Remaining (separate opt-ins)
A6-2b frontend (configure the action + surface suspended runs) · public webhook endpoint + token emitter
(when a real consumer exists) · sequential-multi-wait stress · A6-3+ (branch / BPMN / approval-as-job).
