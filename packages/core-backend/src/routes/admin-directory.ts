import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import {
  acknowledgeDirectorySyncAlert,
  batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts,
  bindDirectoryAccount,
  createDirectoryIntegration,
  getDirectorySyncScheduleSnapshot,
  listDirectoryIntegrationAccounts,
  listDirectoryIntegrations,
  listDirectoryReviewItems,
  listDirectorySyncAlerts,
  listDirectorySyncRuns,
  syncDirectoryIntegration,
  testDirectoryIntegration,
  unbindDirectoryAccount,
  updateDirectoryIntegration,
} from '../directory/directory-sync'
import { refreshDirectoryIntegrationSchedule } from '../directory/directory-sync-scheduler'
import { isAdmin as isRbacAdmin } from '../rbac/service'
import { jsonError, jsonOk, parsePagination } from '../util/response'

function normalizeAlertFilter(value: unknown): 'all' | 'pending' | 'acknowledged' {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized === 'pending' || normalized === 'acknowledged') return normalized
  return 'all'
}

function normalizeReviewFilter(value: unknown): 'all' | 'pending_binding' | 'inactive_linked' | 'missing_identifier' {
  const normalized = typeof value === 'string' ? value.trim() : ''
  switch (normalized) {
    case 'pending_binding':
    case 'inactive_linked':
    case 'missing_identifier':
      return normalized
    case 'needs_binding':
      return 'pending_binding'
    case 'missing_identity':
      return 'missing_identifier'
    default:
      return 'all'
  }
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}

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
  if (Array.isArray(raw.permissions) && raw.permissions.includes('*:*')) return true
  if (Array.isArray(raw.perms) && raw.perms.includes('*:*')) return true
  return false
}

async function ensurePlatformAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = getRequestUserId(req)
  if (!userId) {
    jsonError(res, 401, 'UNAUTHENTICATED', 'Authentication required')
    return null
  }

  if (hasLegacyAdminClaim(req) || await isRbacAdmin(userId)) {
    return userId
  }

  jsonError(res, 403, 'FORBIDDEN', 'Admin access required')
  return null
}

