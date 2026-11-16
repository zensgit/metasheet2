/**
 * Database-side census of the privilege-classifier input tables against the standard migrated
 * schema: the non-internal triggers on the seven input tables are exactly the five recovery-lease
 * triggers; no rule writes an input table; no user-defined function body writes an input table or
 * runs dynamic SQL that names one; the functions that lock `users` rows are exactly four; every
 * cascading foreign key from an input table points at one of five known parents; the three `users`
 * columns the classifier reads carry their pinned default expressions; no view or materialized view
 * is defined over an input table; the foreign keys whose child is an input table are a pinned
 * list, each with its update action, delete action and deferrability; and no table inherits from an
 * input table or is a partition of one, so a read of an input table returns its own rows only.
 * Matching is done in TypeScript on catalog text; the database only returns names, definitions,
 * default expressions and constraint attributes.
 *
 * Each assertion has a positive control created inside a transaction that is rolled back, and the
 * function-body assertion has negative controls for a trigger function that only takes a lease and
 * one that only touches `updated_at`. The foreign-key list has a second control: an existing
 * constraint rebuilt under the same name and columns with another update action.
 */
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRIVILEGE_GRANT_SOURCE_TABLES } from '../../src/auth/security-action-privilege'

const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (authorization-input census)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const INPUT_TABLES: readonly string[] = PRIVILEGE_GRANT_SOURCE_TABLES

/** (table, trigger) pairs expected on the input tables. */
const EXPECTED_TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  ['users', 'trg_users_recovery_authority_lock_update'],
  ['users', 'trg_users_recovery_authority_lock_lifecycle'],
  ['user_roles', 'trg_user_roles_recovery_authority_lock'],
  ['user_permissions', 'trg_user_permissions_recovery_authority_lock'],
  ['role_permissions', 'trg_role_permissions_recovery_authority_lock'],
]

const EXPECTED_USERS_LOCKING_FUNCTIONS: readonly string[] = [
  'guard_dingtalk_repaired_identity',
  'guard_repaired_directory_link',
  'attendance_employee_timezone_member_guard',
  'guard_attendance_calculation_group_membership_user_org',
]

const CASCADE_PARENT_ALLOWLIST: readonly string[] = ['roles', 'permissions', 'users', 'directory_departments', 'platform_member_groups']

/** The `users` columns the classifier reads, each with the default expression the catalog reports. */
const EXPECTED_USERS_INPUT_DEFAULTS: ReadonlyArray<readonly [column: string, defaultExpression: string | null]> = [
  ['is_admin', 'false'],
  ['permissions', "'[]'::jsonb"],
  ['role', "'user'::text"],
]

/** Views and materialized views defined over an input table, as `schema.view -> table`. */
const EXPECTED_VIEWS_OVER_INPUTS: readonly string[] = []

/** Tables that inherit from an input table or are a partition of one, as `schema.child -> parent`. */
const EXPECTED_CHILDREN_OF_INPUTS: readonly string[] = []

type InputForeignKey = Readonly<{ constraint: string; child: string; parent: string; onUpdate: string; onDelete: string; deferrable: boolean; initiallyDeferred: boolean }>

const fk = (constraint: string, child: string, parent: string, onDelete: string): InputForeignKey => ({ constraint, child, parent, onUpdate: 'a', onDelete, deferrable: false, initiallyDeferred: false })

/**
 * Every foreign key whose child is an input table. Actions are the catalog's one-letter codes:
 * `a` no action, `c` cascade, `n` set null. None has an update action and none is deferrable.
 */
