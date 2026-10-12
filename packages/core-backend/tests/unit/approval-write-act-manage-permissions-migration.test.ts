/**
 * `zzzz20261010120000_add_approval_write_act_template_manage_permissions` — the migration that registers
 * `approvals:write`, `approvals:act` and `approval-templates:manage` in the `permissions` catalogue.
 *
 * Sibling of `zzzz20260920130000_add_approval_product_permissions` (`approvals:read`) and held to the same
 * contract: CATALOGUE ROWS ONLY — idempotent, and ZERO grants. The real-DB acceptance for the product
 * round trip (grant endpoint, role endpoint, gates) is `tests/integration/approval-permission-catalogue-
 * grant.db.test.ts`; this file needs no database.
 *
 * HOW IT RUNS THE MIGRATION. The real `up()` / `down()` execute against a Kysely instance whose driver is
 * a small CLOSED-WORLD fake of the RBAC tables: it recognises exactly the statement shapes this migration
 * is allowed to emit (the `information_schema` existence probe, `INSERT INTO permissions (code, name,
 * description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, and the two statements of `down()`:
 * the single guarded `DELETE FROM permissions p WHERE p.code IN (...) AND NOT EXISTS (role_permissions
 * ...) AND NOT EXISTS (user_permissions ...)` and the `SELECT code FROM permissions WHERE code IN (...)`
 * read-back of the kept codes) and THROWS on anything else. So a later edit that adds a
 * `role_permissions` insert, an `ON CONFLICT DO UPDATE`, ANY `role_permissions` / `user_permissions`
 * write (including the old cascading `down()` deletes) or any other statement fails here instead of
 * passing a text-only assertion. Either NOT EXISTS clause may be absent (the migration omits it when its
 * table does not exist); the fake applies exactly the clauses it sees, and a `permissions` row it does
 * delete takes its grant rows with it, as the real `ON DELETE CASCADE` foreign keys would, so dropping a
 * guard shows up as lost grants, not just as different SQL text.
 *
 * This is a fake of the migration's own statement shapes, not a PostgreSQL: that the SQL is valid and
 * behaves the same on a real catalogue is shown by the live run recorded with the change and by the
 * real-DB suite above.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely'
import * as migration from '../../src/db/migrations/zzzz20261010120000_add_approval_write_act_template_manage_permissions'
import * as approvalsReadMigration from '../../src/db/migrations/zzzz20260920130000_add_approval_product_permissions'

const NEW_CODES = ['approvals:write', 'approvals:act', 'approval-templates:manage'] as const

/** `name` is pinned: it is what the admin UI lists next to the code. */
const EXPECTED_NAMES: Record<(typeof NEW_CODES)[number], string> = {
  'approvals:write': 'Approvals Write',
  'approvals:act': 'Approvals Act',
  'approval-templates:manage': 'Approval Templates Manage',
}

/** Codes other migrations already own; this migration must neither re-register nor disturb them. */
const OTHER_APPROVAL_CODES = [
  'approvals:read',
  'approvals:admin',
  'approvals:admin-templates',
  'approvals:admin-data',
  'approvals:analytics',
] as const

interface PermissionRow {
  name: string | null
  description: string | null
}
interface FakeState {
  tables: Set<string>
  permissions: Map<string, PermissionRow>
  rolePermissions: Array<{ roleId: string; code: string }>
  userPermissions: Array<{ userId: string; code: string }>
  /** Normalised SQL of every statement, probes included, in execution order. */
  statements: string[]
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    tables: new Set(['permissions', 'role_permissions', 'user_permissions']),
    permissions: new Map(),
    rolePermissions: [],
    userPermissions: [],
    statements: [],
    ...overrides,
  }
}

