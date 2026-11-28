/**
 * API token issuance fence on a real PostgreSQL (migrated schema). Writers that hold or change the
 * creator users row race a create or rotate; each cell proves the wait it relies on before it lets
 * the writer commit.
 *
 * Connects only when DATABASE_URL is set; with EXPECT_DB=1 a missing URL is red, not skipped.
 * Every user, session, watermark, token and audit row it writes is synthetic and removed in afterAll.
 *
 * Pools:
 * - RC: the server default (READ COMMITTED in CI).
 * - RR: session-level default_transaction_isolation = repeatable read, so a bare BEGIN starts a
 *   REPEATABLE READ transaction unless the issuance path pins READ COMMITTED itself.
 *
 * Writers in the F cells hold the users row without the user access advisory key. A cell whose
 * create ends busy (the shared lock waits at most one second) is void and re-run, up to three times.
 */
import { randomBytes } from 'node:crypto'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { revokeUserSession } from '../../src/auth/session-registry'
import { sealExactAndCredentialSessions } from '../../src/auth/strict-credential-chain'
import type { Database } from '../../src/db/types'
import {
  ApiTokenIssuanceError,
  type ApiTokenIssuanceCredential,
} from '../../src/multitable/api-token-issuance'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { apiTokensRouter } from '../../src/routes/api-tokens'

const expectDb = process.env.EXPECT_DB === '1'
const dbUrl = process.env.DATABASE_URL
const suite = dbUrl ? describe : describe.skip

if (expectDb) {
  it('api token issuance fence lane requires DATABASE_URL when EXPECT_DB is set', () => {
    expect(dbUrl).toBeTruthy()
  })
}

type Isolation = 'rc' | 'rr'
type Logged = { sql: string; rows: Record<string, unknown>[] }
type Gate = {
  match: (sql: string) => boolean
  hit: boolean
  reached: Promise<void>
  released: Promise<void>
  arrive: () => void
  open: () => void
}
type PoolLike = {
  connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<QueryResult>; release: () => void }>
  end: () => Promise<void>
}

const INSERT_TOKEN = (sql: string) => /^insert into "multitable_api_tokens"/i.test(sql.trim())
const SESSION_REREAD = (sql: string) => /FROM user_sessions\s+WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL/.test(sql)
const ISOLATION_PROBE = (sql: string) => sql.includes("current_setting('transaction_isolation')")

/**
 * One-connection pool for the issuing side. Records every statement with its rows, exposes the
 * backend pid, and can hold a statement until the test opens its gate.
 */
class IssuerPool {
  readonly log: Logged[] = []
  pid: number | null = null
  private readonly gates: Gate[] = []
  private readonly raw: Pool
  private readonly prepared = new WeakSet<PoolClient>()

  constructor(private readonly isolation: Isolation) {
    this.raw = new Pool({ connectionString: dbUrl, max: 1, application_name: `d14-1-issuer-${isolation}` })
  }

  gate(match: (sql: string) => boolean): Gate {
    let arrive = () => {}
    let open = () => {}
    const reached = new Promise<void>((resolve) => { arrive = resolve })
    const released = new Promise<void>((resolve) => { open = resolve })
    const gate: Gate = { match, hit: false, reached, released, arrive: () => arrive(), open: () => open() }
    this.gates.push(gate)
    return gate
  }

  /** Opens every gate, so a held statement can finish during cleanup. */
  openAll(): void {
    for (const gate of this.gates) gate.open()
  }

  pool(): PoolLike {
    return {
      connect: async () => {
        const client = await this.raw.connect()
        if (!this.prepared.has(client)) {
          if (this.isolation === 'rr') await client.query("SET SESSION default_transaction_isolation = 'repeatable read'")
          this.prepared.add(client)
        }
        const pid = await client.query('SELECT pg_catalog.pg_backend_pid()::int AS pid')
        this.pid = Number(pid.rows[0].pid)
        return {
          query: async (sql: string, params?: unknown[]) => {
            for (const gate of this.gates) {
              if (!gate.hit && gate.match(sql)) {
                gate.hit = true
                gate.arrive()
                await gate.released
              }
            }
            const result = await client.query(sql, params as unknown[])
            this.log.push({ sql, rows: result.rows })
            return result
          },
          release: () => client.release(),
        }
      },
      end: () => this.raw.end(),
    }
  }

