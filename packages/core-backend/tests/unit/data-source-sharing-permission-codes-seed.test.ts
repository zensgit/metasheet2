/**
 * G02 PR-1 — the `data_sources:use|rotate|share` seed, checked against the code that will ENFORCE
 * it, and against the one gate this PR actually moves.
 *
 * WHAT THIS SUITE IS FOR
 *
 * Two separate things ship together here and each can rot in a different direction:
 *
 *   1. THE SEED. Three rows in `permissions`. Without the row the grant is not merely undocumented,
 *      it is refused by the database — `role_permissions.permission_code` and
 *      `user_permissions.permission_code` are FOREIGN KEYs onto `permissions(code)`
 *      (20250924190000_create_rbac_tables.ts:92-115). A seed that drifts from the gates recreates
 *      exactly the "enforceable but ungrantable" state G09 was opened to fix.
 *
 *   2. THE GATE MOVE. `PUT /api/data-sources/:id/credentials` now requires `data_sources:rotate`
 *      EXCLUSIVELY. The whole value of splitting the verb is the exclusivity: the moment somebody
 *      "fixes a 403" by turning it into `rbacGuardAny(['data_sources:rotate','data_sources:write'])`,
 *      rotating a password and repointing a source are fused again and this PR becomes decorative.
 *      So exclusivity is asserted structurally against the real route file, not just behaviourally.
 *
 * Every guard below is paired with an IN-MEMORY MUTATION PROBE that feeds the same assertion a
 * deliberately broken input and demands it throw. Nothing on disk is ever modified.
 *
 * NO DATABASE. Idempotency is checked by replaying the migration's OWN emitted SQL against an
 * in-process simulation that models exactly one thing: the `permissions(code)` primary key and
 * `ON CONFLICT (code) DO NOTHING`. That is precisely what "idempotent" means for a seed. Real
 * Postgres replay (`db:migrate` twice against a fresh database) is CI's migration-replay lane; this
 * file exists so the property is also checked on every no-DB unit run. Simulation shape follows
 * tests/unit/integration-permission-codes-seed.test.ts (G09 / #5611).
 *
 * DELIBERATE DECOUPLING FROM #5611. This suite never imports that migration's constants and never
 * asserts that the pre-existing three codes are seeded anywhere. The two migrations are independent
 * and may land in either order; a test that required the other one to exist would make merge order
 * load-bearing.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  DATA_SOURCE_ALL_PERMISSION_CODES,
  DATA_SOURCE_PREEXISTING_PERMISSION_CODES,
  DATA_SOURCE_SHARING_PERMISSION_CODES,
  down,
  up,
} from '../../src/db/migrations/zzzz20260912120000_add_data_source_sharing_permissions'
import {
  derivePermissionNamespace,
  isNamespaceAdmissionControlledResource,
} from '../../src/rbac/namespace-admission'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')
const MIGRATION_BASENAME = 'zzzz20260912120000_add_data_source_sharing_permissions.ts'
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_BASENAME)
const ROUTES_PATH = path.join(__dirname, '../../src/routes/data-sources.ts')

const CREDENTIALS_ROUTE = '/api/data-sources/:id/credentials'
const CONFIG_ROUTE = '/api/data-sources/:id'

// ---------------------------------------------------------------------------
// Parsers — every "expected" set below is derived from real source, never typed out.
// ---------------------------------------------------------------------------

const QUOTE = `['"\`]`

/** The codes the migration actually INSERTs, read out of its own `VALUES` tuples. */
function parseSeededCodes(migrationSource: string): string[] {
  const upBody = migrationSource.split('export async function up')[1] ?? ''
  const insert = upBody.split('INSERT INTO permissions')[1] ?? ''
  const values = insert.split('ON CONFLICT')[0] ?? insert
  const codes = [...values.matchAll(/\(\s*'([a-z_]+:[a-z_]+)'\s*,/g)].map((match) => match[1])
  return [...new Set(codes)].sort()
}

/**
 * The middleware text of ONE route registration, i.e. everything between the route path literal and
 * the `async (` handler. Throws when the route is absent, so a renamed/removed route reds this file
 * instead of silently making its gate assertions vacuous.
 */
function parseRouteMiddleware(routeSource: string, method: string, routePath: string): string {
  const pattern = new RegExp(
    `router\\.${method}\\(\\s*${QUOTE}${routePath}${QUOTE}\\s*,([\\s\\S]*?),\\s*async\\s*\\(`,
  )
  const match = pattern.exec(routeSource)
  if (!match) throw new Error(`route registration not found: ${method.toUpperCase()} ${routePath}`)
  return match[1].trim()
}

/**
 * Permission codes referenced by a middleware chain, in every shape the repo uses:
 * `rbacGuard('res', 'action')`, `rbacGuard('res:action')` and `rbacGuardAny(['res:a', 'res:b'])`,
 * in any quote style. A parser that only knew the two-argument form could be bypassed by writing
 * the widening any other legal way, which would make the exclusivity assertion quietly vacuous.
 */
function parseGuardCodes(middleware: string): string[] {
  const twoArg = new RegExp(`rbacGuard\\w*\\(\\s*${QUOTE}([a-z_]+)${QUOTE}\\s*,\\s*${QUOTE}([a-z_]+)${QUOTE}`, 'g')
  const literal = new RegExp(`${QUOTE}([a-z_]+:[a-z_]+)${QUOTE}`, 'g')
  const codes = [
    ...[...middleware.matchAll(twoArg)].map((match) => `${match[1]}:${match[2]}`),
    ...[...middleware.matchAll(literal)].map((match) => match[1]),
  ]
  return [...new Set(codes)].sort()
}

/** Every `<resource>:<action>` code enforced anywhere in a route file, all call shapes. */
function parseEnforcedCodes(routeSource: string, resource: string): string[] {
  const twoArg = new RegExp(`rbacGuard\\w*\\(\\s*${QUOTE}${resource}${QUOTE}\\s*,\\s*${QUOTE}([a-z_]+)${QUOTE}`, 'g')
  const literal = new RegExp(`${QUOTE}${resource}:([a-z_]+)${QUOTE}`, 'g')
  const codes = [
    ...[...routeSource.matchAll(twoArg)].map((match) => `${resource}:${match[1]}`),
    ...[...routeSource.matchAll(literal)].map((match) => `${resource}:${match[1]}`),
  ]
  return [...new Set(codes)].sort()
}

/**
 * THE exclusivity guard. Rotation must be gated by `data_sources:rotate` and by nothing else.
 * An ANY-of gate that also accepts `data_sources:write` would restore the exact fusion this PR
 * exists to break, while leaving every behavioural test green (a `write` holder would still rotate).
 */
function assertRotateGateIsExclusive(routeSource: string): void {
  const middleware = parseRouteMiddleware(routeSource, 'put', CREDENTIALS_ROUTE)
  if (/rbacGuardAny/.test(middleware)) {
    throw new Error(
      `PUT ${CREDENTIALS_ROUTE} must not use an any-of gate: rotate is exclusive, found \`${middleware}\``,
    )
  }
  const codes = parseGuardCodes(middleware)
  if (codes.length !== 1 || codes[0] !== 'data_sources:rotate') {
    throw new Error(
      `PUT ${CREDENTIALS_ROUTE} must be gated by data_sources:rotate EXCLUSIVELY, found: [${codes.join(', ')}]`,
    )
  }
}

/**
 * THE split guard. Moving rotation out is only meaningful while repointing stays where it was: if a
 * later change also moved `PUT /:id` onto `rotate`, the two acts would be fused again from the other
 * side and rotation would once more imply repointing.
 */
function assertConfigEditStaysOnWrite(routeSource: string): void {
  const codes = parseGuardCodes(parseRouteMiddleware(routeSource, 'put', CONFIG_ROUTE))
  if (codes.length !== 1 || codes[0] !== 'data_sources:write') {
    throw new Error(
      `PUT ${CONFIG_ROUTE} (repoint the connection) must stay on data_sources:write, found: [${codes.join(', ')}]`,
    )
  }
}

/**
 * THE reconciliation, in both directions, scoped to what THIS migration is responsible for:
 *
 *   - a `data_sources:*` code enforced by a gate but absent from BOTH the pre-existing vocabulary
 *     and this seed is ungrantable — the G09 bug, reintroduced;
 *   - a code this migration DECLARES (the exported constant, which the design's verb table and the
 *     later PRs both read) but does not actually INSERT is vocabulary that exists only in
 *     TypeScript: grantable nowhere, and invisible to the "ungrantable" direction above for as long
 *     as no gate references it yet. That is exactly the state `use` and `share` are in during PR-1,
 *     so without this direction a dropped `use` line would go unnoticed until PR-4;
 *
 *   - a code this migration seeds whose enforcement status disagrees with `expectedWired` is drift
 *     between the plan and the tree. PR-1 wires `rotate` only; `use` and `share` are seeded now and
 *     wired by PR-4 / PR-3, so "seeded but enforced nowhere" is the CORRECT state for those two and
 *     is asserted as such rather than tolerated.
 */
function assertSeedMatchesEnforcement(
  seededCodes: string[],
  enforcedCodes: string[],
  expectedWired: string[],
  declaredCodes: readonly string[] = DATA_SOURCE_SHARING_PERMISSION_CODES,
): void {
  const seeded = [...new Set(seededCodes)].sort()
  const enforced = [...new Set(enforcedCodes)].sort()
  const known = new Set<string>([...DATA_SOURCE_PREEXISTING_PERMISSION_CODES, ...seeded])

  const ungrantable = enforced.filter((code) => !known.has(code))
  if (ungrantable.length > 0) {
    throw new Error(
      `enforced but never seeded (FK to permissions(code) makes these ungrantable): ${ungrantable.join(', ')}`,
    )
  }

  const undeclared = declaredCodes.filter((code) => !seeded.includes(code))
  if (undeclared.length > 0) {
    throw new Error(`declared but never seeded (TypeScript-only vocabulary): ${undeclared.join(', ')}`)
  }

  const wired = seeded.filter((code) => enforced.includes(code)).sort()
  const expected = [...new Set(expectedWired)].sort()
  if (wired.join(',') !== expected.join(',')) {
    throw new Error(
      `wiring drift: this PR wires [${expected.join(', ')}] of the new codes, tree wires [${wired.join(', ')}]`,
    )
  }
}

/**
 * THE zero-automatic-holders guard. `up` may CREATE vocabulary and nothing else; the moment it also
 * hands the vocabulary out, installing the migration becomes a grant made by nobody.
 */
function assertUpGrantsNothing(migrationSource: string): void {
  const upBody = migrationSource
    .split('export async function up')[1]
    ?.split('export async function down')[0] ?? ''
  if (!upBody) throw new Error('could not locate up() body')

  for (const forbidden of [
    /INSERT INTO\s+role_permissions/i,
    /INSERT INTO\s+user_permissions/i,
    /INSERT INTO\s+user_roles/i,
    /UPDATE\s+permissions/i,
    /DELETE FROM/i,
  ]) {
    if (forbidden.test(upBody)) {
      throw new Error(`up() must only seed permission rows, found: ${forbidden}`)
    }
  }
}

// ---------------------------------------------------------------------------
// A Postgres simulation that models exactly one thing: the permissions primary key.
// ---------------------------------------------------------------------------

class DuplicateKeyError extends Error {
  readonly code = '23505'
  constructor(key: string) {
    super(`duplicate key value violates unique constraint "permissions_pkey" (code)=(${key})`)
    this.name = 'DuplicateKeyError'
  }
}

class MemoryRbacTables {
  /** table name -> primary-key value -> row. Presence of a key models `information_schema.tables`. */
  private readonly tables = new Map<string, Map<string, Record<string, string>>>()
  readonly executed: string[] = []

  constructor(existingTables: string[] = ['permissions', 'role_permissions', 'user_permissions']) {
    for (const table of existingTables) this.tables.set(table, new Map())
  }

  codes(table = 'permissions'): string[] {
    return [...(this.tables.get(table)?.keys() ?? [])].sort()
  }

  seed(table: string, keys: string[]): void {
    const rows = this.tables.get(table)
    if (!rows) return
    for (const key of keys) rows.set(key, { key })
  }

  execute(statement: string): void {
    this.executed.push(statement)

    // `DO $$ BEGIN IF EXISTS (... table_name = 'x') THEN ... END $$` — the guard the migration wraps
    // every statement in. A missing table skips the whole block, exactly as in Postgres.
    const guarded = /table_name\s*=\s*'([a-z_]+)'/.exec(statement)
    if (guarded && !this.tables.has(guarded[1])) return

    const insertMatch = /INSERT INTO\s+([a-z_]+)\s*\(([^)]*)\)\s*VALUES([\s\S]*?)(ON CONFLICT[\s\S]*?)?;/i
      .exec(statement)
    if (insertMatch) {
      const [, table, , valuesText, onConflict] = insertMatch
      const rows = this.tables.get(table)
      if (!rows) return
      const ignoreDuplicates = /ON CONFLICT\s*\(\s*code\s*\)\s*DO NOTHING/i.test(onConflict ?? '')
      for (const tuple of valuesText.matchAll(/\(\s*'((?:[^']|'')*)'/g)) {
        const key = tuple[1]
        if (rows.has(key)) {
          if (ignoreDuplicates) continue
          throw new DuplicateKeyError(key)
        }
        rows.set(key, { key })
      }
      return
    }

    const deleteMatch = /DELETE FROM\s+([a-z_]+)\s*WHERE\s+[a-z_]+\s+IN\s*\(([\s\S]*?)\)\s*;/i
      .exec(statement)
    if (deleteMatch) {
      const [, table, listText] = deleteMatch
      const rows = this.tables.get(table)
      if (!rows) return
      for (const literal of listText.matchAll(/'((?:[^']|'')*)'/g)) rows.delete(literal[1])
    }
  }
}

