/**
 * Multitable BUTTON field run route (B1-a1 → B1-S1 D0-A).
 *
 * POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run
 *
 * Runs a button field's configured action against the current record, mirroring
 * the AI-shortcut-run shape (#2623): preflight gates -> dispatch through the
 * existing automation executor (NO parallel path) -> redacted audit -> settle.
 *
 * Security (design-lock #2645): VISIBILITY != EXECUTABILITY. Seeing a button
 * requires the field to be visible; RUNNING it re-evaluates the action's own
 * gate server-side, as the actor, at dispatch.
 *
 * B1-S1 D0-A enables the FIRST side-effecting action: `send_notification`. It
 * writes a DURABLE in-app notification (Notification Center sink) to recipients
 * that are SERVER-VALIDATED against the sheet member set at dispatch (§3.1, the
 * #1 control). Side-effecting actions REQUIRE a requestId, REQUIRE server-side
 * confirmation when the button declares confirm.enabled, and HARD-REJECT the
 * whole run if ANY configured recipient is not a member.
 *
 * The durable delivery is a ROUTE-LEVEL DEDICATED SIDE-EFFECT TRANSACTION (it does
 * NOT live in the shared AutomationExecutor). All-succeed-or-all-fail in ONE DB
 * transaction, in this order:
 *   server-confirm gate → actor edit gate → recipient hard-reject → dedup
 *     → notification rows → audit row.
 * The no-write validation (confirm / actor / recipient) runs BEFORE the
 * transaction opens, so a rejected run writes NOTHING (no notification, no audit,
 * no dedup marker — the requestId is NOT consumed and a later valid retry with the
 * same requestId still sends once). dedup + notification + audit then commit
 * together; if the audit insert fails, the WHOLE run rolls back (fail-closed — no
 * "sent but unaudited" state). The inert `record_click` stays read-gated,
 * requestId-optional, and OFF this transactional path.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { buildRecordPatchContext, requireRecordReadable } from './univer-meta'
import { type ConnectionPool, type QueryFn } from '../multitable/record-write-service'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import {
  AutomationExecutor,
  AUTOMATION_EXECUTION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationStepResult,
  type ExecutionContext,
} from '../multitable/automation-executor'
import type { AutomationActionType } from '../multitable/automation-actions'
import { AutomationLogService } from '../multitable/automation-log-service'
import { loadSheetMemberUserIdSet } from '../multitable/permission-service'
import { insertRecordSubscriptionNotifications } from '../multitable/record-subscription-service'
import { normalizeJson } from '../multitable/field-codecs'
import { ensureRecordWriteAllowed } from '../multitable/sheet-capabilities'
import { ensureRecordNotLocked } from '../multitable/record-lock'
import { Logger } from '../core/logger'

type PoolLike = ConnectionPool & { query: QueryFn }
const logger = new Logger('MultitableButton')

// B1-S1 D0-A enabled actions. `record_click` = executor-owned INERT (read-gated,
// requestId-optional, NO confirm). `send_notification` = first side-effecting
// action (notify-gated via canSendNotification, durable + deduped + audited in one route transaction).
// Every new action must declare its actor gate AND whether it is side-effecting —
// a single `sideEffecting` flag drives BOTH the requestId requirement (§6 dedup)
// AND the server-side confirm requirement (§4): a side-effecting action whose
// button declares confirm.enabled MUST be confirmed by the server, not just the FE.
type ButtonActorGate = 'read' | 'edit' | 'notify'
interface ButtonActionPolicy {
  /** Actor permission required to RUN this action (server-evaluated at dispatch). */
  gate: ButtonActorGate
  /**
   * Side-effecting actions REQUIRE a requestId (§6 at-most-once) AND, when the
   * button declares confirm.enabled, REQUIRE `confirmed === true` from the server
   * (§4 — the FE confirm dialog is an affordance, the server is the gate). Inert
   * actions are neither.
   */
  sideEffecting: boolean
  /** The executor action dispatched for this button click. */
  dispatchType: AutomationActionType
}

const BUTTON_ACTION_POLICIES: Record<string, ButtonActionPolicy> = {
  record_click: { gate: 'read', sideEffecting: false, dispatchType: 'record_click' },
  send_notification: { gate: 'notify', sideEffecting: true, dispatchType: 'send_notification' },
  // B1-S1 D0-B: first RECORD-MUTATING button action. `edit` gate is the sheet-level
  // pre-filter; the dispatch branch re-gates the SPECIFIC row (write-own + lock) so a
  // button can never mutate a row the clicker could not edit directly (no elevation).
  update_record: { gate: 'edit', sideEffecting: true, dispatchType: 'update_record' },
}