  service(): ApiTokenService {
    return new ApiTokenService(new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool() as never }) }))
  }

  probeResults(): unknown[] {
    return this.log.filter((entry) => ISOLATION_PROBE(entry.sql)).map((entry) => entry.rows[0]?.isolation)
  }

  async end(): Promise<void> {
    await this.raw.end()
  }
}

let admin: Pool
let writerPool: Pool
const users: string[] = []
/** Session ids revoked through the administrator route; their audit rows are removed in afterAll. */
const adminAuditSessions: string[] = []

function hex(bytes = 6): string {
  return randomBytes(bytes).toString('hex')
}

async function dbNowSeconds(): Promise<number> {
  const now = await admin.query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now')
  return Number(now.rows[0].now)
}

type Fixture = { userId: string; sid: string; iat: number; oldTokenId: string }

type WatermarkSetup = 'none' | 'epoch' | 'before-iat' | 'at-iat' | 'one-second-before-iat'

/**
 * Active user with one live session issued two seconds ago and one unrevoked token. The watermark
 * row is absent, the epoch placeholder, one hour before iat, exactly at iat, or one second before iat.
 */
async function fixture(watermark: WatermarkSetup = 'none'): Promise<Fixture> {
  const userId = `d14f_${hex()}`
  const sid = `d14s_${hex()}`
  const oldTokenId = hex(16)
  users.push(userId)
  await admin.query(
    `INSERT INTO users (id, username, email, name, password_hash, role, is_active, is_admin,
                        activation_status, local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $2, 'Synthetic issuance user', 'synthetic-unusable', 'user', TRUE, FALSE,
             'activated', TRUE, FALSE, 0)`,
    [userId, `${userId}@example.test`],
  )
  const iat = (await dbNowSeconds()) - 2
  await admin.query(
    `INSERT INTO user_sessions (id, user_id, issued_at, expires_at)
     VALUES ($1, $2, to_timestamp($3::double precision), pg_catalog.clock_timestamp() + interval '2 hours')`,
    [sid, userId, iat],
  )
  if (watermark === 'epoch') {
    await admin.query(
      `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
       VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), NULL, NULL)`,
      [userId],
    )
  } else if (watermark !== 'none') {
    const offset = { 'before-iat': '1 hour', 'at-iat': '0 seconds', 'one-second-before-iat': '1 second' }[watermark]
    await admin.query(
      `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
       VALUES ($1, to_timestamp($2::double precision) - $3::interval, pg_catalog.clock_timestamp(), 'synthetic', 'synthetic-earlier')`,
      [userId, iat, offset],
    )
  }
  const plain = `mst_${hex(16)}`
  await admin.query(
    `INSERT INTO multitable_api_tokens (id, name, token_hash, token_prefix, scopes, created_by)
     VALUES ($1, 'synthetic old', $2, $3, '["records:read"]'::jsonb, $4)`,
    [oldTokenId, randomBytes(32).toString('hex'), plain.slice(0, 8), userId],
  )
  return { userId, sid, iat, oldTokenId }
}

/** Active platform administrator (users.role = admin) without a session row; its JWT carries no sid. */
async function adminUser(): Promise<string> {
  const adminId = `d14a_${hex()}`
  users.push(adminId)
  await admin.query(
    `INSERT INTO users (id, username, email, name, password_hash, role, is_active, is_admin,
                        activation_status, local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $2, 'Synthetic issuance admin', 'synthetic-unusable', 'admin', TRUE, TRUE,
             'activated', TRUE, FALSE, 0)`,
    [adminId, `${adminId}@example.test`],
  )
  return adminId
}

function credential(f: Fixture, withSid = true, dated = true): ApiTokenIssuanceCredential {
  return { expectedAccessGeneration: 0, sessionId: withSid ? f.sid : null, issuedAt: dated ? f.iat : null }
}

async function tokenRows(userId: string): Promise<Array<{ id: string; revoked: boolean }>> {
  const rows = await admin.query('SELECT id, revoked FROM multitable_api_tokens WHERE created_by = $1 ORDER BY created_at, id', [userId])
  return rows.rows as Array<{ id: string; revoked: boolean }>
}

