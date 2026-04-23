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
import { rbacGuard } from '../rbac/rbac'
import { REFUND_WORKFLOW_KEY, type AfterSalesApprovalBridgeService } from '../services/AfterSalesApprovalBridgeService'
import { ApprovalBridgeService, ServiceError } from '../services/ApprovalBridgeService'
import { ApprovalProductService, resolveApprovalListPaging } from '../services/ApprovalProductService'
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

function resolveApprovalActorRoles(req: Request): string[] {
  return Array.isArray(req.user?.roles)
    ? req.user!.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    : []
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

function getProductService(): ApprovalProductService {
  return new ApprovalProductService()
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
  const productService = getProductService()

  r.get('/api/approval-templates', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const page = parsePaging(req.query.page, 1, Number.MAX_SAFE_INTEGER)
      const pageSize = parsePaging(req.query.pageSize, 20)
      const { limit, offset } = resolveApprovalListPaging(page, pageSize)
      const result = await productService.listTemplates({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
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
        'APPROVAL_TEMPLATE_LIST_FAILED',
        'Failed to list approval templates',
      )
    }
  })

  r.post('/api/approval-templates', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const template = await productService.createTemplate({
        key: req.body?.key,
        name: req.body?.name,
        description: req.body?.description,
        formSchema: req.body?.formSchema,
        approvalGraph: req.body?.approvalGraph,
      })
      res.status(201).json(template)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_TEMPLATE_CREATE_FAILED',
        'Failed to create approval template',
      )
    }
  })

  r.get('/api/approval-templates/:id', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const template = await productService.getTemplate(req.params.id)
      if (!template) {
        return res.status(404).json(
          approvalErrorResponse('APPROVAL_TEMPLATE_NOT_FOUND', 'Approval template not found'),
        )
      }
      res.json(template)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_TEMPLATE_FETCH_FAILED',
        'Failed to fetch approval template',
      )
    }
  })

  r.patch('/api/approval-templates/:id', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const template = await productService.updateTemplate(req.params.id, {
        key: req.body?.key,
        name: req.body?.name,
        description: req.body?.description,
        formSchema: req.body?.formSchema,
        approvalGraph: req.body?.approvalGraph,
      })
      res.json(template)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_TEMPLATE_UPDATE_FAILED',
        'Failed to update approval template',
      )
    }
  })

  r.post('/api/approval-templates/:id/publish', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const version = await productService.publishTemplate(req.params.id, {
        policy: req.body?.policy,
      })
      res.json(version)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_TEMPLATE_PUBLISH_FAILED',
        'Failed to publish approval template',
      )
    }
  })

  r.get('/api/approval-templates/:id/versions/:versionId', authenticate, rbacGuard('approval-templates:manage'), async (req: Request, res: Response) => {
    try {
      const version = await productService.getTemplateVersion(req.params.id, req.params.versionId)
      if (!version) {
        return res.status(404).json(
          approvalErrorResponse('APPROVAL_TEMPLATE_VERSION_NOT_FOUND', 'Approval template version not found'),
        )
      }
      res.json(version)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_TEMPLATE_VERSION_FETCH_FAILED',
        'Failed to fetch approval template version',
      )
    }
  })

  r.get('/api/approvals', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json(
          approvalErrorResponse('APPROVALS_DATABASE_UNAVAILABLE', 'Database not available'),
        )
      }

      // Wave 2 WP2: `sourceSystem` drives the unified Inbox filter.
      //   - 'all'      → mixed feed across platform + plm (no filter)
      //   - 'platform' → platform-owned approvals only
      //   - 'plm'      → plm-mirrored approvals only
      //   - undefined  → legacy behaviour (tab-driven default to 'platform')
      const rawSourceSystem = typeof req.query.sourceSystem === 'string' ? req.query.sourceSystem.trim() : ''
      if (rawSourceSystem && !['platform', 'plm', 'all'].includes(rawSourceSystem)) {
        return res.status(400).json(
          approvalErrorResponse(
            'APPROVAL_SOURCE_SYSTEM_INVALID',
            "sourceSystem must be one of 'platform', 'plm', or 'all'",
          ),
        )
      }
      const sourceSystem = rawSourceSystem === 'all' || rawSourceSystem === ''
        ? undefined
        : (rawSourceSystem as 'platform' | 'plm')
      const sourceSystemProvided = rawSourceSystem !== ''
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const workflowKey = typeof req.query.workflowKey === 'string' ? req.query.workflowKey : undefined
      const businessKey = typeof req.query.businessKey === 'string' ? req.query.businessKey : undefined
      const assignee = typeof req.query.assignee === 'string' ? req.query.assignee : undefined
      const tab = typeof req.query.tab === 'string' ? req.query.tab as 'pending' | 'mine' | 'cc' | 'completed' : undefined
      const search = typeof req.query.search === 'string' ? req.query.search : undefined
      const page = parsePaging(req.query.page, 1, Number.MAX_SAFE_INTEGER)
      const pageSize = parsePaging(req.query.pageSize, 20)
      const { limit, offset } = req.query.page || req.query.pageSize
        ? resolveApprovalListPaging(page, pageSize)
        : {
            limit: parsePaging(req.query.limit, 50),
            offset: parsePaging(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
          }
      const actorId = resolveApprovalActorId(req)
      const actorRoles = resolveApprovalActorRoles(req)

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

      // Determine the effective filter.
      //   - Explicit 'platform' | 'plm'  → honour it verbatim
      //   - Explicit 'all'               → unified feed (sourceSystem is undefined here)
      //   - Not provided                 → preserve legacy default (tabs imply platform)
      const effectiveSourceSystem = sourceSystemProvided
        ? sourceSystem
        : (tab ? 'platform' : undefined)

      const result = await bridgeService.listApprovals({
        sourceSystem: effectiveSourceSystem,
        status,
        workflowKey,
        businessKey,
        assignee,
        search,
        tab,
        includeExternalTabSources: rawSourceSystem === 'all',
        actorId: actorId || undefined,
        actorRoles,
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

  r.post('/api/approvals/sync/plm', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
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

  r.post('/api/approvals', authenticate, rbacGuard('approvals', 'write'), async (req: Request, res: Response) => {
    try {
      const userId = resolveApprovalActorId(req)
      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }

      const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : ''
      const formData =
        req.body?.formData && typeof req.body.formData === 'object' && !Array.isArray(req.body.formData)
          ? req.body.formData as Record<string, unknown>
          : null

      if (!templateId || !formData) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'templateId and formData are required',
          },
        })
      }

      const approval = await productService.createApproval(
        { templateId, formData },
        {
          userId,
          userName: resolveApprovalActorName(req, userId),
          email: typeof req.user?.email === 'string' ? req.user.email : undefined,
          department: typeof req.user?.department === 'string' ? req.user.department : undefined,
          roles: resolveApprovalActorRoles(req),
          permissions: Array.isArray(req.user?.permissions)
            ? req.user!.permissions.filter((permission): permission is string => typeof permission === 'string')
            : undefined,
        },
      )

      res.status(201).json(approval)
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_CREATE_FAILED',
        'Failed to create approval request',
      )
    }
  })

  // Legacy endpoint: keep scoped to platform-owned approvals only.
  r.get('/api/approvals/pending', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
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

  // Wave 2 WP3 slice 1: count the current user's active pending assignments so
  // the 待办 tab can render a red-badge indicator. Filtered by sourceSystem so
  // the frontend can ask for `all | platform | plm` without fetching the full
  // list. Semantics mirror the LIST pending tab's assignment rule uniformly
  // across source systems (user OR role match on approval_assignments), which
  // diverges from LIST's PLM-specific "status=pending without assignment
  // join" branch on purpose — the task contract explicitly defines this count
  // as `is_active=TRUE assignments for the current user`.
  r.get('/api/approvals/pending-count', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
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

      const rawSourceSystem = typeof req.query.sourceSystem === 'string' ? req.query.sourceSystem.trim() : ''
      if (rawSourceSystem && !['platform', 'plm', 'all'].includes(rawSourceSystem)) {
        return res.status(400).json(
          approvalErrorResponse(
            'APPROVAL_SOURCE_SYSTEM_INVALID',
            "sourceSystem must be one of 'platform', 'plm', or 'all'",
          ),
        )
      }
      const sourceSystem = rawSourceSystem === 'all' || rawSourceSystem === ''
        ? null
        : (rawSourceSystem as 'platform' | 'plm')
      const actorRoles = resolveApprovalActorRoles(req)
      const actorRolesParam = actorRoles.length > 0 ? actorRoles : ['__none__']

      const conditions: string[] = [
        `a.is_active = TRUE`,
        `i.status = 'pending'`,
        `(
          (a.assignment_type = 'user' AND a.assignee_id = $1)
          OR (a.assignment_type = 'role' AND a.assignee_id = ANY($2))
        )`,
      ]
      const params: unknown[] = [userId, actorRolesParam]

      if (sourceSystem) {
        conditions.push(`COALESCE(i.source_system, 'platform') = $${params.length + 1}`)
        params.push(sourceSystem)
      }

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT a.instance_id)::text AS count
         FROM approval_assignments a
         INNER JOIN approval_instances i ON i.id = a.instance_id
         WHERE ${conditions.join(' AND ')}`,
        params,
      )

      res.json({ count: parseInt(countResult.rows[0]?.count || '0', 10) })
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_PENDING_COUNT_FAILED',
        'Failed to compute pending approval count',
        () => res.json({ count: 0, degraded: true }),
      )
    }
  })

  // Wave 2 WP3 slice 1: 催办 (remind / nudge). Records a `remind` row on
  // approval_records so the timeline preserves the nudge event; the task
  // boundary explicitly defers external notification channels (IM/email/push)
  // to Phase 3 Notification Hub. PLM-sourced approvals are recorded locally
  // but not forwarded upstream (bridged=false in the response).
  //
  // Permission model: a dedicated endpoint rather than bolting onto
  // `/actions` so that the requester — who may not hold `approvals:act` —
  // can still nudge. Guarded by `approvals:read`, then the handler refines:
  // requester OR `approvals:act` perm.
  //
  // Rate limit: at most 1 remind per instance per user per hour. Uses
  // `occurred_at > now() - interval '1 hour'` so the clock lives in the DB
  // and stays consistent with the recorded timestamp.
  r.post('/api/approvals/:id/remind', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
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

      const { id } = req.params
      const userName = resolveApprovalActorName(req, userId)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const instanceResult = await client.query<{
          id: string
          status: string
          source_system: string | null
          requester_snapshot: { id?: string | null } | null
        }>(
          `SELECT id, status, source_system, requester_snapshot
           FROM approval_instances
           WHERE id = $1
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
        const requesterId = instance.requester_snapshot?.id ?? null
        const actorPerms = Array.isArray(req.user?.permissions)
          ? req.user!.permissions.filter((p): p is string => typeof p === 'string')
          : []
        const actorPermsFromToken = Array.isArray((req.user as { perms?: unknown })?.perms)
          ? ((req.user as { perms: unknown }).perms as unknown[]).filter((p): p is string => typeof p === 'string')
          : []
        const combinedPerms = [...actorPerms, ...actorPermsFromToken]
        const actorRoles = resolveApprovalActorRoles(req)
        const isAdminUser = actorRoles.includes('admin') || req.user?.role === 'admin'
        const hasActPerm = isAdminUser
          || combinedPerms.includes('*:*')
          || combinedPerms.includes('approvals:*')
          || combinedPerms.includes('approvals:act')
        const isRequester = requesterId != null && requesterId === userId

        if (!isRequester && !hasActPerm) {
          await client.query('ROLLBACK')
          return res.status(403).json(
            approvalErrorResponse(
              'APPROVAL_REMIND_FORBIDDEN',
              'Only the requester or an approver may remind this approval',
            ),
          )
        }

        if (instance.status !== 'pending') {
          await client.query('ROLLBACK')
          return res.status(400).json(
            approvalErrorResponse(
              'APPROVAL_REMIND_STATUS_INVALID',
              `Cannot remind: current status is ${instance.status}`,
            ),
          )
        }

        // 1-hour soft rate limit — a previous remind by the same actor on
        // the same instance within the window returns 429 and never writes
        // a duplicate record.
        const recentResult = await client.query<{ occurred_at: Date }>(
          `SELECT occurred_at FROM approval_records
           WHERE instance_id = $1
             AND action = 'remind'
             AND actor_id = $2
             AND occurred_at > now() - INTERVAL '1 hour'
           ORDER BY occurred_at DESC
           LIMIT 1`,
          [id, userId],
        )

        if (recentResult.rows.length > 0) {
          await client.query('ROLLBACK')
          const lastAt = recentResult.rows[0].occurred_at
          const lastIso = lastAt instanceof Date ? lastAt.toISOString() : String(lastAt)
          return res.status(429).json({
            ok: false,
            error: {
              code: 'APPROVAL_REMIND_THROTTLED',
              message: 'Remind is rate-limited to once per instance per hour',
              lastRemindedAt: lastIso,
              retryAfterSeconds: 3600,
            },
          })
        }

        const bridged = false
        const metadata = {
          remindedBy: userId,
          remindedAt: new Date().toISOString(),
          sourceSystem: instance.source_system ?? 'platform',
          bridged,
        }

        await client.query(
          `INSERT INTO approval_records
           (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
           VALUES ($1, 'remind', $2, $3, NULL, $4, $4, 0, 0, $5, $6, $7)`,
          [
            id,
            userId,
            userName,
            instance.status,
            JSON.stringify(metadata),
            req.ip || null,
            req.get('user-agent') || null,
          ],
        )

        await client.query('COMMIT')

        logger.info(`Approval ${id} reminded by ${userId}`)
        res.json({
          ok: true,
          data: {
            id,
            action: 'remind',
            remindedAt: metadata.remindedAt,
            bridged,
            sourceSystem: metadata.sourceSystem,
          },
        })
      } catch (innerError) {
        await client.query('ROLLBACK')
        throw innerError
      } finally {
        client.release()
      }
    } catch (error) {
      handleApprovalsError(
        res,
        error,
        'APPROVAL_REMIND_FAILED',
        'Failed to remind approval',
      )
    }
  })

  r.post('/api/approvals/:id/actions', authenticate, rbacGuard('approvals', 'act'), async (req: Request, res: Response) => {
    try {
      const bridgeService = getBridgeService(options)

      const userId = resolveApprovalActorId(req)
      if (!userId) {
        return res.status(401).json(
          approvalErrorResponse('APPROVAL_USER_REQUIRED', 'User ID not found in token'),
        )
      }

      const action = req.body?.action
      if (!['approve', 'reject', 'transfer', 'revoke', 'comment', 'return'].includes(String(action))) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'action must be approve, reject, transfer, revoke, comment, or return',
          },
        })
      }

      const comment = typeof req.body?.comment === 'string' ? req.body.comment : undefined
      const targetUserId = typeof req.body?.targetUserId === 'string' ? req.body.targetUserId.trim() : undefined
      const targetNodeKey = typeof req.body?.targetNodeKey === 'string' ? req.body.targetNodeKey.trim() : undefined
      const actor = {
        userId,
        userName: resolveApprovalActorName(req, userId),
        roles: resolveApprovalActorRoles(req),
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
          if (action !== 'approve' && action !== 'reject') {
            return res.status(400).json({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'after-sales approvals only support approve or reject',
              },
            })
          }
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
        const templateRuntimeInstance = isPlmApprovalId(req.params.id)
          ? false
          : await productService.isTemplateRuntimeInstance(req.params.id)
        if (templateRuntimeInstance) {
          approval = await productService.dispatchAction(
            req.params.id,
            {
              action,
              comment,
              targetUserId,
              targetNodeKey,
            },
            actor,
          )
        } else {
          if (action !== 'approve' && action !== 'reject') {
            return res.status(400).json({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'legacy approvals only support approve or reject',
              },
            })
          }
          approval = await bridgeService.dispatchAction(
            req.params.id,
            {
              action,
              comment,
              targetUserId,
            },
            actor,
          )
        }
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
  r.post('/api/approvals/:id/approve', authenticate, rbacGuard('approvals', 'act'), async (req: Request, res: Response) => {
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
  r.post('/api/approvals/:id/reject', authenticate, rbacGuard('approvals', 'act'), async (req: Request, res: Response) => {
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

  r.get('/api/approvals/:id', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
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
