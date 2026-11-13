import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: {
    id: 'admin-1',
    role: 'user',
  } as { id: string; role: string; tenantId?: string },
  authenticatedTenantId: undefined as string | undefined,
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const namespaceAdmissionMocks = vi.hoisted(() => ({
  deriveDelegatedAdminNamespace: vi.fn(),
  grantNamespaceAdmissions: vi.fn(async () => [] as string[]),
  disableNamespaceAdmissionsWithoutRoles: vi.fn(),
  isNamespaceAdmissionControlledResource: vi.fn(),
  listRoleNamespaces: vi.fn(),
  listUserNamespaceAdmissionSnapshots: vi.fn(),
  lockNamespaceAdmissionWrites: vi.fn(),
  normalizeNamespace: vi.fn(),
  roleIdMatchesNamespaces: vi.fn(),
  writeUserNamespaceAdmission: vi.fn(),
}))

const inviteMocks = vi.hoisted(() => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
  isInviteTokenExpired: vi.fn((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig'),
}))

const dingtalkOauthMocks = vi.hoisted(() => ({
  getDingTalkRuntimeStatus: vi.fn(),
}))

const activateMocks = vi.hoisted(() => ({
  activatePendingUser: vi.fn(),
}))

const attendanceW4Mocks = vi.hoisted(() => ({
  acquireAttendanceCalculationRolloutLock: vi.fn(),
  parseCanonicalAttendanceRolloutOrgKeyV1: vi.fn((value: unknown) => value),
  resolveSegmentCalculationPosture: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    if (state.authenticatedTenantId) req.authenticatedTenantId = state.authenticatedTenantId
    next()
  },
}))

// Load-bearing for T3 HTTP mapping (#4581 r3): service-layer unit tests alone cannot
// catch reverting ACTIVATE_ALIAS_FAILED → 409 or echoing raw driver text.
vi.mock('../../src/auth/user-activate', () => ({
  activatePendingUser: activateMocks.activatePendingUser,
  isActivateMode: (value: unknown) =>
    value === 'temp_password' || value === 'sso' || value === 'admin_no_password',
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  // W4-PRE-1: POST /api/admin/users now wraps its write sequence in transaction() (the
  // user_orgs atomicity requirement, §3.3). The handler's client.query is backed by the SAME
  // pgMocks.query mock so every existing test's call-order/count scripting (mockResolvedValueOnce
  // chains) is unaffected — transaction() is transparent here, not a second mock surface.
  transaction: vi.fn(async (handler: (client: { query: typeof pgMocks.query }) => Promise<unknown>) =>
    handler({ query: pgMocks.query })),
}))

// Alias full-writer hooks: default stubs keep existing create/profile once-chains green.
// Dedicated load-bearing coverage lives in login-alias-writers*.test.ts (do not weaken those).
const loginAliasWriterMocks = vi.hoisted(() => ({
  claimNonEmptyLoginAliasesOrThrow: vi.fn(async () => []),
  applyMobileLoginAliasChangeOrThrow: vi.fn(async (options: { afterNewClaim: () => Promise<void> }) => {
    await options.afterNewClaim()
    return { claimed: [], retiredNormalized: null }
  }),
}))

vi.mock('../../src/auth/login-alias-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/login-alias-service')>()
  return {
    ...actual,
    claimNonEmptyLoginAliasesOrThrow: loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow,
    applyMobileLoginAliasChangeOrThrow: loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow,
  }
})

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/rbac/namespace-admission', async () => ({
  // `deriveGrantNamespaces` is deliberately NOT stubbed: provisioning's admission write must be
  // driven by the SHIPPED derivation. A stub here could agree with a caller that derives the
  // wrong namespaces, which is precisely the coupling this suite needs to observe.
  deriveGrantNamespaces: (
    await vi.importActual<typeof import('../../src/rbac/namespace-admission')>(
      '../../src/rbac/namespace-admission',
    )
  ).deriveGrantNamespaces,
  // Same reasoning: the delegated platform-code refusal classifies each permission code with the
  // SHIPPED derivation, so a stub cannot agree with a wrong classification.
  derivePermissionNamespace: (
    await vi.importActual<typeof import('../../src/rbac/namespace-admission')>(
      '../../src/rbac/namespace-admission',
    )
  ).derivePermissionNamespace,
  grantNamespaceAdmissions: namespaceAdmissionMocks.grantNamespaceAdmissions,
  deriveDelegatedAdminNamespace: namespaceAdmissionMocks.deriveDelegatedAdminNamespace,
  disableNamespaceAdmissionsWithoutRoles: namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles,
  isNamespaceAdmissionControlledResource: namespaceAdmissionMocks.isNamespaceAdmissionControlledResource,
  listRoleNamespaces: namespaceAdmissionMocks.listRoleNamespaces,
  listUserNamespaceAdmissionSnapshots: namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots,
  lockNamespaceAdmissionWrites: namespaceAdmissionMocks.lockNamespaceAdmissionWrites,
  normalizeNamespace: namespaceAdmissionMocks.normalizeNamespace,
  roleIdMatchesNamespaces: namespaceAdmissionMocks.roleIdMatchesNamespaces,
  writeUserNamespaceAdmission: namespaceAdmissionMocks.writeUserNamespaceAdmission,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: inviteMocks.issueInviteToken,
  isInviteTokenExpired: inviteMocks.isInviteTokenExpired,
}))

vi.mock('../../src/auth/dingtalk-oauth', () => ({
  getDingTalkRuntimeStatus: dingtalkOauthMocks.getDingTalkRuntimeStatus,
}))

vi.mock('../../src/attendance/w4c0-identity', () => attendanceW4Mocks)

import { LoginAliasClaimError } from '../../src/auth/login-alias-service'
import { LOGIN_NAME_RULE_MESSAGE } from '../../src/auth/login-name-rule'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { transaction } from '../../src/db/pg'
import { censusFile } from './lib/recovery-census-recorder'

// O2-A1/P3-1 RUNTIME leg linkage: each recovery-census leg below records its
// site as its LAST statement, and the file-level afterAll installed here asserts the
// EXECUTED set equals this file's registered set exactly. A skipped/focused-out/deleted
// leg therefore reds this file instead of silently leaving a dead call site green.
const census = censusFile('admin-users-routes.test.ts')

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    textBody: '',
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = String(value)
      return this
    },
    write(chunk: unknown) {
      this.textBody += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk != null) this.textBody += String(chunk)
      this.headersSent = true
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
    headers: Record<string, string>
    textBody: string
  }
}

async function invokeRoute(
  method: 'get' | 'post' | 'patch',
  path: string,
  options: {
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = adminUsersRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
  } as unknown as Request

  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  return res
}

function lockedUserResult(id: string, role = 'user') {
  return { rows: [{
    id, role, activation_status: 'activated', is_active: true,
    access_generation: 0, deleted_at: null, purged_at: null,
  }] }
}

function expectScopeWriteSerialized(userId: string, writeSqlIncludes: string): void {
  expect(namespaceAdmissionMocks.lockNamespaceAdmissionWrites).toHaveBeenCalledWith(expect.anything(), userId)
  const roleReads = pgMocks.query.mock.calls
    .map((call, index) => ({ index, sql: String(call[0]), userId: (call[1] as unknown[] | undefined)?.[0] }))
    .filter((call) => call.sql.includes('FROM user_roles') && call.userId === userId)
  const writeIndex = pgMocks.query.mock.calls.findIndex((call) => String(call[0]).includes(writeSqlIncludes))
  expect(roleReads.length).toBeGreaterThanOrEqual(2)
  expect(writeIndex).toBeGreaterThan(roleReads[1].index)
  const lockAt = namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mock.invocationCallOrder[0]
  const roleAt = pgMocks.query.mock.invocationCallOrder[roleReads[1].index]
  const writeAt = pgMocks.query.mock.invocationCallOrder[writeIndex]
  expect(lockAt).toBeLessThan(roleAt)
  expect(roleAt).toBeLessThan(writeAt)
}