async function watermarkRows(userId: string): Promise<unknown[]> {
  const rows = await admin.query('SELECT user_id, revoked_after, updated_at, reason FROM user_session_revocations WHERE user_id = $1', [userId])
  return rows.rows
}

/**
 * Waits until `waiterPid` waits on a row lock held by `holderPid`: wait_event_type Lock with
 * wait_event transactionid or tuple (never advisory), and the holder among its blocking pids.
 */
async function waitBlockedOnRow(waiterPid: () => number | null, holderPid: number, budgetMs = 900): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const pid = waiterPid()
    if (pid !== null) {
      const seen = await admin.query(
        `SELECT a.wait_event_type, a.wait_event, $2::int = ANY (pg_catalog.pg_blocking_pids(a.pid)) AS blocked_by_holder
           FROM pg_catalog.pg_stat_activity a WHERE a.pid = $1::int`,
        [pid, holderPid],
      )
      const row = seen.rows[0] as { wait_event_type?: string; wait_event?: string; blocked_by_holder?: boolean } | undefined
      if (row?.wait_event_type === 'Lock' && (row.wait_event === 'transactionid' || row.wait_event === 'tuple') && row.blocked_by_holder === true) {
        const waiting = await admin.query('SELECT locktype FROM pg_catalog.pg_locks WHERE pid = $1::int AND NOT granted', [pid])
        expect(waiting.rows.map((lock) => lock.locktype).every((type) => type === 'transactionid' || type === 'tuple')).toBe(true)
        return
      }
    }
    if (Date.now() >= deadline) throw new Error('D14_1_ROW_LOCK_WAIT_NOT_OBSERVED')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  const pid = await client.query('SELECT pg_catalog.pg_backend_pid()::int AS pid')
  return Number(pid.rows[0].pid)
}

async function expectNoAdvisoryHeld(pid: number): Promise<void> {
  const held = await admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE pid = $1::int AND locktype = 'advisory'`, [pid])
  expect(held.rows[0].n).toBe(0)
}

/** Writer that only locks the users row, then advances the watermark and revokes sessions through the published seal. */
async function sealHeldUser(client: PoolClient, userId: string, tokens: boolean): Promise<void> {
  await sealExactAndCredentialSessions(client, {
    userId,
    actorId: 'd14-1-synthetic-writer',
    reason: 'd14-1-synthetic',
    grantIds: [],
    legs: { sessions: true, tokens },
  })
}

/** Writer for the FOR NO KEY UPDATE cell: three statements and no seal, so the row lock is never upgraded. */
async function noKeyWriterWrites(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
     VALUES ($1, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), 'd14-1-synthetic-writer', 'd14-1-synthetic')
     ON CONFLICT (user_id) DO UPDATE SET revoked_after = GREATEST(user_session_revocations.revoked_after, EXCLUDED.revoked_after),
       updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason`,
    [userId],
  )
  await client.query('UPDATE user_sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
}

/** Waits for a held statement; fails at once if the issuing call finished without reaching it. */
async function reach(gate: Gate, pending: Promise<unknown>): Promise<void> {
  await Promise.race([
    gate.reached,
    pending.then(() => { throw new Error('D14_1_HOLD_NOT_REACHED: the issuing call finished before the held statement') }),
  ])
}

/** Cleanup order for a cell: open holds, roll the writer back, let the issuing call finish, then close. */
async function closeCell(issuer: IssuerPool, writer: PoolClient | null, pending: Promise<unknown> | null): Promise<void> {
  issuer.openAll()
  if (writer) await writer.query('ROLLBACK').catch(() => undefined)
  if (pending) await pending
  if (writer) writer.release()
  await issuer.end()
}

function isBusy(error: unknown): boolean {
  return error instanceof ApiTokenIssuanceError && error.code === 'API_TOKEN_ISSUANCE_BUSY'
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Runs a cell; a busy outcome voids the run and re-runs it, three times at most. */
async function withBusyRetry(cell: () => Promise<'done' | 'busy'>): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await cell() === 'done') return
  }
  throw new Error('D14_1_FIXTURE_GAP: three consecutive runs ended busy')
}

