/**
 * Approvals Router
 *
 * Keeps legacy platform approval endpoints stable while exposing the new
 * phase 1 unified approval bridge for PLM-backed approvals.
 */

import type { Injector } from '@wendellhu/redi'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { Logger } from '../core/logger'
import { IPLMAdapter } from '../di/identifiers'
import { pool } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { REFUND_WORKFLOW_KEY, type AfterSalesApprovalBridgeService } from '../services/AfterSalesApprovalBridgeService'
import { ApprovalBridgeService, ServiceError } from '../services/ApprovalBridgeService'
import {
  APPROVAL_ERROR_CODES,
  type ApprovalBridgePlmAdapter,
} from '../services/approval-bridge-types'
import { isDatabaseSchemaError } from '../utils/database-errors'

const logger = new Logger('ApprovalsRouter')
const MAX_APPROVAL_PAGE_SIZE = 200

let approvalsDegraded = false
const allowDegradation = process.env.APPROVALS_OPTIONAL === '1'

interface ApprovalInstance {
  id: string
  status: string
  version: number
  source_system?: string | null
  created_at: Date
  updated_at: Date
}

interface ApprovalRouterOptions {
  injector?: Injector
  plmAdapter?: ApprovalBridgePlmAdapter | null
  afterSalesApprovalBridgeService?: AfterSalesApprovalBridgeService
}

function isPlmApprovalId(id: string): boolean {
  return id.startsWith('plm:')
}

function parsePaging(value: unknown, fallback: number, max: number = MAX_APPROVAL_PAGE_SIZE): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(parsed, max)
}

function normalizeApprovalVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return null
}

function normalizeApprovalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function resolveApprovalActorId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? req.user?.sub
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

function resolveApprovalActorName(req: Request, fallbackId: string): string {
  const candidate = req.user?.name ?? req.user?.email ?? fallbackId
  if (typeof candidate !== 'string') return fallbackId
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : fallbackId
}

function approvalVersionConflictResponse(currentVersion: number) {
  return {
    ok: false,
    error: {
      code: 'APPROVAL_VERSION_CONFLICT',
      message: 'Approval instance version mismatch',
      currentVersion,
    },
  }
}

function approvalErrorResponse(code: string, message: string) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  }
}

function sendServiceError(res: Response, error: ServiceError): void {
  res.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  })
}

function resolvePlmAdapter(options?: ApprovalRouterOptions): ApprovalBridgePlmAdapter | null {
  if (options?.plmAdapter) {
    return options.plmAdapter
  }
  if (!options?.injector) {
    return null
  }
  return options.injector.get(IPLMAdapter) as unknown as ApprovalBridgePlmAdapter
}

function getBridgeService(options?: ApprovalRouterOptions): ApprovalBridgeService {
  return new ApprovalBridgeService(resolvePlmAdapter(options))
}

function handleApprovalsError(
  res: Response,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  degradedResponse?: () => void,
): void {
  if (error instanceof ServiceError) {
    sendServiceError(res, error)
    return
  }
  if (isDatabaseSchemaError(error) && allowDegradation && degradedResponse) {
    if (!approvalsDegraded) {
      logger.warn('Approvals service degraded - tables not found')
      approvalsDegraded = true
    }
    degradedResponse()
    return
  }

  logger.error(fallbackMessage, error instanceof Error ? error : undefined)
  res.status(500).json(approvalErrorResponse(fallbackCode, fallbackMessage))
}

