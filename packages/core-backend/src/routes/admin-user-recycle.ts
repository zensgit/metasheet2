import type { Request, Response, Router } from 'express'
import { auditLog } from '../audit/audit'
import {
  listRecycleBin,
  planRecycleIdList,
  purgeRecycleUsers,
  resolveUserRecycleRetentionDays,
  restoreRecycleUsers,
  USER_RECYCLE_PURGE_CONFIRM_TEXT,
} from '../admin/user-recycle'
import type { BatchItemResult } from '../admin/user-batch-plan'
import { authenticate } from '../middleware/auth'
import { hasLegacyAdminClaim } from '../rbac/platform-admin'
import { isAdmin as isRbacAdmin } from '../rbac/service'
import { jsonError, jsonOk, parsePagination } from '../util/response'

function getRequestUserId(req: Request): string {
  const raw = req.user as Record<string, unknown> | undefined
  const userId = raw?.id ?? raw?.userId ?? raw?.sub
  return typeof userId === 'string' ? userId.trim() : ''
}

async function ensureRecycleAdmin(req: Request, res: Response): Promise<string | null> {
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

function summarize(results: BatchItemResult[]) {
  const successCount = results.filter((item) => item.ok).length
  return { successCount, failureCount: results.length - successCount, results }
}

export function registerAdminUserRecycleRoutes(router: Router): void {
  router.get('/api/admin/users/recycle', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureRecycleAdmin(req, res)
    if (!adminUserId) return
    try {
      const q = String(req.query.q || '').trim()
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const listed = await listRecycleBin({ q, limit: pageSize, offset })
      return jsonOk(res, {
        ...listed,
        page,
        pageSize,
        query: q,
        retentionDays: resolveUserRecycleRetentionDays(),
        actorId: adminUserId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载回收站失败'
      return jsonError(res, 500, 'RECYCLE_LIST_FAILED', message)
    }
  })

  router.post('/api/admin/users/recycle/restore', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureRecycleAdmin(req, res)
    if (!adminUserId) return
    const plan = planRecycleIdList(req.body?.userIds)
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)
    try {
      const results = await restoreRecycleUsers({ actorId: adminUserId, rows: plan.ids })
      const summary = summarize(results)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'restore',
        resourceType: 'user-batch',
        resourceId: 'recycle-restore',
        meta: {
          adminUserId,
          successCount: summary.successCount,
          failureCount: summary.failureCount,
        },
      })
      return jsonOk(res, summary)
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复失败'
      return jsonError(res, 500, 'RECYCLE_RESTORE_FAILED', message)
    }
  })

  router.post('/api/admin/users/recycle/purge', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureRecycleAdmin(req, res)
    if (!adminUserId) return
    if (req.body?.confirmText !== USER_RECYCLE_PURGE_CONFIRM_TEXT) {
      return jsonError(res, 400, 'CONFIRM_TEXT_MISMATCH', `请输入「${USER_RECYCLE_PURGE_CONFIRM_TEXT}」以确认`)
    }
    const plan = planRecycleIdList(req.body?.userIds)
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)
    try {
      const results = await purgeRecycleUsers({ actorId: adminUserId, rows: plan.ids })
      const summary = summarize(results)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'delete',
        resourceType: 'user-batch',
        resourceId: 'recycle-purge',
        meta: {
          adminUserId,
          outcome: 'purged',
          successCount: summary.successCount,
          failureCount: summary.failureCount,
        },
      })
      return jsonOk(res, summary)
    } catch (error) {
      const message = error instanceof Error ? error.message : '清除失败'
      return jsonError(res, 500, 'RECYCLE_PURGE_FAILED', message)
    }
  })
}
