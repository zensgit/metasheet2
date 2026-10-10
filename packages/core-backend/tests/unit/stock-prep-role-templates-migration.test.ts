/**
 * S5a — the four built-in 备料 role templates (ADR adr-stock-prep-project-sheets-20261008 §11.2 /
 * §11.3; register R-39), migration `zzzz20261010124500_seed_stock_prep_role_templates`, against a
 * FAKE database (no PostgreSQL).
 *
 *   T-01 THE TABLE: four literal ids, the ADR display names, EXACT code sets (no fifth code, no
 *        platform code, the developer holds read only), every code in the plugin's vocabulary.
 *   T-02 THE IDS: each matches the G1 grant pattern and `roleIdMatchesNamespace('stock-prep', id)`;
 *        exactly one ends with `_admin` and it is `stock-prep_admin` (the only delegated admin).
 *   T-03 THE SHAPE GUARD refuses — with a positive control — a second `_admin`, no `_admin`, a
 *        `buildPluginRoleId`-shaped id, an out-of-namespace code, a duplicate id.
 *   T-04 FRESH DATABASE: up() creates the four with exactly their codes, zero members, all four in
 *        the ledger.
 *   T-05 ADOPTION: a pre-existing `stock-prep_puller` (any name, any codes, members) is left
 *        byte-identical; no code is bound to it; it is not in the ledger; the other three are created.
 *   T-06 DISPLAY-NAME CLASH: another role already named like a template (after trimming) → the
 *        template is created with the `（内置）` suffix; the other role is untouched.
 *   T-07 IDEMPOTENT: a second up() changes nothing and binds no code.
 *   T-08 down(): refuses while a role it CREATED has a member or is a role-subject grant subject;
 *        ignores an ADOPTED role's members; deletes only ledger ids; no ledger → no-op.
 *   T-09 FAIL-CLOSED PRECONDITIONS: missing RBAC tables or a missing catalogue code throw before any
 *        write.
 *
 * The fake answers ONLY the statements the migration is expected to issue (shape-matched after
 * whitespace normalisation) and throws on anything else; every answer is computed over in-memory
 * tables from the BOUND PARAMETERS. The same migration runs against real PostgreSQL in CI:
 * tests/integration/elearning-role-templates.db.test.ts (S5a block).
 */
import { createRequire } from 'node:module'

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
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn(), pool: null }))

import { STOCK_PREPARATION_GRANT_ROLE_ID_PATTERN } from '../../src/multitable/stock-preparation-project-sheet-grant-contract'
import { deriveDelegatedAdminNamespace, roleIdMatchesNamespace } from '../../src/rbac/namespace-admission'
import {
  STOCK_PREP_ROLE_TEMPLATES,
  STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED,
  STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED,
  STOCK_PREP_ROLE_TEMPLATE_IDS,
  assertStockPrepRoleTemplateShape,
  down,
  up,
  type StockPrepRoleTemplate,
} from '../../src/db/migrations/zzzz20261010124500_seed_stock_prep_role_templates'

// The migration logs one line per template; captured so the log can be checked for site values.
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
const loggedSince = (start: number) => logSpy.mock.calls.slice(start).map((args) => args.join(' '))

const require_ = createRequire(__filename)
const workbenchAccess = require_('../../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs') as {
  STOCK_PREP_PERMISSION_DESCRIPTORS: ReadonlyArray<{ code: string }>
}

const EXPECTED = [
  { id: 'stock-prep_admin', name: '备料主管理员', permissions: ['stock-prep:admin'] },
  { id: 'stock-prep_puller', name: '数据管理员（拉取人员）', permissions: ['stock-prep:operate', 'stock-prep:pull', 'stock-prep:read'] },
  { id: 'stock-prep_developer', name: '开发成员', permissions: ['stock-prep:read'] },
  { id: 'stock-prep_frontline', name: '一线填写', permissions: ['stock-prep:operate', 'stock-prep:read'] },
]
const STOCK_PREP_CODES = ['stock-prep:admin', 'stock-prep:operate', 'stock-prep:pull', 'stock-prep:read']
const GRANT_TABLES = ['spreadsheet_permissions', 'meta_view_permissions', 'field_permissions', 'record_permissions', 'meta_history_audit_grants']
const LEDGER = 'stock_prep_role_template_seeds'

// ── the fake database ──────────────────────────────────────────────────────────────────────────
type FakeState = {
  tables: Set<string>
  permissions: Set<string>
  roles: Array<{ id: string; name: string }>
  rolePermissions: Array<{ role_id: string; permission_code: string }>
  userRoles: Array<{ user_id: string; role_id: string }>
  grants: Record<string, Array<{ subject_type: string; subject_id: string }>>
  ledger: string[] | null
}

