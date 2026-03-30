import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { authenticate } from '../middleware/auth'
import { isAdmin as isRbacAdmin } from '../rbac/service'
import { readErrorMessage } from '../utils/error'
import { jsonError, jsonOk, parsePagination } from '../util/response'
import {
  getDirectorySyncStatus,
  acknowledgeAlert,
  getDirectorySyncHistory,
} from '../directory/DirectorySyncService'
import {
  listDeprovisions,
  getDeprovision,
  rollbackDeprovision,
} from '../directory/deprovision-ledger'

function getRequestUserId(req: Request): string {
  const raw = req.user as Record<string, unknown> | undefined
  const userId = raw?.id ?? raw?.userId ?? raw?.sub
  return typeof userId === 'string' ? userId.trim() : ''
}

function hasLegacyAdminClaim(req: Request): boolean {
  const raw = req.user as Record<string, unknown> | undefined
  if (!raw) return false
  if (raw.role === 'admin') return true
  if (Array.isArray(raw.roles) && raw.roles.includes('admin')) return true
  if (Array.isArray(raw.perms) && (raw.perms.includes('*:*') || raw.perms.includes('admin:all'))) return true
  return false
}

async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }

  const allowed = hasLegacyAdminClaim(req) || await isRbacAdmin(userId)
  if (!allowed) {
    jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
    return null
  }

  return userId
}

export function adminDirectoryRouter(): Router {
  const r = Router()

  // GET /api/admin/directory/sync/status
  r.get('/api/admin/directory/sync/status', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const status = await getDirectorySyncStatus()
      return jsonOk(res, status)
    } catch (error) {
      return jsonError(res, 500, 'SYNC_STATUS_FAILED', readErrorMessage(error, 'Failed to load sync status'))
    }
  })

  // POST /api/admin/directory/sync/acknowledge
  r.post('/api/admin/directory/sync/acknowledge', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const status = await acknowledgeAlert(adminUserId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.sync.acknowledge',
        resourceType: 'directory-sync',
        resourceId: 'alert',
        meta: { acknowledgedBy: adminUserId },
      })

      return jsonOk(res, status)
    } catch (error) {
      return jsonError(res, 500, 'SYNC_ACKNOWLEDGE_FAILED', readErrorMessage(error, 'Failed to acknowledge alert'))
    }
  })

  // GET /api/admin/directory/sync/history
  r.get('/api/admin/directory/sync/history', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
      })

      const result = await getDirectorySyncHistory({ page, pageSize })
      return jsonOk(res, { items: result.items, page, pageSize, total: result.total })
    } catch (error) {
      return jsonError(res, 500, 'SYNC_HISTORY_FAILED', readErrorMessage(error, 'Failed to load sync history'))
    }
  })

  // GET /api/admin/directory/deprovisions
  r.get('/api/admin/directory/deprovisions', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
      })
      const q = String(req.query.q || '').trim()

      const result = await listDeprovisions({ page, pageSize, q: q || undefined })
      return jsonOk(res, { items: result.items, page, pageSize, total: result.total, query: q })
    } catch (error) {
      return jsonError(res, 500, 'DEPROVISION_LIST_FAILED', readErrorMessage(error, 'Failed to load deprovisions'))
    }
  })

  // GET /api/admin/directory/deprovisions/:id
  r.get('/api/admin/directory/deprovisions/:id', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const record = await getDeprovision(req.params.id)
      if (!record) {
        return jsonError(res, 404, 'NOT_FOUND', 'Deprovision record not found')
      }
      return jsonOk(res, record)
    } catch (error) {
      return jsonError(res, 500, 'DEPROVISION_GET_FAILED', readErrorMessage(error, 'Failed to load deprovision'))
    }
  })

  // POST /api/admin/directory/deprovisions/:id/rollback
  r.post('/api/admin/directory/deprovisions/:id/rollback', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { record, snapshot } = await rollbackDeprovision(req.params.id, adminUserId)
      if (!record) {
        return jsonError(res, 404, 'NOT_FOUND', 'Deprovision record not found or already rolled back')
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.deprovision.rollback',
        resourceType: 'deprovision-ledger',
        resourceId: req.params.id,
        meta: { targetUserId: record.targetUserId, rolledBackBy: adminUserId },
      })

      return jsonOk(res, { record, snapshot })
    } catch (error) {
      return jsonError(res, 500, 'DEPROVISION_ROLLBACK_FAILED', readErrorMessage(error, 'Failed to rollback deprovision'))
    }
  })

  return r
}
