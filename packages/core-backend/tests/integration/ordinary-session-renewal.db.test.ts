import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { setTimeout as sleep } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthService, type User } from '../../src/auth/AuthService'
import { runtimeJwtSecret } from '../helpers/runtime-jwt-secret'

const EXPECT_DB = process.env.EXPECT_DB === '1'
const url = process.env.DATABASE_URL
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('has a configured database for ordinary session renewal', () => { expect(url).toBeTruthy() })

const dbSuite = url ? describe : describe.skip
dbSuite('ordinary session renewal against PostgreSQL', () => {
  let pool: Pool
  let auth: AuthService
  let user: User
  let orgId: string
  let sid: string

  beforeAll(() => {
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    pool = new Pool({ connectionString: url })
    auth = new AuthService()
  })

  beforeEach(async () => {
    const id = `renew-${randomUUID()}`
    orgId = `org-${randomUUID()}`
    sid = randomUUID()
    user = { id, email: `${id}@example.invalid`, name: 'Renewal fixture', role: 'admin', permissions: [],
      tenantId: orgId, created_at: new Date(), updated_at: new Date(), access_generation: 0 }
    await pool.query(`INSERT INTO users (id,email,name,password_hash,role,is_active,activation_status,access_generation)
      VALUES ($1,$2,$3,'fixture-only','admin',true,'activated',0)`, [id, user.email, user.name])
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true)', [id, orgId])
    await pool.query(`INSERT INTO user_sessions (id,user_id,expires_at) VALUES ($1,$2,clock_timestamp()-interval '1 day')`, [sid, id])
  })

  afterEach(async () => {
    await pool.query('DELETE FROM user_sessions WHERE user_id=$1', [user.id])
    await pool.query('DELETE FROM user_session_revocations WHERE user_id=$1', [user.id])
    await pool.query('DELETE FROM user_orgs WHERE user_id=$1', [user.id])
    await pool.query('DELETE FROM users WHERE id=$1', [user.id])
  })

  afterAll(async () => { await pool.end(); vi.unstubAllEnvs() })

  it('verifies legacy ordinary sessions without an issue time only until a real revocation watermark exists', async () => {
    const { authRouter } = await import('../../src/routes/auth')
    const app = express().use('/api/auth', authRouter)
    const legacy = jwt.sign({ userId: user.id }, runtimeJwtSecret(), { noTimestamp: true, expiresIn: '1h' })
    const older = auth.createToken(user, { issuedAt: Math.floor(Date.now() / 1000) - 60 })
    const verify = (token: string) => request(app).get('/api/auth/verify').set('Authorization', `Bearer ${token}`)
    expect((await verify(legacy)).status).toBe(200)
    await pool.query(`INSERT INTO user_session_revocations (user_id, revoked_after)
      VALUES ($1, timestamptz '1970-01-01 00:00:00+00')`, [user.id])
    expect((await verify(legacy)).status).toBe(200)
    await pool.query("UPDATE user_session_revocations SET revoked_after=clock_timestamp()-interval '2 seconds' WHERE user_id=$1", [user.id])
    for (const token of [legacy, older]) {
      const rejected = await verify(token)
      expect(rejected.status).toBe(401)
      expect(rejected.body).toEqual({ success: false, error: 'Invalid token' })
    }
    expect((await verify(auth.createToken(user))).status).toBe(200)
  })

  function original(kind: 'refresh' | 'switch', withSid: boolean) {
    const issuedAt = Math.floor(Date.now() / 1000) - (kind === 'refresh' ? 3 * 86400 : 10)
    return auth.createToken(user, { issuedAt, ...(withSid && { sid }) })
  }

  async function renew(kind: 'refresh' | 'switch', token: string) {
    if (kind === 'refresh') return auth.refreshToken(token)
    const outcome = await auth.switchOrdinarySessionOrg(token, user, orgId, {})
    return outcome.kind === 'ok' ? outcome.token : null
  }

  async function writeCutoff(client: PoolClient) {
    await client.query(`INSERT INTO user_session_revocations (user_id,revoked_after) VALUES ($1,clock_timestamp())`, [user.id])
    await client.query(`UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL
      AND expires_at > (SELECT revoked_after FROM user_session_revocations WHERE user_id=$1)`, [user.id])
  }

  async function waitForSharedUserLock(holder: number) {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const result = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
        AND query ILIKE '%FROM users WHERE id = $1 FOR SHARE%') AS waiting`, [holder])
      if (result.rows[0]?.waiting) return
      await sleep(15)
    }
    throw new Error('Expected a pending user row lock')
  }

  for (const kind of ['refresh', 'switch'] as const) {
    it.each([true, false])(`${kind} registered before a cutoff is invalid afterwards, original sid present %s`, async withSid => {
      const derived = await renew(kind, original(kind, withSid))
      expect(derived).toEqual(expect.any(String))
      const issued = auth.readTokenPayload(derived!)!
      expect(issued.sid).toEqual(withSid ? sid : expect.any(String))
      expect(issued.tenantId).toBe(orgId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id])
        await writeCutoff(client)
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }
      expect(await auth.verifyToken(derived!)).toBeNull()
      const row = await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM user_sessions WHERE id=$1', [issued.sid])
      expect(row.rows).toEqual([{ revoked: true }])
    })

    it.each([true, false])(`${kind} waits for the account cutoff and leaves existing rows alone, original sid present %s`, async withSid => {
      const token = original(kind, withSid)
      const client = await pool.connect()
      let waiting: Promise<string | null> | undefined
      try {
        await client.query('BEGIN')
        const holder = await client.query('SELECT pg_backend_pid() AS pid FROM users WHERE id=$1 FOR UPDATE', [user.id])
        waiting = renew(kind, token)
        await waitForSharedUserLock(holder.rows[0].pid)
        await writeCutoff(client)
        await client.query('COMMIT')
        expect(await waiting).toBeNull()
        const rows = await pool.query(`SELECT id, revoked_at IS NULL AS untouched, expires_at < now() AS expired
          FROM user_sessions WHERE user_id=$1`, [user.id])
        expect(rows.rows).toEqual([{ id: sid, untouched: true, expired: true }])
      } finally { await client.query('ROLLBACK'); client.release(); await waiting }
    })
  }

  it('rechecks the target membership and account generation before registering', async () => {
    const token = original('switch', true)
    await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [user.id, orgId])
    expect(await auth.switchOrdinarySessionOrg(token, user, orgId, {})).toEqual({ kind: 'not_member' })
    await pool.query('UPDATE users SET access_generation=access_generation+1 WHERE id=$1', [user.id])
    expect(await auth.switchOrdinarySessionOrg(token, user, orgId, {})).toEqual({ kind: 'changed' })
    const result = await pool.query('SELECT expires_at < now() AS expired FROM user_sessions WHERE id=$1', [sid])
    expect(result.rows).toEqual([{ expired: true }])
  })

  it('uses an inclusive cutoff and accepts a subsequently issued live credential', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 5
    await pool.query('INSERT INTO user_session_revocations (user_id,revoked_after) VALUES ($1,to_timestamp($2))', [user.id, issuedAt])
    expect(await auth.refreshToken(auth.createToken(user, { sid, issuedAt }))).toBeNull()
    expect(await auth.refreshToken(auth.createToken(user, { sid, issuedAt: issuedAt + 1 }))).toEqual(expect.any(String))
  })
})
