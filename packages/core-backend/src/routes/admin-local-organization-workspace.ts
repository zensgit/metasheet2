import { Router } from 'express'
import type { Request, Response } from 'express'
import { Logger } from '../core/logger'
import {
  getLocalOrganizationWorkspace,
  listLocalOrganizationMembers,
  listLocalOrganizationMemberCandidates,
  LocalOrganizationWorkspaceError,
  type LocalOrganizationPage,
} from '../directory/local-organization-workspace'
import { ensurePlatformAdmin } from './admin-directory'
import { jsonError, jsonOk } from '../util/response'

const logger = new Logger('LocalOrganizationWorkspace')
// Same server-owned org context as the existing local CRUD router.
const ORG_ID = 'default'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function integer(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'Invalid page')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'Invalid page')
  return parsed
}

function pageInput(req: Request): LocalOrganizationPage {
  if (Object.keys(req.query).some(key => !['integrationId', 'page', 'pageSize', 'q'].includes(key))) {
    throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS', 'Query contains fields not accepted by this endpoint')
  }
  if (typeof req.query.integrationId !== 'string' || !UUID.test(req.query.integrationId)) {
    throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'integrationId must be an expected local anchor UUID')
  }
  const page = integer(req.query.page, 1)
  const pageSize = integer(req.query.pageSize, 25)
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) {
    throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'Invalid page size')
  }
  if (req.query.q !== undefined && typeof req.query.q !== 'string') {
    throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'Invalid search')
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (q.length > 200) throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_INVALID_INPUT', 'Invalid search')
  return { integrationId: req.query.integrationId, page, pageSize, q }
}

function fail(res: Response, error: unknown): void {
  if (error instanceof LocalOrganizationWorkspaceError) {
    jsonError(res, error.status, error.code, error.message)
    return
  }
  logger.warn('Local organization request failed')
  jsonError(res, 500, 'LOCAL_ORG_INTERNAL_ERROR', 'Local organization request failed')
}

export function localOrganizationWorkspaceRouter(): Router {
  const router = Router()
  router.get('/workspace', async (req: Request, res: Response) => {
    if (!await ensurePlatformAdmin(req, res)) return
    try {
      if (Object.keys(req.query).length > 0) {
        throw new LocalOrganizationWorkspaceError(400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS', 'Query contains fields not accepted by this endpoint')
      }
      jsonOk(res, await getLocalOrganizationWorkspace(ORG_ID))
    } catch (error) { fail(res, error) }
  })
  router.get('/members', async (req: Request, res: Response) => {
    if (!await ensurePlatformAdmin(req, res)) return
    try { jsonOk(res, await listLocalOrganizationMembers(ORG_ID, pageInput(req))) }
    catch (error) { fail(res, error) }
  })
  router.get('/member-candidates', async (req: Request, res: Response) => {
    if (!await ensurePlatformAdmin(req, res)) return
    try { jsonOk(res, await listLocalOrganizationMemberCandidates(ORG_ID, pageInput(req))) }
    catch (error) { fail(res, error) }
  })
  return router
}
