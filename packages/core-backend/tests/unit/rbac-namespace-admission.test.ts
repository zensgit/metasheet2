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

import { inspectUserPermissionGrants, invalidateUserPerms, listUserPermissions, userHasPermission } from '../../src/rbac/service'
import { rbacGuard } from '../../src/rbac/rbac'
import { userHasEffectiveNamespaceAccess } from '../../src/rbac/namespace-admission'

function deferred<T>() {
  let release!: (value: T) => void
  let started!: () => void
  const gate = new Promise<T>((resolve) => { release = resolve })
  const startedGate = new Promise<void>((resolve) => { started = resolve })
  return { release, started, gate, startedGate }
}

async function invokeWorkflowGuard(userId: string, permissions: string[]): Promise<{ nextCalled: boolean; statusCode: number }> {
  const handler = rbacGuard('workflow:read')
  let nextCalled = false
  let statusCode = 0
  const req = { user: { id: userId, permissions, roles: [] } }
  const res = {
    status(code: number) {
      statusCode = code
      return this
    },
    json() {
      return this
    },
  }
  await handler(req as never, res as never, (() => { nextCalled = true }) as never)
  return { nextCalled, statusCode }
}

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

  // Final review (M26): the in-lock read of the grantor's codes "bypasses the 60 s cache" — the test above
  // starts from a COLD memo, so a transaction branch that returned a cache hit first survived it. Warm
  // the memo through the pool path, then read on a transaction query that answers a DIFFERENT set.
  it('on a caller transaction query: a WARM memo is bypassed — the transaction\'s codes come back, no cache hit is counted, the memo is not overwritten', async () => {
    const userId = 'user-warm-m26'
    state.query.mockResolvedValue({ rows: [] })
    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'workflow:read' }, { code: 'spreadsheets:read' }] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    expect((await listUserPermissions(userId)).sort()).toEqual(['spreadsheets:read', 'workflow:read'])
    expect(state.cacheMiss).toHaveBeenCalledTimes(1)
    // The memo is warm: a second pool-path read is a hit and issues no statement.
    expect((await listUserPermissions(userId)).sort()).toEqual(['spreadsheets:read', 'workflow:read'])
    expect(state.cacheHits).toHaveBeenCalledTimes(1)
    const poolCalls = state.poolQuery.mock.calls.length

    const txQuery = vi.fn(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text.includes('AS code FROM')) return { rows: [{ code: 'workflow:read' }] }
      if (text.startsWith('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })
    const fromTx = await listUserPermissions(userId, txQuery)
    expect(fromTx).toEqual(['workflow:read'])
    expect(txQuery).toHaveBeenCalled()
    expect(state.cacheHits).toHaveBeenCalledTimes(1)
    expect(state.cacheMiss).toHaveBeenCalledTimes(1)
    expect(state.poolQuery).toHaveBeenCalledTimes(poolCalls)
    // Nor written back: the pool path still serves the memo's two codes.
    expect((await listUserPermissions(userId)).sort()).toEqual(['spreadsheets:read', 'workflow:read'])
    expect(state.cacheHits).toHaveBeenCalledTimes(2)
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

  it('inspects a direct namespaced grant as persisted-but-blocked while listUserPermissions stays admission-filtered', async () => {
    const userId = 'user-inspect-direct'
    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }, { code: 'workflow:read' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    state.query
      .mockResolvedValueOnce({ rows: [] })
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

    const inspection = await inspectUserPermissionGrants(userId)

    expect(inspection.direct).toEqual(['crm:read', 'workflow:read'])
    expect(inspection.inherited).toEqual([])
    expect(inspection.legacy).toEqual([])
    expect(inspection.effective).toEqual(['workflow:read'])
    expect(inspection.blockedByNamespaceAdmission).toEqual(['crm:read'])
    expect(state.cacheHits).not.toHaveBeenCalled()
    expect(state.cacheMiss).not.toHaveBeenCalled()

    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }, { code: 'workflow:read' }] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    state.query
      .mockResolvedValueOnce({ rows: [] })
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

    const listed = await listUserPermissions(userId)
    expect(listed).toEqual(['workflow:read'])
    expect(inspection.effective).toEqual(listed)
  })

  it('inspectUserPermissionGrants issues only SELECTs and never writes admissions', async () => {
    const userId = 'user-inspect-select-only'
    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
      .mockResolvedValueOnce({ rows: [{ code: 'crm:write' }] })
      .mockResolvedValueOnce({ rows: [{ permissions: ['workflow:read'] }] })
    state.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator', permission_code: 'crm:write' }],
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

    const inspection = await inspectUserPermissionGrants(userId)

    expect(inspection.direct).toEqual(['crm:read'])
    expect(inspection.inherited).toEqual(['crm:write'])
    expect(inspection.legacy).toEqual(['workflow:read'])
    expect(inspection.effective).toEqual(['workflow:read'])
    expect(inspection.blockedByNamespaceAdmission).toEqual(['crm:read', 'crm:write'])

    const statements = [...state.poolQuery.mock.calls, ...state.query.mock.calls]
      .map((call) => String(call[0]))
    expect(statements).toHaveLength(5)
    for (const sql of statements) {
      expect(sql).toMatch(/^\s*SELECT\b/i)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    }
    expect(statements.some((sql) => sql.includes('user_permissions'))).toBe(true)
    expect(statements.some((sql) => sql.includes('role_permissions'))).toBe(true)
    expect(statements.some((sql) => sql.includes('user_namespace_admissions'))).toBe(true)
    expect(statements.join('\n')).not.toMatch(/user_orgs/)
  })

  it('discards a partial inspection when a later source SELECT is 42P01', async () => {
    const previous = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    try {
      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
        .mockRejectedValueOnce(
          Object.assign(new Error('relation "role_permissions" does not exist'), { code: '42P01' }),
        )
      const inspection = await inspectUserPermissionGrants('user-partial-schema')
      expect(inspection.unavailable).toBe(true)
      expect(inspection.direct).toEqual([])
      expect(inspection.inherited).toEqual([])
      expect(inspection.effective).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('marks inspection unavailable on 42P01 instead of returning healthy empty grants', async () => {
    const previous = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    try {
      state.poolQuery.mockRejectedValueOnce(
        Object.assign(new Error('relation "role_permissions" does not exist'), { code: '42P01' }),
      )
      const inspection = await inspectUserPermissionGrants('user-schema-missing')
      expect(inspection.unavailable).toBe(true)
      expect(inspection.direct).toEqual([])
      expect(inspection.inherited).toEqual([])
      expect(inspection.legacy).toEqual([])
      expect(inspection.effective).toEqual([])
      expect(inspection.blockedByNamespaceAdmission).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('propagates a generic database error from inspection instead of empty grants', async () => {
    state.poolQuery.mockRejectedValueOnce(
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    )
    await expect(inspectUserPermissionGrants('user-db-down')).rejects.toMatchObject({ code: '57P01' })
  })

  it('throws 42P01 from inspection when RBAC_OPTIONAL is off', async () => {
    const previous = process.env.RBAC_OPTIONAL
    delete process.env.RBAC_OPTIONAL
    try {
      state.poolQuery.mockRejectedValueOnce(
        Object.assign(new Error('relation "role_permissions" does not exist'), { code: '42P01' }),
      )
      await expect(inspectUserPermissionGrants('user-schema-required')).rejects.toMatchObject({ code: '42P01' })
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('marks inspection unavailable when optional admission fallback hides unread admission rows', async () => {
    const previous = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    try {
      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
        .mockResolvedValueOnce({ rows: [{ code: 'crm:write' }] })
        .mockResolvedValueOnce({ rows: [{ permissions: ['workflow:read'] }] })
      state.query.mockImplementation(async (sql: string) => {
        const text = String(sql)
        if (text.includes('user_namespace_admissions')) {
          throw Object.assign(new Error('relation "user_namespace_admissions" does not exist'), { code: '42P01' })
        }
        if (text.includes('FROM user_roles')) {
          return { rows: [{ role_id: 'crm_operator', permission_code: 'crm:write' }] }
        }
        return { rows: [] }
      })

      const inspection = await inspectUserPermissionGrants('user-admission-unread')
      expect(inspection.unavailable).toBe(true)
      expect(inspection.direct).toEqual([])
      expect(inspection.inherited).toEqual([])
      expect(inspection.legacy).toEqual([])
      expect(inspection.effective).toEqual([])
      expect(inspection.blockedByNamespaceAdmission).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('marks inspection unavailable when optional fallback hides unread role-context rows', async () => {
    const previous = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    try {
      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
      state.query.mockImplementation(async (sql: string) => {
        const text = String(sql)
        if (text.includes('FROM user_roles')) {
          throw Object.assign(new Error('relation "user_roles" does not exist'), { code: '42P01' })
        }
        if (text.includes('user_namespace_admissions')) {
          return {
            rows: [{
              namespace: 'crm',
              enabled: true,
              source: 'platform_admin',
              granted_by: null,
              updated_by: null,
              created_at: null,
              updated_at: null,
            }],
          }
        }
        return { rows: [] }
      })

      const inspection = await inspectUserPermissionGrants('user-role-context-unread')
      expect(inspection.unavailable).toBe(true)
      expect(inspection.effective).toEqual([])
      expect(inspection.blockedByNamespaceAdmission).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('keeps authorization fail-open on unread admissions while inspection stays unavailable', async () => {
    const previous = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    try {
      state.query.mockImplementation(async (sql: string) => {
        const text = String(sql)
        if (text.includes('user_namespace_admissions')) {
          throw Object.assign(new Error('relation "user_namespace_admissions" does not exist'), { code: '42P01' })
        }
        if (text.includes('FROM user_roles')) {
          return { rows: [{ role_id: 'crm_operator', permission_code: 'crm:read' }] }
        }
        return { rows: [] }
      })
      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }, { code: 'workflow:read' }] })
        .mockResolvedValueOnce({ rows: [{ permissions: [] }] })

      const listed = await listUserPermissions('user-auth-fail-open')
      expect(listed.sort()).toEqual(['crm:read', 'workflow:read'])

      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
      const inspection = await inspectUserPermissionGrants('user-auth-fail-open')
      expect(inspection.unavailable).toBe(true)
      expect(inspection.effective).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('propagates a generic admission-table error from inspection instead of empty grants', async () => {
    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    state.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('user_namespace_admissions')) {
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
      }
      return { rows: [{ role_id: 'crm_operator', permission_code: 'crm:read' }] }
    })
    await expect(inspectUserPermissionGrants('user-admission-db-down')).rejects.toMatchObject({ code: '57P01' })
  })

  it('throws 42P01 from unread admissions when RBAC_OPTIONAL is off', async () => {
    const previous = process.env.RBAC_OPTIONAL
    delete process.env.RBAC_OPTIONAL
    try {
      state.poolQuery
        .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
      state.query.mockImplementation(async (sql: string) => {
        const text = String(sql)
        if (text.includes('user_namespace_admissions')) {
          throw Object.assign(new Error('relation "user_namespace_admissions" does not exist'), { code: '42P01' })
        }
        return { rows: [{ role_id: 'crm_operator', permission_code: 'crm:read' }] }
      })
      await expect(inspectUserPermissionGrants('user-admission-required')).rejects.toMatchObject({ code: '42P01' })
    } finally {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    }
  })

  it('does not store an in-flight authorization memo after invalidateUserPerms', async () => {
    const userId = 'user-inflight-memo'
    const revokedCodes = ['workflow:read']
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const startedGate = new Promise<void>((resolve) => { started = resolve })
    let unionReads = 0
    state.query.mockResolvedValue({ rows: [] })
    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('permission_code AS code')) {
        unionReads += 1
        if (unionReads === 1) {
          started()
          await gate
          // Pre-revoke snapshot that completes only after invalidateUserPerms.
          return { rows: revokedCodes.map((code) => ({ code })) }
        }
        return { rows: [] }
      }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })

    const pending = listUserPermissions(userId)
    await startedGate
    invalidateUserPerms(userId)
    release()
    const firstRead = await pending
    expect(firstRead).toEqual([])
    expect(firstRead).not.toEqual(revokedCodes)
    expect(unionReads).toBeGreaterThanOrEqual(2)
    const unionReadsAfterRetry = unionReads

    // If the deferred pre-revoke result had been cache.set, the next list would
    // return workflow:read even after this poisoned miss source.
    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('permission_code AS code')) {
        unionReads += 1
        return { rows: revokedCodes.map((code) => ({ code })) }
      }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })
    await expect(listUserPermissions(userId)).resolves.toEqual([])
    expect(unionReads).toBe(unionReadsAfterRetry)
    expect(state.cacheHits).toHaveBeenCalled()

    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM user_permissions')) return { rows: [] }
      if (text.includes('FROM user_roles')) return { rows: [] }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })
    state.query.mockResolvedValue({ rows: [] })
    await expect(userHasPermission(userId, 'workflow:read')).resolves.toBe(false)
  })

  it('fails closed when a second invalidation lands during the bounded retry', async () => {
    const userId = 'user-second-invalidation'
    const revokedCodes = ['workflow:read']
    let unionReads = 0
    const first = deferred<void>()
    const second = deferred<void>()
    state.query.mockResolvedValue({ rows: [] })
    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('permission_code AS code')) {
        unionReads += 1
        if (unionReads === 1) {
          first.started()
          await first.gate
          return { rows: revokedCodes.map((code) => ({ code })) }
        }
        if (unionReads === 2) {
          second.started()
          await second.gate
          return { rows: revokedCodes.map((code) => ({ code })) }
        }
        return { rows: [{ code: 'spreadsheets:read' }] }
      }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })

    const pending = listUserPermissions(userId)
    await first.startedGate
    invalidateUserPerms(userId)
    first.release()
    const sawRetry = await Promise.race([
      second.startedGate.then(() => 'retry' as const),
      pending.then(() => 'returned' as const),
    ])
    expect(sawRetry).toBe('retry')
    invalidateUserPerms(userId)
    second.release()

    const returned = await pending
    expect(returned).toEqual([])
    expect(returned).not.toEqual(revokedCodes)
    expect(unionReads).toBe(2)

    const denied = await invokeWorkflowGuard(userId, returned)
    expect(denied.nextCalled).toBe(false)
    expect(denied.statusCode).toBe(403)

    // The actual guard allows a resolved profile that still carries the revoked
    // code, before the live permission query. This caller must not receive it.
    const allowed = await invokeWorkflowGuard(userId, revokedCodes)
    expect(allowed.nextCalled).toBe(true)
    expect(allowed.statusCode).toBe(0)

    const missesBeforeFreshRead = state.cacheMiss.mock.calls.length
    const hitsBeforeFreshRead = state.cacheHits.mock.calls.length
    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('permission_code AS code')) {
        unionReads += 1
        return { rows: [{ code: 'spreadsheets:read' }] }
      }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })
    await expect(listUserPermissions(userId)).resolves.toEqual(['spreadsheets:read'])
    expect(unionReads).toBe(3)
    expect(state.cacheMiss.mock.calls.length).toBe(missesBeforeFreshRead + 1)
    expect(state.cacheHits.mock.calls.length).toBe(hitsBeforeFreshRead)
  })

  it('drops a warm authorization memo on invalidate so the next list is a fresh miss', async () => {
    const userId = 'user-warm-invalidate'
    state.query.mockResolvedValue({ rows: [] })
    state.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'workflow:read' }] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    expect(await listUserPermissions(userId)).toEqual(['workflow:read'])
    expect(state.cacheMiss).toHaveBeenCalledTimes(1)
    expect(await listUserPermissions(userId)).toEqual(['workflow:read'])
    expect(state.cacheHits).toHaveBeenCalledTimes(1)

    invalidateUserPerms(userId)
    state.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ permissions: [] }] })
    expect(await listUserPermissions(userId)).toEqual([])
    expect(state.cacheMiss).toHaveBeenCalledTimes(2)
    state.poolQuery.mockResolvedValue({ rows: [] })
    await expect(userHasPermission(userId, 'workflow:read')).resolves.toBe(false)
  })
})
