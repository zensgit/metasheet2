/**
 * O2-D1 — per-surface discriminating tests for routes/univer-meta.ts's recovery-authority
 * mapping, the surface the DISCOVERY guard added to the census denominator.
 *
 * Why this file exists: `POST /sheets/:sheetId/config-restore-execute` writes
 * field_permissions and spreadsheet_permissions (both carrying a recovery-authority
 * trigger armed from ladder rung L1) and its outer catch did NOT classify, so a 40001
 * landed as an unmapped 500. That was found by an independent review (#5114,
 * da556a4f33) — not by the census, because univer-meta was never in the census's
 * denominator at all. The denominator gap is closed by the discovery guard in
 * recovery-conflict-census.test.ts; these are the behaviour legs that let the file be
 * registered rather than allowlisted.
 *
 * Shape follows recovery-conflict-surfaces-routes-rbac.test.ts exactly: invoke the
 * route's FINAL handler directly (guards are not under test here), inject the marker
 * 40001 at the db seam → the exact 409 RECOVERY_AUTHORITY_BUSY body; inject a non-40001
 * error → that route's ORIGINAL 500 semantics, asserted positively. Without the second
 * half a route that answered 409 for EVERY error would satisfy the leg.
 *
 * Injection point: every one of the five catches is the OUTER catch of its whole handler,
 * and the first statement inside each `try` is `poolManager.get()` followed by a query, so
 * rejecting the pool reaches the registered call site directly. That is the same
 * discipline the pre-existing legs use (`pgMocks.poolQuery.mockRejectedValue(...)`).
 */

import type { Request, Response, Router } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => rbacServiceMocks)

import { poolManager } from '../../src/integration/db/connection-pool'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { censusFile } from './lib/recovery-census-recorder'

// O2-A1/P3-1 RUNTIME leg linkage — see recovery-conflict-census.test.ts.
const census = censusFile('recovery-conflict-surfaces-routes-univer-meta.test.ts')

/** univer-meta's own local responder body (routes/univer-meta.ts sendRecoveryAuthorityBusy). */
const UNIFORM_409_BODY = {
  ok: false,
  error: {
    code: 'RECOVERY_AUTHORITY_BUSY',
    message: 'Recovery is stabilizing permissions; retry this change.',
  },
}

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function otherDbError(): Error & { code: string } {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' })
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

/** Reject every db access with `error`, so the handler's outer catch is reached. */
function poolRejecting(error: Error): void {
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: vi.fn(async () => { throw error }),
    transaction: vi.fn(async () => { throw error }),
  } as never)
}

/** Invoke the route's FINAL handler directly (guards are not under test here). */
function invokeHandler(
  router: Router,
  method: 'post' | 'put' | 'delete',
  path: string,
  req: Partial<Request>,
  res: Response,
): Promise<unknown> {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: method.toUpperCase(),
    headers: {},
    query: {},
    params: {},
    body: {},
    user: { id: 'admin-1', role: 'admin', roles: ['admin'], permissions: [], perms: [] },
  } as unknown as Request
  Object.assign(fullReq, req)
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => {
    if (err) throw err
  }))
}

/** One registered call site: how to reach it, and the 500 it must keep for other errors. */
type Surface = {
  method: 'post' | 'put' | 'delete'
  path: string
  req: Partial<Request>
  originalErrorCode: string
  originalErrorMessage: string
}

const SHEET_PERMISSIONS: Surface = {
  method: 'put',
  path: '/sheets/:sheetId/permissions/:subjectType/:subjectId',
  req: {
    params: { sheetId: 'sheet-1', subjectType: 'user', subjectId: 'user-1' },
    body: { accessLevel: 'read' },
  },
  originalErrorCode: 'INTERNAL_ERROR',
  originalErrorMessage: 'Failed to update sheet permission',
}

const FIELD_PERMISSIONS: Surface = {
  method: 'put',
  path: '/sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId',
  req: {
    params: { sheetId: 'sheet-1', fieldId: 'field-1', subjectType: 'user', subjectId: 'user-1' },
    body: { visible: false },
  },
  originalErrorCode: 'INTERNAL_ERROR',
  originalErrorMessage: 'Failed to update field permission',
}

const CONFIG_RESTORE_EXECUTE: Surface = {
  method: 'post',
  path: '/sheets/:sheetId/config-restore-execute',
  req: {
    params: { sheetId: 'sheet-1' },
    body: { revisionId: 'rev-1', previewToken: 'token-1' },
  },
  originalErrorCode: 'INTERNAL',
  originalErrorMessage: 'Failed to execute config restore',
}

const RECORD_PERMISSIONS_PUT: Surface = {
  method: 'put',
  path: '/sheets/:sheetId/records/:recordId/permissions',
  req: {
    params: { sheetId: 'sheet-1', recordId: 'record-1' },
    body: { subjectType: 'user', subjectId: 'user-1', accessLevel: 'read' },
  },
  originalErrorCode: 'INTERNAL_ERROR',
  originalErrorMessage: 'Failed to update record permission',
}

