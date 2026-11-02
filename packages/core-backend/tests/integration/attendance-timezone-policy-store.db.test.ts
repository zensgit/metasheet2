import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { down, up } from '../../src/db/migrations/zzzz20261012100000_create_attendance_timezone_policy'

const require = createRequire(import.meta.url)
type Input = Record<string, unknown>
type Query = (sql: string, values: unknown[]) => Promise<{ rows: Input[] }>
type Store = Record<string, (input: Input) => Promise<unknown>>
const { createAttendanceTimezonePolicyStore: create } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs',
) as {
  createAttendanceTimezonePolicyStore: (adapter: {
    query: Query, transaction: (work: (query: Query) => Promise<unknown>) => Promise<unknown>,
    authorizeManage: (input: Input) => Promise<boolean>,
  }) => Store,
}
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL
if (!dbUrl) throw new Error('ATTENDANCE_TIMEZONE_TEST_DATABASE_REQUIRED')
const schema = 'timezone_d1_' + randomUUID().replaceAll('-', '')
const bootstrap = new Pool({ connectionString: dbUrl, max: 1 })
const pool = new Pool({ connectionString: dbUrl, max: 4, options: '-c search_path=' + schema + ',public' })
const db = new Kysely<unknown>({ dialect: new PostgresDialect({
  pool: new Pool({ connectionString: dbUrl, max: 1, options: '-c search_path=' + schema + ',public' }),
}) })
const actor = { orgId: 'org-a', actorId: 'actor-a' }
const from = new Date('2026-10-12T00:00:00Z')
const middle = new Date('2026-10-13T00:00:00Z')
const to = new Date('2026-10-14T00:00:00Z')
const query: Query = (sql, values) => pool.query(sql, values)
const transaction = async (work: (q: Query) => Promise<unknown>) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work((sql, values) => client.query(sql, values))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
const store = create({ query, transaction, authorizeManage: async ({ orgId, actorId }) =>
  (orgId === 'org-a' && actorId === 'actor-a') || (orgId === 'org-b' && actorId === 'actor-b'),
})
function error(code: string, status = 422) {
  return { code: 'ATTENDANCE_TIMEZONE_' + code, message: 'ATTENDANCE_TIMEZONE_' + code, status }
}

