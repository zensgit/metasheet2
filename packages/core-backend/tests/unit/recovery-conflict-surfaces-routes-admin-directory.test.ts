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

async function invokeRestore(body: Record<string, unknown>) {
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
    (entry) =>
      entry.route?.path === '/deprovision/events/:eventId/restore'
      && entry.route?.methods?.post,
  )
  if (!layer?.route) throw new Error('restore route not found')
  const res = mockResponse()
  const req = {
    method: 'POST',
    headers: {},
    query: {},
    params: { eventId: EVENT_ID },
    body,
    // admin-directory uses its OWN ensurePlatformAdmin (module-local, not the
    // admin-users export) — the legacy role claim short-circuits its RBAC DB read.
    user: { id: 'admin-1', role: 'admin' },
  } as unknown as Request
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, (err?: unknown) => {
    if (err) throw err
  })
  return res
}

beforeEach(() => {
  adminUsersMocks.ensurePlatformAdmin.mockReset()
  adminUsersMocks.ensurePlatformAdmin.mockResolvedValue('admin-1')
  evidenceMocks.restoreDeprovisionEvent.mockReset()
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
})

describe('POST /deprovision/events/:eventId/restore — recovery conflict boundary', () => {
  it('the named RecoveryConflictError from the service → exact uniform retryable 409', async () => {
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
