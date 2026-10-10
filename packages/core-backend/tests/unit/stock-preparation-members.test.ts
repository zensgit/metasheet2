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
 *   SM-06 INVARIANT 1 (tables): a sheet the grantor cannot WRITE (read-only included) refuses the
 *         whole call; no grant runs.
 *   SM-07 THE ROLE-ID FENCE: outside namespace / `_admin` / built-in / not-custom, each its own code,
 *         before any IO; the generated id runs the same fence.
 *   SM-08..10 the writes: create / update / grant, their statements and results.
 *   SM-11 INVARIANT 3: each change writes exactly one audit row in the admin-users.ts delegation shape.
 *   SM-12 describe: built-ins (installed or not), custom roles, scope-filtered members, readable sheets.
 *   SM-13 the ladder is the plugin's, for every subset of the four codes.
 *   SM-14 the scope SQL keeps admin-users.ts's load-bearing clauses.
 *   SM-15 a recovery-authority conflict is the uniform retryable 409.
 *   SM-16 index.ts hands the port to plugin-integration-core only.
 *   SM-17 no cross-scope effect; SM-18 the 100 cap; SM-19 the delegation routes' audit pins.
 *   Fix round 1:
 *   SM-20 (S1) a role carrying a code outside the selectable list is LOCKED: not appointable, not
 *         editable, every port write 409 STOCK_PREP_CUSTOM_ROLE_HAS_PLATFORM_CODES (built-ins too).
 *   SM-21 (S4) a rename-only update writes its audit row; removing codes drops the members' memo.
 *   SM-22 (S5) every write takes its locks first, in order, and decides again under them: the caller,
 *         the grantor's codes, every member's scope, the cap; a lock wait past the bound is 409 BUSY.
 *   SM-23 (S6) more than 16 permissionCodes entries is 400 before any IO.
 *   SM-24 (S7) the audit section shows no unreadable sheet and no actor beyond the role views.
 *   SM-25 (S8) a custom role may not take a built-in's display name, however it is spelled.
 *   SM-26 (S4) the caller tier's role check is an exact equality on `stock-prep_admin`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { RecoveryConflictError } from '../../src/db/recovery-conflict'
import { censusFile } from './lib/recovery-census-recorder'
import {
  STOCK_PREP_BUILTIN_ROLE_IDS,
  STOCK_PREP_CUSTOM_ROLE_ID_PATTERN,
  STOCK_PREP_MEMBERS_ADVISORY_LOCK_KEY,
  STOCK_PREP_MEMBERS_ADVISORY_LOCK_SQL,
  STOCK_PREP_MEMBERS_CUSTOM_ROLE_STATE_SQL,
  STOCK_PREP_MEMBERS_DELEGATED_ADMIN_HELD_SQL,
  STOCK_PREP_MEMBERS_GRANTOR_LOCK_SQL,
  STOCK_PREP_MEMBERS_LOCK_TIMEOUT_SQL,
  STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV,
  STOCK_PREP_MEMBERS_PERMISSION_CODES,
  STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL,
  STOCK_PREP_MEMBERS_SCOPED_USERS_SQL,
  STOCK_PREP_MEMBERS_USER_ROLES_LOCK_SQL,
  StockPrepMembersError,
  createStockPrepMembersPort,
  stockPrepCodeEffective,
  type StockPrepMembersDeps,
  type StockPrepMembersGrantTarget,
} from '../../src/services/stock-preparation-members'

