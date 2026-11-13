/**
 * The judgment of migration statements that touch the privilege-classifier inputs, case by case.
 *
 * Every case is a virtual migration checked by the same function as the real traversal, and pins
 * the kind of each verdict (`raising` or `unreadable`), not only that the migration is refused.
 * Green controls pin that the rules leave the repository's usual forms acceptable. Unless a case
 * says otherwise the file is a new migration and carries the compliant lock block.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE,
  AUTHORIZATION_INPUT_MIGRATION_HELPERS,
  AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_PARENT_KEY_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_SENSITIVE_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES,
} from '../../src/rbac/authorization-input-writers'
import type { AuthorizationInputDynamicExemption } from '../../src/rbac/authorization-input-writers'
import { helperMapProblems, judgeInputWrite, judgeMigrationInputWrites, splitStatements } from '../helpers/authorization-input-migration-judge'
import {
  checkNewMigration,
  closureProblems,
  COMPLIANT_LOCK_BLOCK,
  digestOfFiles,
  historicalMigrationFiles,
  isNewMigration,
} from '../helpers/authorization-input-migration-rules'
import { blankSqlComments, CASCADE_PARENT_TABLES, INPUT_TABLES } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MIG = 'packages/core-backend/src/db/migrations'
const NEW_TS = `${MIG}/zzzz20270101000000_case.ts`
const NEW_SQL = 'packages/core-backend/migrations/999_case.sql'

const up = (...lines: string[]) => `import { sql } from 'kysely'\nexport async function up(db) {\n${lines.join('\n')}\n}`
/** One statement issued as a plain string literal. */
const q = (statement: string) => `await db.query(${JSON.stringify(statement)})`
const LOCK = q(COMPLIANT_LOCK_BLOCK)
const locked = (...statements: string[]) => up(LOCK, ...statements.map(q))
const unlocked = (...statements: string[]) => up(...statements.map(q))
/** A source with the lock block and raw lines of TypeScript. */
const lockedCode = (...lines: string[]) => up(LOCK, ...lines)

const check = (source: string, file = NEW_TS, isNew = true) => checkNewMigration(file, source, isNew)
const verdicts = (source: string, file = NEW_TS, isNew = true) => check(source, file, isNew).verdicts.map((line) => line.verdict)
const INSERT_RP = 'INSERT INTO role_permissions (role_id, permission_code)'

describe('rule tables', () => {
  it('every input table has a table rule and a sensitive-column entry; judged columns and parent keys name known tables', () => {
    expect(Object.keys(AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES).sort()).toEqual([...INPUT_TABLES].sort())
    expect(Object.keys(AUTHORIZATION_INPUT_MIGRATION_SENSITIVE_COLUMNS).sort()).toEqual([...INPUT_TABLES].sort())
    for (const table of Object.keys(AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS)) expect(INPUT_TABLES).toContain(table)
    expect(Object.keys(AUTHORIZATION_INPUT_MIGRATION_PARENT_KEY_COLUMNS).sort()).toEqual([...CASCADE_PARENT_TABLES].sort())
    // Every table judged by column has a judged column, and the three tables that can carry a code or a role are judged by column.
    const byColumn = Object.entries(AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES).filter(([, rules]) => Object.values(rules).includes('by_column')).map(([table]) => table).sort()
    expect(byColumn).toEqual(['role_permissions', 'user_permissions', 'users'])
    expect(Object.keys(AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS).sort()).toEqual(byColumn)
    expect(AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS.users).toEqual({ role: 'role_id', is_admin: 'false_only', permissions: 'permission_array', id: 'never_in_set' })
    expect(AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS.role_permissions).toEqual({ permission_code: 'permission_code', role_id: 'never_in_set' })
    expect(AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS.user_permissions).toEqual({ permission_code: 'permission_code', user_id: 'never_in_set' })
    // Memberships are not written by a migration, whichever the verb.
    expect(AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES.user_roles).toEqual({ INSERT: 'forbidden', UPDATE: 'forbidden', DELETE: 'forbidden', TRUNCATE: 'forbidden', MERGE: 'forbidden', COPY: 'forbidden' })
  })

  it('a table and verb without a rule is unreadable', () => {
    expect(judgeInputWrite('users', 'VACUUM', [])).toMatchObject({ verdict: 'unreadable' })
    expect(judgeInputWrite('role_permissions', 'MERGE', [])).toMatchObject({ verdict: 'unreadable' })
    expect(judgeInputWrite('not_an_input', 'INSERT', [])).toMatchObject({ verdict: 'unreadable' })
    expect(judgeInputWrite('user_namespace_admissions', 'INSERT', [])).toMatchObject({ verdict: 'safe' })
  })
})

