/**
 * Session tokens and the invite lifecycle against real PostgreSQL, through the real routes.
 *
 * Invariants:
 *  - session verification accepts only session tokens: a correctly signed token that carries a payload
 *    `type` claim is answered exactly like any invalid token, on a gated route and on refresh, and
 *    changes nothing;
 *  - an account that has completed its first sign-in is not sent another invite, and an account that
 *    has never signed in still is;
 *  - a revoked invite token and a token replaced by a later one cannot be used for anything;
 *  - every issued invite token is distinct, so replacing a token always retires the one before it.
 *
 * DATABASE_URL-gated. Every row this file reads or writes belongs to an account it created.
 */
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import express from 'express'
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ActualQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

// One statement can be preceded by a step of the test's choosing: the way to place a change between
// the read and the write of a single request.
const queryHooks = vi.hoisted(() => ({
  before: null as null | ((sql: string, run: ActualQuery) => Promise<void>),
}))

vi.mock('../../src/db/pg', async (original) => {
  const actual = await original<typeof import('../../src/db/pg')>()
  return {
    ...actual,
    query: async (sql: string, params?: unknown[]) => {
      const hook = queryHooks.before
      if (hook) await hook(String(sql), actual.query as unknown as ActualQuery)
      return actual.query(sql, params)
    },
  }
})

import { authService } from '../../src/auth/AuthService'
import { recordInvite } from '../../src/auth/invite-ledger'
import { issueInviteToken } from '../../src/auth/invite-tokens'
import { query } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { authRouter } from '../../src/routes/auth'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const PASSWORD = 'SyntheticPass9A'
const NEW_PASSWORD = 'WelcomePass9A'
const createdUserIds: string[] = []

const pinned = usePinnedServer()

function buildApp() {
  const app = express()
  app.use(express.json())
  app.get('/gated', authenticate, (req: Request, res: Response) => {
    res.json({ ok: true, userId: (req.user as { id?: string } | undefined)?.id ?? null })
  })
  app.use('/api/auth', authRouter)
  app.use(adminUsersRouter())
  return app
}

function sessionSecret(): string {
  return resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
}

function signWithSessionSecret(payload: Record<string, unknown>): string {
  return jwt.sign(payload, sessionSecret(), { algorithm: 'HS256' })
}

function claimsUnderSessionSecret(token: string): Record<string, unknown> {
  return jwt.verify(token, sessionSecret(), { ignoreExpiration: true }) as Record<string, unknown>
}

interface SeededUser {
  id: string
  email: string
}

async function seedUser(options: { admin?: boolean } = {}): Promise<SeededUser> {
  const id = `stk_${randomUUID()}`
  const email = `${id}@example.test`
  const admin = options.admin === true
  // Created an hour ago, so nothing below depends on how close the account and a token were made.
  await query(
    `INSERT INTO users(
       id, username, email, name, password_hash, role, is_admin, is_active,
       activation_status, must_change_password, local_password_set, created_at, updated_at
     ) VALUES (
       $1, $1, $2, 'Synthetic user', $3, $4, $5, TRUE,
       'activated', FALSE, TRUE, NOW() - interval '1 hour', NOW() - interval '1 hour'
     )`,
    [id, email, await bcrypt.hash(PASSWORD, 4), admin ? 'admin' : 'user', admin],
  )
  await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)', [id, admin ? 'admin' : 'user'])
  createdUserIds.push(id)
  return { id, email }
}