function freshState(): FakeState {
  return {
    tables: new Set(['roles', 'permissions', 'role_permissions', 'user_roles', ...GRANT_TABLES]),
    permissions: new Set([...STOCK_PREP_CODES, 'approvals:read', 'multitable:manage-schema']),
    roles: [{ id: 'admin', name: 'admin' }],
    rolePermissions: [{ role_id: 'admin', permission_code: 'approvals:read' }],
    userRoles: [{ user_id: 'user-root', role_id: 'admin' }],
    grants: Object.fromEntries(GRANT_TABLES.map((table) => [table, []])),
    ledger: null,
  }
}

const snapshot = (state: FakeState) => JSON.stringify({ ...state, tables: [...state.tables].sort(), permissions: [...state.permissions].sort() })
const norm = (text: string) => text.replace(/\s+/g, ' ').trim()
const LIST = String.raw`\((\$\d+(?:, \$\d+)*)\)`
const pick = (params: readonly unknown[], list: string) => list.split(', ').map((p) => String(params[Number(p.slice(1)) - 1]))
const WRITE = /^(INSERT|DELETE|UPDATE|CREATE|DROP|ALTER)\b/

type Recorded = { sql: string; parameters: readonly unknown[] }

function createFakeDb(state: FakeState, recorded: Recorded[] = []): Kysely<unknown> {
  const handlers: Array<[RegExp, (m: RegExpMatchArray, p: readonly unknown[]) => unknown[]]> = [
    [/^SELECT count\(\*\)::int as count FROM information_schema\.tables WHERE table_name = \$1 AND table_schema = current_schema\(\)$/, (_m, p) => {
      const name = String(p[0])
      return [{ count: (name === LEDGER ? state.ledger !== null : state.tables.has(name)) ? 1 : 0 }]
    }],
    [new RegExp(`^SELECT code FROM permissions WHERE code IN ${LIST}$`), (m, p) => pick(p, m[1]).filter((c) => state.permissions.has(c)).map((code) => ({ code }))],
    [/^CREATE TABLE IF NOT EXISTS stock_prep_role_template_seeds \( role_id text PRIMARY KEY, seeded_at timestamptz NOT NULL DEFAULT now\(\) \)$/, () => {
      state.ledger ??= []
      return []
    }],
    [/^SELECT 1 AS taken FROM roles WHERE id <> \$1 AND btrim\(name\) = \$2 LIMIT 1$/, (_m, p) =>
      state.roles.some((r) => r.id !== p[0] && r.name.trim() === p[1]) ? [{ taken: 1 }] : []],
    [/^INSERT INTO roles \(id, name\) VALUES \(\$1, \$2\) ON CONFLICT \(id\) DO NOTHING RETURNING id$/, (_m, p) => {
      if (state.roles.some((r) => r.id === p[0])) return []
      state.roles.push({ id: String(p[0]), name: String(p[1]) })
      return [{ id: p[0] }]
    }],
    [/^INSERT INTO role_permissions \(role_id, permission_code\) VALUES \(\$1, \$2\) ON CONFLICT \(role_id, permission_code\) DO NOTHING$/, (_m, p) => {
      if (!state.permissions.has(String(p[1]))) throw Object.assign(new Error('fk violation'), { code: '23503' })
      if (!state.rolePermissions.some((r) => r.role_id === p[0] && r.permission_code === p[1])) {
        state.rolePermissions.push({ role_id: String(p[0]), permission_code: String(p[1]) })
      }
      return []
    }],
    [/^INSERT INTO stock_prep_role_template_seeds \(role_id\) VALUES \(\$1\) ON CONFLICT \(role_id\) DO NOTHING$/, (_m, p) => {
      if (state.ledger === null) throw new Error('relation stock_prep_role_template_seeds does not exist')
      if (!state.ledger.includes(String(p[0]))) state.ledger.push(String(p[0]))
      return []
    }],
    [/^SELECT role_id FROM stock_prep_role_template_seeds ORDER BY role_id$/, () => [...(state.ledger ?? [])].sort().map((role_id) => ({ role_id }))],
    [new RegExp(`^SELECT EXISTS \\( SELECT 1 FROM user_roles WHERE role_id IN ${LIST} \\) AS assigned$`), (m, p) => {
      const ids = pick(p, m[1])
      return [{ assigned: state.userRoles.some((r) => ids.includes(r.role_id)) }]
    }],
    [new RegExp(`^SELECT EXISTS \\( SELECT 1 FROM "([a-z_]+)" WHERE subject_type = 'role' AND subject_id IN ${LIST} \\) AS granted$`), (m, p) => {
      const ids = pick(p, m[2])
      return [{ granted: (state.grants[m[1]] ?? []).some((g) => g.subject_type === 'role' && ids.includes(g.subject_id)) }]
    }],
    [new RegExp(`^DELETE FROM role_permissions WHERE role_id IN ${LIST}$`), (m, p) => {
      const ids = pick(p, m[1])
      state.rolePermissions = state.rolePermissions.filter((r) => !ids.includes(r.role_id))
      return []
    }],
    [new RegExp(`^DELETE FROM roles WHERE id IN ${LIST}$`), (m, p) => {
      const ids = pick(p, m[1])
      state.roles = state.roles.filter((r) => !ids.includes(r.id))
      return []
    }],
    [/^DROP TABLE IF EXISTS stock_prep_role_template_seeds$/, () => {
      state.ledger = null
      return []
    }],
  ]
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = norm(compiled.sql)
      recorded.push({ sql: text, parameters: compiled.parameters })
      for (const [pattern, handler] of handlers) {
        const match = text.match(pattern)
        if (match) return { rows: handler(match, compiled.parameters) as R[] }
      }
      throw new Error(`FAKE_DB_UNKNOWN_STATEMENT: ${text}`)
    },
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streamQuery is not used by migrations')
    },
  }
  const driver: Driver = {
    async init() {},
    async acquireConnection() { return connection },
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

const codesOf = (state: FakeState, roleId: string) =>
  state.rolePermissions.filter((r) => r.role_id === roleId).map((r) => r.permission_code).sort()
const roleOf = (state: FakeState, roleId: string) => state.roles.find((r) => r.id === roleId)

// ── tests ──────────────────────────────────────────────────────────────────────────────────────
describe('S5a stock-prep role templates — the table (T-01..T-03)', () => {
  it('T-01: four literal ids, the ADR names, exact code sets inside the stock-prep vocabulary', () => {
    expect(STOCK_PREP_ROLE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, permissions: [...t.permissions].sort() }))).toEqual(EXPECTED)
    expect(STOCK_PREP_ROLE_TEMPLATE_IDS).toEqual(EXPECTED.map((t) => t.id))
    const vocabulary = workbenchAccess.STOCK_PREP_PERMISSION_DESCRIPTORS.map((d) => d.code).sort()
    expect(vocabulary).toEqual(STOCK_PREP_CODES)
    for (const template of STOCK_PREP_ROLE_TEMPLATES) {
      for (const code of template.permissions) expect(vocabulary).toContain(code)
      expect(template.permissions.some((code) => /^(multitable|workflow|roles|integration|approvals|spreadsheet):|^\*/.test(code))).toBe(false)
    }
  })

  it('T-02: every id is a G1-grantable, namespace-assignable role id; only stock-prep_admin is a delegated admin', () => {
    for (const id of STOCK_PREP_ROLE_TEMPLATE_IDS) {
      expect(STOCK_PREPARATION_GRANT_ROLE_ID_PATTERN.test(id)).toBe(true)
      expect(roleIdMatchesNamespace(id, 'stock-prep')).toBe(true)
    }
    expect(STOCK_PREP_ROLE_TEMPLATE_IDS.filter((id) => id.endsWith('_admin'))).toEqual(['stock-prep_admin'])
    expect(STOCK_PREP_ROLE_TEMPLATE_IDS.map((id) => deriveDelegatedAdminNamespace(id))).toEqual(['stock-prep', null, null, null])
  })

  it('T-03: the shape guard refuses each ADR §11.2 violation (positive control: the shipped table passes)', () => {
    expect(() => assertStockPrepRoleTemplateShape(STOCK_PREP_ROLE_TEMPLATES)).not.toThrow()
    const base = STOCK_PREP_ROLE_TEMPLATES.map((t) => ({ ...t, permissions: [...t.permissions] }))
    const variant = (index: number, patch: Partial<StockPrepRoleTemplate>) => base.map((t, i) => (i === index ? { ...t, ...patch } : t))
    expect(() => assertStockPrepRoleTemplateShape(variant(1, { id: 'stock-prep_data_admin' }))).toThrow('only stock-prep_admin may end with _admin')
    expect(() => assertStockPrepRoleTemplateShape(variant(0, { id: 'stock-prep_chief' }))).toThrow('only stock-prep_admin may end with _admin')
    expect(() => assertStockPrepRoleTemplateShape(variant(3, { id: 'stock_prep_frontline' }))).toThrow(/wrong shape/)
    expect(() => assertStockPrepRoleTemplateShape(variant(3, { id: 'stock-prep_front line' }))).toThrow(/wrong shape/)
    expect(() => assertStockPrepRoleTemplateShape(variant(2, { permissions: ['stock-prep:read', 'multitable:manage-schema'] }))).toThrow(/outside stock-prep/)
    expect(() => assertStockPrepRoleTemplateShape(variant(2, { id: 'stock-prep_frontline' }))).toThrow(/duplicated/)
    expect(() => assertStockPrepRoleTemplateShape(variant(2, { permissions: [] }))).toThrow(/no permission code/)
  })
})