export function adminDirectoryRouter(): Router {
  const router = Router()

  router.get('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const items = await listDirectoryIntegrations()
      jsonOk(res, { items })
    } catch (error) {
      jsonError(res, 500, 'DIRECTORY_LIST_FAILED', readErrorMessage(error, 'Failed to load directory integrations'))
    }
  })

  router.post('/integrations', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integration = await createDirectoryIntegration(req.body as Record<string, unknown> as never)
      await refreshDirectoryIntegrationSchedule(integration.id)
      jsonOk(res, { integration })
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_CREATE_FAILED', readErrorMessage(error, 'Failed to create directory integration'))
    }
  })

  router.put('/integrations/:integrationId', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const integration = await updateDirectoryIntegration(req.params.integrationId, req.body as Record<string, unknown> as never)
      if (!integration) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      await refreshDirectoryIntegrationSchedule(integration.id)
      jsonOk(res, { integration })
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_UPDATE_FAILED', readErrorMessage(error, 'Failed to update directory integration'))
    }
  })

  router.post('/integrations/test', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await testDirectoryIntegration(req.body as Record<string, unknown> as never)
      jsonOk(res, result)
    } catch (error) {
      jsonError(res, 400, 'DIRECTORY_TEST_FAILED', readErrorMessage(error, 'Failed to test directory integration'))
    }
  })

  router.post('/integrations/:integrationId/sync', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const result = await syncDirectoryIntegration(req.params.integrationId, adminUserId)
      jsonOk(res, result)
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to sync directory integration')
      jsonError(res, /not found/i.test(message) ? 404 : 500, 'DIRECTORY_SYNC_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/runs', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const result = await listDirectorySyncRuns(req.params.integrationId, { limit: pageSize, offset })
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
      })
    } catch (error) {
      jsonError(res, 500, 'DIRECTORY_RUNS_FAILED', readErrorMessage(error, 'Failed to load sync runs'))
    }
  })

  router.get('/integrations/:integrationId/schedule', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const snapshot = await getDirectorySyncScheduleSnapshot(req.params.integrationId)
      if (!snapshot) {
        jsonError(res, 404, 'DIRECTORY_NOT_FOUND', 'Directory integration not found')
        return
      }
      jsonOk(res, { snapshot })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory schedule')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_SCHEDULE_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/alerts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 100,
      })
      const filter = normalizeAlertFilter(req.query.ack ?? req.query.filter)
      const result = await listDirectorySyncAlerts(
        req.params.integrationId,
        { limit: pageSize, offset },
        filter,
      )
      jsonOk(res, {
        items: result.items,
        counts: result.counts,
        total: result.total,
        page,
        pageSize,
        filter,
        ack: filter,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory alerts')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_ALERTS_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/review-items', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 100,
        maxPageSize: 200,
      })
      const filter = normalizeReviewFilter(req.query.queue ?? req.query.filter)
      const result = await listDirectoryReviewItems(
        req.params.integrationId,
        { limit: pageSize, offset },
        filter,
      )
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
        filter,
        queue: filter,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory review items')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_REVIEW_ITEMS_FAILED', message)
    }
  })

  router.get('/integrations/:integrationId/accounts', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 50,
        maxPageSize: 100,
      })
      const search = typeof req.query.q === 'string' ? req.query.q : undefined
      const result = await listDirectoryIntegrationAccounts(req.params.integrationId, { limit: pageSize, offset }, search)
      jsonOk(res, {
        items: result.items,
        total: result.total,
        page,
        pageSize,
        query: search?.trim() || '',
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to load directory accounts')
      jsonError(res, /required|invalid/i.test(message) ? 400 : 500, 'DIRECTORY_ACCOUNTS_FAILED', message)
    }
  })

  router.post('/accounts/:accountId/bind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const localUserRef = typeof req.body?.localUserRef === 'string' ? req.body.localUserRef : ''
      const enableDingTalkGrant = typeof req.body?.enableDingTalkGrant === 'boolean'
        ? req.body.enableDingTalkGrant
        : true

      const result = await bindDirectoryAccount(req.params.accountId, {
        localUserRef,
        adminUserId,
        enableDingTalkGrant,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'bind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          localUserId: result.account.localUser?.id ?? null,
          localUserEmail: result.account.localUser?.email ?? null,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          enableDingTalkGrant,
        },
      })
      jsonOk(res, { account: result.account })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to bind directory account')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already bound|already linked/i.test(message)
          ? 409
          : /required|cannot be pre-bound/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_BIND_FAILED', message)
    }
  })

  router.post('/accounts/batch-bind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const rawBindings = Array.isArray(req.body?.bindings) ? req.body.bindings : []
      const bindings = rawBindings
        .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
          localUserRef: typeof entry.localUserRef === 'string' ? entry.localUserRef : '',
          enableDingTalkGrant: typeof entry.enableDingTalkGrant === 'boolean' ? entry.enableDingTalkGrant : true,
        }))

      const results = await batchBindDirectoryAccounts(bindings, { adminUserId })
      await Promise.all(results.map((result) => auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'bind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          localUserId: result.account.localUser?.id ?? null,
          localUserEmail: result.account.localUser?.email ?? null,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          mode: 'bulk',
          selectionSize: bindings.length,
        },
      })))
      jsonOk(res, {
        items: results.map((result) => result.account),
        updatedCount: results.length,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to batch bind directory accounts')
      const statusCode = /not found/i.test(message)
        ? 404
        : /already bound|already linked/i.test(message)
          ? 409
          : /required|cannot be pre-bound/i.test(message)
            ? 400
            : 500
      jsonError(res, statusCode, 'DIRECTORY_BATCH_BIND_FAILED', message)
    }
  })

  router.post('/accounts/:accountId/unbind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const disableDingTalkGrant = req.body?.disableDingTalkGrant === true
      const result = await unbindDirectoryAccount(req.params.accountId, {
        adminUserId,
        disableDingTalkGrant,
      })
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'unbind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          disableDingTalkGrant,
        },
      })
      jsonOk(res, { account: result.account })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to unbind directory account')
      const statusCode = /not found/i.test(message)
        ? 404
        : /required/i.test(message)
          ? 400
          : 500
      jsonError(res, statusCode, 'DIRECTORY_UNBIND_FAILED', message)
    }
  })

  router.post('/accounts/batch-unbind', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const rawAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : []
      const accountIds = rawAccountIds.filter((value): value is string => typeof value === 'string')
      const disableDingTalkGrant = req.body?.disableDingTalkGrant === true
      const results = await batchUnbindDirectoryAccounts(accountIds, {
        adminUserId,
        disableDingTalkGrant,
      })
      await Promise.all(results.map((result) => auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'unbind',
        resourceType: 'directory-account-link',
        resourceId: result.account.id,
        meta: {
          adminUserId,
          directoryAccountId: result.account.id,
          integrationId: result.account.integrationId,
          externalUserId: result.account.externalUserId,
          corpId: result.account.corpId,
          previousLocalUserId: result.previousLocalUser?.id ?? null,
          previousLocalUserEmail: result.previousLocalUser?.email ?? null,
          disableDingTalkGrant,
          mode: 'bulk',
          selectionSize: accountIds.length,
        },
      })))
      jsonOk(res, {
        items: results.map((result) => result.account),
        updatedCount: results.length,
        disableDingTalkGrant,
      })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to batch unbind directory accounts')
      const statusCode = /not found/i.test(message)
        ? 404
        : /required/i.test(message)
          ? 400
          : 500
      jsonError(res, statusCode, 'DIRECTORY_BATCH_UNBIND_FAILED', message)
    }
  })

  router.post('/alerts/:alertId/ack', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      const alert = await acknowledgeDirectorySyncAlert(req.params.alertId, adminUserId)
      if (!alert) {
        jsonError(res, 404, 'DIRECTORY_ALERT_NOT_FOUND', 'Directory alert not found')
        return
      }
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'acknowledge',
        resourceType: 'directory-sync-alert',
        resourceId: alert.id,
        meta: {
          adminUserId,
          alertId: alert.id,
          integrationId: alert.integrationId,
          runId: alert.runId,
          code: alert.code,
          level: alert.level,
          acknowledgedAt: alert.acknowledgedAt,
        },
      })
      jsonOk(res, { alert })
    } catch (error) {
      const message = readErrorMessage(error, 'Failed to acknowledge directory alert')
      jsonError(res, /required/i.test(message) ? 400 : 500, 'DIRECTORY_ALERT_ACK_FAILED', message)
    }
  })

  return router
}
