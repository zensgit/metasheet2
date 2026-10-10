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
import { userHasEffectiveNamespaceAccess } from '../../src/rbac/namespace-admission'

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

  // S5b lock redesign: a caller deciding inside its own transaction (the stock-prep members port)
  // hands its transaction query; every statement of the read must run there, never on the pool.
  it('on a caller transaction query: every statement runs on it, the pool and the permission memo are untouched', async () => {
    const statements: string[] = []
    const txQuery = vi.fn(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim()
      statements.push(text.slice(0, 40))
      if (text.includes('AS code FROM')) return { rows: [{ code: 'crm:read' }, { code: 'workflow:read' }] }
      if (text.startsWith('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      if (text.includes('FROM user_roles ur LEFT JOIN role_permissions')) return { rows: [{ role_id: 'crm_operator', permission_code: 'crm:read' }] }
      if (text.includes('FROM user_namespace_admissions')) {
        return { rows: [{ namespace: 'crm', enabled: true, source: 'platform_admin', granted_by: null, updated_by: null, created_at: null, updated_at: null }] }
      }
      throw new Error(`unexpected statement: ${text}`)
    })

    const permissions = await listUserPermissions('user-tx', txQuery)
    expect(permissions.sort()).toEqual(['crm:read', 'workflow:read'])
    expect(statements).toHaveLength(4)
    expect(state.poolQuery).not.toHaveBeenCalled()
    expect(state.query).not.toHaveBeenCalled()
    // Not served from, nor written to, the memo: a pool read afterwards misses and reads the pool.
    expect(state.cacheHits).not.toHaveBeenCalled()
    expect(state.cacheMiss).not.toHaveBeenCalled()

    state.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    await listUserPermissions('user-tx')
    expect(state.cacheMiss).toHaveBeenCalledTimes(1)
    expect(state.poolQuery).toHaveBeenCalledTimes(2)
  })

  it('userHasEffectiveNamespaceAccess on a caller transaction query reads both admission inputs there, one after the other', async () => {
    const order: string[] = []
    const txQuery = vi.fn(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text.includes('FROM user_roles ur LEFT JOIN role_permissions')) {
        order.push('roles')
        return { rows: [{ role_id: 'stock-prep_admin', permission_code: 'stock-prep:admin' }] }
      }
      if (text.includes('FROM user_namespace_admissions')) {
        order.push('admissions')
        return { rows: [{ namespace: 'stock-prep', enabled: false, source: 'platform_admin', granted_by: null, updated_by: null, created_at: null, updated_at: null }] }
      }
      throw new Error(`unexpected statement: ${text}`)
    })
    await expect(userHasEffectiveNamespaceAccess('user-tx', 'stock-prep', txQuery)).resolves.toBe(false)
    expect(order).toEqual(['roles', 'admissions'])
    expect(state.query).not.toHaveBeenCalled()
    expect(state.poolQuery).not.toHaveBeenCalled()
  })
})
