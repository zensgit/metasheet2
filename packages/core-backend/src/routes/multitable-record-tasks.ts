/**
 * The tasks dispatched from one multitable record (package 2, the record's 关联任务 panel).
 *
 *   GET /api/multitable/sheets/:sheetId/records/:recordId/tasks   ?limit= (1..100, default 20)
 *       → { ok, data: { items, hasMore } }, each item { id, title, status, completionMode, dueAt,
 *         dueDate, createdBy, createdAt, isMine }. No count and no retry key on any item.
 *   GET …/tasks?dispatchKey=<key>
 *       → the same shape, with only the caller's own dispatch made with that key from this record:
 *         0 or 1 items, `hasMore` false.
 *
 * Mounted only when the task routes mount (the factory returns null otherwise; `index.ts` mounts it
 * beside them). Not on `tasksRouter()`: that router's route population is pinned.
 *
 * GATE ORDER (every step fail-closed, every refusal values-free):
 *   1. `authenticate`, `rbacGuard('tasks', 'read')` as route middleware: the door of every task read.
 *   2. `requireRecordReadable(req, query, sheetId, recordId)`: the record routes' own read gate (the
 *      record exists on this sheet, the sheet is live, the caller may read it). 403 and 404 are answered
 *      with one code each; a 401 passes through.
 *   3. The gated reader is the task actor (the id the task routes use).
 *   4. A `dispatchKey` of another shape is 422 INVALID_DISPATCH_KEY.
 *   5. Org = the token's org claim; none → an empty, degraded answer.
 *   6. The rows: tasks linked to this sheet and record that the caller could open from the task centre
 *      (services/task-records.ts `listRecordTasks`).
 */
import { Router, type Request, type Response } from 'express'

import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { listRecordTasks } from '../services/task-records'
import { isTasksEnabled } from '../tasks/feature-flag'
import { clampRecordTaskListLimit, isDispatchKey } from '../tasks/task-source-links'
import { actorId, orgId } from './tasks-http'
import { requireRecordReadable } from './univer-meta'

const logger = new Logger('MultitableRecordTasks')

/** The record read gate's query function: the task module's own database access, as a plain function. */
const recordQuery: Parameters<typeof requireRecordReadable>[1] = (sql, params) => query(sql, params)

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ ok: false, error: { code, message } })
}

/**
 * The record read gate's refusal, without widening it: 403 → PERMISSION_DENIED, 404 (record absent, not
 * on this sheet, sheet deleted) → RECORD_NOT_FOUND, anything else (401) passes through byte-for-byte.
 */
function refuseFromReadGate(res: Response, refusal: { status: number; body: unknown }): Response {
  if (refusal.status === 403) {
    return fail(res, 403, 'PERMISSION_DENIED', 'Insufficient permissions')
  }
  if (refusal.status === 404) {
    return fail(res, 404, 'RECORD_NOT_FOUND', 'Record not found')
  }
  return res.status(refusal.status).json(refusal.body)
}

export function createMultitableRecordTaskRoutes(): Router | null {
  if (!isTasksEnabled()) return null
  const router = Router()

  router.get('/sheets/:sheetId/records/:recordId/tasks', authenticate, rbacGuard('tasks', 'read'), async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return fail(res, 400, 'VALIDATION_ERROR', 'sheetId and recordId are required')
    }
    const limit = clampRecordTaskListLimit(req.query.limit)

    try {
      const gate = await requireRecordReadable(req, recordQuery, sheetId, recordId)
      if ('status' in gate) return refuseFromReadGate(res, gate)
      // The reader the gate passed is the actor whose tasks are listed.
      const viewer = actorId(req)
      if (gate.access.userId !== viewer) {
        return fail(res, 403, 'PERMISSION_DENIED', 'Insufficient permissions')
      }

      // A repeated or nested `dispatchKey` is not a string and is refused like any other shape.
      const rawKey: unknown = req.query.dispatchKey
      let dispatchKey: string | null = null
      if (rawKey !== undefined) {
        if (!isDispatchKey(rawKey)) {
          return fail(res, 422, 'INVALID_DISPATCH_KEY', 'Invalid dispatch key')
        }
        dispatchKey = rawKey
      }

      const org = orgId(req)
      if (!org) {
        return res.json({ ok: true, data: { items: [], hasMore: false, degraded: true, reason: 'org_missing' } })
      }

      const page = await listRecordTasks({ orgId: org, actorId: viewer, sheetId, recordId, limit, dispatchKey })
      return res.json({ ok: true, data: { items: page.items, hasMore: page.hasMore } })
    } catch (error) {
      // Never echo driver text: log the class only.
      logger.error(
        `[multitable.record.tasks.list] failed sheet=${sheetId} record=${recordId}`,
        error instanceof Error ? new Error(error.name) : undefined,
      )
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list record tasks')
    }
  })

  return router
}
