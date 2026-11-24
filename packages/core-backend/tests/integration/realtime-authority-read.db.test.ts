/**
 * Real-PostgreSQL controls for the realtime authority reader and the installation probe.
 *
 * Connects only when EXPECT_DB=1 and DATABASE_URL are both set; without them the suite is skipped,
 * and a skip is not a pass. The positive cases read the migrated schema of the test database with
 * synthetic rows that this file inserts and removes. The cases about a missing or unreadable
 * structure run in schemas this file creates and drops, so the migrated schema is never altered.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertConnectionLoginScope, readStrictLoginInstallation } from '../../src/auth/strict-login-grant-store'
import { STRICT_LOGIN_GRANT_MIGRATION_NAME, up as strictScopeUp } from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'
import { decideRealtimeAdmission } from '../../src/realtime-authz/admission'
import { createRealtimeAuthorityReader, type AuthorityQuery } from '../../src/realtime-authz/authority-read'
import {
  enablementRecordNotDefinedInThisBuild,
  probeRealtimeInstallation,
  type ProbeCaller,
  type RealtimeInstallationFacts,
} from '../../src/realtime-authz/installation-probe'
import { bindVerifiedSessionClaims, bindingKey, type RealtimeSessionBinding } from '../../src/realtime-authz/session-binding'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for realtime-authority-read.db.test.ts')
}
const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip

const RUN = `a2rt${randomBytes(5).toString('hex')}`
const ORG = `${RUN}-org`
const keptSchemas: string[] = []
const keptRoles: string[] = []
let pool: Pool

const classify = () => 'standard' as const
function session(userId: string, claims: Record<string, unknown> = {}): RealtimeSessionBinding {
  const binding = bindVerifiedSessionClaims({ userId, iat: Math.floor(Date.now() / 1000), exp: 9_999_999_999, ...claims }, classify)
  if (!binding) throw new Error('fixture did not bind')
  return binding
}

function counted(target: Pool): { query: AuthorityQuery; statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    query: async (sql, params) => {
      statements.push(sql)
      const result = await target.query(sql, params)
      return { rows: result.rows }
    },
  }
}

const neverStrict = async (): Promise<boolean> => {
  throw new Error('no strict session in this file')
}

async function user(id: string, overrides: { isActive?: boolean; activation?: string; role?: string } = {}): Promise<string> {
  const userId = `${RUN}-${id}`
  await pool.query(
    `INSERT INTO users(
       id, username, email, name, password_hash, role, is_admin, is_active,
       activation_status, must_change_password, local_password_set, created_at, updated_at
     ) VALUES ($1, $1, $2, 'Synthetic user', 'x', $3, FALSE, $4, $5, FALSE, TRUE, NOW(), NOW())`,
    [userId, `${userId}@synthetic.invalid`, overrides.role ?? 'user', overrides.isActive ?? true, overrides.activation ?? 'activated'],
  )
  return userId
}

async function member(userId: string, isActive = true): Promise<void> {
  await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)', [userId, ORG, isActive])
}

async function registeredSession(userId: string, revoked = false): Promise<string> {
  const sid = `${RUN}-${randomUUID()}`
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, issued_at, expires_at, last_seen_at, revoked_at)
     VALUES ($1, $2, NOW(), NOW() + interval '1 hour', NOW(), $3)`,
    [sid, userId, revoked ? new Date() : null],
  )
  return sid
}

async function verdictOf(binding: RealtimeSessionBinding, target: Pool = pool) {
  const reader = createRealtimeAuthorityReader({ query: counted(target).query, verifyStrict: neverStrict })
  return (await reader.read([binding])).get(bindingKey(binding))
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('fixture identifier refused')
  return `"${name}"`
}

async function isolatedSchema(): Promise<{ schema: string; pool: Pool }> {
  const schema = `a2rt${randomBytes(8).toString('hex')}`
  keptSchemas.push(schema)
  await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`)
  return { schema, pool: new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog`, max: 2 }) }
}

/** Minimal copies of the four tables the reader joins, enough to answer `allowed` for one user. */
async function authorityFixture(target: Pool, userId: string, omit: string[] = []): Promise<void> {
  const tables: Record<string, string> = {
    users: `CREATE TABLE users (id text PRIMARY KEY, is_active boolean, role text, activation_status text);
            INSERT INTO users VALUES ('${userId}', true, 'user', 'activated')`,
    user_session_revocations: 'CREATE TABLE user_session_revocations (user_id text PRIMARY KEY, revoked_after timestamptz)',
    user_orgs: `CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean);
                INSERT INTO user_orgs VALUES ('${userId}', 'o1', true)`,
    user_sessions: `CREATE TABLE user_sessions (id text PRIMARY KEY, user_id text, revoked_at timestamptz);
                    INSERT INTO user_sessions VALUES ('s1', '${userId}', NULL)`,
  }
  for (const [name, ddl] of Object.entries(tables)) if (!omit.includes(name)) await target.query(ddl)
}

