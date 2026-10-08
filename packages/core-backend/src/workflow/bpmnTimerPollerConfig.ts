/**
 * Env-gate for `BPMNWorkflowEngine`'s `startTimerProcessor()` minute poller.
 *
 * Owner ruling (2026-08-05, Plan B): the production BPMN workflow engine is
 * self-described as "in development" (see `src/index.ts`'s
 * `/api/workflow-mock/status` handler, `message: 'Workflow engine is in
 * development. Use /api/workflow for real endpoints.'`), and there is no
 * evidence of production use: no seed/migration ever inserts a
 * `bpmn_process_definitions` row, and `WORKFLOW_ENABLED=true` (the frontend
 * flag that surfaces the Workflow Designer UI) appears in no deploy config,
 * docker-compose file, or CI workflow in this repo — only in two local-dev
 * verification docs (20260309, `NODE_ENV=development`, port 7778).
 *
 * That is "no evidence of use", not "structurally impossible": the real
 * `/api/workflow/deploy` route is reachable by any authenticated user
 * regardless of `WORKFLOW_ENABLED` (that flag only hides frontend UI, see
 * `routes/auth.ts`'s `buildFeaturePayload` — it is never read by engine
 * lifecycle code), and `apps/web/src/views/workflowDesignerPersistence.ts`
 * does call that real route from the shipped Workflow Designer UI. Whether
 * any live deployment has actually used it to create a `bpmn_timer_jobs` row
 * cannot be confirmed by static analysis. What IS structurally true:
 * `startTimerProcessor`'s poll (one `selectFrom`, plus `processTimerJob`'s
 * three `updateTable` calls) is the ONLY reader of `bpmn_timer_jobs` in this
 * codebase — gating it off PAUSES processing of any such row (it stays
 * `WAITING`, nothing is dropped or deleted) rather than losing it, and the
 * pause is reversible by setting this flag. `'cycle'`-type recurring timers
 * are a separate, unaffected code path (`scheduleRecurringTimer`, its own
 * in-memory `cron.schedule`) — only persisted date/duration timers are
 * affected. `resumeActiveInstances()` (also called from `initialize()`) only
 * loads `bpmn_process_instances` into memory and does not depend on this
 * poller either.
 *
 * A dormant subsystem should not poll regardless: previously
 * `startTimerProcessor()` scheduled an unconditional `* * * * *` cron job
 * against the shared `db` pool the moment `BPMNWorkflowEngine.initialize()`
 * ran (both eager, at module-load time via `routes/workflow.ts`, and lazily
 * on first designer-route call via `routes/workflow-designer.ts`), which is
 * both needless standing load and — per issue #4770/#4779 — a source of
 * teardown races in tests that boot the real server against a scratch
 * database.
 *
 * This flag defaults OFF (unset or any value other than the literal string
 * `'true'`). Deliberately narrower than `DISABLE_WORKFLOW` (which opts the
 * WHOLE engine out — `loadProcessDefinitions`, `resumeActiveInstances`,
 * metrics, health check, and the timer poller together) and unrelated to
 * `WORKFLOW_ENABLED` (a frontend-only display flag, never read by engine
 * lifecycle code) — this only ever governs whether the minute poller itself
 * starts. If a deployment is known to have live BPMN process instances with
 * date/duration timer events waiting to fire, set this to `'true'` in that
 * deployment's environment.
 */
export const BPMN_TIMER_POLLER_ENABLED_ENV = 'ENABLE_BPMN_TIMER_POLLER'

type BpmnTimerPollerEnv = Readonly<Record<string, string | undefined>>

export function isBpmnTimerPollerEnabled(env: BpmnTimerPollerEnv = process.env): boolean {
  return env[BPMN_TIMER_POLLER_ENABLED_ENV] === 'true'
}

/**
 * Owner review P1-1 (2026-08-05, PR #4783): env-gating the POLLER off was not enough —
 * `BPMNWorkflowEngine.createTimerJob()` (the only `INSERT INTO bpmn_timer_jobs` site in
 * this codebase) still unconditionally persisted a `state: 'WAITING'` row for every
 * `'date'`/`'duration'` timer, regardless of the flag. With the poller off, that row can
 * never be read back — a NEWLY created orphan, not a paused pre-existing one, because
 * poller-off was already the deploy's state when it was written. "Current WAITING count
 * is 0, therefore safe to merge" does not hold once new writes keep happening after
 * merge: `/api/workflow/start/:key`, task-complete, message, and signal delivery are all
 * reachable by any authenticated user and can each drive process execution into a timer
 * event.
 *
 * `createTimerJob` throws this BEFORE the insert when the poller is disabled, for
 * `'date'`/`'duration'` timers only — `'cycle'` timers never reach this code path (see
 * `scheduleRecurringTimer`, a separate in-memory `cron.schedule` that never touches
 * `bpmn_timer_jobs`). The route layer's existing generic `catch (error) { ... 500 ...
 * error.message }` pattern (see every handler in `routes/workflow.ts`) surfaces `code` as
 * the response body's `error` field — a stable, enum-shaped signal, not a swallowed
 * silent write. This mirrors the `readonly code: string` `Error` subclass convention used
 * throughout `packages/core-backend/src/attendance/*` (e.g. `AttendanceW4AuthorizationError`).
 */
export const BPMN_TIMER_POLLER_DISABLED_ERROR_CODE = 'BPMN_TIMER_POLLER_DISABLED'

export class BpmnTimerPollerDisabledError extends Error {
  readonly code: string
  constructor(code: string = BPMN_TIMER_POLLER_DISABLED_ERROR_CODE) {
    super(code)
    this.name = 'BpmnTimerPollerDisabledError'
    this.code = code
  }
}
