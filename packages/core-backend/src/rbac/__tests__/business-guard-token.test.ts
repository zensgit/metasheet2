import type { Request } from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GuardLookups } from '../rbac'

let evaluate: typeof import('../rbac').evaluateRequestGuard
beforeAll(async () => {
  vi.stubEnv('RBAC_TOKEN_TRUST', 'true')
  vi.resetModules()
  evaluate = (await import('../rbac')).evaluateRequestGuard
})
afterAll(() => vi.unstubAllEnvs())

function fixture(permissions: string[], perms: string[]) {
  const req = { user: { id: 'subject', role: 'user', permissions, perms } } as unknown as Request
  const lookups: GuardLookups = {
    admission: vi.fn().mockResolvedValue(true),
    isAdmin: vi.fn().mockResolvedValue(false),
    hasPermission: vi.fn().mockResolvedValue(false),
    listPermissions: vi.fn().mockResolvedValue([]),
  }
  return { req, lookups }
}

describe('shared evaluator with trusted token claims', () => {
  it('checks admission for matching token permissions', async () => {
    const { req, lookups } = fixture([], ['a:*'])
    vi.mocked(lookups.admission).mockResolvedValue(false)
    expect(await evaluate(req, 'single', ['a:read'], lookups)).toBe(false)
    expect(lookups.admission).toHaveBeenCalledWith('subject', 'a:read')
  })

  it('does not combine resolved and token branches for all', async () => {
    const { req, lookups } = fixture(['a:read'], ['b:read'])
    expect(await evaluate(req, 'all', ['a:read', 'b:read'], lookups)).toBe(false)
    expect(lookups.listPermissions).toHaveBeenCalledOnce()
  })

  it('short circuits any token match before DB lookup', async () => {
    const { req, lookups } = fixture([], ['a:*'])
    expect(await evaluate(req, 'any', ['a:read', 'b:read'], lookups)).toBe(true)
    expect(lookups.isAdmin).not.toHaveBeenCalled()
  })
})
