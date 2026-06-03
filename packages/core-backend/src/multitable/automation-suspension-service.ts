/**
 * Automation Suspension Service — A6-2 suspend/resume (admin-gated v1).
 *
 * Owns the `multitable_automation_suspensions` row: the resume capability (single-use
 * `resume_token`) + the inputs an admin resume re-derives from. It does NOT run actions
 * or settle executions — `AutomationService.resumeExecution` orchestrates that (mirrors
 * `retryExecution`); this service is the persistence + token-claim plane.
 *
 * Invariants:
 * - the suspended state is OUT-OF-BAND (design D2): the legacy execution stays `running`;
 *   the C1 `multitable_automation_jobs` wait row carries `status='suspended'` (written here
 *   via the job service). This table never stores the suspended status on an execution.
 * - the stored `trigger_event` is A1-redacted (same `redactValue` as the execution/job planes) —
 *   never persist unredacted record data (D4); resume re-fetches the live record instead.
 * - `claim()` is the single-use guard (D8): a transactional pending→resumed flip; a second
 *   resume (or a concurrent one) loses the claim and the route returns 409.
 *
 * See docs/development/multitable-automation-a6-2-suspend-resume-design-20260603.md
 */

import { createHash, randomUUID } from 'crypto'
import { db } from '../db/db'
import { toJsonValue } from '../db/type-helpers'
import { redactValue } from './automation-log-redact'
import { AutomationJobService } from './automation-job-service'
import type { AutomationAction } from './automation-actions'

/** Suspend-time action sequence fingerprint (D4b rule-drift guard) — non-secret (types only). */
export interface ActionFingerprint {
  count: number
  hash: string
}

export interface SuspensionRow {
  id: string
  executionId: string
  ruleId: string
  sheetId: string | null
  recordId: string | null
  stepIndex: number
  resumeToken: string
  reason: string
  actionFingerprint: ActionFingerprint
  triggerEvent: unknown
  status: string
}

/**
 * Non-secret fingerprint of the suspend-time action sequence. Types only — configs may hold
 * secrets, and the type list + count is enough to detect a re-sequence (D4b). On resume a
 * mismatch fails closed `409 rule_changed` (step_index is only meaningful against this array).
 */
export function computeActionFingerprint(actions: ReadonlyArray<{ type: string }>): ActionFingerprint {
  const hash = createHash('sha256').update(actions.map((a) => a.type).join('|')).digest('hex')
  return { count: actions.length, hash }
}

export class AutomationSuspensionService {
  constructor(private readonly jobService: AutomationJobService) {}

  /**
   * Suspend: persist the suspension row (capability + re-derive inputs) + the `suspended`
   * C1 job row (out-of-band state, D2). Called from the executor's onSuspend hook. Returns
   * the resume token (v1 has no emitter, so nothing external receives it yet).
   */
  async create(input: {
    executionId: string
    rule: { id: string; sheetId?: string; actions: ReadonlyArray<AutomationAction> }
    recordId: string
    triggerEvent: unknown
    stepIndex: number
    action: AutomationAction
  }): Promise<string> {
    const resumeToken = randomUUID()
    const fingerprint = computeActionFingerprint(input.rule.actions)
    // B2: the suspension row (resume capability + re-derive inputs) and the out-of-band
    // `suspended` C1 job row MUST be atomic — a half-written suspend (pending suspension with no
    // suspended job, or vice versa) is a dangling state a later resume token could observe. One
    // transaction → both commit or neither; on failure the executor's onSuspend throws → the
    // execution fails closed with nothing half-persisted.
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('multitable_automation_suspensions')
        .values({
          id: `asp_${randomUUID()}`,
          execution_id: input.executionId,
          rule_id: input.rule.id,
          sheet_id: input.rule.sheetId ?? null,
          record_id: input.recordId || null,
          step_index: input.stepIndex,
          resume_token: resumeToken,
          reason: 'external_event',
          action_fingerprint: toJsonValue(fingerprint) as never,
          // A1-redacted trigger event (D4 — no unredacted recordData persisted).
          trigger_event: input.triggerEvent == null ? null : (toJsonValue(redactValue(input.triggerEvent)) as never),
          status: 'pending',
        })
        .execute()
      // Out-of-band suspended state (D2): the wait step's C1 job row, SAME transaction.
      await this.jobService.writeSuspendedJob(
        input.executionId,
        { id: input.rule.id, sheetId: input.rule.sheetId },
        input.stepIndex,
        input.action,
        trx,
      )
    })
    return resumeToken
  }

  /** Look up a suspension by its resume token (null if unknown → route 404). */
  async findByToken(resumeToken: string): Promise<SuspensionRow | null> {
    const row = await db
      .selectFrom('multitable_automation_suspensions')
      .selectAll()
      .where('resume_token', '=', resumeToken)
      .executeTakeFirst()
    return row ? this.mapRow(row) : null
  }

  /**
   * Single-use claim (D8): transactionally flip pending→resumed, only if still pending.
   * Returns true iff THIS call won the claim. `RETURNING id` → a row means we claimed it;
   * undefined means it was already resumed/cancelled or a concurrent resume won the race.
   */
  async claim(resumeToken: string): Promise<boolean> {
    const claimed = await db
      .updateTable('multitable_automation_suspensions')
      .set({ status: 'resumed', resumed_at: new Date().toISOString() })
      .where('resume_token', '=', resumeToken)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst()
    return claimed != null
  }

  private mapRow(row: Record<string, unknown>): SuspensionRow {
    const fpRaw = typeof row.action_fingerprint === 'string'
      ? JSON.parse(row.action_fingerprint)
      : (row.action_fingerprint ?? {})
    const fp = (fpRaw && typeof fpRaw === 'object' ? fpRaw : {}) as Record<string, unknown>
    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      ruleId: row.rule_id as string,
      sheetId: (row.sheet_id as string) ?? null,
      recordId: (row.record_id as string) ?? null,
      stepIndex: Number(row.step_index),
      resumeToken: row.resume_token as string,
      reason: row.reason as string,
      actionFingerprint: { count: Number(fp.count ?? 0), hash: String(fp.hash ?? '') },
      triggerEvent: typeof row.trigger_event === 'string' ? JSON.parse(row.trigger_event) : (row.trigger_event ?? null),
      status: row.status as string,
    }
  }
}
