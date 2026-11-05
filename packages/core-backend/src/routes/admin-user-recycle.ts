import type { Request, Response, Router } from 'express'
import { auditLog } from '../audit/audit'
import {
  acceptsRecyclePurgeConfirm,
  acceptsRecycleRescrubConfirm,
  listRecycleBin,
  logRecycleFailure,
  planRecycleIdList,
  purgeRecycleUsers,
  rescrubPurgedUsers,
  resolveUserRecycleRetentionDays,
  restoreRecycleUsers,
  USER_RECYCLE_PURGE_CONFIRM_TEXT,
  USER_RECYCLE_RESCRUB_CONFIRM_TEXT,
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
    } catch {
      return jsonError(res, 500, 'RECYCLE_LIST_FAILED', '加载回收站失败')
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
    } catch {
      return jsonError(res, 500, 'RECYCLE_RESTORE_FAILED', '恢复失败')
    }
  })

  router.post('/api/admin/users/recycle/purge', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureRecycleAdmin(req, res)
    if (!adminUserId) return
    if (!acceptsRecyclePurgeConfirm(req.body?.confirmText)) {
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
      logRecycleFailure('RECYCLE_PURGE_FAILED', error)
      return jsonError(res, 500, 'RECYCLE_PURGE_FAILED', '清除失败')
    }
  })

  router.post('/api/admin/users/recycle/rescrub', authenticate, async (req: Request, res: Response) => {
    const adminUserId = await ensureRecycleAdmin(req, res)
    if (!adminUserId) return
    if (!acceptsRecycleRescrubConfirm(req.body?.confirmText)) {
      return jsonError(res, 400, 'CONFIRM_TEXT_MISMATCH', `请输入「${USER_RECYCLE_RESCRUB_CONFIRM_TEXT}」以确认`)
    }
    const plan = planRecycleIdList(req.body?.userIds)
    if (plan.ok === false) return jsonError(res, plan.status, plan.code, plan.message)
    try {
      const results = await rescrubPurgedUsers({ actorId: adminUserId, rows: plan.ids })
      const summary = summarize(results)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'update',
        resourceType: 'user-batch',
        resourceId: 'recycle-rescrub',
        meta: {
          adminUserId,
          outcome: 'rescrubbed',
          successCount: summary.successCount,
          failureCount: summary.failureCount,
        },
      })
      return jsonOk(res, summary)
    } catch (error) {
      logRecycleFailure('RECYCLE_RESCRUB_FAILED', error)
      return jsonError(res, 500, 'RECYCLE_RESCRUB_FAILED', '重新清理失败')
    }
  })
}
