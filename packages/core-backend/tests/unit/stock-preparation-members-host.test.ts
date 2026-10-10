/**
 * 备料「成员与权限」(S5b, R-39) — the HOST WIRING of the members port: the real dependencies the
 * port is built with. The guards themselves are driven by stock-preparation-members.test.ts against
 * counting fakes; this file proves the fakes stand for the right host primitives.
 *
 *   SW-01 query / transaction go to db/pg (the pool; a transaction client for writes).
 *   SW-02 isPlatformAdmin is rbac/service.ts `isAdmin` (the DB admin role) and NOTHING ELSE — no read
 *         of the legacy `users.is_admin` / `users.role` columns, no token claim.
 *   SW-03 listEffectivePermissions DROPS the actor's permission memo before reading — the grantor
 *         bound (invariant 1) reads CURRENT codes, never a cached list.
 *   SW-04 hasEffectiveNamespaceAdmission is namespace-admission.ts `userHasEffectiveNamespaceAccess`.
 *   SW-05 resolveReadableSheetIds is permission-service.ts `resolveReadableSheetIds` with an access
 *         snapshot built from the same two rbac reads — after dropping the actor's memo (S3).
 *   SW-06 auditLog is audit/audit.ts `auditLog`.
 *   SW-07 the switch is read from process.env on every call.
 *   SW-08 resolveWritableSheetIds (S2, S3) drops the memo, then asks the grid's capability resolver
 *         per sheet and admits only a LIVE sheet with full record write (create + edit + delete, not
 *         write-own only).
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
  resolveSheetCapabilitiesForAccess: vi.fn(),
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
vi.mock('../../src/multitable/permission-service', () => ({
  resolveReadableSheetIds: mocks.resolveReadableSheetIds,
  resolveSheetCapabilitiesForAccess: mocks.resolveSheetCapabilitiesForAccess,
  // The write-own row policy, transcribed (pure in permission-service.ts; pinned by its own suite).
  requiresOwnWriteRowPolicy: (scope: { hasAssignments?: boolean; canWrite?: boolean; canWriteOwn?: boolean } | undefined, isAdminRole: boolean) =>
    !isAdminRole && !!scope?.hasAssignments && !!scope.canWriteOwn && !scope.canWrite,
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.auditLog }))

import { createStockPrepMembersHostDeps, createStockPrepMembersHostPort } from '../../src/services/stock-preparation-members-host'

const ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'
const FULL = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true }

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
    mocks.resolveReadableSheetIds.mockImplementation(async (_req: unknown, _query: unknown, sheetIds: string[]) => { mocks.order.push('readable'); return new Set(sheetIds) })
    mocks.resolveSheetCapabilitiesForAccess.mockImplementation(async (_query: unknown, sheetId: string) => {
      mocks.order.push(`capabilities:${sheetId}`)
      return { capabilities: { ...FULL }, sheetLiveness: 'live', sheetScope: { hasAssignments: true, canRead: true, canWrite: true, canWriteOwn: false, canAdmin: false } }
    })
    mocks.auditLog.mockResolvedValue(undefined)
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ')
      if (text.includes('AS held FROM user_roles')) return { rows: [{ held: 1 }], rowCount: 1 }
      if (text.includes('AS configured')) return { rows: [{ configured: true }], rowCount: 1 }
      if (text.includes('AS permissions FROM roles r')) return { rows: [{ id: 'stock-prep_c_0a1b2c3d', name: 'x', permissions: ['stock-prep:read'] }], rowCount: 1 }
      if (text.includes('SELECT user_id FROM user_roles WHERE role_id')) return { rows: [], rowCount: 0 }
      if (text.includes('COUNT(*)')) return { rows: [{ c: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    mocks.transaction.mockImplementation(async (handler: (client: { query: typeof mocks.poolQuery }) => Promise<unknown>) => handler({
      query: vi.fn(async (sql: string) => {
        const text = sql.replace(/\s+/g, ' ')
        if (text.startsWith('SELECT code FROM permissions')) return { rows: [{ code: 'stock-prep:read' }], rowCount: 1 }
        if (text.startsWith('INSERT INTO roles')) return { rows: [{ id: 'x' }], rowCount: 1 }
        if (text.includes('AS permissions FROM roles r')) return { rows: [{ id: 'stock-prep_c_0a1b2c3d', name: 'x', permissions: ['stock-prep:read'] }], rowCount: 1 }
        if (text.includes('COUNT(*)')) return { rows: [{ c: 0 }], rowCount: 1 }
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

  it('SW-02: the platform-admin decision is the DB admin role and nothing else — no legacy users column is read', async () => {
    const deps = createStockPrepMembersHostDeps()
    mocks.isAdmin.mockResolvedValueOnce(true)
    await expect(deps.isPlatformAdmin('u_x')).resolves.toBe(true)
    await expect(deps.isPlatformAdmin('u_y')).resolves.toBe(false)
    expect(mocks.isAdmin.mock.calls).toEqual([['u_x'], ['u_y']])
    expect(mocks.poolQuery).not.toHaveBeenCalled()
  })

  it('SW-05: readability is the grid resolver, with a FRESH snapshot of the actor\'s permissions and DB admin flag', async () => {
    const deps = createStockPrepMembersHostDeps()
    const readable = await deps.resolveReadableSheetIds('u_delegated', ['sheet_a'])
    expect(Array.from(readable)).toEqual(['sheet_a'])
    // S3: the memo is dropped BEFORE the snapshot is read.
    expect(mocks.order).toEqual(['invalidate:u_delegated', 'list:u_delegated', 'readable'])
    const [req, query, sheetIds, access] = mocks.resolveReadableSheetIds.mock.calls[0]
    expect(req).toBeUndefined()
    expect(typeof query).toBe('function')
    expect(sheetIds).toEqual(['sheet_a'])
    expect(access).toEqual({ userId: 'u_delegated', permissions: ['stock-prep:admin'], isAdminRole: false })
  })

  it('SW-08: writability is the grid capability resolver per sheet — a live sheet with full record write only, fresh snapshot', async () => {
    const deps = createStockPrepMembersHostDeps()
    const answers: Record<string, unknown> = {
      sheet_full: { capabilities: { ...FULL }, sheetLiveness: 'live', sheetScope: { hasAssignments: true, canRead: true, canWrite: true, canWriteOwn: false, canAdmin: false } },
      sheet_global: { capabilities: { ...FULL }, sheetLiveness: 'live' },
      sheet_read_only: { capabilities: { ...FULL, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false }, sheetLiveness: 'live', sheetScope: { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: false, canAdmin: false } },
      sheet_write_own: { capabilities: { ...FULL }, sheetLiveness: 'live', sheetScope: { hasAssignments: true, canRead: true, canWrite: false, canWriteOwn: true, canAdmin: false } },
      sheet_no_delete: { capabilities: { ...FULL, canDeleteRecord: false }, sheetLiveness: 'live' },
      sheet_unreadable: { capabilities: { ...FULL, canRead: false }, sheetLiveness: 'live' },
      sheet_deleted: { capabilities: { ...FULL }, sheetLiveness: 'deleted' },
      sheet_absent: { capabilities: { ...FULL }, sheetLiveness: 'absent' },
    }
    mocks.resolveSheetCapabilitiesForAccess.mockImplementation(async (_query: unknown, sheetId: string) => { mocks.order.push(`capabilities:${sheetId}`); return answers[sheetId] })
    const ids = Object.keys(answers)
    const writable = await deps.resolveWritableSheetIds('u_delegated', [...ids, 'sheet_full'])
    expect(Array.from(writable).sort()).toEqual(['sheet_full', 'sheet_global'])
    // S3: the memo is dropped BEFORE the snapshot is read; one capability read per distinct sheet.
    expect(mocks.order).toEqual(['invalidate:u_delegated', 'list:u_delegated', ...ids.map((id) => `capabilities:${id}`)])
    const [query, sheetId, access] = mocks.resolveSheetCapabilitiesForAccess.mock.calls[0]
    expect(typeof query).toBe('function')
    expect(sheetId).toBe('sheet_full')
    expect(access).toEqual({ userId: 'u_delegated', permissions: ['stock-prep:admin'], isAdminRole: false })
  })

  it('SW-05/08 through the port: a project-sheet grant asks the WRITE resolver (not readability) before any G1 call', async () => {
    const port = createStockPrepMembersHostPort()
    const granted: string[] = []
    await port.grantCustomRoleProjectSheets({
      actorId: 'u_delegated',
      roleId: 'stock-prep_c_0a1b2c3d',
      resolveTargets: async () => [{ sheetId: 'sheet_a', grant: async () => { granted.push('sheet_a'); return { granted: true } } }],
    })
    expect(mocks.resolveReadableSheetIds).not.toHaveBeenCalled()
    // Once as the fast check, once again under the locks.
    expect(mocks.resolveSheetCapabilitiesForAccess).toHaveBeenCalledTimes(2)
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
