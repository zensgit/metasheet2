import type { Request, Response } from 'express'
import { Router } from 'express'
import { isAdmin as isRbacAdmin } from '../rbac/service'
import { jsonError, jsonOk, parsePagination } from '../util/response'
import {
  createDirectoryIntegration,
  listDirectoryIntegrations,
  listDirectorySyncRuns,
  syncDirectoryIntegration,
  testDirectoryIntegration,
  updateDirectoryIntegration,
} from '../directory/directory-sync'

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

  return router
}
