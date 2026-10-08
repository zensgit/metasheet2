/**
 * #6185 — every permission code an access preset grants must exist in the `permissions` catalogue.
 *
 * Applying a preset writes its codes to `user_permissions` (POST /api/admin/users with `presetId`,
 * POST /api/admin/permission-templates/apply), and `user_permissions.permission_code` is a foreign key
 * to `permissions(code)`. `platform-editor`, `platform-viewer` and `plm-collaborator` listed
 * `workflow:read`, which no migration registers, so creating a user with any of them failed on that
 * foreign key and the user was not created.
 *
 * The catalogue here is not a list written down in this file. It is what the migrations themselves
 * insert: every migration under src/db/migrations whose source writes to `permissions` has its REAL
 * `up()` executed against a Kysely instance whose driver records each compiled statement, and the
 * `code` column of every recorded `INSERT INTO permissions (...) VALUES (...)` is read back (literal
 * or bound parameter). `checkTableExists` is answered "exists" so the guarded inserts run, as they do
 * on a fresh install where 20250924190000_create_rbac_tables created the table.
 *
 * Fail-closed rules, so the reader cannot quietly widen the catalogue:
 *   - an `up()` that DELETEs from `permissions`, or UPDATEs its `code` column, stops the test (the
 *     reader would otherwise count a code that a later migration removes);
 *   - an `INSERT INTO permissions` the reader cannot parse (no `code` column, no VALUES list, a value
 *     that is neither a literal nor a bound parameter) stops the test;
 *   - a migration whose `up()` source contains an insert into `permissions` but yields no code stops
 *     the test.
 * A migration this reader misses can only make the catalogue smaller, which turns this test red, not
 * green.
 *
 * Runtime self-registration (PluginRbacProvisioningService, attendance-admin role templates) and the
 * dev seed (scripts/seed-rbac.ts) are not counted: a preset must work on a fresh install whatever
 * plugins are enabled.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
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
import { listAccessPresets } from '../../src/auth/access-presets'
import { listPermissionTemplates } from '../../src/auth/permission-templates'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')

/** Any statement shape that writes the `permissions` table (not role_permissions / user_permissions). */
const WRITES_PERMISSIONS_SOURCE =
  /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:public\.)?"?permissions"?(?![\w"])/i
const INSERT_INTO_PERMISSIONS = /\bINSERT\s+INTO\s+(?:public\.)?"?permissions"?(?![\w"])/gi
const INSERT_WITH_VALUES =
  /\bINSERT\s+INTO\s+(?:public\.)?"?permissions"?(?![\w"])\s*\(([^)]*)\)\s*VALUES\s*/gi
const DELETE_FROM_PERMISSIONS = /\bDELETE\s+FROM\s+(?:public\.)?"?permissions"?(?![\w"])/i
const UPDATE_PERMISSIONS_SET =
  /\bUPDATE\s+(?:public\.)?"?permissions"?(?![\w"])\s+SET\s+([\s\S]*?)(?:\bWHERE\b|;|$)/gi

interface RecordedStatement {
  sql: string
  parameters: readonly unknown[]
}

function createRecordingDb(statements: RecordedStatement[]): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push({ sql: compiled.sql, parameters: compiled.parameters })
      if (/\binformation_schema\.tables\b/i.test(compiled.sql)) {
        return { rows: [{ count: 1, exists: true }] as unknown as R[] }
      }
      return { rows: [] }
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

/** Splits `a, 'b, c', (d, e)` at top-level commas; quotes and nested parentheses are respected. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inQuote) {
      current += char
      if (char === "'") {
        if (text[index + 1] === "'") {
          current += "'"
          index += 1
        } else {
          inQuote = false
        }
      }
      continue
    }
    if (char === "'") inQuote = true
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (inQuote || depth !== 0) throw new Error(`PERMISSION_CATALOGUE_UNBALANCED_TUPLE: ${text}`)
  parts.push(current.trim())
  return parts
}

/** Reads the parenthesised tuples that follow `VALUES`, starting at `start`. */
function readValueTuples(sqlText: string, start: number): string[] {
  const tuples: string[] = []
  let index = start
  for (;;) {
    while (index < sqlText.length && /\s/.test(sqlText[index])) index += 1
    if (sqlText[index] !== '(') break
    let depth = 0
    let inQuote = false
    const open = index
    for (; index < sqlText.length; index += 1) {
      const char = sqlText[index]
      if (inQuote) {
        if (char === "'") {
          if (sqlText[index + 1] === "'") index += 1
          else inQuote = false
        }
        continue
      }
      if (char === "'") inQuote = true
      else if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) throw new Error('PERMISSION_CATALOGUE_UNTERMINATED_TUPLE')
    tuples.push(sqlText.slice(open + 1, index))
    index += 1
    while (index < sqlText.length && /\s/.test(sqlText[index])) index += 1
    if (sqlText[index] !== ',') break
    index += 1
  }
  if (tuples.length === 0) throw new Error('PERMISSION_CATALOGUE_NO_VALUES_TUPLE')
  return tuples
}

function resolveValue(expression: string, parameters: readonly unknown[]): string {
  const parameter = expression.match(/^\$(\d+)$/)
  if (parameter) {
    const value = parameters[Number(parameter[1]) - 1]
    if (typeof value !== 'string') throw new Error(`PERMISSION_CATALOGUE_NON_STRING_PARAMETER: ${expression}`)
    return value
  }
  const literal = expression.match(/^'((?:[^']|'')*)'$/)
  if (literal) return literal[1].replace(/''/g, "'")
  throw new Error(`PERMISSION_CATALOGUE_UNRECOGNISED_VALUE: ${expression}`)
}

/** The `code` values one recorded statement inserts into `permissions`. */
function readInsertedCodes(statement: RecordedStatement): string[] {
  const { sql: sqlText, parameters } = statement
  if (DELETE_FROM_PERMISSIONS.test(sqlText)) {
    throw new Error('PERMISSION_CATALOGUE_DELETE_IN_UP: teach this guard about removals before relying on it')
  }
  for (const update of sqlText.matchAll(UPDATE_PERMISSIONS_SET)) {
    if (/(?:^|[\s,])"?code"?\s*=/i.test(update[1])) {
      throw new Error('PERMISSION_CATALOGUE_CODE_UPDATE_IN_UP: teach this guard about renames before relying on it')
    }
  }
  const insertCount = [...sqlText.matchAll(INSERT_INTO_PERMISSIONS)].length
  const codes: string[] = []
  let parsedInserts = 0
  for (const insert of sqlText.matchAll(INSERT_WITH_VALUES)) {
    parsedInserts += 1
    const columns = insert[1].split(',').map((column) => column.trim().replace(/"/g, '').toLowerCase())
    const codeIndex = columns.indexOf('code')
    if (codeIndex < 0) throw new Error(`PERMISSION_CATALOGUE_NO_CODE_COLUMN: (${insert[1]})`)
    for (const tuple of readValueTuples(sqlText, (insert.index ?? 0) + insert[0].length)) {
      const values = splitTopLevel(tuple)
      if (values.length !== columns.length) {
        throw new Error(`PERMISSION_CATALOGUE_ARITY_MISMATCH: ${columns.length} columns, ${values.length} values`)
      }
      codes.push(resolveValue(values[codeIndex], parameters))
    }
  }
  if (parsedInserts !== insertCount) {
    throw new Error('PERMISSION_CATALOGUE_UNPARSED_INSERT: an INSERT INTO permissions without a column list + VALUES')
  }
  return codes
}

async function readMigrationPermissionCatalogue(): Promise<{
  codes: Set<string>
  perMigration: Map<string, string[]>
}> {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.ts') && !name.startsWith('_') && !name.endsWith('.d.ts'))
    .sort()
  const codes = new Set<string>()
  const perMigration = new Map<string, string[]>()
  for (const name of files) {
    const filePath = path.join(MIGRATIONS_DIR, name)
    const source = await fs.readFile(filePath, 'utf8')
    if (!WRITES_PERMISSIONS_SOURCE.test(source)) continue
    const migration = (await import(filePath.replace(/\\/g, '/'))) as { up?: (db: Kysely<unknown>) => Promise<void> }
    if (typeof migration.up !== 'function') throw new Error(`PERMISSION_CATALOGUE_NO_UP: ${name}`)
    const statements: RecordedStatement[] = []
    await migration.up(createRecordingDb(statements))
    const inserted = statements.flatMap(readInsertedCodes)
    const upSource = source.split(/export\s+async\s+function\s+down\b/)[0] ?? source
    if (new RegExp(INSERT_INTO_PERMISSIONS.source, 'i').test(upSource) && inserted.length === 0) {
      throw new Error(`PERMISSION_CATALOGUE_UP_INSERTED_NOTHING: ${name}`)
    }
    perMigration.set(name, inserted)
    for (const code of inserted) codes.add(code)
  }
  return { codes, perMigration }
}

/** `<grant source>:<code>` for every granted code the catalogue does not contain. */
function findUnregisteredCodes(
  grants: Array<{ id: string; permissions: string[] }>,
  catalogue: ReadonlySet<string>,
): string[] {
  return grants.flatMap((grant) =>
    grant.permissions.filter((code) => !catalogue.has(code)).map((code) => `${grant.id} -> ${code}`),
  )
}

describe('access presets only grant registered permission codes (#6185)', () => {
  it('the catalogue is read from the migrations that write `permissions`, each contributing codes', async () => {
    const { codes, perMigration } = await readMigrationPermissionCatalogue()
    expect(perMigration.size).toBeGreaterThan(0)
    expect(codes.size).toBeGreaterThan(0)
    // Includes the table-creating migration itself, so the reader saw the plain-literal form too.
    expect([...perMigration.keys()]).toContain('20250924190000_create_rbac_tables.ts')
  })

  it('every access preset code is inserted into `permissions` by a migration', async () => {
    const { codes } = await readMigrationPermissionCatalogue()
    const presets = listAccessPresets()
    expect(presets.length).toBeGreaterThan(0)
    expect(findUnregisteredCodes(presets, codes)).toEqual([])
  })

  it('every permission template code (the presets as applied by /api/admin/permission-templates/apply) is registered', async () => {
    const { codes } = await readMigrationPermissionCatalogue()
    const templates = listPermissionTemplates()
    expect(templates.length).toBeGreaterThan(0)
    expect(findUnregisteredCodes(templates, codes)).toEqual([])
  })

  it('NEGATIVE CONTROL — a preset carrying a code no migration inserts is reported', async () => {
    const { codes } = await readMigrationPermissionCatalogue()
    const probe = [{ id: 'probe-preset', permissions: ['multitable:read', 'never-registered-6185:probe'] }]
    expect(findUnregisteredCodes(probe, codes)).toEqual(['probe-preset -> never-registered-6185:probe'])
  })

  it('NEGATIVE CONTROL — the reader refuses statements it cannot account for', () => {
    expect(() => readInsertedCodes({ sql: 'DELETE FROM permissions WHERE code = $1', parameters: ['x:y'] }))
      .toThrow('PERMISSION_CATALOGUE_DELETE_IN_UP')
    expect(() => readInsertedCodes({ sql: "UPDATE permissions SET code = 'x:z' WHERE code = 'x:y'", parameters: [] }))
      .toThrow('PERMISSION_CATALOGUE_CODE_UPDATE_IN_UP')
    expect(() => readInsertedCodes({ sql: 'INSERT INTO permissions SELECT * FROM staged', parameters: [] }))
      .toThrow('PERMISSION_CATALOGUE_UNPARSED_INSERT')
    expect(() => readInsertedCodes({ sql: 'INSERT INTO permissions (code, name) VALUES (lower($1), $2)', parameters: ['X:Y', 'n'] }))
      .toThrow('PERMISSION_CATALOGUE_UNRECOGNISED_VALUE')
    // A description edit keyed by code is not a code change.
    expect(readInsertedCodes({ sql: "UPDATE permissions SET description = 'd' WHERE code = 'x:y'", parameters: [] }))
      .toEqual([])
    // Only the `code` column is read, wherever it sits; quoted commas do not split a value.
    expect(readInsertedCodes({
      sql: "INSERT INTO permissions (name, code, description) VALUES ('A, b', 'a:b', 'c (d, e)'), ($1, $2, $3)",
      parameters: ['N', 'c:d', 'D'],
    })).toEqual(['a:b', 'c:d'])
    // role_permissions / user_permissions inserts are not catalogue rows.
    expect(readInsertedCodes({
      sql: "INSERT INTO role_permissions (role_id, permission_code) VALUES ('admin', 'q:r')",
      parameters: [],
    })).toEqual([])
  })
})
