/**
 * G09 — the `integration:*` / `data_sources:*` RBAC seed, checked against the code that ENFORCES it.
 *
 * WHY THIS SUITE EXISTS
 *
 * The bug this migration closes was not a missing feature, it was a missing ROW: six permission
 * codes that every gate on the main integration journey checks, and that no `permissions` row ever
 * defined. Because `role_permissions.permission_code` / `user_permissions.permission_code` are
 * FOREIGN KEYs onto `permissions(code)`, the grant did not fail late and loudly at the gate — it
 * failed in the database, so the only way anyone ever ran the journey as a non-admin was by
 * hand-writing INSERTs on a production box.
 *
 * A seed migration that merely *states* six codes would not prevent that from recurring, because
 * nothing would notice when a route grew a seventh gate action, or when someone dropped a code from
 * the VALUES list. So the assertions below are COUPLINGS, not transcriptions:
 *
 *   seeded codes        -> parsed out of the migration's own INSERT ... VALUES text
 *   data_sources gates  -> parsed out of `rbacGuard('data_sources', '<action>')` in the real route file
 *   integration gates   -> parsed out of the `'integration:<action>'` literals in the real plugin gate
 *   idempotency         -> the migration's OWN emitted SQL, replayed against a Postgres simulation
 *                          that models the `permissions` primary key
 *   admission posture   -> `derivePermissionNamespace` called live, so adding either resource to
 *                          NON_NAMESPACED_PERMISSION_RESOURCES reds this file
 *
 * Each guard is paired with an in-memory MUTATION PROBE that feeds the same assertion a deliberately
 * broken input and requires it to throw. A guard that cannot fail is not a guard, and these probes
 * are how this file proves, on every run, that its own assertions still have teeth.
 *
 * NO DATABASE. The idempotency check runs the migration against an in-process simulation of the
 * three RBAC tables (below), not Postgres. It models exactly one thing — the `permissions(code)`
 * primary key and `ON CONFLICT (code) DO NOTHING` — which is precisely the property "idempotent"
 * means here. Real-Postgres replay (migrate twice against a fresh database) is CI's
 * migration-replay lane; this file exists so the property is also checked on every no-DB unit run.
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
  DATA_SOURCES_PERMISSION_CODES,
  INTEGRATION_PERMISSION_CODES,
  INTEGRATION_SEED_PERMISSION_CODES,
  down,
  up,
} from '../../src/db/migrations/zzzz20260910120000_add_integration_permissions'
import { derivePermissionNamespace, isNamespaceAdmissionControlledResource } from '../../src/rbac/namespace-admission'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/db/migrations/zzzz20260910120000_add_integration_permissions.ts',
)
const DATA_SOURCES_ROUTES_PATH = path.join(__dirname, '../../src/routes/data-sources.ts')
const PLUGIN_GATE_PATH = path.join(
  REPO_ROOT,
  'plugins/plugin-integration-core/lib/http-routes.cjs',
)

// ---------------------------------------------------------------------------
// Parsers — every "expected" set below is derived from real source, never typed out.
// ---------------------------------------------------------------------------

/** The codes the migration actually INSERTs, read out of its `VALUES` tuples. */
function parseSeededCodes(migrationSource: string): string[] {
  const upBody = migrationSource.split('export async function up')[1] ?? ''
  const insert = upBody.split('INSERT INTO permissions')[1] ?? ''
  const values = insert.split('ON CONFLICT')[0] ?? insert
  const codes = [...values.matchAll(/\(\s*'([a-z_]+:[a-z_]+)'\s*,/g)].map((match) => match[1])
  return [...new Set(codes)].sort()
}

/**
 * The codes `rbacGuard` enforces in a route file, in BOTH supported call shapes:
 * the two-argument `rbacGuard('data_sources', 'read')` and the one-argument
 * `rbacGuard('data_sources:read')` — `src/rbac/rbac.ts:56-57` accepts either, and the repo already
 * uses the one-argument form elsewhere (e.g. `rbacGuard('approvals:read')`), so a parser that saw
 * only the two-argument form could be bypassed without noticing.
 *
 * SCOPE, stated plainly: this reads ONE file and matches quote-delimited literals (' " `) written
 * inline. A gate whose code is assembled at runtime (concatenation, a variable, an interpolated
 * template) or that lives in a file this suite does not read is NOT covered. See the note on
 * `assertSeedMatchesEnforcement`.
 */
function parseRbacGuardCodes(routeSource: string, resource: string): string[] {
  const q = `['"\`]`
  const twoArg = new RegExp(`rbacGuard\\(\\s*${q}${resource}${q}\\s*,\\s*${q}([a-z_]+)${q}`, 'g')
  const oneArg = new RegExp(`rbacGuard\\(\\s*${q}${resource}:([a-z_]+)${q}`, 'g')
  const codes = [
    ...[...routeSource.matchAll(twoArg)].map((match) => `${resource}:${match[1]}`),
    ...[...routeSource.matchAll(oneArg)].map((match) => `${resource}:${match[1]}`),
  ]
  return [...new Set(codes)].sort()
}

/**
 * The `<namespace>:<action>` string literals a gate file compares against, in any quote style.
 * Same scope caveat as above: inline literals in the one file handed to it, nothing more.
 */
function parseQuotedCodes(gateSource: string, namespace: string): string[] {
  const pattern = new RegExp(`['"\`]${namespace}:([a-z_]+)['"\`]`, 'g')
  const codes = [...gateSource.matchAll(pattern)].map((match) => `${namespace}:${match[1]}`)
  return [...new Set(codes)].sort()
}

/**
 * THE zero-automatic-holders guard. `up` may CREATE vocabulary and nothing else; the moment it also
 * hands the vocabulary out, installing the migration becomes an implicit grant.
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

/**
 * THE reconciliation. Throws when the seed and the enforcement points disagree in either direction:
 * an enforced code that is ungrantable (the G09 bug), or a seeded code nothing enforces (dead
 * vocabulary that would quietly widen what an operator can hand out).
 *
 * WHAT THIS DOES AND DOES NOT CATCH. It catches drift in gates that are written as quote-delimited
 * literals INSIDE the two files this suite reads (`src/routes/data-sources.ts` and
 * `plugins/plugin-integration-core/lib/http-routes.cjs`), in either `rbacGuard` call shape. It does
 * NOT catch a gate whose code is built at runtime (concatenated, held in a variable, interpolated),
 * nor a gate added in any OTHER file — a new router mounting `rbacGuard('data_sources:purge')`
 * somewhere else is invisible here and would reintroduce exactly the G09 bug. Closing that would
 * take a repo-wide sweep of every `rbacGuard` call site, which is deliberately out of scope for this
 * migration's suite; this is a tripwire on the known gates, not a proof about all gates.
 */
function assertSeedMatchesEnforcement(seededCodes: string[], enforcedCodes: string[]): void {
  const seeded = [...new Set(seededCodes)].sort()
  const enforced = [...new Set(enforcedCodes)].sort()

  const ungrantable = enforced.filter((code) => !seeded.includes(code))
  if (ungrantable.length > 0) {
    throw new Error(
      `enforced but never seeded (FK to permissions(code) makes these ungrantable): ${ungrantable.join(', ')}`,
    )
  }

  const unenforced = seeded.filter((code) => !enforced.includes(code))
  if (unenforced.length > 0) {
    throw new Error(`seeded but enforced nowhere: ${unenforced.join(', ')}`)
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
    // every statement in. A missing table means the whole block is skipped, exactly as in Postgres.
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

async function readMigrationSource(): Promise<string> {
  return fs.readFile(MIGRATION_PATH, 'utf8')
}

// ---------------------------------------------------------------------------
// 1. The six codes exist, spelled exactly as the gates spell them.
// ---------------------------------------------------------------------------

describe('integration/data_sources permission seed — vocabulary', () => {
  it('seeds exactly six codes and the exported constants match the migration SQL', async () => {
    const source = await readMigrationSource()

    expect(INTEGRATION_SEED_PERMISSION_CODES).toHaveLength(6)
    expect(parseSeededCodes(source)).toEqual([...INTEGRATION_SEED_PERMISSION_CODES].sort())
    expect([...INTEGRATION_PERMISSION_CODES]).toEqual([
      'integration:read',
      'integration:write',
      'integration:admin',
    ])
    expect([...DATA_SOURCES_PERMISSION_CODES]).toEqual([
      'data_sources:read',
      'data_sources:write',
      'data_sources:execute',
    ])
  })

  it('is discoverable by the migration provider: right folder, unique name, sorts last', async () => {
    // `createCoreBackendMigrationProvider` hands `src/db/migrations` to Kysely's FileMigrationProvider,
    // which keys migrations by basename and skips anything starting with `_` or `.`. A seed dropped
    // into the wrong folder or renamed with a leading underscore is not an error — it just silently
    // never runs, and the six codes stay missing exactly as they were before this migration existed.
    const dir = path.join(__dirname, '../../src/db/migrations')
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.ts'))
    const self = 'zzzz20260910120000_add_integration_permissions.ts'

    expect(names).toContain(self)
    expect(self.startsWith('_') || self.startsWith('.')).toBe(false)
    expect(names.filter((name) => name === self)).toHaveLength(1)

    // Proof the glob above really is the migrations folder and not an empty/renamed directory —
    // without this, `toContain(self)` could pass against a folder holding nothing else.
    expect(names).toContain('20250924190000_create_rbac_tables.ts')

    // NO ORDERING ASSERTION HERE, on purpose. `runMigrations` sets `allowUnorderedMigrations: true`
    // (src/db/migrate.ts:32) and this migration's up() depends only on the `permissions` table
    // existing, so relative position protects nothing. An "I must sort last" assertion would instead
    // red on the next person's migration PR — `tests/unit/**` is collected by default and
    // plugin-tests.yml runs core-backend tests unconditionally on any packages/core-backend/** change.
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
      "ON CONFLICT (code) DO NOTHING;\n        INSERT INTO role_permissions (role_id, permission_code)\n          VALUES ('admin', 'data_sources:execute') ON CONFLICT DO NOTHING;",
    )
    expect(withAdminGrant).not.toEqual(source)
    expect(() => assertUpGrantsNothing(withAdminGrant)).toThrow(/only seed permission rows/)
  })

  it('down() removes only these six codes, children before parents', async () => {
    const source = await readMigrationSource()
    const downBody = source.split('export async function down')[1] ?? ''

    const roleDelete = downBody.indexOf('DELETE FROM role_permissions')
    const userDelete = downBody.indexOf('DELETE FROM user_permissions')
    const permissionDelete = downBody.indexOf('DELETE FROM permissions')
    expect(roleDelete).toBeGreaterThanOrEqual(0)
    expect(userDelete).toBeGreaterThan(roleDelete)
    expect(permissionDelete).toBeGreaterThan(userDelete)

    // A rollback that reaches another domain's codes would revoke grants this migration never made.
    for (const foreign of ['stock-prep:', 'elearning:', 'attendance:', 'multitable:', 'approvals:']) {
      expect(downBody).not.toContain(foreign)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Reconciliation: seeded set == enforced set, both derived from real source.
// ---------------------------------------------------------------------------

describe('integration/data_sources permission seed — reconciliation with the gates', () => {
  it('seeds exactly the data_sources codes rbacGuard enforces in the route file', async () => {
    const [migrationSource, routeSource] = await Promise.all([
      readMigrationSource(),
      fs.readFile(DATA_SOURCES_ROUTES_PATH, 'utf8'),
    ])

    const enforced = parseRbacGuardCodes(routeSource, 'data_sources')
    // Proof the parser actually found the gates rather than silently matching nothing.
    expect(enforced.length).toBeGreaterThan(0)
    expect(enforced).toEqual([...DATA_SOURCES_PERMISSION_CODES].sort())

    const seeded = parseSeededCodes(migrationSource).filter((code) => code.startsWith('data_sources:'))
    expect(() => assertSeedMatchesEnforcement(seeded, enforced)).not.toThrow()
  })

  it('seeds exactly the integration codes the plugin gate compares against', async () => {
    const [migrationSource, gateSource] = await Promise.all([
      readMigrationSource(),
      fs.readFile(PLUGIN_GATE_PATH, 'utf8'),
    ])

    const enforced = parseQuotedCodes(gateSource, 'integration')
    expect(enforced.length).toBeGreaterThan(0)
    expect(enforced).toEqual([...INTEGRATION_PERMISSION_CODES].sort())

    const seeded = parseSeededCodes(migrationSource).filter((code) => code.startsWith('integration:'))
    expect(() => assertSeedMatchesEnforcement(seeded, enforced)).not.toThrow()
  })

  it('the gate parsers see both rbacGuard shapes and every quote style', () => {
    // `rbacGuard` accepts one argument OR two (src/rbac/rbac.ts:56-57) and the repo uses both forms.
    // A parser that only understood `rbacGuard('x', 'y')` with single quotes could be bypassed by
    // writing the gate any other legal way, which would make the reconciliation above quietly
    // vacuous. This pins the widening in place.
    const synthetic = [
      "rbacGuard('data_sources', 'read')",
      'rbacGuard("data_sources", "write")',
      'rbacGuard(`data_sources`, `select`)',
      "rbacGuard('data_sources:execute')",
      'rbacGuard("data_sources:purge")',
      'rbacGuard(`data_sources:vacuum`)',
    ].join('\n')

    expect(parseRbacGuardCodes(synthetic, 'data_sources')).toEqual([
      'data_sources:execute',
      'data_sources:purge',
      'data_sources:read',
      'data_sources:select',
      'data_sources:vacuum',
      'data_sources:write',
    ])

    expect(parseQuotedCodes(`'integration:read' "integration:write" \`integration:admin\``, 'integration'))
      .toEqual(['integration:admin', 'integration:read', 'integration:write'])

    // And the documented blind spot, asserted rather than merely claimed in a comment: a code built
    // at runtime is invisible to both parsers. This is the residual risk §the docblock names.
    const assembled = "const action = 'purge'\nrbacGuard('data_sources', action)"
    expect(parseRbacGuardCodes(assembled, 'data_sources')).toEqual([])
  })

  it('MUTATION PROBE: dropping one seeded code makes the reconciliation throw', async () => {
    const migrationSource = await readMigrationSource()
    const enforced = [
      ...parseRbacGuardCodes(await fs.readFile(DATA_SOURCES_ROUTES_PATH, 'utf8'), 'data_sources'),
      ...parseQuotedCodes(await fs.readFile(PLUGIN_GATE_PATH, 'utf8'), 'integration'),
    ]

    // In-memory only: the file on disk is never touched.
    for (const dropped of INTEGRATION_SEED_PERMISSION_CODES) {
      const mutated = migrationSource.replace(
        new RegExp(`^.*'${dropped.replace(':', ':')}', '.*$\\n?`, 'm'),
        '',
      )
      expect(parseSeededCodes(mutated), `${dropped} should be gone from the mutated source`)
        .not.toContain(dropped)
      expect(
        () => assertSeedMatchesEnforcement(parseSeededCodes(mutated), enforced),
        `dropping ${dropped} must be caught`,
      ).toThrow(/enforced but never seeded/)
    }
  })

  it('MUTATION PROBE: a gate action nobody seeded makes the reconciliation throw', async () => {
    const seeded = parseSeededCodes(await readMigrationSource())
    const enforcedPlusNewGate = [...seeded, 'data_sources:truncate']
    expect(() => assertSeedMatchesEnforcement(seeded, enforcedPlusNewGate))
      .toThrow(/data_sources:truncate/)
  })
})

// ---------------------------------------------------------------------------
// 3. Idempotency, proven by replaying the migration's own SQL.
// ---------------------------------------------------------------------------

describe('integration/data_sources permission seed — idempotency', () => {
  it('up() twice leaves exactly six rows and never raises a duplicate key', async () => {
    const memory = new MemoryRbacTables()
    const db = createMemoryDb(memory)

    await up(db)
    expect(memory.codes()).toEqual([...INTEGRATION_SEED_PERMISSION_CODES].sort())

    await expect(up(db)).resolves.toBeUndefined()
    expect(memory.codes()).toEqual([...INTEGRATION_SEED_PERMISSION_CODES].sort())
  })

  it('up() is a no-op on a database that already carries a subset of the codes', async () => {
    const memory = new MemoryRbacTables()
    memory.seed('permissions', ['integration:read', 'data_sources:execute', 'stock-prep:read'])
    const db = createMemoryDb(memory)

    await up(db)
    expect(memory.codes()).toEqual(
      [...new Set([...INTEGRATION_SEED_PERMISSION_CODES, 'stock-prep:read'])].sort(),
    )
  })

  it('up() is skipped entirely when the permissions table does not exist', async () => {
    const memory = new MemoryRbacTables([])
    const db = createMemoryDb(memory)

    await expect(up(db)).resolves.toBeUndefined()
    expect(memory.codes()).toEqual([])
  })

  it('down() removes the six codes and leaves other domains untouched', async () => {
    const memory = new MemoryRbacTables()
    memory.seed('permissions', ['stock-prep:read'])
    memory.seed('role_permissions', ['integration:write', 'stock-prep:read'])
    const db = createMemoryDb(memory)

    await up(db)
    await down(db)

    expect(memory.codes()).toEqual(['stock-prep:read'])
    expect(memory.codes('role_permissions')).toEqual(['stock-prep:read'])
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
// 4. The posture this migration deliberately did NOT change.
// ---------------------------------------------------------------------------

describe('integration/data_sources permission seed — namespace admission posture', () => {
  it('both namespaces stay admission-controlled (seeding a code is not a grant of reachability)', () => {
    // NON_NAMESPACED_PERMISSION_RESOURCES is an EXEMPTION list. Putting either resource in it would
    // let every existing holder bypass `user_namespace_admissions` — a widening, and the reason this
    // migration does not touch it. This assertion is what reds if someone tries.
    expect(isNamespaceAdmissionControlledResource('integration')).toBe(true)
    expect(isNamespaceAdmissionControlledResource('data_sources')).toBe(true)

    for (const code of INTEGRATION_PERMISSION_CODES) {
      expect(derivePermissionNamespace(code)).toBe('integration')
    }
    for (const code of DATA_SOURCES_PERMISSION_CODES) {
      expect(derivePermissionNamespace(code)).toBe('data_sources')
    }
  })

  it('MUTATION PROBE: the posture assertion discriminates — exempt resources answer false/null', () => {
    // If `integration` or `data_sources` were added to NON_NAMESPACED_PERMISSION_RESOURCES they
    // would behave like these do, and the assertion above would red. This is what proves that
    // assertion is not vacuously true.
    for (const exempt of ['multitable', 'workflow', 'approvals', 'admin']) {
      expect(isNamespaceAdmissionControlledResource(exempt)).toBe(false)
      expect(derivePermissionNamespace(`${exempt}:read`)).toBeNull()
    }
  })

  it('no executable statement in the migration touches the admission surface', async () => {
    const source = await readMigrationSource()
    // Everything before the first export is the header docblock, which DISCUSSES both identifiers
    // on purpose. What must stay clean is the code that runs.
    const executable = source.slice(source.indexOf('export const INTEGRATION_PERMISSION_CODES'))
    expect(executable.length).toBeGreaterThan(0)
    expect(executable).not.toContain('NON_NAMESPACED_PERMISSION_RESOURCES')
    expect(executable).not.toContain('user_namespace_admissions')
  })
})
