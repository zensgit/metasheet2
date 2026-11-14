/**
 * Closed-world guard over writers of the privilege-classifier inputs and their cascade parents.
 *
 * The scan reads the syntax tree of every production source and plugin file and matches write
 * statements only in string and template literals; its per-file, per-table, per-verb counts must
 * equal the writer registry, and every dynamic write target must be a registered exemption whose
 * reachable tables exclude the inputs. Migrations that write an input are frozen by path; a new one
 * must carry the bounded try form of the world lock and every one of its writes must be judged
 * safe (the cases of that judgment are in `authorization-input-migration-rules.guard.test.ts`). Script
 * trees are classified by path. The guard also pins: the two table allowlists of the generic bulk
 * routes item for item; that no production module imports a contract module; that no production
 * call joins a contract transaction; that the world-lock key appears only in its three statement
 * forms and its two declarations; the function-level conversion ratchet; the table list closure
 * between the classifier's statement and its table constant; the birth-only shape of the one
 * user insert that stays outside the contract; the closed set of callers that take a role row late;
 * and the identifiers a work closure may not reference, which include the pull-source organisation
 * lock and the functions of its write gate.
 *
 * The table list closure has one exception, and only one: the service reader left-joins `roles` to
 * show the name of each role a permission is inherited from. No decision reads `roles`. The exception
 * is pinned by shape (`ROLE_NAME_JOIN`): one mention, that join clause, its alias read only as the
 * selected name, inside that one statement. Any other writing of the table in a reader is a problem.
 *
 * Every pattern has a positive control on a real file mutated in memory, and every negative control
 * states what the scan deliberately does not count.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PRIVILEGE_GRANT_SOURCE_TABLES } from '../../src/auth/security-action-privilege'
import {
  AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_FROZEN_MIGRATIONS,
  AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS,
  AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM,
  AUTHORIZATION_INPUT_SCRIPT_CLASSES,
  AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET,
  AUTHORIZATION_INPUT_WORKFLOW_FIXTURES,
  AUTHORIZATION_INPUT_WRITERS,
  hasPendingWriters,
  registeredWriteCounts,
} from '../../src/rbac/authorization-input-writers'
import type { AuthorizationInputDynamicExemption, AuthorizationInputLateRoleRowCaller, AuthorizationInputWriterEntry } from '../../src/rbac/authorization-input-writers'
import { AUTHORIZATION_INPUT_TAKEOVER_CALLERS, AUTHORIZATION_INPUT_WORLD_LOCK_KEY1 } from '../../src/rbac/authorization-input-lock'
import {
  checkNewMigration,
  COMPLIANT_LOCK_BLOCK,
  exemptDynamicForms,
  isMigrationPath,
  JUDGED_ONLY_DYNAMIC_FORMS,
  judgedOnlyExemptionProblems,
  migrationRuleProblems,
  reachableTableProblems,
  traversalProblems,
} from '../helpers/authorization-input-migration-rules'
import {
  CASCADE_PARENT_TABLES,
  enclosingFunctionAt,
  INPUT_TABLES,
  isTestPath,
  listFiles,
  literalTexts,
  queryReceiverAt,
  scanFiles,
  scanSource,
  SCANNED_DYNAMIC_FORMS,
  SCANNED_TABLES,
  SOURCE_EXTENSIONS,
  tally,
} from '../helpers/authorization-input-scan'
import type { DynamicTarget, LiteralWrite } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const CONTRACT_MODULES = ['brand', 'classes', 'lock', 'writers', 'consumers'].map((name) => `${SRC}/rbac/authorization-input-${name}.ts`)
const LOCK_MODULE = `${SRC}/rbac/authorization-input-lock.ts`
const KEY_REGISTRY_MODULE = `${SRC}/attendance/coordination/settlement-coordination-key.ts`
const CLASSIFIER_MODULE = `${SRC}/auth/security-action-privilege.ts`
const CONTROL_FILE = `${SRC}/routes/attendance-admin.ts`
const CONTROL_NEEDLE = 'const ATTENDANCE_ROLE_ID_BOUND'

const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')

const PRODUCTION = { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] }
const MIGRATIONS = { roots: [`${SRC}/db/migrations`, 'packages/core-backend/migrations'], exclude: [] }
const SCRIPTS = { roots: ['packages/core-backend/scripts', 'scripts'], exclude: [] }
const WORKFLOWS = { roots: ['.github/workflows'], exclude: [] }
const ALL_ROOTS = { roots: [SRC, 'plugins', 'packages/core-backend/scripts', 'scripts', 'packages/core-backend/migrations', '.github/workflows'], exclude: [] }

const productionFiles = listFiles(REPO_ROOT, PRODUCTION)
const production = scanFiles(REPO_ROOT, productionFiles.filter((file) => !CONTRACT_MODULES.includes(file)))
const contractScan = scanFiles(REPO_ROOT, CONTRACT_MODULES)
const migrations = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, MIGRATIONS))
const scripts = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, SCRIPTS))
const workflows = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, WORKFLOWS))

function byFileAndForm(targets: readonly DynamicTarget[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const target of targets) counts.set(`${target.file}|${target.form}`, (counts.get(`${target.file}|${target.form}`) ?? 0) + 1)
  return counts
}

function sortedEntries(map: ReadonlyMap<string, number>): Array<[string, number]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

describe('domain floor', () => {
  it('the scan reads the real trees and the files the registry names', () => {
    expect(productionFiles.length).toBeGreaterThan(900)
    expect(productionFiles.some((file) => file.startsWith('plugins/'))).toBe(true)
    expect(productionFiles).toContain('plugins/plugin-attendance/index.cjs')
    for (const required of [`${SRC}/rbac/role-assignment.ts`, `${SRC}/routes/roles.ts`, `${SRC}/routes/permissions.ts`, `${SRC}/routes/admin-users.ts`, `${SRC}/routes/admin-routes.ts`, ...CONTRACT_MODULES]) {
      expect(productionFiles).toContain(required)
    }
    for (const writer of AUTHORIZATION_INPUT_WRITERS) expect(fs.existsSync(path.join(REPO_ROOT, writer.file)), writer.file).toBe(true)
    expect(migrations.files.length).toBeGreaterThan(400)
    expect(scripts.files.length).toBeGreaterThan(300)
    expect(workflows.files.length).toBeGreaterThan(50)
    expect(productionFiles.some(isTestPath)).toBe(false)
  })

  it('the scanned table set is the classifier\'s table constant plus the four cascade parents', () => {
    expect([...INPUT_TABLES]).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES])
    expect([...CASCADE_PARENT_TABLES].sort()).toEqual(['directory_departments', 'permissions', 'platform_member_groups', 'roles'])
    expect(SCANNED_TABLES.size).toBe(11)
  })
})

describe('production writers equal the registry', () => {
  it('per file, table and verb, the literal write counts equal the registered counts', () => {
    const scanned = sortedEntries(tally(production.writes))
    const registered = sortedEntries(registeredWriteCounts())
    expect(scanned).toEqual(registered)
    expect(scanned.length).toBeGreaterThan(40)
  })

  it('the contract modules issue exactly one write: the birth insert of the lock module', () => {
    expect(contractScan.writes.map((write) => [write.file, write.table, write.verb])).toEqual([[LOCK_MODULE, 'users', 'INSERT']])
    expect(contractScan.dynamic).toEqual([])
  })

  it('every registered symbol is still present in its file', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      const source = read(writer.file)
      const callee = writer.symbol.startsWith('callback:') ? writer.symbol.slice('callback:'.length) : writer.symbol
      expect(source, `${writer.id} ${writer.symbol}`).toContain(`${callee}(`)
    }
  })

  it('every dynamic target is a registered exemption or the pinned allowlist route, and no exemption reaches an input', () => {
    const expected = new Map<string, number>()
    for (const exemption of AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((e) => !e.file.includes('/db/migrations/'))) expected.set(`${exemption.file}|${exemption.form}`, exemption.count)
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      if (!writer.dynamic) continue
      const key = `${writer.file}|${writer.dynamic.form}`
      expected.set(key, (expected.get(key) ?? 0) + writer.dynamic.count)
    }
    expect(sortedEntries(byFileAndForm(production.dynamic))).toEqual(sortedEntries(expected))
    const registered = [...AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS, ...AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS]
    expect(reachableTableProblems(registered, AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)).toEqual([])
    for (const exemption of registered) {
      expect(exemption.reachableTables.length, exemption.id).toBeGreaterThan(0)
      expect(exemption.reason.length).toBeGreaterThan(0)
    }
  })

  it('the one exemption of the migration helper module is pinned, and sets no verdict aside when a migration is judged', () => {
    const ofHelper = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => exemption.file === AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    expect(ofHelper.map((exemption) => [exemption.form, exemption.count, [...exemption.reachableTables]])).toEqual([['query_builder_non_literal', 1, ['<migration helper parameter>']]])
    expect([...exemptDynamicForms(AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, new Map([['query_builder_non_literal', 1]]), AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS)]).toEqual([])
    // Every other exemption under the migration streams covers its form in its own file.
    const others = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => isMigrationPath(exemption.file) && exemption.file !== AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    expect(others.length).toBeGreaterThan(0)
    for (const exemption of others) expect([...exemptDynamicForms(exemption.file, new Map([[exemption.form, exemption.count]]), AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS)], exemption.id).toEqual([exemption.form])
  })

  it('POSITIVE CONTROL — an exemption that reaches an input table or a cascade parent under another spelling, and a migration exemption that names a pattern, are problems', () => {
    const virtual = (id: string, file: string, reachableTables: string[]): AuthorizationInputDynamicExemption => ({ id, file, form: 'template_substitution', count: 1, reachableTables, reason: 'control' })
    const sourceFile = `${SRC}/admin/user-recycle.ts`
    const migration = `${SRC}/db/migrations/zzzz20270101000000_control.ts`
    const legacy = 'packages/core-backend/migrations/999_control.sql'
    const problemsOf = (...exemptions: AuthorizationInputDynamicExemption[]) => reachableTableProblems(exemptions, AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    for (const [spelling, name] of [['users', 'users'], ['public.users', 'users'], ['"users"', 'users'], [' users', 'users'], ['user_roles ', 'user_roles'], ['"PUBLIC" . "Roles"', 'roles'], ['metasheet.public.permissions', 'permissions']]) {
      expect(problemsOf(virtual('V-1', sourceFile, ['audit_logs', spelling])), spelling).toEqual([`V-1: reaches ${name}`])
      expect(problemsOf(virtual('V-1', migration, [spelling])), spelling).toEqual([`V-1: reaches ${name}`])
    }
    for (const spelling of ['*', '<any table>', 'integration_*', 'audit logs', '']) {
      expect(problemsOf(virtual('V-2', migration, [spelling])), spelling).toEqual([`V-2: ${spelling} is not a plain table name`])
      expect(problemsOf(virtual('V-2', legacy, ['audit_x', spelling])), spelling).toEqual([`V-2: ${spelling} is not a plain table name`])
      // Outside the migration streams a reachable set may be a pattern: it sets no verdict aside there.
      expect(problemsOf(virtual('V-2', sourceFile, [spelling])), spelling).toEqual([])
    }
    expect(problemsOf(virtual('V-3', migration, ['audit_x', 'public.audit_y', '"Audit_Z"']))).toEqual([])
    // The helper module's own entry is the one place a placeholder stands under the migration streams.
    expect(problemsOf(virtual('V-4', AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, ['<migration helper parameter>']))).toEqual([])
    expect(problemsOf(virtual('V-4', AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, ['users']))).toEqual(['V-4: reaches users'])
  })

  it('a `D` entry registers no literal statements and every other entry registers at least one', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      if (writer.class === 'D') {
        expect(writer.statements).toEqual([])
        expect(writer.dynamic).toBeDefined()
      } else {
        expect(writer.statements.length, writer.id).toBeGreaterThan(0)
        expect(writer.dynamic).toBeUndefined()
      }
    }
    expect(new Set(AUTHORIZATION_INPUT_WRITERS.map((writer) => writer.id)).size).toBe(AUTHORIZATION_INPUT_WRITERS.length)
  })

  it('every writer declares whether it has a human operator, with one of the two values', () => {
    const values: readonly string[] = ['human', 'n/a']
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      expect(Object.hasOwn(writer, 'actor'), writer.id).toBe(true)
      expect(values, writer.id).toContain(writer.actor)
    }
    expect(AUTHORIZATION_INPUT_WRITERS.length).toBeGreaterThan(30)
  })

  it('the registry is still entirely pending: no production caller uses the contract yet', () => {
    expect(hasPendingWriters()).toBe(true)
    expect(AUTHORIZATION_INPUT_WRITERS.filter((writer) => writer.status === 'converted')).toEqual([])
    expect(AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET.status).toBe('pending')
  })
})

describe('scan controls', () => {
  const original = read(CONTROL_FILE)
  const mutate = (replacement: string) => scanSource(CONTROL_FILE, original.replace(CONTROL_NEEDLE, replacement))
  const baseline = scanSource(CONTROL_FILE, original)

  it('the control file carries the needle and matches only its registered writes', () => {
    expect(original).toContain(CONTROL_NEEDLE)
    expect(baseline.writes.map((w) => `${w.table}|${w.verb}`).sort()).toEqual(['permissions|INSERT', 'role_permissions|INSERT'])
    expect(baseline.dynamic).toEqual([])
  })

  const positives: Array<[string, string, string]> = [
    ['raw INSERT', "const x = 'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['raw DELETE', "const x = 'DELETE FROM user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['users UPDATE of an input column', "const x = 'UPDATE users SET is_admin = TRUE WHERE id = $1'", 'users|UPDATE'],
    ['TRUNCATE', "const x = 'TRUNCATE TABLE role_permissions'", 'role_permissions|TRUNCATE'],
    ['TRUNCATE without TABLE', "const x = 'TRUNCATE delegated_role_admin_scopes'", 'delegated_role_admin_scopes|TRUNCATE'],
    ['MERGE', "const x = 'MERGE INTO user_roles USING x ON (TRUE)'", 'user_roles|MERGE'],
    ['COPY FROM', "const x = 'COPY user_roles (user_id, role_id) FROM STDIN'", 'user_roles|COPY'],
    ['quoted identifier', 'const x = \'INSERT INTO "user_roles" (user_id) VALUES ($1)\'', 'user_roles|INSERT'],
    ['public. prefix', "const x = 'DELETE FROM public.user_roles'", 'user_roles|DELETE'],
    ['ONLY', "const x = 'UPDATE ONLY users SET role = $1'", 'users|UPDATE'],
    ['cascade parent delete', "const x = 'DELETE FROM roles WHERE id = $1'", 'roles|DELETE'],
    ['template literal', 'const x = `INSERT INTO user_roles (user_id) VALUES (${1})`', 'user_roles|INSERT'],
    ['CTE body', "const x = 'WITH x AS (DELETE FROM user_roles WHERE user_id = $1 RETURNING *) SELECT 1'", 'user_roles|DELETE'],
    ['query builder literal', "const x = db.insertInto('user_roles').values({})", 'user_roles|INSERT'],
    ['query builder replaceInto', "const x = db.replaceInto('user_permissions').values({})", 'user_permissions|INSERT'],
    ['folded same-file constant', "const T = 'user_roles'; const x = `DELETE FROM ${T} WHERE 1=1`", 'user_roles|DELETE'],
    ['folded type assertion', "const x = db.deleteFrom('user_roles' as any)", 'user_roles|DELETE'],
    ['lower-case verb', "const x = 'insert into user_roles (user_id) values ($1)'", 'user_roles|INSERT'],
    ['two concatenated literals', "const x = 'INSERT INTO ' + 'user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['three concatenated literals', "const x = 'DELETE ' + 'FROM ' + 'user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['concatenation across lines', "const x = 'DELETE FROM ' +\n  'user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['literal + constant + literal', "const T = 'user_roles'; const x = 'INSERT INTO ' + T + ' (user_id) VALUES ($1)'", 'user_roles|INSERT'],
    ['quoted schema and table', 'const x = \'DELETE FROM "public"."user_roles" WHERE user_id = $1\'', 'user_roles|DELETE'],
    ['users UPDATE of a quoted input column', 'const x = \'UPDATE users SET "role" = $1 WHERE id = $2\'', 'users|UPDATE'],
    ['users UPDATE through a tuple assignment', "const x = 'UPDATE users SET (role, is_admin) = ($1, $2) WHERE id = $3'", 'users|UPDATE'],
    ['multi-table TRUNCATE', "const x = 'TRUNCATE audit_logs, user_roles, sessions'", 'user_roles|TRUNCATE'],
    ['schema with white space around the dot', "const x = 'DELETE FROM public . user_roles WHERE user_id = $1'", 'user_roles|DELETE'],
    ['SQL comment between the verb and the table', "const x = 'INSERT INTO /* note */ user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['SQL line comment between the verb and the table', "const x = 'DELETE FROM -- note\\n user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['query builder call with its method name in brackets', "const x = db['deleteFrom']('user_roles')", 'user_roles|DELETE'],
    ['query builder call with its method name as a template in brackets', 'const x = db[`insertInto`](\'public.user_permissions\').values({})', 'user_permissions|INSERT'],
    ['a table after a substituted schema', 'const x = `DELETE FROM ${schema}.user_roles WHERE user_id = $1`', 'user_roles|DELETE'],
    ['a lower-case write after a substituted schema', 'const x = `update "${schema}"."users" set role = $1`', 'users|UPDATE'],
    ['TRUNCATE past an item in another schema', "const x = 'TRUNCATE audit_logs, other.thing, user_roles'", 'user_roles|TRUNCATE'],
    ['TRUNCATE of a scanned name that directly follows the verb, with a dot after it', "const x = 'TRUNCATE users.archive'", 'users|TRUNCATE'],
    ['DELETE of a scanned name that directly follows the verb, with a dot after it', "const x = 'DELETE FROM user_roles.archive'", 'user_roles|DELETE'],
    ['TRUNCATE after an item that is not a plain name', 'const x = \'TRUNCATE "audit log", role_permissions\'', 'role_permissions|TRUNCATE'],
    ['TRUNCATE after a substituted item', 'const x = `TRUNCATE ${table}, user_permissions`', 'user_permissions|TRUNCATE'],
    ['TRUNCATE of a table after a substituted schema', 'const x = `TRUNCATE audit_logs, ${schema}.user_roles`', 'user_roles|TRUNCATE'],
    ['a table after a schema written as text against a substitution', 'const x = `INSERT INTO tenant_${id}.user_roles (user_id) VALUES ($1)`', 'user_roles|INSERT'],
    ['a table after a schema written as a substitution against text', 'const x = `DELETE FROM ${prefix}lic.user_permissions WHERE user_id = $1`', 'user_permissions|DELETE'],
    ['a table after a schema written as two substitutions', 'const x = `UPDATE ${a}${b}.users SET is_admin = TRUE`', 'users|UPDATE'],
    ['a table after a schema concatenated from text and an operand', "const x = 'DELETE FROM tenant_' + id + '.role_permissions'", 'role_permissions|DELETE'],
    ['a scanned name with a substitution written against it', 'const x = `DELETE FROM user_roles${where}`', 'user_roles|DELETE'],
    ['TRUNCATE after an item written in pieces', 'const x = `TRUNCATE audit_${suffix}, user_permissions`', 'user_permissions|TRUNCATE'],
    ['TRUNCATE of a table after a schema written in pieces', 'const x = `TRUNCATE audit_logs, tenant_${id}.user_roles`', 'user_roles|TRUNCATE'],
    ['TRUNCATE of a scanned name with a substitution written against it, later in the list', 'const x = `TRUNCATE audit_logs, users${suffix}`', 'users|TRUNCATE'],
    ['TRUNCATE of a scanned name that a schema in pieces begins with, later in the list', 'const x = `TRUNCATE audit_logs, users${suffix}.archive`', 'users|TRUNCATE'],
  ]
  for (const [name, replacement, expected] of positives) {
    it(`POSITIVE CONTROL — ${name} is counted`, () => {
      const result = mutate(replacement)
      expect(result.writes.map((w) => `${w.table}|${w.verb}`)).toContain(expected)
      expect(result.writes.length).toBe(baseline.writes.length + 1)
    })
  }

  const dynamicPositives: Array<[string, string, string]> = [
    ['template substitution after a verb', 'const x = `INSERT INTO ${table} (a) VALUES (1)`', 'template_substitution'],
    ['concatenation after a verb', "const x = 'DELETE FROM ' + table", 'concatenation'],
    ['concatenation after a verb in a longer chain', "const x = 'WITH x AS (DELETE FROM ' + table + ' WHERE id = $1) SELECT 1'", 'concatenation'],
    ['users UPDATE with a concatenated SET clause', "const x = 'UPDATE users SET ' + assignments + ' WHERE id = $1'", 'users_update_dynamic_set'],
    ['query builder non-literal table', 'const x = db.updateTable(table as any).set({})', 'query_builder_non_literal'],
    ['users UPDATE with a substituted SET clause', 'const x = `UPDATE users SET ${assignments} WHERE id = $1`', 'users_update_dynamic_set'],
    ['query builder call in brackets with a non-literal table', "const x = db['updateTable'](table as any).set({})", 'query_builder_non_literal'],
    ['a name of three parts that ends in a scanned table', "const x = 'DELETE FROM metasheet.public.user_roles WHERE user_id = $1'", 'multi_part_name'],
    ['a name of three parts that begins with the usual schema', "const x = 'DELETE FROM public.user_roles.archived'", 'multi_part_name'],
    ['a quoted name of three parts on a cascade parent', 'const x = \'UPDATE "my db"."public"."roles" SET id = $1\'', 'multi_part_name'],
    ['a name of three parts with a substituted part', 'const x = `INSERT INTO metasheet.public.${table} (id) VALUES ($1)`', 'multi_part_name'],
    ['a name of three parts in a TRUNCATE list', "const x = 'TRUNCATE audit_logs, metasheet.public.user_roles'", 'multi_part_name'],
    ['text against a substitution after a verb', 'const x = `INSERT INTO user_${suffix} (user_id, role_id) VALUES ($1, $2)`', 'template_substitution'],
    ['text against a substitution after a verb and the usual schema', 'const x = `UPDATE public.user${suffix} SET is_admin = TRUE`', 'template_substitution'],
    ['text against a substitution as the first item of a TRUNCATE list', 'const x = `TRUNCATE TABLE user_${suffix}`', 'template_substitution'],
    ['text against a concatenation operand after a verb', "const x = 'DELETE FROM user_' + suffix", 'concatenation'],
    ['a name of three parts with a part written in pieces', 'const x = `DELETE FROM metasheet.pub${suffix}.user_roles`', 'multi_part_name'],
  ]
  for (const [name, replacement, form] of dynamicPositives) {
    it(`POSITIVE CONTROL — ${name} is a dynamic target`, () => {
      const result = mutate(replacement)
      expect(result.dynamic.map((d) => d.form)).toContain(form)
      expect(result.writes.length).toBe(baseline.writes.length)
    })
  }

  const negatives: Array<[string, string]> = [
    ['a read of an input table', "const x = 'SELECT 1 FROM user_roles WHERE user_id = $1'"],
    ['a write inside a comment', "const x = 1 // INSERT INTO user_roles (user_id) VALUES ($1)"],
    ['a write inside a block comment', "/* DELETE FROM user_roles */ const x = 1"],
    ['a users UPDATE of a non-input column', "const x = 'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2'"],
    ['a row lock clause', "const x = 'SELECT id FROM users WHERE id = $1 FOR UPDATE'"],
    ['a no-key row lock clause', "const x = 'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE'"],
    ['an upsert action clause', "const x = 'INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET seen = NOW()'"],
    ['a COPY out', "const x = 'COPY users TO STDOUT'"],
    ['a table whose name only starts with an input name', "const x = 'DELETE FROM users_archive WHERE id = $1'"],
    ['a lower-case prose verb before a substitution', 'const x = `update ${count} rows`'],
    ['a template substitution after a non-verb', 'const x = `SELECT * FROM ${table}`'],
    ['concatenated literals naming a table outside the set', "const x = 'INSERT INTO ' + 'sessions (id) VALUES ($1)'"],
    ['a concatenation after a non-verb', "const x = 'SELECT * FROM ' + table"],
    ['a multi-table TRUNCATE naming no scanned table', "const x = 'TRUNCATE audit_logs, sessions'"],
    ['a write inside an SQL block comment of a literal', "const x = 'SELECT 1 /* DELETE FROM user_roles */'"],
    ['a write inside an SQL line comment of a literal', "const x = 'SELECT 1 -- INSERT INTO user_roles (user_id) VALUES (1)'"],
    ['a name of three parts none of which is a scanned table', "const x = 'INSERT INTO smoke_db.dbo.smoke_probe (id) VALUES (1)'"],
    ['a copy out of a name of three parts', "const x = 'COPY metasheet.public.users TO STDOUT'"],
    ['a TRUNCATE item in another schema', "const x = 'TRUNCATE audit_logs, app.user_roles'"],
    ['a later TRUNCATE item whose schema is spelled like a scanned table', "const x = 'TRUNCATE audit_logs, users.archive'"],
    ['text against a substitution after a non-verb', 'const x = `SELECT * FROM user_${suffix}`'],
    ['a lower-case prose verb before text against a substitution', 'const x = `update row_${count} of the list`'],
    ['a substitution after white space behind the table of a write', 'const x = `DELETE FROM sessions ${where}`'],
    ['a later TRUNCATE item written in pieces that names no scanned table', 'const x = `TRUNCATE audit_logs, user_${suffix}`'],
  ]
  for (const [name, replacement] of negatives) {
    it(`NEGATIVE CONTROL — ${name} is not counted`, () => {
      const result = mutate(replacement)
      expect(result.writes.length).toBe(baseline.writes.length)
      expect(result.dynamic).toEqual([])
    })
  }

  it('CONTROLS — the writes of one text are reported in the order of the text, however each of them is found', () => {
    const result = mutate('const x = `DELETE FROM user_permissions; TRUNCATE "audit log", user_roles; DELETE FROM ${schema}.delegated_role_admin_scopes; DELETE FROM users`')
    const added = result.writes.filter((write) => !baseline.writes.some((known) => known.table === write.table && known.verb === write.verb))
    expect(added.map((write) => `${write.table}|${write.verb}`)).toEqual(['user_permissions|DELETE', 'user_roles|TRUNCATE', 'delegated_role_admin_scopes|DELETE', 'users|DELETE'])
  })

  it('CONTROLS — a users upsert action counts an UPDATE only when it assigns an input column, and is dynamic when its SET clause is substituted', () => {
    const keyOf = (w: LiteralWrite) => `${w.table}|${w.verb}|${w.form}`
    const added = (result: ReturnType<typeof mutate>) => {
      const remaining = baseline.writes.map(keyOf)
      return result.writes.map(keyOf).filter((key) => {
        const index = remaining.indexOf(key)
        if (index < 0) return true
        remaining.splice(index, 1)
        return false
      }).sort()
    }
    expect(added(mutate("const x = 'INSERT INTO users (id, role) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role'"))).toEqual(['users|INSERT|sql', 'users|UPDATE|upsert'])
    expect(added(mutate("const x = 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name'"))).toEqual(['users|INSERT|sql'])
    expect(added(mutate("const x = 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING'"))).toEqual(['users|INSERT|sql'])
    const substituted = mutate('const x = `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET ${assignments}`')
    expect(added(substituted)).toEqual(['users|INSERT|sql'])
    expect(substituted.dynamic.map((d) => d.form)).toEqual(['users_update_dynamic_set'])
  })
})