describe('S5a stock-prep role templates — up() / down() against a fake database (T-04..T-09)', () => {
  it('T-04: a fresh database gets the four roles with exactly their codes, zero members, all in the ledger', async () => {
    const state = freshState()
    await up(createFakeDb(state))
    for (const expected of EXPECTED) {
      expect(roleOf(state, expected.id)).toEqual({ id: expected.id, name: expected.name })
      expect(codesOf(state, expected.id)).toEqual(expected.permissions)
    }
    expect(state.userRoles.filter((r) => STOCK_PREP_ROLE_TEMPLATE_IDS.includes(r.role_id))).toEqual([])
    expect([...(state.ledger ?? [])].sort()).toEqual([...STOCK_PREP_ROLE_TEMPLATE_IDS].sort())
    expect(roleOf(state, 'admin')).toEqual({ id: 'admin', name: 'admin' })
    expect(codesOf(state, 'admin')).toEqual(['approvals:read'])
  })

  it('T-05: a pre-existing stock-prep_puller (members, any codes, any name) is adopted byte-identical', async () => {
    const state = freshState()
    state.roles.push({ id: 'stock-prep_puller', name: '备料拉取人员' })
    state.rolePermissions.push(
      { role_id: 'stock-prep_puller', permission_code: 'stock-prep:read' },
      { role_id: 'stock-prep_puller', permission_code: 'approvals:read' },
    )
    state.userRoles.push({ user_id: 'user-p1', role_id: 'stock-prep_puller' }, { user_id: 'user-p2', role_id: 'stock-prep_puller' })
    const before = {
      role: { ...roleOf(state, 'stock-prep_puller') },
      codes: codesOf(state, 'stock-prep_puller'),
      members: state.userRoles.filter((r) => r.role_id === 'stock-prep_puller'),
    }
    const recorded: Recorded[] = []
    const logStart = logSpy.mock.calls.length
    await up(createFakeDb(state, recorded))

    const log = loggedSince(logStart)
    expect(log.filter((line) => line.includes('stock-prep_puller'))).toEqual([
      '[zzzz20261010124500_seed_stock_prep_role_templates] role stock-prep_puller already exists; adopted unchanged (no rename, no code change, no member change)',
    ])
    for (const siteValue of ['备料拉取人员', 'user-p1', 'user-p2', 'approvals:read']) {
      expect(log.join('\n')).not.toContain(siteValue)
    }
    expect(roleOf(state, 'stock-prep_puller')).toEqual(before.role)
    expect(codesOf(state, 'stock-prep_puller')).toEqual(before.codes)
    expect(state.userRoles.filter((r) => r.role_id === 'stock-prep_puller')).toEqual(before.members)
    const writesBoundToPuller = recorded.filter((r) => WRITE.test(r.sql) && r.parameters.includes('stock-prep_puller'))
    expect(writesBoundToPuller.map((r) => r.sql)).toEqual(['INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id'])
    expect(state.ledger).not.toContain('stock-prep_puller')
    for (const expected of EXPECTED.filter((t) => t.id !== 'stock-prep_puller')) {
      expect(roleOf(state, expected.id)).toEqual({ id: expected.id, name: expected.name })
      expect(codesOf(state, expected.id)).toEqual(expected.permissions)
    }
  })

  it('T-06: a display name already used by another role → the template is created with the （内置） suffix', async () => {
    const state = freshState()
    state.roles.push({ id: 'site-developers', name: ' 开发成员 ' })
    state.rolePermissions.push({ role_id: 'site-developers', permission_code: 'approvals:read' })
    const logStart = logSpy.mock.calls.length
    await up(createFakeDb(state))
    expect(loggedSince(logStart).join('\n')).not.toContain('site-developers')
    expect(roleOf(state, 'stock-prep_developer')).toEqual({ id: 'stock-prep_developer', name: '开发成员（内置）' })
    expect(codesOf(state, 'stock-prep_developer')).toEqual(['stock-prep:read'])
    expect(roleOf(state, 'site-developers')).toEqual({ id: 'site-developers', name: ' 开发成员 ' })
    expect(codesOf(state, 'site-developers')).toEqual(['approvals:read'])
    expect(roleOf(state, 'stock-prep_frontline')?.name).toBe('一线填写')
  })

  it('T-07: a second up() changes nothing and binds no permission code', async () => {
    const state = freshState()
    await up(createFakeDb(state))
    const afterFirst = snapshot(state)
    const recorded: Recorded[] = []
    await up(createFakeDb(state, recorded))
    expect(snapshot(state)).toBe(afterFirst)
    expect(recorded.filter((r) => r.sql.startsWith('INSERT INTO role_permissions'))).toEqual([])
  })

  it('T-08a: down() refuses while a role it created has a member, and changes nothing', async () => {
    const state = freshState()
    await up(createFakeDb(state))
    state.userRoles.push({ user_id: 'user-f1', role_id: 'stock-prep_frontline' })
    const before = snapshot(state)
    await expect(down(createFakeDb(state))).rejects.toThrow(STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED)
    expect(snapshot(state)).toBe(before)
  })

  it('T-08b: down() refuses while a role it created is the subject of a role-subject grant row', async () => {
    for (const table of GRANT_TABLES) {
      const state = freshState()
      await up(createFakeDb(state))
      state.grants[table].push({ subject_type: 'role', subject_id: 'stock-prep_frontline' })
      const before = snapshot(state)
      await expect(down(createFakeDb(state))).rejects.toThrow(STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED)
      expect(snapshot(state)).toBe(before)
    }
  })

  it('T-08c: down() deletes only the roles it created; an adopted role with members stays byte-identical', async () => {
    const state = freshState()
    state.roles.push({ id: 'stock-prep_puller', name: '备料拉取人员' })
    state.rolePermissions.push({ role_id: 'stock-prep_puller', permission_code: 'stock-prep:pull' })
    state.userRoles.push({ user_id: 'user-p1', role_id: 'stock-prep_puller' })
    state.grants.spreadsheet_permissions.push({ subject_type: 'role', subject_id: 'stock-prep_puller' })
    await up(createFakeDb(state))
    await down(createFakeDb(state))
    expect(state.roles.map((r) => r.id).sort()).toEqual(['admin', 'stock-prep_puller'])
    expect(roleOf(state, 'stock-prep_puller')).toEqual({ id: 'stock-prep_puller', name: '备料拉取人员' })
    expect(codesOf(state, 'stock-prep_puller')).toEqual(['stock-prep:pull'])
    expect(state.userRoles).toContainEqual({ user_id: 'user-p1', role_id: 'stock-prep_puller' })
    expect(state.rolePermissions.filter((r) => ['stock-prep_admin', 'stock-prep_developer', 'stock-prep_frontline'].includes(r.role_id))).toEqual([])
    expect(state.ledger).toBeNull()
    // and up() again restores exactly the three it had created
    await up(createFakeDb(state))
    expect(codesOf(state, 'stock-prep_frontline')).toEqual(['stock-prep:operate', 'stock-prep:read'])
    expect(codesOf(state, 'stock-prep_puller')).toEqual(['stock-prep:pull'])
  })

  it('T-08d: down() with no ledger table writes nothing', async () => {
    const state = freshState()
    state.roles.push({ id: 'stock-prep_frontline', name: '一线填写' })
    const before = snapshot(state)
    const recorded: Recorded[] = []
    await down(createFakeDb(state, recorded))
    expect(snapshot(state)).toBe(before)
    expect(recorded.filter((r) => WRITE.test(r.sql))).toEqual([])
  })

  it('T-09: missing RBAC tables or a missing catalogue code fail closed before any write', async () => {
    const noUserRoles = freshState()
    noUserRoles.tables.delete('user_roles')
    const recordedA: Recorded[] = []
    await expect(up(createFakeDb(noUserRoles, recordedA))).rejects.toThrow('stock-prep role templates require the RBAC tables')
    expect(recordedA.filter((r) => WRITE.test(r.sql))).toEqual([])

    const noPull = freshState()
    noPull.permissions.delete('stock-prep:pull')
    const recordedB: Recorded[] = []
    await expect(up(createFakeDb(noPull, recordedB))).rejects.toThrow('every stock-prep permission code')
    expect(recordedB.filter((r) => WRITE.test(r.sql))).toEqual([])
  })
})
