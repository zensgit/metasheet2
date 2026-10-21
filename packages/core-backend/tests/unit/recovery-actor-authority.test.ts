import type { Request } from 'express'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), sheet: vi.fn() }))
vi.mock('../../src/multitable/access', async (original) => ({
  ...(await original<typeof import('../../src/multitable/access')>()),
  resolveRequestAccess: mocks.request,
}))
vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetCapabilitiesForAccess: mocks.sheet,
}))

import { deriveCapabilities, type ResolvedRequestAccess } from '../../src/multitable/access'
import type { QueryFn } from '../../src/multitable/permission-service'
import {
  loadDatabaseFreshRecoveryAccess,
  resolveDatabaseRecoverySheetAuthority,
  resolveRecoverySheetAuthority,
} from '../../src/multitable/recovery-authorization-stability'

const denied = deriveCapabilities([], false)
const allowed = deriveCapabilities([], true)
const request = {} as Request
const actorId = 'recovery-actor'
const sheetId = 'recovery-sheet'
const activeUser = { role: 'user', permissions: [], is_active: true, rbac_admin: false }

function database(user: Record<string, unknown> | undefined = activeUser, permissions: string[] = []) {
  return vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async (sql) => {
    if (sql.includes('FROM users')) return { rows: user ? [user] : [] }
    if (sql.includes('effective_permissions')) return { rows: permissions.map((code) => ({ code })) }
    throw new Error('unexpected_recovery_authority_query')
  })
}

beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue({ userId: actorId, permissions: [], isAdminRole: false })
  mocks.sheet.mockReset().mockImplementation(async (_query, _sheetId, access: ResolvedRequestAccess) => ({
    access,
    capabilities: deriveCapabilities(access.permissions, access.isAdminRole),
    capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
  }))
})

describe('canonical database recovery actor authority', () => {
  test.each([
    ['missing', undefined],
    ['inactive', { ...activeUser, is_active: false }],
    ['disabled', { ...activeUser, role: 'disabled' }],
  ] as const)('%s actor cannot regain capabilities from sheet grants', async (_state, user) => {
    // Missing needs an explicit empty database result rather than database()'s active default.
    const query = user === undefined ? vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async () => ({ rows: [] })) : database(user)
    mocks.sheet.mockResolvedValue({ capabilities: allowed })
    const result = await resolveDatabaseRecoverySheetAuthority(query, sheetId, actorId)
    expect(result).toEqual({
      access: { userId: '', permissions: [], isAdminRole: false },
      capabilities: denied,
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(mocks.sheet).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test('blank actor has no database or request work', async () => {
    const query = database()
    expect((await resolveDatabaseRecoverySheetAuthority(query, sheetId, '  ')).capabilities).toEqual(denied)
    expect(query).not.toHaveBeenCalled()
    expect(mocks.sheet).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test('fresh global grants are deduplicated and the actor id normalized', async () => {
    const query = database({ ...activeUser, permissions: ['multitable:read'] }, ['multitable:read', 'multitable:write'])
    expect(await loadDatabaseFreshRecoveryAccess(query, ` ${actorId} `)).toEqual({
      userId: actorId, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false,
    })
    expect(query.mock.calls.every(([, params]) => params?.[0] === actorId)).toBe(true)
  })

  test('active actor with no global permissions still receives canonical explicit sheet grants', async () => {
    const query = database()
    const grant = {
      access: { userId: actorId, permissions: [], isAdminRole: false },
      capabilities: allowed,
      capabilityOrigin: { source: 'sheet-grant', hasSheetAssignments: true },
      sheetScope: { hasAssignments: true, canRead: true, canWrite: true, canWriteOwn: false, canAdmin: true },
    }
    mocks.sheet.mockResolvedValue(grant)
    expect(await resolveDatabaseRecoverySheetAuthority(query, sheetId, actorId)).toEqual(grant)
    expect(mocks.sheet).toHaveBeenCalledTimes(1)
    expect(mocks.sheet).toHaveBeenCalledWith(query, sheetId, grant.access)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test('database errors propagate without consulting grants', async () => {
    const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async () => { throw new Error('database_unavailable') })
    await expect(resolveDatabaseRecoverySheetAuthority(query, sheetId, actorId)).rejects.toThrow('database_unavailable')
    expect(mocks.sheet).not.toHaveBeenCalled()
  })
})

describe('request recovery ceiling remains distinct', () => {
  test('anonymous request does not query the database', async () => {
    mocks.request.mockResolvedValue({ userId: '', permissions: [], isAdminRole: false })
    const query = database()
    expect((await resolveRecoverySheetAuthority(request, query, sheetId)).capabilities).toEqual(denied)
    expect(query).not.toHaveBeenCalled()
    expect(mocks.sheet).not.toHaveBeenCalled()
  })

  test.each([false, 'disabled'] as const)('inactive database actor defeats stale admin request (%s)', async (state) => {
    const query = database({ ...activeUser, ...(state === false ? { is_active: false } : { role: state }) })
    mocks.request.mockResolvedValue({ userId: actorId, permissions: ['multitable:write'], isAdminRole: true })
    mocks.sheet.mockResolvedValue({ capabilities: allowed })
    const result = await resolveRecoverySheetAuthority(request, query, sheetId)
    expect(result.access).toEqual({ userId: actorId, permissions: [], isAdminRole: false })
    expect(result.capabilities).toEqual(denied)
    expect(mocks.sheet).not.toHaveBeenCalled()
  })

  test.each(Object.keys(allowed) as Array<keyof typeof allowed>)('intersects request ceiling for %s', async (capability) => {
    const query = database({ ...activeUser, rbac_admin: true })
    mocks.sheet.mockImplementation(async (_query, _sheetId, access: ResolvedRequestAccess) => ({
      access,
      capabilities: access.isAdminRole ? allowed : { ...allowed, [capability]: false },
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
    }))
    const result = await resolveRecoverySheetAuthority(request, query, sheetId)
    expect(result.capabilities).toEqual({ ...allowed, [capability]: false })
    expect(result.access.isAdminRole).toBe(false)
  })

  test('database revocation defeats stale request grants', async () => {
    mocks.request.mockResolvedValue({ userId: actorId, permissions: [], isAdminRole: true })
    const result = await resolveRecoverySheetAuthority(request, database(), sheetId)
    expect(result.capabilities).toEqual(denied)
    expect(result.access.isAdminRole).toBe(false)
  })
})