const EXPECTED_INPUT_FOREIGN_KEYS: readonly InputForeignKey[] = [
  fk('delegated_role_admin_member_groups_admin_user_id_fkey', 'delegated_role_admin_member_groups', 'users', 'c'),
  fk('delegated_role_admin_member_groups_created_by_fkey', 'delegated_role_admin_member_groups', 'users', 'n'),
  fk('delegated_role_admin_member_groups_group_id_fkey', 'delegated_role_admin_member_groups', 'platform_member_groups', 'c'),
  fk('delegated_role_admin_scopes_admin_user_id_fkey', 'delegated_role_admin_scopes', 'users', 'c'),
  fk('delegated_role_admin_scopes_created_by_fkey', 'delegated_role_admin_scopes', 'users', 'n'),
  fk('delegated_role_admin_scopes_directory_department_id_fkey', 'delegated_role_admin_scopes', 'directory_departments', 'c'),
  fk('role_permissions_permission_code_fkey', 'role_permissions', 'permissions', 'c'),
  fk('user_namespace_admissions_user_id_fkey', 'user_namespace_admissions', 'users', 'c'),
  fk('user_permissions_permission_code_fkey', 'user_permissions', 'permissions', 'c'),
]

/** Everything the census compares about a foreign key: its identity, its two actions and its deferrability. */
const comparedForeignKey = (key: InputForeignKey): string => [key.constraint, key.child, key.parent, key.onUpdate, key.onDelete, key.deferrable, key.initiallyDeferred].join('|')
const sortedLines = (lines: readonly string[]): string[] => [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The constraints found that are not on the pinned list as found, and the pinned ones that were not found as pinned. */
function inputForeignKeyDifferences(found: readonly InputForeignKey[]): string[] {
  const pinned = new Set(EXPECTED_INPUT_FOREIGN_KEYS.map(comparedForeignKey))
  const present = new Set(found.map(comparedForeignKey))
  return sortedLines([
    ...found.filter((key) => !pinned.has(comparedForeignKey(key))).map((key) => `unexpected ${key.constraint}`),
    ...EXPECTED_INPUT_FOREIGN_KEYS.filter((key) => !present.has(comparedForeignKey(key))).map((key) => `missing ${key.constraint}`),
  ])
}

type Runner = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

const TABLE_PATTERN = INPUT_TABLES.join('|')
const WRITE_VERB_TO_INPUT = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?(?:public\\.)?"?(?:${TABLE_PATTERN})"?(?![A-Za-z0-9_])`, 'i')
const MENTIONS_INPUT = new RegExp(`\\b(?:${TABLE_PATTERN})\\b`, 'i')
const ROW_LOCK = /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i
const MENTIONS_USERS = /\busers\b/i

function isUpdateClause(text: string, index: number): boolean {
  return /\b(?:FOR(?:\s+NO\s+KEY)?|DO)\s*$/i.test(text.slice(Math.max(0, index - 24), index))
}

/** Whether a function body writes an input table with a literal statement. */
function bodyWritesInput(body: string): boolean {
  const pattern = new RegExp(WRITE_VERB_TO_INPUT.source, 'gi')
  for (const match of body.matchAll(pattern)) {
    if (/^UPDATE/i.test(match[0]) && isUpdateClause(body, match.index ?? 0)) continue
    return true
  }
  return false
}

/** Whether a function body runs dynamic SQL and names an input table anywhere. */
function bodyExecutesNamingInput(body: string): boolean {
  return /\bEXECUTE\b/i.test(body) && MENTIONS_INPUT.test(body)
}

async function triggersOnInputs(run: Runner): Promise<Array<{ table: string; trigger: string; enabled: string }>> {
  const result = await run(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY 1, 2`,
    [INPUT_TABLES],
  )
  return result.rows.map((row) => ({ table: String(row.table_name), trigger: String(row.trigger_name), enabled: String(row.enabled) }))
}