function expectAuthenticationChanged(outcome: { ok: boolean; error?: unknown }): void {
  expect(outcome.ok).toBe(false)
  const error = (outcome as { error: unknown }).error
  expect(error).toBeInstanceOf(ApiTokenIssuanceError)
  expect((error as ApiTokenIssuanceError).code).toBe('AUTHENTICATION_CHANGED')
  expect((error as ApiTokenIssuanceError).statusCode).toBe(409)
}

suite('API token issuance fence (real PostgreSQL)', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: dbUrl, max: 2, application_name: 'd14-1-admin' })
    writerPool = new Pool({ connectionString: dbUrl, max: 2, application_name: 'd14-1-writer' })
  })

  afterAll(async () => {
    if (!admin) return
    for (const sid of adminAuditSessions) {
      await admin.query(`DELETE FROM audit_logs WHERE resource_type = 'user-session' AND resource_id = $1`, [sid]).catch(() => undefined)
    }
    for (const userId of users) {
      await admin.query('DELETE FROM multitable_api_tokens WHERE created_by = $1', [userId]).catch(() => undefined)
      await admin.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]).catch(() => undefined)
      await admin.query('DELETE FROM user_session_revocations WHERE user_id = $1', [userId]).catch(() => undefined)
      await admin.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    await writerPool.end().catch(() => undefined)
    await admin.end().catch(() => undefined)
  })

  it('RR sentinel: a bare BEGIN on the RR pool runs REPEATABLE READ', async () => {
    const issuer = new IssuerPool('rr')
    try {
      const client = await issuer.pool().connect()
      try {
        await client.query('BEGIN')
        const seen = await client.query("SELECT current_setting('transaction_isolation') AS isolation")
        expect(seen.rows[0].isolation).toBe('repeatable read')
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    } finally {
      await issuer.end()
    }
  })

  /**
   * F1b / F1b-nosid / F1b-NK: the writer holds the users row first; the create is shown waiting on
   * that row lock; the writer advances the watermark, revokes the sessions and commits; the create
   * answers exactly 409 AUTHENTICATION_CHANGED and writes no row.
   */
  async function writerFirstCell(input: { isolation: Isolation; withSid: boolean; mode: 'seal' | 'no-key' }): Promise<void> {
    await withBusyRetry(async () => {
      const f = await fixture()
      const issuer = new IssuerPool(input.isolation)
      const writer = await writerPool.connect()
      let pending: Promise<Settled<unknown>> | null = null
      try {
        await writer.query('BEGIN')
        const writerPid = await backendPid(writer)
        await writer.query(`SELECT id FROM users WHERE id = $1 ${input.mode === 'no-key' ? 'FOR NO KEY UPDATE' : 'FOR UPDATE'}`, [f.userId])
        pending = settle(issuer.service().createToken(f.userId, { name: 'raced', scopes: ['records:read'] }, credential(f, input.withSid)))
        await waitBlockedOnRow(() => issuer.pid, writerPid)
        if (input.mode === 'seal') await sealHeldUser(writer, f.userId, false)
        else await noKeyWriterWrites(writer, f.userId)
        await expectNoAdvisoryHeld(writerPid)
        await writer.query('COMMIT')
        const outcome = await pending
        if (!outcome.ok && isBusy((outcome as { error: unknown }).error)) return 'busy'
        expectAuthenticationChanged(outcome)
        expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
        if (input.isolation === 'rr') expect(issuer.probeResults()).toEqual(['read committed'])
        return 'done'
      } finally {
        await closeCell(issuer, writer, pending)
      }
    })
  }

  it.each(['rc', 'rr'] as const)('F1b (%s): a create waiting on the held users row is refused after the writer commits', async (isolation) => {
    await writerFirstCell({ isolation, withSid: true, mode: 'seal' })
  })

  it.each(['rc', 'rr'] as const)('F1b-nosid (%s): without a sid the watermark re-read alone refuses', async (isolation) => {
    await writerFirstCell({ isolation, withSid: false, mode: 'seal' })
  })

  // This fixture checks the users row lock independently of the user access key.
  // FOR NO KEY UPDATE must block issuance until the writer transaction completes.
  it.each(['rc', 'rr'] as const)('F1b-NK (%s): a writer holding FOR NO KEY UPDATE still blocks and refuses the create', async (isolation) => {
    await writerFirstCell({ isolation, withSid: true, mode: 'no-key' })
  })

  /**
   * Issuer first: the create or rotate holds the users row FOR SHARE and is held before its insert;
   * the writer is shown waiting on the issuer; the issuer commits; the writer then takes the row.
   */
  async function issuerFirstCell(input: { action: 'create' | 'rotate'; tokens: boolean; checkRereads: boolean }): Promise<Fixture> {
    const f = await fixture()
    const issuer = new IssuerPool('rc')
    const writer = await writerPool.connect()
    let pending: Promise<Settled<unknown>> | null = null
    let locking: Promise<unknown> | null = null
    try {
      const hold = issuer.gate(INSERT_TOKEN)
      const svc = issuer.service()
      pending = settle(input.action === 'create'
        ? svc.createToken(f.userId, { name: 'first', scopes: ['records:read'] }, credential(f))
        : svc.rotateToken(f.oldTokenId, f.userId, credential(f)))
      await reach(hold, pending)
      if (input.checkRereads) {
        expect(issuer.log.some((entry) => SESSION_REREAD(entry.sql))).toBe(true)
        expect(issuer.log.some((entry) => entry.sql.includes('user_session_revocations'))).toBe(true)
      }
      await writer.query('BEGIN')
      const writerPid = await backendPid(writer)
      locking = writer.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.userId]).catch((error: unknown) => error)
      await waitBlockedOnRow(() => writerPid, issuer.pid!, 2000)
      hold.open()
      const outcome = await pending
      expect(outcome.ok).toBe(true)
      expect(await locking).not.toBeInstanceOf(Error)
      await sealHeldUser(writer, f.userId, input.tokens)
      await writer.query('COMMIT')
      return f
    } finally {
      await closeCell(issuer, writer, pending)
      if (locking) await locking
    }
  }

  it('F1a: the create that takes the user lock first commits; the writer waits for it', async () => {
    const f = await issuerFirstCell({ action: 'create', tokens: false, checkRereads: false })
    const rows = await tokenRows(f.userId)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.revoked === false)).toBe(true)
  })

  it('F1c: a writer with the token leg waits for the create, then revokes the new token', async () => {
    const f = await issuerFirstCell({ action: 'create', tokens: true, checkRereads: true })
    const rows = await tokenRows(f.userId)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.revoked === false)).toEqual([])
  })

  /**
   * Creation with a revoked authenticating session returns AUTHENTICATION_CHANGED
   * without writing a token.
   */
  it.each(['none', 'epoch', 'before-iat'] as const)('F1d (watermark %s): a session revoked before the re-read refuses the create', async (watermark) => {
    const f = await fixture(watermark)
    const issuer = new IssuerPool('rc')
    let pending: Promise<Settled<unknown>> | null = null
    try {
      const hold = issuer.gate(SESSION_REREAD)
      pending = settle(issuer.service().createToken(f.userId, { name: 'after-logout', scopes: ['records:read'] }, credential(f)))
      await reach(hold, pending)
      const before = await watermarkRows(f.userId)
      const revoked = await revokeUserSession(f.sid, { revokedBy: 'd14-1-synthetic-admin', reason: 'd14-1-synthetic' })
      expect(revoked?.id).toBe(f.sid)
      expect(await watermarkRows(f.userId)).toEqual(before)
      hold.open()
      expectAuthenticationChanged(await pending)
      expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
    } finally {
      await closeCell(issuer, null, pending)
    }
  })

  /**
   * Administrator revocation of the authenticating session makes token creation
   * return AUTHENTICATION_CHANGED without writing a token.
   */
  it.each(['none', 'epoch', 'before-iat'] as const)('F1d admin route (watermark %s): an administrator single-session revoke refuses the create', async (watermark) => {
    const trust = process.env.RBAC_TOKEN_TRUST
    process.env.RBAC_TOKEN_TRUST = 'false'
    const f = await fixture(watermark)
    const adminId = await adminUser()
    const issuer = new IssuerPool('rc')
    let pending: Promise<Settled<unknown>> | null = null
    try {
      const app = express()
      app.use(express.json())
      app.use(adminUsersRouter())
      const adminJwt = authService.createToken({
        id: adminId,
        email: `${adminId}@example.test`,
        name: 'Synthetic issuance admin',
        role: 'admin',
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      const hold = issuer.gate(SESSION_REREAD)
      pending = settle(issuer.service().createToken(f.userId, { name: 'after-admin-logout', scopes: ['records:read'] }, credential(f)))
      await reach(hold, pending)
      const before = await watermarkRows(f.userId)
      adminAuditSessions.push(f.sid)
      const revoked = await request(app)
        .post(`/api/admin/users/${encodeURIComponent(f.userId)}/sessions/${encodeURIComponent(f.sid)}/revoke`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ reason: 'd14-1-synthetic' })
      expect(revoked.status).toBe(200)
      expect(revoked.body.data.sessionId).toBe(f.sid)
      expect(revoked.body.data.userId).toBe(f.userId)
      const sessionRow = await admin.query('SELECT revoked_at IS NOT NULL AS revoked FROM user_sessions WHERE id = $1', [f.sid])
      expect(sessionRow.rows).toEqual([{ revoked: true }])
      expect(await watermarkRows(f.userId)).toEqual(before)
      hold.open()
      expectAuthenticationChanged(await pending)
      expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
    } finally {
      await closeCell(issuer, null, pending)
      if (trust === undefined) delete process.env.RBAC_TOKEN_TRUST
      else process.env.RBAC_TOKEN_TRUST = trust
    }
  })

  it('F2 (writer first): a rotate waiting on the held users row is refused and changes nothing', async () => {
    await withBusyRetry(async () => {
      const f = await fixture()
      const issuer = new IssuerPool('rc')
      const writer = await writerPool.connect()
      let pending: Promise<Settled<unknown>> | null = null
      try {
        await writer.query('BEGIN')
        const writerPid = await backendPid(writer)
        await writer.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.userId])
        pending = settle(issuer.service().rotateToken(f.oldTokenId, f.userId, credential(f)))
        await waitBlockedOnRow(() => issuer.pid, writerPid)
        await sealHeldUser(writer, f.userId, false)
        await writer.query('COMMIT')
        const outcome = await pending
        if (!outcome.ok && isBusy((outcome as { error: unknown }).error)) return 'busy'
        expectAuthenticationChanged(outcome)
        expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
        return 'done'
      } finally {
        await closeCell(issuer, writer, pending)
      }
    })
  })

  it('F2 (rotate first): rotation commits the replacement token atomically', async () => {
    const f = await issuerFirstCell({ action: 'rotate', tokens: false, checkRereads: false })
    const rows = await tokenRows(f.userId)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === f.oldTokenId)?.revoked).toBe(true)
    expect(rows.filter((row) => row.id !== f.oldTokenId && row.revoked === false)).toHaveLength(1)
  })

  it.each(['rc', 'rr'] as const)('F3 (%s): a live session with an older non-epoch watermark creates and rotates', async (isolation) => {
    const f = await fixture('before-iat')
    const issuer = new IssuerPool(isolation)
    try {
      const svc = issuer.service()
      const created = await svc.createToken(f.userId, { name: 'positive', scopes: ['records:read'] }, credential(f))
      expect(created.plainTextToken).toMatch(/^mst_/)
      const rotated = await svc.rotateToken(created.token.id, f.userId, credential(f))
      expect(rotated.token.id).not.toBe(created.token.id)
      const noSid = await svc.createToken(f.userId, { name: 'positive-nosid', scopes: ['records:read'] }, credential(f, false))
      expect(noSid.plainTextToken).toMatch(/^mst_/)
      expect(issuer.probeResults()).toEqual(['read committed', 'read committed', 'read committed'])
    } finally {
      await issuer.end()
    }
  })

  /**
   * Watermark boundary of a dated credential: a watermark exactly at iat revokes the session (the
   * same rule as iat*1000 <= revoked_after in session verification); one second before iat does not.
   * Direct service calls, because authenticate itself refuses a token whose iat is at the watermark.
   */
  it.each([true, false])('watermark at iat (sid %s): the create is refused and writes no row', async (withSid) => {
    const f = await fixture('at-iat')
    const issuer = new IssuerPool('rc')
    try {
      expectAuthenticationChanged(await settle(issuer.service().createToken(f.userId, { name: 'at-iat', scopes: ['records:read'] }, credential(f, withSid))))
      expect(issuer.log.some((entry) => entry.sql.includes('revoked_after >= to_timestamp($2::double precision)'))).toBe(true)
      expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
    } finally {
      await issuer.end()
    }
  })

  it('watermark one second before iat: the create succeeds', async () => {
    const f = await fixture('one-second-before-iat')
    const issuer = new IssuerPool('rc')
    try {
      const created = await issuer.service().createToken(f.userId, { name: 'before-iat', scopes: ['records:read'] }, credential(f))
      expect(created.plainTextToken).toMatch(/^mst_/)
      expect(await tokenRows(f.userId)).toHaveLength(2)
    } finally {
      await issuer.end()
    }
  })

  it('session row predicate: a revoked session row refuses the create when no watermark exists', async () => {
    const f = await fixture('none')
    await admin.query('UPDATE user_sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1', [f.sid])
    const issuer = new IssuerPool('rc')
    try {
      expectAuthenticationChanged(await settle(issuer.service().createToken(f.userId, { name: 'revoked-row', scopes: ['records:read'] }, credential(f))))
      expect(issuer.log.some((entry) => SESSION_REREAD(entry.sql))).toBe(true)
      expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
    } finally {
      await issuer.end()
    }
  })

  /**
   * Undated credential (the token carries no usable iat): any watermark other than the epoch
   * placeholder revokes it, even one in the past; the placeholder alone or no row lets it through.
   */
  it.each([
    { watermark: 'before-iat', refused: true },
    { watermark: 'epoch', refused: false },
    { watermark: 'none', refused: false },
  ] as const)('undated credential with watermark $watermark: refused = $refused', async ({ watermark, refused }) => {
    const f = await fixture(watermark)
    const issuer = new IssuerPool('rc')
    try {
      const outcome = await settle(issuer.service().createToken(f.userId, { name: 'undated', scopes: ['records:read'] }, credential(f, true, false)))
      expect(issuer.log.some((entry) => entry.sql.includes("revoked_after <> TIMESTAMPTZ '1970-01-01 00:00:00+00'"))).toBe(true)
      if (refused) {
        expectAuthenticationChanged(outcome)
        expect(await tokenRows(f.userId)).toEqual([{ id: f.oldTokenId, revoked: false }])
      } else {
        expect(outcome.ok).toBe(true)
        expect(await tokenRows(f.userId)).toHaveLength(2)
      }
    } finally {
      await issuer.end()
    }
  })

  it('F3 (route): the real authenticate and routes take sid and iat from the bearer token', async () => {
    const trust = process.env.RBAC_TOKEN_TRUST
    process.env.RBAC_TOKEN_TRUST = 'false'
    try {
      const f = await fixture('before-iat')
      const jwt = authService.createToken({
        id: f.userId,
        email: `${f.userId}@example.test`,
        name: 'Synthetic issuance user',
        role: 'user',
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      }, { sid: f.sid, issuedAt: f.iat + 1, externalAuth: false })
      const app = express()
      app.use(express.json())
      app.use(apiTokensRouter())
      const created = await request(app)
        .post('/api/multitable/api-tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'route positive', scopes: ['records:read'] })
      expect(created.status).toBe(201)
      const rotated = await request(app)
        .post(`/api/multitable/api-tokens/${created.body.data.token.id}/rotate`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({})
      expect(rotated.status).toBe(200)
      await admin.query('UPDATE user_sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1', [f.sid])
      const afterLogout = await request(app)
        .post('/api/multitable/api-tokens')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'route after logout', scopes: ['records:read'] })
      expect(afterLogout.status).toBe(401)
    } finally {
      if (trust === undefined) delete process.env.RBAC_TOKEN_TRUST
      else process.env.RBAC_TOKEN_TRUST = trust
    }
  })
})