async function probeWith(target: Pool): Promise<RealtimeInstallationFacts> {
  return probeRealtimeInstallation({
    withReadOnlySnapshot: async (work) => {
      const client = await target.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const caller: ProbeCaller = { query: async (sql, params) => client.query(sql, params) }
        return await work(caller)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    },
    readStrictInstallation: async (caller) => (await readStrictLoginInstallation(caller)).installation,
    readEnablement: enablementRecordNotDefinedInThisBuild,
  })
}

async function strictGenerationParents(target: Pool): Promise<void> {
  await target.query(`
    -- fixture parents of the strict login scope generation
    CREATE TABLE kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL);
    CREATE TABLE directory_integrations (id uuid PRIMARY KEY);
    CREATE TABLE user_external_identities (id uuid PRIMARY KEY);
    CREATE TABLE user_external_identity_evidence (id text PRIMARY KEY);
    CREATE TABLE security_action_challenges (id uuid PRIMARY KEY, purpose text, status text);
    CREATE TABLE user_sessions (id text PRIMARY KEY);
    CREATE TABLE user_session_revocations (user_id text PRIMARY KEY);
    CREATE TABLE directory_deprovision_events (id uuid PRIMARY KEY);
    CREATE TABLE directory_sync_runs (id uuid PRIMARY KEY);
  `)
}

async function installStrictGeneration(target: Pool): Promise<void> {
  await strictGenerationParents(target)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: target }) })
  await db.transaction().execute(async (trx) => { await strictScopeUp(trx) })
  await target.query('INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)', [STRICT_LOGIN_GRANT_MIGRATION_NAME, new Date().toISOString()])
}

beforeAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  pool = new Pool({ connectionString: databaseUrl, max: 4 })
})

afterAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  try {
    await pool.query('DELETE FROM user_sessions WHERE id LIKE $1', [`${RUN}-%`])
    await pool.query('DELETE FROM user_session_revocations WHERE user_id LIKE $1', [`${RUN}-%`])
    await pool.query('DELETE FROM user_orgs WHERE user_id LIKE $1', [`${RUN}-%`])
    await pool.query('DELETE FROM users WHERE id LIKE $1', [`${RUN}-%`])
    for (const schema of keptSchemas) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    for (const role of keptRoles) await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`)
  } finally {
    await pool.end()
  }
})

describeDb('realtime authority reader on the migrated schema', () => {
  it('allows an active member with an open registered session and no watermark', async () => {
    const userId = await user('ok')
    await member(userId)
    const sid = await registeredSession(userId)
    expect(await verdictOf(session(userId, { sid, tenantId: ORG }))).toEqual({ state: 'allowed' })
    expect(await verdictOf(session(userId))).toEqual({ state: 'allowed' })
  })

  it('denies a user that is missing, inactive, disabled, pending activation or in the recycle bin', async () => {
    expect(await verdictOf(session(`${RUN}-nobody`))).toEqual({ state: 'denied', reason: 'user-missing' })
    expect(await verdictOf(session(await user('inactive', { isActive: false })))).toEqual({ state: 'denied', reason: 'user-not-active' })
    expect(await verdictOf(session(await user('disabled', { role: 'disabled' })))).toEqual({ state: 'denied', reason: 'user-not-active' })
    expect(await verdictOf(session(await user('pending', { activation: 'pending_activation' })))).toEqual({ state: 'denied', reason: 'user-not-active' })
    const recycled = await user('recycled')
    const columns = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'deleted_at'`,
    )
    expect(columns.rows).toHaveLength(1)
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [recycled])
    expect(await verdictOf(session(recycled))).toEqual({ state: 'denied', reason: 'user-not-active' })
  })

  it('applies the watermark to credentials issued at or before it and not to later ones', async () => {
    const userId = await user('watermark')
    const base = 1_900_000_000
    await pool.query(
      `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
       VALUES ($1, to_timestamp($2::double precision), NOW(), 'fixture', 'fixture')`,
      [userId, base + 0.4],
    )
    expect(await verdictOf(session(userId, { iat: base - 1 }))).toEqual({ state: 'denied', reason: 'watermark-applies' })
    expect(await verdictOf(session(userId, { iat: base }))).toEqual({ state: 'denied', reason: 'watermark-applies' })
    expect(await verdictOf(session(userId, { iat: base + 1 }))).toEqual({ state: 'allowed' })
    expect(await verdictOf(session(userId, { iat: undefined }))).toEqual({ state: 'denied', reason: 'watermark-applies' })
    // The first insertion of a watermark for a user that had none is seen by the very next read.
    const fresh = await user('first-watermark')
    const binding = session(fresh, { iat: Math.floor(Date.now() / 1000) - 5 })
    expect(await verdictOf(binding)).toEqual({ state: 'allowed' })
    await pool.query(
      `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason) VALUES ($1, NOW(), NOW(), 'fixture', 'fixture')`,
      [fresh],
    )
    expect(await verdictOf(binding)).toEqual({ state: 'denied', reason: 'watermark-applies' })
  })

  it('denies a registered session that is revoked, missing or of another user', async () => {
    const userId = await user('sessions')
    const other = await user('sessions-other')
    const open = await registeredSession(userId)
    expect(await verdictOf(session(userId, { sid: open }))).toEqual({ state: 'allowed' })
    await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1', [open])
    expect(await verdictOf(session(userId, { sid: open }))).toEqual({ state: 'denied', reason: 'session-not-current' })
    expect(await verdictOf(session(userId, { sid: `${RUN}-absent` }))).toEqual({ state: 'denied', reason: 'session-not-current' })
    const foreign = await registeredSession(other)
    expect(await verdictOf(session(userId, { sid: foreign }))).toEqual({ state: 'denied', reason: 'session-not-current' })
  })

  it('denies a credential whose organization membership is inactive or gone, and only that organization', async () => {
    const userId = await user('member')
    await member(userId)
    expect(await verdictOf(session(userId, { tenantId: ORG }))).toEqual({ state: 'allowed' })
    await pool.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [userId, ORG])
    expect(await verdictOf(session(userId, { tenantId: ORG }))).toEqual({ state: 'denied', reason: 'membership-lost' })
    await pool.query('DELETE FROM user_orgs WHERE user_id = $1', [userId])
    expect(await verdictOf(session(userId, { tenantId: ORG }))).toEqual({ state: 'denied', reason: 'membership-lost' })
    expect(await verdictOf(session(userId))).toEqual({ state: 'allowed' })
  })

  it('answers a batch of sixty sessions with two statements and keeps each answer with its own session', async () => {
    const bindings: RealtimeSessionBinding[] = []
    const expected: string[] = []
    for (let index = 0; index < 60; index += 1) {
      const active = index % 3 !== 0
      const userId = await user(`batch-${index}`, { isActive: active })
      const sid = await registeredSession(userId, index % 5 === 0)
      bindings.push(session(userId, { sid }))
      expected.push(!active ? 'denied:user-not-active' : index % 5 === 0 ? 'denied:session-not-current' : 'allowed')
    }
    const { query, statements } = counted(pool)
    const verdicts = await createRealtimeAuthorityReader({ query, verifyStrict: neverStrict }).read(bindings)
    expect(statements).toHaveLength(2)
    expect(bindings.map((binding) => {
      const verdict = verdicts.get(bindingKey(binding))
      return verdict?.state === 'denied' ? `denied:${verdict.reason}` : verdict?.state
    })).toEqual(expected)
  })
})

