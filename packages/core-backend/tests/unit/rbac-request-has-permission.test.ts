/**
 * `requestHasPermission` answers exactly what `rbacGuard` decides for the same request: every row of
 * the table runs through both. The token-claims setting is read when `rbac.ts` loads, so each row
 * sets the environment and loads a fresh copy of the module.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  userHasPermission: vi.fn(),
  listUserPermissions: vi.fn(),
  entryAllowed: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: state.isAdmin,
  userHasPermission: state.userHasPermission,
  listUserPermissions: state.listUserPermissions,
}))

vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: state.entryAllowed,
}))

const CODE = 'tasks:read'

interface Row {
  name: string
  user: Record<string, unknown>
  trustClaims?: boolean
  entryAllowed?: boolean
  dbAdmin?: boolean
  dbPermission?: boolean
  expected: boolean
}

const ROWS: Row[] = [
  { name: 'role field names admin', user: { id: 'u1', role: 'admin' }, expected: true },
  { name: 'roles list names admin', user: { id: 'u1', roles: ['admin'] }, expected: true },
  { name: 'resolved code, entry allowed', user: { id: 'u1', permissions: [CODE] }, entryAllowed: true, expected: true },
  { name: 'resolved code, entry not allowed', user: { id: 'u1', permissions: [CODE] }, entryAllowed: false, expected: false },
  { name: 'unrelated resolved code', user: { id: 'u1', permissions: ['approvals:read'] }, entryAllowed: true, expected: false },
  { name: 'token claim, claims trusted, entry allowed', user: { id: 'u1', perms: [CODE] }, trustClaims: true, entryAllowed: true, expected: true },
  { name: 'token claim, claims trusted, entry not allowed', user: { id: 'u1', perms: [CODE] }, trustClaims: true, entryAllowed: false, expected: false },
  { name: 'token claim, claims not trusted', user: { id: 'u1', perms: [CODE] }, trustClaims: false, entryAllowed: true, expected: false },
  { name: 'database admin row', user: { id: 'u1' }, dbAdmin: true, expected: true },
  { name: 'database permission', user: { id: 'u1' }, dbPermission: true, expected: true },
  { name: 'nothing held', user: { id: 'u1' }, expected: false },
]

function fakeResponse(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
  } as unknown as Response & { statusCode?: number; body?: unknown }
  return res
}

async function loadRbac(trustClaims: boolean) {
  vi.resetModules()
  if (trustClaims) process.env.RBAC_TOKEN_TRUST = 'true'
  else delete process.env.RBAC_TOKEN_TRUST
  return import('../../src/rbac/rbac')
}

describe('requestHasPermission answers what rbacGuard decides', () => {
  const originalTrust = process.env.RBAC_TOKEN_TRUST

  beforeEach(() => {
    state.isAdmin.mockReset().mockResolvedValue(false)
    state.userHasPermission.mockReset().mockResolvedValue(false)
    state.entryAllowed.mockReset().mockResolvedValue(false)
  })

  afterEach(() => {
    if (originalTrust === undefined) delete process.env.RBAC_TOKEN_TRUST
    else process.env.RBAC_TOKEN_TRUST = originalTrust
  })

  for (const row of ROWS) {
    it(`${row.name} -> ${row.expected}`, async () => {
      state.entryAllowed.mockResolvedValue(row.entryAllowed ?? false)
      state.isAdmin.mockResolvedValue(row.dbAdmin ?? false)
      state.userHasPermission.mockResolvedValue(row.dbPermission ?? false)
      const { rbacGuard, requestHasPermission } = await loadRbac(row.trustClaims ?? false)
      const req = { user: row.user } as unknown as Request

      await expect(requestHasPermission(req, CODE)).resolves.toBe(row.expected)

      const res = fakeResponse()
      const next = vi.fn() as unknown as NextFunction
      await rbacGuard(CODE)(req, res, next)
      expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(row.expected ? 1 : 0)
      if (row.expected) {
        expect(res.statusCode).toBeUndefined()
      } else {
        expect(res.statusCode).toBe(403)
        expect(res.body).toEqual({ error: 'Insufficient permissions' })
      }
    })
  }

  it('an admin named on the request needs no lookup', async () => {
    const { requestHasPermission } = await loadRbac(false)
    await requestHasPermission({ user: { id: 'u1', role: 'admin' } } as unknown as Request, CODE)
    expect(state.entryAllowed).not.toHaveBeenCalled()
    expect(state.isAdmin).not.toHaveBeenCalled()
    expect(state.userHasPermission).not.toHaveBeenCalled()
  })

  it('no user id: false from the function, 401 from the guard', async () => {
    const { rbacGuard, requestHasPermission } = await loadRbac(false)
    const req = { user: undefined } as unknown as Request
    await expect(requestHasPermission(req, CODE)).resolves.toBe(false)

    const res = fakeResponse()
    const next = vi.fn() as unknown as NextFunction
    await rbacGuard(CODE)(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })

  it('a failed lookup: thrown by the function, 500 from the guard', async () => {
    state.isAdmin.mockRejectedValue(new Error('lookup failed'))
    const { rbacGuard, requestHasPermission } = await loadRbac(false)
    const req = { user: { id: 'u1' } } as unknown as Request
    await expect(requestHasPermission(req, CODE)).rejects.toThrow('lookup failed')

    const res = fakeResponse()
    const next = vi.fn() as unknown as NextFunction
    await rbacGuard(CODE)(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Permission check failed' })
  })

  it('the two-argument guard form checks the same code', async () => {
    state.userHasPermission.mockResolvedValue(true)
    const { rbacGuard } = await loadRbac(false)
    const next = vi.fn() as unknown as NextFunction
    await rbacGuard('tasks', 'read')({ user: { id: 'u1' } } as unknown as Request, fakeResponse(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(state.userHasPermission).toHaveBeenCalledWith('u1', CODE)
  })
})