function sessionTokenWithoutSessionId(user: SeededUser, role = 'user'): string {
  return authService.createToken({
    id: user.id,
    email: user.email,
    name: 'Synthetic user',
    role,
    permissions: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
}

/** Everything a request about this account could have written. */
async function snapshot(userId: string) {
  const [user, invites, sessions, revocations] = await Promise.all([
    query('SELECT to_jsonb(u) AS row FROM users u WHERE u.id = $1', [userId]),
    query('SELECT to_jsonb(i) AS row FROM user_invites i WHERE i.user_id = $1 ORDER BY i.created_at, i.id', [userId]),
    query('SELECT to_jsonb(s) AS row FROM user_sessions s WHERE s.user_id = $1 ORDER BY s.id', [userId]),
    query('SELECT to_jsonb(r) AS row FROM user_session_revocations r WHERE r.user_id = $1', [userId]),
  ])
  return {
    user: user.rows.map((entry) => entry.row),
    invites: invites.rows.map((entry) => entry.row),
    sessions: sessions.rows.map((entry) => entry.row),
    revocations: revocations.rows.map((entry) => entry.row),
  }
}

async function inviteRow(inviteId: string) {
  const result = await query<{ invite_token: string; status: string }>(
    'SELECT invite_token, status FROM user_invites WHERE id = $1',
    [inviteId],
  )
  return result.rows[0]
}

/** Records a pending invite, issued the way the service issues one: no preset, the default lifetime. */
async function recordInviteFor(user: SeededUser, admin: SeededUser) {
  const token = issueInviteToken({ userId: user.id, email: user.email })
  const entry = await recordInvite({
    userId: user.id,
    email: user.email,
    productMode: 'platform',
    invitedBy: admin.id,
    inviteToken: token,
  })
  if (!entry) throw new Error('invite ledger row was not recorded')
  return { token, inviteId: entry.id }
}

type Answer = { status: number; body: unknown }

async function answer(pending: PromiseLike<{ status: number; body: unknown }>): Promise<Answer> {
  const response = await pending
  return { status: response.status, body: response.body }
}

const http = {
  gated: (token: string) => answer(request(pinned.url()).get('/gated').auth(token, { type: 'bearer' })),
  me: (token: string) => answer(request(pinned.url()).get('/api/auth/me').auth(token, { type: 'bearer' })),
  adminInvites: (token: string) => answer(request(pinned.url()).get('/api/admin/invites').auth(token, { type: 'bearer' })),
  refresh: (token: string) => answer(request(pinned.url()).post('/api/auth/refresh-token').send({ token })),
  preview: (token: string) => answer(request(pinned.url()).get('/api/auth/invite/preview').query({ token })),
  accept: (token: string) => answer(request(pinned.url()).post('/api/auth/invite/accept').send({ token, password: NEW_PASSWORD })),
  resend: (adminToken: string, inviteId: string) =>
    answer(request(pinned.url()).post(`/api/admin/invites/${inviteId}/resend`).auth(adminToken, { type: 'bearer' })),
  revoke: (adminToken: string, inviteId: string) =>
    answer(request(pinned.url()).post(`/api/admin/invites/${inviteId}/revoke`).auth(adminToken, { type: 'bearer' })),
}

/** The write statement of a resend. */
const RESEND_WRITE = /UPDATE user_invites\s+SET invite_token = \$2/

/** The account read of an invite acceptance: it follows the ledger read and precedes the transaction. */
const ACCEPT_ACCOUNT_READ = /SELECT id, email, name, is_active, activation_status, updated_at\s+FROM users/

/** A token's claims without its identifier. */
function claimsWithoutIdentifier(token: string): Record<string, unknown> {
  const { jti: _jti, ...rest } = jwt.decode(token) as Record<string, unknown>
  return rest
}

function errorCode(response: Answer): unknown {
  const body = response.body as { code?: unknown; error?: { code?: unknown } | string } | null
  if (body && typeof body.error === 'object' && body.error !== null) return body.error.code
  return body?.code
}

describeIfDatabase('session tokens and the invite lifecycle (real PostgreSQL)', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeAll(async () => {
    for (const key of ['RBAC_BYPASS', 'RBAC_TOKEN_TRUST']) previousEnv[key] = process.env[key]
    process.env.RBAC_BYPASS = 'false'
    process.env.RBAC_TOKEN_TRUST = 'false'
    await query(
      "INSERT INTO roles(id, name) VALUES ('admin', 'Synthetic admin'), ('user', 'Synthetic user') ON CONFLICT DO NOTHING",
    )
  })

  beforeEach(() => {
    queryHooks.before = null
    pinned.setApp(buildApp())
  })

  afterAll(async () => {
    queryHooks.before = null
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    for (const table of ['user_invites', 'user_sessions', 'user_session_revocations', 'user_roles']) {
      await query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [createdUserIds]).catch(() => undefined)
    }
    await query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds]).catch(() => undefined)
  })

  describe('session verification accepts only session tokens', () => {
    it('every way a session token is issued still reaches a gated route', async () => {
      const admin = await seedUser({ admin: true })
      const signedIn = await authService.login(admin.email, PASSWORD)
      expect(signedIn).not.toBeNull()
      const tokens: Array<[string, string]> = [
        ['sign-in, with a session id', String(signedIn?.token)],
        ['without a session id', sessionTokenWithoutSessionId(admin, 'admin')],
        ['id, roles and perms', signWithSessionSecret({ id: admin.id, roles: ['admin'], perms: [], exp: Math.floor(Date.now() / 1000) + 3600 })],
        ['sub and roles', signWithSessionSecret({ sub: admin.id, roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 3600 })],
      ]

      for (const [label, token] of tokens) {
        expect(claimsUnderSessionSecret(token), label).not.toHaveProperty('type')
        expect((await http.gated(token)).status, label).toBe(200)
        expect(await http.gated(token), label).toEqual({ status: 200, body: { ok: true, userId: admin.id } })
        expect((await http.me(token)).status, label).toBe(200)
        expect((await http.adminInvites(token)).status, label).toBe(200)
      }
    })

    it('a correctly signed token that carries a payload type claim is answered like any invalid token and changes nothing', async () => {
      const admin = await seedUser({ admin: true })
      const future = Math.floor(Date.now() / 1000) + 3600
      const typed: Array<[string, string]> = [
        ['a purpose token issued by this service', issueInviteToken({ userId: admin.id, email: admin.email })],
        ['a string type with userId', signWithSessionSecret({ type: 'invite', userId: admin.id, email: admin.email, exp: future })],
        ['a string type with userId, past its expiry', signWithSessionSecret({ type: 'invite', userId: admin.id, email: admin.email, iat: future - 9000, exp: future - 7200 })],
        ['another string type with id, roles and perms', signWithSessionSecret({ type: 'restore-preview', id: admin.id, roles: ['admin'], perms: ['admin:all'], exp: future })],
        ['a non-string type with sub', signWithSessionSecret({ type: 7, sub: admin.id, exp: future })],
      ]
      // The account itself is in good standing: its session token is accepted everywhere below.
      const session = sessionTokenWithoutSessionId(admin, 'admin')
      expect((await http.gated(session)).status).toBe(200)
      expect((await http.adminInvites(session)).status).toBe(200)

      const invalid = {
        gated: await http.gated('not-a-token'),
        me: await http.me('not-a-token'),
        adminInvites: await http.adminInvites('not-a-token'),
        refresh: await http.refresh('not-a-token'),
      }
      expect([invalid.gated.status, invalid.me.status, invalid.adminInvites.status, invalid.refresh.status]).toEqual([401, 401, 401, 401])

      const before = await snapshot(admin.id)
      for (const [label, token] of typed) {
        expect(claimsUnderSessionSecret(token), label).toHaveProperty('type')
        expect(await http.gated(token), label).toEqual(invalid.gated)
        expect(await http.me(token), label).toEqual(invalid.me)
        expect(await http.adminInvites(token), label).toEqual(invalid.adminInvites)
        expect(await http.refresh(token), label).toEqual(invalid.refresh)
      }
      expect(await snapshot(admin.id)).toEqual(before)
    })

    it('refresh records a session for a session token and none for a token that carries a payload type claim', async () => {
      const user = await seedUser()
      const before = await snapshot(user.id)
      expect(before.sessions).toHaveLength(0)

      const typed = await http.refresh(issueInviteToken({ userId: user.id, email: user.email }))
      expect(typed.status).toBe(401)
      expect(await snapshot(user.id)).toEqual(before)

      const renewed = await http.refresh(sessionTokenWithoutSessionId(user))
      expect(renewed.status).toBe(200)
      const renewedToken = String((renewed.body as { data: { token: string } }).data.token)
      expect(claimsUnderSessionSecret(renewedToken)).not.toHaveProperty('type')
      const after = await snapshot(user.id)
      expect(after.sessions).toHaveLength(1)
      expect(after.revocations).toEqual(before.revocations)
      expect((await http.gated(renewedToken)).status).toBe(200)
    })
  })

  describe('an account that has completed its first sign-in is not sent another invite', () => {
    it('an invite for an account that has never signed in is resent, pending or revoked', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      for (const revokeFirst of [false, true]) {
        const invitee = await seedUser()
        const first = await recordInviteFor(invitee, admin)
        if (revokeFirst) expect((await http.revoke(adminToken, first.inviteId)).status).toBe(200)

        const resent = await http.resend(adminToken, first.inviteId)

        expect(resent.status).toBe(200)
        const next = String((resent.body as { data: { inviteToken: string } }).data.inviteToken)
        expect(next).not.toBe(first.token)
        expect(await inviteRow(first.inviteId)).toEqual({ invite_token: next, status: 'pending' })
      }
    })

    it.each([[false], [true]])('a resend is refused once the account has signed in, and writes nothing (invite revoked first: %s)', async (revokeFirst) => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const first = await recordInviteFor(invitee, admin)
      if (revokeFirst) expect((await http.revoke(adminToken, first.inviteId)).status).toBe(200)
      expect(await authService.login(invitee.email, PASSWORD)).not.toBeNull()
      const before = await snapshot(invitee.id)
      expect((before.user[0] as { last_login_at: unknown }).last_login_at).not.toBeNull()

      const refused = await http.resend(adminToken, first.inviteId)

      expect(refused.status).toBe(409)
      expect(errorCode(refused)).toBe('INVITE_ACCOUNT_ALREADY_ONBOARDED')
      expect(JSON.stringify(refused.body)).not.toContain('inviteToken')
      expect(await snapshot(invitee.id)).toEqual(before)
    })

    it('a resend is refused once any invite for the account has been accepted, and writes nothing', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const accepted = await recordInviteFor(invitee, admin)
      await query(
        "UPDATE user_invites SET status = 'accepted', accepted_at = NOW(), consumed_by = $2 WHERE id = $1",
        [accepted.inviteId, invitee.id],
      )
      const other = await recordInviteFor(invitee, admin)
      const before = await snapshot(invitee.id)
      // The account has no recorded sign-in: the accepted invite alone decides.
      expect((before.user[0] as { last_login_at: unknown }).last_login_at).toBeNull()

      const refusedOther = await http.resend(adminToken, other.inviteId)
      const refusedAccepted = await http.resend(adminToken, accepted.inviteId)

      expect(refusedOther.status).toBe(409)
      expect(errorCode(refusedOther)).toBe('INVITE_ACCOUNT_ALREADY_ONBOARDED')
      expect(refusedAccepted.status).toBe(409)
      expect(errorCode(refusedAccepted)).toBe('INVITE_ALREADY_ACCEPTED')
      expect(await snapshot(invitee.id)).toEqual(before)
    })

    it('a sign-in recorded between the read and the write of a resend leaves the invite unchanged', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const first = await recordInviteFor(invitee, admin)
      const before = await snapshot(invitee.id)
      let placed = 0
      queryHooks.before = async (sql, run) => {
        if (!RESEND_WRITE.test(sql)) return
        queryHooks.before = null
        placed += 1
        await run('UPDATE users SET last_login_at = NOW() WHERE id = $1', [invitee.id])
      }

      const refused = await http.resend(adminToken, first.inviteId)

      expect(placed).toBe(1)
      expect(refused.status).toBe(409)
      expect(errorCode(refused)).toBe('INVITE_RESEND_CONFLICT')
      expect(JSON.stringify(refused.body)).not.toContain('inviteToken')
      const after = await snapshot(invitee.id)
      expect(after.invites).toEqual(before.invites)
      expect(await inviteRow(first.inviteId)).toEqual({ invite_token: first.token, status: 'pending' })
      // Asked again, the read now gives the settled answer.
      expect(errorCode(await http.resend(adminToken, first.inviteId))).toBe('INVITE_ACCOUNT_ALREADY_ONBOARDED')
    })
  })

  describe('an accepted invite stays accepted', () => {
    it('an invite accepted while its resend is waiting for the row is left accepted, under its own token', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const first = await recordInviteFor(invitee, admin)
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      let release: Promise<void> = Promise.resolve()
      let placed = 0
      try {
        queryHooks.before = async (sql, run) => {
          if (!RESEND_WRITE.test(sql)) return
          queryHooks.before = null
          placed += 1
          const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
          await holder.query('BEGIN')
          await holder.query(
            "UPDATE user_invites SET status = 'accepted', accepted_at = NOW(), consumed_by = $2 WHERE id = $1",
            [first.inviteId, invitee.id],
          )
          // Commit only once the resend write is waiting on this row, so the write meets the row in
          // its accepted state. A write that never waits fails the test instead of passing it.
          release = (async () => {
            const deadline = Date.now() + 10_000
            try {
              for (;;) {
                const waiting = await run(
                  "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))",
                  [pid],
                )
                if (waiting.rows.length > 0) break
                if (Date.now() > deadline) throw new Error('the resend write never waited on the invite row')
                await new Promise((resolve) => setTimeout(resolve, 20))
              }
              await holder.query('COMMIT')
            } catch (error) {
              await holder.query('ROLLBACK').catch(() => undefined)
              throw error
            }
          })()
          release.catch(() => undefined)
        }

        const refused = await http.resend(adminToken, first.inviteId)
        await release

        expect(placed).toBe(1)
        expect(refused.status).toBe(409)
        expect(errorCode(refused)).toBe('INVITE_RESEND_CONFLICT')
        expect(JSON.stringify(refused.body)).not.toContain('inviteToken')
        expect(await inviteRow(first.inviteId)).toEqual({ invite_token: first.token, status: 'accepted' })
      } finally {
        queryHooks.before = null
        await holder.end()
      }
    })
  })

  describe('a revoked or superseded invite token cannot be used', () => {
    it('after revoke and after resend the earlier token cannot be used anywhere, with nothing written', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const first = await recordInviteFor(invitee, admin)
      const invalid = { gated: await http.gated('not-a-token'), refresh: await http.refresh('not-a-token') }

      // While its ledger row is pending the token previews.
      const live = await http.preview(first.token)
      expect(live.status).toBe(200)
      expect((live.body as { data: { user: { id: string } } }).data.user.id).toBe(invitee.id)

      // Revoked.
      expect((await http.revoke(adminToken, first.inviteId)).status).toBe(200)
      const revoked = await snapshot(invitee.id)
      const previewRevoked = await http.preview(first.token)
      expect(previewRevoked.status).toBe(409)
      expect(errorCode(previewRevoked)).toBe('INVITE_NOT_PENDING')
      expect((previewRevoked.body as { data?: unknown }).data).toBeUndefined()
      const acceptRevoked = await http.accept(first.token)
      expect(acceptRevoked).toEqual(previewRevoked)
      expect(await http.gated(first.token)).toEqual(invalid.gated)
      expect(await http.refresh(first.token)).toEqual(invalid.refresh)
      expect(await snapshot(invitee.id)).toEqual(revoked)

      // Resent: the row is pending again under a new token, and the earlier token stays unusable.
      const resent = await http.resend(adminToken, first.inviteId)
      expect(resent.status).toBe(200)
      const second = String((resent.body as { data: { inviteToken: string } }).data.inviteToken)
      expect(second).not.toBe(first.token)
      expect(await inviteRow(first.inviteId)).toEqual({ invite_token: second, status: 'pending' })
      const superseded = await snapshot(invitee.id)
      expect((await http.preview(second)).status).toBe(200)
      const previewSuperseded = await http.preview(first.token)
      expect(previewSuperseded.status).toBe(409)
      expect(errorCode(previewSuperseded)).toBe('INVITE_NOT_PENDING')
      const acceptSuperseded = await http.accept(first.token)
      expect(acceptSuperseded).toEqual(previewSuperseded)
      expect(await http.gated(first.token)).toEqual(invalid.gated)
      expect(await http.refresh(first.token)).toEqual(invalid.refresh)
      expect(await http.gated(second)).toEqual(invalid.gated)
      expect(await http.refresh(second)).toEqual(invalid.refresh)
      expect(await snapshot(invitee.id)).toEqual(superseded)

      // The current token is the one that works, once.
      const accepted = await http.accept(second)
      expect(accepted.status).toBe(200)
      expect(await inviteRow(first.inviteId)).toEqual({ invite_token: second, status: 'accepted' })
      // Accepting signs the account in with a session token.
      const sessionToken = String((accepted.body as { data: { token: string } }).data.token)
      expect(claimsUnderSessionSecret(sessionToken)).not.toHaveProperty('type')
      expect(claimsUnderSessionSecret(sessionToken).userId).toBe(invitee.id)
      expect(errorCode(await http.preview(second))).toBe('INVITE_NOT_PENDING')
      const acceptedAgain = await http.accept(second)
      expect(acceptedAgain.status).toBe(409)
      expect(errorCode(acceptedAgain)).toBe('INVITE_NOT_PENDING')
      expect(errorCode(await http.resend(adminToken, first.inviteId))).toBe('INVITE_ALREADY_ACCEPTED')
    })

    it('a token the ledger does not hold cannot be previewed or accepted, with nothing written', async () => {
      const admin = await seedUser({ admin: true })
      const invitee = await seedUser()
      const recorded = await recordInviteFor(invitee, admin)
      const unrecorded = issueInviteToken({ userId: invitee.id, email: invitee.email })
      expect(unrecorded).not.toBe(recorded.token)
      const before = await snapshot(invitee.id)

      const preview = await http.preview(unrecorded)
      const accept = await http.accept(unrecorded)

      expect(preview.status).toBe(409)
      expect(errorCode(preview)).toBe('INVITE_NOT_PENDING')
      expect(accept).toEqual(preview)
      expect(await snapshot(invitee.id)).toEqual(before)
    })

    it('a token the ledger does not hold as pending gets one answer from acceptance, whatever the account and the password', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const dead: Array<[string, string, string]> = []

      // An account in good standing.
      const plain = await seedUser()
      const plainInvite = await recordInviteFor(plain, admin)
      expect((await http.revoke(adminToken, plainInvite.inviteId)).status).toBe(200)
      dead.push(['account unchanged', plainInvite.token, plain.id])

      // An account written to after the token was issued.
      const touched = await seedUser()
      const touchedInvite = await recordInviteFor(touched, admin)
      expect((await http.revoke(adminToken, touchedInvite.inviteId)).status).toBe(200)
      await query("UPDATE users SET name = 'Renamed', updated_at = NOW() + interval '1 hour' WHERE id = $1", [touched.id])
      dead.push(['account written to since', touchedInvite.token, touched.id])

      // An account that is not activated.
      const inactive = await seedUser()
      const inactiveInvite = await recordInviteFor(inactive, admin)
      expect((await http.revoke(adminToken, inactiveInvite.inviteId)).status).toBe(200)
      await query("UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", [inactive.id])
      dead.push(['account pending activation', inactiveInvite.token, inactive.id])

      // An account whose email no longer matches the token.
      const moved = await seedUser()
      const movedInvite = await recordInviteFor(moved, admin)
      expect((await http.revoke(adminToken, movedInvite.inviteId)).status).toBe(200)
      await query('UPDATE users SET email = $2 WHERE id = $1', [moved.id, `moved_${moved.email}`])
      dead.push(['account under another email', movedInvite.token, moved.id])

      const expected = { status: 409, body: { success: false, error: 'Invite is no longer valid', code: 'INVITE_NOT_PENDING' } }
      for (const [label, token, userId] of dead) {
        const before = await snapshot(userId)
        expect(await http.accept(token), label).toEqual(expected)
        expect(
          await answer(request(pinned.url()).post('/api/auth/invite/accept').send({ token, password: 'weak' })),
          label,
        ).toEqual(expected)
        expect(await http.preview(token), label).toEqual(expected)
        expect(await snapshot(userId), label).toEqual(before)
      }
    })

    it.each([
      ['revoked', false],
      ['replaced by a later token', true],
    ])('an invite %s between the ledger read and the transaction of its acceptance is not accepted, and the account is not written', async (_label, replace) => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      const invitee = await seedUser()
      const first = await recordInviteFor(invitee, admin)
      let placed = 0
      let settled: Awaited<ReturnType<typeof snapshot>> | null = null
      queryHooks.before = async (sql) => {
        if (!ACCEPT_ACCOUNT_READ.test(sql)) return
        queryHooks.before = null
        placed += 1
        const changed = replace
          ? await http.resend(adminToken, first.inviteId)
          : await http.revoke(adminToken, first.inviteId)
        expect(changed.status).toBe(200)
        settled = await snapshot(invitee.id)
      }

      const refused = await http.accept(first.token)

      // The ledger read saw a pending row; the consume inside the transaction is what decides.
      expect(placed).toBe(1)
      expect(refused.status).toBe(409)
      expect(errorCode(refused)).toBe('INVITE_LEDGER_CONSUME_FAILED')
      expect(settled).not.toBeNull()
      expect(await snapshot(invitee.id)).toEqual(settled)
      const row = await inviteRow(first.inviteId)
      expect(row.status).toBe(replace ? 'pending' : 'revoked')
      expect(row.invite_token === first.token).toBe(!replace)
      // The password the request carried was not set.
      expect(await authService.login(invitee.email, NEW_PASSWORD)).toBeNull()
    })
  })

  describe('every issued invite token is distinct', () => {
    it('a resend issues a token different from the one it replaces, and the replaced token stops working', async () => {
      const admin = await seedUser({ admin: true })
      const adminToken = sessionTokenWithoutSessionId(admin, 'admin')
      // Both tokens of a pair are issued for the same account, preset and lifetime. A pair counts
      // only when the two carry the same claims apart from their identifier; a run in which no pair
      // did fails instead of passing.
      let pairsAlikeButForIdentifier = 0
      for (let attempt = 0; attempt < 5 && pairsAlikeButForIdentifier === 0; attempt += 1) {
        const invitee = await seedUser()
        // Both tokens of the pair are to carry the same timestamps.
        const intoSecond = Date.now() % 1000
        if (intoSecond > 300) await new Promise((resolve) => setTimeout(resolve, 1005 - intoSecond))
        const first = await recordInviteFor(invitee, admin)

        const resent = await http.resend(adminToken, first.inviteId)

        expect(resent.status).toBe(200)
        const second = String((resent.body as { data: { inviteToken: string } }).data.inviteToken)
        expect(second).not.toBe(first.token)
        expect(await inviteRow(first.inviteId)).toEqual({ invite_token: second, status: 'pending' })
        if (JSON.stringify(claimsWithoutIdentifier(second)) !== JSON.stringify(claimsWithoutIdentifier(first.token))) continue
        pairsAlikeButForIdentifier += 1

        const settled = await snapshot(invitee.id)
        const previewFirst = await http.preview(first.token)
        expect(previewFirst.status).toBe(409)
        expect(errorCode(previewFirst)).toBe('INVITE_NOT_PENDING')
        expect(await http.accept(first.token)).toEqual(previewFirst)
        expect(await snapshot(invitee.id)).toEqual(settled)
        expect((await http.preview(second)).status).toBe(200)
        expect((await http.accept(second)).status).toBe(200)
      }
      expect(pairsAlikeButForIdentifier).toBeGreaterThan(0)
    })
  })
})