export function createMultitableButtonRoutes(): Router {
  const router = Router()
  const logService = new AutomationLogService()

  router.post('/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const parsed = z
      .object({
        requestId: z.string().min(1).max(100).optional(),
        // §4 server-confirm: a side-effecting button with confirm.enabled requires
        // confirmed===true. FE-only window.confirm is bypassable by a direct POST,
        // so the server is the gate.
        confirmed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {})
    if (!sheetId || !recordId || !fieldId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, recordId, fieldId are required' } })
    }
    const requestId = parsed.data.requestId
    const confirmed = parsed.data.confirmed === true

    try {
      const pool = poolManager.get() as unknown as PoolLike
      const query = pool.query.bind(pool) as QueryFn

      // 1) Actor RECORD-READ gate (also 404s a record not on this sheet, 401 unauth).
      //    This IS the inert record_click's own gate (visibility != executability,
      //    re-evaluated server-side as the actor).
      const readable = await requireRecordReadable(req, query, sheetId, recordId)
      if ('status' in readable) {
        return res.status(readable.status).json(readable.body)
      }
      const { access, capabilities, sheetScope } = readable

      // 2) Load the field + its derived permissions for THIS actor.
      const ctx = await buildRecordPatchContext(req, query, sheetId, access, capabilities)
      if (!ctx) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const field = ctx.fields.find((f) => f.id === fieldId)
      if (!field) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
      }
      if (field.type !== 'button') {
        return res.status(400).json({ ok: false, error: { code: 'NOT_A_BUTTON', message: `Field is not a button: ${fieldId}` } })
      }
      // FIELD-VISIBLE gate: a button the actor cannot see cannot be clicked.
      if (ctx.fieldPermissions[fieldId]?.visible === false) {
        return res.status(403).json({ ok: false, error: { code: 'FIELD_FORBIDDEN', message: `Button field is not visible: ${fieldId}` } })
      }

      const property = normalizeJson(field.property)
      const actionType = typeof property.actionType === 'string' ? property.actionType.trim() : ''
      if (!actionType) {
        return res.status(400).json({ ok: false, error: { code: 'BUTTON_NOT_CONFIGURED', message: 'Button has no actionType configured' } })
      }
      const policy = BUTTON_ACTION_POLICIES[actionType]
      if (!policy) {
        // Real action types are enabled one-by-one (each needs its own gate + policy).
        return res.status(400).json({ ok: false, error: { code: 'BUTTON_ACTION_NOT_ENABLED', message: `Button action not yet enabled: ${actionType}` } })
      }

      // §4 SERVER-CONFIRM GATE (no-write). If the button declares confirm.enabled
      // AND the action is side-effecting, the server REQUIRES confirmed===true.
      // FE-only window.confirm is bypassable by a direct POST, so this is a SERVER
      // behavior: no-confirm → no write (no notification, no audit, no dedup). The
      // FE confirm dialog still runs (it sends confirmed:true), but is not the gate.
      const confirmConfig = normalizeJson(property.confirm)
      const confirmEnabled = confirmConfig.enabled === true
      if (policy.sideEffecting && confirmEnabled && !confirmed) {
        return res.status(400).json({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'This action requires confirmation' } })
      }

      // §3 ACTOR GATE (per-action). record_click = read (already passed above).
      // send_notification = canSendNotification — a DEDICATED sheet-level notify
      // capability (full sheet write/admin, NOT write-own: notify is a fan-out to the
      // sheet's configured members, not a record-scoped action). Replaces the earlier
      // canEditRecord proxy. The 'edit' branch is retained for any future edit-gated action.
      if (policy.gate === 'edit' && !capabilities.canEditRecord) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      if (policy.gate === 'notify' && !capabilities.canSendNotification) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }

      // §6 IDEMPOTENCY: side-effecting actions REQUIRE a requestId.
      if (policy.sideEffecting && !requestId) {
        return res.status(400).json({ ok: false, error: { code: 'REQUEST_ID_REQUIRED', message: 'requestId is required for this action' } })
      }

      const executionId = `axe_btn_${randomUUID()}`

      // ── send_notification dispatch (B1-S1 D0-A) ─────────────────────────────
      // Route-level DEDICATED SIDE-EFFECT TRANSACTION. No-write validation first
      // (recipient hard-reject), then one all-or-nothing DB transaction:
      //   dedup → notification rows → audit row.
      if (actionType === 'send_notification') {
        const actorId = access.userId
        const requestIdValue = requestId as string // §6 requestId already required above.

        const actionConfig = normalizeJson(property.actionConfig)
        const requestedUserIds = Array.from(new Set(
          (Array.isArray(actionConfig.userIds) ? actionConfig.userIds : [])
            .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
            .map((u) => u.trim()),
        ))
        const message = typeof actionConfig.message === 'string' ? actionConfig.message.trim() : ''

        // §3.1 RECIPIENT HARD-REJECT (the #1 control, NO write). config.userIds MUST
        // ALL be sheet members. If ANY configured recipient is not a member, REJECT
        // the entire run (validation-failed) and write NOTHING — no silent partial
        // delivery. Reuses the SAME member set the Person field write-validator uses
        // (single resolver, no drift). This runs BEFORE the transaction so a rejected
        // run never consumes the requestId.
        if (requestedUserIds.length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'NO_RECIPIENTS', message: 'No recipients configured' } })
        }
        if (!message) {
          return res.status(400).json({ ok: false, error: { code: 'MESSAGE_REQUIRED', message: 'Notification message is required' } })
        }
        const memberSet = await loadSheetMemberUserIdSet(query, sheetId)
        const nonMembers = requestedUserIds.filter((u) => !memberSet.has(u))
        if (nonMembers.length > 0) {
          return res.status(400).json({
            ok: false,
            error: { code: 'RECIPIENT_NOT_AUTHORIZED', message: 'One or more recipients are not members of this sheet' },
          })
        }

        // §6 + §4: dedup + notification + audit in ONE transaction (all-or-nothing).
        // The dedup INSERT inside the transaction means a rolled-back run (e.g. a
        // failed audit) does NOT consume the requestId — a later retry still sends.
        // Structured (JSON array) key, NOT a '|'-joined string: requestId is client
        // input and could contain the delimiter, which would risk a false replay.
        const dedupKey = JSON.stringify([actorId, sheetId, recordId, fieldId, requestIdValue])
        const txResult = await pool.transaction<{ deduplicated: boolean; executionId: string }>(async ({ query: txq }) => {
          const dedup = await txq(
            `INSERT INTO multitable_button_run_dedup
               (id, dedup_key, actor_id, sheet_id, record_id, field_id, request_id, execution_id)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [randomUUID(), dedupKey, actorId, sheetId, recordId, fieldId, requestIdValue, executionId],
          )
          if (Number(dedup.rowCount ?? 0) === 0) {
            // Replay: a prior run already COMMITTED this effect. Short-circuit with no
            // second notification and no second audit (single effect, §6). Return the
            // ORIGINAL committed executionId (it maps to the real audit row) — never the
            // fresh id generated this request, which would be untraceable.
            const existing = await txq(
              `SELECT execution_id FROM multitable_button_run_dedup WHERE dedup_key = $1`,
              [dedupKey],
            )
            const originalExecutionId = (existing.rows[0] as { execution_id?: string } | undefined)?.execution_id ?? executionId
            return { deduplicated: true, executionId: originalExecutionId }
          }

          // Durable notification write — the route owns recipient policy (already
          // hard-rejected above); this seam writes exactly the validated recipients.
          await insertRecordSubscriptionNotifications(txq, {
            userIds: requestedUserIds,
            sheetId,
            recordId,
            eventType: 'notification.sent',
            message,
            actorId,
          })

          // §2 HARD DURABLE AUDIT — the redacted triggered_by='button' row is written
          // on the SAME transaction client. If it throws, the whole transaction rolls
          // back (notification + dedup released): fail-closed, no "sent but unaudited".
          const step: AutomationStepResult = {
            actionType: 'send_notification',
            status: 'success',
            output: { notifiedUsers: requestedUserIds.length },
          }
          await writeButtonAudit(logService, txq, {
            executionId, sheetId, fieldId, actorId, requestId: requestIdValue, step,
          })
          return { deduplicated: false, executionId }
        })

        // Post-commit: emit the legacy realtime event so any live in-memory subscriber
        // still fires. Emitted AFTER commit (never inside the tx) so a rolled-back run
        // can never emit a phantom notification. Skipped on a replay (no new effect).
        if (!txResult.deduplicated) {
          eventBus.emit('automation.notification', { userIds: requestedUserIds, message, sheetId, recordId, actorId })
        }

        logger.info('[multitable.button.run]', {
          executionId, sheetId, recordId, fieldId, actionType,
          actorId, status: 'success', requestId: requestIdValue,
          recipients: requestedUserIds.length, deduplicated: txResult.deduplicated,
        })
        return res.json({ ok: true, data: { status: 'succeeded', executionId: txResult.executionId, ...(txResult.deduplicated ? { deduplicated: true } : {}) } })
      }

      // ── update_record dispatch (B1-S1 D0-B) ─────────────────────────────────
      // First RECORD-MUTATING button action. NO ELEVATION: the click performs the
      // update as the CLICKING ACTOR through the SAME per-row gates a normal edit
      // uses, so a button can never mutate a row the clicker could not edit directly.
      if (actionType === 'update_record') {
        const actorId = access.userId
        const requestIdValue = requestId as string // §6 requestId already required (side-effecting).

        // §3.1 PER-ROW WRITE GATE (no-elevation). The sheet-level `edit` policy gate
        // (canEditRecord) above is NOT sufficient — under write-own it is true for
        // EVERY row. Re-gate THIS record by created_by (write-own honored) + the lock
        // guard, identically to the normal record-edit path. Either failure → 403,
        // no write, no dedup consumed.
        const recRes = await query(
          'SELECT created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        if (recRes.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
        }
        const recRow = recRes.rows[0] as { created_by?: string | null; locked?: boolean | null; locked_by?: string | null }
        const createdBy = typeof recRow.created_by === 'string' ? recRow.created_by : null
        if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'edit')) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions to edit this record' } })
        }
        try {
          ensureRecordNotLocked(actorId, { locked: recRow.locked === true, locked_by: recRow.locked_by ?? null }, () => new Error('locked'))
        } catch {
          return res.status(403).json({ ok: false, error: { code: 'RECORD_LOCKED', message: 'Record is locked' } })
        }

        // §3.2 CONFIG: same-base update of THE CLICKED record (fields only — a button
        // does NOT do cross-base targeting). Empty → nothing to write.
        const actionConfig = normalizeJson(property.actionConfig)
        const fields = (actionConfig.fields && typeof actionConfig.fields === 'object' && !Array.isArray(actionConfig.fields))
          ? (actionConfig.fields as Record<string, unknown>)
          : null
        if (!fields || Object.keys(fields).length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'NO_FIELDS', message: 'Button update_record has no fields configured' } })
        }

        // §6 + §2: dedup → executor write (SAME tx client) → audit, all-or-nothing.
        // Mirrors the send_notification transaction; the executor performs the real
        // versioned write via the SAME path automations use (no parallel write path).
        const dedupKey = JSON.stringify([actorId, sheetId, recordId, fieldId, requestIdValue])
        const context: ExecutionContext = {
          executionId, ruleId: `btn_${fieldId}`, sheetId, recordId,
          recordData: {}, ruleCreatedBy: '', actorId,
          triggerEvent: { _trigger: 'button', fieldId, requestId: requestIdValue },
        }
        const txResult = await pool.transaction<{ deduplicated: boolean; executionId: string }>(async ({ query: txq }) => {
          const dedup = await txq(
            `INSERT INTO multitable_button_run_dedup
               (id, dedup_key, actor_id, sheet_id, record_id, field_id, request_id, execution_id)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [randomUUID(), dedupKey, actorId, sheetId, recordId, fieldId, requestIdValue, executionId],
          )
          if (Number(dedup.rowCount ?? 0) === 0) {
            const existing = await txq(`SELECT execution_id FROM multitable_button_run_dedup WHERE dedup_key = $1`, [dedupKey])
            const originalExecutionId = (existing.rows[0] as { execution_id?: string } | undefined)?.execution_id ?? executionId
            return { deduplicated: true, executionId: originalExecutionId }
          }
          // Same-base update of the clicked record (fields only). The executor write
          // runs on the tx client, so a failed audit rolls the write back (fail-closed).
          const executor = new AutomationExecutor({ eventBus, queryFn: txq })
          const step = await executor.runSingleAction({ type: 'update_record', config: { fields } }, context)
          if (step.status !== 'success') {
            // Roll back the dedup + any partial write so a transient failure is retryable.
            throw new Error(step.error ?? 'update_record failed')
          }
          await writeButtonAudit(logService, txq, { executionId, sheetId, fieldId, actorId, requestId: requestIdValue, step })
          return { deduplicated: false, executionId }
        })

        logger.info('[multitable.button.run]', {
          executionId, sheetId, recordId, fieldId, actionType,
          actorId, status: 'success', requestId: requestIdValue, deduplicated: txResult.deduplicated,
        })
        return res.json({ ok: true, data: { status: 'succeeded', executionId: txResult.executionId, ...(txResult.deduplicated ? { deduplicated: true } : {}) } })
      }

      // ── record_click dispatch (inert) ───────────────────────────────────────
      const context: ExecutionContext = {
        executionId,
        ruleId: `btn_${fieldId}`,
        sheetId,
        recordId,
        recordData: {},
        ruleCreatedBy: '',
        actorId: access.userId,
        triggerEvent: { _trigger: 'button', fieldId, requestId },
      }
      const executor = new AutomationExecutor({ eventBus, queryFn: query })
      const step = await executor.runSingleAction(
        { type: policy.dispatchType, config: normalizeJson(property.actionConfig) },
        context,
      )

      // record_click is INERT: logger-only, NO durable automation-execution row
      // (design-lock §7/§9, AUDIT-1). Durable audit rows are EXCLUSIVE to
      // side-effecting actions (the in-transaction audit on the send_notification
      // path above). Keeping an inert action out of multitable_automation_executions
      // also keeps the DF-N1 rule-monitoring surface clean.
      logger.info('[multitable.button.run]', {
        executionId, sheetId, recordId, fieldId, actionType,
        actorId: access.userId, status: step.status, requestId,
      })

      if (step.status === 'success') {
        return res.json({ ok: true, data: { status: 'succeeded', executionId } })
      }
      return res.status(200).json({ ok: false, data: { status: 'failed', executionId, message: step.error ?? 'action failed' } })
    } catch (err) {
      // Fail-closed: never leak internals; never 500-swallow into a fake success.
      console.error('[multitable-button] run failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'button run failed' } })
    }
  })

  return router
}

