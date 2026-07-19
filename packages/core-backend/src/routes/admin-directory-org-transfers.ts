import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import { ensurePlatformAdmin } from './admin-directory'
import {
  OrgTransferConflictError,
  OrgTransferNotFoundError,
  OrgTransferValidationError,
  applyOrgTransfer,
  cancelOrgTransfer,
  createOrgTransfer,
  dryRunOrgTransfer,
  getOrgTransfer,
  scanOrgTransfer,
} from '../directory/org-transfer-service'
import { jsonError, jsonOk } from '../util/response'

/**
 * Transfer MVP — T1 (routes), API per `provider-org-transfer-development-plan-20260709.md` §6.3:
 * create / read / scan / dry-run apply / apply / cancel. The decisions PATCH endpoint of §6.3 is
 * deliberately NOT here — without a registered adapter scan yields zero bindings only when tests
 * explicitly register the no-op; production scan/apply fail closed with
 * ORG_TRANSFER_ADAPTER_UNAVAILABLE. The decision surface (and its secret-handling rules) lands
 * with the first real adapter (T3/T4).
 *
 * Platform-admin only (`ensurePlatformAdmin`, the single source in admin-directory.ts). Org
 * identity is never read from the request: the service derives `org_id` from the two integration
 * rows, and the schema's composite FKs make cross-org/provider-mismatched rows impossible.
 * Every successful lifecycle mutation writes ONE values-free audit row (ids/status/counters only —
 * no names, no tenant/corp keys, no URLs). Rejected mutations (including adapter-unavailable)
 * write no success audit.
 */

const logger = new Logger('AdminDirectoryOrgTransferRoutes')

const CREATE_FIELDS = ['provider', 'sourceIntegrationId', 'targetIntegrationId'] as const

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuidShaped(value: string): boolean {
  return UUID_SHAPE_RE.test(value)
}

/** Non-UUID :transferId params 400 at the route edge (pre-B4 hardening item 1 precedent). */
function rejectNonUuidParam(res: Response, paramName: string, value: string): boolean {
  if (isUuidShaped(value)) return false
  jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', `${paramName} must be a UUID`)
  return true
}

/**
 * Fail-closed field allowlist (B2 owner hard-requirement pattern): any key outside the
 * endpoint's allowlist — org_id/orgId/corp_id most of all — 400s the whole request rather than
 * being silently dropped.
 */
function rejectUnlistedFields(req: Request, res: Response, allowed: readonly string[]): boolean {
  const body = (req.body ?? {}) as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return false
  jsonError(res, 400, 'ORG_TRANSFER_UNKNOWN_FIELDS', 'Request body contains fields not accepted by this endpoint')
  return true
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

/**
 * Typed-error → HTTP mapping. Thrown messages are developer-authored templates with only
 * server-side tokens interpolated (status words; for adapter-unavailable, the transfer row's
 * stored provider label). No request body / caller-supplied free text is echoed, so surfacing
 * them stays values-free relative to operator input and directory payload content.
 */
function handleOrgTransferError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof OrgTransferValidationError) {
    jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', error.message)
    return
  }
  if (error instanceof OrgTransferNotFoundError) {
    jsonError(res, 404, 'ORG_TRANSFER_NOT_FOUND', error.message)
    return
  }
  if (error instanceof OrgTransferConflictError) {
    jsonError(res, 409, error.code, error.message)
    return
  }
  logger.warn(fallbackMessage, { error: readErrorMessage(error, 'unknown error') })
  jsonError(res, 500, 'ORG_TRANSFER_INTERNAL_ERROR', fallbackMessage)
}

type TransferAuditAction = 'create' | 'scan' | 'dry_run' | 'apply' | 'cancel'

/** Values-free lifecycle audit row; best-effort per the directory route precedent. */
async function auditTransfer(
  adminUserId: string,
  action: TransferAuditAction,
  transferId: string,
  meta: Record<string, unknown>
): Promise<void> {
  try {
    await auditLog({
      actorId: adminUserId,
      actorType: 'user',
      action: `directory.org_transfer.${action}`,
      resourceType: 'directory-org-transfer',
      resourceId: transferId,
      meta,
    })
  } catch (error) {
    logger.warn('org-transfer audit write failed', {
      action,
      error: readErrorMessage(error, 'unknown error'),
    })
  }
}