async function rulesTouchingInputs(run: Runner): Promise<{ onInputs: string[]; namingInputs: string[] }> {
  const onInputs = await run(
    `SELECT c.relname AS table_name, r.rulename AS rule_name
       FROM pg_rewrite r
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rulename <> '_RETURN' AND n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [INPUT_TABLES],
  )
  const all = await run(
    `SELECT n.nspname AS schema_name, c.relname AS table_name, r.rulename AS rule_name, pg_get_ruledef(r.oid) AS definition
       FROM pg_rewrite r
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rulename <> '_RETURN' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  )
  return {
    onInputs: onInputs.rows.map((row) => `${row.table_name}.${row.rule_name}`),
    namingInputs: all.rows.filter((row) => MENTIONS_INPUT.test(String(row.definition ?? ''))).map((row) => `${row.schema_name}.${row.table_name}.${row.rule_name}`),
  }
}

type FunctionRow = { signature: string; name: string; body: string }

async function userFunctions(run: Runner): Promise<FunctionRow[]> {
  const result = await run(
    `SELECT n.nspname AS schema_name, p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS arguments, p.prosrc AS body
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND l.lanname NOT IN ('internal', 'c')`,
  )
  return result.rows.map((row) => ({ signature: `${row.schema_name}.${row.function_name}(${row.arguments ?? ''})`, name: String(row.function_name), body: String(row.body ?? '') }))
}

function writingFunctions(functions: readonly FunctionRow[]): string[] {
  return functions.filter((fn) => bodyWritesInput(fn.body) || bodyExecutesNamingInput(fn.body)).map((fn) => fn.signature).sort()
}

function usersLockingFunctions(functions: readonly FunctionRow[]): string[] {
  return [...new Set(functions.filter((fn) => ROW_LOCK.test(fn.body) && MENTIONS_USERS.test(fn.body)).map((fn) => fn.name))].sort()
}

async function cascadeParents(run: Runner): Promise<Array<{ child: string; parent: string; constraint: string }>> {
  const result = await run(
    `SELECT c.conname AS constraint_name, child.relname AS child_name, parent.relname AS parent_name
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND child.relname = ANY($1::text[]) AND c.confdeltype = ANY($2::"char"[])`,
    [INPUT_TABLES, ['c', 'n', 'd']],
  )
  return result.rows.map((row) => ({ child: String(row.child_name), parent: String(row.parent_name), constraint: String(row.constraint_name) }))
}

async function usersInputDefaults(run: Runner): Promise<Array<[string, string | null]>> {
  const result = await run(
    `SELECT a.attname AS column_name, pg_get_expr(d.adbin, d.adrelid) AS default_expression
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = 'users' AND NOT a.attisdropped AND a.attname = ANY($1::text[])
      ORDER BY 1`,
    [EXPECTED_USERS_INPUT_DEFAULTS.map(([column]) => column)],
  )
  return result.rows.map((row) => [String(row.column_name), row.default_expression === null || row.default_expression === undefined ? null : String(row.default_expression)])
}

async function viewsOverInputs(run: Runner): Promise<string[]> {
  const result = await run(
    `SELECT DISTINCT vn.nspname AS view_schema, v.relname AS view_name, t.relname AS table_name
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class v ON v.oid = r.ev_class
       JOIN pg_namespace vn ON vn.oid = v.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
        AND v.relkind IN ('v', 'm') AND v.oid <> t.oid
        AND tn.nspname = 'public' AND t.relname = ANY($1::text[])`,
    [INPUT_TABLES],
  )
  return sortedLines(result.rows.map((row) => `${row.view_schema}.${row.view_name} -> ${row.table_name}`))
}

async function inputForeignKeys(run: Runner): Promise<InputForeignKey[]> {
  const result = await run(
    `SELECT c.conname AS constraint_name, child.relname AS child_name, parent.relname AS parent_name,
            c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete, c.condeferrable AS deferrable, c.condeferred AS initially_deferred
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND child.relname = ANY($1::text[])`,
    [INPUT_TABLES],
  )
  return result.rows.map((row) => ({
    constraint: String(row.constraint_name),
    child: String(row.child_name),
    parent: String(row.parent_name),
    onUpdate: String(row.on_update),
    onDelete: String(row.on_delete),
    deferrable: row.deferrable === true,
    initiallyDeferred: row.initially_deferred === true,
  }))
}

