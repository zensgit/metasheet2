/**
 * 备料「成员与权限」(S5b, R-39) — the HOST WIRING of the members port: the real dependencies the
 * port is built with. The guards themselves are driven by stock-preparation-members.test.ts against
 * counting fakes; this file proves the fakes stand for the right host primitives.
 *
 *   SW-01 query / transaction go to db/pg (the pool; a transaction client for writes).
 *   SW-02 isPlatformAdmin is rbac/service.ts `isAdmin` (the DB admin role, not a token claim).
 *   SW-03 listEffectivePermissions DROPS the actor's permission memo before reading — the grantor
 *         bound (invariant 1) reads CURRENT codes, never a cached list.
 *   SW-04 hasEffectiveNamespaceAdmission is namespace-admission.ts `userHasEffectiveNamespaceAccess`.
 *   SW-05 resolveReadableSheetIds is permission-service.ts `resolveReadableSheetIds` with an access
 *         snapshot built from the same two rbac reads (permissions + DB admin flag).
 *   SW-06 auditLog is audit/audit.ts `auditLog`.
 *   SW-07 the switch is read from process.env on every call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transaction: vi.fn(),
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
  userHasEffectiveNamespaceAccess: vi.fn(),
  resolveReadableSheetIds: vi.fn(),
  auditLog: vi.fn(),
  order: [] as string[],
}))

vi.mock('../../src/db/pg', () => ({ query: mocks.poolQuery, transaction: mocks.transaction }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: mocks.isAdmin,
  listUserPermissions: mocks.listUserPermissions,
  invalidateUserPerms: mocks.invalidateUserPerms,
}))
vi.mock('../../src/rbac/namespace-admission', async () => ({
  ...(await vi.importActual<typeof import('../../src/rbac/namespace-admission')>('../../src/rbac/namespace-admission')),
  userHasEffectiveNamespaceAccess: mocks.userHasEffectiveNamespaceAccess,
}))
vi.mock('../../src/multitable/permission-service', () => ({ resolveReadableSheetIds: mocks.resolveReadableSheetIds }))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.auditLog }))

import { createStockPrepMembersHostPort } from '../../src/services/stock-preparation-members-host'

const ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'

describe('stock-prep members port — host wiring (S5b, R-39)', () => {
  afterEach(() => {
    delete process.env[ENV]
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    process.env[ENV] = 'true'
    mocks.invalidateUserPerms.mockImplementation((userId: string) => { mocks.order.push(`invalidate:${userId}`) })
    mocks.listUserPermissions.mockImplementation(async (userId: string) => { mocks.order.push(`list:${userId}`); return ['stock-prep:admin'] })
    mocks.isAdmin.mockResolvedValue(false)
    mocks.userHasEffectiveNamespaceAccess.mockResolvedValue(true)
    mocks.resolveReadableSheetIds.mockImplementation(async (_req: unknown, _query: unknown, sheetIds: string[]) => new Set(sheetIds))
    mocks.auditLog.mockResolvedValue(undefined)
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ')
      if (text.includes('AS held FROM user_roles')) return { rows: [{ held: 1 }], rowCount: 1 }
      if (text.includes('AS configured')) return { rows: [{ configured: true }], rowCount: 1 }
      if (text.startsWith('SELECT id FROM roles WHERE id = $1')) return { rows: [{ id: 'stock-prep_c_0a1b2c3d' }], rowCount: 1 }
      if (text.includes('SELECT user_id FROM user_roles WHERE role_id')) return { rows: [], rowCount: 0 }
      if (text.includes('COUNT(*)')) return { rows: [{ c: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    mocks.transaction.mockImplementation(async (handler: (client: { query: typeof mocks.poolQuery }) => Promise<unknown>) => handler({
      query: vi.fn(async (sql: string) => {
        const text = sql.replace(/\s+/g, ' ')
        if (text.startsWith('SELECT code FROM permissions')) return { rows: [{ code: 'stock-prep:read' }], rowCount: 1 }
        if (text.startsWith('INSERT INTO roles')) return { rows: [{ id: 'x' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }) as never,
    }))
  })

  it('SW-01..04, SW-06: a create runs the DB admin check, the fresh grantor read, the admission check, a pool transaction and the audit writer', async () => {
    const port = createStockPrepMembersHostPort()
    const result = await port.createCustomRole({ actorId: 'u_delegated', name: '甲', permissionCodes: ['stock-prep:read'] })
    expect(result.roleId).toMatch(/^stock-prep_c_[0-9a-f]{8}$/)
    expect(mocks.isAdmin).toHaveBeenCalledWith('u_delegated')
    expect(mocks.userHasEffectiveNamespaceAccess).toHaveBeenCalledWith('u_delegated', 'stock-prep')
    // SW-03: the memo is dropped BEFORE the codes are read.
    expect(mocks.order.slice(0, 2)).toEqual(['invalidate:u_delegated', 'list:u_delegated'])
    expect(mocks.poolQuery).toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.auditLog).toHaveBeenCalledTimes(1)
    expect(mocks.auditLog.mock.calls[0][0]).toMatchObject({ actorId: 'u_delegated', actorType: 'user', action: 'create', resourceType: 'role' })
  })

  it('SW-05: readability is the grid resolver, with the actor\'s permissions and DB admin flag', async () => {
    mocks.isAdmin.mockResolvedValue(false)
    const port = createStockPrepMembersHostPort()
    const granted: string[] = []
    await port.grantCustomRoleProjectSheets({
      actorId: 'u_delegated',
      roleId: 'stock-prep_c_0a1b2c3d',
      resolveTargets: async () => [{ sheetId: 'sheet_a', grant: async () => { granted.push('sheet_a'); return { granted: true } } }],
    })
    expect(mocks.resolveReadableSheetIds).toHaveBeenCalledTimes(1)
    const [req, query, sheetIds, access] = mocks.resolveReadableSheetIds.mock.calls[0]
    expect(req).toBeUndefined()
    expect(typeof query).toBe('function')
    expect(sheetIds).toEqual(['sheet_a'])
    expect(access).toEqual({ userId: 'u_delegated', permissions: ['stock-prep:admin'], isAdminRole: false })
    expect(granted).toEqual(['sheet_a'])
  })

  it('SW-07: the switch is read from process.env per call', async () => {
    const port = createStockPrepMembersHostPort()
    process.env[ENV] = 'TRUE'
    await expect(port.describe({ actorId: 'u_delegated' })).rejects.toMatchObject({ status: 404, code: 'STOCK_PREP_MEMBERS_PAGE_DISABLED' })
    expect(mocks.poolQuery).not.toHaveBeenCalled()
    delete process.env[ENV]
  })
})
