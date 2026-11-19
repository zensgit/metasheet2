import type { Request } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { evaluateRequestGuard, type GuardLookups } from '../rbac'

function fixture(permissions: string[] = []) {
  const req = { user: { id: 'subject', role: 'user', permissions } } as Request
  const lookups: GuardLookups = {
    admission: vi.fn().mockResolvedValue(true),
    isAdmin: vi.fn().mockResolvedValue(false),
    hasPermission: vi.fn().mockResolvedValue(false),
    listPermissions: vi.fn().mockResolvedValue([]),
  }
  return { req, lookups }
}

describe('shared business guard evaluator', () => {
  it('requires admission for a resolved wildcard and falls through on denial', async () => {
    const { req, lookups } = fixture(['stock-prep:*'])
    vi.mocked(lookups.admission).mockResolvedValue(false)
    expect(await evaluateRequestGuard(req, 'single', ['stock-prep:read'], lookups)).toBe(false)
    expect(lookups.admission).toHaveBeenCalledWith('subject', 'stock-prep:read')
    expect(lookups.hasPermission).toHaveBeenCalledOnce()
  })

  it('does not equate write with read', async () => {
    const { req, lookups } = fixture(['approvals:write'])
    expect(await evaluateRequestGuard(req, 'single', ['approvals:read'], lookups)).toBe(false)
    expect(lookups.admission).not.toHaveBeenCalled()
  })

  it('scans any in order and stops before later lookups', async () => {
    const { req, lookups } = fixture(['a:read', 'b:read'])
    vi.mocked(lookups.admission).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await evaluateRequestGuard(req, 'any', ['a:read', 'b:read'], lookups)).toBe(true)
    expect(vi.mocked(lookups.admission).mock.calls).toEqual([['subject', 'a:read'], ['subject', 'b:read']])
    expect(lookups.isAdmin).not.toHaveBeenCalled()
  })

  it('keeps all DB fallback exact and does not combine branches', async () => {
    const { req, lookups } = fixture(['a:read'])
    vi.mocked(lookups.listPermissions).mockResolvedValue(['a:*', 'b:read'])
    expect(await evaluateRequestGuard(req, 'all', ['a:read', 'b:read'], lookups)).toBe(false)
    expect(lookups.hasPermission).not.toHaveBeenCalled()
  })

  it('preserves empty any and all branch ordering', async () => {
    const { req, lookups } = fixture()
    expect(await evaluateRequestGuard(req, 'any', [], lookups)).toBe(false)
    expect(lookups.isAdmin).toHaveBeenCalledOnce()
    vi.mocked(lookups.isAdmin).mockClear()
    expect(await evaluateRequestGuard(req, 'all', [], lookups)).toBe(true)
    expect(lookups.isAdmin).not.toHaveBeenCalled()
  })

  it('propagates visited lookup failures and skips unvisited ones', async () => {
    const { req, lookups } = fixture(['a:read'])
    vi.mocked(lookups.isAdmin).mockRejectedValue(new Error('unavailable'))
    expect(await evaluateRequestGuard(req, 'any', ['a:read'], lookups)).toBe(true)
    await expect(evaluateRequestGuard(req, 'any', ['b:read'], lookups)).rejects.toThrow('unavailable')
  })
})
