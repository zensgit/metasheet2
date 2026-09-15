/**
 * Multitable RECORD-LEVEL submit-for-approval routes (multitable × approval phase 2, design §4.1).
 *
 *   POST /api/multitable/sheets/:sheetId/records/:recordId/approvals   body { templateId, formData }
 *   GET  /api/multitable/sheets/:sheetId/records/:recordId/approvals
 *
 * No revoke/delete endpoint here on purpose: revocation lives in the approval center (design §4.1).
 *
 * GATE ORDER (every step fail-closed, every refusal values-free):
 *   1. `requireRecordReadable(req, query, sheetId, recordId)` — the shared record READ choke. It bottoms
 *      out at `resolveSheetCapabilities(req, query, sheetId)` (never `req.user.tenantId` / `x-tenant-id`),
 *      proves the record exists ON THIS SHEET, proves the sheet is live, and applies row-level read deny.
 *   2. `capabilities.canSubmitApproval` — the multitable-side door (`multitable:submit-approval`; admins
 *      short-circuit via isAdminRole inside the derivation).
 *   3. template readability via `canReadApprovalTemplateForAutomation` (the EXISTING multitable-side
 *      template gate: needs `approvals:read` AND passes the template's visibility scope) — NOT a direct
 *      read of `/api/approval-templates`. Then the template must be `published`.
 *   4. the requester actor is loaded by `loadAuthorizedApprovalActor` — the SAME loader the automation
 *      start_approval bridge uses, including its `approvals:write` precheck. That precheck is NOT the
 *      authority: `createApproval` re-checks `approvals:write` on the database inside its own
 *      transaction. A 403 from either is surfaced as RECORD_APPROVAL_PERMISSION_DENIED.
 *
 * The write itself is the service's three-step (INSERT 'creating' → createApproval → UPDATE 'pending'),
 * because `createApproval` opens its own connection/transaction and takes a (sheet, record) advisory lock
 * at its tail — so this route holds NO transaction and NO lock across it (design §2.4/§2.5).
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'

import { poolManager } from '../integration/db/connection-pool'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import { canReadApprovalTemplateForAutomation } from '../multitable/automation-approval-template-access'
import { loadAuthorizedApprovalActor } from '../multitable/automation-approval-bridge-service'
import type { QueryFn } from '../multitable/permission-service'
import {
  listRecordApprovalSubmissions,
  RECORD_APPROVAL_ERROR_CODES,
  RECORD_APPROVAL_LIST_DEFAULT_LIMIT,
  RecordApprovalError,
  submitRecordApproval,
  type RecordApprovalSubmissionRow,
} from '../multitable/record-approval-submission-service'
import { ApprovalProductService } from '../services/ApprovalProductService'
import { loadReadableRecordFieldIds, requireRecordReadable } from './univer-meta'

const logger = new Logger('MultitableRecordApprovals')

const submitBodySchema = z.object({
  templateId: z.string().min(1).max(200),
  formData: z.record(z.unknown()).default({}),
})

function fail(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return res.status(status).json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  })
}

/**
 * Normalize the shared read choke's refusal onto this route's coded vocabulary (design §4.4) without
 * widening it: 403 → PERMISSION_DENIED, 404 (record absent / not on this sheet / sheet deleted) →
 * RECORD_NOT_FOUND, anything else (401) passes through byte-for-byte.
 */
function refuseFromReadGate(res: Response, refusal: { status: number; body: unknown }): Response {
  if (refusal.status === 403) {
    return fail(res, 403, RECORD_APPROVAL_ERROR_CODES.permissionDenied, 'Insufficient permissions')
  }
  if (refusal.status === 404) {
    return fail(res, 404, RECORD_APPROVAL_ERROR_CODES.recordNotFound, 'Record not found')
  }
  return res.status(refusal.status).json(refusal.body)
}

function serializeSubmission(row: RecordApprovalSubmissionRow) {
  return {
    id: row.id,
    sheetId: row.sheetId,
    recordId: row.recordId,
    templateId: row.templateId,
    status: row.status,
    outcome: row.outcome,
    approvalInstanceId: row.approvalInstanceId,
    requestNo: row.approvalRequestNo,
    submittedBy: row.submittedBy,
    recordVersionAtSubmit: row.recordVersionAtSubmit,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  }
}

export interface MultitableRecordApprovalRouteDeps {
  approvalProductService?: Pick<ApprovalProductService, 'createApproval'>
}

