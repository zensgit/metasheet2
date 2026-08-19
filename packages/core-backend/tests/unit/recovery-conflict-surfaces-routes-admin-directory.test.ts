/**
 * O2-S2 — per-surface discriminating tests, HTTP layer (routes/admin-directory.ts,
 * the boundary that surfaces directory/deprovision-evidence-api.ts conflicts).
 *
 * The service re-raises a marker 40001 as the named retryable RecoveryConflictError
 * (proven in recovery-conflict-surfaces-services.test.ts); this suite proves the route
 * catch maps that named error to the EXACT uniform retryable 409, while the
 * pre-existing coded mappings (404 / 409 / 500) stay byte-identical.
 */

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminUsersMocks = vi.hoisted(() => ({
  ensurePlatformAdmin: vi.fn(),
}))

const evidenceMocks = vi.hoisted(() => ({
  compensateSupersededDenyGrant: vi.fn(),
  listDeprovisionEffects: vi.fn(),
  listDeprovisionEvents: vi.fn(),
  previewDeprovisionForUser: vi.fn(),
  readDeprovisionRuntimeFlags: vi.fn(() => ({})),
  restoreDeprovisionEvent: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

// O2-A1 census legs: the write-surface service functions the admin-directory router
// delegates to. Each route leg rejects one of these with the NAMED RecoveryConflictError
// (the shape the service layer is separately proven to produce in
// recovery-conflict-surfaces-services.test.ts) and asserts the route's catch maps it to
// the exact uniform retryable 409 — making each `sendIfRecoveryConflict` call site
// individually load-bearing (dead-branching any one site reds its leg).
const directorySyncMocks = vi.hoisted(() => ({
  syncDirectoryIntegration: vi.fn(),
  bindDirectoryAccount: vi.fn(),
  admitDirectoryAccountUser: vi.fn(),
  batchBindDirectoryAccounts: vi.fn(),
  batchAdmitDirectoryAccountUsers: vi.fn(),
  unbindDirectoryAccount: vi.fn(),
  batchUnbindDirectoryAccounts: vi.fn(),
}))

vi.mock('../../src/directory/directory-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/directory/directory-sync')>()
  return {
    ...actual,
    syncDirectoryIntegration: directorySyncMocks.syncDirectoryIntegration,
    bindDirectoryAccount: directorySyncMocks.bindDirectoryAccount,
    admitDirectoryAccountUser: directorySyncMocks.admitDirectoryAccountUser,
    batchBindDirectoryAccounts: directorySyncMocks.batchBindDirectoryAccounts,
    batchAdmitDirectoryAccountUsers: directorySyncMocks.batchAdmitDirectoryAccountUsers,
    unbindDirectoryAccount: directorySyncMocks.unbindDirectoryAccount,
    batchUnbindDirectoryAccounts: directorySyncMocks.batchUnbindDirectoryAccounts,
  }
})

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: adminUsersMocks.ensurePlatformAdmin,
}))

vi.mock('../../src/directory/deprovision-evidence-api', () => evidenceMocks)

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))

import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
  RecoveryConflictError,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const EVENT_ID = '44444444-4444-4444-8444-444444444444'

const UNIFORM_409_BODY = {
  ok: false,
  error: {
    code: RECOVERY_CONFLICT_HTTP_CODE,
    message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    details: { retryable: true },
  },
}

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function mockResponse() {
  return {
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
  } as Response & { statusCode: number; body: unknown }
}

async function invokeRoute(
  method: 'post' | 'get',
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown> } = {},
) {
  const router = adminDirectoryRouter()
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find(
    (entry) => entry.route?.path === path && entry.route?.methods?.[method],
  )
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const res = mockResponse()
  const req = {
    method: method.toUpperCase(),
    headers: {},
    query: {},
    params: options.params ?? {},
    body: options.body ?? {},
    // admin-directory uses its OWN ensurePlatformAdmin (module-local, not the
    // admin-users export) — the legacy role claim short-circuits its RBAC DB read.
    user: { id: 'admin-1', role: 'admin' },
  } as unknown as Request
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, (err?: unknown) => {
    if (err) throw err
  })
  return res
}

async function invokeRestore(body: Record<string, unknown>) {
  return invokeRoute('post', '/deprovision/events/:eventId/restore', {
    params: { eventId: EVENT_ID },
    body,
  })
}

beforeEach(() => {
  adminUsersMocks.ensurePlatformAdmin.mockReset()
  adminUsersMocks.ensurePlatformAdmin.mockResolvedValue('admin-1')
  evidenceMocks.restoreDeprovisionEvent.mockReset()
  evidenceMocks.compensateSupersededDenyGrant.mockReset()
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
  for (const mock of Object.values(directorySyncMocks)) mock.mockReset()
})

describe('POST /deprovision/events/:eventId/restore — recovery conflict boundary', () => {
  it('[recovery-census:admin-directory:deprovision-restore] the named RecoveryConflictError from the service → exact uniform retryable 409', async () => {
    evidenceMocks.restoreDeprovisionEvent.mockRejectedValue(
      new RecoveryConflictError(markerError()),
    )
    const res = await invokeRestore({ mode: 'rehire' })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('coded EVENT_NOT_FOUND keeps its ORIGINAL 404 mapping, exactly', async () => {
    evidenceMocks.restoreDeprovisionEvent.mockRejectedValue(
      Object.assign(new Error('Deprovision event not found'), { code: 'EVENT_NOT_FOUND' }),
    )
    const res = await invokeRestore({ mode: 'rehire' })
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'EVENT_NOT_FOUND',
        message: 'Deprovision event not found',
        details: undefined,
      },
    })
  })

  it('an uncoded failure keeps the ORIGINAL 500 DEPROVISION_RESTORE_FAILED, exactly', async () => {
    evidenceMocks.restoreDeprovisionEvent.mockRejectedValue(new Error('raw driver text'))
    const res = await invokeRestore({ mode: 'rehire' })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DEPROVISION_RESTORE_FAILED',
        message: 'Restore failed',
        details: undefined,
      },
    })
  })
})

