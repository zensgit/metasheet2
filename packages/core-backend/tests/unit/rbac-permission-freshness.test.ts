/**
 * Post-commit permission reads must follow the database on the next call.
 *
 * `invalidateUserPerms` only moves this process's generation. A second process
 * never sees that call. These tests change the committed rows between reads and
 * do not invalidate, with RBAC_CACHE_TTL_MS pinned to the historical 60s default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.RBAC_CACHE_TTL_MS = '60000'
})

const state = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  query: vi.fn(),
  cacheHits: vi.fn(),
  cacheMiss: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: state.poolQuery },
  query: state.query,
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    rbacPermCacheHits: { inc: state.cacheHits },
    rbacPermCacheMiss: { inc: state.cacheMiss },
  },
}))

import { getPermCacheStatus, listUserPermissions } from '../../src/rbac/service'

type RoleRow = { role_id: string; permission_code: string | null }
type AdmissionRow = {
  namespace: string
  enabled: boolean
  source: string
  granted_by: null
  updated_by: null
  created_at: null
  updated_at: null
}

const committed = {
  unionCodes: [] as string[],
  legacy: [] as string[],
  roles: [] as RoleRow[],
  admissions: [] as AdmissionRow[],
}

function admission(namespace: string, enabled: boolean): AdmissionRow {
  return {
    namespace,
    enabled,
    source: 'platform_admin',
    granted_by: null,
    updated_by: null,
    created_at: null,
    updated_at: null,
  }
}

function installReaders(): void {
  state.poolQuery.mockImplementation(async (sql: string) => {
    const text = String(sql)
    if (text.includes('permission_code AS code')) {
      return { rows: committed.unionCodes.map((code) => ({ code })) }
    }
    if (text.includes('SELECT permissions FROM users')) {
      return { rows: [{ permissions: [...committed.legacy] }] }
    }
    return { rows: [] }
  })
  state.query.mockImplementation(async (sql: string) => {
    const text = String(sql)
    if (text.includes('FROM user_roles')) return { rows: committed.roles.map((row) => ({ ...row })) }
    if (text.includes('user_namespace_admissions')) {
      return { rows: committed.admissions.map((row) => ({ ...row })) }
    }
    return { rows: [] }
  })
}

describe('rbac permission freshness across a committed change this process did not invalidate', () => {
  beforeEach(() => {
    committed.unionCodes = []
    committed.legacy = []
    committed.roles = []
    committed.admissions = []
    state.poolQuery.mockReset()
    state.query.mockReset()
    state.cacheHits.mockReset()
    state.cacheMiss.mockReset()
    installReaders()
  })

  it('sees role, direct, and legacy code changes on the next list', async () => {
    const userId = 'user-source-change'
    expect(await listUserPermissions(userId)).toEqual([])

    committed.unionCodes = ['workflow:read']
    committed.roles = [{ role_id: 'user', permission_code: 'workflow:read' }]
    expect(await listUserPermissions(userId)).toEqual(['workflow:read'])

    committed.unionCodes = ['workflow:write']
    committed.roles = [{ role_id: 'user', permission_code: 'workflow:write' }]
    expect(await listUserPermissions(userId)).toEqual(['workflow:write'])

    committed.unionCodes = ['spreadsheets:read', 'workflow:write']
    expect(await listUserPermissions(userId)).toEqual(['spreadsheets:read', 'workflow:write'])

    committed.unionCodes = []
    committed.roles = []
    committed.legacy = ['spreadsheets:write']
    expect(await listUserPermissions(userId)).toEqual(['spreadsheets:write'])

    committed.legacy = []
    expect(await listUserPermissions(userId)).toEqual([])
    expect(state.cacheHits).not.toHaveBeenCalled()
    expect(state.cacheMiss).toHaveBeenCalledTimes(6)
    expect(getPermCacheStatus()).toMatchObject({ cacheSize: 0, ttlMs: 60000, keys: [] })
  })

  it('drops a direct namespaced code when the holder role is gone and shows it again when admission is restored', async () => {
    const userId = 'user-stock-prep-holder'
    committed.unionCodes = ['stock-prep:read', 'stock-prep:admin']
    committed.roles = [{ role_id: 'stock-prep_admin', permission_code: 'stock-prep:admin' }]
    committed.admissions = [admission('stock-prep', true)]

    expect(await listUserPermissions(userId)).toEqual(['stock-prep:read', 'stock-prep:admin'])

    // Other process: last namespace-holder role revoked, direct stock-prep:read kept.
    committed.unionCodes = ['stock-prep:read']
    committed.roles = []
    const readsBeforeDenied = state.poolQuery.mock.calls.length
    expect(await listUserPermissions(userId)).toEqual([])
    expect(state.poolQuery.mock.calls.length).toBeGreaterThan(readsBeforeDenied)

    committed.admissions = [admission('stock-prep', false)]
    committed.roles = [{ role_id: 'stock-prep_admin', permission_code: 'stock-prep:read' }]
    committed.unionCodes = ['stock-prep:read']
    expect(await listUserPermissions(userId)).toEqual([])

    committed.admissions = [admission('stock-prep', true)]
    expect(await listUserPermissions(userId)).toEqual(['stock-prep:read'])
    expect(state.cacheHits).not.toHaveBeenCalled()
    expect(getPermCacheStatus().cacheSize).toBe(0)
  })

  it('does not publish a caller-transaction snapshot to the next pool read', async () => {
    const userId = 'user-tx-not-memo'
    committed.unionCodes = ['spreadsheets:read']
    const txQuery = vi.fn(async (sql: string) => {
      const text = String(sql)
      if (text.includes('permission_code AS code')) return { rows: [{ code: 'workflow:read' }] }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      if (text.includes('FROM user_roles')) return { rows: [{ role_id: 'user', permission_code: 'workflow:read' }] }
      if (text.includes('user_namespace_admissions')) return { rows: [] }
      throw new Error(`unexpected statement: ${text}`)
    })

    expect(await listUserPermissions(userId, txQuery)).toEqual(['workflow:read'])
    expect(state.cacheMiss).not.toHaveBeenCalled()
    expect(await listUserPermissions(userId)).toEqual(['spreadsheets:read'])
    expect(state.poolQuery).toHaveBeenCalled()
    expect(getPermCacheStatus().keys).toEqual([])
  })
})