const RECORD_PERMISSIONS_DELETE: Surface = {
  method: 'delete',
  path: '/sheets/:sheetId/records/:recordId/permissions/:permissionId',
  req: { params: { sheetId: 'sheet-1', recordId: 'record-1', permissionId: 'perm-1' } },
  originalErrorCode: 'INTERNAL_ERROR',
  originalErrorMessage: 'Failed to delete record permission',
}

async function marker409(surface: Surface): Promise<Response & { statusCode: number; body: unknown }> {
  poolRejecting(markerError())
  const res = mockResponse()
  await invokeHandler(univerMetaRouter(), surface.method, surface.path, surface.req, res)
  return res
}

async function original500(surface: Surface): Promise<Response & { statusCode: number; body: unknown }> {
  poolRejecting(otherDbError())
  const res = mockResponse()
  await invokeHandler(univerMetaRouter(), surface.method, surface.path, surface.req, res)
  return res
}

beforeEach(() => {
  rbacServiceMocks.isAdmin.mockReset()
  rbacServiceMocks.isAdmin.mockResolvedValue(true)
  rbacServiceMocks.listUserPermissions.mockReset()
  rbacServiceMocks.listUserPermissions.mockResolvedValue(['multitable:read', 'multitable:write'])
  rbacServiceMocks.userHasPermission.mockReset()
  rbacServiceMocks.userHasPermission.mockResolvedValue(true)
  rbacServiceMocks.invalidateUserPerms.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('routes/univer-meta.ts — recovery-authority busy mapping', () => {
  it('[recovery-census:univer-meta:sheet-permissions-put] PUT sheet permissions: marker 40001 → exact 409 RECOVERY_AUTHORITY_BUSY', async () => {
    const res = await marker409(SHEET_PERMISSIONS)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('univer-meta:sheet-permissions-put')
  })

  it('PUT sheet permissions: a non-40001 db error keeps the ORIGINAL 500 (control)', async () => {
    const res = await original500(SHEET_PERMISSIONS)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: SHEET_PERMISSIONS.originalErrorCode, message: SHEET_PERMISSIONS.originalErrorMessage },
    })
  })

  it('[recovery-census:univer-meta:field-permissions-put] PUT field permission: marker 40001 → exact 409 RECOVERY_AUTHORITY_BUSY', async () => {
    const res = await marker409(FIELD_PERMISSIONS)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('univer-meta:field-permissions-put')
  })

  it('PUT field permission: a non-40001 db error keeps the ORIGINAL 500 (control)', async () => {
    const res = await original500(FIELD_PERMISSIONS)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: FIELD_PERMISSIONS.originalErrorCode, message: FIELD_PERMISSIONS.originalErrorMessage },
    })
  })

  it('[recovery-census:univer-meta:config-restore-execute] POST config-restore-execute: marker 40001 → exact 409 RECOVERY_AUTHORITY_BUSY', async () => {
    // The #5114 site. Before that fix this catch had no classification line at all, so a
    // 40001 raised by applyPermissionDeEscalation's field_permissions /
    // spreadsheet_permissions writes fell through to the 500 asserted by the control below.
    const res = await marker409(CONFIG_RESTORE_EXECUTE)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('univer-meta:config-restore-execute')
  })

  it('POST config-restore-execute: a non-40001 db error keeps the ORIGINAL 500 (control)', async () => {
    const res = await original500(CONFIG_RESTORE_EXECUTE)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: CONFIG_RESTORE_EXECUTE.originalErrorCode, message: CONFIG_RESTORE_EXECUTE.originalErrorMessage },
    })
  })

  it('[recovery-census:univer-meta:record-permissions-put] PUT record permissions: marker 40001 → exact 409 RECOVERY_AUTHORITY_BUSY', async () => {
    const res = await marker409(RECORD_PERMISSIONS_PUT)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('univer-meta:record-permissions-put')
  })

  it('PUT record permissions: a non-40001 db error keeps the ORIGINAL 500 (control)', async () => {
    const res = await original500(RECORD_PERMISSIONS_PUT)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: RECORD_PERMISSIONS_PUT.originalErrorCode, message: RECORD_PERMISSIONS_PUT.originalErrorMessage },
    })
  })

  it('[recovery-census:univer-meta:record-permissions-delete] DELETE record permission: marker 40001 → exact 409 RECOVERY_AUTHORITY_BUSY', async () => {
    const res = await marker409(RECORD_PERMISSIONS_DELETE)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('univer-meta:record-permissions-delete')
  })

  it('DELETE record permission: a non-40001 db error keeps the ORIGINAL 500 (control)', async () => {
    const res = await original500(RECORD_PERMISSIONS_DELETE)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: RECORD_PERMISSIONS_DELETE.originalErrorCode, message: RECORD_PERMISSIONS_DELETE.originalErrorMessage },
    })
  })
})