function createMemoryDb(memory: MemoryRbacTables): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiledQuery): Promise<QueryResult<R>> {
      memory.execute(compiledQuery.sql)
      return { rows: [] as R[] }
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streaming is not used by these migrations')
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

const readMigrationSource = (): Promise<string> => fs.readFile(MIGRATION_PATH, 'utf8')
const readRouteSource = (): Promise<string> => fs.readFile(ROUTES_PATH, 'utf8')

// ---------------------------------------------------------------------------
// 1. Vocabulary
// ---------------------------------------------------------------------------

describe('data_sources sharing permission seed — vocabulary', () => {
  it('seeds exactly the three new verbs and the exported constant matches the migration SQL', async () => {
    const source = await readMigrationSource()

    expect(DATA_SOURCE_SHARING_PERMISSION_CODES).toHaveLength(3)
    expect([...DATA_SOURCE_SHARING_PERMISSION_CODES]).toEqual([
      'data_sources:use',
      'data_sources:rotate',
      'data_sources:share',
    ])
    expect(parseSeededCodes(source)).toEqual([...DATA_SOURCE_SHARING_PERMISSION_CODES].sort())
  })

  it('all three share the `data_sources` prefix, so they ride ONE admission switch', () => {
    // §2 of the design: `derivePermissionResource` takes everything before the FIRST colon, so a
    // new prefix would have created a second operator-facing admission surface for no security
    // gain. This is what reds if someone renames a code to e.g. `data_sources_share:grant`.
    for (const code of DATA_SOURCE_SHARING_PERMISSION_CODES) {
      expect(code.slice(0, code.indexOf(':'))).toBe('data_sources')
    }
    expect(new Set(DATA_SOURCE_ALL_PERMISSION_CODES).size).toBe(6)
  })

  it('is discoverable by the migration provider: right folder, unique name, no skip prefix', async () => {
    // `createCoreBackendMigrationProvider` hands `src/db/migrations` to Kysely's
    // FileMigrationProvider, which keys migrations by basename and skips anything starting with `_`
    // or `.`. A seed in the wrong folder is not an error — it just silently never runs.
    const names = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.ts'))
    expect(names).toContain(MIGRATION_BASENAME)
    expect(MIGRATION_BASENAME.startsWith('_') || MIGRATION_BASENAME.startsWith('.')).toBe(false)
    expect(names.filter((name) => name === MIGRATION_BASENAME)).toHaveLength(1)
    // Proof the glob really is the migrations folder rather than an empty/renamed directory.
    expect(names).toContain('20250924190000_create_rbac_tables.ts')
    // No ordering assertion on purpose: `runMigrations` sets `allowUnorderedMigrations: true` and
    // up() depends only on `permissions` existing, so relative position protects nothing — while an
    // "I sort last" assertion would red on the next person's unrelated migration PR.
  })

  it('uses the repo seed shape: DO $$ table guard + ON CONFLICT (code) DO NOTHING', async () => {
    const source = await readMigrationSource()
    expect(source).toContain('DO $$')
    expect(source).toContain("table_name = 'permissions'")
    expect(source).toContain('ON CONFLICT (code) DO NOTHING')
  })

  it('grants the codes to NOBODY — no role or user binding is created by the migration', async () => {
    const source = await readMigrationSource()
    expect(() => assertUpGrantsNothing(source)).not.toThrow()
  })

  it('MUTATION PROBE: seeding a role binding in up() trips the zero-automatic-holders guard', async () => {
    const source = await readMigrationSource()
    // The exact shape zzzz20260824121000_add_elearning_permissions uses — legal there, refused here.
    const withAdminGrant = source.replace(
      'ON CONFLICT (code) DO NOTHING;',
      "ON CONFLICT (code) DO NOTHING;\n        INSERT INTO role_permissions (role_id, permission_code)\n          VALUES ('admin', 'data_sources:rotate') ON CONFLICT DO NOTHING;",
    )
    expect(withAdminGrant).not.toEqual(source)
    expect(() => assertUpGrantsNothing(withAdminGrant)).toThrow(/only seed permission rows/)
  })

  it('down() removes only these three codes, children before parents', async () => {
    const downBody = (await readMigrationSource()).split('export async function down')[1] ?? ''

    const roleDelete = downBody.indexOf('DELETE FROM role_permissions')
    const userDelete = downBody.indexOf('DELETE FROM user_permissions')
    const permissionDelete = downBody.indexOf('DELETE FROM permissions')
    expect(roleDelete).toBeGreaterThanOrEqual(0)
    expect(userDelete).toBeGreaterThan(roleDelete)
    expect(permissionDelete).toBeGreaterThan(userDelete)

    // A rollback reaching another domain's codes would revoke grants this migration never made.
    // `data_sources:read|write|execute` are in this list on purpose: they are NOT ours to delete.
    for (const foreign of [
      'data_sources:read',
      'data_sources:write',
      'data_sources:execute',
      'integration:',
      'stock-prep:',
      'elearning:',
      'attendance:',
      'multitable:',
      'approvals:',
    ]) {
      expect(downBody).not.toContain(foreign)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The gate this PR moves — asserted structurally against the real route file.
// ---------------------------------------------------------------------------

describe('data_sources sharing permission seed — the rotate gate', () => {
  it('PUT /:id/credentials is gated by data_sources:rotate EXCLUSIVELY', async () => {
    const source = await readRouteSource()
    expect(() => assertRotateGateIsExclusive(source)).not.toThrow()
  })

  it('PUT /:id (repoint the connection) stays on data_sources:write — the split is a split', async () => {
    const source = await readRouteSource()
    expect(() => assertConfigEditStaysOnWrite(source)).not.toThrow()
  })

  it('MUTATION PROBE: reverting the credentials gate to `write` trips the exclusivity guard', async () => {
    const source = await readRouteSource()
    const reverted = source.replace(
      `router.put('${CREDENTIALS_ROUTE}', rbacGuard('data_sources', 'rotate')`,
      `router.put('${CREDENTIALS_ROUTE}', rbacGuard('data_sources', 'write')`,
    )
    expect(reverted).not.toEqual(source)
    expect(() => assertRotateGateIsExclusive(reverted)).toThrow(/EXCLUSIVELY, found: \[data_sources:write\]/)
  })

  it('MUTATION PROBE: widening the credentials gate to any-of(rotate, write) trips it too', async () => {
    // This is the mutation a behavioural test alone CANNOT catch: with an any-of gate every
    // positive rotation case still passes, and only the fail-closed 403 case would red. Asserting
    // the shape means the widening is caught even if someone deletes that 403 case.
    const source = await readRouteSource()
    const widened = source.replace(
      `router.put('${CREDENTIALS_ROUTE}', rbacGuard('data_sources', 'rotate')`,
      `router.put('${CREDENTIALS_ROUTE}', rbacGuardAny(['data_sources:rotate', 'data_sources:write'])`,
    )
    expect(widened).not.toEqual(source)
    expect(() => assertRotateGateIsExclusive(widened)).toThrow(/must not use an any-of gate/)
  })

  it('MUTATION PROBE: moving PUT /:id onto rotate trips the split guard', async () => {
    const source = await readRouteSource()
    const fused = source.replace(
      `router.put('${CONFIG_ROUTE}', rbacGuard('data_sources', 'write')`,
      `router.put('${CONFIG_ROUTE}', rbacGuard('data_sources', 'rotate')`,
    )
    expect(fused).not.toEqual(source)
    expect(() => assertConfigEditStaysOnWrite(fused)).toThrow(/must stay on data_sources:write/)
  })

  it('the guard parsers see every call shape and every quote style', () => {
    // `rbacGuard` accepts one argument OR two (src/rbac/rbac.ts:56-57) and `rbacGuardAny` takes an
    // array (:119). A parser that understood only one of them could be bypassed by writing the
    // widening any other legal way, making the exclusivity assertion silently vacuous.
    expect(parseGuardCodes("rbacGuard('data_sources', 'rotate')")).toEqual(['data_sources:rotate'])
    expect(parseGuardCodes('rbacGuard("data_sources", "rotate")')).toEqual(['data_sources:rotate'])
    expect(parseGuardCodes('rbacGuard(`data_sources`, `rotate`)')).toEqual(['data_sources:rotate'])
    expect(parseGuardCodes("rbacGuard('data_sources:rotate')")).toEqual(['data_sources:rotate'])
    expect(parseGuardCodes("rbacGuardAny(['data_sources:rotate', 'data_sources:write'])")).toEqual([
      'data_sources:rotate',
      'data_sources:write',
    ])
    // And the documented blind spot, asserted rather than claimed: a code assembled at runtime is
    // invisible to the parser. That residual risk is real and is named here so it stays visible.
    expect(parseGuardCodes("const action = 'write'\nrbacGuard('data_sources', action)")).toEqual([])
  })

  it('MUTATION PROBE: the route lookup fails loudly when the route disappears', async () => {
    const source = await readRouteSource()
    expect(() => parseRouteMiddleware(source, 'put', '/api/data-sources/:id/nonexistent')).toThrow(
      /route registration not found/,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Reconciliation between the seed and what the route file enforces.
// ---------------------------------------------------------------------------

describe('data_sources sharing permission seed — reconciliation with the gates', () => {
  it('every data_sources code the route file enforces is grantable; PR-1 wires rotate only', async () => {
    const [migrationSource, routeSource] = await Promise.all([readMigrationSource(), readRouteSource()])
    const enforced = parseEnforcedCodes(routeSource, 'data_sources')

    // Proof the parser found the gates rather than silently matching nothing.
    expect(enforced.length).toBeGreaterThan(0)
    expect(enforced).toContain('data_sources:rotate')

    expect(() =>
      assertSeedMatchesEnforcement(parseSeededCodes(migrationSource), enforced, ['data_sources:rotate']),
    ).not.toThrow()
  })

  it('`use` and `share` are seeded but wired NOWHERE yet — PR-1 moves exactly one door', async () => {
    // PR-4 wires `use` onto /schema, /tables/:table and /select; PR-3 wires `share` onto the new
    // PUT /:id/scope. Until then the correct state is "grantable, enforced nowhere", and pinning it
    // means those later PRs have to come here and say so.
    const enforced = parseEnforcedCodes(await readRouteSource(), 'data_sources')
    expect(enforced).not.toContain('data_sources:use')
    expect(enforced).not.toContain('data_sources:share')
  })

  it('MUTATION PROBE: dropping any one seeded code is caught', async () => {
    const migrationSource = await readMigrationSource()
    const enforced = parseEnforcedCodes(await readRouteSource(), 'data_sources')

    for (const dropped of DATA_SOURCE_SHARING_PERMISSION_CODES) {
      // In-memory only: the file on disk is never touched.
      const mutated = migrationSource.replace(new RegExp(`^.*\\('${dropped}', '.*$\\n?`, 'm'), '')
      expect(parseSeededCodes(mutated), `${dropped} should be gone from the mutated source`)
        .not.toContain(dropped)
      expect(
        () => assertSeedMatchesEnforcement(parseSeededCodes(mutated), enforced, ['data_sources:rotate']),
        `dropping ${dropped} must be caught`,
      ).toThrow(
        dropped === 'data_sources:rotate'
          // `rotate` IS wired by this PR, so dropping it is caught by the ungrantable direction —
          // the G09 bug reintroduced. `use`/`share` are wired nowhere yet, so only the declared-vs-
          // seeded direction sees them; that asymmetry is why both directions exist.
          ? /enforced but never seeded/
          : /declared but never seeded/,
      )
    }
  })

  it('MUTATION PROBE: a gate action nobody seeded is caught', async () => {
    const seeded = parseSeededCodes(await readMigrationSource())
    expect(() =>
      assertSeedMatchesEnforcement(seeded, [...seeded, 'data_sources:truncate'], ['data_sources:rotate']),
    ).toThrow(/data_sources:truncate/)
  })

  it('MUTATION PROBE: silently wiring `use` early is caught as wiring drift', async () => {
    const seeded = parseSeededCodes(await readMigrationSource())
    expect(() =>
      assertSeedMatchesEnforcement(seeded, ['data_sources:rotate', 'data_sources:use'], ['data_sources:rotate']),
    ).toThrow(/wiring drift/)
  })
})

// ---------------------------------------------------------------------------
// 4. Idempotency, proven by replaying the migration's own SQL.
// ---------------------------------------------------------------------------

describe('data_sources sharing permission seed — idempotency', () => {
  it('up() twice leaves exactly three rows and never raises a duplicate key', async () => {
    const memory = new MemoryRbacTables()
    const db = createMemoryDb(memory)

    await up(db)
    expect(memory.codes()).toEqual([...DATA_SOURCE_SHARING_PERMISSION_CODES].sort())

    await expect(up(db)).resolves.toBeUndefined()
    expect(memory.codes()).toEqual([...DATA_SOURCE_SHARING_PERMISSION_CODES].sort())
  })

  it('up() is a no-op on a database that already carries a subset of the codes', async () => {
    const memory = new MemoryRbacTables()
    memory.seed('permissions', ['data_sources:rotate', 'data_sources:write', 'stock-prep:read'])
    const db = createMemoryDb(memory)

    await up(db)
    expect(memory.codes()).toEqual(
      [...new Set([...DATA_SOURCE_SHARING_PERMISSION_CODES, 'data_sources:write', 'stock-prep:read'])].sort(),
    )
  })

  it('up() is skipped entirely when the permissions table does not exist', async () => {
    const memory = new MemoryRbacTables([])
    const db = createMemoryDb(memory)

    await expect(up(db)).resolves.toBeUndefined()
    expect(memory.codes()).toEqual([])
  })

  it('down() removes the three codes and leaves the pre-existing vocabulary untouched', async () => {
    const memory = new MemoryRbacTables()
    memory.seed('permissions', [...DATA_SOURCE_PREEXISTING_PERMISSION_CODES, 'stock-prep:read'])
    memory.seed('role_permissions', ['data_sources:rotate', 'data_sources:write'])
    const db = createMemoryDb(memory)

    await up(db)
    await down(db)

    expect(memory.codes()).toEqual(
      [...DATA_SOURCE_PREEXISTING_PERMISSION_CODES, 'stock-prep:read'].sort(),
    )
    // The operator's own `data_sources:write` role bindings survive a rollback of this migration.
    expect(memory.codes('role_permissions')).toEqual(['data_sources:write'])
  })

  it('MUTATION PROBE: without ON CONFLICT the very same seed fails on the second run', async () => {
    // Capture the migration's REAL emitted SQL, then strip the idempotency clause in memory.
    const capture = new MemoryRbacTables()
    await up(createMemoryDb(capture))
    expect(capture.executed).toHaveLength(1)

    const nonIdempotent = capture.executed[0].replace(/\s*ON CONFLICT \(code\) DO NOTHING/i, '')
    expect(nonIdempotent).not.toContain('ON CONFLICT')

    const memory = new MemoryRbacTables()
    expect(() => memory.execute(nonIdempotent)).not.toThrow()
    expect(() => memory.execute(nonIdempotent)).toThrow(/duplicate key value/)
  })
})

// ---------------------------------------------------------------------------
// 5. The posture this migration deliberately did NOT change.
// ---------------------------------------------------------------------------

describe('data_sources sharing permission seed — namespace admission posture', () => {
  it('the namespace stays admission-controlled, and all three codes derive it', () => {
    // NON_NAMESPACED_PERMISSION_RESOURCES is an EXEMPTION list. Putting `data_sources` in it would
    // let EVERY existing holder of EVERY data_sources code bypass `user_namespace_admissions` — a
    // widening on the namespace that reaches customer database credentials. This reds if anyone does.
    expect(isNamespaceAdmissionControlledResource('data_sources')).toBe(true)
    for (const code of DATA_SOURCE_ALL_PERMISSION_CODES) {
      expect(derivePermissionNamespace(code)).toBe('data_sources')
    }
  })

  it('MUTATION PROBE: the posture assertion discriminates — exempt resources answer false/null', () => {
    // If `data_sources` were added to the exemption list it would behave like these do, and the
    // assertion above would red. This is what proves that assertion is not vacuously true.
    for (const exempt of ['multitable', 'workflow', 'approvals', 'admin']) {
      expect(isNamespaceAdmissionControlledResource(exempt)).toBe(false)
      expect(derivePermissionNamespace(`${exempt}:read`)).toBeNull()
    }
  })

  it('no executable statement in the migration touches the admission surface', async () => {
    const source = await readMigrationSource()
    // Everything before the first export is the header docblock, which DISCUSSES both identifiers
    // on purpose. What must stay clean is the code that runs.
    const executable = source.slice(source.indexOf('export const DATA_SOURCE_SHARING_PERMISSION_CODES'))
    expect(executable.length).toBeGreaterThan(0)
    expect(executable).not.toContain('NON_NAMESPACED_PERMISSION_RESOURCES')
    expect(executable).not.toContain('user_namespace_admissions')
  })
})
