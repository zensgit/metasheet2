import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pg'
import { activatePendingUser } from '../../src/auth/user-activate'
import { poolManager } from '../../src/integration/db/connection-pool'
import { runtimeJwtSecret } from '../helpers/runtime-jwt-secret'

// Two-point wiring self-check (feedback: an unwired *.db.test.ts skip-greens forever). This
// suite must be BOTH excluded from the no-DB job (so it cannot skip-green there) AND listed in
// the approval real-DB run list (so it actually executes). If either point is dropped, this
// runs — and reds — in the real-DB job.
describe('directory-activation-source-lock wiring', () => {
  const filename = 'tests/integration/directory-activation-source-lock.db.test.ts'
  const repoRoot = path.resolve(__dirname, '../../../..')
  it('is excluded from the no-DB job and wired into the approval real-DB step', () => {
    const vitestConfig = readFileSync(
      path.join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    expect(vitestConfig).toContain(filename)
    expect(workflow).toContain(filename)
  })
})

/**
 * Post-merge review P1 (2026-08-10): T3 activation locks `users` but read the directory source
 * (account/link/integration) UNLOCKED. Under READ COMMITTED an admin could deactivate the
 * integration on another connection and COMMIT between the source read and the activation's own
 * commit — activating a user against a now-inactive source, violating "admin 激活不得对 inactive
 * 目录源静默开通". The fix adds `FOR SHARE OF ... di` to the source read.
 *
 * This is a CONSTRUCTED race, not a sequential argument: a second connection holds an
 * uncommitted integration deactivation, and we prove — via pg_locks — that the real
 * activatePendingUser BLOCKS on that transaction (its FOR SHARE cannot proceed). When the
 * deactivation then commits, the FOR SHARE's READ COMMITTED EPQ recheck refetches the fresh
 * 'inactive' status and the activation refuses ACTIVATE_INTEGRATION_INACTIVE, writing nothing.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
if (process.env.EXPECT_DB === '1')
  it('DB lane must not skip', () =>
    expect(process.env.DATABASE_URL).toBeTruthy())
const TS = Date.now()
const PREFIX = `t3-src-lock-${TS}`

type Seeded = {
  userId: string
  orgId: string
  integrationId: string
  accountId: string
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM user_login_aliases WHERE user_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM directory_account_links WHERE local_user_id LIKE $1`, [`${PREFIX}%`])
  await query(
    `DELETE FROM directory_accounts WHERE integration_id IN
       (SELECT id FROM directory_integrations WHERE org_id LIKE $1)`,
    [`${PREFIX}%`],
  )
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}%`])
}

async function seed(): Promise<Seeded> {
  const orgId = `${PREFIX}-org-${randomUUID()}`
  const userId = `${PREFIX}-user-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, org_id, provider, status, default_deprovision_policy)
     VALUES ($1, $2, $3, 'dingtalk', 'active', 'manual_review')
     RETURNING id::text AS id`,
    [`${PREFIX}-integration`, `${PREFIX}-corp-${randomUUID()}`, orgId],
  )
  const integrationId = integration.rows[0].id
  await query(
    `INSERT INTO users (id, email, password_hash, is_active, activation_status, local_password_set)
     VALUES ($1, $2, 'x', FALSE, 'pending_activation', FALSE)`,
    [userId, `${userId}@example.com`],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, 'dingtalk', $2, $3, 'Source', TRUE)
     RETURNING id::text AS id`,
    [integrationId, `${PREFIX}-ext-${randomUUID()}`, `dingtalk:${PREFIX}:${randomUUID()}`],
  )
  const accountId = account.rows[0].id
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [accountId, userId],
  )
  return { userId, orgId, integrationId, accountId }
}

describeIfDatabase('T3 activation source read serialises against integration deactivation (real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it.each(['release', 'cancel', 'activation-first', 'app-mismatch'] as const)('serializes the source-less OAuth activation and its session with the first cutover (%s)', async decision => {
    const target = await seed()
    const admin = `${PREFIX}-admin-${randomUUID()}`
    const corp = `corp-${target.integrationId}`
    const openId = `open-${target.accountId}`, unionId = `union-${target.accountId}`
    const loginApp = `login-${randomUUID()}`
    await query("INSERT INTO users(id,email,password_hash,role,is_active,activation_status) VALUES($1,$2,'x','admin',true,'activated')", [admin, `${admin}@example.invalid`])
    await query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [admin])
    await query('UPDATE directory_integrations SET corp_id=$1,config=$2 WHERE id=$3', [corp, { appKey: `directory-${randomUUID()}` }, target.integrationId])
    await query('UPDATE directory_accounts SET corp_id=$1,open_id=$2,union_id=$3 WHERE id=$4', [corp, openId, unionId, target.accountId])
    vi.stubEnv('DINGTALK_CORP_ID', corp)
    vi.stubEnv('DINGTALK_CLIENT_ID', loginApp)
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'synthetic')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://example.invalid/callback')
    vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'false')
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let pending: Promise<request.Response> | undefined
    let unlock!: () => void
    const commitGate = new Promise<void>(resolve => { unlock = resolve })
    let atCommit!: () => void
    const ready = new Promise<void>(resolve => { atCommit = resolve })
    const appPool = poolManager.get()
    const transaction = appPool.transaction.bind(appPool)
    const paused = decision === 'activation-first' ? vi.spyOn(appPool, 'transaction').mockImplementation(work => transaction(async client => {
      const result = await work(client)
      if (result && typeof result === 'object' && 'sid' in result) {
        atCommit()
        await commitGate
      }
      return result
    })) : undefined
    const stateOf = async () => (await query(`SELECT u.activation_status,u.is_active,u.access_generation,u.password_hash,u.updated_at,
      (SELECT count(*)::int FROM user_login_aliases WHERE user_id=u.id) AS aliases,
      (SELECT count(*)::int FROM user_orgs WHERE user_id=u.id AND is_active) AS memberships,
      (SELECT count(*)::int FROM user_external_identities WHERE local_user_id=u.id) AS identities,
      (SELECT count(*)::int FROM user_external_auth_grants WHERE local_user_id=u.id AND enabled) AS grants,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=u.id) AS sessions
      FROM users u WHERE id=$1`, [target.userId])).rows[0]
    const before = await stateOf()
    try {
      const { authRouter, createLocalStrictDingTalkAuthRouter } = await import('../../src/routes/auth')
      const { generateState } = await import('../../src/auth/dingtalk-oauth')
      const router = decision === 'app-mismatch'
        ? await createLocalStrictDingTalkAuthRouter({ fetchFn: (...args) => fetch(...args), env: { DINGTALK_CLIENT_ID: `other-${loginApp}`, DINGTALK_CORP_ID: corp } }) : authRouter
      const app = express().use(express.json()).use('/api/auth', router)
      let providerCalls = 0
      vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
        providerCalls++
        if (decision === 'app-mismatch') throw new Error('Unmatched application reached the provider')
        const endpoint = new URL(url).pathname
        if (endpoint.endsWith('/userAccessToken')) {
          expect(JSON.parse(String(init?.body)).clientId).toBe(loginApp)
          // Only the already captured environment may be used after the code exchange starts.
          vi.stubEnv('DINGTALK_CORP_ID', 'changed-after-selection')
          return Response.json({ accessToken: 'synthetic' })
        }
        if (!endpoint.endsWith('/contact/users/me')) throw new Error('Unexpected provider operation')
        // Selection has finished. The first scope insert is deliberately uncommitted while the
        // genuine activation writes and its session registration reach the final table fence.
        if (decision !== 'activation-first') {
          await holder.query('BEGIN')
          await holder.query('INSERT INTO directory_connection_login_scope(connection_id,command_id) VALUES($1,$2)', [target.integrationId, randomUUID()])
        }
        return Response.json({ openId, unionId, nick: 'Synthetic' })
      })
      const state = await generateState({ intent: 'activate', activateUserId: target.userId, activateAdminUserId: admin })
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = request(app).post('/api/auth/dingtalk/callback').send({ code: 'fixture', state }).then(res => res)
      if (decision === 'app-mismatch') {
        const result = await pending
        expect(result.status).toBe(403)
        expect(result.body.code).toBe('strict_connection')
        expect(providerCalls).toBe(0)
        expect(await stateOf()).toEqual(before)
        return
      }
      let blocked: { pid: number; session_write: boolean } | undefined
      if (decision === 'activation-first') {
        await Promise.race([ready, pending.then(() => { throw new Error('Activation finished before the commit witness') })])
        await holder.query('BEGIN')
        const insertion = holder.query('INSERT INTO directory_connection_login_scope(connection_id,command_id) VALUES($1,$2)', [target.integrationId, randomUUID()])
        let waiting = false
        try {
          for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
            waiting = (await query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid])).rows[0].waiting === true
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 15))
          }
          expect(waiting).toBe(true)
          expect(await stateOf()).toEqual(before)
        } finally { unlock(); await insertion }
      } else {
        for (let attempt = 0; attempt < 240 && !blocked; attempt++) {
          const locks = await query<{ pid: number; session_write: boolean }>(`SELECT a.pid, EXISTS(
              SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='user_sessions'::regclass AND l.mode='RowExclusiveLock' AND l.granted
            ) AS session_write FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))
               AND a.query LIKE 'LOCK TABLE %directory_connection_login_scope% IN SHARE MODE'`, [pid])
          blocked = locks.rows[0]
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 15))
        }
        expect(blocked, 'the final scope fence must conflict with the separate writer').toBeDefined()
        expect(blocked?.session_write, 'the same uncommitted activation must already own session registration').toBe(true)
        expect(await stateOf()).toEqual(before)
      }
      if (decision === 'cancel') {
        expect((await query('SELECT pg_cancel_backend($1) AS cancelled', [blocked!.pid])).rows[0].cancelled).toBe(true)
        const result = await pending
        expect(result.status).toBe(503)
        expect(result.body.data?.token).toBeUndefined()
        expect(await stateOf()).toEqual(before)
      } else {
        await holder.query('ROLLBACK')
        const result = await pending
        expect(result.status, result.body.code).toBe(200)
        const claims = jwt.verify(result.body.data.token, runtimeJwtSecret()) as jwt.JwtPayload
        expect(claims.userId).toBe(target.userId)
        expect(claims.tenantId).toBe(target.orgId)
        expect((await query('SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2', [claims.sid, target.userId])).rowCount).toBe(1)
        expect(await stateOf()).toMatchObject({ activation_status: 'activated', is_active: true, memberships: 1, aliases: 1, grants: 1, sessions: 1 })
      }
    } finally {
      unlock()
      await holder.query('ROLLBACK')
      try { await pending } finally { paused?.mockRestore(); await holder.end(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
    }
  }, 15000)

  // Both branches of the source read must serialise. The IMPLICIT branch (no directoryAccountId,
  // links-by-user) and the EXPLICIT branch (directoryAccountId, the path the production DingTalk
  // OAuth SSO activation at routes/auth.ts takes — resolveDingTalkActivationSource passes an
  // explicit account id) compile to different SQL, so a fix to one is not a fix to the other.
  async function proveRaceRefuses(useExplicitAccount: boolean): Promise<void> {
    const seeded = await seed()

    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let activation: Promise<unknown> | null = null
    try {
      // Connection B: deactivate the integration but DO NOT commit — this holds an exclusive row
      // lock on the integration tuple and assigns B a transaction id.
      await holder.query('BEGIN')
      await holder.query(
        `UPDATE directory_integrations SET status = 'inactive' WHERE id = $1::uuid`,
        [seeded.integrationId],
      )
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const holderXid = String(
        (
          await holder.query(
            `SELECT transactionid::text AS xid
               FROM pg_locks
              WHERE pid = $1 AND locktype = 'transactionid' AND granted
              LIMIT 1`,
            [holderPid],
          )
        ).rows[0]?.xid,
      )
      expect(holderXid).not.toBe('undefined')

      // The real activation starts and MUST block: its FOR SHARE read of the integration row
      // cannot proceed while B's uncommitted UPDATE holds the row. (Its own users lock is taken
      // without contention, so any wait it has is on B's deactivation, not the user lock.)
      activation = activatePendingUser({
        userId: seeded.userId,
        mode: 'admin_no_password',
        adminUserId: 'admin-test',
        ...(useExplicitAccount ? { directoryAccountId: seeded.accountId } : {}),
      })
      const settledEarly = { done: false }
      activation.then(
        () => { settledEarly.done = true },
        () => { settledEarly.done = true },
      )

      // Deterministic barrier (no sleep-and-hope): wait until a DIFFERENT backend is provably
      // blocked WAITING ON B's transaction — i.e. on the integration deactivation specifically.
      let blockedPid = 0
      for (let attempt = 0; attempt < 100 && blockedPid === 0; attempt += 1) {
        const waiting = await holder.query(
          `SELECT blocked.pid AS pid
             FROM pg_locks blocked
            WHERE NOT blocked.granted
              AND blocked.locktype = 'transactionid'
              AND blocked.transactionid::text = $1
              AND blocked.pid <> $2
            LIMIT 1`,
          [holderXid, holderPid],
        )
        blockedPid = Number(waiting.rows[0]?.pid ?? 0)
        if (blockedPid === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(blockedPid).toBeGreaterThan(0) // the activation is blocked on the deactivation
      expect(settledEarly.done).toBe(false) // and therefore has NOT resolved

      // Additionally pin that B's lock is on the integration relation (context for the wait).
      const holderRel = await holder.query(
        `SELECT 1
           FROM pg_locks
          WHERE pid = $1 AND relation = 'directory_integrations'::regclass AND granted
          LIMIT 1`,
        [holderPid],
      )
      expect(holderRel.rows.length).toBe(1)

      // The deactivation commits. The activation's FOR SHARE EPQ recheck now sees 'inactive'.
      await holder.query('COMMIT')

      await expect(activation).rejects.toMatchObject({ code: 'ACTIVATE_INTEGRATION_INACTIVE' })
      activation = null
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      await holder.end()
      if (activation) { await activation.catch(() => undefined) }
    }

    // Fail-closed: nothing was written — the user is still pending, with no membership.
    const user = await query<{ activation_status: string; is_active: boolean }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [seeded.userId],
    )
    expect(user.rows[0]).toEqual({ activation_status: 'pending_activation', is_active: false })
    const membership = await query(`SELECT 1 FROM user_orgs WHERE user_id = $1`, [seeded.userId])
    expect(membership.rows).toHaveLength(0)
  }

  it('IMPLICIT branch (no directoryAccountId): blocks on the deactivation and refuses once it commits', async () => {
    await proveRaceRefuses(false)
  }, 30_000)

  it('EXPLICIT branch (directoryAccountId — the OAuth SSO activation path): blocks and refuses too', async () => {
    await proveRaceRefuses(true)
  }, 30_000)

  // SAFE-path positive control (delta review P3-2): the fix locks ONLY the integration row,
  // relying on the pre-existing users lock to serialise ACCOUNT/LINK races. This pins that
  // premise: a writer holding this user's users lock while deactivating the account makes the
  // activation block ON THE USERS LOCK and then refuse — so account deactivation cannot slip
  // through unserialised despite the source read not locking `da`. If a future change dropped
  // the users lock, the activation would read the stale-active account and this test reds.
  it('an account deactivation under the users lock serialises the activation, which then refuses', async () => {
    const seeded = await seed()
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let activation: Promise<unknown> | null = null
    try {
      await holder.query('BEGIN')
      // Hold this user's access-graph lock, exactly as every real account/link writer does...
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [seeded.userId])
      // ...then deactivate the account within that same locked transaction.
      await holder.query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const holderXid = String(
        (
          await holder.query(
            `SELECT transactionid::text AS xid
               FROM pg_locks
              WHERE pid = $1 AND locktype = 'transactionid' AND granted
              LIMIT 1`,
            [holderPid],
          )
        ).rows[0]?.xid,
      )

      activation = activatePendingUser({
        userId: seeded.userId,
        mode: 'admin_no_password',
        adminUserId: 'admin-test',
      })
      const settledEarly = { done: false }
      activation.then(() => { settledEarly.done = true }, () => { settledEarly.done = true })

      // The activation blocks on the USERS lock (its very first statement), waiting on the
      // holder's transaction — proving the account race is serialised there, not at `da`.
      let blockedPid = 0
      for (let attempt = 0; attempt < 100 && blockedPid === 0; attempt += 1) {
        const waiting = await holder.query(
          `SELECT blocked.pid AS pid
             FROM pg_locks blocked
            WHERE NOT blocked.granted
              AND blocked.locktype = 'transactionid'
              AND blocked.transactionid::text = $1
              AND blocked.pid <> $2
            LIMIT 1`,
          [holderXid, holderPid],
        )
        blockedPid = Number(waiting.rows[0]?.pid ?? 0)
        if (blockedPid === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(blockedPid).toBeGreaterThan(0)
      expect(settledEarly.done).toBe(false)

      await holder.query('COMMIT') // account now inactive; users lock released
      // The activation proceeds, reads the committed-inactive account, and refuses.
      await expect(activation).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INACTIVE' })
      activation = null
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      await holder.end()
      if (activation) { await activation.catch(() => undefined) }
    }
    const user = await query<{ activation_status: string }>(
      `SELECT activation_status FROM users WHERE id = $1`, [seeded.userId])
    expect(user.rows[0]?.activation_status).toBe('pending_activation')
  }, 30_000)
})

describeIfDatabase('DingTalk activation admission', () => {
  let target: Seeded
  let admin: string, corp: string, appKey: string, openId: string, unionId: string
  let loginConnection: string | undefined
  let providerCalls: number
  let profileReady: () => Promise<void>

  async function snapshot() {
    const rows: Record<string, unknown> = {}
    for (const [table, column] of [
      ['users', 'id'], ['user_login_aliases', 'user_id'], ['user_orgs', 'user_id'],
      ['user_external_identities', 'local_user_id'], ['user_external_auth_grants', 'local_user_id'],
      ['user_sessions', 'user_id'], ['user_session_revocations', 'user_id'], ['subject_authorization_versions', 'subject_id'],
      ['directory_account_links', 'local_user_id'],
    ]) rows[table] = (await query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${column}=$1 ORDER BY to_jsonb(t)::text`, [target.userId])).rows
    rows.account = (await query('SELECT to_jsonb(t) AS row FROM directory_accounts t WHERE id=$1', [target.accountId])).rows
    return rows
  }

  async function addLoginConnection(status: string, org = target.orgId) {
    loginConnection = randomUUID()
    await query(`INSERT INTO directory_integrations(id,name,provider,org_id,corp_id,status,config)
      VALUES($1,$2,'dingtalk',$3,$4,$5,$6)`, [loginConnection, `Activation fixture ${loginConnection}`, org, corp, status, { appKey }])
  }

  async function activate(selector: Record<string, string> = {}) {
    const { authRouter } = await import('../../src/routes/auth')
    const { generateState } = await import('../../src/auth/dingtalk-oauth')
    const state = await generateState({ intent: 'activate', activateUserId: target.userId, activateAdminUserId: admin })
    const app = express().use(express.json()).use('/api/auth', authRouter)
    return request(app).post('/api/auth/dingtalk/callback').send({ code: 'synthetic', state, ...selector })
  }

  function denied(response: request.Response) {
    expect(response.status, JSON.stringify(response.body)).toBe(403)
    expect(response.body).toEqual({ success: false, code: 'strict_connection', error: 'DingTalk login is not eligible for this source' })
    expect(response.body.data?.token).toBeUndefined()
  }

  beforeEach(async () => {
    target = await seed()
    admin = `${PREFIX}-admin-${randomUUID()}`
    corp = `corp-${target.integrationId}`; appKey = `app-${randomUUID()}`
    openId = `open-${target.accountId}`; unionId = `union-${target.accountId}`
    loginConnection = undefined; providerCalls = 0; profileReady = async () => {}
    await query("INSERT INTO users(id,email,password_hash,role,is_active,activation_status) VALUES($1,$2,'x','admin',true,'activated')", [admin, `${admin}@example.invalid`])
    await query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [admin])
    await query('UPDATE directory_integrations SET corp_id=$1,config=$2 WHERE id=$3', [corp, { appKey: `directory-${randomUUID()}` }, target.integrationId])
    await query('UPDATE directory_accounts SET corp_id=$1,open_id=$2,union_id=$3 WHERE id=$4', [corp, openId, unionId, target.accountId])
    for (const [key, value] of Object.entries({
      DINGTALK_CLIENT_ID: appKey, DINGTALK_CLIENT_SECRET: 'synthetic', DINGTALK_CORP_ID: corp,
      DINGTALK_REDIRECT_URI: 'https://example.invalid/callback', DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE: 'false',
      DINGTALK_ALLOWED_CORP_IDS: corp, AUTH_LOGIN_MAX_ATTEMPTS: '10000',
    })) vi.stubEnv(key, value)
    vi.stubGlobal('fetch', async (url: string | URL) => {
      providerCalls++
      const endpoint = new URL(url).pathname
      if (endpoint.endsWith('/userAccessToken')) return Response.json({ accessToken: 'synthetic' })
      if (!endpoint.endsWith('/contact/' + 'users/me')) throw new Error('Unexpected provider operation')
      await profileReady()
      return Response.json({ openId, unionId, nick: 'Fixture' })
    })
  })

  afterEach(async () => {
    try {
      if (loginConnection) await query('DELETE FROM directory_integrations WHERE id=$1', [loginConnection])
      await cleanup()
      await query('DELETE FROM subject_authorization_versions WHERE subject_id LIKE $1', [`${PREFIX}%`])
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
  })

  it.each(['implicit', 'id', 'corp', 'both'] as const)('checks activation source eligibility (%s)', async selector => {
    await addLoginConnection('paused')
    const before = await snapshot()
    denied(await activate({ ...(['id', 'both'].includes(selector) ? { connectionId: loginConnection! } : {}),
      ...(['corp', 'both'].includes(selector) ? { corpId: corp } : {}) }))
    expect(providerCalls).toBe(0)
    expect(await snapshot()).toEqual(before)
  })

  it.each(['inactive', 'disabled', 'deactivated', 'Active', ''])('requires an active activation source (%s)', async status => {
    await addLoginConnection(status)
    const before = await snapshot()
    denied(await activate())
    expect(providerCalls).toBe(0)
    expect(await snapshot()).toEqual(before)
  })

  it('requires activation source organization fields', async () => {
    await addLoginConnection('active', '')
    const before = await snapshot()
    denied(await activate())
    expect(providerCalls).toBe(0)
    expect(await snapshot()).toEqual(before)
  })

  it.each(['active', 'unconfigured', 'separate-app'] as const)('activates eligible directory identities (%s)', async shape => {
    if (shape !== 'unconfigured') await query('UPDATE directory_integrations SET config=$1 WHERE id=$2', [{ appKey }, target.integrationId])
    if (shape === 'separate-app') {
      await addLoginConnection('paused')
      await query('UPDATE directory_integrations SET config=$1 WHERE id=$2', [{ appKey: `other-${appKey}` }, loginConnection])
    }
    const response = await activate()
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const claims = jwt.verify(response.body.data.token, runtimeJwtSecret()) as jwt.JwtPayload
    expect(claims.userId).toBe(target.userId)
    expect(claims.tenantId).toBe(target.orgId)
    expect((await query('SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2', [claims.sid, target.userId])).rowCount).toBe(1)
    expect(providerCalls).toBe(2)
  })

  it('requires current eligibility for the activation transaction', async () => {
    const before = await snapshot()
    profileReady = async () => {
      await addLoginConnection('paused')
      vi.stubEnv('DINGTALK_CLIENT_ID', `changed-${appKey}`)
      vi.stubEnv('DINGTALK_CORP_ID', `changed-${corp}`)
    }
    denied(await activate())
    expect(providerCalls).toBe(2)
    expect(await snapshot()).toEqual(before)
  })

  it('requires an active directory source before activation writes', async () => {
    await query('UPDATE directory_integrations SET config=$1 WHERE id=$2', [{ appKey }, target.integrationId])
    const before = await snapshot()
    profileReady = async () => { await query("UPDATE directory_integrations SET status='paused' WHERE id=$1", [target.integrationId]) }
    const response = await activate()
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('activate_source_ineligible')
    expect(providerCalls).toBe(2)
    expect(response.body.data?.token).toBeUndefined()
    expect(await snapshot()).toEqual(before)
  })
})
