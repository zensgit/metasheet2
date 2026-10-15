/**
 * SA-06: live actor authority against PostgreSQL, not an Automation port acceptance.
 * The six authority tables below reproduce the columns/keys actually consumed;
 * this is not a migration/HTTP/JWT/source-owner/request/outbox test. Every subject
 * and permission is synthetic and confined to a new random schema. Competing
 * sessions prove the adopted authorization rows remain locked until commit and
 * revocation is observed by the next transaction. No remote source is configured.
 */
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertAutomationIntegrationActor } from '../../src/integration/automation-live-authority'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const input = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null } as const
const denied = { code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' }
const transactionRequired = { code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED' }

describeDatabase('Automation live actor authority: real locked evidence', () => {
  const schema = `automation_actor_${randomBytes(8).toString('hex')}`
  let pool: Pool
  let admin: PoolClient
  let actor: PoolClient
  let revoker: PoolClient
  let observer: PoolClient
  let actorPid: number
  let revokerPid: number

  const begin = (client: PoolClient) => client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  async function authorize(): Promise<void> {
    await begin(actor)
    try { await assertAutomationIntegrationActor(actor, input) }
    finally { await actor.query('ROLLBACK') }
  }

  beforeAll(async () => {
    if (!/^automation_actor_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    // Types/keys mirror current users, RBAC, membership and namespace tables.
    // Unrelated login/profile/audit columns are intentionally not fabricated.
    await admin.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb,
        is_active boolean, activation_status text, local_password_set boolean, is_admin boolean);
      CREATE TABLE user_roles (user_id varchar(255), role_id varchar(255), PRIMARY KEY(user_id, role_id));
      CREATE TABLE role_permissions (role_id varchar(255), permission_code varchar(255), PRIMARY KEY(role_id, permission_code));
      CREATE TABLE user_permissions (user_id varchar(255), permission_code varchar(255), PRIMARY KEY(user_id, permission_code));
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean NOT NULL, PRIMARY KEY(user_id, org_id));
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean NOT NULL DEFAULT false,
        UNIQUE(user_id, namespace));
    `)
    actor = await pool.connect()
    revoker = await pool.connect()
    observer = await pool.connect()
    for (const client of [actor, revoker, observer]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '10s'")
    }
    actorPid = Number((await actor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    revokerPid = Number((await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  })

  afterAll(async () => {
    for (const client of [actor, revoker, observer]) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
    if (admin) {
      // The exact random schema was created above by this test; never public.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    await actor.query('ROLLBACK')
    await revoker.query('ROLLBACK')
    await admin.query('TRUNCATE users, user_roles, role_permissions, user_permissions, user_orgs, user_namespace_admissions')
    await admin.query(`INSERT INTO users VALUES ($1, 'user', '[]', true, 'activated', false, false)`, [input.actorId])
    await admin.query('INSERT INTO user_orgs VALUES ($1, $2, true)', [input.actorId, input.tenantId])
    // Always populate unrelated positive authority. An omitted WHERE must not
    // pass merely because the synthetic database contains only the one actor.
    await admin.query(`INSERT INTO users VALUES ('synthetic-other-actor', 'admin', '["role:admin"]', true, 'activated', false, true)`)
    await admin.query(`INSERT INTO user_roles VALUES ('synthetic-other-actor', 'admin'), ('synthetic-other-actor', 'foreign_admin')`)
    await admin.query(`INSERT INTO role_permissions VALUES ('foreign_admin', 'integration:admin'), ('foreign_admin', 'role:admin')`)
    await admin.query(`INSERT INTO user_permissions VALUES ('synthetic-other-actor', 'role:admin')`)
    await admin.query("INSERT INTO user_orgs VALUES ('synthetic-other-actor', $1, true), ($2, 'synthetic-other-tenant', true)", [input.tenantId, input.actorId])
    await admin.query(`INSERT INTO user_namespace_admissions VALUES ('synthetic-other-actor', 'integration', true)`)
  })

  async function grant(mode: 'normalized' | 'legacy-role' | 'role-permission' | 'direct' | 'legacy-permission' | 'role-code') {
    if (mode === 'normalized') {
      await admin.query("INSERT INTO user_roles VALUES ($1, 'admin')", [input.actorId])
    } else if (mode === 'legacy-role') {
      await admin.query("UPDATE users SET role = 'admin' WHERE id = $1", [input.actorId])
    } else if (mode === 'role-code') {
      await admin.query("INSERT INTO user_permissions VALUES ($1, 'role:admin')", [input.actorId])
    } else {
      const role = mode === 'role-permission' ? 'synthetic-reader' : 'integration_admin'
      await admin.query('INSERT INTO user_roles VALUES ($1, $2)', [input.actorId, role])
      await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [input.actorId])
      if (mode === 'role-permission') {
        await admin.query("INSERT INTO role_permissions VALUES ($1, 'integration:admin')", [role])
      } else if (mode === 'direct') {
        await admin.query("INSERT INTO user_permissions VALUES ($1, 'integration:admin')", [input.actorId])
      } else {
        await admin.query(`UPDATE users SET permissions = '["integration:admin"]' WHERE id = $1`, [input.actorId])
      }
    }
  }

  it.each(['normalized', 'legacy-role', 'role-permission', 'direct', 'legacy-permission', 'role-code'] as const)(
    'accepts current exact %s authority in a real transaction', async (mode) => {
      await grant(mode)
      await expect(authorize()).resolves.toBeUndefined()
    },
  )

  it('rejects raw client/autocommit, a forged pool marker and non-read-committed isolation', async () => {
    await grant('normalized')
    await expect(assertAutomationIntegrationActor(actor, input)).rejects.toMatchObject(transactionRequired)
    const forged = { isTransaction: true, query: pool.query.bind(pool) } as Queryable
    await expect(assertAutomationIntegrationActor(forged, input)).rejects.toMatchObject(transactionRequired)
    await actor.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try { await expect(assertAutomationIntegrationActor(actor, input)).rejects.toMatchObject(transactionRequired) }
    finally { await actor.query('ROLLBACK') }
  })

  it('an enabled admission plus direct permission without a role-derived namespace still refuses', async () => {
    await admin.query("INSERT INTO user_permissions VALUES ($1, 'integration:admin')", [input.actorId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [input.actorId])
    await expect(authorize()).rejects.toMatchObject(denied)
  })

  it('is_admin alone and wildcard-only permissions are not integration admin', async () => {
    await admin.query(`UPDATE users SET is_admin = true, permissions = '["*:*", "integration:*"]' WHERE id = $1`, [input.actorId])
    await expect(authorize()).rejects.toMatchObject(denied)
  })

  it('does not borrow any of another actor\'s normalized, direct or role-permission admin grants', async () => {
    await expect(authorize()).rejects.toMatchObject(denied)
  })

  it('does not borrow another actor\'s enabled namespace admission', async () => {
    await grant('direct')
    await admin.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [input.actorId])
    await expect(authorize()).rejects.toMatchObject(denied)
  })

  it('does not borrow a different tenant or actor membership even for a platform admin', async () => {
    await grant('normalized')
    await admin.query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [input.actorId, input.tenantId])
    await expect(authorize()).rejects.toMatchObject(denied)
  })

  const revocations = [
    ['normalized role', 'normalized', 'DELETE FROM user_roles WHERE user_id = $1'],
    ['role permission', 'role-permission', "DELETE FROM role_permissions WHERE role_id = 'synthetic-reader' AND $1::text IS NOT NULL"],
    ['direct permission', 'direct', 'DELETE FROM user_permissions WHERE user_id = $1'],
    ['legacy role', 'legacy-role', "UPDATE users SET role = 'user' WHERE id = $1"],
    ['legacy permission', 'legacy-permission', "UPDATE users SET permissions = '[]' WHERE id = $1"],
    ['active user', 'normalized', 'UPDATE users SET is_active = false WHERE id = $1'],
    ['activation status', 'normalized', "UPDATE users SET activation_status = 'pending_activation' WHERE id = $1"],
    ['tenant membership', 'normalized', 'UPDATE user_orgs SET is_active = false WHERE user_id = $1'],
    ['namespace admission', 'direct', 'UPDATE user_namespace_admissions SET enabled = false WHERE user_id = $1'],
    ['namespace role', 'direct', 'DELETE FROM user_roles WHERE user_id = $1'],
  ] as const

  async function observeBlocked(waiterPid: number, blockerPid: number, done: () => boolean): Promise<void> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const result = await observer.query(`SELECT wait_event_type = 'Lock' AS waiting,
        $2::int = ANY(pg_blocking_pids(pid)) AS ours FROM pg_stat_activity WHERE pid = $1`, [waiterPid, blockerPid])
      if (result.rows[0]?.waiting === true && result.rows[0]?.ours === true) return
      expect(done(), 'competing transaction must not finish before adopted authority locks release').toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Expected same-task PostgreSQL lock wait was not observed')
  }

  it.each(revocations)('holds %s evidence until commit, then rejects the next attempt', async (_label, mode, sql) => {
    await grant(mode)
    await begin(actor)
    await begin(revoker)
    let pending: Promise<unknown> | undefined
    let done = false
    try {
      await assertAutomationIntegrationActor(actor, input)
      pending = revoker.query(sql, [input.actorId]).then(() => { done = true }, (error: unknown) => { done = true; throw error })
      // Attach a rejection handler immediately, even when the assertion fails.
      void pending.catch(() => {})
      await observeBlocked(revokerPid, actorPid, () => done)
      await actor.query('COMMIT')
      await pending
      await revoker.query('COMMIT')
      await expect(authorize()).rejects.toMatchObject(denied)
    } finally {
      await actor.query('ROLLBACK')
      await pending?.catch(() => {})
      await revoker.query('ROLLBACK')
    }
  })

  it('revocation already in flight is waited for and observed before authorization returns', async () => {
    await grant('normalized')
    await begin(revoker)
    await revoker.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1', [input.actorId])
    await begin(actor)
    let done = false
    const pending = assertAutomationIntegrationActor(actor, input).then(
      () => { done = true; return { allowed: true } },
      (error: unknown) => { done = true; return { error } },
    )
    try {
      await observeBlocked(actorPid, revokerPid, () => done)
      await revoker.query('COMMIT')
      expect(await pending).toMatchObject({ error: denied })
    } finally {
      await revoker.query('ROLLBACK')
      await pending
      await actor.query('ROLLBACK')
    }
  })

  it('does not adopt newly inserted authority that was absent from its locked role snapshot', async () => {
    await begin(actor)
    let crossed = false
    const handle: Queryable = {
      async query(sql, params) {
        const result = await actor.query(sql, params)
        if (/FROM\s+user_roles\b/i.test(sql) && !crossed) {
          crossed = true
          expect(result.rows).toHaveLength(0)
          // This insert is not protected by the first SELECT's row locks.
          await revoker.query("INSERT INTO user_roles VALUES ($1, 'admin')", [input.actorId])
        }
        return result
      },
    }
    try {
      await expect(assertAutomationIntegrationActor(handle, input)).rejects.toMatchObject(denied)
      expect(crossed).toBe(true)
    } finally { await actor.query('ROLLBACK') }
    await expect(authorize()).resolves.toBeUndefined()
  })

  it('SQL/schema failures produce only a stable private-boundary error, never an allow or SQL message', async () => {
    await grant('normalized')
    await begin(actor)
    try {
      await actor.query('ALTER TABLE user_orgs RENAME TO temporarily_unavailable_membership')
      await expect(assertAutomationIntegrationActor(actor, input)).rejects.toMatchObject({
        code: 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE',
      })
    } finally { await actor.query('ROLLBACK') }
    await expect(authorize()).resolves.toBeUndefined()
  })
})
