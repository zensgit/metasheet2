/**
 * Multitable BUTTON field run route (B1-a1).
 *
 * POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run
 *
 * Runs a button field's configured action against the current record, mirroring
 * the AI-shortcut-run shape (#2623): preflight gates -> dispatch through the
 * existing automation executor (NO parallel path) -> redacted audit -> settle.
 *
 * Security (design-lock #2645): VISIBILITY != EXECUTABILITY. Seeing a button
 * requires the field to be visible; RUNNING it re-evaluates the action's own
 * gate server-side, as the actor, at dispatch. B1-a1 enables ONLY the
 * executor-owned INERT `record_click` action (gate = record-readable); real
 * actions (update_record / send_webhook / ...) are gated follow-ups, each of
 * which must add its own per-action actor gate before being enabled here.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { buildRecordPatchContext, requireRecordReadable } from './univer-meta'
import { type ConnectionPool, type QueryFn } from '../multitable/record-write-service'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import { AutomationExecutor, type ExecutionContext } from '../multitable/automation-executor'
import { normalizeJson } from '../multitable/field-codecs'
import { Logger } from '../core/logger'

type PoolLike = ConnectionPool & { query: QueryFn }
const logger = new Logger('MultitableButton')

// B1-a1 enables ONLY the executor-owned INERT action from a button click. Real
// actions are gated follow-ups: each needs its own actor-permission mapping at
// dispatch (e.g. update_record -> canEditRecord) before it can be enabled here.
const ENABLED_BUTTON_ACTIONS = new Set<string>(['record_click'])

export function createMultitableButtonRoutes(): Router {
  const router = Router()

  router.post('/sheets/:sheetId/records/:recordId/fields/:fieldId/button/run', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const parsed = z.object({ requestId: z.string().min(1).max(100).optional() }).safeParse(req.body ?? {})
    if (!sheetId || !recordId || !fieldId || !parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, recordId, fieldId are required' } })
    }
    const requestId = parsed.data.requestId

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
      const { access, capabilities } = readable

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
      if (!ENABLED_BUTTON_ACTIONS.has(actionType)) {
        // Real action types are not yet enabled from a button (B1-a1 ships the inert action only).
        return res.status(400).json({ ok: false, error: { code: 'BUTTON_ACTION_NOT_ENABLED', message: `Button action not yet enabled: ${actionType}` } })
      }

      // 3) Dispatch through the SAME executor path as a rule trigger (no parallel path).
      const executionId = `axe_btn_${randomUUID()}`
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
        { type: 'record_click', config: normalizeJson(property.actionConfig) },
        context,
      )

      // 4) Audit — redacted by construction: only ids + actionType + status are
      //    logged (never the action config values), so no secret-shaped value leaks.
      logger.info('[multitable.button.run]', {
        executionId, sheetId, recordId, fieldId, actionType,
        actorId: access.userId, status: step.status, requestId,
      })

      // 5) Settle. Errors are NOT swallowed: a failed step surfaces with its message.
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