export function createMultitableRecordApprovalRoutes(
  deps: MultitableRecordApprovalRouteDeps = {},
): Router {
  const router = Router()
  const approvals = deps.approvalProductService ?? new ApprovalProductService()

  router.post('/sheets/:sheetId/records/:recordId/approvals', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const parsed = submitBodySchema.safeParse(req.body ?? {})
    if (!sheetId || !recordId || !parsed.success) {
      return fail(res, 400, 'VALIDATION_ERROR', 'sheetId, recordId and templateId are required')
    }
    const templateId = parsed.data.templateId.trim()
    if (!templateId) {
      return fail(res, 400, 'VALIDATION_ERROR', 'sheetId, recordId and templateId are required')
    }

    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool) as QueryFn

      // 1) record read gate (existence on THIS sheet + canRead + row-level deny + sheet liveness)
      const readable = await requireRecordReadable(req, query, sheetId, recordId)
      if ('status' in readable) return refuseFromReadGate(res, readable)
      const { access, capabilities } = readable

      // 2) the multitable-side submit door
      if (!capabilities.canSubmitApproval) {
        return fail(res, 403, RECORD_APPROVAL_ERROR_CODES.permissionDenied, 'Insufficient permissions')
      }

      // 3) template readability (existing multitable-side gate) + published
      const templateReadable = await canReadApprovalTemplateForAutomation(query, templateId, access.userId)
      if (!templateReadable) {
        return fail(res, 403, RECORD_APPROVAL_ERROR_CODES.templateForbidden, 'Approval template is not readable')
      }
      const templateRow = await query('SELECT status FROM approval_templates WHERE id = $1', [templateId])
      const templateStatus = (templateRow.rows[0] as { status?: unknown } | undefined)?.status
      if (templateStatus !== 'published') {
        return fail(
          res,
          400,
          RECORD_APPROVAL_ERROR_CODES.templateNotPublished,
          'Approval template is not published',
        )
      }

      // 4) the record's drift anchor + snapshot. Locked records ARE allowed (design §9 item 3: submitting
      //    writes nothing to the record).
      const recordRow = await query(
        'SELECT version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      const record = recordRow.rows[0] as { version?: unknown; data?: unknown } | undefined
      if (!record) {
        return fail(res, 404, RECORD_APPROVAL_ERROR_CODES.recordNotFound, 'Record not found')
      }
      const recordData = typeof record.data === 'string' ? safeParseObject(record.data) : asObject(record.data)

      // 5) the requester actor — the bridge's loader (users row + RBAC codes + roles + approvals:write
      //    precheck). createApproval re-checks approvals:write itself; both refusals map to one code.
      let actor
      try {
        actor = await loadAuthorizedApprovalActor(access.userId)
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode
        if (status === 403 || status === 404 || status === 400) {
          return fail(res, 403, RECORD_APPROVAL_ERROR_CODES.permissionDenied, 'Insufficient permissions')
        }
        throw error
      }

      const submission = await submitRecordApproval(
        query,
        {
          sheetId,
          recordId,
          templateId,
          formData: parsed.data.formData ?? {},
          submittedBy: access.userId,
          recordVersion: Number(record.version ?? 0),
          recordSnapshot: recordData,
        },
        actor,
        {
          // `CreateApprovalActor` is module-private in ApprovalProductService; the bridge's loader returns
          // a structurally identical object (userId + name/email/roles/permissions), so the cast is a
          // visibility workaround, not a shape change.
          createApproval: async (request, createActor) =>
            approvals.createApproval(request as never, createActor as never),
        },
      )

      // Values-free audit: ids only, no form data, no record values.
      await auditLog({
        actorId: access.userId,
        actorType: 'user',
        action: 'multitable.record.approval.submitted',
        resourceType: 'multitable_record_approval_submission',
        resourceId: submission.id,
        meta: {
          sheetId,
          recordId,
          templateId,
          approvalInstanceId: submission.approvalInstanceId,
          status: submission.status,
        },
      })

      return res.status(201).json({ ok: true, data: { submission: serializeSubmission(submission) } })
    } catch (error) {
      if (error instanceof RecordApprovalError) {
        return fail(res, error.statusCode, error.code, error.message, error.details)
      }
      // Never leak driver text (it echoes row values): log the class only.
      logger.error(
        `[multitable.record.approval.submit] failed sheet=${sheetId} record=${recordId}`,
        error instanceof Error ? new Error(error.name) : undefined,
      )
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to submit the record for approval')
    }
  })

  router.get('/sheets/:sheetId/records/:recordId/approvals', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return fail(res, 400, 'VALIDATION_ERROR', 'sheetId and recordId are required')
    }
    const limitRaw = Number(req.query.limit ?? RECORD_APPROVAL_LIST_DEFAULT_LIMIT)

    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool) as QueryFn

      const readable = await requireRecordReadable(req, query, sheetId, recordId)
      if ('status' in readable) return refuseFromReadGate(res, readable)
      const { access, capabilities } = readable

      // The drift response carries FIELD IDS, so it is masked by the record read path's own field mask.
      const readableFieldIds = await loadReadableRecordFieldIds(req, query, sheetId, access.userId, capabilities)

      const submissions = await listRecordApprovalSubmissions(query, {
        sheetId,
        recordId,
        readableFieldIds,
        limit: Number.isFinite(limitRaw) ? limitRaw : RECORD_APPROVAL_LIST_DEFAULT_LIMIT,
      })

      return res.json({
        ok: true,
        data: {
          submissions: submissions.map((row) => ({
            ...serializeSubmission(row),
            drift: row.drift,
          })),
        },
      })
    } catch (error) {
      logger.error(
        `[multitable.record.approval.list] failed sheet=${sheetId} record=${recordId}`,
        error instanceof Error ? new Error(error.name) : undefined,
      )
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list record approvals')
    }
  })

  return router
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(value))
  } catch {
    return {}
  }
}