async function childrenOfInputs(run: Runner): Promise<string[]> {
  const result = await run(
    `SELECT cn.nspname AS child_schema, child.relname AS child_name, parent.relname AS parent_name
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace cn ON cn.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_namespace pn ON pn.oid = parent.relnamespace
      WHERE pn.nspname = 'public' AND parent.relname = ANY($1::text[])`,
    [INPUT_TABLES],
  )
  return sortedLines(result.rows.map((row) => `${row.child_schema}.${row.child_name} -> ${row.parent_name}`))
}

describeIfDatabase('authorization-input census (real PostgreSQL)', () => {
  let pool: PgPool
  const run: Runner = async (sql, params) => pool.query(sql, params as never)

  beforeAll(() => {
    pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 2 })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function inRolledBackTransaction<T>(fn: (client: PoolClient, runner: Runner) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      return await fn(client, async (sql, params) => client.query(sql, params as never))
    } finally {
      try {
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
  }

  it('the input tables exist in the migrated schema', async () => {
    const result = await run(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`, [INPUT_TABLES])
    expect(result.rows.map((row) => String(row.relname)).sort()).toEqual([...INPUT_TABLES].sort())
  })

  it('1. the non-internal triggers on the input tables are exactly the five recovery-lease triggers', async () => {
    const triggers = await triggersOnInputs(run)
    const byPair = (a: readonly [string, string], b: readonly [string, string]) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)
    expect(triggers.map((t) => [t.table, t.trigger] as const).sort(byPair)).toEqual([...EXPECTED_TRIGGERS].sort(byPair))
    // Enabled state is recorded, not asserted: the lease triggers install disabled.
    for (const trigger of triggers) expect(['O', 'D', 'R', 'A']).toContain(trigger.enabled)
  })

  it('2. no rule is defined on an input table, and no rule anywhere names one', async () => {
    const rules = await rulesTouchingInputs(run)
    expect(rules.onInputs).toEqual([])
    expect(rules.namingInputs).toEqual([])
  })

  it('3. no user-defined function body writes an input table or runs dynamic SQL that names one', async () => {
    const functions = await userFunctions(run)
    expect(functions.length).toBeGreaterThan(5)
    expect(writingFunctions(functions)).toEqual([])
    // The lease trigger functions are in the population and are not matched.
    expect(functions.some((fn) => /recovery_authority/.test(fn.name))).toBe(true)
  })

  it('4. the functions that lock users rows are exactly the four known guards', async () => {
    const functions = await userFunctions(run)
    expect(usersLockingFunctions(functions)).toEqual([...EXPECTED_USERS_LOCKING_FUNCTIONS].sort())
  })

  it('5. every cascading foreign key from an input table points at an allowed parent', async () => {
    const parents = await cascadeParents(run)
    expect(parents.length).toBeGreaterThan(0)
    for (const fk of parents) expect(CASCADE_PARENT_ALLOWLIST, `${fk.child}.${fk.constraint} -> ${fk.parent}`).toContain(fk.parent)
  })

  it('6. the three users columns the classifier reads carry their pinned default expressions', async () => {
    expect(await usersInputDefaults(run)).toEqual(EXPECTED_USERS_INPUT_DEFAULTS.map(([column, expression]) => [column, expression]))
  })

  it('7. no view or materialized view is defined over an input table', async () => {
    expect(await viewsOverInputs(run)).toEqual([...EXPECTED_VIEWS_OVER_INPUTS])
  })

  it('8. the foreign keys whose child is an input table are the pinned list, each with its update action, delete action and deferrability', async () => {
    const found = await inputForeignKeys(run)
    expect(inputForeignKeyDifferences(found)).toEqual([])
    expect(found).toHaveLength(EXPECTED_INPUT_FOREIGN_KEYS.length)
    // No membership row is tied to its role row by a foreign key in this schema.
    expect(found.filter((key) => key.child === 'user_roles')).toEqual([])
    expect(found.filter((key) => key.parent === 'roles')).toEqual([])
  })

  it('9. no table inherits from an input table or is a partition of one', async () => {
    expect(await childrenOfInputs(run)).toEqual([...EXPECTED_CHILDREN_OF_INPUTS])
  })

  describe('positive controls (each created inside a rolled-back transaction)', () => {
    it('a trigger added to user_roles is detected by assertion 1', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE FUNCTION ais1_census_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$')
        await client.query('CREATE TRIGGER ais1_census_control BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION ais1_census_noop()')
        const triggers = await triggersOnInputs(runner)
        expect(triggers.map((t) => [t.table, t.trigger])).toContainEqual(['user_roles', 'ais1_census_control'])
        expect(triggers).toHaveLength(EXPECTED_TRIGGERS.length + 1)
        // The noop trigger function only returns NEW: not a writer.
        expect(writingFunctions(await userFunctions(runner))).toEqual([])
      })
      expect((await triggersOnInputs(run)).map((t) => t.trigger)).not.toContain('ais1_census_control')
    })

    it('a rule on a view that inserts into user_roles is detected by assertion 2', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE VIEW ais1_census_view AS SELECT user_id, role_id FROM user_roles')
        await client.query('CREATE RULE ais1_census_rule AS ON INSERT TO ais1_census_view DO INSTEAD INSERT INTO user_roles (user_id, role_id) VALUES (NEW.user_id, NEW.role_id)')
        const rules = await rulesTouchingInputs(runner)
        expect(rules.namingInputs).toEqual(['public.ais1_census_view.ais1_census_rule'])
        expect(rules.onInputs).toEqual([])
      })
      expect((await rulesTouchingInputs(run)).namingInputs).toEqual([])
    })

    it('a function that writes user_roles, and one that runs EXECUTE format naming it, are detected by assertion 3', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query("CREATE FUNCTION ais1_census_write() RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO user_roles (user_id, role_id) VALUES ('ais1', 'ais1'); END $$")
        expect(writingFunctions(await userFunctions(runner))).toEqual(['public.ais1_census_write()'])
      })
      await inRolledBackTransaction(async (client, runner) => {
        await client.query("CREATE FUNCTION ais1_census_dynamic() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('INSERT INTO %I (user_id, role_id) VALUES ($1, $2)', 'user_roles') USING 'ais1', 'ais1'; END $$")
        expect(writingFunctions(await userFunctions(runner))).toEqual(['public.ais1_census_dynamic()'])
      })
      expect(writingFunctions(await userFunctions(run))).toEqual([])
    })

    it('NEGATIVE CONTROL — a trigger function that only takes a lease, and one that only touches updated_at, are not writers', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE FUNCTION ais1_census_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT pg_try_advisory_xact_lock(hashtext(NEW.user_id)) THEN RAISE EXCEPTION USING ERRCODE = \'40001\'; END IF; RETURN NEW; END $$')
        await client.query('CREATE FUNCTION ais1_census_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$')
        expect(writingFunctions(await userFunctions(runner))).toEqual([])
        expect(usersLockingFunctions(await userFunctions(runner))).toEqual([...EXPECTED_USERS_LOCKING_FUNCTIONS].sort())
      })
    })

    it('a function that locks a users row is detected by assertion 4', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query("CREATE FUNCTION ais1_census_lock() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM users WHERE id = 'ais1' FOR SHARE; END $$")
        expect(usersLockingFunctions(await userFunctions(runner))).toEqual([...EXPECTED_USERS_LOCKING_FUNCTIONS, 'ais1_census_lock'].sort())
      })
      expect(usersLockingFunctions(await userFunctions(run))).toEqual([...EXPECTED_USERS_LOCKING_FUNCTIONS].sort())
    })

    it('a cascading foreign key to a parent outside the allowlist is detected by assertion 5', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE TABLE ais1_census_parent (id text PRIMARY KEY)')
        await client.query('ALTER TABLE user_namespace_admissions ADD COLUMN ais1_census_parent_id text REFERENCES ais1_census_parent(id) ON DELETE CASCADE')
        const parents = await cascadeParents(runner)
        expect(parents.some((fk) => fk.child === 'user_namespace_admissions' && fk.parent === 'ais1_census_parent')).toBe(true)
        expect(parents.filter((fk) => !CASCADE_PARENT_ALLOWLIST.includes(fk.parent)).map((fk) => fk.parent)).toEqual(['ais1_census_parent'])
      })
      expect((await cascadeParents(run)).every((fk) => CASCADE_PARENT_ALLOWLIST.includes(fk.parent))).toBe(true)
    })
  })

  describe('positive controls for the defaults, the views and the foreign-key list (each inside a rolled-back transaction)', () => {
    it('a changed default and a dropped default on a classifier column are detected by assertion 6', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'admin'")
        expect(await usersInputDefaults(runner)).toEqual([['is_admin', 'false'], ['permissions', "'[]'::jsonb"], ['role', "'admin'::text"]])
      })
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('ALTER TABLE users ALTER COLUMN is_admin DROP DEFAULT')
        expect(await usersInputDefaults(runner)).toEqual([['is_admin', null], ['permissions', "'[]'::jsonb"], ['role', "'user'::text"]])
      })
      expect(await usersInputDefaults(run)).toEqual(EXPECTED_USERS_INPUT_DEFAULTS.map(([column, expression]) => [column, expression]))
    })

    it('a view and a materialized view over an input table are detected by assertion 7', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE VIEW ais1_census_members AS SELECT user_id, role_id FROM user_roles')
        await client.query('CREATE MATERIALIZED VIEW ais1_census_admins AS SELECT id FROM users WHERE is_admin WITH NO DATA')
        expect(await viewsOverInputs(runner)).toEqual(['public.ais1_census_admins -> users', 'public.ais1_census_members -> user_roles'])
      })
      expect(await viewsOverInputs(run)).toEqual([...EXPECTED_VIEWS_OVER_INPUTS])
    })

    it('a foreign key added to an input table is detected by assertion 8', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE TABLE ais1_census_owner (id text PRIMARY KEY)')
        await client.query('ALTER TABLE user_namespace_admissions ADD COLUMN ais1_census_owner_id text CONSTRAINT ais1_census_owner_fkey REFERENCES ais1_census_owner(id)')
        const found = await inputForeignKeys(runner)
        expect(inputForeignKeyDifferences(found)).toEqual(['unexpected ais1_census_owner_fkey'])
        expect(found).toHaveLength(EXPECTED_INPUT_FOREIGN_KEYS.length + 1)
        expect(found.find((key) => key.constraint === 'ais1_census_owner_fkey')).toEqual({ constraint: 'ais1_census_owner_fkey', child: 'user_namespace_admissions', parent: 'ais1_census_owner', onUpdate: 'a', onDelete: 'a', deferrable: false, initiallyDeferred: false })
      })
      expect(inputForeignKeyDifferences(await inputForeignKeys(run))).toEqual([])
    })

    it('an existing foreign key rebuilt under the same name and columns with an update action is detected by assertion 8, though its name, child and parent are unchanged', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_permission_code_fkey')
        await client.query('ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES permissions(code) ON UPDATE CASCADE ON DELETE CASCADE')
        const found = await inputForeignKeys(runner)
        expect(found.find((key) => key.constraint === 'role_permissions_permission_code_fkey')).toEqual({ constraint: 'role_permissions_permission_code_fkey', child: 'role_permissions', parent: 'permissions', onUpdate: 'c', onDelete: 'c', deferrable: false, initiallyDeferred: false })
        // The set of names, children and parents is the pinned one: only the action differs.
        const identity = (key: InputForeignKey) => `${key.constraint}|${key.child}|${key.parent}`
        expect(sortedLines(found.map(identity))).toEqual(sortedLines(EXPECTED_INPUT_FOREIGN_KEYS.map(identity)))
        expect(inputForeignKeyDifferences(found)).toEqual(['missing role_permissions_permission_code_fkey', 'unexpected role_permissions_permission_code_fkey'])
      })
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('ALTER TABLE user_permissions DROP CONSTRAINT user_permissions_permission_code_fkey')
        await client.query('ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED')
        const found = await inputForeignKeys(runner)
        expect(found.find((key) => key.constraint === 'user_permissions_permission_code_fkey')).toMatchObject({ onUpdate: 'a', onDelete: 'c', deferrable: true, initiallyDeferred: true })
        expect(inputForeignKeyDifferences(found)).toEqual(['missing user_permissions_permission_code_fkey', 'unexpected user_permissions_permission_code_fkey'])
      })
      expect(inputForeignKeyDifferences(await inputForeignKeys(run))).toEqual([])
    })
  })

  describe('positive control for the inheritance children (inside a rolled-back transaction)', () => {
    it('a table created as an inheritance child of an input table, and one given an input table as its parent afterwards, are detected by assertion 9; the rows of a child are read through the input table', async () => {
      await inRolledBackTransaction(async (client, runner) => {
        await client.query('CREATE TABLE ais1_census_members () INHERITS (user_roles)')
        expect(await childrenOfInputs(runner)).toEqual(['public.ais1_census_members -> user_roles'])
        await client.query('CREATE TABLE ais1_census_grants (LIKE role_permissions INCLUDING CONSTRAINTS)')
        expect(await childrenOfInputs(runner)).toEqual(['public.ais1_census_members -> user_roles'])
        await client.query('ALTER TABLE ais1_census_grants INHERIT role_permissions')
        expect(await childrenOfInputs(runner)).toEqual(['public.ais1_census_grants -> role_permissions', 'public.ais1_census_members -> user_roles'])
        // A row of the child is a row of every plain read of the parent, and of none that names the parent ONLY.
        await client.query("INSERT INTO ais1_census_members (user_id, role_id) VALUES ('ais1-census-user', 'ais1-census-role')")
        expect((await runner("SELECT role_id FROM user_roles WHERE user_id = 'ais1-census-user'")).rows.map((row) => String(row.role_id))).toEqual(['ais1-census-role'])
        expect((await runner("SELECT role_id FROM ONLY user_roles WHERE user_id = 'ais1-census-user'")).rows).toEqual([])
      })
      expect(await childrenOfInputs(run)).toEqual([...EXPECTED_CHILDREN_OF_INPUTS])
    })
  })

  it('the TypeScript matchers behave on fixed bodies', () => {
    expect(bodyWritesInput("BEGIN INSERT INTO user_roles (user_id, role_id) VALUES ('a', 'b'); END")).toBe(true)
    expect(bodyWritesInput('BEGIN UPDATE ONLY public."users" SET role = $1; END')).toBe(true)
    expect(bodyWritesInput('BEGIN DELETE FROM role_permissions; END')).toBe(true)
    expect(bodyWritesInput('BEGIN TRUNCATE user_permissions; END')).toBe(true)
    expect(bodyWritesInput("BEGIN PERFORM 1 FROM users WHERE id = 'x' FOR UPDATE; RETURN NEW; END")).toBe(false)
    expect(bodyWritesInput('BEGIN INSERT INTO users_archive VALUES (1); END')).toBe(false)
    expect(bodyWritesInput('BEGIN NEW.updated_at = now(); RETURN NEW; END')).toBe(false)
    expect(bodyExecutesNamingInput("BEGIN EXECUTE format('INSERT INTO %I', 'user_roles'); END")).toBe(true)
    expect(bodyExecutesNamingInput("BEGIN EXECUTE format('INSERT INTO %I', 'audit_logs'); END")).toBe(false)
    expect(bodyExecutesNamingInput('BEGIN INSERT INTO user_roles DEFAULT VALUES; END')).toBe(false)
  })
})