export function adminDirectoryOrgTransfersRouter(): Router {
  const router = Router()

  router.post('/', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectUnlistedFields(req, res, CREATE_FIELDS)) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const sourceIntegrationId = typeof body.sourceIntegrationId === 'string' ? body.sourceIntegrationId : ''
    const targetIntegrationId = typeof body.targetIntegrationId === 'string' ? body.targetIntegrationId : ''
    if (provider.length === 0) {
      jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', 'provider is required')
      return
    }
    if (!isUuidShaped(sourceIntegrationId)) {
      jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', 'sourceIntegrationId must be a UUID')
      return
    }
    if (!isUuidShaped(targetIntegrationId)) {
      jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', 'targetIntegrationId must be a UUID')
      return
    }

    try {
      const transfer = await createOrgTransfer({
        provider,
        sourceIntegrationId,
        targetIntegrationId,
        createdBy: adminUserId,
      })
      await auditTransfer(adminUserId, 'create', transfer.id, {
        provider: transfer.provider,
        sourceIntegrationId: transfer.sourceIntegrationId,
        targetIntegrationId: transfer.targetIntegrationId,
        status: transfer.status,
      })
      jsonOk(res, { transfer })
    } catch (error) {
      handleOrgTransferError(res, error, 'Failed to create org transfer')
    }
  })

  router.get('/:transferId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectNonUuidParam(res, 'transferId', req.params.transferId)) return

    try {
      const detail = await getOrgTransfer(req.params.transferId)
      jsonOk(res, detail)
    } catch (error) {
      handleOrgTransferError(res, error, 'Failed to read org transfer')
    }
  })

  router.post('/:transferId/scan', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectNonUuidParam(res, 'transferId', req.params.transferId)) return

    try {
      const result = await scanOrgTransfer(req.params.transferId)
      await auditTransfer(adminUserId, 'scan', result.transfer.id, {
        provider: result.transfer.provider,
        status: result.transfer.status,
        decisionsTotal: result.decisionCounts.total,
        decisionsPending: result.decisionCounts.pending,
      })
      jsonOk(res, result)
    } catch (error) {
      handleOrgTransferError(res, error, 'Failed to scan org transfer')
    }
  })

  // §6.3: dry-run and apply share the endpoint, split by ?dryRun=true. Any other dryRun value
  // is a 400 (never silently coerced into a REAL apply).
  router.post('/:transferId/apply', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectNonUuidParam(res, 'transferId', req.params.transferId)) return

    const rawDryRun = req.query.dryRun
    const wantsDryRun = rawDryRun === 'true'
    if (rawDryRun !== undefined && !wantsDryRun) {
      jsonError(res, 400, 'ORG_TRANSFER_INVALID_INPUT', 'dryRun, when present, must be exactly "true"')
      return
    }

    try {
      if (wantsDryRun) {
        const result = await dryRunOrgTransfer(req.params.transferId)
        await auditTransfer(adminUserId, 'dry_run', result.transfer.id, {
          provider: result.transfer.provider,
          status: result.transfer.status,
          bindings: result.stats.bindings,
          pending: result.stats.pending,
        })
        jsonOk(res, result)
        return
      }
      const transfer = await applyOrgTransfer(req.params.transferId)
      await auditTransfer(adminUserId, 'apply', transfer.id, {
        provider: transfer.provider,
        status: transfer.status,
      })
      jsonOk(res, { transfer })
    } catch (error) {
      handleOrgTransferError(res, error, 'Failed to apply org transfer')
    }
  })

  router.post('/:transferId/cancel', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    if (rejectNonUuidParam(res, 'transferId', req.params.transferId)) return

    try {
      const transfer = await cancelOrgTransfer(req.params.transferId)
      await auditTransfer(adminUserId, 'cancel', transfer.id, {
        provider: transfer.provider,
        status: transfer.status,
      })
      jsonOk(res, { transfer })
    } catch (error) {
      handleOrgTransferError(res, error, 'Failed to cancel org transfer')
    }
  })

  return router
}