describe('table allowlists of the generic bulk routes', () => {
  it('both allowlists exist and equal the pinned items in order', () => {
    const ratchet = AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET
    const source = read(ratchet.file)
    const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
    const arrays: string[][] = []
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ratchet.identifier && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        arrays.push(node.initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : `<${ts.SyntaxKind[element.kind]}>`)))
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(arrays).toHaveLength(ratchet.occurrences)
    for (const items of arrays) expect(items).toEqual([...ratchet.items])
    const dynamicSites = production.dynamic.filter((target) => target.file === ratchet.file)
    expect(dynamicSites.map((target) => target.form)).toEqual(['query_builder_non_literal', 'query_builder_non_literal'])
  })

  it('POSITIVE CONTROL — adding or removing one item is detected (in memory)', () => {
    const ratchet = AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET
    const source = read(ratchet.file)
    const parse = (text: string) => {
      const file = ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true)
      const arrays: string[][] = []
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ratchet.identifier && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
          arrays.push(node.initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : '?')))
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      return arrays
    }
    const added = parse(source.replace("'users', 'cells',", "'users', 'user_roles', 'cells',"))
    expect(added.some((items) => items.join() !== ratchet.items.join())).toBe(true)
    const removed = parse(source.replace("'users', 'cells',", "'cells',"))
    expect(removed.some((items) => items.join() !== ratchet.items.join())).toBe(true)
  })
})