const require = createRequire(import.meta.url)
// O2 recovery-conflict census: SM-15 is this file's registered leg (tests/unit/lib/recovery-census-table.ts).
const census = censusFile('stock-preparation-members.test.ts')
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
/** A custom-shaped role someone put a platform code on through the platform role editor (S1). */
const LOCKED = 'stock-prep_c_0badc0de'
const SHEET_A = 'sheet_proj_a'
const SHEET_B = 'sheet_proj_b'
/** Readable by the delegated admin but not writable (a `spreadsheet:read` grant) — lens-A's S2 case. */
const SHEET_READ_ONLY = 'sheet_proj_read_only'

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
  writable: Map<string, Set<string> | 'all'>
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
      [DELEGATED, new Set([SHEET_A, SHEET_B, SHEET_READ_ONLY])],
    ]),
    writable: new Map<string, Set<string> | 'all'>([
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
  /** The statements run on the TRANSACTION's query, in order. */
  txStatements: string[]
  audits: Array<Record<string, unknown>>
  invalidated: string[]
  depCallCount: () => number
}

const LOCK_STATEMENTS = new Set([
  norm(STOCK_PREP_MEMBERS_LOCK_TIMEOUT_SQL),
  norm(STOCK_PREP_MEMBERS_ADVISORY_LOCK_SQL),
  norm(STOCK_PREP_MEMBERS_USER_ROLES_LOCK_SQL),
  ...STOCK_PREP_MEMBERS_GRANTOR_LOCK_SQL.map(norm),
])

interface HarnessOptions {
  env?: Record<string, string>
  world?: World
  randomSuffix?: () => string
  transactionThrows?: unknown
  /** Runs before a TRANSACTION statement is answered — the "someone else committed meanwhile" seam. */
  onTxStatement?: (text: string, world: World) => void
}

function harness(options: HarnessOptions = {}): Harness {
  const world = options.world ?? baseWorld()
  const calls: Record<string, number> = { query: 0, transaction: 0, isPlatformAdmin: 0, listEffectivePermissions: 0, hasEffectiveNamespaceAdmission: 0, resolveReadableSheetIds: 0, resolveWritableSheetIds: 0, auditLog: 0, invalidateUserPerms: 0 }
  const statements: string[] = []
  const txStatements: string[] = []
  const audits: Array<Record<string, unknown>> = []
  const invalidated: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    calls.query += 1
    const text = norm(sql)
    statements.push(text)
    if (LOCK_STATEMENTS.has(text)) return { rows: [] }
    if (text.startsWith(norm(STOCK_PREP_MEMBERS_CUSTOM_ROLE_STATE_SQL))) {
      const role = world.roles.get(params[0] as string)
      return { rows: role ? [{ ...role, permissions: world.rolePermissions.filter((row) => row.role_id === role.id).map((row) => row.permission_code).sort() }] : [] }
    }
    if (text === norm(STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL)) {
      const set = world.scopeConfigured.get(params[0] as string)
      return { rows: [{ configured: Boolean(set && set.has(params[1] as string)) }] }
    }
    if (text === norm(STOCK_PREP_MEMBERS_SCOPED_USERS_SQL)) {
      const scoped = world.scopedUsers.get(params[0] as string) ?? new Set<string>()
      return { rows: (params[2] as string[]).filter((id) => scoped.has(id)).map((user_id) => ({ user_id })) }
    }
    if (text === norm(STOCK_PREP_MEMBERS_DELEGATED_ADMIN_HELD_SQL)) {
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
    if (text.startsWith('SELECT COUNT(*)::int AS c FROM roles WHERE id LIKE $1')) {
      return { rows: [{ c: Array.from(world.roles.keys()).filter((id) => id.startsWith('stock-prep_c_')).length }] }
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
  const txQuery = async (sql: string, params: unknown[] = []) => {
    const text = norm(sql)
    txStatements.push(text)
    options.onTxStatement?.(text, world)
    return query(sql, params)
  }
  const sheetSet = (map: Map<string, Set<string> | 'all'>, userId: string, sheetIds: string[]) => {
    const allowed = map.get(userId)
    if (allowed === 'all') return new Set(sheetIds)
    return new Set(sheetIds.filter((id) => allowed?.has(id)))
  }
  const deps: StockPrepMembersDeps = {
    query,
    transaction: async (fn) => {
      calls.transaction += 1
      if (options.transactionThrows) throw options.transactionThrows
      const snapshot = { roles: new Map(Array.from(world.roles.entries()).map(([k, v]) => [k, { ...v }])), rolePermissions: world.rolePermissions.map((row) => ({ ...row })) }
      try {
        return await fn(txQuery)
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
      return sheetSet(world.readable, userId, sheetIds)
    },
    resolveWritableSheetIds: async (userId, sheetIds) => {
      calls.resolveWritableSheetIds += 1
      return sheetSet(world.writable, userId, sheetIds)
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
    txStatements,
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

  it('SM-06: invariant 1 (tables) — a sheet the grantor cannot WRITE refuses the whole call (read-only too); no grant runs', async () => {
    const h = harness()
    for (const sheet of ['sheet_unreadable', SHEET_READ_ONLY]) {
      const t = targets([SHEET_A, sheet])
      const error = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }))
      expect([error.status, error.code], sheet).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
      expect(error.details).toEqual({ notWritableCount: 1 })
      expect(t.granted).toEqual([])
    }
    // The decision is the WRITE resolver's; readability is not consulted for a grant.
    expect(h.calls.resolveReadableSheetIds).toBe(0)
    expect(h.calls.transaction).toBe(0)
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

  it('SM-09: update — the role\'s stock-prep:* rows move; members re-read on an add AND on a removal; 404 when absent', async () => {
    const h = harness()
    const result = await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '改名', permissionCodes: ['stock-prep:operate', 'stock-prep:read', 'stock-prep:pull'] })
    expect(result).toMatchObject({ roleId: CUSTOM, name: '改名', added: ['stock-prep:operate', 'stock-prep:pull'], removed: [] })
    expect(h.world.rolePermissions.filter((row) => row.role_id === CUSTOM).map((row) => row.permission_code).sort())
      .toEqual(['stock-prep:operate', 'stock-prep:pull', 'stock-prep:read'])
    expect(h.invalidated).toEqual([MEMBER_IN])
    const narrowed = await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: [] })
    expect(narrowed).toMatchObject({ removed: ['stock-prep:operate', 'stock-prep:pull', 'stock-prep:read'], added: [] })
    expect(h.world.rolePermissions.filter((row) => row.role_id === CUSTOM)).toEqual([])
    // S4: a removal-only change drops the members' memo too (a narrowed member must not keep the
    // removed code from the 60 s cache) …
    expect(h.invalidated).toEqual([MEMBER_IN, MEMBER_IN])
    // … and a rename alone changes nobody's codes, so it drops nothing.
    await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '再改名' })
    expect(h.invalidated).toEqual([MEMBER_IN, MEMBER_IN])
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
    expect(view.customRoles[0]).toMatchObject({ id: CUSTOM, editable: true, appointable: true, locked: false, foreignCodeCount: 0, permissionCodes: ['stock-prep:read'], otherCodeCount: 0, sheetIds: [SHEET_A], otherSheetCount: 1 })
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

  it('SM-15 [recovery-census:stock-prep-members:role-write]: a recovery-authority conflict on a role write is the uniform retryable 409', async () => {
    const h = harness({ transactionThrows: new RecoveryConflictError(undefined) })
    const error = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, permissionCodes: ['stock-prep:read'] }))
    expect([error.status, error.code, error.details]).toEqual([409, 'RECOVERY_AUTHORITY_BUSY', { retryable: true }])
    expect(h.audits).toEqual([])
    census.record('stock-prep-members:role-write')
  })

  it('SM-16: index.ts hands the members port to plugin-integration-core only', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8').split('\r\n').join('\n')
    expect(source).toContain("stockPreparationMembers: manifest.name === 'plugin-integration-core'\n          ? createStockPrepMembersHostPort()\n          : undefined,")
    expect(source.match(/createStockPrepMembersHostPort\(\)/g)).toHaveLength(1)
  })

  it('SM-17: a delegated admin may not change what a role grants while it has members outside their scope', async () => {
    const h = harness()
    h.world.userRoles.push({ user_id: MEMBER_OUT, role_id: CUSTOM })
    const update = await refusal(h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
    expect([update.status, update.code, update.details]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE', { outOfScopeCount: 1 }])
    const t = targets([SHEET_A])
    const grant = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }))
    expect([grant.status, grant.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE'])
    expect(t.granted).toEqual([])
    expect(h.calls.transaction).toBe(0)
    expect(h.audits).toEqual([])
    expect(h.world.rolePermissions.filter((row) => row.role_id === CUSTOM && row.permission_code === 'stock-prep:operate')).toEqual([])
    // A rename changes nobody's access and stays possible.
    await expect(h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '改名' })).resolves.toMatchObject({ name: '改名' })
    // The platform admin is unbounded here, exactly as on the delegation routes.
    await expect(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })).resolves.toMatchObject({ added: ['stock-prep:operate'] })
    // Members all in scope: the delegated admin may change it.
    const inScope = harness()
    await expect(inScope.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })).resolves.toBeTruthy()
  })

  it('SM-18: at most STOCK_PREP_CUSTOM_ROLE_MAX custom roles — the 101st is 409 before any write', async () => {
    const h = harness()
    for (let i = 1; i < 100; i += 1) {
      const id = `stock-prep_c_${i.toString(16).padStart(8, '0')}`
      h.world.roles.set(id, { id, name: id })
    }
    const error = await refusal(h.port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['stock-prep:read'] }))
    expect([error.status, error.code, error.details]).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_LIMIT', { limit: 100 }])
    expect(h.calls.transaction).toBe(0)
    expect(h.audits).toEqual([])
    // One fewer and the create goes through.
    h.world.roles.delete('stock-prep_c_00000001')
    await expect(h.port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['stock-prep:read'] })).resolves.toBeTruthy()
  })

  it('SM-19: appoint / revoke / admission stay on the delegation routes, which audit in the shape this port copies', () => {
    // Static pin of the EXISTING writers this page relies on (routes/admin-users.ts, not modified here):
    // removing either auditLog — or the delegated flag in its meta — reddens this line, not only the
    // admin-users suite.
    const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'admin-users.ts'), 'utf8').split('\r\n').join('\n')
    const handler = (route: string): string => {
      const start = source.indexOf(route)
      expect(start, route).toBeGreaterThan(0)
      const end = source.indexOf('\n  r.', start + route.length)
      return source.slice(start, end > 0 ? end : undefined)
    }
    const admission = handler("r.patch('/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission'")
    expect(admission).toMatch(/await auditLog\(\{\s*actorId: delegation\.actorId,\s*actorType: 'user',\s*action: enabled \? 'grant' : 'revoke',\s*resourceType: 'user-namespace-admission',/)
    expect(admission).toMatch(/delegated: !delegation\.isPlatformAdmin,\s*delegableNamespaces: delegation\.delegableNamespaces,/)
    const roles = handler("r.post('/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)'")
    expect(roles).toMatch(/await auditLog\(\{\s*actorId: delegation\.actorId,\s*actorType: 'user',\s*action: action === 'assign' \? 'grant' : 'revoke',\s*resourceType: 'user-role',/)
    expect(roles).toMatch(/delegated: !delegation\.isPlatformAdmin,\s*delegableNamespaces: delegation\.delegableNamespaces,/)
    // ...and both still refuse a delegated admin without a scope with the code this port reuses.
    for (const body of [admission, roles]) {
      expect(body).toContain("jsonError(res, 403, 'ROLE_DELEGATION_SCOPE_REQUIRED'")
    }
  })

  // ── fix round 1 ─────────────────────────────────────────────────────────────────────────────────

  it('SM-20 (S1): a role carrying a code outside the selectable list is locked — never appointable or editable, every port write 409', async () => {
    const ADMIN_CODED = 'stock-prep_c_0adc0de0'
    const lockedWorld = (): World => {
      const w = baseWorld()
      // Custom-shaped ids someone authored on the platform role editor (`roles:write`): one with a
      // platform code, one with the main-administrator code.
      w.roles.set(LOCKED, { id: LOCKED, name: '看似自定义' })
      w.rolePermissions.push({ role_id: LOCKED, permission_code: 'stock-prep:read' }, { role_id: LOCKED, permission_code: 'users:write' })
      w.userRoles.push({ user_id: MEMBER_IN, role_id: LOCKED })
      w.roles.set(ADMIN_CODED, { id: ADMIN_CODED, name: '第二主管' })
      w.rolePermissions.push({ role_id: ADMIN_CODED, permission_code: 'stock-prep:admin' })
      // A built-in widened on the platform editor is locked the same way.
      w.rolePermissions.push({ role_id: 'stock-prep_frontline', permission_code: 'multitable:write' })
      return w
    }
    for (const actorId of [DELEGATED, PLATFORM_ADMIN]) {
      const h = harness({ world: lockedWorld() })
      const view = await h.port.describe({ actorId }) as Record<string, any>
      const byId = (list: any[], id: string) => list.find((role: any) => role.id === id)
      expect(byId(view.customRoles, LOCKED), actorId).toMatchObject({ locked: true, foreignCodeCount: 1, otherCodeCount: 1, editable: false, appointable: false, permissionCodes: ['stock-prep:read'] })
      expect(byId(view.customRoles, ADMIN_CODED)).toMatchObject({ locked: true, foreignCodeCount: 1, otherCodeCount: 0, editable: false, appointable: false })
      expect(byId(view.customRoles, CUSTOM)).toMatchObject({ locked: false, editable: true, appointable: true })
      expect(byId(view.builtInRoles, 'stock-prep_frontline')).toMatchObject({ locked: true, appointable: false, editable: false })
      expect(byId(view.builtInRoles, 'stock-prep_puller')).toMatchObject({ locked: false, appointable: true })
      expect(byId(view.builtInRoles, 'stock-prep_admin')).toMatchObject({ locked: false, appointable: false })
      const writes: Array<[string, () => Promise<unknown>]> = [
        ['rename', () => h.port.updateCustomRole({ actorId, roleId: LOCKED, name: '改名' })],
        ['codes', () => h.port.updateCustomRole({ actorId, roleId: LOCKED, permissionCodes: ['stock-prep:read'] })],
        ['admin-coded rename', () => h.port.updateCustomRole({ actorId, roleId: ADMIN_CODED, name: '改名' })],
      ]
      for (const [what, run] of writes) {
        const error = await refusal(run())
        expect([error.status, error.code, error.details], `${actorId} ${what}`).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_HAS_PLATFORM_CODES', { foreignCodeCount: 1 }])
      }
      let resolved = 0
      const grant = await refusal(h.port.grantCustomRoleProjectSheets({ actorId, roleId: LOCKED, resolveTargets: async () => { resolved += 1; return targets([SHEET_A]).list } }))
      expect([grant.status, grant.code]).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_HAS_PLATFORM_CODES'])
      expect(resolved, 'refused before the registry is read').toBe(0)
      expect(h.world.roles.get(LOCKED)?.name).toBe('看似自定义')
      expect(h.world.rolePermissions.filter((row) => row.role_id === LOCKED).map((row) => row.permission_code).sort()).toEqual(['stock-prep:read', 'users:write'])
      expect(h.audits).toEqual([])
    }
  })

  it('SM-21 (S4): a rename-only update writes exactly one audit row', async () => {
    const h = harness()
    await h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '仅改名' })
    expect(h.audits).toEqual([{
      actorId: DELEGATED,
      actorType: 'user',
      action: 'update',
      resourceType: 'role',
      resourceId: CUSTOM,
      meta: { adminUserId: DELEGATED, delegated: true, delegableNamespaces: ['stock-prep'], source: 'stock-prep-members', roleId: CUSTOM, name: '仅改名' },
    }])
  })

  it('SM-22 (S5): every write takes its locks first, in order, then decides again under them', async () => {
    expect(STOCK_PREP_MEMBERS_LOCK_TIMEOUT_SQL).toBe("SELECT set_config('lock_timeout', $1, true)")
    expect(STOCK_PREP_MEMBERS_ADVISORY_LOCK_SQL).toBe('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))')
    expect([...STOCK_PREP_MEMBERS_ADVISORY_LOCK_KEY]).toEqual(['stock-prep', 'members-port'])
    expect(STOCK_PREP_MEMBERS_USER_ROLES_LOCK_SQL).toBe('LOCK TABLE user_roles IN SHARE MODE')
    for (const sql of STOCK_PREP_MEMBERS_GRANTOR_LOCK_SQL) expect(sql).toMatch(/ = \$1\)? FOR SHARE$/)
    const prefix = [STOCK_PREP_MEMBERS_LOCK_TIMEOUT_SQL, STOCK_PREP_MEMBERS_ADVISORY_LOCK_SQL, STOCK_PREP_MEMBERS_USER_ROLES_LOCK_SQL, ...STOCK_PREP_MEMBERS_GRANTOR_LOCK_SQL].map(norm)
    const writes: Array<[string, (h: Harness) => Promise<unknown>]> = [
      ['create', (h) => h.port.createCustomRole({ actorId: DELEGATED, name: '甲', permissionCodes: ['stock-prep:read'] })],
      ['update', (h) => h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })],
      ['rename', (h) => h.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, name: '乙' })],
      ['grant', (h) => h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => targets([SHEET_A]).list })],
    ]
    for (const [name, run] of writes) {
      const h = harness()
      await run(h)
      expect(h.txStatements.slice(0, prefix.length), `${name}: the locks open the transaction, in order`).toEqual(prefix)
      expect(h.calls.transaction, name).toBe(1)
    }

    // The window between the fast checks and the locks: someone else commits there. `at` = the
    // moment the transaction asks for the user_roles lock (the change committed just before it).
    const at = (change: (world: World) => void) => (text: string, world: World) => {
      if (text === norm(STOCK_PREP_MEMBERS_USER_ROLES_LOCK_SQL)) change(world)
    }
    // (a) the grantor's codes are decided again
    {
      const revoke = at((world) => { world.effective.set(DELEGATED, ['stock-prep:read']) })
      const c = harness({ onTxStatement: revoke })
      const created = await refusal(c.port.createCustomRole({ actorId: DELEGATED, name: '甲', permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
      expect([created.status, created.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR'])
      expect(Array.from(c.world.roles.keys()).filter((id) => STOCK_PREP_CUSTOM_ROLE_ID_PATTERN.test(id))).toEqual([CUSTOM])
      const u = harness({ onTxStatement: revoke })
      const updated = await refusal(u.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
      expect([updated.status, updated.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR'])
      expect(u.world.rolePermissions.filter((row) => row.role_id === CUSTOM).map((row) => row.permission_code)).toEqual(['stock-prep:read'])
      expect([...c.audits, ...u.audits]).toEqual([])
    }
    // (b) the caller is decided again: the main-administrator role revoked meanwhile
    {
      const drop = at((world) => { world.userRoles = world.userRoles.filter((row) => !(row.user_id === DELEGATED && row.role_id === 'stock-prep_admin')) })
      for (const [name, run] of writes) {
        const h = harness({ onTxStatement: drop })
        const t = targets([SHEET_A])
        const error = await refusal(name === 'grant' ? h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }) : run(h))
        expect([error.status, error.code], name).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
        expect(t.granted).toEqual([])
        expect(h.audits).toEqual([])
        expect(h.world.roles.get(CUSTOM)?.name, name).toBe('仓库只填两张表')
      }
    }
    // (c) every member's scope is decided again: an out-of-scope member appointed meanwhile
    {
      const appoint = at((world) => { if (!world.userRoles.some((row) => row.user_id === MEMBER_OUT && row.role_id === CUSTOM)) world.userRoles.push({ user_id: MEMBER_OUT, role_id: CUSTOM }) })
      const u = harness({ onTxStatement: appoint })
      const updated = await refusal(u.port.updateCustomRole({ actorId: DELEGATED, roleId: CUSTOM, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
      expect([updated.status, updated.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE'])
      expect(u.world.rolePermissions.filter((row) => row.role_id === CUSTOM).map((row) => row.permission_code)).toEqual(['stock-prep:read'])
      const g = harness({ onTxStatement: appoint })
      const t = targets([SHEET_A])
      const granted = await refusal(g.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }))
      expect([granted.status, granted.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE'])
      expect(t.granted).toEqual([])
      expect([...u.audits, ...g.audits]).toEqual([])
    }
    // (d) the cap is counted again: creates that landed meanwhile
    {
      const fill = at((world) => {
        for (let i = 1; i < 100; i += 1) {
          const id = `stock-prep_c_${i.toString(16).padStart(8, '0')}`
          world.roles.set(id, { id, name: id })
        }
      })
      const h = harness({ onTxStatement: fill, randomSuffix: () => 'feedface' })
      const error = await refusal(h.port.createCustomRole({ actorId: DELEGATED, name: '甲', permissionCodes: ['stock-prep:read'] }))
      expect([error.status, error.code]).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_LIMIT'])
      expect(h.world.roles.has('stock-prep_c_feedface')).toBe(false)
    }
    // (e) the sheets are decided again: the grantor's write on one of them revoked meanwhile
    {
      const h = harness({ onTxStatement: at((world) => { world.writable.set(DELEGATED, new Set([SHEET_B])) }) })
      const t = targets([SHEET_A])
      const error = await refusal(h.port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId: CUSTOM, resolveTargets: async () => t.list }))
      expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
      expect(t.granted).toEqual([])
    }
    // (f) a lock wait past the bound (or a deadlock the server broke) is a retryable 409; nothing written
    for (const code of ['55P03', '40P01']) {
      const h = harness({ transactionThrows: Object.assign(new Error('canceling statement due to lock timeout'), { code }) })
      const error = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, name: '丙' }))
      expect([error.status, error.code, error.details], code).toEqual([409, 'STOCK_PREP_MEMBERS_BUSY', { retryable: true }])
      expect(error.message).not.toContain('canceling')
      expect(h.audits).toEqual([])
    }
  })

  it('SM-23 (S6): more than 16 permissionCodes entries is 400 before any IO (duplicates count)', async () => {
    const h = harness()
    for (const codes of [Array(17).fill('stock-prep:read'), Array(100_000).fill('stock-prep:read'), Array.from({ length: 17 }, (_, i) => `x:${i}`)]) {
      const create = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: '甲', permissionCodes: codes }))
      expect([create.status, create.code, create.details], `create ×${codes.length}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODES_INVALID', { field: 'permissionCodes', max: 16 }])
      const update = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, permissionCodes: codes }))
      expect([update.status, update.code], `update ×${codes.length}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_CODES_INVALID'])
    }
    expect(h.depCallCount(), 'zero IO').toBe(0)
    // Sixteen (duplicates included) is still a request, de-duplicated.
    await expect(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name: '甲', permissionCodes: Array(16).fill('stock-prep:read') })).resolves.toMatchObject({ permissionCodes: ['stock-prep:read'] })
  })

  it('SM-24 (S7): the audit section shows no unreadable sheet and no actor beyond what the role views show', async () => {
    const world = baseWorld()
    world.auditRows.push(
      { id: 4, created_at: '2026-10-09T02:00:00.000Z', action: 'grant', resource_type: 'role', resource_id: CUSTOM, action_details: { adminUserId: PLATFORM_ADMIN, roleId: CUSTOM, sheetId: 'sheet_foreign', delegated: false } },
      { id: 5, created_at: '2026-10-09T02:01:00.000Z', action: 'grant', resource_type: 'role', resource_id: CUSTOM, action_details: { adminUserId: DELEGATED, roleId: CUSTOM, sheetId: SHEET_A, delegated: true } },
      { id: 6, created_at: '2026-10-09T02:02:00.000Z', action: 'grant', resource_type: 'user-role', resource_id: `${MEMBER_IN}:${CUSTOM}`, action_details: { adminUserId: 'u_other_admin', userId: MEMBER_IN, roleId: CUSTOM } },
      { id: 7, created_at: '2026-10-09T02:03:00.000Z', action: 'update', resource_type: 'role', resource_id: CUSTOM, action_details: { adminUserId: MEMBER_IN, roleId: CUSTOM } },
    )
    const view = await harness({ world }).port.describe({ actorId: DELEGATED }) as Record<string, any>
    const entries = view.audit.entries as Array<Record<string, unknown>>
    const pick = (id: number) => entries.find((entry) => entry.at === `2026-10-09T02:0${id - 4}:00.000Z`)
    expect(pick(4)).toMatchObject({ action: 'grant', roleId: CUSTOM, sheetId: null, actorId: null })
    expect(pick(5)).toMatchObject({ sheetId: SHEET_A, actorId: DELEGATED })
    expect(pick(6)).toMatchObject({ userId: MEMBER_IN, actorId: null })
    expect(pick(7)).toMatchObject({ actorId: MEMBER_IN }) // a member the role views already show
    const text = JSON.stringify(view.audit)
    for (const hidden of ['sheet_foreign', PLATFORM_ADMIN, 'u_other_admin', MEMBER_OUT]) expect(text, hidden).not.toContain(hidden)
    // The platform administrator sees every actor and every sheet.
    const admin = await harness({ world: (() => { const w = baseWorld(); w.auditRows.push(world.auditRows[3]); return w })() }).port.describe({ actorId: PLATFORM_ADMIN }) as Record<string, any>
    expect(admin.audit.entries.find((entry: any) => entry.sheetId === 'sheet_foreign')).toMatchObject({ actorId: PLATFORM_ADMIN })
  })

  it('SM-25 (S8): a custom role may not take a built-in display name, however it is spelled', async () => {
    const reserved = [
      '备料主管理员', ' 备料主管理员 ', '数据管理员（拉取人员）', '数据管理员(拉取人员)', '数据管理员 （ 拉取人员 ）',
      '开发成员（内置）', '开发成员(内置)', '开发成员 【内置】', '一线填写「内置」', '一线​填写',
      'ＤＥＶＥＬＯＰＥＲ', 'developer', 'Floor  Operator', 'Main administrator (built-in)', 'Data Manager (Puller)',
      'stock-prep_admin', 'Stock-Prep_Frontline', '（内置）', '​',
    ]
    const h = harness()
    for (const name of reserved) {
      const create = await refusal(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name, permissionCodes: [] }))
      expect([create.status, create.code], `create ${JSON.stringify(name)}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_NAME_RESERVED'])
      const rename = await refusal(h.port.updateCustomRole({ actorId: PLATFORM_ADMIN, roleId: CUSTOM, name }))
      expect([rename.status, rename.code], `rename ${JSON.stringify(name)}`).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_NAME_RESERVED'])
    }
    expect(h.depCallCount(), 'zero IO').toBe(0)
    for (const name of ['开发成员甲', '一线填写组', '备料主管理员助理', 'Developers']) {
      await expect(h.port.createCustomRole({ actorId: PLATFORM_ADMIN, name, permissionCodes: [] }), name).resolves.toMatchObject({ name })
    }
  })

  it('SM-26 (S4): the caller tier asks for exactly the role stock-prep_admin, by equality', async () => {
    expect(STOCK_PREP_MEMBERS_DELEGATED_ADMIN_HELD_SQL).toBe('SELECT 1 AS held FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1')
    const world = baseWorld()
    // Another delegated-admin role inside the namespace (a derived namespace's admin), admitted and scoped.
    world.userRoles.push({ user_id: 'u_sub_admin', role_id: 'stock-prep_x_admin' })
    world.admitted.add('u_sub_admin')
    world.scopeConfigured.set('u_sub_admin', new Set(['stock-prep']))
    world.effective.set('u_sub_admin', ['stock-prep:admin'])
    const h = harness({ world })
    const error = await refusal(h.port.describe({ actorId: 'u_sub_admin' }))
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
  })
})