interface ButtonAuditInput {
  executionId: string
  sheetId: string
  fieldId: string
  actorId: string
  requestId?: string
  step: AutomationStepResult
}

function buildButtonExecution(input: ButtonAuditInput): AutomationExecution {
  const now = new Date().toISOString()
  return {
    id: input.executionId,
    ruleId: `btn_${input.fieldId}`,
    triggeredBy: 'button',
    triggeredAt: now,
    status: input.step.status === 'success' ? 'success' : input.step.status === 'skipped' ? 'skipped' : 'failed',
    steps: [input.step],
    sheetId: input.sheetId,
    initiatedBy: input.actorId,
    // requestId is a plain identifier (the §6 idempotency key), kept in the
    // redacted trigger_event so a run is traceable to its dedup marker.
    triggerEvent: input.requestId ? { _trigger: 'button', fieldId: input.fieldId, requestId: input.requestId } : { _trigger: 'button', fieldId: input.fieldId },
    finishedAt: now,
    schemaVersion: AUTOMATION_EXECUTION_SCHEMA_VERSION,
  }
}

/**
 * §2 HARD DURABLE AUDIT — write a redacted multitable_automation_executions row
 * with triggered_by='button' (EXPLICIT; never the executor's 'event' default) ON
 * THE CALLER'S query client. For send_notification this is the SAME transaction
 * client as the dedup + notification writes, so audit is a HARD precondition: if
 * this insert fails it THROWS, the transaction rolls back, and the run fails
 * fail-closed (no "sent but unaudited" state). The action config is NEVER
 * persisted (only ids + actionType + status ride into the step), and the row is
 * redacted via the SAME path record() uses (recordWithQuery delegates the value
 * builder), so no secret-shaped value leaks. Button rows are EXCLUDED from the
 * rule-monitoring reads (listExecutions/getRecent) but stay retrievable by getById.
 */
async function writeButtonAudit(
  logService: AutomationLogService,
  query: QueryFn,
  input: ButtonAuditInput,
): Promise<void> {
  await logService.recordWithQuery(query, buildButtonExecution(input))
}