/* ───────────────────────────── migrations ───────────────────────────── */

const MIG = `${SRC}/db/migrations`
/** The frozen list is pinned by length and by the timestamp ceiling of its entries; the one entry without a timestamp is the legacy SQL file. */
const FROZEN_MIGRATION_COUNT = 25
const FROZEN_MIGRATION_CEILING = '20261012090000'
const FROZEN_MIGRATION_LEGACY = 'packages/core-backend/migrations/054_create_users_table.sql'

function migrationStamp(file: string): string | null {
  return /(?:^|\/)(?:zzzz)?(\d{14})_/.exec(file)?.[1] ?? null
}

/** Problems with a frozen list: wrong length, an entry past the ceiling, an entry that is not a writing migration. */
function frozenListProblems(frozen: readonly string[], writing: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (frozen.length !== FROZEN_MIGRATION_COUNT) problems.push(`frozen list has ${frozen.length} entries, pinned ${FROZEN_MIGRATION_COUNT}`)
  for (const file of frozen) {
    const stamp = migrationStamp(file)
    if (file === FROZEN_MIGRATION_LEGACY) continue
    if (stamp === null) problems.push(`${file}: no timestamp`)
    else if (stamp > FROZEN_MIGRATION_CEILING) problems.push(`${file}: past the ceiling ${FROZEN_MIGRATION_CEILING}`)
    if (!writing.has(file)) problems.push(`${file}: not a writing migration`)
  }
  return problems
}