describe('admin-users routes', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    state.authUser = {
      id: 'admin-1',
      role: 'user',
    }
    state.authenticatedTenantId = undefined
    pgMocks.query.mockReset()
    pgMocks.query.mockResolvedValue({ rows: [] })
    loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow.mockReset()
    loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow.mockResolvedValue([])
    loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow.mockReset()
    loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow.mockImplementation(
      async (options: { afterNewClaim: () => Promise<void> }) => {
        await options.afterNewClaim()
        return { claimed: [], retiredNormalized: null }
      },
    )
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue([])
    rbacMocks.invalidateUserPerms.mockReset()
    bcryptMocks.hash.mockReset()
    auditMocks.auditLog.mockReset()
    namespaceAdmissionMocks.deriveDelegatedAdminNamespace.mockReset()
    namespaceAdmissionMocks.deriveDelegatedAdminNamespace.mockImplementation((roleId: string) => (
      typeof roleId === 'string' && roleId.endsWith('_admin') && roleId !== 'admin'
        ? roleId.slice(0, -'_admin'.length)
        : null
    ))
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockReset()
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockResolvedValue([])
    namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mockReset()
    namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mockResolvedValue(undefined)
    namespaceAdmissionMocks.isNamespaceAdmissionControlledResource.mockReset()
    namespaceAdmissionMocks.isNamespaceAdmissionControlledResource.mockImplementation((namespace: string) => Boolean(namespace))
    namespaceAdmissionMocks.grantNamespaceAdmissions.mockClear()
    namespaceAdmissionMocks.grantNamespaceAdmissions.mockResolvedValue([])
    namespaceAdmissionMocks.listRoleNamespaces.mockReset()
    namespaceAdmissionMocks.listRoleNamespaces.mockResolvedValue([])
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockReset()
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([])
    namespaceAdmissionMocks.normalizeNamespace.mockReset()
    namespaceAdmissionMocks.normalizeNamespace.mockImplementation((value: unknown) => String(value ?? '').trim())
    namespaceAdmissionMocks.roleIdMatchesNamespaces.mockReset()
    namespaceAdmissionMocks.roleIdMatchesNamespaces.mockImplementation((roleId: string, namespaces: string[]) => (
      Array.isArray(namespaces) && namespaces.some((namespace) => roleId === namespace || roleId.startsWith(`${namespace}_`))
    ))
    namespaceAdmissionMocks.writeUserNamespaceAdmission.mockReset()
    namespaceAdmissionMocks.writeUserNamespaceAdmission.mockResolvedValue([])
    inviteMocks.issueInviteToken.mockClear()
    inviteMocks.isInviteTokenExpired.mockClear()
    inviteMocks.isInviteTokenExpired.mockImplementation((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig')
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReset()
    attendanceW4Mocks.acquireAttendanceCalculationRolloutLock.mockReset()
    attendanceW4Mocks.acquireAttendanceCalculationRolloutLock.mockResolvedValue(undefined)
    attendanceW4Mocks.parseCanonicalAttendanceRolloutOrgKeyV1.mockReset()
    attendanceW4Mocks.parseCanonicalAttendanceRolloutOrgKeyV1.mockImplementation((value: unknown) => value)
    attendanceW4Mocks.resolveSegmentCalculationPosture.mockReset()
    attendanceW4Mocks.resolveSegmentCalculationPosture.mockResolvedValue({ referenceSegments: false })
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: [],
      requireGrant: false,
      autoLinkEmail: true,
      autoProvision: false,
      unavailableReason: null,
    })
    activateMocks.activatePendingUser.mockReset()
  })

  it('lists users with pagination payload', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            mobile: '13800138000',
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'user-1',
          enabled: true,
          granted_by: 'admin-1',
          granted_by_name: 'Admin One',
          granted_by_email: 'admin@example.com',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-1', last_directory_sync_at: '2026-03-13T00:00:00.000Z' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: 'user-1',
          corp_id: 'ding-corp',
          provider_union_id: 'union-1',
          provider_open_id: null,
          last_login_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[1]?.[0])).toContain('ORDER BY created_at DESC, id ASC')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        total: 2,
        page: 1,
        pageSize: 20,
        query: 'alpha',
      },
    })
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'user-1',
      email: 'alpha@example.com',
      mobile: '13800138000',
      roleIds: [],
      dingtalkLoginEnabled: true,
      dingtalkGrantUpdatedAt: '2026-03-13T00:05:00.000Z',
      dingtalkGrantUpdatedBy: 'Admin One',
      directoryLinked: true,
      dingtalkIdentityExists: true,
      dingtalkHasUnionId: true,
      dingtalkHasOpenId: false,
      dingtalkOpenIdMissing: true,
      dingtalkCorpId: 'ding-corp',
      lastDirectorySyncAt: '2026-03-13T00:00:00.000Z',
    })
  })

  it('pins a deep-linked user when the row is outside the paginated window', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 42 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-first',
            email: 'first@example.com',
            name: 'First',
            mobile: null,
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-pinned',
            email: 'pinned@example.com',
            name: 'Pinned',
            mobile: null,
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: { userId: 'user-pinned', page: '1', pageSize: '1' },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query).toHaveBeenCalledTimes(6)
    const items = (response.body as Record<string, any>).data.items
    expect(items[0].id).toBe('user-pinned')
    expect(items.map((row: Record<string, unknown>) => row.id)).toEqual(['user-pinned'])
    expect(items).toHaveLength(1)
    expect((response.body as Record<string, any>).data.pinUserId).toBe('user-pinned')
    expect((response.body as Record<string, any>).data.pinUserIncluded).toBe(true)
  })

  it('skips the extra pin lookup when the deep-linked user already appears in the first page', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 3 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-a',
            email: 'a@example.com',
            name: 'A',
            mobile: null,
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-10T00:00:00.000Z',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
          {
            id: 'user-b',
            email: 'b@example.com',
            name: 'B',
            mobile: null,
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-09T00:00:00.000Z',
            updated_at: '2026-03-09T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: { userId: 'user-a' },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query).toHaveBeenCalledTimes(5)
    expect((response.body as Record<string, any>).data.items.map((row: Record<string, unknown>) => row.id)).toEqual(['user-a', 'user-b'])
    expect((response.body as Record<string, any>).data.pinUserIncluded).toBe(true)
  })

  it('reports pinUserIncluded=false when the deep-linked user does not exist', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: { userId: 'missing-user' },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query).toHaveBeenCalledTimes(3)
    expect((response.body as Record<string, any>).data.items).toEqual([])
    expect((response.body as Record<string, any>).data.pinUserId).toBe('missing-user')
    expect((response.body as Record<string, any>).data.pinUserIncluded).toBe(false)
  })

  it('filters and pages the user list on the server without an unbounded load', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 11 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: {
        page: '2',
        pageSize: '20',
        role: 'auditor',
        accountStatus: 'active',
        listFilter: 'platform-admin',
        sort: 'name',
        dir: 'asc',
      },
    })

    expect(response.statusCode).toBe(200)
    const countSql = String(pgMocks.query.mock.calls[0]?.[0])
    const listSql = String(pgMocks.query.mock.calls[1]?.[0])
    expect(countSql).toContain('role = $1')
    expect(countSql).toContain('is_active IS TRUE')
    expect(countSql).toContain("role = 'admin'")
    expect(listSql).toContain('ORDER BY name ASC NULLS LAST, id ASC')
    expect(listSql).toContain('LIMIT $2 OFFSET $3')
    expect(listSql).not.toContain('LIMIT 10000')
    expect(String(pgMocks.query.mock.calls[1]?.[1])).not.toContain('10000')
    expect(pgMocks.query.mock.calls[0]?.[1]).toEqual(['auditor'])
    expect(pgMocks.query.mock.calls[1]?.[1]).toEqual(['auditor', 20, 20])
    expect((response.body as Record<string, any>).data).toMatchObject({ page: 2, pageSize: 20, total: 11 })
  })

  it('rejects non-admin requests', async () => {
    state.authUser = {
      id: 'user-2',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)

    const response = await invokeRoute('get', '/api/admin/users')

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('FORBIDDEN')
  })

  it('returns user access details', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read', 'workflow:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          mobile: '13800138000',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }, { role_id: 'workflow_operator' }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.roles).toEqual(['attendance_employee', 'workflow_operator'])
    expect((response.body as Record<string, any>).data.permissions).toEqual(['attendance:read', 'workflow:read'])
    expect((response.body as Record<string, any>).data.isAdmin).toBe(false)
  })

  it('updates user profile name and mobile', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['crm:admin'])
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: null as string | null,
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] }) // pre-read
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] }) // FOR UPDATE lock
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // UPDATE
      .mockResolvedValueOnce({
        rows: [{
          ...profileRow,
          name: 'Alpha Prime',
          mobile: '13800138000',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { name: 'Alpha Prime', mobile: '13800138000', expectedMobile: null },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toMatch(/FOR UPDATE/)
    expect(pgMocks.query).toHaveBeenNthCalledWith(3,
      expect.stringContaining('UPDATE users'),
      ['Alpha Prime', '13800138000', null, null, null, null, 'user-1', true, null],
    )
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      resourceType: 'user',
      resourceId: 'user-1',
      meta: expect.objectContaining({
        before: {
          name: 'Alpha',
          mobile: null,
          employeeNo: null,
          department: null,
          position: null,
          hireDate: null,
        },
        after: {
          name: 'Alpha Prime',
          mobile: '13800138000',
          employeeNo: null,
          department: null,
          position: null,
          hireDate: null,
        },
      }),
    }))
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      id: 'user-1',
      name: 'Alpha Prime',
      mobile: '13800138000',
    })
  })

  it('updates attendance HR profile fields', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          mobile: '13800138000',
          employeeNo: null,
          department: null,
          position: null,
          hireDate: null,
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          mobile: '13800138000',
          employeeNo: 'E-2026-009',
          department: 'Assembly',
          position: 'Line Lead',
          hireDate: '2026-05-29',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-05-29T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: {
        employeeNo: ' E-2026-009 ',
        department: ' Assembly ',
        position: ' Line Lead ',
        hireDate: '2026-05-29',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('UPDATE users'),
      ['Alpha', '13800138000', 'E-2026-009', 'Assembly', 'Line Lead', '2026-05-29', 'user-1', false, null],
    )
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      resourceType: 'user',
      resourceId: 'user-1',
      meta: expect.objectContaining({
        before: expect.objectContaining({
          employeeNo: null,
          department: null,
          position: null,
          hireDate: null,
        }),
        after: expect.objectContaining({
          employeeNo: 'E-2026-009',
          department: 'Assembly',
          position: 'Line Lead',
          hireDate: '2026-05-29',
        }),
      }),
    }))
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      id: 'user-1',
      employeeNo: 'E-2026-009',
      department: 'Assembly',
      position: 'Line Lead',
      hireDate: '2026-05-29',
    })
  })

  it('rejects invalid HR profile hire dates', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha',
        mobile: null,
        employeeNo: null,
        department: null,
        position: null,
        hireDate: null,
        role: 'user',
        is_active: true,
        is_admin: false,
        last_login_at: null,
        created_at: '2026-03-12T00:00:00.000Z',
        updated_at: '2026-03-12T00:00:00.000Z',
      }],
    })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { hireDate: '2026-02-31' },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('INVALID_HIRE_DATE')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('clears user mobile profile field', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: '13800138000' as string | null,
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({
        rows: [{ ...profileRow, mobile: null, updated_at: '2026-03-13T00:00:00.000Z' }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '   ', expectedMobile: '13800138000' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toMatch(/FOR UPDATE/)
    expect(pgMocks.query).toHaveBeenNthCalledWith(3,
      expect.stringContaining('UPDATE users'),
      ['Alpha', null, null, null, null, null, 'user-1', true, '13800138000'],
    )
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      id: 'user-1',
      mobile: null,
    })
  })

  it('normalises whitespace on both sides of the mobile CAS witness', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: '138 0013 8000',
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      // fetchUserProfile returns legacy dirty data with embedded whitespace.
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] }) // FOR UPDATE
      // UPDATE still matches because both sides are normalised in SQL.
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          ...profileRow,
          mobile: '13800138000',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13800138000', expectedMobile: '13800138000' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toMatch(/FOR UPDATE/)
    const updateCall = pgMocks.query.mock.calls[2]
    expect(String(updateCall[0])).toContain('regexp_replace')
    expect(String(updateCall[0])).toContain('IS NOT DISTINCT FROM')
    expect(updateCall[1]).toEqual(['Alpha', '13800138000', null, null, null, null, 'user-1', true, '13800138000'])
  })

  it('returns 409 when expected mobile no longer matches current value', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: '13600000000',
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // CAS UPDATE fails

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13900001234', expectedMobile: '13500000000' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('PROFILE_MOBILE_CONFLICT')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('returns dingtalk access details for a user', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: ['ding-corp'],
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      unavailableReason: null,
    })
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'ding-corp',
          provider_union_id: 'union-1',
          provider_open_id: 'open-1',
          last_login_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          linked_count: 2,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/dingtalk-access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      userId: 'user-1',
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      server: {
        configured: true,
        available: true,
        corpId: 'ding-corp',
        requireGrant: true,
        autoLinkEmail: false,
        autoProvision: false,
        unavailableReason: null,
      },
      directory: {
        linked: true,
        linkedCount: 2,
      },
      grant: { exists: true, enabled: true },
      identity: {
        exists: true,
        corpId: 'ding-corp',
        unionId: 'union-1',
        openId: 'open-1',
        hasUnionId: true,
        hasOpenId: true,
      },
    })
  })

  it('returns member admission snapshot for a user', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'seed_backfill',
        grantedBy: null,
        updatedBy: null,
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }, { role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          directory_account_id: 'account-1',
          external_user_id: 'ding-user-1',
          account_name: 'Alpha',
          account_email: 'alpha@example.com',
          account_mobile: '13800000000',
          account_is_active: true,
          account_updated_at: '2026-03-13T00:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'external_identity',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-03-13T00:00:00.000Z',
          department_paths: ['总部 / 研发部'],
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'ding-corp',
          provider_union_id: 'union-1',
          provider_open_id: 'open-1',
          last_login_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      userId: 'user-1',
      accountEnabled: true,
      platformAdminEnabled: false,
      attendanceAdminEnabled: false,
      businessRoleIds: ['crm_admin'],
      directoryMemberships: [
        expect.objectContaining({
          integrationId: 'integration-1',
          integrationName: 'DingTalk CN',
          linkStatus: 'linked',
          matchStrategy: 'external_identity',
          departmentPaths: ['总部 / 研发部'],
        }),
      ],
      dingtalk: {
        grant: { exists: true, enabled: true },
        identity: {
          exists: true,
          corpId: 'ding-corp',
          unionId: 'union-1',
          openId: 'open-1',
          hasUnionId: true,
          hasOpenId: true,
        },
      },
      namespaceAdmissions: [
        expect.objectContaining({
          namespace: 'crm',
          enabled: true,
          effective: true,
          hasRole: true,
        }),
      ],
    })
  })

  describe('member-admission organizations (read-only user_orgs view, slice B)', () => {
    type OrgRow = { user_id: string; org_id: string; is_active: boolean }
    type EvidenceRow = { local_user_id: string; status: string }

    // Slice C (#6079): the history statement shared with the local-account guard
    // (directory/org-membership-history.ts) is answered from the same fixtures. Like the active read
    // below, each predicate is applied ONLY when the statement carries it, so dropping the user
    // filter, adding an `is_active` filter (ignoring deactivated rows), dropping the `'applied'`
    // status filter or turning the event/effect OR into AND reds the slice C cases below.
    const historyCalls: Array<{ sql: string; params: unknown[] }> = []

    function evaluateHistory(
      sql: string,
      params: unknown[],
      input: { rows: OrgRow[]; events: EvidenceRow[]; effects: EvidenceRow[] },
    ) {
      const [anySegment = '', afterAny = ''] = sql.split('AS has_any_row')
      const [orgSegment = '', evidenceSegment = ''] = afterAny.split('AS has_org_row')
      const userRows = (segment: string) => input.rows
        .filter((row) => !/uo\.user_id = \$1/.test(segment) || row.user_id === params[0])
        .filter((row) => !/is_active/.test(segment) || row.is_active)
      const eventsSegment = evidenceSegment.split('directory_deprovision_effects')[0] ?? ''
      const effectsSegment = evidenceSegment.split('directory_deprovision_effects')[1] ?? ''
      const liveEvidence = (rows: EvidenceRow[], segment: string, alias: 'event' | 'effect') => rows
        .filter((row) => !new RegExp(`${alias}[.]local_user_id = [$]1`).test(segment) || row.local_user_id === params[0])
        .filter((row) => !new RegExp(`${alias}[.]status = 'applied'`).test(segment) || row.status === 'applied')
        .length > 0
      const eventLive = liveEvidence(input.events, eventsSegment, 'event')
      const effectLive = liveEvidence(input.effects, effectsSegment, 'effect')
      const combinedWithOr = /[)]\s*OR\s+EXISTS/.test(evidenceSegment)
      return {
        has_any_row: userRows(anySegment).length > 0,
        has_org_row: userRows(orgSegment)
          .filter((row) => !/uo\.org_id = \$2/.test(orgSegment) || row.org_id === params[1])
          .length > 0,
        deprovision_applied: combinedWithOr ? eventLive || effectLive : eventLive && effectLive,
      }
    }

    // A small fake of the two tables the organizations read joins. It applies each filter ONLY when
    // the route's SQL carries the matching predicate, so dropping `uo.user_id = $1`,
    // `uo.is_active = true` or `u.is_active = true` from the route lets the filtered rows through
    // and these cases go red (fixtures carry another user's rows for the user filter).
    function installOrgFake(input: { userActive: boolean; rows: OrgRow[]; events?: EvidenceRow[]; effects?: EvidenceRow[] }) {
      const orgCalls: Array<{ sql: string; params: unknown[] }> = []
      historyCalls.length = 0
      pgMocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('AS has_any_row')) {
          historyCalls.push({ sql, params })
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error('organizations read must not write')
          return { rows: [evaluateHistory(sql, params, { rows: input.rows, events: input.events ?? [], effects: input.effects ?? [] })] }
        }
        if (/FROM users\s+WHERE id = \$1/.test(sql)) {
          return {
            rows: [{
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: input.userActive,
              is_admin: false,
              last_login_at: null,
              created_at: '2026-03-12T00:00:00.000Z',
              updated_at: '2026-03-12T00:00:00.000Z',
            }],
          }
        }
        if (sql.includes('FROM user_orgs')) {
          orgCalls.push({ sql, params })
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error('organizations read must not write')
          const filterUser = /uo\.user_id = \$1/.test(sql)
          const filterRowActive = /uo\.is_active = true/.test(sql)
          const filterUserActive = /JOIN users u ON u\.id = uo\.user_id/.test(sql) && /u\.is_active = true/.test(sql)
          const rows = input.rows
            .filter((row) => !filterUser || row.user_id === params[0])
            .filter((row) => !filterRowActive || row.is_active)
            .filter(() => !filterUserActive || input.userActive)
            .map((row) => ({ org_id: row.org_id }))
          return { rows }
        }
        return { rows: [] }
      })
      return orgCalls
    }

    async function readOrganizations() {
      const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
        params: { userId: 'user-1' },
      })
      expect(response.statusCode).toBe(200)
      return (response.body as Record<string, any>).data.organizations
    }

    beforeEach(() => {
      rbacMocks.isAdmin.mockResolvedValue(true)
    })

    it('zero active rows: empty list and no tenant context (an inactive row does not count)', async () => {
      const orgCalls = installOrgFake({
        userActive: true,
        rows: [
          { user_id: 'user-1', org_id: 'org-old', is_active: false },
          { user_id: 'user-2', org_id: 'org-b', is_active: true },
        ],
      })
      // The deactivated `org-old` row is history: no tenant context, but `hasAnyRow` is true.
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: true, deprovisionApplied: false })
      expect(orgCalls).toHaveLength(1)
      expect(orgCalls[0].params).toEqual(['user-1'])
    })

    it('exactly one active row: that org and a tenant context (the login claim predicate)', async () => {
      const orgCalls = installOrgFake({
        userActive: true,
        rows: [
          { user_id: 'user-1', org_id: 'org-a', is_active: true },
          { user_id: 'user-1', org_id: 'org-z', is_active: false },
          { user_id: 'user-2', org_id: 'org-b', is_active: true },
        ],
      })
      expect(await readOrganizations()).toEqual({ active: [{ orgId: 'org-a' }], hasTenantContext: true, hasAnyRow: true, deprovisionApplied: false })
      expect(orgCalls.map((call) => call.params)).toEqual([['user-1']])
    })

    it('two active rows: both orgs listed but NO tenant context (login would need an explicit choice)', async () => {
      installOrgFake({
        userActive: true,
        rows: [
          { user_id: 'user-1', org_id: 'org-a', is_active: true },
          { user_id: 'user-1', org_id: 'org-b', is_active: true },
        ],
      })
      expect(await readOrganizations()).toEqual({
        active: [{ orgId: 'org-a' }, { orgId: 'org-b' }],
        hasTenantContext: false,
        hasAnyRow: true,
        deprovisionApplied: false,
      })
    })

    it('an inactive user is filtered out like at login: active rows are not reported and there is no tenant context', async () => {
      installOrgFake({
        userActive: false,
        rows: [{ user_id: 'user-1', org_id: 'org-a', is_active: true }],
      })
      // History is about rows, not about the user's own active flag: the row still counts.
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: true, deprovisionApplied: false })
    })

    it('a blank org id still counts as a row for the exactly-one rule (login parity) but is not listed', async () => {
      installOrgFake({
        userActive: true,
        rows: [
          { user_id: 'user-1', org_id: '', is_active: true },
          { user_id: 'user-1', org_id: 'org-a', is_active: true },
        ],
      })
      expect(await readOrganizations()).toEqual({ active: [{ orgId: 'org-a' }], hasTenantContext: false, hasAnyRow: true, deprovisionApplied: false })
    })

    it('a single blank org id gives no tenant context, like login (a blank resolved id is "no tenant")', async () => {
      installOrgFake({
        userActive: true,
        rows: [{ user_id: 'user-1', org_id: '', is_active: true }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: true, deprovisionApplied: false })
    })

    it('a failing user_orgs read answers 200 with organizations: null, keeps the rest, and logs values-free', async () => {
      const MARKER = 'MARKER_orgs_q7 connect ECONNREFUSED 198.51.100.7:5432 role=fixture-role'
      const { Logger } = await import('../../src/core/logger')
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([
        { namespace: 'crm', enabled: true, effective: true, hasRole: true, source: 'seed_backfill', grantedBy: null, updatedBy: null, createdAt: null, updatedAt: null },
      ])
      installOrgFake({ userActive: true, rows: [] })
      const fake = pgMocks.query.getMockImplementation()!
      pgMocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM user_orgs')) throw new Error(MARKER)
        return fake(sql, params)
      })

      const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
        params: { userId: 'user-1' },
      })

      expect(response.statusCode).toBe(200)
      const data = (response.body as Record<string, any>).data
      expect(data).toHaveProperty('organizations', null)
      expect(data).toMatchObject({
        userId: 'user-1',
        accountEnabled: true,
        namespaceAdmissions: [expect.objectContaining({ namespace: 'crm', enabled: true })],
      })
      expect(JSON.stringify(response.body)).not.toContain('MARKER_orgs_q7')
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines).toEqual([expect.stringMatching(/^admin-users\.organizations-read-failed errorClass=Error(?: correlationId=\S+)?$/)])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('MARKER_orgs_q7')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('198.51.100.7')
      warn.mockRestore()
    })

    // ---- Slice C (#6079): hasAnyRow / deprovisionApplied, the read-only mirror of the
    // POST /api/admin/directory/local/accounts guard (one shared statement). ----

    it('slice C: no user_orgs row at all and no applied evidence: hasAnyRow=false, deprovisionApplied=false (the only shape the panel may offer "join")', async () => {
      installOrgFake({
        userActive: true,
        rows: [{ user_id: 'user-2', org_id: 'default', is_active: false }],
        events: [{ local_user_id: 'user-2', status: 'applied' }],
        effects: [{ local_user_id: 'user-2', status: 'applied' }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: false, deprovisionApplied: false })
      expect(historyCalls).toHaveLength(1)
      // The user id and NO org: the field is about any org; the guard passes its own org.
      expect(historyCalls[0].params).toEqual(['user-1', null])
      expect(historyCalls[0].sql).toMatch(/^\s*SELECT/)
    })

    it('slice C: a deactivated row in any org is history: hasAnyRow=true while active stays empty', async () => {
      installOrgFake({
        userActive: true,
        rows: [{ user_id: 'user-1', org_id: 'default', is_active: false }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: true, deprovisionApplied: false })
    })

    it('slice C: an applied deprovision event alone gives deprovisionApplied=true and leaves hasAnyRow=false (the two fields are not swapped)', async () => {
      installOrgFake({
        userActive: true,
        rows: [],
        events: [{ local_user_id: 'user-1', status: 'applied' }],
        effects: [{ local_user_id: 'user-1', status: 'superseded' }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: false, deprovisionApplied: true })
    })

    it('slice C: an applied deprovision effect alone (its event no longer applied) also gives deprovisionApplied=true', async () => {
      installOrgFake({
        userActive: true,
        rows: [],
        events: [{ local_user_id: 'user-1', status: 'fully_resolved' }],
        effects: [{ local_user_id: 'user-1', status: 'applied' }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: false, deprovisionApplied: true })
    })

    it('slice C: only resolved / superseded evidence is not "applied": deprovisionApplied=false', async () => {
      installOrgFake({
        userActive: true,
        rows: [],
        events: [{ local_user_id: 'user-1', status: 'superseded' }, { local_user_id: 'user-1', status: 'fully_resolved' }],
        effects: [{ local_user_id: 'user-1', status: 'superseded' }, { local_user_id: 'user-1', status: 'reversed' }],
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: false, deprovisionApplied: false })
    })

    it('slice C: a failing history read keeps active / hasTenantContext, answers hasAnyRow / deprovisionApplied as null, and logs values-free', async () => {
      const MARKER = 'MARKER_hist_k4 connect ECONNREFUSED 198.51.100.9:5432 role=fixture-role'
      const { Logger } = await import('../../src/core/logger')
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      installOrgFake({ userActive: true, rows: [{ user_id: 'user-1', org_id: 'org-a', is_active: true }] })
      const fake = pgMocks.query.getMockImplementation()!
      pgMocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('AS has_any_row')) throw new Error(MARKER)
        return fake(sql, params)
      })

      const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
        params: { userId: 'user-1' },
      })

      expect(response.statusCode).toBe(200)
      expect((response.body as Record<string, any>).data.organizations).toEqual({
        active: [{ orgId: 'org-a' }],
        hasTenantContext: true,
        hasAnyRow: null,
        deprovisionApplied: null,
      })
      expect(JSON.stringify(response.body)).not.toContain('MARKER_hist_k4')
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines).toEqual([expect.stringMatching(/^admin-users\.organization-history-read-failed errorClass=Error(?: correlationId=\S+)?$/)])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('MARKER_hist_k4')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('198.51.100.9')
      warn.mockRestore()
    })

    it('slice C: a history read that answers a non-boolean is "unknown" (null), never coerced to false', async () => {
      const { Logger } = await import('../../src/core/logger')
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      installOrgFake({ userActive: true, rows: [] })
      const fake = pgMocks.query.getMockImplementation()!
      pgMocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('AS has_any_row')) return { rows: [{ has_any_row: null, has_org_row: false, deprovision_applied: 'f' }] }
        return fake(sql, params)
      })
      expect(await readOrganizations()).toEqual({ active: [], hasTenantContext: false, hasAnyRow: null, deprovisionApplied: null })
      warn.mockRestore()
    })

    it('an unknown user is a 404 and user_orgs is never read', async () => {
      const orgCalls: string[] = []
      pgMocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM user_orgs')) orgCalls.push(sql)
        return { rows: [] }
      })
      const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
        params: { userId: 'missing-user' },
      })
      expect(response.statusCode).toBe(404)
      expect(orgCalls).toEqual([])
    })

    it('a non-admin is refused before any user_orgs read', async () => {
      rbacMocks.isAdmin.mockResolvedValue(false)
      const orgCalls = installOrgFake({
        userActive: true,
        rows: [{ user_id: 'user-1', org_id: 'org-a', is_active: true }],
      })
      const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
        params: { userId: 'user-1' },
      })
      expect(response.statusCode).toBe(403)
      expect(orgCalls).toEqual([])
      expect(historyCalls).toEqual([])
    })
  })

  it('answers a fixed 500 when the delegated role read fails before the handler, instead of leaving the request unanswered', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockRejectedValueOnce(new Error('MARKER_rd_f3q7 connect ECONNREFUSED'))

    const response = await invokeRoute('get', '/api/admin/role-delegation/summary')

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'ROLE_DELEGATION_CHECK_FAILED', message: 'Failed to verify delegated role-admin access' },
    })
    expect(JSON.stringify(response.body)).not.toContain('MARKER_rd_f3q7')
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED')
  })

  it('returns delegated role summary for a plugin admin', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'attendance_employee' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/summary')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      isPlatformAdmin: false,
      delegableNamespaces: ['crm'],
      // Owner ruling 2026-10-10: the namespace main-admin role `crm_admin` is platform-only, so
      // a delegate's assignable list no longer offers it.
      roleCatalog: [
        { id: 'crm_operator' },
      ],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          departmentFullPath: '总部 / 研发部',
        }),
      ],
    })
    const catalog = (response.body as Record<string, any>).data.roleCatalog as Array<Record<string, unknown>>
    expect(catalog).toEqual([
      expect.objectContaining({
        id: 'crm_operator',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ])
  })

  it('sends a cooked catalog predicate that keeps the crm_ separator', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      return { rows: [] }
    })

    const response = await invokeRoute('get', '/api/admin/role-delegation/summary')
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)

    // The string query() received after the template literal was cooked.
    // The summary body is not this check: fetchDelegatedRoleCatalogs still
    // drops a non-matching role id through roleIdMatchesNamespaces.
    const catalogCall = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('FROM unnest($1::text[]) AS namespace'))
    expect(catalogCall).toBeTruthy()
    const sql = String(catalogCall?.[0])
    const params = catalogCall?.[1] as unknown[]
    expect(params).toEqual([['crm']])
    expect(sql).toContain("r.id = namespace\n            OR starts_with(r.id, namespace || '_')")
    expect(sql).not.toContain("LIKE namespace || '_%'")
    expect(sql).not.toContain("ESCAPE ''")
    expect(`${(params[0] as string[])[0]}_`).toBe('crm_')
  })

  it('filters delegated access member groups to the actor-visible delegated groups', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: 'admin-1',
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: 'CRM 经理层',
          group_description: 'CRM 可见组',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-1',
          name: 'CRM 经理层',
          description: 'CRM 可见组',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.memberGroups).toEqual([
      expect.objectContaining({
        id: 'group-1',
        name: 'CRM 经理层',
      }),
    ])
    expect((response.body as Record<string, any>).data.namespaceAdmissions).toEqual([
      expect.objectContaining({
        namespace: 'crm',
        enabled: true,
      }),
    ])
    expect((response.body as Record<string, any>).data.manageableNamespaces).toEqual(['crm'])
    expect(pgMocks.query.mock.calls.filter((call) => String(call[0]).includes('WITH RECURSIVE'))).toHaveLength(1)
  })

  it('updates platform namespace admission and writes audit log', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.writeUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: 'admin-1',
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha',
        role: 'user',
        is_active: true,
        is_admin: false,
        last_login_at: null,
        created_at: '2026-03-12T00:00:00.000Z',
        updated_at: '2026-03-12T00:00:00.000Z',
      }],
    })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/namespaces/:namespace/admission', {
      params: { userId: 'user-1', namespace: 'crm' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: true,
      actorId: 'admin-1',
      source: 'platform_admin',
    }), expect.objectContaining({ query: pgMocks.query }))
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-1:crm',
    }))
  })

  it('updates namespace admission in bulk and records an audit entry per user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.writeUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: false,
        effective: false,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: null,
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'user-1' },
        { id: 'user-2' },
      ],
    })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/namespaces/:namespace/admission/bulk', {
      params: { namespace: 'crm' },
      body: {
        userIds: ['user-1', 'user-2', 'user-1'],
        enabled: false,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      namespace: 'crm',
      enabled: false,
      updatedCount: 2,
      userIds: ['user-1', 'user-2'],
    })
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenCalledTimes(2)
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: false,
      actorId: 'admin-1',
      source: 'platform_admin',
    }), expect.objectContaining({ query: pgMocks.query }))
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenNthCalledWith(2, expect.objectContaining({
      userId: 'user-2',
      namespace: 'crm',
      enabled: false,
      actorId: 'admin-1',
      source: 'platform_admin',
    }), expect.objectContaining({ query: pgMocks.query }))
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-2')
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-1:crm',
      meta: expect.objectContaining({
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-2:crm',
      meta: expect.objectContaining({
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
  })

  it('updates delegated namespace admission within visible scope', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    namespaceAdmissionMocks.writeUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'delegated_admin',
        grantedBy: 'crm-admin-1',
        updatedBy: 'crm-admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce(lockedUserResult('crm-admin-1', 'user'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [{ configured: true }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })

    const response = await invokeRoute('patch', '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission', {
      params: { userId: 'user-1', namespace: 'crm' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: true,
      actorId: 'crm-admin-1',
      source: 'delegated_admin',
    }), expect.objectContaining({ query: pgMocks.query }))
  })

  it('rejects delegated role assignment outside allowed namespaces', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'qa_admin' }] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'qa_admin' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_FORBIDDEN')
  })

  it('rejects delegated role assignment when the user is outside the namespace-specific department scope', async () => {
    state.authUser = {
      id: 'plugin-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'qa_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-qa-1',
          admin_user_id: 'plugin-admin-1',
          namespace: 'qa',
          directory_department_id: 'dept-9',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1099',
          department_name: '质控部',
          department_full_path: '总部 / 质控部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: false }] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
  })

  it('assigns delegated role within allowed namespaces', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['crm:read', 'crm:write'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      // in-transaction role lock + the role's codes (delegated platform-code check)
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce(lockedUserResult('crm-admin-1', 'user'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [{ configured: true }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'crm:read' }, { permission_code: 'crm:write' }] })
      // the write boundary's own lock + code read (delegated `namespaces` scope backstop)
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'crm:read' }, { permission_code: 'crm:write' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      isPlatformAdmin: false,
      delegableNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          departmentFullPath: '总部 / 研发部',
        }),
      ],
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-1:crm_operator',
      meta: expect.objectContaining({
        delegated: true,
        delegableNamespaces: ['crm'],
      }),
    }))
  })

  it('assigns delegated role when the target user is inside a delegated member group scope', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: '制造中心',
          group_description: '制造中心成员集',
          member_count: 3,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      // in-transaction role lock + the role's codes (delegated platform-code check)
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce(lockedUserResult('crm-admin-1', 'user'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [{ configured: true }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'crm:read' }] })
      // the write boundary's own lock + code read (delegated `namespaces` scope backstop)
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'crm:read' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-1',
          name: '制造中心',
          description: '制造中心成员集',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 3,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(200)
  })

  // P23: same discriminator/mapping as the '/api/admin/users/:userId/roles/assign' coverage
  // above, exercised on the sibling delegated-role route (this is the route the P23 write-up
  // names directly — its user_roles write used to fall through to an unclassified 500 too).
  it('[recovery-census:admin-users:delegated-role-action] maps a busy recovery authority lease to a retryable 409 on the delegated role-assign route', async () => {
    state.authUser = { id: 'admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockImplementationOnce(async () => {
        const error = new Error('METASHEET_RECOVERY_AUTHORITY_BUSY') as Error & { code: string }
        error.code = '40001'
        throw error
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('RECOVERY_AUTHORITY_BUSY')
    expect((response.body as Record<string, any>).error.details).toEqual({ retryable: true })
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    census.record('admin-users:delegated-role-action')
  })

  it('blocks delegated role access when no department scope is configured', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_SCOPE_REQUIRED')
  })

  it('lists delegated admin scopes for a selected user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/scopes', {
      params: { userId: 'user-2' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      adminNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          directoryDepartmentId: 'dept-1',
        }),
      ],
    })
  })

  it('assigns a delegated admin department scope', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      adminNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          directoryDepartmentId: 'dept-1',
        }),
      ],
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'delegated-admin-scope',
      resourceId: 'user-2:crm:dept-1',
    }))
    expectScopeWriteSerialized('user-2', 'INSERT INTO delegated_role_admin_scopes')
    const scopeInsert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))
    expect(String(scopeInsert?.[0])).toContain('include_children = EXCLUDED.include_children')
    expect(scopeInsert?.[1]).toEqual(['user-2', 'crm', 'dept-1', true, 'admin-1'])
  })

  it('refuses a department scope assign when the role is gone under the admission lock', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_NAMESPACE_NOT_HELD')
    expect(namespaceAdmissionMocks.lockNamespaceAdmissionWrites).toHaveBeenCalledWith(expect.anything(), 'user-2')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))).toBe(false)
  })

  it('creates an organization scope template', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'template-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          department_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates', {
      body: { name: '华东销售', description: '华东销售线模板' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'template-1',
      name: '华东销售',
      departmentCount: 0,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'template:template-1',
    }))
  })

  it('returns 409 when creating a duplicate scope template name', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_delegated_role_scope_templates_name"',
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates', {
      body: { name: '华东销售', description: '华东销售线模板' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_SCOPE_TEMPLATE_NAME_CONFLICT')
  })

  it('creates a platform member group', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-1',
          name: '制造中心',
          description: '制造中心成员集',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/member-groups', {
      body: { name: '制造中心', description: '制造中心成员集' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'group-1',
      name: '制造中心',
      memberCount: 0,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'platform-member-group',
      resourceId: 'group:group-1',
    }))
  })

  it('returns 409 when creating a duplicate platform member group name', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_platform_member_groups_name"',
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/member-groups', {
      body: { name: '制造中心', description: '制造中心成员集' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('PLATFORM_MEMBER_GROUP_NAME_CONFLICT')
  })

  it('assigns a user to a platform member group', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { groupId: 'group-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'platform-member-group',
      resourceId: 'group-1:user-1',
    }))
  })

  it('assigns a platform member group to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: '制造中心',
          group_description: '制造中心成员集',
          member_count: 3,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', groupId: 'group-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.groupAssignments).toMatchObject([
      expect.objectContaining({
        namespace: 'crm',
        groupId: 'group-1',
        name: '制造中心',
      }),
    ])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'delegated-admin-group-scope',
      resourceId: 'user-2:crm:group:group-1',
    }))
    expectScopeWriteSerialized('user-2', 'INSERT INTO delegated_role_admin_member_groups')
  })

  it('applies template member groups to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          group_id: 'group-1',
          group_name: '华东销售经理',
          group_description: '固定经理层',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          group_name: '华东销售经理',
          group_description: '固定经理层',
          member_count: 2,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
      params: { userId: 'user-2' },
      body: { namespace: 'crm', templateId: 'template-1', mode: 'replace' },
    })

    expect(response.statusCode).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-2:crm:template:template-1',
      meta: expect.objectContaining({
        memberGroupCount: 1,
      }),
    }))
    expectScopeWriteSerialized('user-2', 'INSERT INTO delegated_role_admin_member_groups')
  })

  it('adds a department to a scope template', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'template-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'template-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          directory_department_id: 'dept-1',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', {
      params: { templateId: 'template-1', action: 'assign' },
      body: { directoryDepartmentId: 'dept-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'template-1',
      departmentCount: 1,
      departments: [
        expect.objectContaining({
          directoryDepartmentId: 'dept-1',
          departmentFullPath: '总部 / 销售部',
          includeChildren: true,
        }),
      ],
    })
    const templateInsert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_scope_template_departments'))
    expect(String(templateInsert?.[0])).toContain('ON CONFLICT (template_id, directory_department_id)')
    expect(String(templateInsert?.[0])).toContain('include_children = EXCLUDED.include_children')
    expect(templateInsert?.[1]).toEqual(['template-1', 'dept-1', true])
  })

  it('applies a scope template to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-2', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ role_id: 'crm_admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          directory_department_id: 'dept-1',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
      params: { userId: 'user-2' },
      body: { namespace: 'crm', templateId: 'template-1', mode: 'replace' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.adminNamespaces).toEqual(['crm'])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-2:crm:template:template-1',
      meta: expect.objectContaining({
        templateId: 'template-1',
        mode: 'replace',
      }),
    }))
    expectScopeWriteSerialized('user-2', 'INSERT INTO delegated_role_admin_scopes')
    const applied = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))
    expect(String(applied?.[0])).toContain('include_children = EXCLUDED.include_children')
    expect(applied?.[1]).toEqual(['user-2', 'crm', 'dept-1', true, 'admin-1'])
  })

  it('updates dingtalk grant and records an audit entry', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/dingtalk-grant', {
      params: { userId: 'user-1' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.grant).toMatchObject({
      exists: true,
      enabled: true,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-auth-grant',
      resourceId: 'user-1:dingtalk',
    }))
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
  })

  it('pins grant override supersede and generation with SQL-shaped responses', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (statement: unknown) => {
      const sql = String(statement)
      if (/FROM users[\s\S]*FOR UPDATE/i.test(sql)) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 7,
          }],
        }
      }
      if (/SELECT local_user_id, enabled[\s\S]*user_external_auth_grants/i.test(sql)) {
        return { rows: [] }
      }
      if (/UPDATE users[\s\S]*RETURNING access_generation/i.test(sql)) {
        return { rows: [{ access_generation: 8 }] }
      }
      if (/SELECT enabled,[\s\S]*FROM user_external_auth_grants/i.test(sql)) {
        return {
          rows: [{
            enabled: true,
            granted_by: 'admin-1',
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:05:00.000Z',
          }],
        }
      }
      if (/COUNT\(\*\)::int AS linked_count/i.test(sql)) {
        return { rows: [{ linked_count: 0 }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/dingtalk-grant', {
      params: { userId: 'user-1' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_events'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
  })

  it('rejects enabling dingtalk grant when bound identity is missing openId', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: 'user-1',
          corp_id: 'dingcorp',
          provider_open_id: null,
        }],
      })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/dingtalk-grant', {
      params: { userId: 'user-1' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_OPEN_ID_REQUIRED')
    expect(String((response.body as Record<string, any>).error.message || '')).toContain('missing DingTalk openId')
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toContain('provider_open_id')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('updates dingtalk grants in bulk and records an audit entry per user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', is_active: true, activation_status: 'activated', access_generation: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'user-2', is_active: true, activation_status: 'activated', access_generation: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    const response = await invokeRoute('post', '/api/admin/users/dingtalk-grants/bulk', {
      body: {
        userIds: ['user-1', 'user-2', 'user-1'],
        enabled: false,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      enabled: false,
      updatedCount: 2,
      userIds: ['user-1', 'user-2'],
    })
    const grantWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_external_auth_grants'))
    expect(String(grantWrite?.[0] || '')).toContain('INSERT INTO user_external_auth_grants')
    expect(grantWrite?.[1]).toEqual(['dingtalk', false, 'admin-1', ['user-1', 'user-2']])
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-auth-grant',
      resourceId: 'user-1:dingtalk',
      meta: expect.objectContaining({
        enabled: false,
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-auth-grant',
      resourceId: 'user-2:dingtalk',
      meta: expect.objectContaining({
        enabled: false,
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
    expect(pgMocks.query.mock.calls.filter((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toHaveLength(2)
    expect(pgMocks.query.mock.calls.filter((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toHaveLength(2)
  })

  it('rejects bulk enabling dingtalk grants when one identity is missing openId', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', is_active: true, activation_status: 'activated', access_generation: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'user-2', is_active: true, activation_status: 'activated', access_generation: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            local_user_id: 'user-2',
            corp_id: 'dingcorp',
            provider_open_id: null,
          },
        ],
      })

    const response = await invokeRoute('post', '/api/admin/users/dingtalk-grants/bulk', {
      body: {
        userIds: ['user-1', 'user-2'],
        enabled: true,
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_OPEN_ID_REQUIRED')
    expect(String((response.body as Record<string, any>).error.message || '')).toContain('user-2')
    expect(String(pgMocks.query.mock.calls[2]?.[0] || '')).toContain('provider_open_id')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('assigns a role and invalidates cached permissions', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_admin' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query.mock.calls.some((call) => call[0] === 'SELECT id FROM roles WHERE id = $1 FOR SHARE')).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('updated_at FROM roles'))).toBe(false)
    expect((response.body as Record<string, any>).data.changedRoleId).toBe('attendance_admin')
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_admin',
    }))
  })

  // P23: user_roles is one of exact-anchor recovery's eight recovery-authority tables. While
  // recovery holds its per-subject lease, an INSERT INTO user_roles fails fast with Postgres
  // 40001 (RECOVERY_AUTHORITY_BUSY_MARKER). Before this slice the route's catch always mapped
  // that (like every other error) to an unclassified 500 — mock the write throwing that exact
  // shape (no real trigger needed) and assert the route now maps it to a retryable 409 using
  // the SAME discriminator/code the multitable permission routes already use.
  it('[recovery-census:admin-users:role-assign] [recovery-census:admin-users:busy-delegation] maps a busy recovery authority lease to a retryable 409 instead of an unclassified 500', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce(async () => {
        const error = new Error('METASHEET_RECOVERY_AUTHORITY_BUSY') as Error & { code: string }
        error.code = '40001'
        throw error
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('RECOVERY_AUTHORITY_BUSY')
    expect((response.body as Record<string, any>).error.details).toEqual({ retryable: true })
    // Not the unclassified fallback this route used to return for every error.
    expect((response.body as Record<string, any>).error.code).not.toBe('ROLE_ASSIGN_FAILED')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    census.record('admin-users:role-assign')
    census.record('admin-users:busy-delegation')
  })

  it('rejects an invalid expectedUpdatedAt before the role share', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_employee', expectedUpdatedAt: 'not-a-timestamp' },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('EXPECTED_UPDATED_AT_INVALID')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('FOR SHARE'))).toBe(false)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('returns ROLE_MODIFIED when the locked role timestamp disagrees', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement === 'SELECT id FROM roles WHERE id = $1') return { rows: [{ id: 'attendance_employee' }] }
      if (statement.includes('SELECT id, updated_at FROM roles')) {
        return { rows: [{ id: 'attendance_employee', updated_at: '2020-01-01T00:00:00.000Z' }] }
      }
      if (statement.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      throw new Error(`unexpected query ${statement.slice(0, 160)}`)
    })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_employee', expectedUpdatedAt: '2026-06-01T00:00:00.000Z' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_MODIFIED')
    expect((response.body as Record<string, any>).error.details).toEqual({ retryable: true })
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO user_roles'))).toBe(false)
  })

  it('rejects a non-string expectedUpdatedAt before the role share', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    for (const expectedUpdatedAt of [1717200000000, null, '', '   ']) {
      pgMocks.query.mockClear()
      auditMocks.auditLog.mockClear()
      const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
        params: { userId: 'user-1' },
        body: { roleId: 'attendance_employee', expectedUpdatedAt },
      })

      expect(response.statusCode, JSON.stringify(expectedUpdatedAt)).toBe(400)
      expect((response.body as Record<string, any>).error.code).toBe('EXPECTED_UPDATED_AT_INVALID')
      expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('FOR SHARE'))).toBe(false)
      expect(auditMocks.auditLog).not.toHaveBeenCalled()
    }
  })

  it('returns ROLE_MODIFIED when the locked role has no updated_at', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement === 'SELECT id FROM roles WHERE id = $1') return { rows: [{ id: 'attendance_employee' }] }
      if (statement.includes('SELECT id, updated_at FROM roles')) {
        return { rows: [{ id: 'attendance_employee', updated_at: null }] }
      }
      if (statement.includes('FOR UPDATE')) {
        const id = String(params?.[0] ?? '')
        return lockedUserResult(id, id === 'admin-1' ? 'admin' : 'user')
      }
      if (statement.includes('FROM user_roles')) {
        const id = String(params?.[0] ?? '')
        return { rows: [{ role_id: id === 'admin-1' ? 'admin' : 'attendance_employee' }] }
      }
      if (statement.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_employee', expectedUpdatedAt: '2026-06-01T00:00:00.000Z' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_MODIFIED')
    expect((response.body as Record<string, any>).error.details).toEqual({ retryable: true })
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO user_roles'))).toBe(false)
  })

  it('delegated assign returns ROLE_MODIFIED without a refusal audit', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ allowed: true }] }
      if (statement.includes('delegated_role_admin_member_groups')) return { rows: [] }
      if (statement.includes('delegated_role_admin_scopes')) return { rows: [{ id: 'scope-1' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement === 'SELECT id FROM roles WHERE id = $1') return { rows: [{ id: 'crm_operator' }] }
      if (statement.includes('SELECT id, updated_at FROM roles')) {
        return { rows: [{ id: 'crm_operator', updated_at: '2020-01-01T00:00:00.000Z' }] }
      }
      if (statement.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      throw new Error(`unexpected delegated query ${statement.slice(0, 180)}`)
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator', expectedUpdatedAt: '2026-06-01T00:00:00.000Z' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_MODIFIED')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('delegated unassign ignores expectedUpdatedAt and keeps the plain role share', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ allowed: true }] }
      if (statement.includes('AS configured')) return { rows: [{ configured: true }] }
      if (statement.includes('delegated_role_admin_member_groups')) return { rows: [] }
      if (statement.includes('delegated_role_admin_scopes')) return { rows: [{ id: 'scope-1' }] }
      if (statement.includes('is_sign_in_admin')) return { rows: [{ is_sign_in_admin: false }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 2 }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('permission_code FROM role_permissions')) {
        return { rows: [{ permission_code: 'crm:read' }] }
      }
      if (statement === 'SELECT id FROM roles WHERE id = $1') return { rows: [{ id: 'crm_operator' }] }
      if (statement === 'SELECT id FROM roles WHERE id = $1 FOR SHARE') return { rows: [{ id: 'crm_operator' }] }
      if (statement.includes('FOR UPDATE')) return lockedUserResult(String(params?.[0] ?? 'user-1'), 'user')
      if (statement.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'unassign' },
      body: { roleId: 'crm_operator', expectedUpdatedAt: 'not-a-timestamp' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    expect(pgMocks.query.mock.calls.some((call) => call[0] === 'SELECT id FROM roles WHERE id = $1 FOR SHARE')).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('updated_at FROM roles'))).toBe(false)
  })

  it('assigns platform admin and syncs legacy admin columns', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['admin:all'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'admin',
          is_active: true,
          is_admin: true,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'admin' }, { role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      role: 'admin',
      is_admin: true,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET role = CASE'),
      ['user-1', true],
    )
    expect(namespaceAdmissionMocks.lockNamespaceAdmissionWrites).toHaveBeenCalledWith(expect.anything(), 'user-1')
    const lockAt = namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mock.invocationCallOrder[0]
    const insertAt = pgMocks.query.mock.invocationCallOrder[
      pgMocks.query.mock.calls.findIndex((call) => String(call[0]).includes('INSERT INTO user_roles'))
    ]
    const legacyAt = pgMocks.query.mock.invocationCallOrder[
      pgMocks.query.mock.calls.findIndex((call) => String(call[0]).includes('SET role = CASE'))
    ]
    expect(lockAt).toBeLessThan(insertAt)
    expect(insertAt).toBeLessThan(legacyAt)
  })

  it.each(['platform', 'delegated'] as const)('%s admin assign keeps the admission lock and legacy profile inside one transaction', async (entry) => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const events: string[] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => pgMocks.query(sql, params)),
    }
    vi.mocked(transaction).mockImplementationOnce(async (callback) => {
      events.push('begin')
      const result = await callback(client as never)
      events.push('commit')
      return result
    })
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        const id = String(params?.[0])
        if (id === 'admin-1') return lockedUserResult(id, 'admin')
        if (id === 'user-1') return lockedUserResult(id)
        throw new Error('Unexpected locked user')
      }
      if (sql.includes('INSERT INTO user_roles')) {
        events.push('insert')
        return { rows: [{ user_id: 'user-1' }], rowCount: 1 }
      }
      if (sql.includes('SET role = CASE')) {
        events.push('legacy')
        return { rows: [] }
      }
      if (sql.includes('FROM roles')) return { rows: [{ id: 'admin' }] }
      if (sql.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'admin',
            is_active: true, is_admin: true, last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z', updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('role_id')) return { rows: [{ role_id: 'admin' }] }
      return { rows: [] }
    })
    namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mockImplementation(async () => {
      events.push('admission')
    })

    const response = await invokeRoute('post', entry === 'platform'
      ? '/api/admin/users/:userId/roles/assign'
      : '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(events).toEqual(['begin', 'admission', 'admission', 'insert', 'legacy', 'commit'])
  })

  it('delegated unassign refuses the last platform admin before the admission lock', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const events: string[] = []
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        events.push('invariant')
        return { rows: [] }
      }
      if (sql.includes('is_sign_in_admin')) return { rows: [{ is_sign_in_admin: true }] }
      if (sql.includes('COUNT(*)')) return { rows: [{ c: 0 }] }
      if (sql.includes('DELETE FROM user_roles') || sql.includes('SET role = CASE')) {
        events.push('write')
        return { rows: [] }
      }
      if (sql.includes('FROM roles')) return { rows: [{ id: 'admin' }] }
      if (sql.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'admin',
            is_active: true, is_admin: true, last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z', updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })
    namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mockImplementation(async () => {
      events.push('admission')
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'unassign' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as { error: { code: string } }).error.code).toBe('LAST_PLATFORM_ADMIN')
    expect(events).toEqual(['invariant'])
  })

  it('unassigns a role and writes an audit entry', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    namespaceAdmissionMocks.listRoleNamespaces.mockResolvedValue(['attendance'])
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockResolvedValue(['attendance'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.changedRoleId).toBe('attendance_admin')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_admin',
      meta: expect.objectContaining({
        disabledNamespaces: ['attendance'],
      }),
    }))
  })

  it('unassigns platform admin and clears legacy admin columns', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'admin',
          is_active: true,
          is_admin: true,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ is_sign_in_admin: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      role: 'user',
      is_admin: false,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET role = CASE'),
      ['user-1', false],
    )
  })

  it.each(['platform', 'delegated'] as const)('%s unassign holds one transaction through lock, DELETE and revoke witness', async (entry) => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const events: string[] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('DELETE FROM user_roles')) events.push('delete')
        return pgMocks.query(sql, params)
      }),
    }
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        const id = String(params?.[0])
        if (id === 'admin-1') return lockedUserResult(id, 'admin')
        if (id === 'user-1') return lockedUserResult(id)
        throw new Error('Unexpected locked user')
      }
      if (sql.includes('FROM users')) return { rows: [{ id: 'user-1', role: 'user', is_active: true, permissions: [] }] }
      if (sql.includes('FROM roles WHERE')) return { rows: [{ id: 'attendance_employee' }] }
      if (sql.includes('DELETE FROM user_roles')) return { rows: [{ user_id: 'user-1' }], rowCount: 1 }
      return { rows: [] }
    })
    vi.mocked(transaction).mockImplementationOnce(async (callback) => {
      events.push('begin')
      const result = await callback(client)
      events.push('commit')
      return result
    })
    namespaceAdmissionMocks.lockNamespaceAdmissionWrites.mockImplementation(async (executor, userId) => {
      expect(executor).toBe(client)
      expect(['admin-1', 'user-1']).toContain(userId)
      events.push('lock:' + userId)
    })
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockImplementationOnce(async (options, runQuery) => {
      expect(runQuery).toBe(client.query)
      expect(options).toEqual({
        userId: 'user-1', namespaces: [], actorId: 'admin-1',
        source: 'role_unassigned', revokedRoleId: 'attendance_employee',
      })
      expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
      events.push('witness')
      return []
    })

    const response = await invokeRoute('post', entry === 'platform'
      ? '/api/admin/users/:userId/roles/unassign'
      : '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'unassign' },
      body: { roleId: 'attendance_employee' },
    })

    expect(response.statusCode).toBe(200)
    expect(events).toEqual(['begin', 'lock:admin-1', 'lock:user-1', 'delete', 'witness', 'commit'])
    expect(namespaceAdmissionMocks.listRoleNamespaces).toHaveBeenCalledWith('attendance_employee', client.query)
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
  })

  it('unassigns attendance_employee with DELETE rowCount 1 and reports roleHeld false', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['workflow:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_employee' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-1' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_employee' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data).toMatchObject({
      changedRoleId: 'attendance_employee',
      actorId: 'admin-1',
      roleHeld: false,
      membershipChanged: true,
      roles: [],
      permissions: ['workflow:read'],
    })
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('DELETE FROM user_roles'))).toBe(true)
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
  })

  it('reports leftover membership when unassign DELETE rowCount is 0 and the snapshot still holds the role', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_employee' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1', 'user'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_employee' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data).toMatchObject({
      changedRoleId: 'attendance_employee',
      actorId: 'admin-1',
      roleHeld: true,
      membershipChanged: false,
      roles: ['attendance_employee'],
      permissions: ['attendance:read'],
    })
  })

  it('lists role catalog with permissions and member counts', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'attendance_admin',
          name: 'Attendance Admin',
          permissions: ['attendance:admin', 'attendance:read'],
          member_count: 3,
        },
      ],
    })

    const response = await invokeRoute('get', '/api/admin/roles')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'attendance_admin',
      name: 'Attendance Admin',
      memberCount: 3,
      permissions: ['attendance:admin', 'attendance:read'],
      admissionNamespaces: ['attendance'],
    })
  })

  it('lists access presets for admin user provisioning', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('get', '/api/admin/access-presets')

    expect(response.statusCode).toBe(200)
    const body = (response.body as Record<string, any>).data
    expect(body.capabilities).toEqual({ explicitNamespaceAdmission: true })
    const attendance = (body.items as Array<Record<string, unknown>>).find((item) => item.id === 'attendance-employee')
    expect(attendance?.admissionNamespaces).toEqual(['attendance'])
    const viewer = (body.items as Array<Record<string, unknown>>).find((item) => item.id === 'platform-viewer')
    expect(viewer?.admissionNamespaces).toEqual([])
  })

  it('filters access presets by product mode', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('get', '/api/admin/access-presets', {
      query: { mode: 'attendance' },
    })

    expect(response.statusCode).toBe(200)
    const items = (response.body as Record<string, any>).data.items as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.productMode === 'attendance')).toBe(true)
  })

  it('reports live database capabilities and ignores a token admin claim', async () => {
    const readCapabilities = async (
      account: Record<string, unknown> | null,
      roleIds: string[],
    ) => {
      pgMocks.query.mockImplementation(async (sql: string) => {
        const statement = String(sql)
        if (statement.includes('to_jsonb(users)')) {
          return { rows: account ? [account] : [] }
        }
        if (statement.includes('FROM user_roles')) {
          return { rows: roleIds.map((roleId) => ({ role_id: roleId })) }
        }
        return { rows: [] }
      })
      return invokeRoute('get', '/api/admin/access-capabilities')
    }
    const operable = {
      role: 'user',
      is_active: true,
      activation_status: 'activated',
      deleted_at: null,
      purged_at: null,
      is_admin: true,
    }

    state.authUser = { id: 'user-1', role: 'admin' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    let response = await readCapabilities(operable, [])
    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })

    response = await readCapabilities({ ...operable, role: 'admin', is_admin: false }, [])
    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toEqual({
      isPlatformAdmin: true,
      canManageScope: true,
      canManagePermissions: false,
      delegableNamespaces: [],
    })

    response = await readCapabilities(operable, ['admin', 'attendance_admin'])
    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toEqual({
      isPlatformAdmin: true,
      canManageScope: true,
      canManagePermissions: true,
      delegableNamespaces: [],
    })

    response = await readCapabilities(operable, ['attendance_admin'])
    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toEqual({
      isPlatformAdmin: false,
      canManageScope: true,
      canManagePermissions: false,
      delegableNamespaces: ['attendance'],
    })

    response = await readCapabilities({ ...operable, is_active: false, role: 'admin' }, ['attendance_admin'])
    expect(response.statusCode).toBe(401)

    response = await readCapabilities({ ...operable, activation_status: 'pending_activation', role: 'admin' }, ['admin'])
    expect(response.statusCode).toBe(401)

    response = await readCapabilities({ ...operable, deleted_at: '2026-01-01T00:00:00.000Z', role: 'admin' }, ['admin'])
    expect(response.statusCode).toBe(401)

    response = await readCapabilities({
      ...operable,
      deleted_at: '2026-01-01T00:00:00.000Z',
      purged_at: '2026-01-01T00:00:00.000Z',
      role: 'admin',
    }, ['admin'])
    expect(response.statusCode).toBe(401)

    response = await readCapabilities(null, ['admin'])
    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })

    state.authUser = { id: '', role: 'admin' }
    response = await readCapabilities(operable, ['admin'])
    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error.code).toBe('UNAUTHENTICATED')
  })

  it('updates user active status', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
          access_generation: 0,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ role_id: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ is_sign_in_admin: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:01:00.000Z',
          updated_at: '2026-03-12T00:01:00.000Z',
          updated_by: 'admin-1',
          reason: 'user-disabled',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: false,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/status', {
      params: { userId: 'user-1' },
      body: { isActive: false },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user.is_active).toBe(false)
    expect(auditMocks.auditLog).toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
  })

  it('refuses to disable the last sign-in platform admin', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('is_sign_in_admin')) return { rows: [{ is_sign_in_admin: true }] }
      if (text.includes('COUNT(*)')) return { rows: [{ c: 0 }] }
      if (text.includes('FOR UPDATE')) {
        const id = String(params?.[0] ?? 'admin-2')
        return {
          rows: [{
            id,
            email: 'other@example.com',
            name: '另一位',
            role: 'admin',
            is_active: true,
            activation_status: 'activated',
            access_generation: 0,
            deleted_at: null,
            purged_at: null,
            is_admin: true,
          }],
        }
      }
      if (text.includes('FROM user_roles') && text.includes('role_id')) {
        return { rows: [{ role_id: 'admin' }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/status', {
      params: { userId: 'admin-2' },
      body: { isActive: false },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('LAST_PLATFORM_ADMIN')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('SET is_active'))).toBe(false)
  })

  it('creates a user with preset-driven onboarding metadata', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_employee' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-new',
          email: 'new@example.com',
          name: 'New User',
          employeeNo: 'E-2026-010',
          department: 'Assembly',
          position: 'Operator',
          hireDate: '2026-05-29',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-new',
          email: 'new@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        employeeNo: ' E-2026-010 ',
        department: ' Assembly ',
        position: ' Operator ',
        hireDate: '2026-05-29',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user.email).toBe('new@example.com')
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      employeeNo: 'E-2026-010',
      department: 'Assembly',
      position: 'Operator',
      hireDate: '2026-05-29',
    })
    expect((response.body as Record<string, any>).data.roles).toEqual(['attendance_employee'])
    expect((response.body as Record<string, any>).data.onboarding.productMode).toBe('attendance')
    expect((response.body as Record<string, any>).data.inviteToken).toBe('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.inviteMessage)).toContain('推荐入口：/attendance')
    expect(bcryptMocks.hash).toHaveBeenCalledWith('WelcomePass9A', 10)
    const insertCall = pgMocks.query.mock.calls.find((args) => String(args[0]).includes('INSERT INTO users ('))
    expect(insertCall?.[1]).toEqual(expect.arrayContaining([
      'E-2026-010',
      'Assembly',
      'Operator',
      '2026-05-29',
    ]))
    expect(auditMocks.auditLog).toHaveBeenCalled()
    // Default create enables nothing. Attendance is persisted disabled so a missing
    // row cannot bootstrap attendance_employee on the next login.
    expect(namespaceAdmissionMocks.grantNamespaceAdmissions).not.toHaveBeenCalled()
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'attendance',
      enabled: false,
      source: 'admin_create',
    }), expect.anything())
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO user_namespace_admissions'))).toBe(false)
  })

  it('POSITIVE CONTROL — a preset that derives no namespace still persists disabled attendance', async () => {
    // Without this, the leg above would also pass against a route that enables an admission
    // unconditionally — which would over-grant every platform preset.
    rbacMocks.isAdmin.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM users\n     WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-plat', email: 'plat@example.com', name: 'Plat', role: 'user',
            is_active: true, is_admin: false, created_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'plat@example.com',
        name: 'Plat',
        password: 'WelcomePass9A',
        presetId: 'platform-viewer',
        isActive: true,
      },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    expect(namespaceAdmissionMocks.grantNamespaceAdmissions).not.toHaveBeenCalled()
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'attendance',
      enabled: false,
      source: 'admin_create',
    }), expect.anything())
  })

  it('opens only an explicitly requested namespace that the selected role derives', async () => {
    rbacMocks.isAdmin.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM roles r') && statement.includes('role_permissions')) {
        return { rows: [{ id: 'attendance_employee', permissions: ['attendance:read'] }] }
      }
      if (statement.includes('FROM users') && statement.includes('WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-new',
            email: 'new@example.com',
            name: 'New User',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'attendance_employee' }] }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        admissionNamespaces: [' attendance ', 'attendance'],
      },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    expect(namespaceAdmissionMocks.grantNamespaceAdmissions).toHaveBeenCalledTimes(1)
    const admissionOptions = namespaceAdmissionMocks.grantNamespaceAdmissions.mock.calls[0]?.[1] as {
      namespaces: string[]
      source?: string
    }
    expect(admissionOptions.namespaces).toEqual(['attendance'])
    expect(admissionOptions.source).toBe('admin_create')
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).not.toHaveBeenCalled()
  })

  it('rejects an admission list that is not derived from the selected role and writes nothing', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM roles r')) {
        return { rows: [{ id: 'attendance_employee', permissions: ['attendance:read'] }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        admissionNamespaces: ['attendance', 'stock-prep'],
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('ADMISSION_NAMESPACE_NOT_DERIVED')
    expect(namespaceAdmissionMocks.grantNamespaceAdmissions).not.toHaveBeenCalled()
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).not.toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO users ('))).toBe(false)
  })

  it('rejects a non-array admission list before any user insert', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        admissionNamespaces: 'attendance',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('ADMISSION_NAMESPACES_INVALID')
    expect(pgMocks.query).not.toHaveBeenCalled()
    expect(namespaceAdmissionMocks.grantNamespaceAdmissions).not.toHaveBeenCalled()
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).not.toHaveBeenCalled()
  })

  it('rejects a namespace the admission control does not support', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    namespaceAdmissionMocks.isNamespaceAdmissionControlledResource.mockImplementation(
      (namespace: string) => namespace === 'attendance',
    )
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM roles r')) {
        return { rows: [{ id: 'attendance_employee', permissions: ['attendance:read', 'multitable:read'] }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        admissionNamespaces: ['multitable'],
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('NAMESPACE_NOT_SUPPORTED')
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).not.toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO users ('))).toBe(false)
  })

  it('derives an explicit admission from the role permission codes when the preset has none', async () => {
    rbacMocks.isAdmin.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM roles r')) {
        return { rows: [{ id: 'attendance_employee', permissions: ['attendance:write'] }] }
      }
      if (statement.includes('FROM users') && statement.includes('WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-role-ns',
            email: 'role-ns@example.com',
            name: 'Role Ns',
            role: 'user',
            is_active: true,
            is_admin: false,
            created_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'role-ns@example.com',
        name: 'Role Ns',
        password: 'WelcomePass9A',
        presetId: 'platform-viewer',
        roleId: 'attendance_employee',
        admissionNamespaces: ['attendance'],
      },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const admissionOptions = namespaceAdmissionMocks.grantNamespaceAdmissions.mock.calls[0]?.[1] as {
      namespaces: string[]
    }
    expect(admissionOptions.namespaces).toEqual(['attendance'])
    expect(namespaceAdmissionMocks.writeUserNamespaceAdmission).not.toHaveBeenCalled()
  })

  it('creates attendance group membership and default shift assignment during user provisioning', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111'
    const shiftId = '22222222-2222-4222-8222-222222222222'
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users WHERE lower(username)')) return { rows: [] }
      if (statement.includes('FROM attendance_groups')) {
        return { rows: [{ id: groupId, name: '总装一组' }] }
      }
      if (statement.includes('FROM attendance_shifts')) {
        return { rows: [{ id: shiftId, name: '早班', segment_count: 1 }] }
      }
      if (statement.includes('INSERT INTO users (')) return { rows: [] }
      if (statement.includes('INSERT INTO attendance_group_members')) {
        expect(params).toEqual(['default', groupId, expect.any(String)])
        return { rows: [{ memberId: 'member-1' }] }
      }
      if (statement.includes('INSERT INTO attendance_shift_assignments')) {
        expect(params).toEqual([expect.any(String), 'default', expect.any(String), shiftId, '2026-06-01'])
        return { rows: [{ assignmentId: 'assignment-1' }] }
      }
      if (statement.includes('FROM users') && statement.includes('WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-new',
            email: null,
            username: 'newuser',
            name: 'New User',
            employeeNo: 'E-2026-011',
            department: 'Assembly',
            position: 'Operator',
            hireDate: '2026-05-29',
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      if (statement.includes('FROM user_roles')) return { rows: [] }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        username: 'newuser',
        name: 'New User',
        employeeNo: 'E-2026-011',
        department: 'Assembly',
        position: 'Operator',
        hireDate: '2026-05-29',
        attendanceGroupId: groupId,
        defaultShiftId: shiftId,
        defaultShiftStartDate: '2026-06-01',
        password: 'WelcomePass9A',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.attendanceOnboarding).toMatchObject({
      orgId: 'default',
      group: {
        id: groupId,
        name: '总装一组',
        memberCreated: true,
      },
      defaultShift: {
        id: shiftId,
        name: '早班',
        startDate: '2026-06-01',
        assignmentId: 'assignment-1',
      },
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create',
      resourceType: 'user',
      meta: expect.objectContaining({
        attendanceOnboarding: expect.objectContaining({
          orgId: 'default',
          group: expect.objectContaining({ id: groupId }),
          defaultShift: expect.objectContaining({ id: shiftId, startDate: '2026-06-01' }),
        }),
      }),
    }))
    const statements = pgMocks.query.mock.calls.map(([sql]) => String(sql))
    const lockedShiftIndex = statements.findIndex((statement) =>
      statement.includes('FROM attendance_shifts s') && statement.includes('FOR SHARE'),
    )
    const userInsertIndex = statements.findIndex((statement) => statement.includes('INSERT INTO users ('))
    expect(lockedShiftIndex).toBeGreaterThanOrEqual(0)
    expect(userInsertIndex).toBeGreaterThan(lockedShiftIndex)
  })

  it.each([
    ['explicit attendanceOrgId', {
      attendanceOrgId: '33333333-3333-4333-8333-333333333333',
      orgId: '33333333-3333-4333-8333-333333333333',
    }],
    ['group/shift-derived org', { orgId: '33333333-3333-4333-8333-333333333333' }],
  ])('admits a multi-segment default shift only through the canonical posture seam (%s)', async (_label, orgFields) => {
    const orgId = '33333333-3333-4333-8333-333333333333'
    const shiftId = '22222222-2222-4222-8222-222222222222'
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    attendanceW4Mocks.resolveSegmentCalculationPosture.mockResolvedValue({ referenceSegments: true })
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users WHERE lower(username)')) return { rows: [] }
      if (statement.includes('FROM directory_integrations')) return { rows: [{ found: 1 }] }
      if (statement.includes('FROM attendance_shifts s') && statement.includes('FOR SHARE')) {
        return { rows: [{ id: shiftId, segment_count: 2 }] }
      }
      if (statement.includes('FROM attendance_shifts')) {
        return { rows: [{ id: shiftId, name: '双段班' }] }
      }
      if (statement.includes('INSERT INTO users (')) return { rows: [] }
      if (statement.includes('INSERT INTO attendance_shift_assignments')) {
        expect(params).toEqual([expect.any(String), orgId, expect.any(String), shiftId, '2026-06-01'])
        return { rows: [{ assignmentId: 'assignment-w4' }] }
      }
      if (statement.includes('FROM users') && statement.includes('WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-new',
            email: null,
            username: 'newuser',
            name: 'New User',
            employeeNo: null,
            department: null,
            position: null,
            hireDate: null,
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      if (statement.includes('FROM user_roles')) return { rows: [] }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        username: 'newuser',
        name: 'New User',
        defaultShiftId: shiftId,
        defaultShiftStartDate: '2026-06-01',
        password: 'WelcomePass9A',
        isActive: true,
        ...orgFields,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(attendanceW4Mocks.parseCanonicalAttendanceRolloutOrgKeyV1).toHaveBeenCalledWith(orgId)
    expect(attendanceW4Mocks.acquireAttendanceCalculationRolloutLock).toHaveBeenCalledWith(
      expect.anything(),
      orgId,
      'shared',
    )
    expect(attendanceW4Mocks.resolveSegmentCalculationPosture).toHaveBeenCalledWith(expect.anything(), orgId)
    const userInsertIndex = pgMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO users ('))
    expect(userInsertIndex).toBeGreaterThanOrEqual(0)
    expect(attendanceW4Mocks.resolveSegmentCalculationPosture.mock.invocationCallOrder[0])
      .toBeLessThan(pgMocks.query.mock.invocationCallOrder[userInsertIndex])
  })

  it('rejects attendance onboarding when the selected group does not exist', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111'
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users WHERE email = $1')) return { rows: [] }
      if (statement.includes('FROM attendance_groups')) return { rows: [] }
      if (statement.includes('INSERT INTO users (')) {
        throw new Error('unexpected user insert')
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        attendanceGroupId: groupId,
        password: 'WelcomePass9A',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).error.code).toBe('ATTENDANCE_GROUP_NOT_FOUND')
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users ('))).toBe(false)
  })

  it('rejects create user requests when password policy fails', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'weak@example.com',
        name: 'Weak Password User',
        password: 'weak',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('PASSWORD_POLICY_FAILED')
    // English message and the `details.details` string array are unchanged; `details.reasons`
    // is the additive machine-readable list the web console localises by.
    expect((response.body as Record<string, any>).error.message).toBe('Password does not meet requirements')
    expect((response.body as Record<string, any>).error.details).toEqual({
      details: [
        'Password must be at least 8 characters long',
        'Password must contain at least one uppercase letter',
        'Password must contain at least one number',
      ],
      reasons: ['too_short', 'no_uppercase', 'no_digit'],
    })
  })

  it('rejects a create-user password containing a common fragment with only the weak_pattern reason', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        username: 'operator.a',
        name: 'Operator A',
        password: '123456Asd',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toEqual({
      code: 'PASSWORD_POLICY_FAILED',
      message: 'Password does not meet requirements',
      details: {
        details: ['Password contains a common weak pattern'],
        reasons: ['weak_pattern'],
      },
    })
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users ('))).toBe(false)
  })

  it('rejects a non-ASCII login name with INVALID_USERNAME and the stable login_name_ascii rule code', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        username: '测试员',
        name: '测试员',
        password: '12345Asd',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toEqual({
      code: 'INVALID_USERNAME',
      message: 'Username must be 3-64 characters and include at least one letter. Only lowercase letters, numbers, dot, underscore, and dash are allowed',
      details: { rule: 'login_name_ascii' },
    })
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users ('))).toBe(false)
  })

  it('creates a no-email user with username/mobile and skips invite issuance', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-temp-password')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-no-email',
          email: null,
          username: 'liqing',
          name: '李青',
          mobile: '13900001234',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-04-18T00:00:00.000Z',
          updated_at: '2026-04-18T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        name: '李青',
        username: 'liqing',
        mobile: '13900001234',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user.email).toBeNull()
    expect((response.body as Record<string, any>).data.user.username).toBe('liqing')
    expect((response.body as Record<string, any>).data.temporaryPassword).toBeTruthy()
    expect((response.body as Record<string, any>).data.inviteToken).toBeNull()
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl || '')).toBe('')
    expect(String((response.body as Record<string, any>).data.onboarding.inviteMessage)).toContain('账号：liqing')
    expect(inviteMocks.issueInviteToken).not.toHaveBeenCalled()
  })

  /**
   * Load-bearing alias full-writer route hooks (admin_create / admin_profile_mobile).
   * Removing claimNonEmptyLoginAliasesOrThrow / applyMobileLoginAliasChangeOrThrow from the
   * production handlers, or swapping previousMobile back to the pre-txn snapshot, must red these.
   */
  it('POST /api/admin/users invokes claimNonEmptyLoginAliasesOrThrow with exact identifiers + txn client', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users WHERE email')) return { rows: [] }
      if (statement.includes('SELECT id FROM users WHERE lower(username)')) return { rows: [] }
      if (statement.includes('SELECT id FROM users WHERE mobile')) return { rows: [] }
      if (statement.includes('INSERT INTO users (')) return { rows: [] }
      if (statement.includes('FROM users') && statement.includes('WHERE id = $1')) {
        return {
          rows: [{
            id: 'user-new',
            email: 'hook@example.com',
            username: 'hookuser',
            name: 'Hook User',
            mobile: '13900139000',
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          }],
        }
      }
      if (statement.includes('FROM user_roles')) return { rows: [] }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'hook@example.com',
        username: 'hookuser',
        mobile: '13900139000',
        name: 'Hook User',
        password: 'WelcomePass9A',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow).toHaveBeenCalledTimes(1)
    expect(loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'hook@example.com',
        username: 'hookuser',
        mobile: '13900139000',
        source: 'admin_create',
        client: expect.objectContaining({ query: expect.any(Function) }),
        userId: expect.any(String),
      }),
    )
  })

  it('POST /api/admin/users maps LoginAliasClaimError ALIAS_CONFLICT to safe 409', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users')) return { rows: [] }
      if (statement.includes('INSERT INTO users (')) return { rows: [] }
      return { rows: [] }
    })
    loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow.mockRejectedValueOnce(
      new LoginAliasClaimError('ALIAS_CONFLICT', 'email'),
    )

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'taken@example.com',
        name: 'Taken',
        password: 'WelcomePass9A',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(409)
    const body = response.body as Record<string, any>
    expect(body.error?.code).toBe('LOGIN_ALIAS_CONFLICT')
    expect(String(body.error?.message || '')).toBe('A login identifier is already claimed by another account')
    expect(JSON.stringify(body)).not.toMatch(/DETAIL|duplicate key|5432|relation/i)
  })

  it('POST /api/admin/users maps LoginAliasClaimError ALIAS_WRITE_FAILED to safe 500', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('SELECT id FROM users')) return { rows: [] }
      if (statement.includes('INSERT INTO users (')) return { rows: [] }
      return { rows: [] }
    })
    loginAliasWriterMocks.claimNonEmptyLoginAliasesOrThrow.mockRejectedValueOnce(
      new LoginAliasClaimError('ALIAS_WRITE_FAILED', 'email'),
    )

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'fail@example.com',
        name: 'Fail',
        password: 'WelcomePass9A',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(500)
    const body = response.body as Record<string, any>
    expect(body.error?.code).toBe('LOGIN_ALIAS_FAILED')
    expect(String(body.error?.message || '')).toBe('Failed to claim login alias')
    expect(JSON.stringify(body)).not.toMatch(/DETAIL|connection refused|5432/i)
  })

  it('PATCH profile mobile locks row FOR UPDATE and passes locked previousMobile to alias helper', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    // Pre-read is intentionally STALE (null) vs locked row (13800138000).
    // Using profile.mobile for retire would pass null; production must use the lock.
    const stalePreRead = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: null as string | null,
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    const lockedRow = { ...stalePreRead, mobile: '13800138000' }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...stalePreRead }] })
      .mockResolvedValueOnce({ rows: [{ ...lockedRow }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // UPDATE
      .mockResolvedValueOnce({
        rows: [{ ...lockedRow, mobile: '13900139000', updated_at: '2026-03-13T00:00:00.000Z' }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13900139000' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toMatch(/FOR UPDATE/)
    expect(loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow).toHaveBeenCalledTimes(1)
    expect(loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        previousMobile: '13800138000', // from lock, NOT stale null pre-read
        nextMobile: '13900139000',
        source: 'admin_profile_mobile',
        client: expect.objectContaining({ query: expect.any(Function) }),
        afterNewClaim: expect.any(Function),
      }),
    )
  })

  it('PATCH profile mobile maps LoginAliasClaimError ALIAS_CONFLICT to safe 409', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: '13800138000',
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
    loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow.mockRejectedValueOnce(
      new LoginAliasClaimError('ALIAS_CONFLICT', 'mobile'),
    )

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13900139000' },
    })

    expect(response.statusCode).toBe(409)
    const body = response.body as Record<string, any>
    expect(body.error?.code).toBe('LOGIN_ALIAS_CONFLICT')
    expect(JSON.stringify(body)).not.toMatch(/DETAIL|duplicate key|5432/i)
  })

  it('PATCH profile mobile maps LoginAliasClaimError ALIAS_WRITE_FAILED to safe 500', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const profileRow = {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      mobile: '13800138000',
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      last_login_at: null,
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow }] })
    loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow.mockRejectedValueOnce(
      new LoginAliasClaimError('ALIAS_WRITE_FAILED', 'mobile'),
    )

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13900139000' },
    })

    expect(response.statusCode).toBe(500)
    const body = response.body as Record<string, any>
    expect(body.error?.code).toBe('LOGIN_ALIAS_FAILED')
    expect(JSON.stringify(body)).not.toMatch(/DETAIL|connection refused|5432/i)
  })

  it('PATCH profile mobile returns 404 when locked row is missing', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          mobile: '13800138000',
          employeeNo: null,
          department: null,
          position: null,
          hireDate: null,
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // FOR UPDATE: gone

    const response = await invokeRoute('patch', '/api/admin/users/:userId/profile', {
      params: { userId: 'user-1' },
      body: { mobile: '13900139000' },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).error?.code).toBe('NOT_FOUND')
    expect(loginAliasWriterMocks.applyMobileLoginAliasChangeOrThrow).not.toHaveBeenCalled()
  })

  it('resets password and returns temporary password', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-temp-password')
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:02:00.000Z',
          updated_at: '2026-03-12T00:02:00.000Z',
          updated_by: 'admin-1',
          reason: 'password-reset',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/reset-password', {
      params: { userId: 'user-1' },
      body: { password: 'TempPass9A' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[0]?.[0])).toContain('deleted_at IS NULL')
    expect(String(pgMocks.query.mock.calls[0]?.[0])).toContain('purged_at IS NULL')
    expect((response.body as Record<string, any>).data.temporaryPassword).toBe('TempPass9A')
    expect(bcryptMocks.hash).toHaveBeenCalledWith('TempPass9A', 10)
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('does not reset a password for a recycled profile', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/reset-password', {
      params: { userId: 'user-gone' },
      body: {},
    })

    expect(response.statusCode).toBe(404)
    expect(String(pgMocks.query.mock.calls[0]?.[0])).toContain('deleted_at IS NULL')
    expect(String(pgMocks.query.mock.calls[0]?.[0])).toContain('purged_at IS NULL')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('password_hash'))).toBe(false)
  })

  it('revokes all sessions for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:03:00.000Z',
          updated_at: '2026-03-12T00:03:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-1' },
      body: { reason: 'admin-force-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.userId).toBe('user-1')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-logout')
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('lists single sessions for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
      ipAddress: '127.0.0.1',
    })
  })

  it('revokes a single session for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:30:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'admin-force-single-session-logout',
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:30:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-1', sessionId: 'sess-1' },
      body: { reason: 'admin-force-single-session-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-1')
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('lists admin audit activity for IAM resources', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          created_at: '2026-03-12T00:04:00.000Z',
          event_type: 'CREATE',
          event_category: 'SYSTEM',
          event_severity: 'INFO',
          action: 'create',
          resource_type: 'user',
          resource_id: 'user-1',
          user_id: null,
          user_name: null,
          user_email: null,
          action_details: { email: 'alpha@example.com', adminUserId: 'admin-1' },
          error_code: null,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/audit-activity', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.total).toBe(2)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      resource_type: 'user',
      action: 'create',
    })
  })

  it('lists invite ledger records', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/invites', {
      query: { userId: 'user-1', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.total).toBe(1)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      user_id: 'user-1',
      email: 'alpha@example.com',
      product_mode: 'attendance',
      status: 'pending',
    })
  })

  it('marks expired invite tokens as expired in invite ledger responses', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-expired',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/invites')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'invite-expired',
      status: 'expired',
    })
  })

  it('resends invite and returns refreshed onboarding metadata', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-old',
          status: 'revoked',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:20:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:20:00.000Z',
          user_name: null,
          invited_by_email: null,
          invited_by_name: null,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/resend', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'invite-1',
      status: 'pending',
      invite_token: 'invite-token-fixed',
    })
    expect((response.body as Record<string, any>).data.inviteToken).toBe('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-token-fixed')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      resourceType: 'user-invite',
      resourceId: 'invite-1',
    }))
  })

  function resendLedgerRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'invite-1',
      user_id: 'user-1',
      email: 'alpha@example.com',
      preset_id: 'attendance-employee',
      product_mode: 'attendance',
      role_id: 'attendance_employee',
      invited_by: 'admin-1',
      invite_token: 'invite-token-old',
      status: 'pending',
      accepted_at: null,
      consumed_by: null,
      last_sent_at: '2026-03-12T00:00:00.000Z',
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:10:00.000Z',
      user_name: 'Alpha',
      invited_by_email: 'admin@example.com',
      invited_by_name: 'Admin',
      ...overrides,
    }
  }

  // An account that has completed its first sign-in is not sent another invite.
  it.each([
    ['pending'],
    ['revoked'],
  ])('refuses to resend a %s invite for an account that has completed its first sign-in, and writes nothing', async (status) => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({ rows: [resendLedgerRow({ status, account_onboarded: true })] })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/resend', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('INVITE_ACCOUNT_ALREADY_ONBOARDED')
    // The read that decides is the only statement; no token is issued and nothing is audited.
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('UPDATE user_invites'))).toBe(false)
    expect(inviteMocks.issueInviteToken).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it.each([
    ['pending', 'pending', 'invite-token-old'],
    ['revoked', 'revoked', 'invite-token-old'],
    // A pending row whose token is past its expiry reads as expired.
    ['expired', 'pending', 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig'],
  ])('still resends a %s invite for an account that has never signed in', async (_label, status, storedToken) => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [resendLedgerRow({ status, invite_token: storedToken, account_onboarded: false })] })
      .mockResolvedValueOnce({
        rows: [resendLedgerRow({
          status: 'pending',
          invite_token: 'invite-token-fixed',
          user_name: null,
          invited_by_email: null,
          invited_by_name: null,
        })],
      })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/resend', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.inviteToken).toBe('invite-token-fixed')
    expect(inviteMocks.issueInviteToken).toHaveBeenCalledTimes(1)
    expect(pgMocks.query).toHaveBeenCalledTimes(2)
  })

  it('decides a resend from the row status, the account sign-in record and its accepted invites, in the read and in the write', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [resendLedgerRow({ account_onboarded: false })] })
      .mockResolvedValueOnce({ rows: [resendLedgerRow({ invite_token: 'invite-token-fixed' })] })

    await invokeRoute('post', '/api/admin/invites/:inviteId/resend', { params: { inviteId: 'invite-1' } })

    const squash = (sql: unknown) => String(sql).replace(/\s+/g, ' ')
    const readSql = squash(pgMocks.query.mock.calls[0]?.[0])
    const writeSql = squash(pgMocks.query.mock.calls[1]?.[0])
    const signedIn = (row: string) =>
      `EXISTS ( SELECT 1 FROM users onboarded_user WHERE onboarded_user.id = ${row}.user_id AND onboarded_user.last_login_at IS NOT NULL )`
    const acceptedBefore = (row: string) =>
      `EXISTS ( SELECT 1 FROM user_invites accepted_invite WHERE accepted_invite.user_id = ${row}.user_id AND accepted_invite.status = 'accepted' )`
    expect(readSql).toContain(`( ${signedIn('inv')} OR ${acceptedBefore('inv')} ) AS account_onboarded`)
    expect(writeSql).toContain('UPDATE user_invites')
    expect(writeSql).toContain(
      `WHERE id = $1 AND status <> 'accepted' AND NOT ( ${signedIn('user_invites')} OR ${acceptedBefore('user_invites')} ) RETURNING`,
    )
    expect(pgMocks.query.mock.calls[1]?.[1]).toEqual(['invite-1', 'invite-token-fixed', 'admin-1'])
  })

  it('answers a conflict and audits nothing when the resend write matches no row', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [resendLedgerRow({ account_onboarded: false })] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/resend', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('INVITE_RESEND_CONFLICT')
    expect((response.body as Record<string, any>).data).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('invite-token-fixed')
    expect(pgMocks.query).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('revokes a pending invite and writes an audit entry', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'invite-1',
        user_id: 'user-1',
        email: 'alpha@example.com',
        preset_id: 'attendance-employee',
        product_mode: 'attendance',
        role_id: 'attendance_employee',
        invited_by: 'admin-1',
        invite_token: 'invite-token-fixed',
        status: 'revoked',
        accepted_at: null,
        consumed_by: null,
        last_sent_at: '2026-03-12T00:00:00.000Z',
        created_at: '2026-03-12T00:00:00.000Z',
        updated_at: '2026-03-12T00:10:00.000Z',
        user_name: null,
        invited_by_email: null,
        invited_by_name: null,
      }],
    })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/revoke', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'invite-1',
      status: 'revoked',
      email: 'alpha@example.com',
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-invite',
      resourceId: 'invite-1',
    }))
  })

  it('exports admin audit activity as csv', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        created_at: '2026-03-12T00:04:00.000Z',
        event_type: 'CREATE',
        event_category: 'SYSTEM',
        event_severity: 'INFO',
        action: 'create',
        resource_type: 'user',
        resource_id: 'user-1',
        user_id: null,
        user_name: 'Alpha',
        user_email: 'alpha@example.com',
        action_details: { adminUserId: 'admin-1' },
        error_code: null,
      }],
    })

    const response = await invokeRoute('get', '/api/admin/audit-activity/export.csv', {
      query: { q: 'alpha', resourceType: 'user', action: 'create', limit: '10' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.textBody).toContain('id,created_at,resource_type,resource_id,action')
    expect(response.textBody).toContain('alpha@example.com')
  })

  it('applies date filters to admin audit activity queries', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/audit-activity', {
      query: { from: '2026-03-10', to: '2026-03-12', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('created_at >=')
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('created_at <=')
    expect(pgMocks.query.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
      ['user', 'user-role', 'user-auth-grant', 'user-namespace-admission', 'user-password', 'user-session', 'user-invite', 'role', 'permission', 'permission-template', 'delegated-admin-scope', 'delegated-admin-scope-template', 'platform-member-group', 'delegated-admin-group-scope'],
      '2026-03-10T00:00:00.000Z',
      '2026-03-12T23:59:59.999Z',
    ])
  })

  it('lists forced session revocation history', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'user-1',
          revoked_after: '2026-03-12T00:03:00.000Z',
          updated_at: '2026-03-12T00:03:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
          user_email: 'alpha@example.com',
          user_name: 'Alpha',
          updated_by_email: 'admin@example.com',
          updated_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/session-revocations', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      user_id: 'user-1',
      reason: 'admin-force-logout',
      user_email: 'alpha@example.com',
      updated_by_email: 'admin@example.com',
    })
  })

  it('applies date filters to session revocation queries', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/session-revocations', {
      query: { from: '2026-03-10', to: '2026-03-12', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('usr.updated_at >=')
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('usr.updated_at <=')
    expect(pgMocks.query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual([
      '2026-03-10T00:00:00.000Z',
      '2026-03-12T23:59:59.999Z',
    ])
  })

  it('POST activate maps ACTIVATE_ALIAS_FAILED to 500 with fixed safe message (no PG text)', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const pgLeak =
      'duplicate key value violates unique constraint "user_login_aliases_normalized_value_key" DETAIL: Key (normalized_value)=(shared) already exists. connection refused 5432'
    const err = new Error(pgLeak) as Error & { code?: string }
    err.code = 'ACTIVATE_ALIAS_FAILED'
    activateMocks.activatePendingUser.mockRejectedValueOnce(err)

    const response = await invokeRoute('post', '/api/admin/users/:id/activate', {
      params: { id: 'pending-user-1' },
      body: { mode: 'temp_password', temporaryPassword: 'TempPass9A!' },
    })

    expect(response.statusCode).toBe(500)
    const body = response.body as { ok?: boolean; error?: { code?: string; message?: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('ACTIVATE_ALIAS_FAILED')
    expect(body.error?.message).toBe('Failed to claim login alias during activation')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(/duplicate key|DETAIL|connection refused|5432|user_login_aliases/i)
    expect(activateMocks.activatePendingUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'pending-user-1',
        mode: 'temp_password',
        adminUserId: 'admin-1',
      }),
    )
  })

  it('POST activate maps ACTIVATE_ALIAS_CONFLICT to 409 (positive control)', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const err = new Error(
      'Login alias for username is already claimed by another account',
    ) as Error & { code?: string }
    err.code = 'ACTIVATE_ALIAS_CONFLICT'
    activateMocks.activatePendingUser.mockRejectedValueOnce(err)

    const response = await invokeRoute('post', '/api/admin/users/:id/activate', {
      params: { id: 'pending-user-2' },
      body: { mode: 'temp_password', temporaryPassword: 'TempPass9A!' },
    })

    expect(response.statusCode).toBe(409)
    const body = response.body as { ok?: boolean; error?: { code?: string; message?: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('ACTIVATE_ALIAS_CONFLICT')
    expect(body.error?.message).toMatch(/already claimed/i)
  })

  it('POST activate rejects an unknown mode before calling the activation service', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users/:id/activate', {
      params: { id: 'pending-user-3' },
      body: { mode: 'passwordish' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'ACTIVATE_REQUEST_INVALID' },
    })
    expect(activateMocks.activatePendingUser).not.toHaveBeenCalled()
  })

  it('POST bulk activate validates every item before the first activation write', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users/activate/bulk', {
      body: {
        items: [
          { userId: 'pending-user-1', mode: 'temp_password' },
          { userId: 'pending-user-2', mode: 'not-a-mode' },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'ACTIVATE_REQUEST_INVALID' },
    })
    expect(activateMocks.activatePendingUser).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('POST bulk activate rejects duplicate users before the first activation write', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users/activate/bulk', {
      body: {
        items: [
          { userId: 'pending-user-1', mode: 'temp_password' },
          { userId: 'pending-user-1', mode: 'sso' },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'ACTIVATE_BULK_DUPLICATE_USER' },
    })
    expect(activateMocks.activatePendingUser).not.toHaveBeenCalled()
  })

  // #4833 + verify-workflow findings: (a) the bulk envelope must carry ACTIVATE_ORG_AMBIGUOUS
  // per-item; (b) no test asserted the routes actually THREAD the parsed orgId into
  // activatePendingUser — a route that dropped it would leave every mapping test green.
  it('POST bulk activate surfaces ACTIVATE_ORG_AMBIGUOUS per-item and threads each item orgId', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    activateMocks.activatePendingUser
      .mockRejectedValueOnce(Object.assign(
        new Error('dual active sources detail: da-1 da-2 DETAIL: secret'),
        { code: 'ACTIVATE_ORG_AMBIGUOUS' },
      ))
      .mockResolvedValueOnce({
        userId: 'pending-user-2',
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: false,
        membershipOrgId: 'org-b',
      })

    const response = await invokeRoute('post', '/api/admin/users/activate/bulk', {
      body: {
        items: [
          { userId: 'pending-user-1', mode: 'admin_no_password' },
          { userId: 'pending-user-2', mode: 'admin_no_password', orgId: 'org-b' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        successCount: 1,
        failureCount: 1,
        items: [
          {
            userId: 'pending-user-1',
            ok: false,
            error: {
              status: 409,
              code: 'ACTIVATE_ORG_AMBIGUOUS',
              message: 'Multiple active directory sources in different orgs; orgId is required to disambiguate',
            },
          },
          { userId: 'pending-user-2', ok: true },
        ],
      },
    })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|da-1/i)
    // Threading: the parsed orgId reached the activation service verbatim, item by item.
    expect(activateMocks.activatePendingUser).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ userId: 'pending-user-1', orgId: undefined }))
    expect(activateMocks.activatePendingUser).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ userId: 'pending-user-2', orgId: 'org-b' }))
    // #4833 audit surface: the successful item's audit row records WHICH org was chosen.
    const activateAudit = auditMocks.auditLog.mock.calls
      .map((call) => call[0])
      .find((entry) => entry?.resourceId === 'pending-user-2')
    expect(activateAudit?.meta).toMatchObject({ membershipOrgId: 'org-b' })
  })

  // Closeout review P1: the bulk route inherits the derived-org rule through the SAME
  // activatePendingUser + mapActivateError pair as the single route — a steered orgId fails
  // per-item as a safe 409 while the rest of the batch proceeds.
  it('POST bulk activate surfaces ACTIVATE_ORG_MISMATCH per-item without killing the batch', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    activateMocks.activatePendingUser
      .mockRejectedValueOnce(Object.assign(
        new Error('org drift detail: integration org_id org-A DETAIL: secret'),
        { code: 'ACTIVATE_ORG_MISMATCH' },
      ))
      .mockResolvedValueOnce({
        userId: 'pending-user-2',
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: false,
      })

    const response = await invokeRoute('post', '/api/admin/users/activate/bulk', {
      body: {
        items: [
          { userId: 'pending-user-1', mode: 'admin_no_password', orgId: 'org-B' },
          { userId: 'pending-user-2', mode: 'admin_no_password' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        successCount: 1,
        failureCount: 1,
        items: [
          {
            userId: 'pending-user-1',
            ok: false,
            error: {
              status: 409,
              code: 'ACTIVATE_ORG_MISMATCH',
              message: 'orgId does not match the directory source integration for this user',
            },
          },
          { userId: 'pending-user-2', ok: true },
        ],
      },
    })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|org drift detail/i)
  })

  it('POST bulk activate keeps item transactions independent and returns only safe failures', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    activateMocks.activatePendingUser
      .mockResolvedValueOnce({
        userId: 'pending-user-1',
        activationStatus: 'activated',
        isActive: true,
        temporaryPassword: 'TempPass9A!',
        localPasswordSet: true,
      })
      .mockRejectedValueOnce(Object.assign(
        new Error('DETAIL: union id secret connection refused 5432'),
        { code: 'ACTIVATE_SOURCE_INELIGIBLE' },
      ))

    const response = await invokeRoute('post', '/api/admin/users/activate/bulk', {
      body: {
        items: [
          {
            userId: 'pending-user-1',
            mode: 'temp_password',
            temporaryPassword: 'TempPass9A!',
          },
          {
            userId: 'pending-user-2',
            mode: 'sso',
            directoryAccountId: 'account-2',
          },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        successCount: 1,
        failureCount: 1,
        items: [
          {
            userId: 'pending-user-1',
            ok: true,
            result: {
              activationStatus: 'activated',
              temporaryPassword: 'TempPass9A!',
            },
          },
          {
            userId: 'pending-user-2',
            ok: false,
            error: {
              status: 409,
              code: 'ACTIVATE_SOURCE_INELIGIBLE',
              message: 'Directory source is not eligible for DingTalk SSO activation',
            },
          },
        ],
      },
    })
    expect(activateMocks.activatePendingUser).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(response.body)).not.toMatch(/DETAIL|union id secret|connection refused|5432/i)
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resourceId: 'bulk-activate',
        meta: {
          source: 'admin_activate_bulk',
          requestedCount: 2,
          successCount: 1,
          failureCount: 1,
        },
      }),
    )
  })

  // #6259: POST /api/admin/users and the DingTalk directory admission use ONE login-name rule
  // (auth/login-name-rule.ts). This leg pins that the create-user route answers with the shared
  // module's sentence and accepts what the shared rule accepts; login-name-rule.test.ts pins that
  // no private copy of the rule is left in this route.
  it('create-user applies the shared login-name rule (#6259)', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const rejected = await invokeRoute('post', '/api/admin/users', {
      body: {
        username: '测试员',
        name: '测试员',
        password: 'WelcomePass9A',
      },
    })

    expect(rejected.statusCode).toBe(400)
    expect((rejected.body as Record<string, any>).error.code).toBe('INVALID_USERNAME')
    expect((rejected.body as Record<string, any>).error.message).toBe(LOGIN_NAME_RULE_MESSAGE)
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users ('))).toBe(false)

    for (const tooShort of ['ab', '12345']) {
      const response = await invokeRoute('post', '/api/admin/users', {
        body: { username: tooShort, name: 'Operator A', password: 'WelcomePass9A' },
      })
      expect(response.statusCode, tooShort).toBe(400)
      expect((response.body as Record<string, any>).error.message, tooShort).toBe(LOGIN_NAME_RULE_MESSAGE)
    }
  })

  it('rejects a non-boolean includeChildren before a scope write', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    for (const includeChildren of [null, 'yes', 1, { nested: true }]) {
      pgMocks.query.mockClear()
      const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
        params: { userId: 'user-2', action: 'assign' },
        body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren },
      })

      expect(response.statusCode, JSON.stringify(includeChildren)).toBe(400)
      expect((response.body as Record<string, any>).error.code).toBe('INCLUDE_CHILDREN_INVALID')
      expect(pgMocks.query).not.toHaveBeenCalled()
    }
  })

  it('persists includeChildren false and updates it on conflict', async () => {
    vi.stubEnv('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'true')
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('FOR UPDATE')) {
        const id = String(params?.[0] ?? '')
        return lockedUserResult(id, id === 'admin-1' ? 'admin' : 'user')
      }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('FROM directory_departments')) return { rows: [{ id: 'dept-1' }] }
      if (statement.includes('FROM users')) {
        return { rows: [{ id: 'user-2', name: 'Plugin Admin', role: 'user', is_active: true }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const scopeInsert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))
    expect(String(scopeInsert?.[0])).toContain('include_children = EXCLUDED.include_children')
    expect(scopeInsert?.[1]).toEqual(['user-2', 'crm', 'dept-1', false, 'admin-1'])
  })

  it('ignores includeChildren on scope unassign', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('FOR UPDATE')) {
        const id = String(params?.[0] ?? '')
        return lockedUserResult(id, id === 'admin-1' ? 'admin' : 'user')
      }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('FROM users')) {
        return { rows: [{ id: 'user-2', name: 'Plugin Admin', role: 'user', is_active: true }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'unassign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: 'no' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('DELETE FROM delegated_role_admin_scopes'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))).toBe(false)
  })

  function mockDelegatedScopeReads(options: { storedScope?: boolean | null; templateDepartment?: boolean | null } = {}): void {
    const storedScope = options.storedScope === undefined ? null : options.storedScope
    const templateDepartment = options.templateDepartment === undefined ? null : options.templateDepartment
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('FOR UPDATE') && statement.includes('delegated_role_scope_templates')) {
        return { rows: [{ id: 'template-1' }] }
      }
      if (statement.includes('FOR UPDATE')) {
        const id = String(params?.[0] ?? '')
        return lockedUserResult(id, id === 'admin-1' ? 'admin' : 'user')
      }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('FROM users')) {
        return { rows: [{ id: 'user-2', name: 'Plugin Admin', role: 'user', is_active: true }] }
      }
      if (statement.includes('FROM directory_departments') && !statement.includes('delegated_role_scope_template_departments')) {
        return { rows: [{ id: 'dept-1' }] }
      }
      if (statement.includes('SELECT include_children') && statement.includes('delegated_role_admin_scopes')) {
        return storedScope === null ? { rows: [] } : { rows: [{ include_children: storedScope }] }
      }
      if (statement.includes('SELECT include_children') && statement.includes('delegated_role_scope_template_departments')) {
        return templateDepartment === null ? { rows: [] } : { rows: [{ include_children: templateDepartment }] }
      }
      if (statement.includes('FROM delegated_role_scope_templates') && !statement.includes('COUNT(')) {
        return { rows: [{ id: 'template-1' }] }
      }
      if (statement.includes('FROM delegated_role_scope_template_departments')) {
        return templateDepartment === null
          ? { rows: [] }
          : { rows: [{ directory_department_id: 'dept-1', include_children: templateDepartment }] }
      }
      return { rows: [] }
    })
  }

  function delegatedScopeMutations(): string[] {
    return pgMocks.query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => (
        sql.includes('INSERT INTO delegated_role_admin_scopes')
        || sql.includes('DELETE FROM delegated_role_admin_scopes')
        || sql.includes('INSERT INTO delegated_role_scope_template_departments')
        || sql.includes('DELETE FROM delegated_role_scope_template_departments')
        || sql.includes('UPDATE delegated_role_scope_templates')
        || sql.includes('INSERT INTO delegated_role_admin_member_groups')
        || sql.includes('DELETE FROM delegated_role_admin_member_groups')
      ))
  }

  function stubExactDepartmentFlag(value: string | undefined): void {
    if (value === undefined) vi.unstubAllEnvs()
    else vi.stubEnv('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', value)
  }

  it('reports exactDepartmentScopeAvailable only for the byte-exact true flag', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      return { rows: [] }
    })

    const read = async () => {
      const response = await invokeRoute('get', '/api/admin/role-delegation/summary')
      expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
      return (response.body as Record<string, any>).data.exactDepartmentScopeAvailable
    }

    expect(await read()).toBe(false)
    for (const value of ['1', 'TRUE', ' true ', 'true ', 'yes', 'on']) {
      stubExactDepartmentFlag(value)
      expect(await read(), value).toBe(false)
    }
    stubExactDepartmentFlag('true')
    expect(await read()).toBe(true)
  })

  it('refuses an explicit exact department on direct and template assign before any query', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    for (const value of [undefined, '1', 'TRUE', ' true ', 'true '] as const) {
      stubExactDepartmentFlag(value)
      pgMocks.query.mockClear()
      auditMocks.auditLog.mockClear()
      rbacMocks.invalidateUserPerms.mockClear()

      const direct = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
        params: { userId: 'user-2', action: 'assign' },
        body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false },
      })
      const template = await invokeRoute('post', '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', {
        params: { templateId: 'template-1', action: 'assign' },
        body: { directoryDepartmentId: 'dept-1', includeChildren: false },
      })

      for (const response of [direct, template]) {
        expect(response.statusCode, String(value)).toBe(403)
        expect((response.body as Record<string, any>).error).toEqual({
          code: 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED',
          message: 'Exact department scope is disabled',
        })
      }
      expect(pgMocks.query, String(value)).not.toHaveBeenCalled()
      expect(auditMocks.auditLog, String(value)).not.toHaveBeenCalled()
      expect(rbacMocks.invalidateUserPerms, String(value)).not.toHaveBeenCalled()
    }
  })

  it('refuses template apply of a locked exact department before merge or replace writes', async () => {
    for (const value of [undefined, '1', 'TRUE', ' true ', 'true '] as const) {
      for (const mode of ['merge', 'replace'] as const) {
        stubExactDepartmentFlag(value)
        mockDelegatedScopeReads({ templateDepartment: false })
        auditMocks.auditLog.mockClear()
        rbacMocks.invalidateUserPerms.mockClear()

        const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
          params: { userId: 'user-2' },
          body: { namespace: 'crm', templateId: 'template-1', mode },
        })

        expect(response.statusCode, `${String(value)} ${mode} ${JSON.stringify(response.body)}`).toBe(403)
        expect((response.body as Record<string, any>).error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')
        expect(delegatedScopeMutations(), mode).toEqual([])
        expect(auditMocks.auditLog).not.toHaveBeenCalled()
        expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
        const sqls = pgMocks.query.mock.calls.map((call) => String(call[0]))
        const userLock = sqls.findIndex((sql) => sql.includes('FROM users') && sql.includes('FOR UPDATE'))
        const templateLock = sqls.findIndex((sql) => sql.includes('delegated_role_scope_templates') && sql.includes('FOR UPDATE'))
        const departmentRead = sqls.findIndex((sql) => sql.includes('FROM delegated_role_scope_template_departments'))
        expect(userLock, mode).toBeGreaterThanOrEqual(0)
        expect(templateLock, mode).toBeGreaterThan(userLock)
        expect(departmentRead, mode).toBeGreaterThan(templateLock)
      }
    }
  })

  it('persists the locked exact department on apply when the flag is byte-exact true', async () => {
    vi.stubEnv('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'true')
    for (const mode of ['merge', 'replace'] as const) {
      mockDelegatedScopeReads({ templateDepartment: false })
      auditMocks.auditLog.mockClear()

      const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
        params: { userId: 'user-2' },
        body: { namespace: 'crm', templateId: 'template-1', mode },
      })

      expect(response.statusCode, `${mode} ${JSON.stringify(response.body)}`).toBe(200)
      const sqls = pgMocks.query.mock.calls.map((call) => String(call[0]))
      const departmentRead = sqls.findIndex((sql) => sql.includes('FROM delegated_role_scope_template_departments'))
      const deleted = sqls.findIndex((sql) => sql.includes('DELETE FROM delegated_role_admin_scopes'))
      const insert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))
      expect(insert?.[1]).toEqual(['user-2', 'crm', 'dept-1', false, 'admin-1'])
      if (mode === 'replace') expect(deleted).toBeGreaterThan(departmentRead)
      else expect(deleted).toBe(-1)
      expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          mode,
          includeChildrenSemantics: [{
            directoryDepartmentId: 'dept-1',
            includeChildren: false,
            semantics: 'exact-department',
          }],
        }),
      }))
    }
  })

  it('preserves a stored exact department when an omitted assign runs with the flag off', async () => {
    mockDelegatedScopeReads({ storedScope: false, templateDepartment: false })

    const direct = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })
    expect(direct.statusCode, JSON.stringify(direct.body)).toBe(200)
    const scopeInsert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))
    expect(scopeInsert?.[1]).toEqual(['user-2', 'crm', 'dept-1', false, 'admin-1'])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        includeChildren: false,
        includeChildrenSemantics: 'exact-department',
      }),
    }))

    pgMocks.query.mockClear()
    auditMocks.auditLog.mockClear()
    const template = await invokeRoute('post', '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', {
      params: { templateId: 'template-1', action: 'assign' },
      body: { directoryDepartmentId: 'dept-1' },
    })
    expect(template.statusCode, JSON.stringify(template.body)).toBe(200)
    const templateInsert = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_scope_template_departments'))
    expect(templateInsert?.[1]).toEqual(['template-1', 'dept-1', false])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      meta: {
        templateId: 'template-1',
        directoryDepartmentId: 'dept-1',
        includeChildren: false,
        includeChildrenSemantics: 'exact-department',
      },
    }))
  })

  it('keeps omitted assigns true when nothing exact is stored, and widens a stored exact row only while the flag is on', async () => {
    mockDelegatedScopeReads()
    const created = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200)
    expect(pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))?.[1]).toEqual([
      'user-2', 'crm', 'dept-1', true, 'admin-1',
    ])

    vi.stubEnv('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'true')
    mockDelegatedScopeReads({ storedScope: false })
    const widened = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })
    expect(widened.statusCode, JSON.stringify(widened.body)).toBe(200)
    expect(pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))?.[1]).toEqual([
      'user-2', 'crm', 'dept-1', true, 'admin-1',
    ])
  })

  it('allows an explicit true write while the flag is off', async () => {
    mockDelegatedScopeReads({ storedScope: false })
    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: true },
    })
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    expect(pgMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))?.[1]).toEqual([
      'user-2', 'crm', 'dept-1', true, 'admin-1',
    ])
  })

  it('audits unassign from the stored exact bit and omits the flag when no row was stored', async () => {
    mockDelegatedScopeReads({ storedScope: false, templateDepartment: false })
    const removed = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'unassign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false },
    })
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      meta: {
        userId: 'user-2',
        namespace: 'crm',
        directoryDepartmentId: 'dept-1',
        includeChildren: false,
        includeChildrenSemantics: 'exact-department',
      },
    }))
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO delegated_role_admin_scopes'))).toBe(false)

    auditMocks.auditLog.mockClear()
    const templateRemoved = await invokeRoute('post', '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', {
      params: { templateId: 'template-1', action: 'unassign' },
      body: { directoryDepartmentId: 'dept-1', includeChildren: true },
    })
    expect(templateRemoved.statusCode, JSON.stringify(templateRemoved.body)).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      meta: {
        templateId: 'template-1',
        directoryDepartmentId: 'dept-1',
        includeChildren: false,
        includeChildrenSemantics: 'exact-department',
      },
    }))

    mockDelegatedScopeReads()
    auditMocks.auditLog.mockClear()
    const missing = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'unassign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: true },
    })
    expect(missing.statusCode, JSON.stringify(missing.body)).toBe(200)
    const meta = auditMocks.auditLog.mock.calls.at(-1)?.[0]?.meta as Record<string, unknown>
    expect(meta).toEqual({
      userId: 'user-2',
      namespace: 'crm',
      directoryDepartmentId: 'dept-1',
      includeChildrenSemantics: 'unassigned',
    })
    expect(meta).not.toHaveProperty('includeChildren')
  })

  it('expands delegated department scope only when the seed includes children', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) {
        return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1', include_children: false }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users', {})

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const statements = pgMocks.query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes('WITH RECURSIVE'))
    expect(statements.length).toBeGreaterThan(0)
    for (const sql of statements) {
      expect(sql).toContain('bool_or(COALESCE(s.include_children, TRUE))')
      expect(sql).toContain('parent.include_children IS TRUE')
    }
    const items = (response.body as Record<string, any>).data.items as Array<Record<string, unknown>>
    expect(items[0]).not.toHaveProperty('selectable')
    expect((response.body as Record<string, any>).data.scopeAssignments[0].includeChildren).toBe(false)
  })

  it('adds grey rows only for includeIneligible=true and strips everything but id and name', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user', tenantId: 'org-1' } as typeof state.authUser
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('corp_id IS NOT NULL')) {
        return { rows: [{ id: 'grey-1', name: 'Grey Person', email: 'grey@example.com', role: 'user' }] }
      }
      if (statement.includes('FROM user_orgs')) return { rows: [{ org_id: 'org-1' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) {
        return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1', include_children: true }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true', q: 'Grey' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const items = (response.body as Record<string, any>).data.items as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ id: 'user-1', selectable: true })
    expect(items[1]).toEqual({
      id: 'grey-1',
      name: 'Grey Person',
      selectable: false,
      disabledReason: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    })
    expect(items[1]).not.toHaveProperty('email')
    const greyCall = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('corp_id IS NOT NULL'))
    const greySql = String(greyCall?.[0])
    expect(greySql).toContain('user_orgs')
    expect(greySql).toContain("i.status = 'active'")
    expect(greySql).not.toContain('user_tenants')
    expect(greySql).not.toContain('email')
    expect(greyCall?.[1]?.[3]).toBe('%Grey%')
  })

  it('omits a user from grey when any link is already authorized, including off the current page, and skips purged rows', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    state.authenticatedTenantId = 'org-1'
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('corp_id IS NOT NULL')) {
        return { rows: [{ id: 'grey-1', name: 'Outside Only' }] }
      }
      if (statement.includes('FROM user_orgs')) return { rows: [{ org_id: 'org-1' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }, { role_id: 'qa_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) {
        return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1', include_children: true }] }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true', page: '1', pageSize: '20' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const greySql = String(pgMocks.query.mock.calls.find((call) => String(call[0]).includes('corp_id IS NOT NULL'))?.[0])
    const authority = greySql.slice(greySql.indexOf('authority_seeds AS ('), greySql.indexOf('scope_seeds AS ('))
    expect(authority).toContain('l.local_user_id')
    expect(authority).toContain('authority_departments')
    expect(authority).toContain('namespace = ANY($2::text[])')
    expect(authority).not.toContain('i.org_id')
    expect(authority).not.toContain('i.status')
    expect(authority).not.toContain('i.provider')
    expect(authority).not.toContain('corp_id')
    expect(authority).not.toContain('ILIKE')
    expect(authority).not.toContain('LIMIT')
    const expansion = greySql.slice(greySql.indexOf('scope_seeds AS ('))
    expect(expansion).toContain("i.status = 'active'")
    expect(expansion).toContain('i.org_id = $3')
    expect(expansion).toContain('d.provider = i.provider')
    expect(expansion).toContain('i.corp_id IS NOT NULL')
    expect(expansion).toContain('auth_user.id = u.id')
    expect(greySql).not.toContain('scoped_ad.directory_account_id = a.id')
    expect(greySql).toContain('u.purged_at IS NULL')
    expect(greySql).toContain('actor_user.purged_at IS NULL')
    const authorizedList = pgMocks.query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes('WITH RECURSIVE') && !sql.includes('authority_seeds'))
    expect(authorizedList.length).toBeGreaterThan(0)
    for (const sql of authorizedList) expect(sql).not.toContain('authority_seeds')
    const orgProof = pgMocks.query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes('FROM user_orgs') && !sql.includes('corp_id IS NOT NULL'))
    expect(orgProof.length).toBeGreaterThan(0)
    for (const sql of orgProof) expect(sql).toContain('u.purged_at IS NULL')
    const ids = ((response.body as Record<string, any>).data.items as Array<{ id: string }>).map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('limits grey suggestions to the requested page and never more than 100 while search still applies', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user' }
    state.authenticatedTenantId = 'org-1'
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('corp_id IS NOT NULL')) return { rows: [{ id: 'grey-1', name: 'Outside Only' }] }
      if (statement.includes('FROM user_orgs')) return { rows: [{ org_id: 'org-1' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ id: 'user-1', name: 'Alpha' }] }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1' }] }
      }
      return { rows: [] }
    })

    for (const [requested, expected] of [['20', 20], ['500', 100]] as const) {
      pgMocks.query.mockClear()
      const response = await invokeRoute('get', '/api/admin/role-delegation/users', {
        query: { includeIneligible: 'true', q: 'Grey', pageSize: requested },
      })
      expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
      const greyCall = pgMocks.query.mock.calls.find((call) => String(call[0]).includes('LIMIT $5'))
      expect(String(greyCall?.[0])).toContain('LIMIT $5')
      expect(greyCall?.[1]?.[3]).toBe('%Grey%')
      expect(greyCall?.[1]?.[4]).toBe(expected)
    }
  })

  it('keeps the authorized list when the grey query fails or the org is not provable', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user', tenantId: 'org-1' } as typeof state.authUser
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('corp_id IS NOT NULL')) throw new Error('grey lookup failed')
      if (statement.includes('FROM user_orgs')) return { rows: [{ org_id: 'org-1' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1' }] }
      }
      return { rows: [] }
    })

    const failed = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(failed.statusCode, JSON.stringify(failed.body)).toBe(200)
    expect((failed.body as Record<string, any>).data.items).toEqual([
      expect.objectContaining({ id: 'user-1', selectable: true }),
    ])

    state.authUser = { id: 'crm-admin-1', role: 'user' }
    pgMocks.query.mockClear()
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM user_orgs')) return { rows: [{ org_id: 'org-a' }, { org_id: 'org-b' }] }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ id: 'user-1', name: 'Alpha' }] }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1' }] }
      }
      return { rows: [] }
    })
    const unprovable = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(unprovable.statusCode).toBe(200)
    expect((unprovable.body as Record<string, any>).data.items).toEqual([
      expect.objectContaining({ id: 'user-1', selectable: true }),
    ])
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('corp_id IS NOT NULL'))).toBe(false)
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('user_tenants'))).toBe(false)

    state.authUser = { id: 'crm-admin-1', role: 'user', tenantId: 'org-header' }
    state.authenticatedTenantId = undefined
    pgMocks.query.mockClear()
    const headerOnly = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(headerOnly.statusCode).toBe(200)
    expect((headerOnly.body as Record<string, any>).data.items).toEqual([
      expect.objectContaining({ id: 'user-1', selectable: true }),
    ])
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('corp_id IS NOT NULL'))).toBe(false)

    state.authenticatedTenantId = 'org-scoped'
    pgMocks.query.mockClear()
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('corp_id IS NOT NULL')) {
        return { rows: [{ id: 'grey-1', name: 'Grey Person' }] }
      }
      if (statement.includes('FROM user_orgs')) {
        return params?.[1] ? { rows: [{ org_id: params[1] }] } : { rows: [{ org_id: 'org-a' }, { org_id: 'org-b' }] }
      }
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ id: 'user-1', name: 'Alpha' }] }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1' }] }
      }
      return { rows: [] }
    })
    const bound = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(bound.statusCode).toBe(200)
    expect((bound.body as Record<string, any>).data.items.map((item: { id: string }) => item.id)).toContain('grey-1')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes("i.status = 'active'"))).toBe(true)
  })

  it('does not add grey rows for a member-only scope or a platform admin', async () => {
    state.authUser = { id: 'crm-admin-1', role: 'user', tenantId: 'org-1' } as typeof state.authUser
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('FROM user_roles')) return { rows: [{ role_id: 'crm_admin' }] }
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('WITH RECURSIVE')) return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      if (statement.includes('delegated_role_admin_member_groups')) {
        return { rows: [{ id: 'group-scope-1', namespace: 'crm', group_id: 'group-1' }] }
      }
      return { rows: [] }
    })

    const memberOnly = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(memberOnly.statusCode, JSON.stringify(memberOnly.body)).toBe(200)
    expect((memberOnly.body as Record<string, any>).data.items).toEqual([
      expect.objectContaining({ id: 'user-1', name: 'Alpha', selectable: true }),
    ])
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('corp_id IS NOT NULL'))).toBe(false)

    state.authUser = { id: 'admin-1', role: 'admin', tenantId: 'org-1' } as typeof state.authUser
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('COUNT(*)')) return { rows: [{ c: 1 }] }
      if (statement.includes('FROM users')) return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com' }] }
      return { rows: [] }
    })
    const platform = await invokeRoute('get', '/api/admin/role-delegation/users', {
      query: { includeIneligible: 'true' },
    })
    expect(platform.statusCode).toBe(200)
    const platformItems = (platform.body as Record<string, any>).data.items as Array<Record<string, unknown>>
    expect(platformItems[0]).not.toHaveProperty('selectable')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('user_orgs'))).toBe(false)
  })

  it('filters delegated access and assignable roles to the namespaces that contain the target', async () => {
    state.authUser = { id: 'plugin-admin-1', role: 'user' }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes('WITH RECURSIVE')) {
        const namespaces = Array.isArray(params?.[1]) ? params?.[1] as string[] : []
        if (namespaces.length === 1) return { rows: [{ allowed: namespaces[0] === 'crm' }] }
        return { rows: [{ allowed: true }] }
      }
      if (statement.includes('FROM user_roles')) {
        const id = String(params?.[0] ?? '')
        if (id === 'plugin-admin-1') return { rows: [{ role_id: 'crm_admin' }, { role_id: 'qa_admin' }] }
        return { rows: [{ role_id: 'crm_operator' }, { role_id: 'qa_operator' }] }
      }
      if (statement.includes('FROM users')) {
        return { rows: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com', role: 'user', is_active: true }] }
      }
      if (statement.includes('delegated_role_admin_scopes')) {
        return { rows: [{ id: 'scope-1', namespace: 'crm', directory_department_id: 'dept-1' }] }
      }
      if (statement.includes('FROM roles r')) {
        return {
          rows: [
            { id: 'crm_operator', name: 'CRM Operator', permissions: ['crm:read'], updated_at: '2026-06-01T00:00:00.000Z' },
            { id: 'qa_operator', name: 'QA Operator', permissions: ['qa:read'], updated_at: '2026-06-01T00:00:00.000Z' },
          ],
        }
      }
      return { rows: [] }
    })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
    const data = (response.body as Record<string, any>).data
    expect(data.delegableNamespaces).toEqual(['crm', 'qa'])
    expect(data.manageableNamespaces).toEqual(['crm'])
    expect(data.roleCatalog.map((role: { id: string }) => role.id)).toEqual(['crm_operator'])
    expect(data.delegableRoles).toEqual(['crm_operator'])
    expect(data.roleCatalog[0].updatedAt).toBe('2026-06-01T00:00:00.000Z')
    const perNamespace = pgMocks.query.mock.calls.filter((call) => {
      const namespaces = (call[1] as unknown[] | undefined)?.[1]
      return String(call[0]).includes('WITH RECURSIVE') && Array.isArray(namespaces) && namespaces.length === 1
    })
    expect(perNamespace).toHaveLength(2)
  })

