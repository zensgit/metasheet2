/**
 * 备料「成员与权限」(ADR adr-stock-prep-project-sheets-20261008 §11.4–§11.6, slice S5b, register R-39)
 * — the host's narrow members port, against an in-memory world (no DB) with every dependency counted.
 *
 *   SM-01 THE SWITCH: off (unset / 'TRUE' / ' true' / '1'), every method is 404
 *         STOCK_PREP_MEMBERS_PAGE_DISABLED with ZERO dependency calls.
 *   SM-02 THE CALLER TIER: only a platform admin or the `stock-prep` delegated admin (role
 *         `stock-prep_admin` + effective admission). A `stock-prep:admin` code holder without the role,
 *         another namespace's delegated admin, and the role without admission are 403 on all four.
 *   SM-03 SCOPE REQUIRED: a delegated admin with no department / member-group scope FOR `stock-prep`
 *         is 403 ROLE_DELEGATION_SCOPE_REQUIRED on all four (another namespace's scope does not count).
 *   SM-04 INVARIANT 2: any code outside `stock-prep:*` is 400 before any IO — multitable / workflow /
 *         roles / integration / `*:*` each named; `stock-prep:*` and `stock-prep:admin` too.
 *   SM-05 INVARIANT 1 (codes): a code the grantor does not currently hold (ladder, read fresh) is 403.
 *   SM-06 INVARIANT 1 (tables): a sheet the grantor cannot read refuses the whole call; no grant runs.
 *   SM-07 THE ROLE-ID FENCE: outside namespace / `_admin` / built-in / not-custom, each its own code,
 *         before any IO; the generated id runs the same fence.
 *   SM-08..10 the writes: create / update / grant, their statements and results.
 *   SM-11 INVARIANT 3: each change writes exactly one audit row in the admin-users.ts delegation shape.
 *   SM-12 describe: built-ins (installed or not), custom roles, scope-filtered members, readable sheets.
 *   SM-13 the ladder is the plugin's, for every subset of the four codes.
 *   SM-14 the scope SQL keeps admin-users.ts's load-bearing clauses.
 *   SM-15 a recovery-authority conflict is the uniform retryable 409.
 *   SM-16 index.ts hands the port to plugin-integration-core only.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { RecoveryConflictError } from '../../src/db/recovery-conflict'
import {
  STOCK_PREP_BUILTIN_ROLE_IDS,
  STOCK_PREP_CUSTOM_ROLE_ID_PATTERN,
  STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV,
  STOCK_PREP_MEMBERS_PERMISSION_CODES,
  STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL,
  STOCK_PREP_MEMBERS_SCOPED_USERS_SQL,
  StockPrepMembersError,
  createStockPrepMembersPort,
  stockPrepCodeEffective,
  type StockPrepMembersDeps,
  type StockPrepMembersGrantTarget,
} from '../../src/services/stock-preparation-members'

const require = createRequire(import.meta.url)
const pluginAccess = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs') as {
  STOCK_PREP_PERMISSION_CODES: readonly string[]
  satisfiesStockPrepAccess: (permissions: string[], code: string) => boolean
}

const PLATFORM_ADMIN = 'u_platform'
const DELEGATED = 'u_delegated'
const DELEGATED_NO_SCOPE = 'u_delegated_noscope'
const DELEGATED_NO_ADMISSION = 'u_delegated_noadmission'
const CODE_HOLDER = 'u_code_holder'
const OTHER_NS_ADMIN = 'u_crm_admin'
const PLAIN = 'u_plain'
const MEMBER_IN = 'u_member_in'
const MEMBER_OUT = 'u_member_out'
const CUSTOM = 'stock-prep_c_0a1b2c3d'
const SHEET_A = 'sheet_proj_a'
const SHEET_B = 'sheet_proj_b'

interface World {
  platformAdmins: Set<string>
  userRoles: Array<{ user_id: string; role_id: string }>
  roles: Map<string, { id: string; name: string }>
  rolePermissions: Array<{ role_id: string; permission_code: string }>
  catalog: Set<string>
  admitted: Set<string>
  scopeConfigured: Map<string, Set<string>>
  scopedUsers: Map<string, Set<string>>
  users: Map<string, { name: string; email: string; username: string }>
  sheetGrants: Array<{ role_id: string; sheet_id: string }>
  readable: Map<string, Set<string> | 'all'>
  effective: Map<string, string[]>
  auditRows: Array<Record<string, unknown>>
  admissions: Map<string, boolean>
}

function baseWorld(): World {
  const roles = new Map<string, { id: string; name: string }>()
  for (const id of STOCK_PREP_BUILTIN_ROLE_IDS) roles.set(id, { id, name: id })
  roles.set(CUSTOM, { id: CUSTOM, name: '仓库只填两张表' })
  roles.set('stock-prep_viewer', { id: 'stock-prep_viewer', name: 'viewer' })
  roles.set('crm_admin', { id: 'crm_admin', name: 'crm' })
  roles.set('wb_role', { id: 'wb_role', name: 'wb' })
  return {
    platformAdmins: new Set([PLATFORM_ADMIN]),
    userRoles: [
      { user_id: DELEGATED, role_id: 'stock-prep_admin' },
      { user_id: DELEGATED_NO_SCOPE, role_id: 'stock-prep_admin' },
      { user_id: DELEGATED_NO_ADMISSION, role_id: 'stock-prep_admin' },
      { user_id: CODE_HOLDER, role_id: 'wb_role' },
      { user_id: OTHER_NS_ADMIN, role_id: 'crm_admin' },
      { user_id: MEMBER_IN, role_id: 'stock-prep_frontline' },
      { user_id: MEMBER_OUT, role_id: 'stock-prep_frontline' },
      { user_id: MEMBER_IN, role_id: CUSTOM },
    ],
    roles,
    rolePermissions: [
      { role_id: 'stock-prep_admin', permission_code: 'stock-prep:admin' },
      { role_id: 'stock-prep_puller', permission_code: 'stock-prep:read' },
      { role_id: 'stock-prep_puller', permission_code: 'stock-prep:operate' },
      { role_id: 'stock-prep_puller', permission_code: 'stock-prep:pull' },
      { role_id: 'stock-prep_frontline', permission_code: 'stock-prep:read' },
      { role_id: 'stock-prep_frontline', permission_code: 'stock-prep:operate' },
      { role_id: 'stock-prep_developer', permission_code: 'stock-prep:read' },
      { role_id: CUSTOM, permission_code: 'stock-prep:read' },
      { role_id: CUSTOM, permission_code: 'comments:read' },
      { role_id: 'wb_role', permission_code: 'stock-prep:admin' },
    ],
    catalog: new Set([...STOCK_PREP_MEMBERS_PERMISSION_CODES, 'comments:read']),
    admitted: new Set([DELEGATED, DELEGATED_NO_SCOPE, CODE_HOLDER]),
    scopeConfigured: new Map([
      [DELEGATED, new Set(['stock-prep'])],
      [DELEGATED_NO_SCOPE, new Set(['crm'])],
    ]),
    scopedUsers: new Map([[DELEGATED, new Set([MEMBER_IN])]]),
    users: new Map([
      [MEMBER_IN, { name: '甲', email: 'a@example.invalid', username: 'a' }],
      [MEMBER_OUT, { name: '乙', email: 'b@example.invalid', username: 'b' }],
    ]),
    sheetGrants: [{ role_id: CUSTOM, sheet_id: SHEET_A }, { role_id: CUSTOM, sheet_id: 'sheet_foreign' }],
    readable: new Map<string, Set<string> | 'all'>([
      [PLATFORM_ADMIN, 'all'],
      [DELEGATED, new Set([SHEET_A, SHEET_B])],
    ]),
    effective: new Map([
      [DELEGATED, ['stock-prep:admin']],
      [DELEGATED_NO_SCOPE, ['stock-prep:admin']],
      [CODE_HOLDER, ['stock-prep:admin']],
    ]),
    auditRows: [
      { id: 1, created_at: '2026-10-09T01:00:00.000Z', action: 'grant', resource_type: 'user-role', resource_id: `${MEMBER_IN}:stock-prep_frontline`, action_details: { adminUserId: DELEGATED, userId: MEMBER_IN, roleId: 'stock-prep_frontline', delegated: true } },
      { id: 2, created_at: '2026-10-09T00:30:00.000Z', action: 'grant', resource_type: 'user-role', resource_id: `${MEMBER_OUT}:stock-prep_frontline`, action_details: { adminUserId: PLATFORM_ADMIN, userId: MEMBER_OUT, roleId: 'stock-prep_frontline', delegated: false } },
      { id: 3, created_at: '2026-10-09T00:10:00.000Z', action: 'create', resource_type: 'role', resource_id: CUSTOM, action_details: JSON.stringify({ adminUserId: DELEGATED, roleId: CUSTOM, delegated: true }) },
    ],
    admissions: new Map([[MEMBER_IN, true]]),
  }
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

interface Harness {
  port: ReturnType<typeof createStockPrepMembersPort>
  world: World
  calls: Record<string, number>
  statements: string[]
  audits: Array<Record<string, unknown>>
  invalidated: string[]
  depCallCount: () => number
}

function harness(options: { env?: Record<string, string>; world?: World; randomSuffix?: () => string; transactionThrows?: unknown } = {}): Harness {
  const world = options.world ?? baseWorld()
  const calls: Record<string, number> = { query: 0, transaction: 0, isPlatformAdmin: 0, listEffectivePermissions: 0, hasEffectiveNamespaceAdmission: 0, resolveReadableSheetIds: 0, auditLog: 0, invalidateUserPerms: 0 }
  const statements: string[] = []
  const audits: Array<Record<string, unknown>> = []
  const invalidated: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    calls.query += 1
    const text = norm(sql)
    statements.push(text)
    if (text === norm(STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL)) {
      const set = world.scopeConfigured.get(params[0] as string)
      return { rows: [{ configured: Boolean(set && set.has(params[1] as string)) }] }
    }
    if (text === norm(STOCK_PREP_MEMBERS_SCOPED_USERS_SQL)) {
      const scoped = world.scopedUsers.get(params[0] as string) ?? new Set<string>()
      return { rows: (params[2] as string[]).filter((id) => scoped.has(id)).map((user_id) => ({ user_id })) }
    }
    if (text.startsWith('SELECT 1 AS held FROM user_roles')) {
      return { rows: world.userRoles.filter((row) => row.user_id === params[0] && row.role_id === params[1]).slice(0, 1).map(() => ({ held: 1 })) }
    }
    if (text.startsWith('SELECT code FROM permissions')) {
      return { rows: (params[0] as string[]).filter((code) => world.catalog.has(code)).map((code) => ({ code })) }
    }
    if (text.startsWith('INSERT INTO roles')) {
      const [id, name] = params as [string, string]
      if (world.roles.has(id)) return { rows: [] }
      world.roles.set(id, { id, name })
      return { rows: [{ id }] }
    }
    if (text.startsWith('INSERT INTO role_permissions')) {
      const [roleId, code] = params as [string, string]
      if (!world.rolePermissions.some((row) => row.role_id === roleId && row.permission_code === code)) {
        world.rolePermissions.push({ role_id: roleId, permission_code: code })
      }
      return { rows: [] }
    }
    if (text.startsWith('SELECT id, name FROM roles WHERE id = $1 FOR UPDATE')) {
      const role = world.roles.get(params[0] as string)
      return { rows: role ? [{ ...role }] : [] }
    }
    if (text.startsWith('SELECT permission_code FROM role_permissions')) {
      return { rows: world.rolePermissions.filter((row) => row.role_id === params[0]).map((row) => ({ permission_code: row.permission_code })) }
    }
    if (text.startsWith('DELETE FROM role_permissions')) {
      const [roleId, codes] = params as [string, string[]]
      world.rolePermissions = world.rolePermissions.filter((row) => !(row.role_id === roleId && codes.includes(row.permission_code)))
      return { rows: [] }
    }
    if (text.startsWith('UPDATE roles SET name')) {
      const [name, id] = params as [string, string]
      const role = world.roles.get(id)
      if (role) role.name = name
      return { rows: [] }
    }
    if (text.startsWith('SELECT user_id FROM user_roles WHERE role_id')) {
      return { rows: world.userRoles.filter((row) => row.role_id === params[0]).map((row) => ({ user_id: row.user_id })) }
    }
    if (text.startsWith('SELECT id FROM roles WHERE id = $1')) {
      return { rows: world.roles.has(params[0] as string) ? [{ id: params[0] }] : [] }
    }
    if (text.includes('FROM roles r')) {
      const rows = Array.from(world.roles.values())
        .filter((role) => role.id === 'stock-prep' || role.id.startsWith('stock-prep_'))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((role) => ({ ...role, permissions: world.rolePermissions.filter((row) => row.role_id === role.id).map((row) => row.permission_code) }))
      return { rows }
    }
    if (text.includes('FROM user_roles ur')) {
      const roleIds = params[1] as string[]
      return {
        rows: world.userRoles
          .filter((row) => roleIds.includes(row.role_id) && world.users.has(row.user_id))
          .map((row) => ({ role_id: row.role_id, user_id: row.user_id, ...world.users.get(row.user_id), admission_enabled: world.admissions.get(row.user_id) ?? null })),
      }
    }
    if (text.includes('FROM audit_logs')) {
      return { rows: world.auditRows.map((row) => ({ ...row })) }
    }
    if (text.includes('FROM spreadsheet_permissions')) {
      const roleIds = params[0] as string[]
      return { rows: world.sheetGrants.filter((row) => roleIds.includes(row.role_id)).map((row) => ({ ...row })) }
    }
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`)
  }
  const deps: StockPrepMembersDeps = {
    query,
    transaction: async (fn) => {
      calls.transaction += 1
      if (options.transactionThrows) throw options.transactionThrows
      const snapshot = { roles: new Map(Array.from(world.roles.entries()).map(([k, v]) => [k, { ...v }])), rolePermissions: world.rolePermissions.map((row) => ({ ...row })) }
      try {
        return await fn(query)
      } catch (error) {
        world.roles = snapshot.roles
        world.rolePermissions = snapshot.rolePermissions
        throw error
      }
    },
    isPlatformAdmin: async (userId) => { calls.isPlatformAdmin += 1; return world.platformAdmins.has(userId) },
    listEffectivePermissions: async (userId) => { calls.listEffectivePermissions += 1; return [...(world.effective.get(userId) ?? [])] },
    hasEffectiveNamespaceAdmission: async (userId, namespace) => { calls.hasEffectiveNamespaceAdmission += 1; return namespace === 'stock-prep' && world.admitted.has(userId) },
    resolveReadableSheetIds: async (userId, sheetIds) => {
      calls.resolveReadableSheetIds += 1
      const readable = world.readable.get(userId)
      if (readable === 'all') return new Set(sheetIds)
      return new Set(sheetIds.filter((id) => readable?.has(id)))
    },
    auditLog: async (entry) => { calls.auditLog += 1; audits.push(entry as unknown as Record<string, unknown>) },
    invalidateUserPerms: (userId) => { calls.invalidateUserPerms += 1; invalidated.push(userId) },
    env: () => options.env ?? { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'true' },
    ...(options.randomSuffix ? { randomSuffix: options.randomSuffix } : {}),
  }
  return {
    port: createStockPrepMembersPort(deps),
    world,
    calls,
    statements,
    audits,
    invalidated,
    depCallCount: () => Object.values(calls).reduce((sum, value) => sum + value, 0),
  }
}

async function refusal(promise: Promise<unknown>): Promise<StockPrepMembersError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(StockPrepMembersError)
    return error as StockPrepMembersError
  }
  throw new Error('expected a refusal, got a result')
}

function targets(sheetIds: string[], landed: string[] = []): { list: StockPrepMembersGrantTarget[]; granted: string[] } {
  const granted: string[] = []
  return {
    granted,
    list: sheetIds.map((sheetId) => ({
      sheetId,
      grant: async () => {
        granted.push(sheetId)
        return { granted: !landed.includes(sheetId) }
      },
    })),
  }
}

/** One call of every method, for the loops that must hold for all four. */
function everyMethod(h: Harness, actorId: string): Array<[string, () => Promise<unknown>]> {
  return [
    ['describe', () => h.port.describe({ actorId })],
    ['createCustomRole', () => h.port.createCustomRole({ actorId, name: '新角色', permissionCodes: ['stock-prep:read'] })],
    ['updateCustomRole', () => h.port.updateCustomRole({ actorId, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })],
    ['grantCustomRoleProjectSheets', () => h.port.grantCustomRoleProjectSheets({ actorId, roleId: CUSTOM, resolveTargets: async () => targets([SHEET_A]).list })],
  ]
}