describe('migrations', () => {
  const writing = new Set(migrations.writes.map((write) => write.file))

  it('the frozen list is pinned (length, timestamp ceiling), every frozen path exists and writes an input or a cascade parent', () => {
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, writing)).toEqual([])
    for (const file of AUTHORIZATION_INPUT_FROZEN_MIGRATIONS) expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true)
    expect(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS).toContain(FROZEN_MIGRATION_LEGACY)
    // The forms the scan reports are pinned here; the two forms only the migration judgment finds are matched by count where a file is judged.
    const scannedForms: readonly string[] = SCANNED_DYNAMIC_FORMS
    const expected = sortedEntries(new Map(AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((e) => e.file.includes('/db/migrations/') && scannedForms.includes(e.form)).map((e) => [`${e.file}|${e.form}`, e.count])))
    expect(sortedEntries(byFileAndForm(migrations.dynamic))).toEqual(expected)
  })

  it('an exemption of a form only the judgment finds names an existing file in which the judgment finds that many targets', () => {
    const sourceOrNull = (file: string) => (fs.existsSync(path.join(REPO_ROOT, file)) ? read(file) : null)
    expect(judgedOnlyExemptionProblems(AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS, sourceOrNull)).toEqual([])
    // Every registered form is one the scan reports or one only the judgment finds, never both.
    const scannedForms: readonly string[] = SCANNED_DYNAMIC_FORMS
    expect(JUDGED_ONLY_DYNAMIC_FORMS.filter((form) => scannedForms.includes(form))).toEqual([])
    for (const exemption of AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS) expect([...scannedForms, ...JUDGED_ONLY_DYNAMIC_FORMS], exemption.id).toContain(exemption.form)
  })

  it('POSITIVE CONTROL — such an exemption for a file that does not exist, or with another count than the judgment finds, is a problem', () => {
    const helperFile = `${MIG}/zzzz20270101000000_control_helper.ts`
    const blockFile = `${MIG}/zzzz20270101000001_control_block.ts`
    const missing = `${MIG}/zzzz20270101000002_control_missing.ts`
    const sources: Record<string, string> = {
      [helperFile]: "import { checkTableExists } from './_patterns'\nexport async function up(db, tableName) {\n  await checkTableExists(db, tableName)\n}",
      [blockFile]: `export async function up(db) {\n  await db.query("DO $$ BEGIN EXECUTE format('DELETE FROM %I', t); EXECUTE format('DELETE FROM %I', u); END $$")\n}`,
    }
    const sourceOf = (file: string) => sources[file] ?? null
    const virtual = (id: string, file: string, form: AuthorizationInputDynamicExemption['form'], count: number): AuthorizationInputDynamicExemption => ({ id, file, form, count, reachableTables: ['audit_x'], reason: 'control' })
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'helper_table_argument', 1)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 2)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 1), virtual('V-2', blockFile, 'dynamic_statement', 1)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'helper_table_argument', 2)], sourceOf)).toEqual([`${helperFile}|helper_table_argument: registered 2, found 1`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'dynamic_statement', 1)], sourceOf)).toEqual([`${helperFile}|dynamic_statement: registered 1, found 0`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 1)], sourceOf)).toEqual([`${blockFile}|dynamic_statement: registered 1, found 2`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', missing, 'helper_table_argument', 1)], sourceOf)).toEqual([`${missing}|helper_table_argument: the file does not exist`])
    // A form the scan reports is compared with the scan, not here.
    expect(judgedOnlyExemptionProblems([virtual('V-1', missing, 'template_substitution', 9)], sourceOf)).toEqual([])
  })

  it('every migration outside the frozen list is checked: one that writes an input carries the bounded try form and each of its writes is judged safe', () => {
    expect(traversalProblems(migrations.files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, read, writing.size)).toEqual([])
    expect(migrations.files.length).toBeGreaterThan(400)
  })

  it('pins the retry-loop marks of the bounded try block', () => {
    expect(AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS).toEqual(['LOOP', 'pg_sleep', 'RAISE', '55P03'])
  })

  it('POSITIVE CONTROL — through the real traversal: a compliant migration passes, a raising or lock-less one is rejected, and the frozen list cannot absorb a later file', () => {
    const compliant = `${MIG}/zzzz20261107000000_control_compliant.ts`
    const raising = `${MIG}/zzzz20261107000001_control_raising.ts`
    const lockless = `${MIG}/zzzz20261107000002_control_lockless.ts`
    const catalogueOnly = `${MIG}/zzzz20261107000003_control_catalogue.ts`
    const sql = `packages/core-backend/migrations/999_control.sql`
    const virtual: Record<string, string> = {
      [compliant]: `export async function up(db) {\n  await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\n  await db.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read') ON CONFLICT DO NOTHING")\n}`,
      [raising]: "export async function up(db) { await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'users:write')\") }",
      [lockless]: "export async function up(db) { await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read')\") }",
      [catalogueOnly]: "export async function up(db) { await db.query('INSERT INTO permissions (code) VALUES ($1)') }",
      [sql]: `-- ${COMPLIANT_LOCK_BLOCK}\nINSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'docs:read');`,
    }
    const sourceOf = (file: string) => virtual[file] ?? read(file)
    const files = [...migrations.files, ...Object.keys(virtual)]
    const problems = migrationRuleProblems(files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf).problems
    expect(problems.filter((p) => p.startsWith(compliant))).toEqual([])
    expect(problems.filter((p) => p.startsWith(catalogueOnly))).toEqual([])
    expect(problems.filter((p) => p.startsWith(raising))).toEqual([`${raising}: missing world lock try form`, `${raising}: grants class-raising code users:write`])
    expect(problems.filter((p) => p.startsWith(lockless))).toEqual([`${lockless}: missing world lock try form`])
    expect(problems.filter((p) => p.startsWith(sql))).toEqual([`${sql}: missing world lock try form`])
    // A compliant new writing migration and a catalogue-only one leave the frozen-list pin green as
    // well, and the assertions of the real traversal hold with both added: a writing migration
    // outside the frozen list is not a failure in itself.
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, new Set([...writing, compliant, catalogueOnly]))).toEqual([])
    expect(traversalProblems([...migrations.files, compliant, catalogueOnly], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 2)).toEqual([])
    expect(traversalProblems([...migrations.files, raising], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 1)).toEqual([`${raising}: missing world lock try form`, `${raising}: grants class-raising code users:write`])
    // A traversal that visits nothing, or only the frozen files, or loses a writing migration, is a failure.
    expect(traversalProblems([], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size).length).toBeGreaterThan(0)
    expect(traversalProblems([...AUTHORIZATION_INPUT_FROZEN_MIGRATIONS], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size)).toEqual(['checked 0 of 0 migrations outside the frozen list'])
    expect(traversalProblems(migrations.files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 1)).toEqual([`checked 0 writing migrations, expected 1`])
    // Appending the raising file to the frozen list skips the rule but breaks the pin.
    const absorbed = [...AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, raising]
    expect(migrationRuleProblems(files, absorbed, sourceOf).problems.filter((p) => p.startsWith(raising))).toEqual([])
    expect(frozenListProblems(absorbed, new Set([...writing, raising]))).toEqual([
      `frozen list has ${FROZEN_MIGRATION_COUNT + 1} entries, pinned ${FROZEN_MIGRATION_COUNT}`,
      `${raising}: past the ceiling ${FROZEN_MIGRATION_CEILING}`,
    ])
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS.slice(1), writing)).toHaveLength(1)
  })

  it('POSITIVE CONTROL — the lock form counts only inside a statement literal and only with its retry-loop marks; user-level raises are rejected', () => {
    const write = "await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read')\")"
    const checkNew = (file: string, source: string) => [...checkNewMigration(file, source, true).problems]
    const up = (body: string) => `export async function up(db) {\n${body}\n}`
    expect(checkNew('x.ts', up(`// ${COMPLIANT_LOCK_BLOCK}\n${write}`))).toEqual(['missing world lock try form'])
    expect(checkNew('x.ts', up(`/* ${COMPLIANT_LOCK_BLOCK} */\n${write}`))).toEqual(['missing world lock try form'])
    expect(checkNew('x.ts', up(`await db.query('SELECT ${AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM}')\n${write}`))).toEqual([
      'world lock try form without LOOP',
      'world lock try form without pg_sleep',
      'world lock try form without RAISE',
      'world lock try form without 55P03',
    ])
    expect(checkNew('x.ts', up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\n${write}`))).toEqual([])
    expect(checkNew('x.ts', up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\nawait db.query('SELECT pg_advisory_xact_lock(20261106, 1)')\n${write}`))).toEqual(['blocking world lock form'])
    expect(checkNew('x.sql', `-- ${COMPLIANT_LOCK_BLOCK}\nINSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read');`)).toEqual(['missing world lock try form'])
    expect(checkNew('x.sql', `${COMPLIANT_LOCK_BLOCK};\nINSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read');`)).toEqual([])
    const locked = (statement: string) => up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\nawait db.query("${statement}")`)
    expect(checkNew('x.ts', locked("INSERT INTO user_roles (user_id, role_id) VALUES ('u', 'admin')"))).toEqual(['writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'])
    expect(checkNew('x.ts', locked("UPDATE users SET is_admin = TRUE WHERE id = 'u'"))).toEqual(['sets is_admin'])
    expect(checkNew('x.ts', locked("UPDATE users SET role = 'admin' WHERE id = 'u'"))).toEqual(['assigns class-raising role admin'])
    expect(checkNew('x.ts', locked("UPDATE role_permissions SET permission_code = 'users:write' WHERE role_id = 'viewer'"))).toEqual(['grants class-raising code users:write'])
    expect(checkNew('x.ts', locked("UPDATE users SET role = 'user' WHERE id = 'u'"))).toEqual([])
    expect(checkNew('x.ts', up("await db.query('INSERT INTO permissions (code) VALUES ($1)')"))).toEqual([])
  })
})

const classOf = (file: string) => AUTHORIZATION_INPUT_SCRIPT_CLASSES.filter((entry) => entry.paths.some((p) => file === p || file.startsWith(p)))

/**
 * Script rules: every touched script has exactly one class; a class with a verb list issues only
 * those verbs (a bootstrap's birth insert may carry an upsert action, which is the one UPDATE a
 * bootstrap may issue); a tool that writes an input table uses the contract entry or contains the
 * migration lock form; dynamic targets outside the fixture class are registered exemptions.
 */
function scriptProblems(writes: readonly LiteralWrite[], dynamic: readonly DynamicTarget[], sourceOf: (file: string) => string): string[] {
  const touched = new Set([...writes.map((w) => w.file), ...dynamic.map((d) => d.file)])
  const problems: string[] = []
  for (const file of [...touched].sort()) {
    const classes = classOf(file)
    if (classes.length !== 1) {
      problems.push(`${file}: ${classes.length} classes`)
      continue
    }
    const [entry] = classes
    const own = writes.filter((w) => w.file === file)
    if (entry.verbs) {
      for (const write of own) {
        if (entry.verbs.includes(write.verb)) continue
        if (entry.class === 'BOOTSTRAP' && write.table === 'users' && write.form === 'upsert') continue
        problems.push(`${file}: ${write.verb} outside ${entry.class}`)
      }
    }
    if (entry.class === 'TOOL' && own.some((w) => (INPUT_TABLES as readonly string[]).includes(w.table))) {
      const source = sourceOf(file)
      if (!/\bwithAuthorizationInputTransaction\s*\(/.test(source) && !literalTexts(file, source).some((text) => text.includes(AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM))) {
        problems.push(`${file}: tool writes an input without the contract entry or the lock form`)
      }
    }
    if (entry.class !== 'FIXTURE') {
      const forms = byFileAndForm(dynamic.filter((d) => d.file === file))
      for (const [key, count] of forms) {
        const exemption = AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS.find((e) => `${e.file}|${e.form}` === key)
        if (!exemption || exemption.count !== count) problems.push(`${file}: unregistered dynamic target ${key} x${count}`)
      }
    }
  }
  return problems
}

describe('scripts and workflows', () => {
  it('every script with a write or a dynamic target satisfies its class rule', () => {
    const touched = new Set([...scripts.writes.map((w) => w.file), ...scripts.dynamic.map((d) => d.file)])
    expect(scriptProblems(scripts.writes, scripts.dynamic, read)).toEqual([])
    expect(touched.size).toBeGreaterThan(20)
    expect(scripts.writes.filter((w) => w.form === 'upsert').map((w) => w.file).sort()).toEqual(AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'BOOTSTRAP')!.paths.slice().sort())
    for (const entry of AUTHORIZATION_INPUT_SCRIPT_CLASSES) {
      for (const p of entry.paths) expect(fs.existsSync(path.join(REPO_ROOT, p)) || [...touched].some((file) => file.startsWith(p)), p).toBe(true)
    }
  })

  it('POSITIVE CONTROL — a bootstrap UPDATE, an unclassified script, and a tool writing an input without the lock form are problems', () => {
    const bootstrap = AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'BOOTSTRAP')!.paths[0]
    const tool = AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'TOOL')!.paths[0]
    const write = (file: string, table: string, verb: LiteralWrite['verb'], form: LiteralWrite['form'] = 'sql'): LiteralWrite => ({ file, line: 1, position: 0, table, verb, form })
    expect(scriptProblems([write(bootstrap, 'users', 'UPDATE')], [], () => '')).toEqual([`${bootstrap}: UPDATE outside BOOTSTRAP`])
    expect(scriptProblems([write(bootstrap, 'users', 'UPDATE', 'upsert')], [], () => '')).toEqual([])
    expect(scriptProblems([write(bootstrap, 'user_roles', 'UPDATE', 'upsert')], [], () => '')).toEqual([`${bootstrap}: UPDATE outside BOOTSTRAP`])
    expect(scriptProblems([write('scripts/ops/unclassified.sh', 'user_roles', 'INSERT')], [], () => '')).toEqual(['scripts/ops/unclassified.sh: 0 classes'])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => "await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)')")).toEqual([`${tool}: tool writes an input without the contract entry or the lock form`])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => `await client.query(\`${COMPLIANT_LOCK_BLOCK}\`)`)).toEqual([])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => `// ${AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM}`)).toHaveLength(1)
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => 'await withAuthorizationInputTransaction({ intent: "MAINTENANCE" }, work)')).toEqual([])
    expect(scriptProblems([write(tool, 'directory_integrations', 'UPDATE')], [], () => '')).toEqual([])
  })

  it('a converted `.mjs` tool copies the classifier statement verbatim and compares classes around its apply step', () => {
    const statement = classifierStatementText()
    for (const entry of AUTHORIZATION_INPUT_SCRIPT_CLASSES.filter((e) => e.class === 'OPS_MJS')) {
      for (const file of entry.paths) {
        const source = read(file)
        const satisfied = source.replace(/\s+/g, ' ').includes(statement.replace(/\s+/g, ' ')) && /--apply/.test(source)
        expect(satisfied, `${file} status`).toBe(entry.status === 'converted')
      }
    }
  })

  it('workflow fixtures equal the registry', () => {
    const expected = new Map<string, number>()
    for (const fixture of AUTHORIZATION_INPUT_WORKFLOW_FIXTURES) for (const s of fixture.statements) expected.set(`${fixture.file}|${s.table}|${s.verb}`, s.count)
    expect(sortedEntries(tally(workflows.writes))).toEqual(sortedEntries(expected))
    expect(workflows.dynamic).toEqual([])
  })
})