describe('D1 timezone persistence (isolated real PostgreSQL)', () => {
  beforeAll(async () => {
    await bootstrap.query('CREATE SCHEMA ' + schema)
    // Minimal real prerequisites; this is not whole production-migration proof.
    await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY, is_active boolean NOT NULL);
      CREATE TABLE user_orgs (
        user_id text NOT NULL REFERENCES users(id), org_id text NOT NULL,
        is_active boolean NOT NULL, PRIMARY KEY (user_id, org_id)
      );
      CREATE TABLE attendance_rules (
        id uuid PRIMARY KEY, org_id text NOT NULL, timezone text NOT NULL, is_default boolean NOT NULL
      );
      INSERT INTO users VALUES ('actor-a',true),('actor-b',true),('user-a',true),
        ('user-b',true),('inactive',false),('inactive-member',true);
      INSERT INTO user_orgs VALUES ('actor-a','org-a',true),('actor-b','org-b',true),
        ('user-a','org-a',true),('user-b','org-b',true),('inactive','org-a',true),
        ('inactive-member','org-a',false)
    `)
    await up(db)
  })
  afterAll(async () => {
    await db.destroy()
    await pool.end()
    await bootstrap.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
    await bootstrap.end()
  })

  it('fresh migration apply/replay/down retains base tables and restores exact empty structures', async () => {
    await up(db)
    await down(db)
    expect((await pool.query(`
      SELECT to_regclass('${schema}.attendance_timezone_policies')::text AS policies,
        to_regclass('${schema}.attendance_employee_timezone_overrides')::text AS overrides,
        to_regclass('${schema}.attendance_timezone_policy_audit')::text AS audit,
        to_regclass('attendance_rules')::text AS rules
    `)).rows).toEqual([{ policies: null, overrides: null, audit: null, rules: 'attendance_rules' }])
    await up(db)
    await up(db)
    expect((await pool.query(`
      SELECT enabled, version FROM attendance_timezone_policies;
    `)).rows).toEqual([])
  })
  it('distinguishes absent policy OFF from missing default and isolates two organizations', async () => {
    expect(await store.readPolicy({ orgId: 'org-a' })).toEqual({ enabled: false, version: 0 })
    await expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(error('DEFAULT_REQUIRED'))
    await pool.query('INSERT INTO attendance_rules VALUES ($1,$2,$3,true,1),($4,$5,$6,true,1)',
      [randomUUID(), 'org-a', 'Asia/Tokyo', randomUUID(), 'org-b', 'Asia/Singapore'])
    const rows = (await pool.query('SELECT id, org_id, timezone FROM attendance_rules ORDER BY org_id')).rows
    expect(await store.readDefault({ orgId: 'org-a' })).toEqual({
      orgId: 'org-a', referenceId: rows[0].id, timezone: 'Asia/Tokyo', version: 1,
    })
    expect(await store.readDefault({ orgId: 'org-b' })).toEqual({
      orgId: 'org-b', referenceId: rows[1].id, timezone: 'Asia/Singapore', version: 1,
    })
  })
  it('increments default revision on actual raw-SQL timezone change only', async () => {
    await pool.query("UPDATE attendance_rules SET timezone = 'Asia/Tokyo' WHERE org_id = 'org-a'")
    expect((await pool.query("SELECT timezone_version FROM attendance_rules WHERE org_id='org-a'")).rows)
      .toEqual([{ timezone_version: 1 }])
    await pool.query("UPDATE attendance_rules SET timezone = 'Europe/London' WHERE org_id = 'org-a'")
    expect((await pool.query("SELECT timezone_version FROM attendance_rules WHERE org_id='org-a'")).rows)
      .toEqual([{ timezone_version: 2 }])
    await expect(pool.query("UPDATE attendance_rules SET timezone_version = 1 WHERE org_id='org-a'"))
      .rejects.toMatchObject({ code: '23514' })
    await expect(down(db)).rejects.toMatchObject({ code: '55000', message: 'ATTENDANCE_TIMEZONE_ROLLBACK_BLOCKED' })
    expect((await store.readDefault({ orgId: 'org-a' }) as Input).version).toBe(2)
  })
  it('rejects invalid and duplicate persisted defaults without fallback', async () => {
    const id = randomUUID()
    await pool.query("INSERT INTO attendance_rules VALUES ($1,'invalid-org','Invalid/Sentinel',true,1)", [id])
    await expect(store.readDefault({ orgId: 'invalid-org' })).rejects.toMatchObject(error('INVALID_ZONE'))
    await pool.query("INSERT INTO attendance_rules VALUES ($1,'org-a','UTC',true,1)", [randomUUID()])
    await expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(error('MULTIPLE_DEFAULTS', 409))
    await pool.query("DELETE FROM attendance_rules WHERE org_id='org-a' AND timezone='UTC'")
  })
  it('concurrent same expected policy version permits exactly one mutation and one audit', async () => {
    const result = await Promise.allSettled([
      store.setPolicy({ ...actor, enabled: true, expectedVersion: 0 }),
      store.setPolicy({ ...actor, enabled: false, expectedVersion: 0 }),
    ])
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = result.find(item => item.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' && rejected.reason).toMatchObject(error('CONFIG_CHANGED', 409))
    const enabled = (result.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Input>).value.enabled
    expect(await store.readPolicy({ orgId: 'org-a' })).toEqual({ enabled, version: 1 })
    expect(await store.readPolicy({ orgId: 'org-b' })).toEqual({ enabled: false, version: 0 })
    expect((await pool.query('SELECT action, version FROM attendance_timezone_policy_audit')).rows)
      .toEqual([{ action: 'policy_set', version: 1 }])
    await expect(pool.query("UPDATE attendance_timezone_policies SET version=0 WHERE org_id='org-a'"))
      .rejects.toMatchObject({ code: '23514' })
  })
  it('rejects unmanaged and inactive/cross-org actors, subjects and stale policy revision', async () => {
    await expect(store.setPolicy({ orgId: 'org-b', actorId: 'actor-a', enabled: true, expectedVersion: 0 }))
      .rejects.toMatchObject(error('FORBIDDEN', 403))
    const base = { ...actor, timezone: 'Asia/Tokyo', effectiveFrom: from, effectiveTo: middle, expectedPolicyVersion: 1 }
    for (const userId of ['user-b', 'inactive', 'inactive-member']) {
      await expect(store.createEmployeeOverride({ ...base, userId }))
        .rejects.toMatchObject(error('MEMBER_REQUIRED', 403))
    }
    await expect(store.createEmployeeOverride({ ...base, userId: 'user-a', expectedPolicyVersion: 0 }))
      .rejects.toMatchObject(error('CONFIG_CHANGED', 409))
    const permissive = create({ query, transaction, authorizeManage: async () => true })
    await expect(permissive.setPolicy({ orgId: 'org-b', actorId: 'actor-a', enabled: true, expectedVersion: 0 }))
      .rejects.toMatchObject(error('MEMBER_REQUIRED', 403))
    expect((await pool.query('SELECT count(*)::integer AS count FROM attendance_employee_timezone_overrides')).rows)
      .toEqual([{ count: 0 }])
  })
  it('DB guard rejects raw cross-org, inactive, invalid-zone and invalid-interval writes', async () => {
    const sql = 'INSERT INTO attendance_employee_timezone_overrides '
      + '(org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by) '
      + 'VALUES ($1,$2,$3,$4,$5,$6,$6)'
    for (const userId of ['user-b', 'inactive', 'inactive-member']) {
      await expect(pool.query(sql, ['org-a', userId, 'UTC', from, middle, 'actor-a']))
        .rejects.toMatchObject({ code: '23503', constraint: 'attendance_employee_timezone_member_required' })
    }
    await expect(pool.query(sql, ['org-a', 'user-a', 'Invalid/Sentinel', from, middle, 'actor-a']))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(sql, ['org-a', 'user-a', 'UTC', middle, from, 'actor-a']))
      .rejects.toMatchObject({ code: '23514' })
  })
  it('DB half-open overlap guard allows adjacent rows; concurrent overlap publishes one', async () => {
    const base = { ...actor, userId: 'user-a', timezone: 'Asia/Tokyo', expectedPolicyVersion: 1 }
    const result = await Promise.allSettled([
      store.createEmployeeOverride({ ...base, effectiveFrom: from, effectiveTo: middle }),
      store.createEmployeeOverride({ ...base, effectiveFrom: from, effectiveTo: middle }),
    ])
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = result.find(item => item.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' && rejected.reason).toMatchObject(error('CONFIG_CONFLICT', 409))
    const first = (result.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Input>).value
    const second = await store.createEmployeeOverride({
      ...base, timezone: 'Asia/Singapore', effectiveFrom: middle, effectiveTo: to,
    }) as Input
    expect(await store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: from })).toEqual(first)
    expect(await store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: middle })).toEqual(second)
    expect(await store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: to })).toBeNull()
    await expect(store.readEmployeeOverride({ orgId: 'org-b', userId: 'user-a', at: from }))
      .rejects.toMatchObject(error('MEMBER_REQUIRED', 403))
    expect((await pool.query("SELECT count(*)::integer AS count FROM attendance_timezone_policy_audit WHERE action='override_created'")).rows)
      .toEqual([{ count: 2 }])
  })
  it('closing uses exact scoped revision and cannot rewrite original zone/start', async () => {
    const row = await store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: from }) as Input
    const input = { ...actor, userId: 'user-a', referenceId: row.referenceId, endAt: new Date('2026-10-12T12:00:00Z') }
    await expect(Promise.resolve().then(() => store.closeEmployeeOverride({ ...input, expectedVersion: 0 })))
      .rejects.toMatchObject(error('INVALID_REVISION'))
    await expect(store.closeEmployeeOverride({ ...input, expectedVersion: 2 }))
      .rejects.toMatchObject(error('CONFIG_CHANGED', 409))
    const creationMetadata = (await pool.query(
      'SELECT created_by, created_at FROM attendance_employee_timezone_overrides WHERE id=$1', [row.referenceId],
    )).rows
    const closed = await store.closeEmployeeOverride({ ...input, expectedVersion: 1 })
    expect((await pool.query(
      'SELECT created_by, created_at FROM attendance_employee_timezone_overrides WHERE id=$1', [row.referenceId],
    )).rows).toEqual(creationMetadata)
    expect(closed).toEqual({ ...row, version: 2, effectiveTo: input.endAt })
    await expect(pool.query("UPDATE attendance_employee_timezone_overrides SET timezone='UTC',version=version+1 WHERE id=$1", [row.referenceId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(store.closeEmployeeOverride({ ...input, orgId: 'org-b', actorId: 'actor-b', userId: 'user-b', expectedVersion: 2 }))
      .rejects.toMatchObject(error('OVERRIDE_REQUIRED', 404))
  })
  it('rollback blocks configured data and retains exact policy/override/audit counts', async () => {
    const counts = async () => (await pool.query(`
      SELECT (SELECT count(*)::integer FROM attendance_timezone_policies) AS policies,
        (SELECT count(*)::integer FROM attendance_employee_timezone_overrides) AS overrides,
        (SELECT count(*)::integer FROM attendance_timezone_policy_audit) AS audits
    `)).rows
    const before = await counts()
    expect(before).toEqual([{ policies: 1, overrides: 2, audits: 4 }])
    await expect(down(db)).rejects.toMatchObject({ code: '55000', message: 'ATTENDANCE_TIMEZONE_ROLLBACK_BLOCKED' })
    expect(await counts()).toEqual(before)
  })

  it.each(['id', 'created_at', 'created_by'])('raw SQL cannot replace immutable %s or change linked audit evidence', async column => {
    const fixtureUser = 'immutable-' + column
    await pool.query('INSERT INTO users VALUES ($1,true)', [fixtureUser])
    await pool.query("INSERT INTO user_orgs VALUES ($1,'org-a',true)", [fixtureUser])
    const configured = await store.readPolicy({ orgId: 'org-a' }) as Input
    await store.createEmployeeOverride({ ...actor, userId: fixtureUser, timezone: 'UTC',
      effectiveFrom: from, effectiveTo: middle, expectedPolicyVersion: configured.version })
    const before = (await pool.query(
      'SELECT id, version, created_by, created_at FROM attendance_employee_timezone_overrides WHERE user_id=$1', [fixtureUser],
    )).rows
    const audits = (await pool.query(
      'SELECT id, reference_id, version FROM attendance_timezone_policy_audit ORDER BY id',
    )).rows
    const replacement = column === 'id' ? 'gen_random_uuid()'
      : column === 'created_at' ? "created_at + interval '1 day'" : "'other-actor'"
    await expect(pool.query(
      'UPDATE attendance_employee_timezone_overrides SET ' + column + ' = ' + replacement
        + ', version = version + 1 WHERE id = $1', [before[0].id],
    )).rejects.toMatchObject({ code: '23514' })
    expect((await pool.query(
      'SELECT id, version, created_by, created_at FROM attendance_employee_timezone_overrides WHERE user_id=$1', [fixtureUser],
    )).rows).toEqual(before)
    expect((await pool.query(
      'SELECT id, reference_id, version FROM attendance_timezone_policy_audit ORDER BY id',
    )).rows).toEqual(audits)
  })
  it.each(['empty', 'policy', 'override', 'audit'])('rollback independently protects %s fixture with source revision one', async kind => {
    const fixtureSchema = schema + '_r_' + kind
    const fixturePool = new Pool({ connectionString: dbUrl, max: 1, options: '-c search_path=' + fixtureSchema + ',public' })
    const fixtureDb = new Kysely<unknown>({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString: dbUrl, max: 1, options: '-c search_path=' + fixtureSchema + ',public' }),
    }) })
    await bootstrap.query('CREATE SCHEMA ' + fixtureSchema)
    try {
      await fixturePool.query(`
        CREATE TABLE users (id text PRIMARY KEY, is_active boolean NOT NULL);
        CREATE TABLE user_orgs (user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL);
        CREATE TABLE attendance_rules (id uuid PRIMARY KEY, org_id text NOT NULL, timezone text NOT NULL, is_default boolean NOT NULL);
        INSERT INTO users VALUES ('fixture-user',true);
        INSERT INTO user_orgs VALUES ('fixture-user','fixture-org',true);
        INSERT INTO attendance_rules VALUES (gen_random_uuid(),'fixture-org','UTC',true)
      `)
      await up(fixtureDb)
      if (kind === 'policy') await fixturePool.query(
        "INSERT INTO attendance_timezone_policies (org_id,updated_by) VALUES ('fixture-org','fixture-user')",
      )
      if (kind === 'override') await fixturePool.query(
        'INSERT INTO attendance_employee_timezone_overrides '
          + '(org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by) '
          + "VALUES ('fixture-org','fixture-user','UTC',$1,$2,'fixture-user','fixture-user')", [from, middle],
      )
      if (kind === 'audit') await fixturePool.query(
        'INSERT INTO attendance_timezone_policy_audit (org_id,actor_id,action,reference_id,version) '
          + "VALUES ('fixture-org','fixture-user','policy_set','fixture-org',1)",
      )
      expect((await fixturePool.query('SELECT timezone_version FROM attendance_rules')).rows)
        .toEqual([{ timezone_version: 1 }])
      const contents = async () => ({
        policy: (await fixturePool.query('SELECT * FROM attendance_timezone_policies')).rows,
        override: (await fixturePool.query('SELECT * FROM attendance_employee_timezone_overrides')).rows,
        audit: (await fixturePool.query('SELECT * FROM attendance_timezone_policy_audit')).rows,
      })
      const before = await contents()
      expect(Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, rows.length])))
        .toEqual({ policy: Number(kind === 'policy'), override: Number(kind === 'override'), audit: Number(kind === 'audit') })
      if (kind === 'empty') {
        await down(fixtureDb)
        expect((await fixturePool.query('SELECT to_regclass($1)::text AS policy', [fixtureSchema + '.attendance_timezone_policies'])).rows)
          .toEqual([{ policy: null }])
        expect((await fixturePool.query('SELECT timezone FROM attendance_rules')).rows).toEqual([{ timezone: 'UTC' }])
      } else {
        await expect(down(fixtureDb)).rejects.toMatchObject({ code: '55000', message: 'ATTENDANCE_TIMEZONE_ROLLBACK_BLOCKED' })
        expect(await contents()).toEqual(before)
      }
    } finally {
      await fixtureDb.destroy()
      await fixturePool.end()
      await bootstrap.query('DROP SCHEMA IF EXISTS ' + fixtureSchema + ' CASCADE')
    }
  })
  it('rechecks actor liveness after management authorization returns from a second connection', async () => {
    await pool.query("INSERT INTO users VALUES ('race-actor',true)")
    await pool.query("INSERT INTO user_orgs VALUES ('race-actor','race-org',true)")
    let authorizerCalled = false
    const raced = create({ query, transaction, authorizeManage: async ({ actorId }) => {
      authorizerCalled = true
      await pool.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
      return true
    } })
    await expect(raced.setPolicy({ orgId: 'race-org', actorId: 'race-actor', enabled: true, expectedVersion: 0 }))
      .rejects.toMatchObject(error('MEMBER_REQUIRED', 403))
    expect(authorizerCalled).toBe(true)
    expect((await pool.query('SELECT * FROM attendance_timezone_policies WHERE org_id=$1', ['race-org'])).rows).toEqual([])
    expect((await pool.query('SELECT * FROM attendance_timezone_policy_audit WHERE org_id=$1', ['race-org'])).rows).toEqual([])
  })

  it('real closed PG adapter becomes explicit 503 rather than OFF', async () => {
    const closed = new Pool({ connectionString: dbUrl })
    await closed.end()
    const unavailable = create({ query: (sql, values) => closed.query(sql, values), transaction, authorizeManage: async () => true })
    await expect(unavailable.readPolicy({ orgId: 'org-a' })).rejects.toMatchObject(error('STORE_UNAVAILABLE', 503))
  })

  it('MUT06_EMPLOYEE_OVERRIDE_ORG_NATIVE: isolates a legal dual-org member without relabelling foreign authority', async () => {
    const client = await pool.connect()
    const userId = 'mut06-employee-org-' + randomUUID()
    const referenceId = randomUUID()
    const calls: { sql: string; values: unknown[]; rows: Input[] }[] = []
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const snapshot = async () => ({
      users: (await client.query('SELECT * FROM users ORDER BY id')).rows,
      memberships: (await client.query('SELECT * FROM user_orgs ORDER BY user_id, org_id')).rows,
      overrides: (await client.query('SELECT * FROM attendance_employee_timezone_overrides ORDER BY id')).rows,
      policies: (await client.query('SELECT * FROM attendance_timezone_policies ORDER BY org_id')).rows,
      audit: (await client.query('SELECT * FROM attendance_timezone_policy_audit ORDER BY id')).rows,
    })
    let before: Awaited<ReturnType<typeof snapshot>> | undefined
    let after: Awaited<ReturnType<typeof snapshot>> | undefined
    let catalogValidated = false
    let positiveControlPassed = false
    let scopedAbsencePassed = false
    let rolledBack = false
    try {
      await client.query('BEGIN')
      expect((await client.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
      expect((await client.query(
        "SELECT convalidated, confrelid = 'users'::regclass AS references_users, "
          + 'pg_get_constraintdef(oid) AS definition FROM pg_constraint '
          + "WHERE conrelid = 'user_orgs'::regclass AND contype = 'f' ORDER BY conname",
      )).rows).toEqual([{
        convalidated: true, references_users: true,
        definition: 'FOREIGN KEY (user_id) REFERENCES users(id)',
      }])
      expect((await client.query(
        'SELECT t.tgenabled AS enabled, t.tgtype::integer AS type, p.proname AS function_name, '
          + 'p.pronamespace = c.relnamespace AS function_in_schema '
          + 'FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid '
          + 'JOIN pg_class c ON c.oid = t.tgrelid '
          + "WHERE t.tgrelid = 'attendance_employee_timezone_overrides'::regclass "
          + "AND t.tgname = 'attendance_employee_timezone_member' AND NOT t.tgisinternal",
      )).rows).toEqual([{
        enabled: 'O', type: 23,
        function_name: 'attendance_employee_timezone_member_guard', function_in_schema: true,
      }])
      catalogValidated = true
      await client.query('INSERT INTO users (id,is_active) VALUES ($1,true)', [userId])
      await client.query(
        "INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,'org-a',true),($1,'org-b',true)",
        [userId],
      )
      await client.query(
        'INSERT INTO attendance_employee_timezone_overrides '
          + '(id,org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by) '
          + "VALUES ($1,'org-b',$2,'Asia/Singapore',$3,$4,'actor-b','actor-b')",
        [referenceId, userId, from, to],
      )
      expect((await client.query(
        'SELECT org_id,is_active FROM user_orgs WHERE user_id=$1 ORDER BY org_id', [userId],
      )).rows).toEqual([{ org_id: 'org-a', is_active: true }, { org_id: 'org-b', is_active: true }])
      expect((await client.query(
        'SELECT id,org_id,user_id,timezone,version,effective_from,effective_to,created_by,updated_by '
          + 'FROM attendance_employee_timezone_overrides WHERE user_id=$1 ORDER BY org_id', [userId],
      )).rows).toEqual([{
        id: referenceId, org_id: 'org-b', user_id: userId, timezone: 'Asia/Singapore', version: 1,
        effective_from: from, effective_to: to, created_by: 'actor-b', updated_by: 'actor-b',
      }])
      const nativeQuery: Query = async (sql, values) => {
        const result = await client.query(sql, values)
        calls.push({ sql, values, rows: result.rows })
        return result
      }
      const nativeStore = create({
        query: nativeQuery, transaction: work => work(nativeQuery), authorizeManage: async () => false,
      })
      before = await snapshot()
      expect(await nativeStore.readEmployeeOverride({ orgId: 'org-b', userId, at: middle })).toEqual({
        orgId: 'org-b', userId, referenceId, timezone: 'Asia/Singapore', version: 1,
        effectiveFrom: from, effectiveTo: to,
      })
      positiveControlPassed = true
      const scoped = await nativeStore.readEmployeeOverride({ orgId: 'org-a', userId, at: middle })
      after = await snapshot()
      expect(after).toEqual(before)
      expect(calls.map(({ sql, values }) => ({
        member: sql.includes('FROM users u JOIN user_orgs uo'),
        employee: sql.includes('FROM attendance_employee_timezone_overrides '),
        values,
      }))).toEqual([
        { member: true, employee: false, values: [userId, 'org-b'] },
        { member: false, employee: true, values: ['org-b', userId, middle] },
        { member: true, employee: false, values: [userId, 'org-a'] },
        { member: false, employee: true, values: ['org-a', userId, middle] },
      ])
      expect(calls[0].rows).toEqual([{ id: userId }])
      expect(calls[2].rows).toEqual([{ id: userId }])
      expect(scoped).toBeNull()
      scopedAbsencePassed = true
    } finally {
      try {
        await client.query('ROLLBACK')
        rolledBack = true
      } finally {
        client.release()
        console.info('MUT06_EMPLOYEE_OVERRIDE_ORG_NATIVE:', JSON.stringify({
          code: 'MUT06_EMPLOYEE_OVERRIDE_ORG_NATIVE',
          catalogValidated, positiveControlPassed, scopedAbsencePassed, rolledBack,
          storeQueryCount: calls.length,
          storeQueries: calls.map(({ sql, values, rows }, index) => ({
            ordinal: index + 1,
            sqlSHA256: createHash('sha256').update(sql).digest('hex'),
            bindingsSHA256: digest(values),
            sqlAndBindingsSHA256: digest({ sql, values }),
            rowCount: rows.length,
          })),
          beforeRowsSnapshotSHA256: before === undefined ? null : digest(before),
          afterRowsSnapshotSHA256: after === undefined ? null : digest(after),
          snapshotsEqual: before !== undefined && after !== undefined && digest(before) === digest(after),
        }))
      }
    }
  })
})
