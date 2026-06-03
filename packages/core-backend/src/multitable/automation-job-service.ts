/**
 * Automation Job Service — A6-1 persistent WorkflowJob runtime (opt-in).
 *
 * Responsible ONLY for persisting one C1-shaped job row per action of an opted-in
 * automation rule (`execution_mode = 'workflow_job_v1'`) and reading them back as
 * C1 WorkflowJob views. It does NOT execute actions — `AutomationExecutor` owns the
 * side effects; this service is the lifecycle/persistence plane around them.
 *
 * Invariants:
 * - reuses the A1 redaction helper (no job-specific redactor; result via redactValue,
 *   error via redactString) — no new unredacted plane;
 * - statuses are the C1 vocabulary via `legacyAutomationStatusToJobStatus` (no second
 *   status vocabulary);
 * - fail-closed: the lifecycle hooks throw on a DB failure so the executor's outer
 *   catch fails the execution (opt-in durable provenance), never a silent warning.
 */

import { db } from '../db/db'
import { toJsonValue } from '../db/type-helpers'
import { legacyAutomationStatusToJobStatus, normalizeWorkflowJobStatus, type WorkflowJobStatus, type WorkflowJobSuspendReason } from './workflow-job-contract'
import type { ActionJobLifecycle } from './automation-executor'
import type { AutomationAction } from './automation-actions'
import { redactString, redactValue } from './automation-log-redact'

const JOB_SCHEMA_VERSION = 1

export class AutomationJobService {
  /**
   * Build the per-action lifecycle for ONE opted-in execution. The executor calls
   * onStart/onSettled/onSkipped around each action; we persist job rows accordingly.
   * A6-1 inline has no queue/worker → a job is created directly as `running` (the
   * vestigial `queued` state belongs to A6-2's worker/claim). The row is created
   * BEFORE the action runs, so a crash leaves an observable `running` row.
   */
  lifecycleFor(executionId: string, rule: { id: string; sheetId?: string }): ActionJobLifecycle {
    // Deterministic id (no random) → idempotent shape, same `${exec}:<kind>:<i>` family as the
    // legacy step-view id (`${exec}:step:i`); jobs use `:job:`.
    const jobId = (stepIndex: number): string => `${executionId}:job:${stepIndex}`
    const upstream = (stepIndex: number): string | null => (stepIndex > 0 ? jobId(stepIndex - 1) : null)

    return {
      onStart: async (stepIndex, action) => {
        const id = jobId(stepIndex)
        const now = new Date().toISOString()
        await db
          .insertInto('multitable_automation_jobs')
          .values({
            id,
            execution_id: executionId,
            rule_id: rule.id,
            sheet_id: rule.sheetId ?? null,
            step_index: stepIndex,
            step_key: String(stepIndex),
            action_type: action.type,
            status: 'running', // C1 'running'
            upstream_job_id: upstream(stepIndex),
            result: null,
            error: null,
            started_at: now,
            finished_at: null,
            duration_ms: null,
            schema_version: JOB_SCHEMA_VERSION,
          })
          .execute()
      },
      onSettled: async (stepIndex, _action, result) => {
        await db
          .updateTable('multitable_automation_jobs')
          .set({
            status: legacyAutomationStatusToJobStatus(result.status), // success→resolved, else identity
            // Same A1 redaction as record() — secret-shaped values scrubbed before persist.
            result: result.output == null ? null : (toJsonValue(redactValue(result.output)) as never),
            error: result.error != null ? redactString(result.error) : null,
            finished_at: new Date().toISOString(),
            duration_ms: result.durationMs ?? null,
            updated_at: new Date().toISOString() as never,
          })
          .where('id', '=', jobId(stepIndex))
          .execute()
      },
      onSkipped: async (stepIndex, action) => {
        // Fail-stop remainder — a terminal skipped job (created directly, never ran).
        const now = new Date().toISOString()
        await db
          .insertInto('multitable_automation_jobs')
          .values({
            id: jobId(stepIndex),
            execution_id: executionId,
            rule_id: rule.id,
            sheet_id: rule.sheetId ?? null,
            step_index: stepIndex,
            step_key: String(stepIndex),
            action_type: action.type,
            status: 'skipped',
            upstream_job_id: upstream(stepIndex),
            result: null,
            error: null,
            started_at: null,
            finished_at: now,
            duration_ms: 0,
            schema_version: JOB_SCHEMA_VERSION,
          })
          .execute()
      },
    }
  }