export function approvalsRouter(options?: ApprovalRouterOptions): Router {
  const r = Router()

  r.get('/api/approvals', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(
          approvalErrorResponse('APPROVALS_DATABASE_UNAVAILABLE', 'Database not available'),
        )
      }

      const sourceSystem = typeof req.query.sourceSystem === 'string' ? req.query.sourceSystem : undefined
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const workflowKey = typeof req.query.workflowKey === 'string' ? req.query.workflowKey : undefined
      const businessKey = typeof req.query.businessKey === 'string' ? req.query.businessKey : undefined
      const assignee = typeof req.query.assignee === 'string' ? req.query.assignee : undefined
      const limit = parsePaging(req.query.limit, 50)
      const offset = parsePaging(req.query.offset, 0, Number.MAX_SAFE_INTEGER)

      if (sourceSystem === 'plm' && assignee) {
        return res.status(400).json({
          error: {
            code: APPROVAL_ERROR_CODES.ASSIGNEE_FILTER_UNSUPPORTED,
            message: 'PLM assignee filtering is not supported in phase 1',
          },
        })
      }

      const bridgeService = getBridgeService(options)
      if (sourceSystem === 'plm' && !bridgeService.hasPlmAdapter()) {
        return res.status(503).json(
          approvalErrorResponse('PLM_APPROVAL_BRIDGE_UNAVAILABLE', 'PLM approval bridge is not configured'),
        )
      }

      if (sourceSystem === 'plm') {
        await bridgeService.syncPlmApprovals({
          status,
          limit,
          offset,
        })
      }

      const result = await bridgeService.listApprovals({
        sourceSystem,
        status,
        workflowKey,
        businessKey,
        assignee,
        limit,
        offset,
      })

      res.json({
        data: result.data,
        total: result.total,
        limit,
        offset,
      })
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_LIST_FAILED',
        'Failed to list approvals',
        () => res.json({ data: [], total: 0, degraded: true }),
      )
    }
  })

  r.post('/api/approvals/sync/plm', authenticate, async (req: Request, res: Response) => {
    try {
      const bridgeService = getBridgeService(options)
      if (!bridgeService.hasPlmAdapter()) {
        return res.status(503).json(
          approvalErrorResponse('PLM_APPROVAL_BRIDGE_UNAVAILABLE', 'PLM approval bridge is not configured'),
        )
      }

      const result = await bridgeService.syncPlmApprovals({
        status: typeof req.body?.status === 'string' ? req.body.status : undefined,
        productId: typeof req.body?.productId === 'string' ? req.body.productId : undefined,
        requesterId: typeof req.body?.requesterId === 'string' ? req.body.requesterId : undefined,
        limit: parsePaging(req.body?.limit, 50),
        offset: parsePaging(req.body?.offset, 0, Number.MAX_SAFE_INTEGER),
      })

      res.json({
        success: true,
        synced: result.synced,
        errors: result.errors,
      })
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'PLM_APPROVAL_SYNC_FAILED',
        'Failed to sync PLM approvals',
      )
    }
  })

  // Legacy endpoint: keep scoped to platform-owned approvals only.
  r.get('/api/approvals/pending', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(
          approvalErrorResponse('APPROVALS_DATABASE_UNAVAILABLE', 'Database not available'),
        )
      }

      const userId = resolveApprovalActorId(req)
      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }

      const limit = parsePaging(req.query.limit, 50)
      const offset = parsePaging(req.query.offset, 0, Number.MAX_SAFE_INTEGER)

      const result = await pool.query<ApprovalInstance>(
        `SELECT ai.* FROM approval_instances ai
         WHERE ai.status = 'pending'
           AND COALESCE(ai.source_system, 'platform') = 'platform'
         ORDER BY ai.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      )

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM approval_instances
         WHERE status = 'pending'
           AND COALESCE(source_system, 'platform') = 'platform'`,
      )

      res.json({
        data: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
        limit,
        offset,
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ data: [], total: 0, degraded: true })
      }
      logger.error('Failed to get pending approvals', error instanceof Error ? error : undefined)
      res.status(500).json(
        approvalErrorResponse(
          'APPROVAL_PENDING_LIST_FAILED',
          'Failed to get pending approvals',
        ),
      )
    }
  })

  r.post('/api/approvals/:id/actions', authenticate, async (req: Request, res: Response) => {
    try {
      const bridgeService = getBridgeService(options)

      const userId = resolveApprovalActorId(req)
      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }

      const action = req.body?.action
      if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'action must be approve or reject',
          },
        })
      }

      const comment = typeof req.body?.comment === 'string' ? req.body.comment : undefined
      const actor = {
        userId,
        userName: resolveApprovalActorName(req, userId),
        ip: req.ip || null,
        userAgent: req.get('user-agent') || null,
      }

      let approval = null
      const afterSalesBridge = options?.afterSalesApprovalBridgeService
      if (afterSalesBridge) {
        const existingAfterSales = await afterSalesBridge.getRefundApproval({
          approvalId: req.params.id,
        })
        if (
          existingAfterSales &&
          existingAfterSales.sourceSystem === 'after-sales' &&
          existingAfterSales.workflowKey === REFUND_WORKFLOW_KEY
        ) {
          const result = await afterSalesBridge.submitRefundApprovalDecision({
            approvalId: req.params.id,
            action,
            actorId: actor.userId,
            actorName: actor.userName,
            comment,
            ip: actor.ip,
            userAgent: actor.userAgent,
          })
          approval = result.approval
        }
      }

      if (!approval) {
        approval = await bridgeService.dispatchAction(
          req.params.id,
          {
            action,
            comment,
          },
          actor,
        )
      }

      res.json(approval)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_ACTION_DISPATCH_FAILED',
        'Failed to dispatch approval action',
      )
    }
  })

  // Legacy endpoint: local platform approvals only.
  r.post('/api/approvals/:id/approve', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(
          approvalErrorResponse('APPROVALS_DATABASE_UNAVAILABLE', 'Database not available'),
        )
      }

      const { id } = req.params
      const requestedVersion = normalizeApprovalVersion(req.body?.version)
      const comment = normalizeApprovalText(req.body?.comment)
      const metadata =
        req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}
      const userId = resolveApprovalActorId(req)

      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }
      const userName = resolveApprovalActorName(req, userId)

      if (requestedVersion === null) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'APPROVAL_VERSION_REQUIRED',
            message: 'Approval version is required',
          },
        })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const instanceResult = await client.query<ApprovalInstance>(
          `SELECT * FROM approval_instances
           WHERE id = $1 AND COALESCE(source_system, 'platform') = 'platform'
           FOR UPDATE`,
          [id],
        )

        if (instanceResult.rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json(
            approvalErrorResponse('APPROVAL_NOT_FOUND', 'Approval instance not found'),
          )
        }

        const instance = instanceResult.rows[0]
        if (instance.version !== requestedVersion) {
          await client.query('ROLLBACK')
          return res.status(409).json(approvalVersionConflictResponse(instance.version))
        }

        if (instance.status !== 'pending') {
          await client.query('ROLLBACK')
          return res.status(400).json(
            approvalErrorResponse(
              'APPROVAL_STATUS_INVALID',
              `Cannot approve: current status is ${instance.status}`,
            ),
          )
        }

        const newVersion = instance.version + 1

        await client.query(
          `UPDATE approval_instances
           SET status = 'approved', version = $1, updated_at = now()
           WHERE id = $2`,
          [newVersion, id],
        )

        await client.query(
          `INSERT INTO approval_records
           (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
           VALUES ($1, 'approve', $2, $3, $4, $5, 'approved', $6, $7, $8, $9, $10)`,
          [
            id,
            userId,
            userName,
            comment || null,
            instance.status,
            instance.version,
            newVersion,
            JSON.stringify(metadata),
            req.ip || null,
            req.get('user-agent') || null,
          ],
        )

        await client.query('COMMIT')

        logger.info(`Approval ${id} approved by ${userId}`)
        res.json({
          ok: true,
          data: {
            id,
            status: 'approved',
            version: newVersion,
            prevVersion: instance.version,
          },
        })
      } catch (innerError) {
        await client.query('ROLLBACK')
        throw innerError
      } finally {
        client.release()
      }
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ success: true, id: req.params.id, degraded: true })
      }
      logger.error('Failed to approve request', error instanceof Error ? error : undefined)
      res.status(500).json(
        approvalErrorResponse('APPROVAL_APPROVE_FAILED', 'Failed to approve request'),
      )
    }
  })

  // Legacy endpoint: local platform approvals only.
  r.post('/api/approvals/:id/reject', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(
          approvalErrorResponse('APPROVALS_DATABASE_UNAVAILABLE', 'Database not available'),
        )
      }

      const { id } = req.params
      const requestedVersion = normalizeApprovalVersion(req.body?.version)
      const comment = normalizeApprovalText(req.body?.comment)
      const reason = normalizeApprovalText(req.body?.reason) ?? comment
      const metadata =
        req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}
      const userId = resolveApprovalActorId(req)

      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }
      const userName = resolveApprovalActorName(req, userId)

      if (requestedVersion === null) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'APPROVAL_VERSION_REQUIRED',
            message: 'Approval version is required',
          },
        })
      }

      if (!reason) {
        return res.status(400).json(
          approvalErrorResponse('APPROVAL_REJECTION_REASON_REQUIRED', 'Rejection reason is required'),
        )
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const instanceResult = await client.query<ApprovalInstance>(
          `SELECT * FROM approval_instances
           WHERE id = $1 AND COALESCE(source_system, 'platform') = 'platform'
           FOR UPDATE`,
          [id],
        )

        if (instanceResult.rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json(
            approvalErrorResponse('APPROVAL_NOT_FOUND', 'Approval instance not found'),
          )
        }

        const instance = instanceResult.rows[0]
        if (instance.version !== requestedVersion) {
          await client.query('ROLLBACK')
          return res.status(409).json(approvalVersionConflictResponse(instance.version))
        }

        if (instance.status !== 'pending') {
          await client.query('ROLLBACK')
          return res.status(400).json(
            approvalErrorResponse(
              'APPROVAL_STATUS_INVALID',
              `Cannot reject: current status is ${instance.status}`,
            ),
          )
        }

        const newVersion = instance.version + 1

        await client.query(
          `UPDATE approval_instances
           SET status = 'rejected', version = $1, updated_at = now()
           WHERE id = $2`,
          [newVersion, id],
        )

        await client.query(
          `INSERT INTO approval_records
           (instance_id, action, actor_id, actor_name, reason, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
           VALUES ($1, 'reject', $2, $3, $4, $5, $6, 'rejected', $7, $8, $9, $10, $11)`,
          [
            id,
            userId,
            userName,
            reason,
            comment || null,
            instance.status,
            instance.version,
            newVersion,
            JSON.stringify(metadata),
            req.ip || null,
            req.get('user-agent') || null,
          ],
        )

        await client.query('COMMIT')

        logger.info(`Approval ${id} rejected by ${userId}: ${reason}`)
        res.json({
          ok: true,
          data: {
            id,
            status: 'rejected',
            version: newVersion,
            prevVersion: instance.version,
          },
        })
      } catch (innerError) {
        await client.query('ROLLBACK')
        throw innerError
      } finally {
        client.release()
      }
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ success: true, id: req.params.id, degraded: true })
      }
      logger.error('Failed to reject request', error instanceof Error ? error : undefined)
      res.status(500).json(
        approvalErrorResponse('APPROVAL_REJECT_FAILED', 'Failed to reject request'),
      )
    }
  })

  r.get('/api/approvals/:id', authenticate, async (req: Request, res: Response) => {
    try {
      const bridgeService = getBridgeService(options)
      const approval = await bridgeService.getApproval(req.params.id)
      if (!approval) {
        return res.status(404).json(
          approvalErrorResponse('APPROVAL_NOT_FOUND', 'Approval instance not found'),
        )
      }

      res.json(approval)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_FETCH_FAILED',
        'Failed to get approval',
        () => res.status(404).json({
          ...approvalErrorResponse('APPROVAL_NOT_FOUND', 'Not found'),
          degraded: true,
        }),
      )
    }
  })

  return r
}