describe('stock-prep members port (S5b, R-39)', () => {
  it('SM-01: switch off ⇒ every method is 404 STOCK_PREP_MEMBERS_PAGE_DISABLED with zero dependency calls', async () => {
    for (const env of [{}, { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'TRUE' }, { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: ' true' }, { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: '1' }, { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'false' }]) {
      const h = harness({ env })
      for (const [name, run] of everyMethod(h, PLATFORM_ADMIN)) {
        const error = await refusal(run())
        expect(error.status, `${name} @ ${JSON.stringify(env)}`).toBe(404)
        expect(error.code).toBe('STOCK_PREP_MEMBERS_PAGE_DISABLED')
      }
      expect(h.depCallCount(), `zero IO @ ${JSON.stringify(env)}`).toBe(0)
    }
  })

  it('SM-02: only the platform admin and the admitted stock-prep delegated admin pass the caller tier', async () => {
    const refused: Array<[string, number]> = [
      ['', 401],
      [PLAIN, 403],
      [CODE_HOLDER, 403], // holds stock-prep:admin through another role, not stock-prep_admin
      [OTHER_NS_ADMIN, 403], // another namespace's delegated admin
      [DELEGATED_NO_ADMISSION, 403], // the role without an effective admission
    ]
    for (const [actorId, status] of refused) {
      const h = harness()
      for (const [name, run] of everyMethod(h, actorId)) {
        const error = await refusal(run())
        expect(error.status, `${actorId || '(none)'} @ ${name}`).toBe(status)
        expect(error.code).toBe(status === 401 ? 'STOCK_PREP_MEMBERS_UNAUTHENTICATED' : 'STOCK_PREP_MEMBERS_FORBIDDEN')
      }
      expect(h.calls.transaction, `${actorId} wrote nothing`).toBe(0)
      expect(h.calls.auditLog).toBe(0)
      expect(h.calls.resolveReadableSheetIds).toBe(0)
    }
    for (const actorId of [PLATFORM_ADMIN, DELEGATED]) {
      const h = harness()
      for (const [name, run] of everyMethod(h, actorId)) {
        await expect(run(), `${actorId} @ ${name}`).resolves.toBeTruthy()
      }
    }
  })

  it('SM-03: a delegated admin without a stock-prep scope is 403 ROLE_DELEGATION_SCOPE_REQUIRED (another namespace scope does not count)', async () => {
    const h = harness()
    for (const [name, run] of everyMethod(h, DELEGATED_NO_SCOPE)) {
      const error = await refusal(run())
      expect(error.status, name).toBe(403)
      expect(error.code, name).toBe('ROLE_DELEGATION_SCOPE_REQUIRED')
    }
    expect(h.calls.transaction).toBe(0)
    expect(h.calls.auditLog).toBe(0)
    // The platform admin needs no scope.
    const admin = harness()
    admin.world.scopeConfigured.clear()
    await expect(admin.port.describe({ actorId: PLATFORM_ADMIN })).resolves.toBeTruthy()
  })

  it('SM-04: invariant 2 — any code outside stock-prep:* is 400 before any IO, on create and on update', async () => {
    const platformCodes = ['multitable:read', 'multitable:*', 'workflow:write', 'workflow:*', 'roles:write', 'roles:*', 'integration:admin', 'integration:*', '*:*', 'admin', 'stock-prep', 'spreadsheet:write']
    for (const code of platformCodes) {
      const h = harness()
      const create = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:read', code] }))
      expect([create.status, create.code], `create ${code}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN'])
      const update = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, permissionCodes: [code] }))
      expect([update.status, update.code], `update ${code}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN'])
      expect(h.depCallCount(), `${code}: zero IO`).toBe(0)
      expect(JSON.stringify(create.details)).not.toContain(code === 'stock-prep' ? '"stock-prep"' : code)
    }
    const h = harness()
    const wildcard = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:*'] }))
    expect([wildcard.status, wildcard.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODE_UNKNOWN'])
    const write = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:write'] }))
    expect([write.status, write.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODE_UNKNOWN'])
    const admin = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:admin'] }))
    expect([admin.status, admin.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODE_NOT_SELECTABLE'])
    const notArray = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: 'stock-prep:read' }))
    expect([notArray.status, notArray.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODES_INVALID'])
    expect(h.depCallCount()).toBe(0)
  })

  it('SM-05: invariant 1 (codes) — a custom role may not carry a code the grantor does not currently hold', async () => {
    const h = harness()
    // The delegated admin's role lost stock-prep:admin: their CURRENT effective codes are read only.
    h.world.effective.set(DELEGATED, ['stock-prep:read'])
    const error = await refusal(h.port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR'])
    const update = await refusal(h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:pull'] }))
    expect([update.status, update.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR'])
    expect(h.calls.transaction).toBe(0)
    // ...and exactly what they hold still goes through.
    await expect(h.port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['stock-prep:read'] })).resolves.toMatchObject({ permissionCodes: ['stock-prep:read'] })
    // The ladder: stock-prep:admin makes read / operate / pull effective; read is fresh per call.
    h.world.effective.set(DELEGATED, ['stock-prep:admin'])
    await expect(h.port.createCustomRole({ actorId: DELEGATED, name: 'y', permissionCodes: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] })).resolves.toBeTruthy()
    expect(h.calls.listEffectivePermissions).toBeGreaterThanOrEqual(4)
  })

  it('SM-06: invariant 1 (tables) — a sheet the grantor cannot read refuses the whole call; no grant runs', async () => {
    const h = harness()
    const t = targets([SHEET_A, 'sheet_unreadable'])
    const error = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }))
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_READABLE'])
    expect(error.details).toEqual({ unreadableCount: 1 })
    expect(t.granted).toEqual([])
    expect(h.audits).toEqual([])
    // Readable sheets go through, one grant each.
    const ok = targets([SHEET_A, SHEET_B])
    await expect(h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => ok.list })).resolves.toMatchObject({ roleId: CUSTOM })
    expect(ok.granted).toEqual([SHEET_A, SHEET_B])
  })

  it('SM-07: the role-id fence — namespace, _admin, built-in, custom shape — each refused with its own code before any IO', async () => {
    const cases: Array<[string, string]> = [
      ['crm_c_0a1b2c3d', 'STOCK_PREP_ROLE_OUTSIDE_NAMESPACE'],
      ['stock-prepx_c_0a1b2c3d', 'STOCK_PREP_ROLE_OUTSIDE_NAMESPACE'],
      ['admin', 'STOCK_PREP_ROLE_OUTSIDE_NAMESPACE'],
      ['', 'STOCK_PREP_ROLE_OUTSIDE_NAMESPACE'],
      ['stock-prep_admin', 'STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN'],
      ['stock-prep_data_admin', 'STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN'],
      ['stock-prep_c_0a1b_admin', 'STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN'],
      ['stock-prep_puller', 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY'],
      ['stock-prep_developer', 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY'],
      ['stock-prep_frontline', 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY'],
      ['stock-prep_viewer', 'STOCK_PREP_ROLE_NOT_CUSTOM'],
      ['stock-prep', 'STOCK_PREP_ROLE_NOT_CUSTOM'],
      ['stock-prep_c_0A1B2C3D', 'STOCK_PREP_ROLE_NOT_CUSTOM'],
      ['stock-prep_c_0a1b2c3d9', 'STOCK_PREP_ROLE_NOT_CUSTOM'],
    ]
    for (const [roleId, code] of cases) {
      const h = harness()
      const update = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId, name: 'renamed' }))
      expect([update.status, update.code], `update ${roleId || '(empty)'}`).toEqual([403, code])
      const t = targets([SHEET_A])
      const grant = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: PLATFORM_ADMIN, roleId, resolveTargets: async () => t.list }))
      expect([grant.status, grant.code], `grant ${roleId || '(empty)'}`).toEqual([403, code])
      expect(h.depCallCount(), `${roleId}: zero IO`).toBe(0)
      expect(t.granted).toEqual([])
    }
    // The GENERATED id runs the same fence: a generator that yields an `_admin`-ending id writes nothing.
    const bad = harness({ randomSuffix: () => '0a1b_admin' })
    const created = await refusal(bad.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:read'] }))
    expect([created.status, created.code]).toEqual([403, 'STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN'])
    expect(bad.calls.transaction).toBe(0)
    expect(Array.from(bad.world.roles.keys()).some((id) => id.endsWith('_admin') && id.startsWith('stock-prep_c_'))).toBe(false)
  })

  it('SM-08: create — a server-generated stock-prep_c_<8 hex> id, the codes, nothing else', async () => {
    const h = harness()
    const result = await h.port.createCustomRole({ actorId: DELEGATED, name: '  采购只读  ', permissionCodes: ['stock-prep:read', 'stock-prep:read', 'stock-prep:operate'] })
    expect(result.roleId).toMatch(STOCK_PREP_CUSTOM_ROLE_ID_PATTERN)
    expect(result).toMatchObject({ name: '采购只读', permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })
    const roleId = result.roleId as string
    expect(h.world.roles.get(roleId)).toEqual({ id: roleId, name: '采购只读' })
    expect(h.world.rolePermissions.filter((row) => row.role_id === roleId).map((row) => row.permission_code).sort()).toEqual(['stock-prep:operate', 'stock-prep:read'])
    expect(roleId.endsWith('_admin')).toBe(false)
    // A colliding id is retried, never overwritten.
    const suffixes = ['0a1b2c3d', 'ffffffff']
    const retry = harness({ randomSuffix: () => suffixes.shift() ?? 'eeeeeeee' })
    const second = await retry.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: [] })
    expect(second.roleId).toBe('stock-prep_c_ffffffff')
    expect(retry.world.roles.get(CUSTOM)?.name).toBe('仓库只填两张表')
    // A code missing from the catalog is a 400 and leaves no role behind.
    const noCatalog = harness()
    noCatalog.world.catalog.delete('stock-prep:pull')
    const refused = await refusal(noCatalog.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: 'x', permissionCodes: ['stock-prep:pull'] }))
    expect([refused.status, refused.code]).toEqual([400, 'UNKNOWN_PERMISSION_CODE'])
    expect(Array.from(noCatalog.world.roles.keys()).filter((id) => STOCK_PREP_CUSTOM_ROLE_ID_PATTERN.test(id))).toEqual([CUSTOM])
  })

  it('SM-09: update — only the role\'s stock-prep:* rows move; other rows are left; members re-read; 404 when absent', async () => {
    const h = harness()
    const result = await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '改名', permissionCodes: ['stock-prep:operate', 'stock-prep:read', 'stock-prep:pull'] })
    expect(result).toMatchObject({ roleId: CUSTOM, name: '改名', added: ['stock-prep:operate', 'stock-prep:pull'], removed: [] })
    expect(h.world.rolePermissions.filter((row) => row.role_id === CUSTOM).map((row) => row.permission_code).sort())
      .toEqual(['comments:read', 'stock-prep:operate', 'stock-prep:pull', 'stock-prep:read'])
    expect(h.invalidated).toEqual([MEMBER_IN])
    const narrowed = await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: [] })
    expect(narrowed).toMatchObject({ removed: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'], added: [] })
    // The foreign row stays: this port is never the writer of a non-stock-prep code.
    expect(h.world.rolePermissions.filter((row) => row.role_id === CUSTOM).map((row) => row.permission_code)).toEqual(['comments:read'])
    const missing = await refusal(h.port.updateCustomRole({ actorId: DELEGATED, roleId: 'stock-prep_c_99999999', name: 'x' }))
    expect([missing.status, missing.code]).toEqual([404, 'STOCK_PREP_CUSTOM_ROLE_NOT_FOUND'])
    const empty = await refusal(h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM }))
    expect([empty.status, empty.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_PATCH_EMPTY'])
  })

  it('SM-10: grant — one G1 call per sheet, in order; an absent role is 404 before any target is resolved', async () => {
    const h = harness()
    const t = targets([SHEET_A, SHEET_B], [SHEET_A])
    const result = await h.port.grantCustomRoleProjectSheets({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, resolveTargets: async () => t.list })
    expect(result).toEqual({ roleId: CUSTOM, sheets: [{ sheetId: SHEET_A, granted: false }, { sheetId: SHEET_B, granted: true }] })
    expect(t.granted).toEqual([SHEET_A, SHEET_B])
    let resolved = 0
    const missing = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: PLATFORM_ADMIN, roleId: 'stock-prep_c_99999999', resolveTargets: async () => { resolved += 1; return t.list } }))
    expect([missing.status, missing.code]).toEqual([404, 'STOCK_PREP_CUSTOM_ROLE_NOT_FOUND'])
    expect(resolved).toBe(0)
    for (const bad of [[], targets(Array.from({ length: 51 }, (_, i) => `sheet_${i}`)).list, [{ sheetId: 'bad sheet', grant: async () => ({ granted: true }) }], [...targets([SHEET_A]).list, ...targets([SHEET_A]).list]]) {
      const error = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, resolveTargets: async () => bad }))
      expect([error.status, error.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_SHEETS_INVALID'])
    }
  })

  it('SM-11: invariant 3 — create, update and every sheet grant each write ONE audit row in the delegation shape', async () => {
    const h = harness()
    const created = await h.port.createCustomRole({ actorId: DELEGATED, name: '甲组', permissionCodes: ['stock-prep:read'] })
    const roleId = created.roleId as string
    expect(h.audits).toEqual([{
      actorId: DELEGATED,
      actorType: 'user',
      action: 'create',
      resourceType: 'role',
      resourceId: roleId,
      meta: { adminUserId: DELEGATED, delegated: true, delegableNamespaces: ['stock-prep'], source: 'stock-prep-members', roleId, name: '甲组', permissions: ['stock-prep:read'] },
    }])
    await h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })
    expect(h.audits[1]).toEqual({
      actorId: PLATFORM_ADMIN,
      actorType: 'user',
      action: 'update',
      resourceType: 'role',
      resourceId: roleId,
      meta: { adminUserId: PLATFORM_ADMIN, delegated: false, delegableNamespaces: [], source: 'stock-prep-members', roleId, name: '甲组', permissions: ['stock-prep:read', 'stock-prep:operate'], permissionsAdded: ['stock-prep:operate'], permissionsRemoved: [] },
    })
    await h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => targets([SHEET_A, SHEET_B], [SHEET_B]).list })
    expect(h.audits.slice(2)).toEqual([SHEET_A, SHEET_B].map((sheetId) => ({
      actorId: DELEGATED,
      actorType: 'user',
      action: 'grant',
      resourceType: 'role',
      resourceId: roleId,
      meta: { adminUserId: DELEGATED, delegated: true, delegableNamespaces: ['stock-prep'], source: 'stock-prep-members', roleId, sheetId, permission: 'spreadsheet:write', granted: sheetId === SHEET_A },
    })))
    expect(h.audits).toHaveLength(4)
    // A refused change writes no audit row.
    await refusal(h.port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['workflow:write'] }))
    expect(h.audits).toHaveLength(4)
  })

  it('SM-12: describe — built-ins (installed or not), custom roles, scope-filtered members, readable sheets, audit', async () => {
    const h = harness()
    h.world.roles.delete('stock-prep_developer')
    const view = await h.port.describe({ actorId: DELEGATED }) as Record<string, any>
    expect(view.enabled).toBe(true)
    expect(view.actor).toEqual({ isPlatformAdmin: false, delegated: true, scopeConfigured: true })
    expect(view.grantableCodes).toEqual(['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'])
    expect(view.builtInRoles.map((role: any) => [role.id, role.installed, role.appointable, role.editable])).toEqual([
      ['stock-prep_admin', true, false, false],
      ['stock-prep_puller', true, true, false],
      ['stock-prep_developer', false, false, false],
      ['stock-prep_frontline', true, true, false],
    ])
    const frontline = view.builtInRoles.find((role: any) => role.id === 'stock-prep_frontline')
    expect(frontline.members.map((member: any) => member.userId)).toEqual([MEMBER_IN])
    expect(frontline.members[0]).toMatchObject({ admitted: true })
    expect(frontline.outOfScopeMemberCount).toBe(1)
    expect(JSON.stringify(view)).not.toContain(MEMBER_OUT)
    expect(view.customRoles).toHaveLength(1)
    expect(view.customRoles[0]).toMatchObject({ id: CUSTOM, editable: true, permissionCodes: ['stock-prep:read'], otherCodeCount: 1, sheetIds: [SHEET_A], otherSheetCount: 1 })
    expect(view.otherRoles.map((role: any) => [role.id, role.appointable, role.editable])).toEqual([['stock-prep_viewer', false, false]])
    expect(view.audit.available).toBe(true)
    expect(view.audit.entries.map((entry: any) => [entry.action, entry.resourceType, entry.userId, entry.roleId])).toEqual([
      ['grant', 'user-role', MEMBER_IN, 'stock-prep_frontline'],
      ['create', 'role', null, CUSTOM],
    ])
    // A platform admin sees every member and every entry.
    const admin = await harness().port.describe({ actorId: PLATFORM_ADMIN }) as Record<string, any>
    expect(admin.builtInRoles.find((role: any) => role.id === 'stock-prep_frontline').members.map((member: any) => member.userId).sort()).toEqual([MEMBER_IN, MEMBER_OUT].sort())
    expect(admin.audit.entries).toHaveLength(3)
    expect(admin.actor).toEqual({ isPlatformAdmin: true, delegated: false, scopeConfigured: true })
    // An unreadable audit table degrades that section only.
    const degraded = harness()
    degraded.world.auditRows = null as never
    const partial = await degraded.port.describe({ actorId: PLATFORM_ADMIN }) as Record<string, any>
    expect(partial.audit).toEqual({ available: false, entries: [] })
    expect(partial.builtInRoles).toHaveLength(4)
  })

  it('SM-13: the host ladder is the plugin ladder, for every subset of the four codes, with and without platform admin', () => {
    expect([...STOCK_PREP_MEMBERS_PERMISSION_CODES]).toEqual([...pluginAccess.STOCK_PREP_PERMISSION_CODES])
    const codes = [...STOCK_PREP_MEMBERS_PERMISSION_CODES]
    for (let mask = 0; mask < 1 << codes.length; mask += 1) {
      const held = codes.filter((_, index) => (mask & (1 << index)) !== 0)
      for (const platformAdmin of [false, true]) {
        for (const code of [...codes, 'stock-prep:*', 'multitable:read']) {
          expect(stockPrepCodeEffective(held, platformAdmin, code), `${held.join('+') || '(none)'} admin=${platformAdmin} @ ${code}`)
            .toBe(pluginAccess.satisfiesStockPrepAccess(platformAdmin ? [...held, 'role:admin'] : held, code))
        }
      }
    }
  })

  it('SM-14: the scope SQL keeps the delegation routes\' load-bearing clauses, for the stock-prep namespace only', () => {
    const scoped = norm(STOCK_PREP_MEMBERS_SCOPED_USERS_SQL)
    for (const clause of [
      "WHERE s.admin_user_id = $1 AND s.namespace = $2 AND d.is_active = true",
      'WHERE child.is_active = true',
      "WHERE gscope.admin_user_id = $1 AND gscope.namespace = $2",
      'AND a.is_active = true',
      "WHERE l.link_status = 'linked' AND l.local_user_id = ANY($3::text[])",
      'WHERE gm.user_id = ANY($3::text[])',
    ]) {
      expect(scoped).toContain(clause)
    }
    const configured = norm(STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL)
    expect(configured).toContain('JOIN directory_integrations i ON i.id = d.integration_id')
    expect(configured).toContain('JOIN platform_member_groups g ON g.id = gscope.group_id')
    expect(configured.match(/namespace = \$2/g)).toHaveLength(2)
  })

  it('SM-15: a recovery-authority conflict on a role write is the uniform retryable 409', async () => {
    const h = harness({ transactionThrows: new RecoveryConflictError(undefined) })
    const error = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, permissionCodes: ['stock-prep:read'] }))
    expect([error.status, error.code, error.details]).toEqual([409, 'RECOVERY_AUTHORITY_BUSY', { retryable: true }])
    expect(h.audits).toEqual([])
  })

  it('SM-16: index.ts hands the members port to plugin-integration-core only', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8').split('\r\n').join('\n')
    expect(source).toContain("stockPreparationMembers: manifest.name === 'plugin-integration-core'\n          ? createStockPrepMembersHostPort()\n          : undefined,")
    expect(source.match(/createStockPrepMembersHostPort\(\)/g)).toHaveLength(1)
  })
})