  /**
   * A6-2: write the wait step's job row as `suspended` (the out-of-band suspended state, D2).
   * Mirrors onStart's insert (started, observable) but with C1 status `suspended` and no finish.
   * The suspend descriptor (reason / resume token) lives in the suspension table, NOT here — the
   * token is a capability secret and must never enter the job/read plane. On resume the existing
   * onSettled flips this row → `resolved` (success→resolved bridge).
   */
  async writeSuspendedJob(
    executionId: string,
    rule: { id: string; sheetId?: string },
    stepIndex: number,
    action: AutomationAction,
    executor: typeof db = db,
  ): Promise<void> {
    const now = new Date().toISOString()
    await executor
      .insertInto('multitable_automation_jobs')
      .values({
        id: `${executionId}:job:${stepIndex}`,
        execution_id: executionId,
        rule_id: rule.id,
        sheet_id: rule.sheetId ?? null,
        step_index: stepIndex,
        step_key: String(stepIndex),
        action_type: action.type,
        status: 'suspended', // C1 'suspended' (non-terminal); excluded from TERMINAL_JOB_STATUSES
        upstream_job_id: stepIndex > 0 ? `${executionId}:job:${stepIndex - 1}` : null,
        result: null,
        error: null,
        started_at: now,
        finished_at: null,
        duration_ms: null,
        schema_version: JOB_SCHEMA_VERSION,
      })
      .execute()
  }

  /**
   * Read persisted jobs for an execution as C1 WorkflowJob views, ordered by step.
   * Returns [] when the execution has no jobs (legacy execution → caller falls back
   * to AutomationExecution.steps). The shape matches the A2 step view (id/executionId/
   * stepKey/status/upstreamJobId/result/error) so the read boundary is uniform.
   */
  async listByExecution(executionId: string): Promise<Array<{
    id: string
    executionId: string
    stepKey: string
    status: WorkflowJobStatus
    upstreamJobId: string | null
    result: unknown
    error?: string
    suspend?: { reason: WorkflowJobSuspendReason; resumeToken: string }
  }>> {
    const rows = await db
      .selectFrom('multitable_automation_jobs')
      .selectAll()
      .where('execution_id', '=', executionId)
      .orderBy('step_index', 'asc')
      .execute()

    // B1: a `suspended` job MUST carry its C1 suspend descriptor — the contract enforces
    // `suspended ⇔ { reason, resumeToken }` (normalizeWorkflowJob throws otherwise). The descriptor
    // lives in the suspension table (single source of truth); attach it here so the view is a VALID
    // C1 WorkflowJob, not a descriptor-less shape that only resembles one. (The token in this
    // admin-gated read is also how a v1 admin obtains it to resume — there is no external emitter.)
    const hasSuspended = rows.some((r) => r.status === 'suspended')
    const suspendByStep = new Map<number, { reason: WorkflowJobSuspendReason; resumeToken: string }>()
    if (hasSuspended) {
      const susps = await db
        .selectFrom('multitable_automation_suspensions')
        .select(['step_index', 'reason', 'resume_token'])
        .where('execution_id', '=', executionId)
        .where('status', '=', 'pending')
        .execute()
      for (const s of susps) {
        suspendByStep.set(Number(s.step_index), {
          reason: s.reason as WorkflowJobSuspendReason,
          resumeToken: s.resume_token as string,
        })
      }
    }

    return rows.map((row) => {
      // Stored status is a C1 value (running on start; resolved/failed via bridge on settle; skipped;
      // suspended via writeSuspendedJob) — normalize (fail-loud on a corrupt status) so the read
      // boundary stays enum-strict.
      const status = normalizeWorkflowJobStatus(row.status)
      const descriptor = status === 'suspended' ? suspendByStep.get(Number(row.step_index)) : undefined
      return {
        id: row.id as string,
        executionId: row.execution_id as string,
        stepKey: row.step_key as string,
        status,
        upstreamJobId: (row.upstream_job_id as string) ?? null,
        result: typeof row.result === 'string' ? JSON.parse(row.result) : (row.result ?? null),
        // error string-or-ABSENT to satisfy the C1 normalizeWorkflowJob contract (never null).
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
        // suspended ⇔ descriptor (C1): attach so the view passes normalizeWorkflowJob.
        ...(descriptor ? { suspend: descriptor } : {}),
      }
    })
  }
}