/** A catalogue that looks like a deployed one: other approval codes and unrelated codes, plus grants. */
function deployedState(): FakeState {
  const state = freshState()
  for (const code of OTHER_APPROVAL_CODES) {
    state.permissions.set(code, { name: `name of ${code}`, description: `description of ${code}` })
  }
  state.permissions.set('tasks:read', { name: 'Tasks Read', description: 'Read tasks in the caller org' })
  state.permissions.set('multitable:read', { name: 'Multitable Read', description: null })
  state.rolePermissions.push(
    { roleId: 'admin', code: 'approvals:admin' },
    { roleId: 'role-a', code: 'approvals:read' },
    { roleId: 'role-a', code: 'tasks:read' },
  )
  state.userPermissions.push(
    { userId: 'user-a', code: 'approvals:read' },
    { userId: 'user-b', code: 'multitable:read' },
  )
  return state
}

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim()

const INSERT_PERMISSION =
  /^INSERT INTO permissions \(code, name, description\) VALUES \(\$1, \$2, \$3\) ON CONFLICT \(code\) DO NOTHING$/
const ROLE_UNBOUND = 'AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_code = p.code)'
const USER_UNBOUND = 'AND NOT EXISTS (SELECT 1 FROM user_permissions upm WHERE upm.permission_code = p.code)'
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** down(): the ONE catalogue delete; each grant-table guard is optional (emitted only when that table exists). */
const DELETE_UNBOUND = new RegExp(
  String.raw`^DELETE FROM permissions p WHERE p\.code IN \((\$\d+(?:, \$\d+)*)\)` +
    `( ${escapeRegExp(ROLE_UNBOUND)})?( ${escapeRegExp(USER_UNBOUND)})?$`,
)
/** down(): read-back of the codes still in the catalogue (the kept, still-bound ones). */
const SELECT_CATALOGUE = /^SELECT code FROM permissions WHERE code IN \((\$\d+(?:, \$\d+)*)\)$/

const codesOf = (placeholders: string, parameters: readonly unknown[]): string[] =>
  placeholders.split(', ').map((placeholder) => String(parameters[Number(placeholder.slice(1)) - 1]))

function createFakeRbacDb(state: FakeState): Kysely<unknown> {
  const requireTable = (table: string): void => {
    if (!state.tables.has(table)) throw new Error(`relation "${table}" does not exist`)
  }
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = normalise(compiled.sql)
      state.statements.push(text)

      if (/\binformation_schema\.tables\b/i.test(text)) {
        const table = String(compiled.parameters[0])
        return { rows: [{ count: state.tables.has(table) ? 1 : 0 }] as unknown as R[] }
      }

      if (INSERT_PERMISSION.test(text)) {
        requireTable('permissions')
        const [code, name, description] = compiled.parameters as [string, string, string]
        if (!state.permissions.has(code)) state.permissions.set(code, { name, description })
        return { rows: [] }
      }

      const del = text.match(DELETE_UNBOUND)
      if (del) {
        const [, placeholders, roleGuard, userGuard] = del
        requireTable('permissions')
        if (roleGuard) requireTable('role_permissions')
        if (userGuard) requireTable('user_permissions')
        for (const code of codesOf(placeholders, compiled.parameters)) {
          if (!state.permissions.has(code)) continue
          if (roleGuard && state.rolePermissions.some((row) => row.code === code)) continue
          if (userGuard && state.userPermissions.some((row) => row.code === code)) continue
          state.permissions.delete(code)
          // The real role_permissions / user_permissions foreign keys are ON DELETE CASCADE.
          state.rolePermissions = state.rolePermissions.filter((row) => row.code !== code)
          state.userPermissions = state.userPermissions.filter((row) => row.code !== code)
        }
        return { rows: [] }
      }

      const select = text.match(SELECT_CATALOGUE)
      if (select) {
        requireTable('permissions')
        const rows = codesOf(select[1], compiled.parameters)
          .filter((code) => state.permissions.has(code))
          .map((code) => ({ code }))
        return { rows: rows as unknown as R[] }
      }

      throw new Error(`UNEXPECTED_STATEMENT: ${text}`)
    },
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streamQuery is not used by migrations')
    },
  }
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
}