// O2-A1 (census reachability): one discriminating behaviour leg PER
// sendIfRecoveryAuthorityBusy writer call site that had none. Each leg drives the REAL
// route until its recovery-authority write raises the marker 40001 and asserts the
// retryable 409 — so `if (false && sendIfRecoveryAuthorityBusy(res, error))` at that
// one site turns exactly its leg red (the error would fall through to the surface's
// original *_FAILED 500 instead).
describe('admin-users remaining recovery-authority-busy writer sites', () => {
  function recoveryBusyError(): Error & { code: string } {
    const error = new Error('METASHEET_RECOVERY_AUTHORITY_BUSY') as Error & { code: string }
    error.code = '40001'
    return error
  }

  const USER_ROW = {
    id: 'user-1',
    email: 'alpha@example.com',
    name: 'Alpha',
    role: 'user',
    is_active: true,
    is_admin: false,
    last_login_at: null,
    created_at: '2026-03-12T00:00:00.000Z',
    updated_at: '2026-03-12T00:00:00.000Z',
  }

  function expectRetryable409(response: { statusCode: number; body: unknown }): void {
    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('RECOVERY_AUTHORITY_BUSY')
    expect((response.body as Record<string, any>).error.details).toEqual({ retryable: true })
  }

  it('[recovery-census:admin-users:member-group-action] member-group assign: busy lease on the membership write → retryable 409', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // fetchUserProfile
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] }) // group lookup
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1'))
      .mockResolvedValueOnce({ rows: [] }) // current actor RBAC roles
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('INSERT INTO platform_member_group_members')
        throw recoveryBusyError() // INSERT INTO platform_member_group_members
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { groupId: 'group-1' },
    })

    expectRetryable409(response)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    census.record('admin-users:member-group-action')
  })

  it('[recovery-census:admin-users:create-user] create user: busy lease on the users INSERT → retryable 409', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true) // ensurePlatformAdmin
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('INSERT INTO users (')) throw recoveryBusyError()
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
      },
    })

    expectRetryable409(response)
    census.record('admin-users:create-user')
  })

  it('create user: a non-40001 insert failure keeps the ORIGINAL USER_CREATE_FAILED 500 (control)', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query.mockImplementation(async (sql: string) => {
      const statement = String(sql)
      if (statement.includes('INSERT INTO users (')) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      }
      return { rows: [] }
    })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error.code).toBe('USER_CREATE_FAILED')
  })

  it('[recovery-census:admin-users:role-unassign] role unassign: busy lease on the user_roles DELETE → retryable 409', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // fetchUserProfile
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce(lockedUserResult('admin-1', 'admin'))
      .mockResolvedValueOnce(lockedUserResult('user-1'))
      .mockResolvedValueOnce({ rows: [] }) // current actor RBAC roles
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('DELETE FROM user_roles')
        throw recoveryBusyError() // DELETE FROM user_roles
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expectRetryable409(response)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    census.record('admin-users:role-unassign')
  })

  it('[recovery-census:admin-users:status] status update: busy lease inside the access-graph lock transaction → retryable 409', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    // The transaction mock runs its handler against pgMocks.query. Disabling takes the
    // platform-admin advisory lock first; a marker on that statement is still the
    // retryable 409 for this access-graph transaction.
    pgMocks.query.mockImplementationOnce(async () => {
      throw recoveryBusyError()
    })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/status', {
      params: { userId: 'user-1' },
      body: { isActive: false },
    })

    expectRetryable409(response)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    census.record('admin-users:status')
  })
})
})
