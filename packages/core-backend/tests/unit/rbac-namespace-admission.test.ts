import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  query: vi.fn(),
  cacheHits: vi.fn(),
  cacheMiss: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: {
    query: state.poolQuery,
  },
  query: state.query,
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    rbacPermCacheHits: { inc: state.cacheHits },
    rbacPermCacheMiss: { inc: state.cacheMiss },
  },
}))

import { listUserPermissions, userHasPermission } from '../../src/rbac/service'

describe('rbac namespace admission', () => {
  beforeEach(() => {
    state.poolQuery.mockReset()
    state.query.mockReset()
    state.cacheHits.mockReset()
    state.cacheMiss.mockReset()
  })

  it('filters namespaced permissions by role plus admission status', async () => {
    state.poolQuery
      .mockResolvedValueOnce({
        rows: [
          { code: 'attendance:read' },
          { code: 'crm:read' },
          { code: 'workflow:read' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ permissions: ['attendance:write', 'spreadsheets:read'] }],
      })

    state.query
      .mockResolvedValueOnce({
        rows: [
          { role_id: 'attendance_employee', permission_code: 'attendance:read' },
          { role_id: 'crm_operator', permission_code: 'crm:read' },
          { role_id: 'user', permission_code: 'spreadsheets:read' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            namespace: 'attendance',
            enabled: true,
            source: 'seed_backfill',
            granted_by: null,
            updated_by: null,
            created_at: '2026-04-11T00:00:00.000Z',
            updated_at: '2026-04-11T00:00:00.000Z',
          },
          {
            namespace: 'crm',
            enabled: false,
            source: 'platform_admin',
            granted_by: 'admin-1',
            updated_by: 'admin-1',
            created_at: '2026-04-11T00:00:00.000Z',
            updated_at: '2026-04-11T00:00:00.000Z',
          },
        ],
      })

    const permissions = await listUserPermissions('user-1')

    expect(permissions).toEqual([
      'attendance:read',
      'workflow:read',
      'attendance:write',
      'spreadsheets:read',
    ])
  })

  it('denies direct namespaced permissions when namespace admission is disabled', async () => {
    state.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator', permission_code: 'crm:read' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          namespace: 'crm',
          enabled: false,
          source: 'platform_admin',
          granted_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-04-11T00:00:00.000Z',
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
      })

    const allowed = await userHasPermission('user-1', 'crm:read')

    expect(allowed).toBe(false)
    expect(state.poolQuery).not.toHaveBeenCalled()
  })
})