/* ───────────────────────────── import edges, takeover sites, key forms ───────────────────────────── */

/** Module specifiers of every `import … from`, `import type`, and `export … from` statement. */
function importSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers
}

const CONTRACT_SPECIFIER = /authorization-input-(?:brand|classes|lock|writers|consumers)/

function contractEdges(files: readonly string[], sourceOf: (file: string) => string): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  for (const file of files) {
    if (CONTRACT_MODULES.includes(file)) continue
    const source = sourceOf(file)
    if (!CONTRACT_SPECIFIER.test(source)) continue
    for (const specifier of importSpecifiers(source)) if (CONTRACT_SPECIFIER.test(specifier)) edges.push([file, specifier])
    if (/(?:require|import)\(\s*['"`][^'"`]*authorization-input-/.test(source)) edges.push([file, '<dynamic>'])
  }
  return edges
}

describe('contract modules have no production importer', () => {
  it('the set of import edges from production source (migrations included) and plugins to a contract module is empty', () => {
    const sourceFiles = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [] }).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    expect(sourceFiles.length).toBeGreaterThan(productionFiles.length)
    expect(sourceFiles.some((file) => file.startsWith(`${SRC}/db/migrations/`))).toBe(true)
    expect(contractEdges(sourceFiles, read)).toEqual([])
  })

  it('the brand is minted by the lock module only', () => {
    const minting = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [] })
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && /\bmintAuthorizationInputBrand\b/.test(read(file)))
      .sort()
    expect(minting).toEqual([`${SRC}/rbac/authorization-input-brand.ts`, LOCK_MODULE])
  })

  it('POSITIVE CONTROL — a static import, a type import, a re-export and a dynamic load are each an edge', () => {
    const cases = [
      "import { x } from './authorization-input-brand'",
      "import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'",
      "export { y } from './authorization-input-classes'",
      "const m = require('./authorization-input-writers')",
      "const m = await import('./authorization-input-consumers')",
    ]
    for (const source of cases) expect(contractEdges(['x.ts'], () => source), source).toHaveLength(1)
    expect(contractEdges(['x.ts'], () => "import { z } from './role-assignment'")).toEqual([])
  })
})

type TakeoverSite = { file: string; line: number; intent: string | null; caller: string | null }

function takeoverSites(file: string, source: string): TakeoverSite[] {
  const sites: TakeoverSite[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'enterAuthorizationInputTransaction') {
      const plan = node.arguments[1]
      let intent: string | null = null
      let caller: string | null = null
      if (plan && ts.isObjectLiteralExpression(plan)) {
        for (const property of plan.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            if (property.name.text === 'intent' && ts.isStringLiteral(property.initializer)) intent = property.initializer.text
            if (property.name.text === 'caller' && ts.isStringLiteral(property.initializer)) caller = property.initializer.text
          }
        }
      }
      sites.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, intent, caller })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return sites
}

const TAKEOVER_FILES: Readonly<Record<string, string>> = Object.freeze({
  directory_sync: `${SRC}/directory/directory-sync.ts`,
  controlled_handover: `${SRC}/directory/controlled-handover.ts`,
})

function takeoverProblems(sites: readonly TakeoverSite[]): string[] {
  const problems: string[] = []
  for (const site of sites) {
    const caller = site.caller === null ? null : (AUTHORIZATION_INPUT_TAKEOVER_CALLERS as Record<string, { intents: readonly string[] } | undefined>)[site.caller]
    if (!site.caller || !caller) problems.push(`${site.file}:${site.line}: caller is not a registered literal`)
    else if (TAKEOVER_FILES[site.caller] !== site.file) problems.push(`${site.file}:${site.line}: not the registered file of ${site.caller}`)
    else if (site.intent === null || !caller.intents.includes(site.intent)) problems.push(`${site.file}:${site.line}: intent is not a literal inside the closure`)
  }
  return problems
}

describe('takeover call sites', () => {
  it('no production file joins a contract transaction', () => {
    const sites = productionFiles
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== LOCK_MODULE)
      .flatMap((file) => {
        const source = read(file)
        return source.includes('enterAuthorizationInputTransaction') ? takeoverSites(file, source) : []
      })
    expect(sites).toEqual([])
    expect(takeoverProblems(sites)).toEqual([])
  })

  it('POSITIVE CONTROL — a site outside the registered file, with a non-literal or out-of-closure intent, is a problem; a registered site is not', () => {
    const sync = TAKEOVER_FILES.directory_sync
    const ok = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(ok)).toEqual([])
    const wrongFile = takeoverSites(`${SRC}/routes/roles.ts`, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(wrongFile)).toHaveLength(1)
    const outside = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'EDIT_ROLE_CONTENT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(outside)).toHaveLength(1)
    const variable = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent, caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(variable)).toHaveLength(1)
    const noCaller = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT' }, ['isolation_pin'], work)")
    expect(takeoverProblems(noCaller)).toHaveLength(1)
  })
})

const KEY = String(AUTHORIZATION_INPUT_WORLD_LOCK_KEY1)
const PERMITTED_KEY_FORMS = [`pg_advisory_xact_lock_shared(${KEY}, 1)`, `pg_try_advisory_xact_lock_shared(${KEY}, 1)`, `pg_try_advisory_xact_lock(${KEY}, 1)`]
/** The key as the first argument of any advisory-lock call, in text; a date embedded in a migration name or a path is not a key. */
const KEY_IN_ADVISORY_CALL = new RegExp(`pg_[a-z_]*advisory[a-z_]*\\(\\s*${KEY}\\b`, 'g')
/** The key as a bare numeric token in text, as a parameter list or a SQL literal would spell it. */
const KEY_AS_TOKEN = new RegExp(`(?<![0-9A-Za-z_.\\-/])${KEY}(?![0-9A-Za-z_.\\-/])`, 'g')
const KEY_IDENTIFIERS = ['AUTHORIZATION_INPUT_WORLD_LOCK_KEY1', 'AUTHORIZATION_INPUT_WORLD_LOCK_KEY2']

/**
 * Every occurrence of the key that is not a permitted statement form or a declaration: in
 * TypeScript, string and template chunks, numeric literals and references to the key identifiers;
 * in other files, the text. Text occurrences count when the key is an advisory call's first
 * argument or a bare numeric token.
 */
function keyProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const check = (text: string, where: string) => {
    const seen = new Set<number>()
    for (const match of [...text.matchAll(KEY_IN_ADVISORY_CALL), ...text.matchAll(KEY_AS_TOKEN)]) {
      const index = (match.index ?? 0) + match[0].indexOf(KEY)
      if (seen.has(index)) continue
      seen.add(index)
      const permitted = PERMITTED_KEY_FORMS.some((form) => text.startsWith(form, index - form.indexOf(KEY)))
      if (!permitted) problems.push(`${where}: ${text.slice(Math.max(0, index - 30), index + 20).replace(/\s+/g, ' ')}`)
    }
  }
  if (SOURCE_EXTENSIONS.has(path.extname(file))) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
    const lineOf = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        check(node.text, `${file}:${lineOf(node)}`)
      } else if (ts.isNumericLiteral(node) && Number(node.text) === AUTHORIZATION_INPUT_WORLD_LOCK_KEY1) {
        const parent = node.parent
        const declaration = parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === KEY_IDENTIFIERS[0] && file === LOCK_MODULE
        const registry = parent && ts.isPropertyAssignment(parent) && parent.name.getText(tree) === 'literal' && file === KEY_REGISTRY_MODULE
        if (!declaration && !registry) problems.push(`${file}:${lineOf(node)}: numeric key outside its declarations`)
      } else if (ts.isIdentifier(node) && KEY_IDENTIFIERS.includes(node.text)) {
        const parent = node.parent
        const declaration = parent && ts.isVariableDeclaration(parent) && parent.name === node && file === LOCK_MODULE
        if (!declaration) problems.push(`${file}:${lineOf(node)}: key identifier ${node.text} referenced outside its declaration`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  } else {
    check(source, file)
  }
  return problems
}

describe('world-lock key forms', () => {
  it('across every root the key appears only in the three permitted statement forms and its two declarations, and the key identifiers are never referenced', () => {
    const files = listFiles(REPO_ROOT, ALL_ROOTS)
    expect(files.length).toBeGreaterThan(2000)
    const problems: string[] = []
    let permittedSites = 0
    for (const file of files) {
      const source = read(file)
      if (!source.includes(KEY) && !KEY_IDENTIFIERS.some((name) => source.includes(name))) continue
      problems.push(...keyProblems(file, source))
      for (const form of PERMITTED_KEY_FORMS) permittedSites += source.split(form).length - 1
    }
    expect(problems).toEqual([])
    expect(permittedSites).toBeGreaterThanOrEqual(3)
  })

  it('POSITIVE CONTROL — the blocking form, the session form, a parameterised key, a key spelled through its identifier and a bare key token are each a problem', () => {
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_xact_lock(${KEY}, 1)'`)).toHaveLength(1)
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_lock(${KEY}, 1)'`)).toHaveLength(1)
    expect(keyProblems('x.ts', `await q('SELECT pg_advisory_xact_lock_shared($1, $2)', [${KEY}, 1])`)).toHaveLength(1)
    expect(keyProblems('x.ts', `await q('SELECT pg_advisory_xact_lock_shared($1, $2)', ['${KEY}', 1])`)).toHaveLength(1)
    expect(keyProblems('x.ts', 'const s = `SELECT pg_advisory_xact_lock(${AUTHORIZATION_INPUT_WORLD_LOCK_KEY1}, ${AUTHORIZATION_INPUT_WORLD_LOCK_KEY2})`')).toHaveLength(2)
    expect(keyProblems('x.ts', 'await q(\'SELECT pg_advisory_xact_lock_shared($1, $2)\', [AUTHORIZATION_INPUT_WORLD_LOCK_KEY1, 1])')).toHaveLength(1)
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_xact_lock_shared(${KEY}, 1)'`)).toEqual([])
    expect(keyProblems('x.sql', `SELECT pg_advisory_xact_lock(${KEY}, 1);`)).toHaveLength(1)
    expect(keyProblems('x.sql', `SELECT pg_advisory_lock( ${KEY} , 1);`)).toHaveLength(1)
    expect(keyProblems('x.sql', `SELECT pg_try_advisory_xact_lock(${KEY}, 1);`)).toEqual([])
    expect(keyProblems('x.sh', `psql -c "SELECT pg_advisory_xact_lock(${KEY}, 1)"`)).toHaveLength(1)
  })

  it('NEGATIVE CONTROL — the digits inside a migration name, a dated path or a dated identifier are not a key', () => {
    expect(keyProblems('x.ts', `const help = \`Likewise zzzz${KEY}120000_create_x.ts refuses\``)).toEqual([])
    expect(keyProblems('x.mjs', `const note = 'run migrate.js --confirm zzzz${KEY}120000_create_x first'`)).toEqual([])
    expect(keyProblems('x.ts', `const doc = 'docs/development/plan-${KEY}.md'`)).toEqual([])
    expect(keyProblems('x.ts', `const dir = 'artifacts/review-${KEY}/report.md'`)).toEqual([])
    expect(keyProblems('x.sh', `ls artifacts/review-${KEY}/`)).toEqual([])
    expect(keyProblems('x.ts', `const stamp = 'build_${KEY}'`)).toEqual([])
  })
})