// O2-A1 (census reachability): one discriminating behaviour leg PER remaining
// sendIfRecoveryConflict call site in routes/admin-directory.ts. Every leg injects the
// named retryable RecoveryConflictError at the service seam its handler awaits and
// asserts the EXACT uniform retryable 409 — so `if (false && sendIfRecoveryConflict(...))`
// at that one site turns exactly its leg red (the error would fall through to the
// surface's ORIGINAL non-conflict mapping instead).
describe('recovery conflict boundary — remaining admin-directory write surfaces', () => {
  const namedConflict = () => new RecoveryConflictError(markerError())

  it('[recovery-census:admin-directory:compensate-deny] compensate-orphan-deny: named conflict → exact uniform retryable 409', async () => {
    evidenceMocks.compensateSupersededDenyGrant.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/deprovision-events/:eventId/compensate-orphan-deny', {
      params: { eventId: EVENT_ID },
      body: { confirm: true, note: 'compensating orphan deny row' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('compensate-orphan-deny: coded refusal keeps its ORIGINAL 400 mapping, exactly', async () => {
    evidenceMocks.compensateSupersededDenyGrant.mockRejectedValue(
      Object.assign(new Error('Compensation requires confirm=true'), { code: 'COMPENSATION_CONFIRM_REQUIRED' }),
    )
    const res = await invokeRoute('post', '/deprovision-events/:eventId/compensate-orphan-deny', {
      params: { eventId: EVENT_ID },
      body: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'COMPENSATION_CONFIRM_REQUIRED',
        message: 'Compensation requires confirm=true',
        details: undefined,
      },
    })
  })

  it('[recovery-census:admin-directory:sync] synchronous sync: named conflict from the local apply → exact uniform retryable 409', async () => {
    directorySyncMocks.syncDirectoryIntegration.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
      body: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('synchronous sync: non-conflict failure keeps the ORIGINAL DIRECTORY_SYNC_FAILED 500, exactly', async () => {
    directorySyncMocks.syncDirectoryIntegration.mockRejectedValue(new Error('provider exploded'))
    const res = await invokeRoute('post', '/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
      body: {},
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DIRECTORY_SYNC_FAILED',
        message: 'provider exploded',
        details: undefined,
      },
    })
  })

  it('[recovery-census:admin-directory:sync-async] async sync: named conflict BEFORE the run row exists → exact uniform retryable 409', async () => {
    // Reject before onRunStarted ever fires — the async branch's own catch handles it.
    directorySyncMocks.syncDirectoryIntegration.mockImplementation(async () => {
      throw namedConflict()
    })
    const res = await invokeRoute('post', '/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
      body: { async: true },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('[recovery-census:admin-directory:bind] bind: named conflict from the bind write → exact uniform retryable 409', async () => {
    directorySyncMocks.bindDirectoryAccount.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/:accountId/bind', {
      params: { accountId: 'account-1' },
      body: { localUserRef: 'user-1' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('bind: non-conflict failure keeps the ORIGINAL DIRECTORY_BIND_FAILED mapping, exactly', async () => {
    directorySyncMocks.bindDirectoryAccount.mockRejectedValue(new Error('Local user not found'))
    const res = await invokeRoute('post', '/accounts/:accountId/bind', {
      params: { accountId: 'account-1' },
      body: { localUserRef: 'user-1' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DIRECTORY_BIND_FAILED',
        message: 'Local user not found',
        details: undefined,
      },
    })
  })

  it('[recovery-census:admin-directory:admit-user] admit-user: named conflict from the admission write → exact uniform retryable 409', async () => {
    directorySyncMocks.admitDirectoryAccountUser.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/:accountId/admit-user', {
      params: { accountId: 'account-1' },
      body: { name: 'New User', email: 'new@example.com' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('[recovery-census:admin-directory:batch-bind] batch-bind: named conflict from a bind write → exact uniform retryable 409', async () => {
    directorySyncMocks.batchBindDirectoryAccounts.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/batch-bind', {
      body: { items: [{ accountId: 'account-1', localUserRef: 'user-1' }] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('[recovery-census:admin-directory:batch-admit] batch-admit-users: named conflict from an admission write → exact uniform retryable 409', async () => {
    directorySyncMocks.batchAdmitDirectoryAccountUsers.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/batch-admit-users', {
      body: { items: [{ accountId: 'account-1', name: 'New User', email: 'new@example.com' }] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('[recovery-census:admin-directory:unbind] unbind: named conflict from the unbind write → exact uniform retryable 409', async () => {
    directorySyncMocks.unbindDirectoryAccount.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/:accountId/unbind', {
      params: { accountId: 'account-1' },
      body: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('[recovery-census:admin-directory:batch-unbind] batch-unbind: named conflict from an unbind write → exact uniform retryable 409', async () => {
    directorySyncMocks.batchUnbindDirectoryAccounts.mockRejectedValue(namedConflict())
    const res = await invokeRoute('post', '/accounts/batch-unbind', {
      body: { accountIds: ['account-1'] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })
})