describe('historical migration files', () => {
  const HISTORICAL_COUNT = 477
  const HISTORICAL_DIGEST = 'ef6d3b1329e1e128ff88a85fc2d07b37d627d13cee2c6431b828b00c4590618e'

  it('the set of historical migration files is pinned by count and digest', () => {
    const historical = historicalMigrationFiles()
    expect(historical).toHaveLength(HISTORICAL_COUNT)
    expect(digestOfFiles(historical)).toBe(HISTORICAL_DIGEST)
    expect([...historical].sort()).toEqual([...historical])
    expect(new Set(historical).size).toBe(historical.length)
    // The set only names files of the two migration streams; a migration added later is outside it.
    for (const file of historical) expect(file.startsWith(`${MIG}/`) || file.startsWith('packages/core-backend/migrations/'), file).toBe(true)
    expect(fs.existsSync(path.join(REPO_ROOT, historical[0]))).toBe(true)
  })

  it('the statement-kind rules apply to a file outside the set, whatever its timestamp, and not to a file inside it', () => {
    const body = unlocked("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'admin'")
    const historical = historicalMigrationFiles().find((file) => file.endsWith('.ts'))!
    expect(isNewMigration(historical)).toBe(false)
    expect(checkNewMigration(historical, body).problems).toEqual([])
    const backdated = `${MIG}/zzzz20200101000000_backdated.ts`
    expect(isNewMigration(backdated)).toBe(true)
    expect(checkNewMigration(backdated, body).verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
    expect(isNewMigration(NEW_TS)).toBe(true)
    expect(digestOfFiles([...historicalMigrationFiles(), NEW_TS])).not.toBe(HISTORICAL_DIGEST)
  })
})

describe('writes judged by table, form and operand', () => {
  const raising: Array<[string, string, string]> = [
    ['a raising code in a VALUES tuple', locked(`${INSERT_RP} VALUES ('viewer', 'users:write')`), 'grants class-raising code users:write'],
    ['a raising code folded into the catalogue form', lockedCode("const ROLE_ID = 'viewer'", "const PERMISSION_CODE = 'users:write'", 'await sql`' + INSERT_RP + ' SELECT ${ROLE_ID}, p.code FROM permissions p WHERE p.code = ${PERMISSION_CODE} ON CONFLICT DO NOTHING`.execute(db)'), 'grants class-raising code users:write'],
    ['a raising code in the last of thirty-one tuples', locked(`${INSERT_RP} VALUES ${Array.from({ length: 30 }, (_, i) => `('viewer', 'docs:read${i}')`).join(', ')}, ('viewer', 'users:write')`), 'grants class-raising code users:write'],
    ['a raising role folded into an UPDATE', lockedCode("const ADMIN_ROLE = 'admin'", 'await sql`UPDATE users SET role = ${ADMIN_ROLE} WHERE id = ${1}`.execute(db)'), 'assigns class-raising role admin'],
    ['a raising direct grant', locked("INSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'users:write')"), 'grants class-raising code users:write'],
    ['a delegated administration scope', locked("INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace) VALUES ('u', 'crm')"), 'writes delegated_role_admin_scopes'],
    ['a delegated member-group scope update', locked("UPDATE delegated_role_admin_member_groups SET group_id = 'g'"), 'writes delegated_role_admin_member_groups'],
    ['the folded code is reported, not the role id', lockedCode("const CODE = 'docs:admin'", 'await sql`' + INSERT_RP + " SELECT 'admin', p.code FROM permissions p WHERE p.code = ${CODE}`.execute(db)"), 'grants class-raising code docs:admin'],
    ['an admin-level code for an ordinary role', locked(`${INSERT_RP} VALUES ('editor', 'docs:admin')`), 'grants class-raising code docs:admin'],
    ['a raising code in the legacy code array', locked(`UPDATE users SET permissions = '["users:write"]'::jsonb`), 'grants class-raising code users:write'],
    ['a raising code array at birth', locked(`INSERT INTO users (id, email, role, is_admin, permissions) VALUES ('u1', 'a@b', 'user', FALSE, '["users:write"]')`), 'grants class-raising code users:write'],
    ['a raising role at birth', locked("INSERT INTO users (id, email, role, is_admin, permissions) VALUES ('u1', 'a@b', 'admin', FALSE, '[]')"), 'assigns class-raising role admin'],
    ['is_admin set to true', locked("UPDATE users SET is_admin = TRUE WHERE id = 'u'"), 'sets is_admin'],
    ['a raising code moved in by UPDATE', locked("UPDATE role_permissions SET permission_code = 'users:write' WHERE role_id = 'viewer'"), 'grants class-raising code users:write'],
    ['a write inside a block body is judged past the semicolons of the body', locked(`DO $$ BEGIN PERFORM 1; ${INSERT_RP} VALUES ('viewer', 'users:write'); END $$`), 'grants class-raising code users:write'],
    ['a write inside a block body with a tagged dollar quote, judged past the semicolons of the body', locked(`DO $body$ BEGIN PERFORM 1; ${INSERT_RP} VALUES ('viewer', 'users:write'); END $body$`), 'grants class-raising code users:write'],
    ['a positional parameter is not a dollar quote', locked(`${INSERT_RP} VALUES ($1, 'users:write'), ($2, 'docs:read')`), 'grants class-raising code users:write'],
    ['a comment between the verb and the table', locked(`INSERT INTO /* c */ role_permissions (role_id, permission_code) VALUES ('viewer', 'users:write')`), 'grants class-raising code users:write'],
    ['a schema-qualified target with spaces around the dot', locked("INSERT INTO public . role_permissions (role_id, permission_code) VALUES ('viewer', 'users:write')"), 'grants class-raising code users:write'],
    ['a double-quoted target', locked(`INSERT INTO "role_permissions" (role_id, permission_code) VALUES ('viewer', 'users:write')`), 'grants class-raising code users:write'],
    ['an upper-case target', locked("INSERT INTO ROLE_PERMISSIONS (ROLE_ID, PERMISSION_CODE) VALUES ('viewer', 'users:write')"), 'grants class-raising code users:write'],
    ['a literal statement run by EXECUTE inside a block', locked(`DO $$ BEGIN EXECUTE 'INSERT INTO role_permissions (role_id, permission_code) VALUES (''viewer'', ''users:write'')'; END $$`), 'grants class-raising code users:write'],
  ]
  for (const [name, source, problem] of raising) {
    it(`${name} is raising`, () => {
      const result = check(source)
      expect(result.verdicts.map((line) => line.verdict)).toEqual(['raising'])
      expect(result.problems).toEqual([problem])
    })
  }

  const unreadable: Array<[string, string, number?]> = [
    ['a loop variable as the code', lockedCode('for (const permissionCode of codes) {', 'await sql`' + INSERT_RP + " VALUES ('viewer', ${permissionCode})`.execute(db)", '}')],
    ['every catalogue code granted without a predicate', locked(`${INSERT_RP} SELECT 'viewer', code FROM permissions`)],
    ['a query-builder insert', lockedCode("await db.insertInto('role_permissions').values({ role_id: 'viewer', permission_code: 'docs:read' }).execute()")],
    ['a code moved to another role', locked("UPDATE role_permissions SET role_id = 'viewer' WHERE permission_code = 'docs:read'")],
    ['a direct grant moved to another user', locked("UPDATE user_permissions SET user_id = 'u2' WHERE user_id = 'u1'")],
    ['an insert without a column list', locked("INSERT INTO role_permissions VALUES ('viewer', 'docs:read')")],
    ['an insert of default values', locked('INSERT INTO role_permissions DEFAULT VALUES')],
    ['MERGE', locked('MERGE INTO role_permissions rp USING staging s ON (rp.role_id = s.role_id) WHEN NOT MATCHED THEN INSERT VALUES (s.role_id, s.code)')],
    ['COPY', locked('COPY role_permissions (role_id, permission_code) FROM STDIN')],
    ['an upsert action that assigns the code', locked(`${INSERT_RP} VALUES ('viewer', 'docs:read') ON CONFLICT (role_id, permission_code) DO UPDATE SET permission_code = EXCLUDED.permission_code`)],
    ['variables as operands inside a block', locked(`DO $$ DECLARE r text; c text; BEGIN ${INSERT_RP} VALUES (r, c); END $$`)],
    ['a literal in the code position of the catalogue form', locked(`${INSERT_RP} SELECT 'viewer', 'users:write' FROM permissions p WHERE p.code = 'docs:read'`)],
    ['a second predicate joined by OR', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions p WHERE p.code = 'docs:read' OR p.code LIKE 'users:%'`)],
    ['a second predicate that is always true', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions p WHERE p.code = 'docs:read' OR TRUE`)],
    ['a second predicate joined by AND', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions p WHERE p.code IN ('docs:read') AND p.code <> 'x'`)],
    ['a UNION after the tuples', locked(`${INSERT_RP} VALUES ('viewer', 'docs:read') UNION SELECT 'viewer', 'users:write'`)],
    ['a UNION after the catalogue form', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions p WHERE p.code IN ('docs:read') UNION SELECT 'viewer', 'users:write'`)],
    ['a join in the catalogue form', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions p JOIN other o ON TRUE WHERE p.code = 'docs:read'`)],
    ['a tuple assignment that names judged columns', locked("UPDATE users SET (role, is_admin) = ('admin', true)")],
    ['an escape-string literal', locked(`${INSERT_RP} VALUES ('viewer', E'users:write')`)],
    ['a unicode-escape literal', locked(`${INSERT_RP} VALUES ('viewer', U&'users\\003Awrite')`)],
    ['a dollar-quoted literal', locked(`${INSERT_RP} VALUES ('viewer', $$users:write$$)`)],
    ['a cast with a length', locked(`${INSERT_RP} VALUES ('viewer', 'users:writeX'::varchar(11))`)],
    ['a CAST expression', locked(`${INSERT_RP} VALUES ('viewer', CAST('docs:read' AS text))`)],
    ['two literals continued across a line', locked(`${INSERT_RP} VALUES ('viewer', 'users:'\n'write')`)],
    ['a literal with a backslash', locked(`${INSERT_RP} VALUES ('viewer', 'docs\\\\:read')`)],
    ['a code array with a JSON escape', locked(`UPDATE users SET permissions = '["\\\\u0075sers:write"]'`)],
    ['a nested code array', locked(`UPDATE users SET permissions = '[["users:write"]]'`)],
    ['a JSON object', locked(`UPDATE users SET permissions = '{"a":1}'`)],
    ['an ARRAY constructor', locked("UPDATE users SET permissions = ARRAY['users:write']")],
    ['a birth that leaves the judged columns to their defaults', locked("INSERT INTO users (id, email) VALUES ('u1', 'a@b')")],
    ['a destructuring default', lockedCode("const { CODE = 'docs:read' } = cfg", 'await sql`' + INSERT_RP + " VALUES ('viewer', ${CODE})`.execute(db)")],
    ['a comma expression', lockedCode("const CODE = ('users:write', 'docs:read')", 'await sql`' + INSERT_RP + " VALUES ('viewer', ${CODE})`.execute(db)")],
    ['a property access', lockedCode("const CODES = { read: 'docs:read' }", 'await sql`' + INSERT_RP + " VALUES ('viewer', ${CODES.read})`.execute(db)")],
    ['a positional parameter', locked(`${INSERT_RP} VALUES ('viewer', $1)`)],
    ['DEFAULT', locked(`${INSERT_RP} VALUES ('viewer', DEFAULT)`)],
    ['NULL', locked(`${INSERT_RP} VALUES ('viewer', NULL)`)],
    ['a function call', locked(`${INSERT_RP} VALUES ('viewer', lower('USERS:WRITE'))`)],
    ['a concatenation', locked(`${INSERT_RP} VALUES ('viewer', 'users:' || 'write')`)],
    ['a column reference', locked(`UPDATE role_permissions SET permission_code = other_code`)],
    ['a subquery', locked(`${INSERT_RP} VALUES ('viewer', (SELECT code FROM permissions LIMIT 1))`)],
    ['a number where a boolean is judged', locked("UPDATE users SET is_admin = 1")],
    ['a quoted boolean', locked("UPDATE users SET is_admin = 'false'")],
    ['an input write inside a CTE of another statement', locked(`WITH w AS (${INSERT_RP} VALUES ('viewer', 'users:write') RETURNING 1) INSERT INTO audit_x SELECT 1 FROM w`)],
    ['the key of a user row', unlocked("UPDATE users SET id = 'u2' WHERE id = 'u1'")],
    ['the key of a user row in an upsert action', locked("INSERT INTO users (id, email, role, is_admin, permissions) VALUES ('u1', 'a@b', 'user', FALSE, '[]') ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id")],
  ]
  for (const [name, source, count] of unreadable) {
    it(`${name} is unreadable`, () => {
      const result = check(source)
      expect(result.verdicts.map((line) => line.verdict)).toEqual(Array.from({ length: count ?? 1 }, () => 'unreadable'))
      expect(result.problems.every((problem) => problem.startsWith('unreadable ') || problem.startsWith('write outside'))).toBe(true)
      expect(result.problems.length).toBeGreaterThan(0)
    })
  }

  it('an input write that is not the outermost statement is reported as that write, in a file that is not new as well', () => {
    const nested = locked(`WITH w AS (${INSERT_RP} VALUES ('viewer', 'users:write') RETURNING 1) INSERT INTO audit_x SELECT 1 FROM w`)
    const problem = 'unreadable INSERT: INSERT on role_permissions is not the outermost statement'
    expect(check(nested).problems).toEqual([problem])
    expect(checkNewMigration(historicalMigrationFiles().find((file) => file.endsWith('.ts'))!, nested, false).problems).toEqual([problem])
  })

  it('a name declared more than once in the file is never folded', () => {
    const shadowedByParameter = `import { sql } from 'kysely'\nconst CODE = 'docs:read'\nasync function grant(db, CODE) {\n  await sql\`${INSERT_RP} VALUES ('viewer', \${CODE})\`.execute(db)\n}\nexport async function up(db) {\n${LOCK}\nawait grant(db, 'users:write')\n}`
    expect(verdicts(shadowedByParameter)).toEqual(['unreadable'])
    const twoScopes = lockedCode("{ const CODE = 'docs:read' }", "const CODE = 'users:write'", 'await sql`' + INSERT_RP + " VALUES ('viewer', ${CODE})`.execute(db)")
    expect(verdicts(twoScopes)).toEqual(['unreadable'])
    const once = lockedCode("const CODE = 'docs:read' as const", 'await sql`' + INSERT_RP + " VALUES ('viewer', ${CODE})`.execute(db)")
    expect(check(once).problems).toEqual([])
    const parameterDefault = `import { sql } from 'kysely'\nexport async function up(db, CODE = 'docs:read') {\n${LOCK}\nawait sql\`${INSERT_RP} VALUES ('viewer', \${CODE})\`.execute(db)\n}`
    expect(verdicts(parameterDefault)).toEqual(['unreadable'])
  })

  const green: Array<[string, string]> = [
    ['a non-raising code for an ordinary role', locked(`${INSERT_RP} VALUES ('viewer', 'docs:read') ON CONFLICT DO NOTHING`)],
    ['a catalogue-only insert', unlocked("INSERT INTO permissions (code, name) VALUES ('users:read', 'Read users')")],
    ['the role id position is not judged', locked(`${INSERT_RP} VALUES ('admin', 'docs:read')`)],
    ['the WHERE clause is not judged', locked("UPDATE role_permissions SET permission_code = 'docs:read' WHERE role_id = 'admin'")],
    ['the catalogue form with a literal code', locked(`${INSERT_RP} SELECT 'admin', p.code FROM permissions p WHERE p.code = 'docs:read' ON CONFLICT DO NOTHING`)],
    ['the catalogue form with a code list', locked(`${INSERT_RP} SELECT 'viewer', p.code FROM permissions AS p WHERE p.code IN ('docs:read', 'docs:comment') ON CONFLICT (role_id, permission_code) DO NOTHING`)],
    ['the catalogue form with a folded code', lockedCode("const CODE = 'docs:read'", "const ROLE = 'admin'", 'await sql`\n  ' + INSERT_RP + '\n  SELECT ${ROLE}, p.code\n  FROM permissions p\n  WHERE p.code = ${CODE}\n  ON CONFLICT DO NOTHING;\n`.execute(db)')],
    ['a folded code inside quotes', lockedCode("const CODE = 'docs:read'", 'await db.query(`' + INSERT_RP + " VALUES ('viewer', '${CODE}')`)")],
    ['a semicolon and a parenthesis inside a literal', locked(`${INSERT_RP} VALUES ('viewer', 'a;b'), ('viewer', 'c)d')`)],
    ['an upsert action that leaves the judged column alone', locked(`${INSERT_RP} VALUES ('viewer', 'docs:read') ON CONFLICT (role_id, permission_code) DO UPDATE SET created_at = now() RETURNING role_id`)],
    ['a delete with the lock block', locked("DELETE FROM role_permissions WHERE permission_code = 'docs:read'")],
    ['a truncate of a direct-grant table with the lock block', locked('TRUNCATE user_permissions')],
    ['an admission row', locked("INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES ('u', 'crm', true)")],
    ['a tuple assignment over other columns', unlocked("UPDATE users SET (email, locale) = ('a', 'b')")],
    ['a text cast', locked(`${INSERT_RP} VALUES ('viewer', 'docs:read'::text), ('viewer', 'docs:comment'::varchar)`)],
    ['a non-raising code array and the two empty forms', locked(`UPDATE users SET permissions = '["docs:read"]'::jsonb`, "UPDATE users SET permissions = '[]'", "UPDATE users SET permissions = '{}'")],
    ['a birth with the three judged columns explicit', locked("INSERT INTO users (id, email, role, is_admin, permissions) VALUES ('u1', 'a@b', 'user', FALSE, '[]')")],
    ['a role lowered to an ordinary one', locked("UPDATE users SET role = 'user', is_admin = FALSE WHERE id = 'u'")],
  ]
  for (const [name, source] of green) {
    it(`${name} is accepted`, () => {
      expect(check(source).problems).toEqual([])
    })
  }

  it('a write without the lock block is refused whatever it writes', () => {
    expect(check(unlocked(`${INSERT_RP} VALUES ('viewer', 'users:write')`)).problems).toEqual(['missing world lock try form', 'grants class-raising code users:write'])
    expect(check(unlocked("DELETE FROM role_permissions WHERE permission_code = 'docs:read'")).problems).toEqual(['missing world lock try form'])
    expect(check(unlocked(`${INSERT_RP} VALUES ('viewer', 'docs:read')`)).problems).toEqual(['missing world lock try form'])
  })

  it('a target spelled with a schema, quotes or upper case is a write: without the lock block it is refused', () => {
    for (const target of ['public . role_permissions', '"public"."role_permissions"', 'ROLE_PERMISSIONS', 'public.Role_Permissions']) {
      expect(check(unlocked(`INSERT INTO ${target} (role_id, permission_code) VALUES ('viewer', 'docs:read')`)).problems, target).toEqual(['missing world lock try form'])
      expect(check(locked(`INSERT INTO ${target} (role_id, permission_code) VALUES ('viewer', 'docs:read')`)).problems, target).toEqual([])
    }
    expect(check(unlocked("DELETE FROM /* c */ role_permissions -- d\nWHERE role_id = 'x'")).problems).toEqual(['missing world lock try form'])
  })

  it('a lock block written only inside an SQL comment of a literal does not count', () => {
    const commented = up(q(`/* ${COMPLIANT_LOCK_BLOCK} */ SELECT 1`), q(`${INSERT_RP} VALUES ('viewer', 'docs:read')`))
    expect(check(commented).problems).toEqual(['missing world lock try form'])
    const lineCommented = up(q(`-- ${COMPLIANT_LOCK_BLOCK}\nSELECT 1`), q(`${INSERT_RP} VALUES ('viewer', 'docs:read')`))
    expect(check(lineCommented).problems).toEqual(['missing world lock try form'])
    expect(blankSqlComments("SELECT '--x', 1 -- tail\n/* a /* b */ c */ FROM t")).toBe("SELECT '--x', 1        \n                  FROM t")
  })

  it('the same rules read a `.sql` migration by its statements', () => {
    expect(check(`${COMPLIANT_LOCK_BLOCK};\nINSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'docs:read');`, NEW_SQL).problems).toEqual([])
    expect(check(`${COMPLIANT_LOCK_BLOCK};\nINSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'users:write');`, NEW_SQL).problems).toEqual(['grants class-raising code users:write'])
    expect(check(`-- ${COMPLIANT_LOCK_BLOCK}\nINSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'docs:read');`, NEW_SQL).problems).toEqual(['missing world lock try form'])
    expect(splitStatements("SELECT 'a;b'; SELECT $$ c; d $$; SELECT $1;").map((statement) => statement.text.trim())).toEqual(["SELECT 'a;b'", 'SELECT $$ c; d $$', 'SELECT $1'])
  })

  it('a write that is judged in a file that is not new is still judged, and its other statements are not', () => {
    const historical = historicalMigrationFiles().find((file) => file.endsWith('.ts'))!
    expect(checkNewMigration(historical, locked(`${INSERT_RP} VALUES ('viewer', 'users:write')`)).problems).toEqual(['grants class-raising code users:write'])
    expect(checkNewMigration(historical, locked(`${INSERT_RP} SELECT 'viewer', code FROM permissions`)).verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
    expect(checkNewMigration(historical, unlocked('CREATE VIEW v AS SELECT * FROM user_roles')).problems).toEqual([])
  })
})

describe('memberships are not written by a migration', () => {
  const MEMBERSHIP = 'writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'

  it('an insert or an update of a membership is refused, whatever the role', () => {
    for (const statement of [
      "INSERT INTO user_roles (user_id, role_id) VALUES ('u', 'viewer')",
      "INSERT INTO user_roles (user_id, role_id) VALUES ('u', 'admin')",
      "UPDATE user_roles SET role_id = 'viewer' WHERE user_id = 'u'",
    ]) {
      const result = check(locked(statement))
      expect(result.verdicts.map((line) => line.verdict), statement).toEqual(['unreadable'])
      expect(result.problems, statement).toEqual([MEMBERSHIP])
    }
    const folded = lockedCode("const ADMIN_ROLE = 'admin'", "await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u', ${ADMIN_ROLE})`.execute(db)")
    expect(check(folded).problems).toEqual([MEMBERSHIP])
  })

  it('a delete or a truncate of memberships is refused with or without the lock block; the same verbs on role_permissions are accepted with it', () => {
    const statements = ["DELETE FROM user_roles WHERE role_id = 'x'", 'TRUNCATE user_roles', 'TRUNCATE audit_x, user_roles']
    for (const statement of statements) {
      const withLock = check(locked(statement))
      expect(withLock.verdicts.map((line) => line.verdict), statement).toEqual(['unreadable'])
      expect(withLock.problems, statement).toEqual([MEMBERSHIP])
      expect(check(unlocked(statement)).problems, statement).toEqual(['missing world lock try form', MEMBERSHIP])
    }
    expect(check(locked("DELETE FROM role_permissions WHERE role_id = 'x'")).problems).toEqual([])
    expect(check(locked('TRUNCATE audit_x, role_permissions')).problems).toEqual([])
  })
})

describe('statement kinds in a new migration', () => {
  const red: Array<[string, string, number?]> = [
    ['a default on a sensitive column', unlocked("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'admin'")],
    ['a type change with USING on is_admin', unlocked('ALTER TABLE users ALTER COLUMN is_admin TYPE boolean USING true')],
    ['a type change with USING on a code column', unlocked("ALTER TABLE role_permissions ALTER COLUMN permission_code TYPE text USING 'users:write'")],
    ['a new column named as a sensitive one', unlocked('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT true')],
    ['a table renamed to an input table', unlocked('ALTER TABLE staging_roles RENAME TO user_roles')],
    ['an input table renamed away', unlocked('ALTER TABLE user_roles RENAME TO user_roles_old')],
    ['an input table dropped', unlocked('DROP TABLE IF EXISTS user_roles CASCADE')],
    ['a table created under an input name', unlocked('CREATE TABLE IF NOT EXISTS user_roles (user_id text, role_id text)')],
    ['any column of a delegated scope table', unlocked('ALTER TABLE delegated_role_admin_scopes ADD COLUMN note text')],
    ['a view over an input table', unlocked('CREATE VIEW v AS SELECT * FROM user_roles')],
    ['a materialized view over an input table', unlocked('CREATE MATERIALIZED VIEW v AS SELECT * FROM role_permissions')],
    ['a rule that writes an input table', unlocked("CREATE RULE r AS ON INSERT TO staging DO ALSO INSERT INTO role_permissions (role_id, permission_code) VALUES (NEW.r, NEW.c)")],
    ['a trigger on an input table', unlocked('CREATE TRIGGER t BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at()')],
    ['a function whose body names an input table', unlocked('CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1 FROM role_permissions; END $$ LANGUAGE plpgsql')],
    ['a formatted dynamic statement whose text names an input table', unlocked(`DO $$ BEGIN EXECUTE format('INSERT INTO %I (role_id, permission_code) VALUES (%L, %L)', 'role_permissions', 'viewer', 'users:write'); END $$`), 2],
    ['a dynamic statement inside a function body', unlocked("CREATE FUNCTION g(t text) RETURNS void AS $$ BEGIN EXECUTE 'DELETE FROM ' || t; END $$ LANGUAGE plpgsql")],
    ['a builder that alters an input table', up("await db.schema.alterTable('users').alterColumn('role', (c) => c.setDefault('admin')).execute()")],
    ['a builder that creates an input table', up("await db.schema.createTable('user_roles').execute()")],
    ['one unsafe sub-action among several', unlocked("ALTER TABLE users ADD COLUMN a int, ALTER COLUMN role SET DEFAULT 'admin'")],
    ['a sub-action that is not on the safe list', unlocked('ALTER TABLE role_permissions SET UNLOGGED')],
    ['a statement kind that is not on the safe list', unlocked('GRANT ALL ON users TO app')],
    ['a rebuilt foreign key with an update action', unlocked('ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_permission_code_fkey, ADD CONSTRAINT role_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES permissions(code) ON UPDATE CASCADE ON DELETE CASCADE')],
    ['a new foreign key with an update action', unlocked('ALTER TABLE user_roles ADD FOREIGN KEY (role_id) REFERENCES roles(id) ON UPDATE CASCADE')],
    ['a foreign key that clears a sensitive column on delete', unlocked('ALTER TABLE user_roles ADD FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL')],
    ['a changed constraint', unlocked('ALTER TABLE user_roles ALTER CONSTRAINT user_roles_role_id_fkey DEFERRABLE')],
    ['the key of the permission catalogue', unlocked("UPDATE permissions SET code = 'reports:admin' WHERE code = 'reports:manage'")],
    ['the key of a role', unlocked("UPDATE roles SET id = 'ops_admin' WHERE id = 'ops_lead'")],
    ['a catalogue key in an upsert action', unlocked("INSERT INTO permissions (code, name) VALUES ('a:b', 'x') ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code")],
    ['a role key changed inside a CTE', unlocked("WITH x AS (UPDATE roles SET id = 'ops_admin' WHERE id = 'ops_lead' RETURNING 1) SELECT 1 FROM x")],
    ['a tuple assignment over a role key', unlocked("UPDATE roles SET (id, name) = ('a', 'b')")],
    ['a user key changed inside a CTE of a read', unlocked("WITH x AS (UPDATE users SET id = 'u2' WHERE id = 'u1' RETURNING 1) SELECT 1 FROM x")],
    ['a user row written inside a CTE of a read, whatever the column', unlocked("WITH x AS (UPDATE users SET email = 'a' RETURNING 1) SELECT 1 FROM x")],
    ['a write on an input table run by EXPLAIN', unlocked("EXPLAIN ANALYZE UPDATE users SET id = 'u2'")],
    ['a write on an input table nested in a write on another table', unlocked("INSERT INTO audit_x WITH w AS (UPDATE users SET id = 'u2' RETURNING id) SELECT id FROM w")],
  ]
  for (const [name, source, count] of red) {
    it(`${name} is unreadable`, () => {
      const result = check(source)
      expect(result.verdicts.map((line) => line.verdict)).toEqual(Array.from({ length: count ?? 1 }, () => 'unreadable'))
      expect(result.problems.filter((problem) => problem.startsWith('unreadable '))).toHaveLength(count ?? 1)
    })
  }

  it('a rule that writes memberships is refused as a membership write', () => {
    expect(verdicts(unlocked("CREATE RULE r AS ON INSERT TO staging DO ALSO INSERT INTO user_roles (user_id, role_id) VALUES (NEW.u, NEW.r)"))).toEqual(['unreadable'])
  })

  const green: Array<[string, string]> = [
    ['a default on a column the classifier does not read', unlocked("ALTER TABLE users ALTER COLUMN activation_status SET DEFAULT 'activated'")],
    ['a foreign key from another table', unlocked('CREATE TABLE audit_x (user_id text REFERENCES users(id))')],
    ['an index on an input table', unlocked('CREATE INDEX IF NOT EXISTS idx_x ON user_roles (role_id)', 'CREATE UNIQUE INDEX idx_y ON users (email)')],
    ['a new ordinary column', unlocked('ALTER TABLE users ADD COLUMN nickname text', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text DEFAULT \'en\'')],
    ['a dropped ordinary column', unlocked('ALTER TABLE users DROP COLUMN IF EXISTS nickname')],
    ['a read', unlocked('SELECT count(*) FROM user_roles')],
    ['a read with a row-lock clause', unlocked("SELECT id FROM users WHERE id = 'u' FOR UPDATE", 'SELECT 1 FROM user_roles FOR SHARE', "SELECT id FROM users WHERE id = 'u' FOR NO KEY UPDATE OF users")],
    ['a read of an input table joined to a write on another table', unlocked('WITH d AS (DELETE FROM audit_x RETURNING user_id) SELECT 1 FROM users u JOIN d ON d.user_id = u.id')],
    ['a write elsewhere that reads an input table', unlocked('INSERT INTO report_cache SELECT user_id FROM user_roles')],
    ['a catalogue insert', unlocked("INSERT INTO permissions (code, name) VALUES ('users:read', 'Read users')")],
    ['a primary key on an input table', unlocked('ALTER TABLE user_roles ADD PRIMARY KEY (user_id, role_id)')],
    ['a guarded column add inside a block', unlocked("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'nickname') THEN ALTER TABLE users ADD COLUMN nickname text; END IF; END $$")],
    ['a trigger on another table', unlocked('CREATE TRIGGER t BEFORE UPDATE ON audit_x FOR EACH ROW EXECUTE FUNCTION touch_updated_at()')],
    ['a renamed ordinary column', unlocked('ALTER TABLE users RENAME COLUMN nickname TO display_name')],
    ['a comment and a validated constraint', unlocked("COMMENT ON TABLE users IS 'accounts'", 'ALTER TABLE users VALIDATE CONSTRAINT users_email_check')],
    ['an update of ordinary user columns', unlocked("UPDATE users SET email = lower(email) WHERE email IS NOT NULL")],
    ['a rebuilt foreign key without an update action', unlocked('ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_permission_code_fkey, ADD CONSTRAINT role_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE')],
    ['a foreign key whose update action keeps the key', unlocked('ALTER TABLE user_roles ADD FOREIGN KEY (role_id) REFERENCES roles(id) ON UPDATE NO ACTION ON DELETE RESTRICT')],
    ['a catalogue description', unlocked("UPDATE permissions SET description = 'x' WHERE code = 'stock-prep:admin'")],
    ['a role name', unlocked("UPDATE roles SET name = 'x', updated_at = now() WHERE id = 'r'")],
  ]
  for (const [name, source] of green) {
    it(`${name} is accepted without the lock block`, () => {
      expect(check(source).problems).toEqual([])
    })
  }

  it('a write the scanner reports outside every judged statement is a problem', () => {
    const write = { file: NEW_TS, line: 1, position: 0, table: 'role_permissions', verb: 'INSERT' as const, form: 'sql' as const }
    expect(closureProblems([write], new Map())).toEqual(['write outside the judged statements: role_permissions|INSERT'])
    expect(closureProblems([write, write], new Map([['role_permissions|INSERT', 1]]))).toEqual(['write outside the judged statements: role_permissions|INSERT'])
    expect(closureProblems([write], new Map([['role_permissions|INSERT', 1]]))).toEqual([])
    expect(closureProblems([{ ...write, table: 'roles', verb: 'DELETE' as const }], new Map())).toEqual(['write outside the judged statements: roles|DELETE'])
    // A name the scanner folds and the judgment does not: the write lies in no judged statement, in a file that is not new as well.
    const shadowed = `import { sql } from 'kysely'\nconst T = 'role_permissions'\nexport async function up(db, T) {\n${LOCK}\nawait sql\`DELETE FROM \${T}\`.execute(db)\n}`
    expect(check(shadowed, historicalMigrationFiles().find((file) => file.endsWith('.ts'))!, false).problems).toEqual(['write outside the judged statements: role_permissions|DELETE'])
    expect(check(shadowed).problems).toEqual(['unreadable ROLE_PERMISSIONS: statement kind is not on the safe list', 'unreadable DELETE: dynamic write target', 'write outside the judged statements: role_permissions|DELETE'])
  })
})

describe('query-builder writes', () => {
  const MEMBERSHIP = 'writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'
  const builder = (call: string) => `await ${call}.execute()`

  const qualified: Array<[string, string, string]> = [
    ['a delete with a schema', "db.deleteFrom('public.user_roles')", MEMBERSHIP],
    ['a delete with an alias', "db.deleteFrom('user_roles as ur').where('ur.role_id', '=', 'x')", MEMBERSHIP],
    ['an insert with a schema', "db.insertInto('public.user_roles').values({ user_id: 'u1', role_id: 'admin' })", MEMBERSHIP],
    ['a merge with an alias', "db.mergeInto('user_roles as ur').using('staging as s', 's.user_id', 'ur.user_id').whenNotMatched().thenInsertValues({ user_id: 'u1', role_id: 'admin' })", MEMBERSHIP],
    ['an update of users with an alias', "db.updateTable('users as u').set({ is_admin: true })", 'unreadable UPDATE: UPDATE on users through a query builder has no statement text'],
    ['an update of users with a schema', "db.updateTable('public.users').set({ role: 'admin' })", 'unreadable UPDATE: UPDATE on users through a query builder has no statement text'],
    ['an insert of a role grant with a schema', "db.insertInto('public.role_permissions').values({ role_id: 'viewer', permission_code: 'users:write' })", 'unreadable INSERT: INSERT on role_permissions through a query builder has no statement text'],
    ['a quoted table with a schema, an alias and upper case', `db.deleteFrom('"public"."USER_ROLES" AS ur')`, MEMBERSHIP],
  ]
  for (const [name, call, problem] of qualified) {
    it(`${name} is one write on the input table it names: one verdict, and the lock block is required`, () => {
      const withLock = check(lockedCode(builder(call)))
      expect(withLock.verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
      expect(withLock.problems).toEqual([problem])
      expect(withLock.inputWrites).toBe(1)
      expect(check(up(builder(call))).problems).toEqual(['missing world lock try form', problem])
    })
  }

  it('a write on memberships under the exact table name is one verdict with the membership wording, counted once, with every scanned write inside it', () => {
    const source = lockedCode(builder("db.insertInto('user_roles').values({ user_id: 'u1', role_id: 'viewer' })"))
    const judged = judgeMigrationInputWrites(NEW_TS, source)
    expect(judged.judgments).toEqual([{ line: 4, kind: 'INSERT', verdict: 'unreadable', detail: MEMBERSHIP, inputWrite: true, table: 'user_roles', forbiddenTable: true }])
    expect([...judged.writes]).toEqual([['user_roles|INSERT', 1]])
    expect(check(source).problems).toEqual([MEMBERSHIP])
    expect(check(lockedCode(builder("db.deleteFrom('USER_ROLES')"))).problems).toEqual([MEMBERSHIP])
  })

  it('a table argument that names no single table is a dynamic target and is still read as text', () => {
    const two = check(lockedCode(builder("db.insertInto('user_roles, staging').values(rows)")))
    expect(two.problems).toEqual(['unreadable INSERT: dynamic write target', 'unreadable USER_ROLES: statement kind is not on the safe list'])
    const three = check(lockedCode(builder("db.deleteFrom('app.public.user_roles')")))
    expect(three.problems).toEqual(['unreadable DELETE: dynamic write target', 'unreadable APP: statement kind is not on the safe list'])
    expect(check(lockedCode(builder("db.deleteFrom('audit_x; y')"))).problems).toEqual(['unreadable DELETE: dynamic write target'])
  })

  it('an update or a merge of a cascade parent has no assignment list to read; an insert and a delete of one, and any write elsewhere, are accepted', () => {
    expect(check(up(builder("db.updateTable('roles').set({ id: 'x' }).where('id', '=', 'y')"))).problems).toEqual(['unreadable UPDATE: UPDATE on roles through a query builder has no assignment list'])
    expect(check(up(builder("db.updateTable('roles as r').set({ name: 'x' })"))).problems).toEqual(['unreadable UPDATE: UPDATE on roles through a query builder has no assignment list'])
    expect(check(up(builder("db.mergeInto('public.permissions').using('staging', 'staging.code', 'permissions.code').whenMatched().thenUpdateSet({ code: 'a:b' })"))).problems).toEqual(['unreadable MERGE: MERGE on permissions through a query builder has no assignment list'])
    expect(check(up(builder("db.insertInto('permissions').values({ code: 'docs:read', name: 'Read' })"))).problems).toEqual([])
    expect(check(up(builder("db.deleteFrom('platform_member_groups')"))).problems).toEqual([])
    expect(check(up(builder("db.updateTable('audit_x as a').set({ note: 'x' })"))).problems).toEqual([])
    // In a file that is not new the parent write is not judged.
    expect(check(up(builder("db.updateTable('roles').set({ id: 'x' })")), historicalMigrationFiles().find((file) => file.endsWith('.ts'))!, false).problems).toEqual([])
  })

  describe('an insert of a cascade parent', () => {
    const noAssignmentList = (table: string) => [`unreadable INSERT: INSERT on ${table} through a query builder has no assignment list`]
    const PERMISSION = "db.insertInto('permissions').values({ code: 'reports:manage', name: 'x' })"
    const ROLE = "db.insertInto('roles').values({ id: 'ops_lead', name: 'x' })"

    const upserts: Array<[string, string, string]> = [
      ['an upsert action that sets the key it conflicts on', `${PERMISSION}.onConflict((oc) => oc.column('code').doUpdateSet({ code: 'reports:admin' }))`, 'permissions'],
      ['an upsert action that sets the key on a conflict over another column', `${PERMISSION}.onConflict((oc) => oc.column('name').doUpdateSet({ code: 'reports:admin' }))`, 'permissions'],
      ['an upsert action that sets the key of a role', `${ROLE}.onConflict((oc) => oc.column('name').doUpdateSet({ id: 'ops_admin' }))`, 'roles'],
      ['an upsert action that sets another column', `${PERMISSION}.onConflict((oc) => oc.column('code').doUpdateSet({ name: 'y' }))`, 'permissions'],
      ['an upsert action built from the excluded row, on a table named with a schema', "db.insertInto('public.roles').values(rows).onConflict((oc) => oc.constraint('roles_pkey').doUpdateSet((eb) => ({ id: eb.ref('excluded.id') })))", 'roles'],
      ['an upsert action in one branch of the conflict clause', `${PERMISSION}.onConflict((oc) => (keep ? oc.doNothing() : oc.column('code').doUpdateSet({ code: 'reports:admin' })))`, 'permissions'],
      ['a conflict clause that is not an inline callback', `${PERMISSION}.onConflict(onPermissionConflict)`, 'permissions'],
      ['a conflict clause whose callback calls anything but a conflict target and doNothing', `${PERMISSION}.onConflict((oc) => finish(oc.column('code')).doNothing())`, 'permissions'],
      ['a conflict clause that does not end in doNothing', `${PERMISSION}.onConflict((oc) => oc.column('code'))`, 'permissions'],
      ['an upsert action called on the insert itself', `${PERMISSION}.doUpdateSet({ code: 'reports:admin' })`, 'permissions'],
      ['an upsert action of another dialect', `${PERMISSION}.onDuplicateKeyUpdate({ code: 'reports:admin' })`, 'permissions'],
      ['an upsert action added under a condition', `${PERMISSION}.$if(flag, (qb) => qb.onConflict((oc) => oc.column('code').doUpdateSet({ code: 'reports:admin' })))`, 'permissions'],
      ['a call that receives the builder', `${PERMISSION}.$call(addUpsert)`, 'permissions'],
      ['a conflict clause written as text at the end of the statement', PERMISSION + '.modifyEnd(sql`on conflict (code) do update set code = excluded.code`)', 'permissions'],
      ['rows taken from a query', "db.insertInto('permissions').columns(['code', 'name']).expression((eb) => eb.selectFrom('staging').select(['code', 'name']))", 'permissions'],
      ['a link after the call that runs it', `${PERMISSION}.execute().then(report)`, 'permissions'],
    ]
    for (const [name, call, table] of upserts) {
      it(`${name} has no assignment list to read`, () => {
        const result = check(up(builder(call)))
        expect(result.verdicts).toEqual([{ verdict: 'unreadable', kind: 'INSERT', detail: `INSERT on ${table} through a query builder has no assignment list`, table, value: undefined }])
        expect(result.problems).toEqual(noAssignmentList(table))
      })
    }

    const plain: Array<[string, string]> = [
      ['no conflict clause', PERMISSION],
      ['a conflict clause that does nothing', `${PERMISSION}.onConflict((oc) => oc.doNothing())`],
      ['a conflict clause that names one column and does nothing', `${PERMISSION}.onConflict((oc) => oc.column('code').doNothing())`],
      ['a conflict clause that names several columns and does nothing', `${ROLE}.onConflict((oc) => oc.columns(['id']).doNothing())`],
      ['a conflict clause that names a constraint and does nothing, written as a function', `${ROLE}.onConflict(function (oc) { return oc.constraint('roles_pkey').doNothing() })`],
      ['a returning clause', `${PERMISSION}.returning('code')`],
      ['a clause that returns every column', `${PERMISSION}.returningAll()`],
    ]
    for (const [name, call] of plain) {
      it(`${name} leaves it a plain insert, accepted without the lock block`, () => {
        expect(check(up(builder(call))).problems).toEqual([])
      })
    }

    it('is read to the call that runs it: a chain that ends anywhere else is refused, whatever is added to it later', () => {
      const notRun = ['unreadable INSERT: INSERT on permissions through a query builder does not end in the call that runs it']
      expect(check(up(`const pending = ${PERMISSION}`, "await pending.onConflict((oc) => oc.column('code').doUpdateSet({ code: 'reports:admin' })).execute()")).problems).toEqual(notRun)
      expect(check(up(`const pending = ${PERMISSION}.onConflict((oc) => oc.doNothing())`, 'await pending.execute()')).problems).toEqual(notRun)
      expect(check(up(`await run(${PERMISSION})`)).problems).toEqual(notRun)
      expect(check(up(`await (${PERMISSION}).execute()`)).problems).toEqual(notRun)
      expect(check(up("const pending = db.insertInto('permissions')", 'await pending.execute()')).problems).toEqual(notRun)
      for (const runner of ['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow']) expect(check(up(`await ${PERMISSION}.${runner}()`)).problems).toEqual([])
      // A link that is not read is reported as such wherever the chain ends.
      expect(check(up(`const pending = ${PERMISSION}.onConflict((oc) => oc.column('code').doUpdateSet({ code: 'reports:admin' }))`)).problems).toEqual(noAssignmentList('permissions'))
      expect(check(up(`const compiled = ${PERMISSION}.compile()`)).problems).toEqual(noAssignmentList('permissions'))
    })

    it('is judged in a new file only, and an upsert on any other table is not judged by this rule', () => {
      const upsert = `${PERMISSION}.onConflict((oc) => oc.column('code').doUpdateSet({ code: 'reports:admin' }))`
      expect(check(up(builder(upsert)), historicalMigrationFiles().find((file) => file.endsWith('.ts'))!, false).problems).toEqual([])
      expect(check(up(builder("db.insertInto('audit_x').values({ id: 'a' }).onConflict((oc) => oc.column('id').doUpdateSet({ note: 'x' }))"))).problems).toEqual([])
      // On an input table a query-builder write has no statement text at all.
      expect(check(lockedCode(builder("db.insertInto('users').values({ id: 'u1' }).onConflict((oc) => oc.column('id').doUpdateSet({ id: 'u2' }))"))).problems).toEqual(['unreadable INSERT: INSERT on users through a query builder has no statement text'])
    })

    it('the same upsert written as statement text is refused by its assignment list', () => {
      expect(check(unlocked("INSERT INTO permissions (code, name) VALUES ('reports:manage', 'x') ON CONFLICT (name) DO UPDATE SET code = 'reports:admin'")).problems).toEqual(['unreadable INSERT: assigns a key column of permissions'])
      expect(check(unlocked("INSERT INTO permissions (code, name) VALUES ('reports:manage', 'x') ON CONFLICT (code) DO UPDATE SET name = 'y'")).problems).toEqual([])
    })
  })
})

describe('a table tied to an input table by inheritance or as a partition', () => {
  const red: Array<[string, string, string]> = [
    ['a table created as an inheritance child of the memberships, and then written', unlocked('CREATE TABLE user_roles_archive () INHERITS (user_roles)', "INSERT INTO user_roles_archive (user_id, role_id) VALUES ('u1', 'admin')"), 'unreadable CREATE TABLE: INHERITS names the input table user_roles'],
    ['a table made an inheritance child of the memberships after it is created, and then written', unlocked('CREATE TABLE audit_x (user_id text, role_id text)', 'ALTER TABLE audit_x INHERIT user_roles', "INSERT INTO audit_x (user_id, role_id) VALUES ('u1', 'admin')"), 'unreadable ALTER TABLE: INHERIT names the input table user_roles'],
    ['a table created as an inheritance child of the accounts, and then written', unlocked('CREATE TABLE users_shadow () INHERITS (users)', "INSERT INTO users_shadow (id, role, is_admin) VALUES ('u9', 'admin', TRUE)"), 'unreadable CREATE TABLE: INHERITS names the input table users'],
    ['an inheritance child of the role grants, with IF NOT EXISTS, a schema and quotes', unlocked('CREATE TABLE IF NOT EXISTS rp_extra () INHERITS ("public"."ROLE_PERMISSIONS")'), 'unreadable CREATE TABLE: INHERITS names the input table role_permissions'],
    ['a temporary inheritance child', unlocked('CREATE TEMP TABLE scratch_members () INHERITS (user_roles)'), 'unreadable CREATE TABLE: INHERITS names the input table user_roles'],
    ['an unlogged inheritance child with columns of its own', unlocked('CREATE UNLOGGED TABLE extra_grants (note text) INHERITS (user_permissions) WITH (fillfactor = 90)'), 'unreadable CREATE TABLE: INHERITS names the input table user_permissions'],
    ['an input table named second in the inheritance list', unlocked('CREATE TABLE audit_y () INHERITS (audit_base, public.user_namespace_admissions)'), 'unreadable CREATE TABLE: INHERITS names the input table user_namespace_admissions'],
    ['an inheritance list with an item that is not a name, in a statement that refers to an input table', up('await sql`CREATE TABLE audit_y (user_id text REFERENCES users(id)) INHERITS (${base})`.execute(db)'), 'unreadable CREATE TABLE: INHERITS names a table that is not readable'],
    ['a table created as a partition of an input table', unlocked("CREATE TABLE user_roles_2027 PARTITION OF user_roles FOR VALUES IN ('a')"), 'unreadable CREATE TABLE: PARTITION OF names the input table user_roles'],
    ['a default partition of an input table named with a schema', unlocked('CREATE TABLE IF NOT EXISTS users_rest PARTITION OF public.users DEFAULT'), 'unreadable CREATE TABLE: PARTITION OF names the input table users'],
    ['IF EXISTS, ONLY and a schema around an added inheritance parent', unlocked('ALTER TABLE IF EXISTS ONLY audit_x INHERIT public.users'), 'unreadable ALTER TABLE: INHERIT names the input table users'],
    ['an inheritance parent added among other sub-actions', unlocked('ALTER TABLE audit_x ADD COLUMN note text, INHERIT "delegated_role_admin_scopes"'), 'unreadable ALTER TABLE: INHERIT names the input table delegated_role_admin_scopes'],
    ['an inheritance parent removed', unlocked('ALTER TABLE audit_x NO INHERIT user_roles'), 'unreadable ALTER TABLE: NO INHERIT names the input table user_roles'],
    ['an input table attached to another table as a partition', unlocked("ALTER TABLE audit_x ATTACH PARTITION user_roles FOR VALUES IN ('a', 'b')"), 'unreadable ALTER TABLE: ATTACH PARTITION names the input table user_roles'],
    ['an input table detached from another table', unlocked('ALTER TABLE audit_x DETACH PARTITION public.role_permissions'), 'unreadable ALTER TABLE: DETACH PARTITION names the input table role_permissions'],
    ['a table attached to an input table as a partition', unlocked("ALTER TABLE user_roles ATTACH PARTITION audit_x FOR VALUES IN ('a')"), 'unreadable ALTER TABLE: ATTACH PARTITION is not on the list of safe sub-actions'],
    ['an inheritance parent given to an input table', unlocked('ALTER TABLE user_roles INHERIT audit_base'), 'unreadable ALTER TABLE: INHERIT audit_base is not on the list of safe sub-actions'],
    ['an inheritance child created inside a block', unlocked('DO $$ BEGIN CREATE TABLE IF NOT EXISTS members_archive () INHERITS (user_roles); END $$'), 'unreadable CREATE TABLE: INHERITS names the input table user_roles'],
    ['an inheritance child created by a statement a block runs from one literal', unlocked("DO $$ BEGIN EXECUTE 'CREATE TABLE members_archive () INHERITS (user_roles)'; END $$"), 'unreadable CREATE TABLE: INHERITS names the input table user_roles'],
  ]
  for (const [name, source, problem] of red) {
    it(`${name} is unreadable`, () => {
      const result = check(source)
      expect(result.verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
      expect(result.problems).toEqual([problem])
    })
  }

  it('the same rule reads a `.sql` migration', () => {
    const source = "CREATE TABLE rp_extra () INHERITS (role_permissions);\nINSERT INTO rp_extra (role_id, permission_code) VALUES ('viewer', 'users:write');\n"
    expect(check(source, NEW_SQL).problems).toEqual(['unreadable CREATE TABLE: INHERITS names the input table role_permissions'])
    expect(check("ALTER TABLE audit_x INHERIT user_roles;\n", NEW_SQL).problems).toEqual(['unreadable ALTER TABLE: INHERIT names the input table user_roles'])
  })

  const green: Array<[string, string]> = [
    ['a definition copied from an input table', unlocked('CREATE TABLE user_roles_staging (LIKE user_roles INCLUDING ALL)')],
    ['a foreign key to an input table on an inheritance child of another table', unlocked('CREATE TABLE audit_y (user_id text REFERENCES users(id)) INHERITS (audit_base)')],
    ['a foreign key to an input table on a partitioned table', unlocked('CREATE TABLE audit_y (user_id text REFERENCES users(id)) PARTITION BY LIST (user_id)')],
    ['a partition of another table whose bound spells an input table name', unlocked("CREATE TABLE audit_users PARTITION OF audit_logs FOR VALUES IN ('users')")],
    ['an inheritance parent that is another table, beside a foreign key to an input table', unlocked('ALTER TABLE audit_x INHERIT audit_base, ADD CONSTRAINT audit_x_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)')],
    ['a partition of another table attached with a bound that spells an input table name', unlocked("ALTER TABLE audit_logs ATTACH PARTITION audit_2027 FOR VALUES IN ('user_roles')")],
  ]
  for (const [name, source] of green) {
    it(`${name} only refers to the input table: accepted without the lock block`, () => {
      expect(check(source).problems).toEqual([])
    })
  }
})

describe('targets that are read item by item or not at all', () => {
  const MEMBERSHIP = 'writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'

  it('an identifier written with unicode escapes is unreadable wherever it stands', () => {
    for (const statement of ['UPDATE U&"\\0075sers" SET is_admin = TRUE', 'INSERT INTO u&"user_r\\006Fles" (user_id, role_id) VALUES (\'u\', \'admin\')', 'DELETE FROM audit_x USING U&"d\\0061ta" d']) {
      const result = check(locked(statement))
      expect(result.verdicts.map((line) => line.verdict), statement).toEqual(['unreadable'])
      expect(result.problems[0], statement).toMatch(/^unreadable (?:UPDATE|INSERT|DELETE): identifier written with unicode escapes$/)
    }
    // A string literal with the same prefix is an operand, not an identifier.
    expect(check(unlocked("SELECT U&'d\\0061ta' FROM audit_x")).problems).toEqual([])
    // Inside the body of a function or of a block, dollar-quoted or single-quoted, it is refused as well.
    const bodies = [
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN UPDATE U&"\\0075sers" SET is_admin = TRUE; END $$ LANGUAGE plpgsql',
      'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS \'BEGIN UPDATE u&"\\0075sers" SET is_admin = TRUE; END\'',
      'DO $body$ BEGIN DELETE FROM U&"user_r\\006Fles"; END $body$',
    ]
    for (const statement of bodies) {
      const result = check(unlocked(statement))
      expect(result.verdicts.map((line) => line.verdict), statement).toEqual(['unreadable'])
      expect(result.problems[0], statement).toMatch(/^unreadable (?:CREATE|DO): identifier written with unicode escapes$/)
    }
    expect(check(unlocked('CREATE FUNCTION f() RETURNS void AS $$ BEGIN UPDATE audit_x SET note = U&\'d\\0061ta\'; END $$ LANGUAGE plpgsql')).problems).toEqual([])
  })

  it('every table of a TRUNCATE list is judged, past an item in another schema', () => {
    expect(check(locked('TRUNCATE audit_x, other.thing, user_roles')).problems).toEqual([MEMBERSHIP])
    expect(check(locked('TRUNCATE other.thing, user_roles')).problems).toEqual([MEMBERSHIP])
    expect(check(unlocked('TRUNCATE other.thing, role_permissions')).problems).toEqual(['missing world lock try form'])
    expect(check(unlocked('TRUNCATE audit_x, other.thing, role_permissions')).problems).toEqual(['missing world lock try form'])
    // In a file that is not new as well: the write is one the scan reports.
    expect(check(locked('TRUNCATE audit_x, "other" . thing, user_roles'), historicalMigrationFiles().find((file) => file.endsWith('.ts'))!, false).problems).toEqual([MEMBERSHIP])
    expect(check(locked('TRUNCATE other.thing, role_permissions')).problems).toEqual([])
    expect(check(unlocked('TRUNCATE TABLE ONLY audit_x *, "public"."user_permissions" CASCADE')).problems).toEqual(['missing world lock try form'])
    expect(check(locked('TRUNCATE TABLE ONLY audit_x *, "public"."user_permissions" CASCADE')).problems).toEqual([])
  })

  it('a table of a TRUNCATE list written with another schema is judged by its name', () => {
    const alone = check(locked('TRUNCATE audit_x, app.user_roles'))
    expect(alone.verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
    expect(alone.problems).toEqual([MEMBERSHIP])
    expect(check(locked('TRUNCATE role_permissions, app.user_roles')).problems).toEqual([MEMBERSHIP])
    expect(check(locked('TRUNCATE role_permissions, app.user_roles, ${t}'.replace('${t}', "'x'"))).problems).toEqual([MEMBERSHIP, 'unreadable TRUNCATE: write target is not readable'])
  })

  it('SELECT INTO under an input table name creates that table; into another name, or into a variable of a block, it is a read', () => {
    for (const statement of ['SELECT * INTO TEMP user_roles FROM roles', 'SELECT id INTO TABLE public.users FROM staging', 'WITH s AS (SELECT 1 AS id) SELECT id INTO UNLOGGED role_permissions FROM s']) {
      const result = check(unlocked(statement))
      expect(result.verdicts.map((line) => line.verdict), statement).toEqual(['unreadable'])
      expect(result.problems, statement).toEqual(['unreadable SELECT INTO: creates a table under an input table name'])
    }
    expect(check(unlocked('SELECT user_id INTO audit_copy FROM user_roles')).problems).toEqual([])
    expect(check(unlocked('DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM user_roles; END $$')).problems).toEqual([])
  })

  it('a TRUNCATE list is read from the verb: an input table after an item that is not a plain name is a write the scan reports, and requires the lock block', () => {
    const historical = historicalMigrationFiles().find((file) => file.endsWith('.ts'))!
    for (const statement of ['TRUNCATE "audit log", role_permissions', 'TRUNCATE TABLE ONLY "audit log" *, public.user_permissions CASCADE']) {
      const without = check(unlocked(statement))
      expect(without.problems, statement).toEqual(['missing world lock try form'])
      expect(without.inputWrites, statement).toBe(1)
      expect(check(locked(statement)).problems, statement).toEqual([])
      expect(check(unlocked(statement), historical, false).problems, statement).toEqual(['missing world lock try form'])
    }
    expect(check(locked('TRUNCATE "audit log", user_roles')).problems).toEqual([MEMBERSHIP])
    // After a substituted first item as well, whose own verdict a registered exemption sets aside.
    const line = 'await sql`TRUNCATE ${sql.table(tableName)}, role_permissions`.execute(db)'
    const cover: AuthorizationInputDynamicExemption = { id: 'T-1', file: NEW_TS, form: 'template_substitution', count: 1, reachableTables: ['audit_x'], reason: 'case' }
    const without = checkNewMigration(NEW_TS, up(line), true, [cover])
    expect(without.problems).toEqual(['missing world lock try form'])
    expect(without.inputWrites).toBe(1)
    expect(checkNewMigration(NEW_TS, lockedCode(line), true, [cover]).problems).toEqual([])
    expect(checkNewMigration(NEW_TS, lockedCode(line), true, []).problems).toEqual(['unreadable TRUNCATE: dynamic write target'])
  })

  it('an input table written with another schema is a write of the table it names and requires the lock block, though the scan does not report it', () => {
    const historical = historicalMigrationFiles().find((file) => file.endsWith('.ts'))!
    const statements = [
      'TRUNCATE app.role_permissions',
      "DELETE FROM app.role_permissions WHERE role_id = 'x'",
      "INSERT INTO app.user_namespace_admissions (user_id, namespace, enabled) VALUES ('u', 'crm', true)",
      "UPDATE app.users SET role = 'user'",
    ]
    for (const statement of statements) {
      const without = check(unlocked(statement))
      expect(without.problems, statement).toEqual(['missing world lock try form'])
      expect(without.inputWrites, statement).toBe(0)
      expect(check(locked(statement)).problems, statement).toEqual([])
      expect(check(unlocked(statement), historical, false).problems, statement).toEqual(['missing world lock try form'])
    }
    // An update of the other columns of an account, and a copy out, write no input.
    expect(check(unlocked('UPDATE app.users SET email = lower(email)')).problems).toEqual([])
    expect(check(unlocked("UPDATE users SET email = lower(email) WHERE role = 'user'")).problems).toEqual([])
    expect(check(unlocked('COPY app.users TO STDOUT')).problems).toEqual(['unreadable COPY: COPY on users has no readable form'])
  })
})

describe('a write target of three or more parts is not read', () => {
  const refused = (kind: string) => [`unreadable ${kind}: write target has more than two parts`]
  const cover: AuthorizationInputDynamicExemption = { id: 'T-1', file: NEW_TS, form: 'template_substitution', count: 1, reachableTables: ['audit_x'], reason: 'case' }

  const writes: Array<[string, string, string]> = [
    ['an insert of a membership', "INSERT INTO metasheet.public.user_roles (user_id, role_id) VALUES ('u1', 'admin')", 'INSERT'],
    ['an update of an account', 'UPDATE metasheet.public.users SET is_admin = TRUE', 'UPDATE'],
    ['a delete of memberships', 'DELETE FROM metasheet.public.user_roles', 'DELETE'],
    ['a delete with every part quoted', 'DELETE FROM "metasheet"."public"."role_permissions"', 'DELETE'],
    ['a delete whose first part is not a plain name', 'DELETE FROM "my db".public.role_permissions', 'DELETE'],
    ['a name that begins with the usual schema', 'DELETE FROM public.role_permissions.archived', 'DELETE'],
    ['an update of the key of a cascade parent', "UPDATE metasheet.public.roles SET id = 'ops_admin' WHERE id = 'ops_lead'", 'UPDATE'],
    ['a write inside a CTE of a read', 'WITH x AS (DELETE FROM metasheet.public.user_roles RETURNING 1) SELECT 1 FROM x', 'WITH'],
    ['an item of a TRUNCATE list', 'TRUNCATE audit_x, metasheet.public.user_roles', 'TRUNCATE'],
  ]
  for (const [name, statement, kind] of writes) {
    it(`${name} is unreadable, with or without the lock block`, () => {
      for (const source of [locked(statement), unlocked(statement)]) {
        const result = check(source)
        expect(result.verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
        expect(result.problems).toEqual(refused(kind))
        expect(result.inputWrites).toBe(0)
      }
    })
  }

  it('a substituted part does not make it readable, and no exemption covers it', () => {
    const source = lockedCode('await sql`DELETE FROM ${sql.id(database)}.public.user_roles`.execute(db)')
    expect(checkNewMigration(NEW_TS, source, true, []).problems).toEqual(refused('DELETE'))
    expect(checkNewMigration(NEW_TS, source, true, [cover]).problems).toEqual(refused('DELETE'))
    const last = lockedCode('await sql`DELETE FROM metasheet.public.${sql.id(table)}`.execute(db)')
    expect(checkNewMigration(NEW_TS, last, true, [cover]).problems).toEqual(refused('DELETE'))
  })

  const named: Array<[string, string, string]> = [
    ['an inheritance parent', 'CREATE TABLE users_shadow () INHERITS (metasheet.public.users)', 'unreadable CREATE TABLE: INHERITS names a table that is not readable'],
    ['a partition parent', "CREATE TABLE user_roles_2027 PARTITION OF metasheet.public.user_roles FOR VALUES IN ('a')", 'unreadable CREATE TABLE: PARTITION OF names a table that is not readable'],
    ['an inheritance parent added to a table', 'ALTER TABLE audit_x INHERIT metasheet.public.users', 'unreadable ALTER TABLE: INHERIT names a table that is not readable'],
    ['a table attached as a partition', "ALTER TABLE audit_x ATTACH PARTITION metasheet.public.user_roles FOR VALUES IN ('a')", 'unreadable ALTER TABLE: ATTACH PARTITION names a table that is not readable'],
    ['the table a partition is attached to', "ALTER TABLE metasheet.public.user_roles ATTACH PARTITION audit_x FOR VALUES IN ('a')", 'unreadable ALTER TABLE: table is not readable'],
    ['a created table', 'CREATE TABLE metasheet.public.user_roles (user_id text, role_id text)', 'unreadable CREATE TABLE: table is not readable'],
    ['a dropped table', 'DROP TABLE IF EXISTS metasheet.public.user_roles', 'unreadable DROP TABLE: table is not readable'],
    ['a table created by SELECT INTO', 'SELECT id INTO metasheet.public.users FROM staging', 'unreadable SELECT INTO: creates a table whose name has more than two parts'],
  ]
  for (const [name, statement, problem] of named) {
    it(`${name} named with three parts is unreadable`, () => {
      const result = check(unlocked(statement))
      expect(result.verdicts.map((line) => line.verdict)).toEqual(['unreadable'])
      expect(result.problems).toEqual([problem])
    })
  }

  it('a name of two parts is still read as schema and table, and a name of three parts that spells no scanned table is not judged', () => {
    expect(check(locked("DELETE FROM public.role_permissions WHERE role_id = 'x'")).problems).toEqual([])
    expect(check(unlocked('CREATE TABLE audit_y () INHERITS (public.audit_base)')).problems).toEqual([])
    expect(check(unlocked('DELETE FROM warehouse.reporting.daily_totals')).problems).toEqual([])
    expect(check(unlocked("UPDATE metasheet.public.audit_x SET note = 'roles'")).problems).toEqual([])
  })
})

describe('a table written after a substituted schema is read as the table it names', () => {
  const MEMBERSHIP = 'writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'
  const cover: AuthorizationInputDynamicExemption = { id: 'T-1', file: NEW_TS, form: 'template_substitution', count: 1, reachableTables: ['audit_x'], reason: 'case' }
  const line = (statement: string) => 'await sql`' + statement.replace(/\$\{s\}/g, '${sql.id(schema)}') + '`.execute(db)'

  const inputs: Array<[string, string, string[]]> = [
    ['an insert of a membership', "INSERT INTO ${s}.user_roles (user_id, role_id) VALUES ('u1', 'admin')", [MEMBERSHIP]],
    ['an account made an administrator', 'UPDATE ${s}.users SET is_admin = TRUE', ['sets is_admin']],
    ['a raising code granted to a role', "INSERT INTO ${s}.role_permissions (role_id, permission_code) VALUES ('viewer', 'users:write')", ['grants class-raising code users:write']],
    ['a delete of role grants', "DELETE FROM ${s}.role_permissions WHERE role_id = 'x'", []],
  ]
  for (const [name, statement, problems] of inputs) {
    it(`${name} is one write of the input table, judged by its rules; the substitution keeps its own verdict`, () => {
      const head = statement.split(' ')[0]
      const withLock = lockedCode(line(statement))
      expect(checkNewMigration(NEW_TS, withLock, true, [cover]).problems).toEqual(problems)
      expect(checkNewMigration(NEW_TS, withLock, true, []).problems).toEqual([`unreadable ${head}: dynamic write target`, ...problems])
      const without = checkNewMigration(NEW_TS, up(line(statement)), true, [cover])
      expect(without.problems).toEqual(['missing world lock try form', ...problems])
      expect(without.inputWrites).toBe(1)
    })
  }

  it('the key of a cascade parent written that way is refused, with or without an exemption for the substitution', () => {
    const source = up(line("UPDATE ${s}.roles SET id = 'ops_admin' WHERE id = 'ops_lead'"))
    expect(checkNewMigration(NEW_TS, source, true, [cover]).problems).toEqual(['unreadable UPDATE: assigns a key column of roles'])
    expect(checkNewMigration(NEW_TS, source, true, []).problems).toEqual(['unreadable UPDATE: dynamic write target', 'unreadable UPDATE: assigns a key column of roles'])
    expect(checkNewMigration(NEW_TS, up(line("UPDATE ${s}.roles SET name = 'x' WHERE id = 'r'")), true, [cover]).problems).toEqual([])
  })

  it('a table that is not scanned stays a dynamic target and nothing more', () => {
    const source = up(line('DELETE FROM ${s}.audit_x WHERE id = 1'))
    expect(checkNewMigration(NEW_TS, source, true, []).problems).toEqual(['unreadable DELETE: dynamic write target'])
    expect(checkNewMigration(NEW_TS, source, true, [cover]).problems).toEqual([])
  })

  it('an inheritance parent written that way is read as the table it names', () => {
    const source = up('await sql`CREATE TABLE users_shadow () INHERITS (${sql.id(schema)}.users)`.execute(db)')
    expect(check(source).problems).toEqual(['unreadable CREATE TABLE: INHERITS names the input table users'])
  })
})

describe('dynamic targets and registered exemptions', () => {
  const exemptionFor = (form: AuthorizationInputDynamicExemption['form'], overrides: Partial<AuthorizationInputDynamicExemption> = {}): AuthorizationInputDynamicExemption => ({ id: 'T-1', file: NEW_TS, form, count: 1, reachableTables: ['audit_x'], reason: 'case', ...overrides })
  const checkWith = (source: string, ...exemptions: AuthorizationInputDynamicExemption[]) => checkNewMigration(NEW_TS, source, true, exemptions)
  const HELPER_IMPORT = "import { checkTableExists } from './_patterns'"
  const sources: Array<[AuthorizationInputDynamicExemption['form'], string, string]> = [
    ['template_substitution', up('await sql`DELETE FROM ${sql.table(tableName)} WHERE id = 1`.execute(db)'), 'unreadable DELETE: dynamic write target'],
    ['concatenation', up("await db.query('DELETE FROM ' + tableName + ' WHERE id = 1')"), 'unreadable DELETE: dynamic write target'],
    ['query_builder_non_literal', up('await db.deleteFrom(tableName).execute()'), 'unreadable DELETE: dynamic write target'],
    ['helper_table_argument', `${HELPER_IMPORT}\nexport async function up(db, tableName) {\nawait checkTableExists(db, tableName)\n}`, 'unreadable helper:checkTableExists: table argument is not a plain table name'],
    ['dynamic_statement', unlocked("DO $$ BEGIN EXECUTE format('DELETE FROM %I', t); END $$"), 'unreadable EXECUTE: dynamic statement'],
  ]

  for (const [form, source, problem] of sources) {
    it(`a ${form} target is refused without an exemption and accepted with one registered for the file, the form and the exact count`, () => {
      expect(checkWith(source).problems).toEqual([problem])
      expect(checkWith(source, exemptionFor(form)).problems).toEqual([])
      expect(checkWith(source, exemptionFor(form, { file: `${MIG}/zzzz20270101000001_other.ts` })).problems).toEqual([problem])
      expect(checkWith(source, exemptionFor(form, { count: 2 })).problems).toEqual([problem])
      expect(checkWith(source, exemptionFor(form === 'concatenation' ? 'template_substitution' : 'concatenation')).problems).toEqual([problem])
      // Two entries of the form add up.
      expect(checkWith(`${source}\n`, exemptionFor(form, { count: 1 }), exemptionFor(form, { id: 'T-2', count: 0 })).problems).toEqual([])
    })
  }

  it('an exemption that reaches an input table or a cascade parent, or names no reachable table, covers nothing', () => {
    const [form, source, problem] = sources[0]
    for (const reachableTables of [['users'], ['audit_x', 'ROLES'], ['user_roles'], []]) {
      expect(checkWith(source, exemptionFor(form, { reachableTables })).problems, JSON.stringify(reachableTables)).toEqual([problem])
    }
    // One entry of the form that reaches an input withdraws the cover of the others.
    expect(checkWith(source, exemptionFor(form, { count: 1 }), exemptionFor(form, { id: 'T-2', count: 0, reachableTables: ['users'] })).problems).toEqual([problem])
  })

  it('an exemption sets aside the dynamic verdict only: whatever else the statement does is still judged', () => {
    const cover = exemptionFor('template_substitution')
    const cases: Array<[string, string[]]> = [
      ["WITH x AS (UPDATE roles SET id = 'a' WHERE id = 'b' RETURNING 1) DELETE FROM ${t}", ['unreadable UPDATE: assigns a key column of roles']],
      ['WITH d AS (DELETE FROM ${t} RETURNING 1) DELETE FROM app.user_roles', ['unreadable WITH: DELETE on user_roles inside another statement']],
      ['TRUNCATE ${t}, user_roles', ['writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool']],
      ['TRUNCATE ${t}, ${t}', ['unreadable TRUNCATE: write target is not readable']],
      ["INSERT INTO ${t} SELECT * FROM audit_x WHERE note = 'user_roles'", []],
      ['INSERT INTO ${t} (user_id) SELECT user_id FROM user_roles', []],
      ['CREATE VIEW v AS WITH d AS (DELETE FROM ${t} RETURNING 1) SELECT * FROM users', ['unreadable CREATE VIEW: defines an object over an input table']],
      ['INSERT INTO $1 SELECT user_id FROM user_roles WHERE EXISTS (WITH d AS (DELETE FROM ${t} RETURNING 1) SELECT 1 FROM d)', ['unreadable INSERT: write target is not readable']],
    ]
    for (const [statement, problems] of cases) {
      const source = lockedCode('await sql`' + statement.replace(/\$\{t\}/g, '${sql.table(tableName)}') + '`.execute(db)')
      const count = (statement.match(/(?:FROM|INTO|TRUNCATE) \$\{t\}/g) ?? []).length
      expect(checkWith(source, { ...cover, count }).problems, statement).toEqual(problems)
      expect(checkWith(source).problems, statement).toEqual(['unreadable ' + statement.split(' ')[0] + ': dynamic write target', ...problems])
    }
    // A dynamically executed statement whose text names an input table stays refused for that.
    const executed = unlocked("DO $$ BEGIN EXECUTE format('INSERT INTO %I (role_id, permission_code) VALUES (%L, %L)', 'role_permissions', r, c); END $$")
    expect(checkWith(executed, exemptionFor('dynamic_statement')).problems).toEqual(['unreadable EXECUTE: statement kind is not on the safe list'])
  })

  it('a substituted SET clause of a users UPDATE is never exempt', () => {
    const source = up('await sql`UPDATE users SET ${sql.ref(column)} = NULL`.execute(db)')
    expect(checkWith(source).problems).toEqual(['unreadable UPDATE: dynamic write target'])
    expect(checkWith(source, exemptionFor('users_update_dynamic_set'), exemptionFor('template_substitution', { id: 'T-2' })).problems).toEqual(['unreadable UPDATE: dynamic write target'])
  })

  it('the two migrations that carry a registered exemption are accepted as new files under their own path, and refused under another path or without the registry', () => {
    const controls: Array<[string, string]> = [
      [`${MIG}/zzzz20260724120000_create_attendance_shift_segments.ts`, 'unreadable INSERT: dynamic write target'],
      [`${MIG}/zzzz20260804120000_attendance_shift_flex_policy.ts`, 'unreadable UPDATE: dynamic write target'],
    ]
    for (const [file, problem] of controls) {
      expect(AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => exemption.file === file), file).toHaveLength(1)
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(checkNewMigration(file, source, true).problems, file).toEqual([])
      expect(checkNewMigration(file, source, true, []).problems, file).toEqual([problem])
      expect(checkNewMigration(NEW_TS, source, true).problems, file).toEqual([problem])
    }
  })
})

describe('migration helpers', () => {
  const HELPERS = "import { addColumnIfNotExists, addForeignKeyIfNotExists, checkColumnExists, checkTableExists, createIndexIfNotExists, createTableWithDefaults, createUpdatedAtTrigger, dropColumnIfExists, dropIndexIfExists, migrateDataSafely, renameColumnIfExists } from './_patterns'"
  const withHelpers = (...lines: string[]) => `${HELPERS}\nexport async function up(db) {\n${lines.join('\n')}\n}`

  const green: Array<[string, string]> = [
    ['a table check', "if (await checkTableExists(db, 'users')) return"],
    ['a column check', "await checkColumnExists(db, 'users', 'mobile')"],
    ['an ordinary column added', "await addColumnIfNotExists(db, 'users', 'nickname', 'text')"],
    ['an ordinary column added with options', "await addColumnIfNotExists(db, 'users', 'nickname', 'text', { notNull: true, defaultTo: '' })"],
    ['an ordinary column dropped', "await dropColumnIfExists(db, 'users', 'nickname')"],
    ['an ordinary column renamed', "await renameColumnIfExists(db, 'users', 'nickname', 'display_name')"],
    ['an index', "await createIndexIfNotExists(db, 'idx_x', 'user_roles', 'role_id')"],
    ['a unique index', "await createIndexIfNotExists(db, 'idx_users_email', 'users', 'email', { unique: true })"],
    ['an index dropped', "await dropIndexIfExists(db, 'idx_users_email')"],
    ['a foreign key from another table, with any action', "await addForeignKeyIfNotExists(db, 'fk_a', 'audit_x', 'user_id', 'users', 'id', { onDelete: 'cascade', onUpdate: 'cascade' })"],
    ['a foreign key on an input table without an update action', "await addForeignKeyIfNotExists(db, 'fk_b', 'user_roles', 'role_id', 'roles', 'id', { onDelete: 'cascade' })"],
    ['a column with a reference that keeps the key', "await addColumnIfNotExists(db, 'user_namespace_admissions', 'owner_id', 'text', { references: { table: 'users', column: 'id', onDelete: 'cascade' } })"],
    ['a walk over table names with for-of', "for (const table of ['roles', 'permissions', 'role_permissions', 'user_roles']) { if (!(await checkTableExists(db, table))) throw new Error('x') }"],
    ['a walk over table names with map', "await Promise.all(['roles', 'role_permissions'].map((table) => checkTableExists(db, table)))"],
    ['a trigger, a table and a data rewrite on other tables', "await createUpdatedAtTrigger(db, 'audit_x')\nawait createTableWithDefaults(db, 'audit_y', (t) => t)\nawait migrateDataSafely(db, 'audit_x', fn)"],
  ]
  for (const [name, line] of green) {
    it(`helper call: ${name} is accepted without the lock block`, () => {
      expect(check(withHelpers(line)).problems).toEqual([])
    })
  }

  const red: Array<[string, string, number?]> = [
    ['a sensitive column added', "await addColumnIfNotExists(db, 'users', 'is_admin', 'boolean', { defaultTo: true })"],
    ['a column whose name is not a literal', "await addColumnIfNotExists(db, 'users', columnName, 'text')"],
    ['a sensitive column dropped', "await dropColumnIfExists(db, 'users', 'role')"],
    ['a column renamed to a sensitive name', "await renameColumnIfExists(db, 'users', 'legacy_role', 'role')"],
    ['a column with a reference that has an update action', "await addColumnIfNotExists(db, 'user_namespace_admissions', 'owner_id', 'text', { references: { table: 'users', column: 'id', onUpdate: 'cascade' } })"],
    ['a trigger on an input table', "await createUpdatedAtTrigger(db, 'users')"],
    ['an input table created', "await createTableWithDefaults(db, 'user_roles', (t) => t)"],
    ['a data rewrite of an input table', "await migrateDataSafely(db, 'role_permissions', fn)"],
    ['a data rewrite of a cascade parent', "await migrateDataSafely(db, 'roles', fn)"],
    ['a table argument that is not a plain name', "await checkTableExists(db, 'users; x')"],
    ['a table argument that is not a literal', 'await checkTableExists(db, tableName)'],
    ['a call outside the map that receives an input table name', "await backfill(db, 'user_roles')"],
    ['a walk whose variable reaches another helper', "for (const t of ['users']) await createUpdatedAtTrigger(db, t)", 2],
    ['a walk whose variable reaches a call outside the map', "for (const t of ['users']) await backfill(db, t)"],
    ['a builder that adds a column to an input table', "await db.schema.alterTable('users').addColumn('nickname', 'text').execute()"],
    ['a foreign key on an input table with an update action', "await addForeignKeyIfNotExists(db, 'fk_x', 'user_roles', 'role_id', 'roles', 'id', { onUpdate: 'cascade' })"],
    ['foreign-key options that are spread', "await addForeignKeyIfNotExists(db, 'fk_x', 'user_roles', 'role_id', 'roles', 'id', { ...opts })"],
    ['a foreign-key option that is not a literal', "await addForeignKeyIfNotExists(db, 'fk_x', 'user_roles', 'role_id', 'roles', 'id', { onUpdate: mode })"],
    ['column options that are not an object literal', "await addColumnIfNotExists(db, 'users', 'nickname', 'text', options)"],
    ['a column option the map does not know', "await addColumnIfNotExists(db, 'users', 'nickname', 'text', { generatedAs: 'x' })"],
  ]
  for (const [name, line, count] of red) {
    it(`helper call: ${name} is unreadable`, () => {
      const result = check(withHelpers(line))
      expect(result.verdicts.map((entry) => entry.verdict)).toEqual(Array.from({ length: count ?? 1 }, () => 'unreadable'))
    })
  }

  describe('table and column arguments given as constants of the file', () => {
    const withConstant = (declaration: string, ...lines: string[]) => `${HELPERS}\n${declaration}\nexport async function up(db) {\n${lines.join('\n')}\n}`

    const accepted: Array<[string, string]> = [
      ['a table check', withConstant("const TABLE_NAME = 'audit_x'", 'if (await checkTableExists(db, TABLE_NAME)) return')],
      ['a column added', withConstant("const TABLE_NAME = 'audit_x' as const", "await addColumnIfNotExists(db, TABLE_NAME, 'note', 'text')")],
      ['an index', withConstant('const TABLE_NAME = `audit_x`', "await createIndexIfNotExists(db, 'idx_audit_x_note', TABLE_NAME, 'note')")],
      ['an ordinary column of an input table named by a constant', withConstant("const COLUMN = 'nickname'", "await addColumnIfNotExists(db, 'users', COLUMN, 'text')", "await dropColumnIfExists(db, 'users', COLUMN)")],
    ]
    for (const [name, source] of accepted) {
      it(`${name} on a table that is not an input is accepted`, () => {
        expect(check(source).problems).toEqual([])
      })
    }

    const refused: Array<[string, string, string]> = [
      ['a parameter', `${HELPERS}\nexport async function up(db, TABLE_NAME) {\nawait checkTableExists(db, TABLE_NAME)\n}`, 'unreadable helper:checkTableExists: table argument is not a plain table name'],
      ['an imported name', `${HELPERS}\nimport { TABLE_NAME } from './names'\nexport async function up(db) {\nawait checkTableExists(db, TABLE_NAME)\n}`, 'unreadable helper:checkTableExists: table argument is not a plain table name'],
      ['a constant shadowed by a parameter', `${HELPERS}\nconst TABLE_NAME = 'audit_x'\nasync function touch(db, TABLE_NAME) {\nawait addColumnIfNotExists(db, TABLE_NAME, 'note', 'text')\n}\nexport async function up(db) {\nawait touch(db, 'users')\n}`, 'unreadable helper:addColumnIfNotExists: table argument is not a plain table name'],
      ['a let binding', withConstant("let TABLE_NAME = 'audit_x'", 'await checkTableExists(db, TABLE_NAME)'), 'unreadable helper:checkTableExists: table argument is not a plain table name'],
      ['a property of an object', withConstant("const TABLES = { audit: 'audit_x' }", 'await checkTableExists(db, TABLES.audit)'), 'unreadable helper:checkTableExists: table argument is not a plain table name'],
      ['a constant that names an input table', withConstant("const TABLE_NAME = 'users'", 'await checkTableExists(db, TABLE_NAME)'), 'unreadable USERS: statement kind is not on the safe list'],
      ['a sensitive column named by a constant', withConstant("const COLUMN = 'role'", "await dropColumnIfExists(db, 'users', COLUMN)"), 'unreadable helper:dropColumnIfExists: drops a sensitive column or a column that is not a plain name'],
      ['a column named by a parameter', `${HELPERS}\nexport async function up(db, COLUMN) {\nawait dropColumnIfExists(db, 'users', COLUMN)\n}`, 'unreadable helper:dropColumnIfExists: drops a sensitive column or a column that is not a plain name'],
    ]
    for (const [name, source, problem] of refused) {
      it(`${name} is unreadable`, () => {
        expect(check(source).problems).toContain(problem)
        expect(check(source).verdicts.every((line) => line.verdict === 'unreadable')).toBe(true)
      })
    }

    it('a constant that names an input table is refused by its declaration, and the call that uses it is judged on that table', () => {
      expect(check(withConstant("const TABLE_NAME = 'users'", 'await checkTableExists(db, TABLE_NAME)')).problems).toEqual(['unreadable USERS: statement kind is not on the safe list'])
      expect(check(withConstant("const TABLE_NAME = 'users'", 'await createUpdatedAtTrigger(db, TABLE_NAME)')).problems).toEqual(['unreadable USERS: statement kind is not on the safe list', 'unreadable helper:createUpdatedAtTrigger: creates a trigger on an input table'])
      expect(check(withConstant("const TABLE_NAME = 'audit_x'", 'await createUpdatedAtTrigger(db, TABLE_NAME)')).problems).toEqual([])
    })
  })

  it('a helper is recognised by its binding: a local function of the same name and a renamed import are not mapped', () => {
    const local = "export async function up(db) {\nawait addColumnIfNotExists(db, 'users', 'nickname', 'text')\n}\nasync function addColumnIfNotExists(db, t, c) { return [db, t, c] }"
    expect(verdicts(local)).toEqual(['unreadable'])
    const renamed = "import { addColumnIfNotExists as addCol } from './_patterns'\nexport async function up(db) {\nawait addCol(db, 'users', 'nickname', 'text')\n}"
    expect(verdicts(renamed)).toEqual(['unreadable'])
    const otherModule = "import { addColumnIfNotExists } from './other'\nexport async function up(db) {\nawait addColumnIfNotExists(db, 'users', 'nickname', 'text')\n}"
    expect(verdicts(otherModule)).toEqual(['unreadable'])
    const shadowed = `${HELPERS}\nexport async function up(db, checkTableExists) {\nawait checkTableExists(db, 'users')\n}`
    expect(verdicts(shadowed)).toEqual(['unreadable'])
  })

  it('the helper map equals the exports of the helper module, name by name and parameter by parameter', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE), 'utf8')
    expect(helperMapProblems(source)).toEqual([])
    expect(Object.keys(AUTHORIZATION_INPUT_MIGRATION_HELPERS)).toHaveLength(11)
    expect(helperMapProblems(`${source}\nexport async function addCheckIfNotExists(db: unknown, tableName: string) { return [db, tableName] }`)).toEqual(['addCheckIfNotExists: exported helper without a rule'])
    expect(helperMapProblems(source.replace('export async function dropIndexIfExists', 'async function dropIndexIfExists'))).toEqual(['dropIndexIfExists: rule without an exported helper'])
    const swapped = source.replace(/(export async function createIndexIfNotExists<DB>\(\s*db: Kysely<DB>,\s*)indexName: string,(\s*)tableName: string,/, '$1tableName: string,$2indexName: string,')
    expect(swapped).not.toBe(source)
    expect(helperMapProblems(swapped)).toEqual(['createIndexIfNotExists: parameters are db,tableName,indexName,columns,options, expected db,indexName,tableName,columns,options'])
  })
})