const snapshot = (state: FakeState) => ({
  permissions: [...state.permissions.entries()].sort(([a], [b]) => a.localeCompare(b)),
  rolePermissions: [...state.rolePermissions],
  userPermissions: [...state.userPermissions],
})

/** Statements that are not the `information_schema` existence probe. */
const writesOf = (state: FakeState): string[] => state.statements.filter((text) => !/information_schema/i.test(text))

describe('approval write/act/manage permission catalogue migration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** down() warns once per kept code; capture it (and keep the test output quiet). */
  const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  it('exports a reversible up/down pair (each takes the db handle)', () => {
    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('registers exactly the three codes on a catalogue that lacks them, with pinned names', async () => {
    const state = deployedState()
    const before = new Set(state.permissions.keys())
    for (const code of NEW_CODES) expect(before.has(code)).toBe(false)

    await migration.up(createFakeRbacDb(state))

    const added = [...state.permissions.keys()].filter((code) => !before.has(code))
    expect([...added].sort()).toEqual([...NEW_CODES].sort())
    expect(state.permissions.size).toBe(before.size + NEW_CODES.length)
    for (const code of NEW_CODES) {
      const row = state.permissions.get(code)
      expect(row?.name).toBe(EXPECTED_NAMES[code])
      expect(typeof row?.description).toBe('string')
      expect((row?.description ?? '').trim()).toBe(row?.description)
      expect((row?.description ?? '').length).toBeGreaterThan(20)
    }
    // One bound INSERT per code, nothing else besides the existence probe.
    expect(writesOf(state)).toHaveLength(NEW_CODES.length)
    for (const text of writesOf(state)) expect(text).toMatch(INSERT_PERMISSION)
  })

  it('is a no-op on re-run: a second up() leaves the catalogue byte-identical', async () => {
    const state = deployedState()
    const db = createFakeRbacDb(state)
    await migration.up(db)
    const afterFirst = snapshot(state)

    await migration.up(db)
    await migration.up(db)

    expect(snapshot(state)).toEqual(afterFirst)
  })

  it('keeps a pre-existing row exactly as it is (ON CONFLICT DO NOTHING) and still registers the others', async () => {
    const state = deployedState()
    // e.g. a code a plugin's role matrix already self-registered at runtime.
    state.permissions.set('approvals:write', { name: 'Name set earlier', description: 'Provisioned by some-plugin: approvals:write' })

    await migration.up(createFakeRbacDb(state))

    expect(state.permissions.get('approvals:write')).toEqual({
      name: 'Name set earlier',
      description: 'Provisioned by some-plugin: approvals:write',
    })
    expect(state.permissions.get('approvals:act')?.name).toBe(EXPECTED_NAMES['approvals:act'])
    expect(state.permissions.get('approval-templates:manage')?.name).toBe(EXPECTED_NAMES['approval-templates:manage'])
    // Never an UPDATE / upsert: every statement it ran is the DO NOTHING insert (or the probe).
    expect(writesOf(state).every((text) => INSERT_PERMISSION.test(text))).toBe(true)
  })

  it('grants NOTHING: up() writes only to permissions and leaves every role/user grant untouched', async () => {
    const state = deployedState()
    const grantsBefore = { role: [...state.rolePermissions], user: [...state.userPermissions] }

    await migration.up(createFakeRbacDb(state))

    expect(state.rolePermissions).toEqual(grantsBefore.role)
    expect(state.userPermissions).toEqual(grantsBefore.user)
    for (const code of NEW_CODES) {
      expect(state.rolePermissions.some((row) => row.code === code)).toBe(false)
      expect(state.userPermissions.some((row) => row.code === code)).toBe(false)
    }
    // The statement log never even names a grant/role table or a preset.
    for (const text of state.statements) {
      expect(text).not.toMatch(/role_permissions|user_permissions|\broles\b|user_roles|preset/i)
    }
  })

  it('leaves the codes other migrations own exactly as they were, and shares no code with the approvals:read migration', async () => {
    const state = deployedState()
    const ownedBefore = OTHER_APPROVAL_CODES.map((code) => [code, state.permissions.get(code)])

    await migration.up(createFakeRbacDb(state))

    expect(OTHER_APPROVAL_CODES.map((code) => [code, state.permissions.get(code)])).toEqual(ownedBefore)

    const readOnly = freshState()
    await approvalsReadMigration.up(createFakeRbacDb(readOnly))
    const registeredByReadMigration = [...readOnly.permissions.keys()]
    expect(registeredByReadMigration).toEqual(['approvals:read'])
    expect(NEW_CODES.filter((code) => registeredByReadMigration.includes(code))).toEqual([])
  })

  it('writes nothing when the permissions table does not exist (existence guard)', async () => {
    const state = freshState({ tables: new Set() })

    await migration.up(createFakeRbacDb(state))

    expect(writesOf(state)).toEqual([])
    expect(state.permissions.size).toBe(0)
  })

  it('down() issues NO statement against role_permissions or user_permissions and leaves every grant row as it was', async () => {
    const state = deployedState()
    const db = createFakeRbacDb(state)
    await migration.up(db)
    // Grants an administrator (or a plugin) could have written for the new codes in the meantime.
    state.rolePermissions.push({ roleId: 'role-b', code: 'approvals:write' }, { roleId: 'role-b', code: 'approvals:act' })
    state.userPermissions.push({ userId: 'user-c', code: 'approval-templates:manage' })
    const grantsBefore = { role: [...state.rolePermissions], user: [...state.userPermissions] }
    state.statements.length = 0
    silenceWarn()

    await migration.down(db)

    expect(state.rolePermissions).toEqual(grantsBefore.role)
    expect(state.userPermissions).toEqual(grantsBefore.user)
    for (const text of state.statements) {
      expect(text).not.toMatch(/^(DELETE FROM|INSERT INTO|UPDATE|TRUNCATE) (role_permissions|user_permissions)\b/i)
    }
    // Exactly one guarded catalogue DELETE (both guards present: both tables exist) and one read-back.
    expect(writesOf(state)).toHaveLength(2)
    expect(writesOf(state)[0]).toMatch(DELETE_UNBOUND)
    expect(writesOf(state)[0]).toContain(ROLE_UNBOUND)
    expect(writesOf(state)[0]).toContain(USER_UNBOUND)
    expect(writesOf(state)[1]).toMatch(SELECT_CATALOGUE)
    // Every code is bound here, so the catalogue keeps all three.
    for (const code of NEW_CODES) expect(state.permissions.has(code)).toBe(true)
  })

  it.each([
    ['a role binding', (state: FakeState) => state.rolePermissions.push({ roleId: 'role-live', code: 'approvals:write' })],
    ['a user binding', (state: FakeState) => state.userPermissions.push({ userId: 'user-live', code: 'approvals:write' })],
  ] as const)(
    'down() deletes only the UNBOUND codes: approvals:write held through %s keeps its catalogue row (text untouched) and its grant; the two unbound codes go',
    async (_label, bind) => {
      const state = deployedState()
      // The deployed shape that motivated the narrowing: the row existed (and was bound) before up() ran.
      state.permissions.set('approvals:write', { name: 'Name set earlier', description: 'Registered by hand before this migration' })
      bind(state)
      const db = createFakeRbacDb(state)
      await migration.up(db)
      const grantsBefore = { role: [...state.rolePermissions], user: [...state.userPermissions] }
      const isNew = (code: string): boolean => (NEW_CODES as readonly string[]).includes(code)
      const othersBefore = [...state.permissions.entries()].filter(([code]) => !isNew(code))
      const warn = silenceWarn()

      await migration.down(db)

      expect(state.permissions.get('approvals:write')).toEqual({
        name: 'Name set earlier',
        description: 'Registered by hand before this migration',
      })
      expect(state.permissions.has('approvals:act')).toBe(false)
      expect(state.permissions.has('approval-templates:manage')).toBe(false)
      expect(state.rolePermissions).toEqual(grantsBefore.role)
      expect(state.userPermissions).toEqual(grantsBefore.user)
      // Nothing outside the three codes moves.
      expect([...state.permissions.entries()].filter(([code]) => !isNew(code))).toEqual(othersBefore)
      // One warn line per kept code, naming it.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('approvals:write')
    },
  )

  it('down() removes all three codes when none is bound, without a warning, and touches nothing else', async () => {
    const state = deployedState()
    const db = createFakeRbacDb(state)
    await migration.up(db)
    const before = snapshot(state)
    const warn = silenceWarn()

    await migration.down(db)

    for (const code of NEW_CODES) expect(state.permissions.has(code)).toBe(false)
    expect(snapshot(state)).toEqual({
      ...before,
      permissions: before.permissions.filter(([code]) => !(NEW_CODES as readonly string[]).includes(code)),
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('down() is a no-op when the permissions table does not exist (only the existence probe runs)', async () => {
    const state = freshState({ tables: new Set(['role_permissions', 'user_permissions']) })
    state.rolePermissions.push({ roleId: 'role-b', code: 'approvals:write' })
    state.userPermissions.push({ userId: 'user-c', code: 'approvals:act' })
    const before = snapshot(state)
    const warn = silenceWarn()

    await migration.down(createFakeRbacDb(state))

    expect(writesOf(state)).toEqual([])
    expect(snapshot(state)).toEqual(before)
    expect(warn).not.toHaveBeenCalled()
  })

  it('down() omits the guard of a grant table that does not exist and keeps the other guard', async () => {
    const state = freshState({ tables: new Set(['permissions', 'user_permissions']) })
    const db = createFakeRbacDb(state)
    await migration.up(db)
    state.userPermissions.push({ userId: 'user-c', code: 'approvals:act' })
    silenceWarn()

    await migration.down(db)

    const deletes = writesOf(state).filter((text) => text.startsWith('DELETE'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).not.toContain('role_permissions')
    expect(deletes[0]).toContain(USER_UNBOUND)
    expect(state.permissions.has('approvals:act')).toBe(true)
    expect(state.userPermissions).toEqual([{ userId: 'user-c', code: 'approvals:act' }])
    expect(state.permissions.has('approvals:write')).toBe(false)
  })

  it('down() then up(): the bound code and its grant survive the round trip, the removed codes come back with pinned names', async () => {
    const state = deployedState()
    const db = createFakeRbacDb(state)
    await migration.up(db)
    state.userPermissions.push({ userId: 'user-c', code: 'approvals:act' })
    silenceWarn()

    await migration.down(db)
    expect(state.permissions.has('approvals:act')).toBe(true)
    expect(state.permissions.has('approvals:write')).toBe(false)
    await migration.up(db)

    for (const code of NEW_CODES) expect(state.permissions.get(code)?.name).toBe(EXPECTED_NAMES[code])
    expect(state.userPermissions.filter((row) => row.code === 'approvals:act')).toEqual([{ userId: 'user-c', code: 'approvals:act' }])
  })

  it('the descriptions state the route-level capability and promise no instance-level scope', async () => {
    const state = freshState()
    await migration.up(createFakeRbacDb(state))

    // A catalogue description that says an `act` holder acts "on an assigned node" tells the administrator
    // making the grant decision something no route enforces for every instance; keep it capability-level.
    for (const code of NEW_CODES) {
      expect(state.permissions.get(code)?.description ?? '').not.toMatch(/\bassigned\b|\bseat\b/i)
    }
  })
})
