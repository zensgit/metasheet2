# Multitable Automation A6-1 — Persistent WorkflowJob Runtime (verification) — 2026-05-30

- **Slice**: A6-1 — opt-in persistent linear WorkflowJob runtime. Implements the A6-1 scout (#2112) after explicit owner opt-in ("启动 A6-1 runtime"). First A6 capability-half runtime.
- **Status**: ✅ implemented + verified. A6-2+ (suspend/resume, branch/parallel, BPMN, approval-as-job) remain frozen / demand-gated.
- **Lock**: post-GATE (K3 blanket lock retired, #1993); A6-1 governed by the run-governance demand gate, not K3. Automation is multitable-kernel (no integration-core / RBAC / K3-write touch).

## What shipped

| File | Change |
|---|---|
| migration `zzzz20260530120000` | new `multitable_automation_jobs` (+ `idx…execution_id`) + nullable `automation_rules.execution_mode`. |
| `db/types.ts` | `MultitableAutomationJobsTable` + `execution_mode` on the rules table + Database registration. |
| `automation-executor.ts` | `AutomationRule.executionMode?`; `ActionJobLifecycle` (onStart/onSettled/onSkipped) + `ActionJobLifecycleFactory`; `execute(rule, evt, jobLifecycleFactory?)`; `executeActions(..., jobLifecycle?)` fires hooks **outside the inner per-action try/catch**. |
| `automation-job-service.ts` (new) | `lifecycleFor(executionId, rule)` (job persistence around each action) + `listByExecution(executionId)` (C1 views). Reuses `redactValue`/`redactString`; statuses via `legacyAutomationStatusToJobStatus`/`normalizeWorkflowJobStatus`. |
| `automation-service.ts` | `AutomationRule.execution_mode`; `toExecutorRule`/`mapRow` plumb it; `executeRule` builds the factory ONLY for `workflow_job_v1` (single path-choice point → retries of opt-in rules also write jobs); `get jobs()` accessor. |
| `routes/automation.ts` | A2 detail prefers persisted jobs (`svc.jobs.listByExecution`) → C1 step view; falls back to legacy steps when none (list unchanged — no N+1). |

## A6-1 scout questions → implementation

| Scout Q | Implemented |
|---|---|
| 1. table shape | separate `multitable_automation_jobs` (NOT extending `steps`); scout columns; index on `execution_id`. |
| 2. opt-in | rule-level `execution_mode` (`NULL`/`legacy` = no jobs; `workflow_job_v1` = jobs). Not a global env flag. |
| 3. worker | none — inline; job created **`running`** before the action (no vestigial `queued`; the invariant is *created-before-side-effect*, so a crash leaves an observable `running` row). |
| 4. txn boundary | **fail-closed for opt-in** (see below). |
| 5. redaction | reuse `automation-log-redact` (`redactValue` result / `redactString` error). No job-specific redactor; no integration-core import → A1 invariant preserved. |
| 6. mixed read | A2 detail prefers jobs, falls back to legacy steps; no new response field (shape stable; job ids `:job:i` vs legacy `:step:i`). |
| 7. legacy-off | opt-out rule → no factory → zero job rows + byte-identical execution/log shape (tested). |

## Fail-closed design (the load-bearing correctness point)
The lifecycle hooks run **OUTSIDE** the inner per-action `try/catch` (which converts action throws into a `failed` STEP). So a job-write failure propagates to `execute()`'s outer catch and fails the **EXECUTION**, not a swallowed step. Two pinned sub-cases:
- **(a) onStart throws** (job create fails) → the action's side effect **never runs**; execution `failed`.
- **(b) onSettled throws** (job update fails) *after* the action → the side effect **ran once**; execution `failed` — "must not pretend the action didn't run."

This is stricter than the legacy log-write swallow and the `/test`+retry fail-OPEN (#2053) — deliberately, because A6-1 is opt-in durable provenance. **Operator-visible consequence (accepted, per scout):** a transient job-write blip turns a side-effect-completed opt-in run into `failed`; an operator A5 retry can then double-fire those side effects. Surfaced here so it's a conscious trade, not a surprise.

## Verification
- `tsc --noEmit` (core-backend): ✅ 0.
- Unit: ✅ **181** (`automation-v1` adds: executor lifecycle ordering, fail-stop skipped, **fail-closed (a) side-effect-never-ran + (b) side-effect-ran-once**, legacy-no-factory unchanged; service path-choice opt-out-no-factory / opt-in-factory; `AutomationJobService` onStart-running / onSettled-redacted+C1-status / `listByExecution` C1 views pass `normalizeWorkflowJob`; `automation-runs-api` adds A2-detail-prefers-jobs vs legacy-steps-fallback). Existing automation suites unchanged.
- Real-DB round-trip: `tests/integration/multitable-automation-jobs.test.ts` (describeIfDatabase + sentinel) — lifecycle onStart→onSettled→onSkipped → `listByExecution` + raw-SQL confirm the new table/columns; wired into `plugin-tests.yml` (closes the wire-vs-fixture gap for the new table).
- ESLint (my files): clean. One **pre-existing** `prefer-const` in `parseCreateRuleInput` (unrelated; core-backend has no `lint` script so CI doesn't flag it) — left as-is.

## Latency — runtime present, enable path deferred (dormant in production)
The read path is fully wired: all `automation_rules` reads use `.selectAll()`, so `execution_mode` flows through `mapRow` → `toExecutorRule` → `executeRule` at runtime (verified — NOT dead-on-arrival). **But no write path sets it**: `createRule`/`updateRule` deliberately do NOT accept/passthrough `execution_mode` (enable path is scout-deferred). So in production the job plane is **dormant** — a rule can be opted in only by **direct DB / fixture** (`execution_mode='workflow_job_v1'`), not via the API. A follow-up (its own opt-in) adds the API/UI enable writer. This is intended: the runtime lands and is provable, while turning it on stays a separate, reviewable step.

## Scope held / out of scope
NO suspend/resume, resume tokens, delay/timer, worker/claim, branch/parallel graph columns, BPMN, approval-as-job, `start_approval`, or default per-action writes for existing rules — **A6-2..A6-5 stay frozen / demand-gated**. Job ids use `${exec}:job:i` (vs legacy `${exec}:step:i`); consumers must not assume a stable step-id shape across an opt-in flip.
