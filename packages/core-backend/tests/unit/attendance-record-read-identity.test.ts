import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { resolveAttendanceRecordReadIdentity } = require('../../../../plugins/plugin-attendance/lib/attendance-record-read-identity.cjs')

function resolve(overrides: Record<string, unknown> = {}) {
  const req = { user: { id: 'actor' }, authenticatedTenantId: 'org-a', headers: {}, query: {}, body: {}, ...overrides }
  const response = { status: vi.fn(), json: vi.fn() }
  response.status.mockReturnValue(response)
  const result = resolveAttendanceRecordReadIdentity(req, response)
  return { result, response }
}

describe('attendance record read trusted identity', () => {
  it('uses the hydrated actor and authenticated tenant, preserving target user selection', () => {
    expect(resolve({ query: { userId: 'other', orgId: 'org-a' }, headers: { 'x-org-id': 'org-a', 'x-tenant-id': 'org-a', 'x-user-id': 'actor' } }).result)
      .toEqual({ actorId: 'actor', orgId: 'org-a' })
  })

  it('never takes the possibly header-filled user.tenantId as identity', () => {
    expect(resolve({ user: { id: 'actor', tenantId: 'foreign' } }).result).toEqual({ actorId: 'actor', orgId: 'org-a' })
    const denied = resolve({ authenticatedTenantId: undefined, user: { id: 'actor', tenantId: 'org-a' }, headers: { 'x-tenant-id': 'org-a' } })
    expect(denied.result).toBeNull()
    expect(denied.response.status).toHaveBeenCalledWith(403)
  })

  it('does not let actor headers replace authentication', () => {
    const denied = resolve({ user: undefined, headers: { 'x-user-id': 'actor' } })
    expect(denied.result).toBeNull()
    expect(denied.response.status).toHaveBeenCalledWith(401)
  })

  for (const value of ['foreign', '', ' org-a', 'org-a ', null, 7, ['org-a'], ['org-a', 'foreign'], { id: 'org-a' }]) {
    for (const location of ['query', 'body', 'header', 'tenant-header', 'legacy-org', 'legacy-workspace'] as const) {
      it(`rejects invalid selector ${location} / ${JSON.stringify(value)}`, () => {
        const overrides = location === 'query' || location === 'body' ? { [location]: { orgId: value } }
          : location === 'header' ? { headers: { 'x-org-id': value } }
            : location === 'tenant-header' ? { headers: { 'x-tenant-id': value } }
              : { user: { id: 'actor', [location === 'legacy-org' ? 'orgId' : 'workspaceId']: value } }
        const denied = resolve(overrides)
        expect(denied.result).toBeNull()
        expect(denied.response.status).toHaveBeenCalledWith(403)
        expect(denied.response.json).toHaveBeenCalledWith({ ok: false, error: { code: 'FORBIDDEN', message: 'Attendance access denied' } })
      })
    }
  }

  it('rejects a forged actor hint without changing the canonical actor', () => {
    const denied = resolve({ headers: { 'x-user-id': 'foreign' } })
    expect(denied.result).toBeNull()
    expect(denied.response.status).toHaveBeenCalledWith(403)
  })
})
