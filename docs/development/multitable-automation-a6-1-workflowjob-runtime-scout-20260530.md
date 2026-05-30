# Multitable Automation A6-1 Persistent WorkflowJob Runtime Scout — 2026-05-30

Status: docs-only scout / runtime not started
Scope: A6-1 persistent linear `WorkflowJob` runtime planning
Companions:
- `docs/development/multitable-automation-a6-convergence-scout-20260529.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `docs/development/run-governance-forward-plan-20260528.md`
- `docs/research/approval-automation-convergence-rfc-20260526.md`

## Verdict

A6-1 may be developed next, but only as a separately reviewed, opt-in, linear
job-persistence runtime. It is no longer blocked by the retired K3 Stage-1
blanket lock, but it is still governed by the run-governance demand gate.

This scout does not authorize A6-2+ capabilities. The first runtime slice must
persist one C1-shaped job per action for explicitly opted-in automation rules,
while leaving existing rules on the current legacy execution path by default.

## Grounding In Current Main

Current `origin/main` has the governance substrate but not the job engine:

- C1 `WorkflowJob` contract exists in
  `packages/core-backend/src/multitable/workflow-job-contract.ts`. It defines the
  status vocabulary and strict normalizers.
- A2 runs API maps legacy `AutomationExecution.steps` into C1 at the read
  boundary in `packages/core-backend/src/routes/automation.ts`. It already treats
  future statuses such as `queued` and `suspended` as legal filters with empty
  results.
- `packages/core-backend/src/multitable/automation-executor.ts` is still a
  private, sequential, fail-stop loop. `executeActions()` runs actions in order,
  stops after the first failed action, and appends skipped results for the
  remaining actions.
- `packages/core-backend/src/multitable/automation-service.ts` still persists a
  single execution row through `AutomationLogService.record()`. A5 retry is
  whole-execution replay, not step-level resume.
- `packages/core-backend/src/multitable/automation-log-service.ts` is the
  redaction boundary. `record()` redacts steps, trigger event, rule snapshot, and
  execution-level error before persistence.
- `multitable_automation_executions` remains the execution log table. There is
  no `automation_jobs` / `workflow_jobs` table and no runtime import of C1 by the
  executor.

Therefore A6-1 should be the smallest runtime bridge between the existing linear
executor and the C1 contract, not a new engine.

## Scope Decision

A6-1 runtime may add:

- a new additive job table for opt-in linear action jobs;
- a rule-level opt-in flag / capability gate;
- executor/service wiring that records one job per action for opted-in rules;
- A2/A3 read integration that prefers persisted jobs when present and falls back
  to legacy `steps` for old executions;
- focused tests proving opt-out compatibility, opt-in job persistence, redaction,
  and read-boundary behavior.

A6-1 runtime must not add:

- suspend/resume endpoints or resume tokens;
- delay/timer persistence or worker claiming;
- branch/parallel graph execution;
- BPMN import, compile, preview, or runtime;
- approval-as-job, `start_approval`, approval completion events, trigger
  bindings, or approval result backwrite;
- default per-action job writes for every existing rule;
- K3 Submit/Audit/BOM/multi-record write expansion or any direct K3 unlock.

## A6-0 Scout Questions Answered

### 1. Table Shape

Use a new table rather than extending `multitable_automation_executions.steps`.
Recommended name: `multitable_automation_jobs`.

Minimal A6-1 columns:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Stable C1 job id, e.g. `awj_<uuid>` or deterministic execution/action key. |
| `execution_id` | TEXT NOT NULL | References `multitable_automation_executions(id)`; index required. |
| `rule_id` | TEXT NOT NULL | Denormalized for filtering/debugging; index optional. |
| `sheet_id` | TEXT NULL | Mirrors execution snapshot; nullable for safety. |
| `step_index` | INTEGER NOT NULL | Legacy action index, unique per execution. |
| `step_key` | TEXT NOT NULL | C1 step key; A6-1 can use `String(step_index)`. |
| `action_type` | TEXT NOT NULL | Diagnostic anchor. |
| `status` | TEXT NOT NULL | C1 status; A6-1 writes only `queued/running/resolved/failed/skipped`. |
| `upstream_job_id` | TEXT NULL | Linear predecessor only; first job is null. |
| `result` | JSONB NULL | Redacted before persistence. |
| `error` | TEXT NULL | Redacted before persistence. |
| `started_at` | TIMESTAMPTZ NULL | Set when action begins. |
| `finished_at` | TIMESTAMPTZ NULL | Set when action reaches terminal status. |
| `duration_ms` | INTEGER NULL | Mirrors current step duration. |
| `schema_version` | INTEGER NOT NULL DEFAULT 1 | Forward compatibility. |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Audit. |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Audit. |

Do not add `suspend`, `resume_token`, `branch_index`, downstream edges, join
mode, or worker claim columns in A6-1. Those belong to A6-2/A6-3 when the runtime
can actually use them.

### 2. Opt-in Flag

Existing rules must remain legacy by default.

The preferred A6-1 flag is rule-level and explicit, for example an additive
nullable/defaulted `execution_mode` column on `automation_rules` with:

- `NULL` / `legacy` = current path, no job rows;
- `workflow_job_v1` = write linear job rows.

This is deliberately not a global environment flag: write amplification and
compatibility should be reviewable per rule/use-case. The route/UI that enables
the flag can be deferred if A6-1 starts with controlled backend fixtures or an
admin-only maintenance toggle; what matters is that runtime default stays
legacy.

### 3. Worker / Claim Model

A6-1 should not introduce a worker or claim model.

The first implementation can run inline inside the existing execution call:

1. create job as `queued`;
2. mark it `running` just before executing the action;
3. update it to `resolved` / `failed`;
4. create terminal `skipped` jobs for remaining actions when fail-stop triggers.

Worker claiming starts only when A6-2 needs durable resume or delay wakeups. A
worker in A6-1 would create scheduler semantics before there is any resumable
job.

### 4. Side-effect Transaction Boundary

The hard problem is external side effects: record writes, webhooks, email, and
DingTalk cannot be rolled back by a database transaction.

Recommended A6-1 rule:

- for an opted-in rule, if the job row cannot be created/updated before the
  action starts, fail the execution before performing the action;
- after a side effect has run, a job-update failure must not pretend the action
  did not run. It should fail the execution with an operator-visible error and
  preserve whatever execution/job state was successfully persisted.

This is stricter than the legacy execution log, where log-write failure is
swallowed. The stricter behavior is acceptable only because A6-1 is opt-in; it is
the price of durable per-action provenance.

The implementation PR must make this behavior explicit in tests. Do not hide job
persistence failure as a background warning for opted-in rules.

### 5. Redaction Helper

Use the existing multitable automation redactor:

- `packages/core-backend/src/multitable/automation-log-redact.ts`
- `redactValue()` for `result`;
- `redactString()` for `error`.

Do not create a job-specific redactor and do not import integration-core
redaction into multitable. A6-1 must preserve the A1 invariant: no new unredacted
execution/job plane.

### 6. Mixed Legacy / Persisted Read Model

A2/A3 should keep their external response shape stable.

Read order:

1. If persisted jobs exist for an execution, map those rows to C1 `WorkflowJob`
   view.
2. If no job rows exist, keep the current legacy fallback:
   `AutomationExecution.steps -> toWorkflowJobView()`.

Optional diagnostic field: add `stepsSource: 'persisted_jobs' | 'legacy_steps'`
only if frontend/debugging needs it. The first implementation can avoid adding a
new response field and preserve the current shape.

Status filtering should remain compatible with the existing A2 behavior:

- stored execution status continues to drive list-level execution filtering;
- step/job statuses are detail-level data until a named product need requires
  job-level filtering.

### 7. Legacy-Off Tests

A6-1 must prove the feature flag is real:

- rule without opt-in produces the exact same execution/log shape as today;
- no job rows are inserted when opt-in is off;
- existing automation-v1 / retry / test-run behavior remains unchanged.

This is the key compatibility gate. If opt-out behavior changes, the runtime
slice is too broad.

## Runtime Implementation Shape

Recommended structure for the future runtime PR:

1. Add migration + DB types for `multitable_automation_jobs` and the rule
   opt-in flag.
2. Add a small `AutomationJobService` responsible only for job persistence and
   C1 row mapping.
3. Extend `AutomationService.executeRule()` to choose legacy executor vs
   job-persisting executor path based on the rule opt-in flag.
4. Refactor `AutomationExecutor.executeActions()` only as much as needed to
   expose per-action lifecycle callbacks or a small linear action runner.
5. Update A2 detail mapping to prefer persisted jobs when present.

Avoid putting DB writes directly inside each individual action executor. The
action executors should continue to perform domain side effects; job lifecycle
should sit around them.

## Required Runtime Tests

Focused unit tests:

- opt-out rule inserts no job rows and preserves current execution shape;
- opt-in success path writes one queued/running/resolved job per action;
- opt-in failed action writes failed job plus skipped jobs for remaining actions;
- job rows pass `normalizeWorkflowJob()`;
- result/error are redacted before job persistence;
- A2 detail prefers persisted jobs and falls back to legacy steps;
- future-state status filters remain legal empty results before A6-2.

Real DB / migration tests:

- migration replay creates the jobs table and rule opt-in field;
- execution row + job rows round-trip through Kysely;
- delete/retention behavior is explicit. If execution cleanup deletes old
  execution rows, job cleanup must not leave orphaned job rows.

Regression tests:

- A5 whole-execution retry still creates a new execution and does not become
  step-level retry;
- `/test` and retry routes continue returning redacted persisted/fallback
  execution responses;
- schedule-trigger and event-trigger legacy paths remain unchanged when opt-in
  is off.

## Open Decisions Before Runtime

These must be answered in the A6-1 implementation PR body before code is merged:

1. Is `execution_mode` the final opt-in storage, or should the flag live in a
   JSON config column to avoid widening `automation_rules`?
2. Should A6-1 use deterministic job ids based on execution + step index, or
   random ids plus a unique `(execution_id, step_index)` constraint?
3. Should job write failure before action start fail closed for opted-in rules?
   This scout recommends yes.
4. Should execution cleanup cascade to jobs or should jobs have their own
   retention policy?
5. Should A2 expose a `stepsSource` diagnostic field, or keep response shape
   unchanged?

## Acceptance For This Scout

- Docs-only diff.
- A6-1 scout answers the seven A6-0 questions.
- Canonical TODO/forward docs say A6-1 scout is recorded while runtime remains
  unstarted.
- No migration, route, service, executor, frontend, or test files changed.

## Current Recommendation

Proceed to A6-1 runtime only after owner confirms the concrete demand and
accepts the opt-in persistent-job write cost. The implementation should be one
small runtime PR, not an A6 monolith.