/* ───────────────────────────── function-level ratchet, table closure, birth-only shape ───────────────────────────── */

function conversionProblems(writer: AuthorizationInputWriterEntry, source: string, writes: readonly LiteralWrite[]): string[] {
  const problems: string[] = []
  if (writer.status !== 'converted') return problems
  const sites = writes.filter((write) => write.file === writer.file && writer.statements.some((s) => s.table === write.table && s.verb === write.verb))
  if (sites.length === 0) problems.push(`${writer.id}: no statement site found`)
  for (const site of sites) {
    const fn = enclosingFunctionAt(writer.file, source, site.position)
    if (!fn || fn.name !== writer.symbol) {
      problems.push(`${writer.id}: statement at line ${site.line} is not inside ${writer.symbol}`)
      continue
    }
    if (!fn.brandedParameters.includes('tx')) problems.push(`${writer.id}: ${writer.symbol} does not take tx typed as the contract token`)
    const receiver = queryReceiverAt(writer.file, source, site.position)
    if (receiver !== 'tx') problems.push(`${writer.id}: statement at line ${site.line} is issued on ${receiver ?? 'no query receiver'}`)
  }
  return problems
}

describe('function-level conversion ratchet', () => {
  it('every converted entry issues its statements on the token inside the named function', () => {
    const problems = AUTHORIZATION_INPUT_WRITERS.flatMap((writer) => conversionProblems(writer, read(writer.file), production.writes))
    expect(problems).toEqual([])
  })

  it('POSITIVE CONTROL — a converted entry whose function takes a client, an untyped tx, or issues a statement on another receiver, is a problem', () => {
    const converted: AuthorizationInputWriterEntry = { ...AUTHORIZATION_INPUT_WRITERS[0], file: 'x.ts', symbol: 'grant', status: 'converted' }
    const good = "async function grant(tx: AuthorizationInputTx, userId: string) { await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, 'r']) }"
    expect(conversionProblems(converted, good, scanSource('x.ts', good).writes)).toEqual([])
    const client = good.replace('grant(tx: AuthorizationInputTx,', 'grant(client: PoolClient,').replace('tx.query', 'client.query')
    expect(conversionProblems(converted, client, scanSource('x.ts', client).writes)).toHaveLength(2)
    const untyped = good.replace('tx: AuthorizationInputTx', 'tx')
    expect(conversionProblems(converted, untyped, scanSource('x.ts', untyped).writes)).toHaveLength(1)
    const otherReceiver = "async function grant(tx: AuthorizationInputTx, userId: string) { await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, 'r']) }"
    expect(conversionProblems(converted, otherReceiver, scanSource('x.ts', otherReceiver).writes)).toHaveLength(1)
    const elsewhere = "async function other(tx: AuthorizationInputTx) { await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', ['u', 'r']) }\nasync function grant(tx: AuthorizationInputTx) {}"
    expect(conversionProblems(converted, elsewhere, scanSource('x.ts', elsewhere).writes)).toHaveLength(1)
  })
})

/** The classifier's data statement, read from its source text by the `FROM users u` mark. */
function classifierStatementText(): string {
  const source = read(CLASSIFIER_MODULE)
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  let statement: string | null = null
  const visit = (node: ts.Node) => {
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.text.includes('FROM users u')) statement = node.text
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (statement === null) throw new Error('classifier statement not found')
  return statement
}

const SERVICE_READER = `${SRC}/rbac/service.ts`
const NAMESPACE_READER = `${SRC}/rbac/namespace-admission.ts`
const AUTHORIZATION_READERS: readonly string[] = [SERVICE_READER, NAMESPACE_READER]
const GRANT_TABLE = /^(?:users|user_[a-z_]+|role_[a-z_]+|roles|delegated_[a-z_]+|platform_member_[a-z_]+)$/

/**
 * THE ONE EXCEPTION to the reader closure. The statement that lists a user's inherited permission
 * codes left-joins `roles` for the display name of each role, and that is the only place a reader may
 * name the table. The join is there to show a name: the codes come from `role_permissions`, a left join
 * drops no row, and no decision reads `roles`. So the exception is pinned by shape and not by table:
 * the word is mentioned once in the statement text of the service reader; the mention is this join
 * clause; outside the clause its alias is read only as this select-list item; and the statement that
 * carries the join is this statement, whitespace apart (which also covers a column of the joined table
 * named without the alias). Every other writing of the table in a reader is a problem, and every other
 * grant table outside the classifier's set is one, as before.
 */
const ROLE_NAME_JOIN = {
  reader: SERVICE_READER,
  table: 'roles',
  clause: 'LEFT JOIN roles r ON r.id = ur.role_id',
  projection: 'r.name AS role_name',
  statement: 'SELECT DISTINCT rp.permission_code AS code, ur.role_id AS role_id, r.name AS role_name FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
} as const
const PINNED_STATEMENT_PROBLEM = `${ROLE_NAME_JOIN.reader}: the statement that joins roles is not the pinned statement`

/**
 * Literals whose whole text is the word, per reader. It is a permission resource name there, not a
 * table: the namespace reader lists it once among the resources that have no namespace. The count is
 * pinned, so the table named as an argument of a query builder is one literal too many.
 */
const ROLES_RESOURCE_NAME_LITERALS: ReadonlyMap<string, number> = new Map([[NAMESPACE_READER, 1]])

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of `text` from `before` words before the one at `index` to `after` words after it. */
function wordsAround(text: string, index: number, before: number, after: number): string {
  const words = [...text.matchAll(/\S+/g)]
  const at = words.findIndex((word) => (word.index ?? 0) <= index && index < (word.index ?? 0) + word[0].length)
  return words.slice(Math.max(0, at - before), at + after + 1).map((word) => word[0]).join(' ')
}

/** Replaces the one occurrence of `needle` in `source`; any other number of occurrences throws. */
function editOnce(source: string, needle: string | RegExp, replacement: string): string {
  const found = typeof needle === 'string'
    ? [...source.matchAll(new RegExp(escapeRegExp(needle), 'g'))]
    : [...source.matchAll(new RegExp(needle.source, 'g'))]
  if (found.length !== 1) throw new Error(`editOnce: the needle occurs ${found.length} times`)
  const index = found[0].index ?? 0
  return source.slice(0, index) + replacement + source.slice(index + found[0][0].length)
}