describeDb('realtime authority reader when a structure cannot be read', () => {
  it('positive control: the minimal fixture answers allowed', async () => {
    const isolated = await isolatedSchema()
    try {
      await authorityFixture(isolated.pool, 'u1')
      expect(await verdictOf(session('u1', { sid: 's1', tenantId: 'o1' }), isolated.pool)).toEqual({ state: 'allowed' })
    } finally {
      await isolated.pool.end()
    }
  })

  it.each([
    ['the user table', 'users'],
    ['the watermark table', 'user_session_revocations'],
    ['the membership table', 'user_orgs'],
    ['the session table', 'user_sessions'],
  ])('answers unknown when %s is missing', async (_label, table) => {
    const isolated = await isolatedSchema()
    try {
      await authorityFixture(isolated.pool, 'u1', [table])
      expect(await verdictOf(session('u1', { sid: 's1', tenantId: 'o1' }), isolated.pool))
        .toEqual({ state: 'unknown', reason: 'authority-read-failed' })
    } finally {
      await isolated.pool.end()
    }
  })

  it('answers unknown when the watermark table was renamed, and allowed again once it is back', async () => {
    const isolated = await isolatedSchema()
    try {
      await authorityFixture(isolated.pool, 'u1')
      const binding = session('u1', { sid: 's1', tenantId: 'o1' })
      await isolated.pool.query('ALTER TABLE user_session_revocations RENAME TO user_session_revocations_moved')
      expect(await verdictOf(binding, isolated.pool)).toEqual({ state: 'unknown', reason: 'authority-read-failed' })
      await isolated.pool.query('ALTER TABLE user_session_revocations_moved RENAME TO user_session_revocations')
      expect(await verdictOf(binding, isolated.pool)).toEqual({ state: 'allowed' })
    } finally {
      await isolated.pool.end()
    }
  })

  it.each(['user_session_revocations', 'user_sessions'])('answers unknown when the reading role may not read %s', async (table) => {
    const isolated = await isolatedSchema()
    const role = `a2rt_reader_${randomBytes(6).toString('hex')}`
    keptRoles.push(role)
    try {
      await authorityFixture(isolated.pool, 'u1')
      await pool.query(`CREATE ROLE ${quoteIdent(role)} NOLOGIN`)
      await pool.query(`GRANT USAGE ON SCHEMA ${quoteIdent(isolated.schema)} TO ${quoteIdent(role)}`)
      await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(isolated.schema)} TO ${quoteIdent(role)}`)
      const client = await isolated.pool.connect()
      try {
        await client.query(`SET ROLE ${quoteIdent(role)}`)
        const asRole: AuthorityQuery = async (sql, params) => ({ rows: (await client.query(sql, params)).rows })
        const binding = session('u1', { sid: 's1', tenantId: 'o1' })
        const read = async () => (await createRealtimeAuthorityReader({ query: asRole, verifyStrict: neverStrict }).read([binding])).get(bindingKey(binding))
        expect(await read()).toEqual({ state: 'allowed' })
        await pool.query(`REVOKE SELECT ON ${quoteIdent(isolated.schema)}.${quoteIdent(table)} FROM ${quoteIdent(role)}`)
        expect(await read()).toEqual({ state: 'unknown', reason: 'authority-read-failed' })
      } finally {
        await client.query('RESET ROLE').catch(() => undefined)
        client.release()
      }
      await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(isolated.schema)} FROM ${quoteIdent(role)}`)
      await pool.query(`REVOKE ALL ON SCHEMA ${quoteIdent(isolated.schema)} FROM ${quoteIdent(role)}`)
    } finally {
      await isolated.pool.end()
    }
  })
})