/** The grant tables a source names after FROM or JOIN, read from its whole text. */
function grantTablesRead(source: string): Set<string> {
  return new Set([...source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((match) => match[1]).filter((table) => GRANT_TABLE.test(table)))
}

/** Problems of one statement of the service reader that mentions `roles`; `statement` is whitespace-squashed. */
function roleNameJoinProblems(statement: string): string[] {
  const { reader, clause, projection } = ROLE_NAME_JOIN
  const problems: string[] = []
  const joins = [...statement.matchAll(new RegExp(`(?<![\\w.])${escapeRegExp(clause)}(?![\\w.])`, 'g'))].map((match) => match.index ?? 0)
  const insideJoin = (index: number) => joins.some((from) => index >= from && index < from + clause.length)
  for (const mention of statement.matchAll(/\broles\b/gi)) {
    if (!insideJoin(mention.index ?? 0)) problems.push(`${reader}: roles is referenced as "${wordsAround(statement, mention.index ?? 0, 2, 1)}", not as "${clause}"`)
  }
  if (problems.length === 0) {
    const selectListEnd = statement.search(/\bFROM\b/)
    const selected = new RegExp(`(?<=(?:,|\\bSELECT|\\bDISTINCT) )${escapeRegExp(projection)}(?=,| FROM\\b)`, 'y')
    for (const use of statement.matchAll(/\br\b(?:\s*\.\s*(?:\*|\w+|"[^"]*"))?/gi)) {
      const index = use.index ?? 0
      if (insideJoin(index)) continue
      selected.lastIndex = index
      if (use[0] !== 'r.name') problems.push(`${reader}: the role-name join's alias is read as "${use[0]}", not as "r.name"`)
      else if (!(index < selectListEnd && selected.test(statement))) problems.push(`${reader}: r.name is used outside the select list, in "${wordsAround(statement, index, 1, 2)}"`)
    }
  }
  if (statement !== ROLE_NAME_JOIN.statement) problems.push(PINNED_STATEMENT_PROBLEM)
  return problems
}

/** Problems of the mentions of `roles` in the literals of one reader. */
function rolesMentionProblems(reader: string, source: string): string[] {
  const problems: string[] = []
  const literals = literalTexts(reader, source).map(squash)
  const resourceNames = literals.filter((text) => text === ROLE_NAME_JOIN.table).length
  const expectedResourceNames = ROLES_RESOURCE_NAME_LITERALS.get(reader) ?? 0
  if (resourceNames !== expectedResourceNames) problems.push(`${reader}: the word roles is the whole text of ${resourceNames} literal(s), not of ${expectedResourceNames}`)
  const statements = literals.filter((text) => text !== ROLE_NAME_JOIN.table && /\broles\b/i.test(text))
  const mentions = statements.reduce((count, text) => count + [...text.matchAll(/\broles\b/gi)].length, 0)
  if (reader !== ROLE_NAME_JOIN.reader) {
    if (mentions > 0) problems.push(`${reader}: statement text mentions roles ${mentions} time(s); only the role-name join may`)
    return problems
  }
  if (mentions !== 1) problems.push(`${reader}: statement text mentions roles ${mentions} time(s), not once`)
  for (const statement of statements) problems.push(...roleNameJoinProblems(statement))
  return problems
}

/**
 * Problems of one authorization reader: a grant table outside the classifier's set after FROM or JOIN
 * anywhere in its text, and any mention of `roles` other than the role-name join. The whole-text rule
 * steps aside for `roles` only in the service reader and only while that text names the table once.
 */
function readerClosureProblems(reader: string, source: string): string[] {
  const problems: string[] = []
  const namedOnce = [...source.matchAll(/\b(?:FROM|JOIN)\s+roles\b/g)].length === 1
  for (const table of grantTablesRead(source)) {
    if ((PRIVILEGE_GRANT_SOURCE_TABLES as readonly string[]).includes(table)) continue
    if (reader === ROLE_NAME_JOIN.reader && table === ROLE_NAME_JOIN.table && namedOnce) continue
    problems.push(`${reader} reads ${table}`)
  }
  problems.push(...rolesMentionProblems(reader, source))
  return problems
}

const serviceSource = read(SERVICE_READER)
const namespaceSource = read(NAMESPACE_READER)

describe('table list closure', () => {
  it('the tables the classifier statement reads equal its table constant, which is the scanner\'s input set', () => {
    const statement = classifierStatementText()
    const tables = new Set([...statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((match) => match[1]))
    expect([...tables].sort()).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES].sort())
    expect([...INPUT_TABLES].sort()).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES].sort())
  })

  it('the authorization readers reference no grant table outside the classifier\'s set', () => {
    // The one exception is the role-name join, pinned by shape above: it shows a role's name, and no decision reads `roles`.
    for (const reader of AUTHORIZATION_READERS) {
      const source = read(reader)
      expect(grantTablesRead(source).size, reader).toBeGreaterThanOrEqual(2)
      expect(readerClosureProblems(reader, source), reader).toEqual([])
    }
  })

  it('CONTROL — the role-name join passes as production writes it and when the same statement is laid out on one line', () => {
    expect(squash(literalTexts(SERVICE_READER, serviceSource).find((text) => /\broles\b/.test(text)) ?? '')).toBe(ROLE_NAME_JOIN.statement)
    expect(readerClosureProblems(SERVICE_READER, serviceSource)).toEqual([])
    const oneLine = editOnce(serviceSource, /`SELECT DISTINCT rp\.permission_code AS code,[^`]*`/, `\`${ROLE_NAME_JOIN.statement}\``)
    expect(oneLine).not.toBe(serviceSource)
    expect(readerClosureProblems(SERVICE_READER, oneLine)).toEqual([])
    expect(readerClosureProblems(NAMESPACE_READER, namespaceSource)).toEqual([])
  })

  it('POSITIVE CONTROL — an inner join of roles is a problem, written with or without INNER', () => {
    const bare = editOnce(serviceSource, 'LEFT JOIN roles r', 'JOIN roles r')
    expect(readerClosureProblems(SERVICE_READER, bare)).toEqual([
      `${SERVICE_READER}: roles is referenced as "ur.role_id JOIN roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const inner = editOnce(serviceSource, 'LEFT JOIN roles r', 'INNER JOIN roles r')
    expect(readerClosureProblems(SERVICE_READER, inner)).toEqual([
      `${SERVICE_READER}: roles is referenced as "INNER JOIN roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const lower = editOnce(serviceSource, 'LEFT JOIN roles r', 'left join ROLES r')
    expect(readerClosureProblems(SERVICE_READER, lower)).toEqual([
      `${SERVICE_READER}: roles is referenced as "left join ROLES r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
  })

  it('POSITIVE CONTROL — a second mention of roles is a problem, even as a copy of the pinned statement or of the pinned join', () => {
    const copy = `${serviceSource}\nconst again = \`${ROLE_NAME_JOIN.statement}\`\n`
    expect(readerClosureProblems(SERVICE_READER, copy)).toEqual([`${SERVICE_READER} reads roles`, `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`])
    const elsewhere = editOnce(serviceSource, 'WHERE ur.user_id = $1 AND rp.permission_code = $2', `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND rp.permission_code = $2`)
    expect(readerClosureProblems(SERVICE_READER, elsewhere)).toEqual([`${SERVICE_READER} reads roles`, `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`, PINNED_STATEMENT_PROBLEM])
    const commaJoin = editOnce(serviceSource, 'WHERE ur.user_id = $1 AND rp.permission_code = $2', ', roles x WHERE ur.user_id = $1 AND rp.permission_code = $2')
    expect(readerClosureProblems(SERVICE_READER, commaJoin)).toEqual([
      `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`,
      `${SERVICE_READER}: roles is referenced as "ur.role_id , roles x", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const inComment = `${serviceSource}\n// an earlier form read: JOIN roles\n`
    expect(readerClosureProblems(SERVICE_READER, inComment)).toEqual([`${SERVICE_READER} reads roles`])
    const removed = editOnce(serviceSource, ROLE_NAME_JOIN.clause, '')
    expect(readerClosureProblems(SERVICE_READER, removed)).toEqual([`${SERVICE_READER}: statement text mentions roles 0 time(s), not once`])
    const resourceName = `${serviceSource}\nconst resources = ['roles']\n`
    expect(readerClosureProblems(SERVICE_READER, resourceName)).toEqual([`${SERVICE_READER}: the word roles is the whole text of 1 literal(s), not of 0`])
  })

  it('POSITIVE CONTROL — FROM roles is a problem, as the first table or inside a derived table', () => {
    const derived = editOnce(serviceSource, ROLE_NAME_JOIN.clause, 'LEFT JOIN (SELECT id, name FROM roles) r ON r.id = ur.role_id')
    expect(readerClosureProblems(SERVICE_READER, derived)).toEqual([
      `${SERVICE_READER}: roles is referenced as "name FROM roles) r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const first = editOnce(serviceSource, /FROM user_roles ur\s+JOIN role_permissions rp ON rp\.role_id = ur\.role_id\s+LEFT JOIN roles r ON r\.id = ur\.role_id/, 'FROM roles r JOIN user_roles ur ON ur.role_id = r.id JOIN role_permissions rp ON rp.role_id = ur.role_id')
    expect(readerClosureProblems(SERVICE_READER, first)).toEqual([
      `${SERVICE_READER}: roles is referenced as "role_name FROM roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
  })

  it('POSITIVE CONTROL — reading another column of the joined role, every column, or the row itself, is a problem', () => {
    const column = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r.is_system AS role_name')
    expect(readerClosureProblems(SERVICE_READER, column)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.is_system", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const star = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r.*')
    expect(readerClosureProblems(SERVICE_READER, star)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.*", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const row = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r AS role_name')
    expect(readerClosureProblems(SERVICE_READER, row)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const both = editOnce(serviceSource, ROLE_NAME_JOIN.projection, `${ROLE_NAME_JOIN.projection}, r.is_system AS role_is_system`)
    expect(readerClosureProblems(SERVICE_READER, both)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.is_system", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
  })

  it('POSITIVE CONTROL — the joined role in a condition is a problem: in WHERE, in a longer ON, in a computed column, as a column named without the alias, or behind a substituted fragment', () => {
    const joinThenWhere = /LEFT JOIN roles r ON r\.id = ur\.role_id\s+WHERE ur\.user_id = \$1/
    const where = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE r.name = $2 AND ur.user_id = $1`)
    expect(readerClosureProblems(SERVICE_READER, where)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "WHERE r.name = $2"`, PINNED_STATEMENT_PROBLEM])
    const on = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} AND r.name IS NOT NULL WHERE ur.user_id = $1`)
    expect(readerClosureProblems(SERVICE_READER, on)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "AND r.name IS NOT"`, PINNED_STATEMENT_PROBLEM])
    const computed = editOnce(serviceSource, 'rp.permission_code AS code,', "CASE WHEN r.name = 'admin' THEN rp.permission_code END AS code,")
    expect(readerClosureProblems(SERVICE_READER, computed)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "WHEN r.name = 'admin'"`, PINNED_STATEMENT_PROBLEM])
    const subquery = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND EXISTS (SELECT ${ROLE_NAME_JOIN.projection} FROM user_permissions)`)
    expect(readerClosureProblems(SERVICE_READER, subquery)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "(SELECT r.name AS role_name"`, PINNED_STATEMENT_PROBLEM])
    const unqualified = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND name = $2`)
    expect(readerClosureProblems(SERVICE_READER, unqualified)).toEqual([PINNED_STATEMENT_PROBLEM])
    const substituted = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 \${extra}`)
    expect(readerClosureProblems(SERVICE_READER, substituted)).toEqual([PINNED_STATEMENT_PROBLEM])
  })

  it('POSITIVE CONTROL — the namespace reader mentioning roles is a problem, whichever way the table is named', () => {
    const commaJoin = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions, roles')
    expect(readerClosureProblems(NAMESPACE_READER, commaJoin)).toEqual([`${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`])
    const qualified = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions JOIN public.roles r ON TRUE')
    expect(readerClosureProblems(NAMESPACE_READER, qualified)).toEqual([`${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`])
    const pinnedJoin = editOnce(namespaceSource, 'FROM user_namespace_admissions', `FROM user_namespace_admissions ${ROLE_NAME_JOIN.clause}`)
    expect(readerClosureProblems(NAMESPACE_READER, pinnedJoin)).toEqual([
      `${NAMESPACE_READER} reads roles`,
      `${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`,
    ])
    const resourceName = `${namespaceSource}\nconst resources = ['roles']\n`
    expect(readerClosureProblems(NAMESPACE_READER, resourceName)).toEqual([`${NAMESPACE_READER}: the word roles is the whole text of 2 literal(s), not of 1`])
  })

  it('POSITIVE CONTROL — every other grant table outside the classifier\'s set is still a problem in both readers', () => {
    const groups = editOnce(serviceSource, ROLE_NAME_JOIN.clause, `${ROLE_NAME_JOIN.clause} JOIN platform_member_groups g ON g.id = ur.role_id`)
    expect(readerClosureProblems(SERVICE_READER, groups)).toEqual([`${SERVICE_READER} reads platform_member_groups`, PINNED_STATEMENT_PROBLEM])
    const apart = `${serviceSource}\nconst other = 'SELECT 1 FROM role_templates'\n`
    expect(readerClosureProblems(SERVICE_READER, apart)).toEqual([`${SERVICE_READER} reads role_templates`])
    const namespace = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions JOIN platform_member_groups g ON TRUE')
    expect(readerClosureProblems(NAMESPACE_READER, namespace)).toEqual([`${NAMESPACE_READER} reads platform_member_groups`])
    expect(() => editOnce(serviceSource, 'WHERE ur.user_id = $1', '')).toThrow('occurs')
    expect(() => editOnce(serviceSource, 'no such text', '')).toThrow('occurs 0 times')
  })
})

/** A `B0` insert: no admin or permission column, a literal `'user'` role in the VALUES list, and no `ON CONFLICT` action. */
function birthOnlyProblems(source: string): string[] {
  const problems: string[] = []
  const inserts = [...source.matchAll(/INSERT\s+INTO\s+users\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)([\s\S]{0,300})/gi)]
  if (inserts.length === 0) return ['no users insert found']
  for (const insert of inserts) {
    const columns = insert[1].split(',').map((column) => column.trim().toLowerCase())
    const values = insert[2].split(',').map((value) => value.trim())
    if (columns.includes('is_admin')) problems.push('inserts is_admin')
    if (columns.includes('permissions')) problems.push('inserts permissions')
    const role = columns.indexOf('role')
    if (role >= 0 && values[role] !== "'user'") problems.push(`role is ${values[role] ?? 'missing'}`)
    if (/^\s*ON\s+CONFLICT\b/i.test(insert[3])) problems.push('carries an ON CONFLICT action')
  }
  return problems
}

describe('birth-only writer shape', () => {
  it('the one user insert outside the contract creates a plain user and no input', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS.filter((w) => w.class === 'B0')) {
      expect(birthOnlyProblems(read(writer.file)), writer.id).toEqual([])
    }
    expect(AUTHORIZATION_INPUT_WRITERS.filter((w) => w.class === 'B0')).toHaveLength(1)
  })

  it('POSITIVE CONTROL — an admin column, a permission column or a non-literal role is a problem', () => {
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user')")).toEqual([])
    expect(birthOnlyProblems('INSERT INTO users (id, role) VALUES ($1, $2)')).toEqual(['role is $2'])
    expect(birthOnlyProblems("INSERT INTO users (id, role, is_admin) VALUES ($1, 'user', TRUE)")).toEqual(['inserts is_admin'])
    expect(birthOnlyProblems("INSERT INTO users (id, permissions) VALUES ($1, '[]')")).toEqual(['inserts permissions'])
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user') ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role")).toEqual(['carries an ON CONFLICT action'])
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user') ON CONFLICT DO NOTHING")).toEqual(['carries an ON CONFLICT action'])
  })
})

/* ───────────────────────────── late role rows ───────────────────────────── */

/** The callers that take a role row late, as `file|function`; the registry must equal this list. */
const LATE_ROLE_ROW_CALLER_KEYS: readonly string[] = [
  `${SRC}/auth/AuthService.ts|insertUserRolesOnce`,
  `${SRC}/directory/directory-sync.ts|applyDirectoryProjectedMemberGroupGovernanceInTransaction`,
]

/** Names of the functions in `source` that enclose a call of `callee`. */
function callersOf(file: string, source: string, callee: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      names.push(enclosingFunctionAt(file, source, node.getStart(tree))?.name ?? '<module>')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return names
}

function lateRoleRowProblems(registry: readonly AuthorizationInputLateRoleRowCaller[], pinned: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const keys = registry.map((caller) => `${caller.file}|${caller.symbol}`)
  for (const key of keys) if (!pinned.includes(key)) problems.push(`${key}: late role row caller outside the pinned set`)
  for (const key of pinned) if (!keys.includes(key)) problems.push(`${key}: pinned late role row caller is not registered`)
  if (new Set(keys).size !== keys.length) problems.push('a late role row caller is registered twice')
  for (const caller of registry) {
    if (caller.roleRows !== 'late' || caller.callee !== 'assignUserRoles') problems.push(`${caller.id}: not a late caller of the role-membership writer`)
    const found = callersOf(caller.file, sourceOf(caller.file), caller.callee).filter((name) => name === caller.symbol).length
    if (found !== 1) problems.push(`${caller.id}: ${caller.symbol} calls ${caller.callee} ${found} time(s)`)
  }
  return problems
}

describe('late role row callers', () => {
  it('the registered callers are the pinned set, and each still calls the role-membership writer once', () => {
    expect(lateRoleRowProblems(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS, LATE_ROLE_ROW_CALLER_KEYS, read)).toEqual([])
    expect(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS).toHaveLength(2)
    expect(new Set(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS.map((caller) => caller.id)).size).toBe(2)
    // The writer they call is the registered membership insert.
    const writer = AUTHORIZATION_INPUT_WRITERS.find((entry) => entry.symbol === 'assignUserRoles')
    expect(writer?.statements).toEqual([{ table: 'user_roles', verb: 'INSERT', count: 1 }])
  })

  it('POSITIVE CONTROL — a third caller, a removed caller, a caller that no longer calls the writer and a duplicate are each a problem', () => {
    const [first, second] = AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS
    const third: AuthorizationInputLateRoleRowCaller = { id: 'LR-X', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', callee: 'assignUserRoles', roleRows: 'late' }
    expect(lateRoleRowProblems([first, second, third], LATE_ROLE_ROW_CALLER_KEYS, read).some((p) => p.includes('outside the pinned set'))).toBe(true)
    expect(lateRoleRowProblems([first], LATE_ROLE_ROW_CALLER_KEYS, read)).toEqual([`${LATE_ROLE_ROW_CALLER_KEYS[1]}: pinned late role row caller is not registered`])
    expect(lateRoleRowProblems([first, second], LATE_ROLE_ROW_CALLER_KEYS, () => 'function insertUserRolesOnce() { return 1 }').length).toBe(2)
    expect(lateRoleRowProblems([first, second, second], LATE_ROLE_ROW_CALLER_KEYS, read)).toContain('a late role row caller is registered twice')
    const source = 'class A { private async insertUserRolesOnce() { await assignUserRoles({}) } }\nasync function applyDirectoryProjectedMemberGroupGovernanceInTransaction() { await assignUserRoles({}) }'
    expect(lateRoleRowProblems([first, second], LATE_ROLE_ROW_CALLER_KEYS, () => source)).toEqual([])
  })
})

/* ───────────────────────────── work closure body ───────────────────────────── */

/** The pull-source organisation lock: a contract transaction never takes it. */
const FORBIDDEN_PULL_SOURCE_LOCK = ['directoryOrgLockSql', 'directoryOrgLockKey', 'DIRECTORY_ORG_LOCK_KEY_PREFIX']
/** The functions of the pull-source write gate: a contract transaction never enters it. */
const FORBIDDEN_PULL_SOURCE_GATE = ['runGatedPullSourceWrite', 'runPullSourceGateTransaction', 'asPullSourceGateFailure']
const FORBIDDEN_IN_WORK = ['fetch', 'axios', 'bcrypt', 'setTimeout', 'sendMail', 'sendEmail', 'sendMessage', 'sendNotification', ...FORBIDDEN_PULL_SOURCE_LOCK, ...FORBIDDEN_PULL_SOURCE_GATE]
const PULL_SOURCE_RULE_MODULE = `${SRC}/directory/pull-source-rule.ts`
const PULL_SOURCE_GATE_MODULE = `${SRC}/directory/pull-source-write-gate.ts`

/** Names of the functions a module exports (declarations and `export const name = (…) =>`). */
function exportedFunctionNames(source: string): string[] {
  const tree = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const exported = (node: ts.Node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) names.push(statement.name.text)
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) names.push(declaration.name.text)
      }
    }
  }
  return names
}

function workClosureProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(?:with|enter)AuthorizationInputTransaction$/.test(node.expression.getText(tree))) {
      const work = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      if (work) {
        const identifiers = new Set<string>()
        const collect = (inner: ts.Node) => {
          if (ts.isIdentifier(inner)) identifiers.add(inner.text)
          ts.forEachChild(inner, collect)
        }
        collect(work)
        for (const forbidden of FORBIDDEN_IN_WORK) if (identifiers.has(forbidden)) problems.push(`${file}: work closure references ${forbidden}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return problems
}

/** Entry options a production caller may not supply: the transaction runner and the post-acquire hook belong to tests. */
const TEST_ONLY_ENTRY_OPTIONS = ['transaction', 'afterAcquire']

function entryOptionProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'withAuthorizationInputTransaction' && node.arguments.length > 2) {
      const options = node.arguments[2]
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
      if (!ts.isObjectLiteralExpression(options)) problems.push(`${file}:${line}: entry options are not an object literal`)
      else {
        for (const property of options.properties) {
          const name = property.name?.getText(tree) ?? '<spread>'
          if (!property.name || TEST_ONLY_ENTRY_OPTIONS.includes(name)) problems.push(`${file}:${line}: entry option ${name} is reserved for tests`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return problems
}

describe('work closures make no external call, and production callers pass no test-only entry option', () => {
  it('no production work closure references a forbidden identifier; no production caller supplies a transaction runner or a post-acquire hook', () => {
    const problems = productionFiles
      .filter((file) => file.endsWith('.ts') && file !== LOCK_MODULE)
      .flatMap((file) => {
        const source = read(file)
        return /AuthorizationInputTransaction\(/.test(source) ? [...workClosureProblems(file, source), ...entryOptionProblems(file, source)] : []
      })
    expect(problems).toEqual([])
  })

  it('the forbidden pull-source names are the ones the organisation lock module exports, and every function the write gate exports is forbidden', () => {
    expect(FORBIDDEN_IN_WORK).toHaveLength(14)
    const rule = read(PULL_SOURCE_RULE_MODULE)
    for (const name of FORBIDDEN_PULL_SOURCE_LOCK) expect(new RegExp(`export (?:const|function) ${name}\\b`).test(rule), name).toBe(true)
    // Every exported name of the lock module that spells the organisation lock is on the list.
    const lockExports = [...rule.matchAll(/export (?:const|function) ([A-Za-z_0-9]*(?:OrgLock|ORG_LOCK)[A-Za-z_0-9]*)/g)].map((match) => match[1]).sort()
    expect(lockExports).toEqual([...FORBIDDEN_PULL_SOURCE_LOCK].sort())
    // Once the gate module exists, each function it exports must be on the list.
    if (fs.existsSync(path.join(REPO_ROOT, PULL_SOURCE_GATE_MODULE))) {
      for (const name of exportedFunctionNames(read(PULL_SOURCE_GATE_MODULE))) expect(FORBIDDEN_IN_WORK, name).toContain(name)
    }
    expect(exportedFunctionNames('export async function runA() {}\nexport const runB = async () => 1\nfunction hidden() {}\nexport const VALUE = 1')).toEqual(['runA', 'runB'])
  })

  it('POSITIVE CONTROL — a closure that takes the pull-source organisation lock or enters its write gate is a problem', () => {
    for (const name of FORBIDDEN_PULL_SOURCE_LOCK) {
      expect(workClosureProblems('x.ts', `withAuthorizationInputTransaction(plan, async (tx) => { await tx.query(${name}('$1'), [org]) })`), name).toEqual([`x.ts: work closure references ${name}`])
    }
    for (const name of FORBIDDEN_PULL_SOURCE_GATE) {
      expect(workClosureProblems('x.ts', `enterAuthorizationInputTransaction(c, plan, [], async (tx) => { await gate.${name}(input) })`), name).toEqual([`x.ts: work closure references ${name}`])
    }
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => tx.query('SELECT 1 FROM directory_integrations'))")).toEqual([])
  })

  it('POSITIVE CONTROL — a closure that calls fetch or setTimeout is a problem', () => {
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => { await fetch(url); return 1 })")).toHaveLength(1)
    expect(workClosureProblems('x.ts', "enterAuthorizationInputTransaction(c, plan, [], async (tx) => { await new Promise((r) => setTimeout(r, 10)) })")).toHaveLength(1)
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => tx.query('SELECT 1'))")).toEqual([])
  })

  it('POSITIVE CONTROL — a transaction runner, a post-acquire hook, a spread or a non-literal options argument is a problem; a budget is not', () => {
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { transaction: runner })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { afterAcquire: hook })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { ...options })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, options)')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { exclusive: { attempts: 3 } })')).toEqual([])
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work)')).toEqual([])
  })
})