describeDb('installation probe on real structures', () => {
  it('reads the migrated schema as installed, and this build as unable to read an enablement record', async () => {
    const facts = await probeWith(pool)
    expect(facts.strictScope.state).toBe('installed')
    expect(facts.enablement).toEqual({ state: 'never-installed', definedInThisBuild: false })
  })

  it('reads a schema with an empty ledger and no object of the generation as never-installed', async () => {
    const isolated = await isolatedSchema()
    try {
      await isolated.pool.query('CREATE TABLE kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)')
      const facts = await probeWith(isolated.pool)
      expect(facts.strictScope).toEqual({ state: 'never-installed' })
      expect(decideRealtimeAdmission({ revalidation: 'off', credentialChain: 'off', facts, listener: 'not-started' }).row).toBe('off-baseline')
    } finally {
      await isolated.pool.end()
    }
  })

  it('reads a complete generation with an empty scope table as installed without scope, and sees the first committed scope row', async () => {
    const isolated = await isolatedSchema()
    try {
      await installStrictGeneration(isolated.pool)
      const empty = await probeWith(isolated.pool)
      expect(empty.strictScope).toEqual({ state: 'installed', hasScope: false })
      expect(decideRealtimeAdmission({ revalidation: 'off', credentialChain: 'off', facts: empty, listener: 'not-started' }).row).toBe('off-baseline')

      const connectionId = randomUUID()
      await isolated.pool.query('INSERT INTO directory_integrations (id) VALUES ($1)', [connectionId])
      const client = await isolated.pool.connect()
      try {
        await client.query('BEGIN')
        await insertConnectionLoginScope(
          { query: async (text, params) => client.query(text, params) },
          { connectionId, commandId: 'fixture-command' },
        )
        // Not committed yet: another session still reads no scope.
        expect((await probeWith(isolated.pool)).strictScope).toEqual({ state: 'installed', hasScope: false })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const scoped = await probeWith(isolated.pool)
      expect(scoped.strictScope).toEqual({ state: 'installed', hasScope: true })
      const off = decideRealtimeAdmission({ revalidation: 'off', credentialChain: 'off', facts: scoped, listener: 'not-started' })
      expect(off).toMatchObject({ row: 'off-enabled-environment', ordinaryHandshake: 'refuse', established: 'terminate' })
    } finally {
      await isolated.pool.end()
    }
  })

  it.each([
    ['a registered generation with a missing table', async (target: Pool) => {
      await installStrictGeneration(target)
      await target.query('DROP TABLE user_external_identity_login_grants CASCADE')
    }],
    ['a renamed scope table', async (target: Pool) => {
      await installStrictGeneration(target)
      await target.query('ALTER TABLE directory_connection_login_scope RENAME TO directory_connection_login_scope_moved')
    }],
    ['leftover objects without a registration', async (target: Pool) => {
      await installStrictGeneration(target)
      await target.query('DELETE FROM kysely_migration')
    }],
    ['a registration without any object', async (target: Pool) => {
      await target.query('CREATE TABLE kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)')
      await target.query('INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)', [STRICT_LOGIN_GRANT_MIGRATION_NAME, 'x'])
    }],
    ['no migration ledger at all', async () => undefined],
  ])('reads %s as unknown, and unknown suspends protected traffic: handshakes are held with the switch off and refused with it on', async (_label, arrange) => {
    const isolated = await isolatedSchema()
    try {
      await arrange(isolated.pool)
      const facts = await probeWith(isolated.pool)
      expect(facts.strictScope).toEqual({ state: 'unknown' })
      expect(decideRealtimeAdmission({ revalidation: 'off', credentialChain: 'off', facts, listener: 'not-started' }))
        .toMatchObject({ row: 'undetermined', ordinaryHandshake: 'hold', strictHandshake: 'hold', established: 'suspend' })
      expect(decideRealtimeAdmission({ revalidation: 'on', credentialChain: 'off', facts, listener: 'ready' }))
        .toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend' })
    } finally {
      await isolated.pool.end()
    }
  })

  it('reads unknown when the scope table may not be read, and installed again once it may', async () => {
    const isolated = await isolatedSchema()
    const role = `a2rt_probe_${randomBytes(6).toString('hex')}`
    keptRoles.push(role)
    try {
      await installStrictGeneration(isolated.pool)
      await pool.query(`CREATE ROLE ${quoteIdent(role)} NOLOGIN`)
      await pool.query(`GRANT USAGE ON SCHEMA ${quoteIdent(isolated.schema)} TO ${quoteIdent(role)}`)
      await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(isolated.schema)} TO ${quoteIdent(role)}`)
      const asRole = new Pool({ connectionString: databaseUrl, options: `-c search_path=${isolated.schema},pg_catalog -c role=${role}`, max: 1 })
      try {
        expect((await probeWith(asRole)).strictScope).toEqual({ state: 'installed', hasScope: false })
        await pool.query(`REVOKE SELECT ON ${quoteIdent(isolated.schema)}.directory_connection_login_scope FROM ${quoteIdent(role)}`)
        expect((await probeWith(asRole)).strictScope).toEqual({ state: 'unknown' })
        await pool.query(`GRANT SELECT ON ${quoteIdent(isolated.schema)}.directory_connection_login_scope TO ${quoteIdent(role)}`)
        expect((await probeWith(asRole)).strictScope).toEqual({ state: 'installed', hasScope: false })
      } finally {
        await asRole.end()
      }
      await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(isolated.schema)} FROM ${quoteIdent(role)}`)
      await pool.query(`REVOKE ALL ON SCHEMA ${quoteIdent(isolated.schema)} FROM ${quoteIdent(role)}`)
    } finally {
      await isolated.pool.end()
    }
  })
})
