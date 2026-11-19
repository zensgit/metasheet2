/**
 * Native actor-input cases. This slice does not run them.
 * Without EXPECT_DB=1 the suite is skipped. A skip is not a pass.
 * Migration cases do not prove the producer. The helper and the real
 * cookie do. Both call the static import of assertAuthenticatedSessionContext.
 * DROP SCHEMA in cleanup removes the fixture. It is not migration down.
 */
import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type QueryResult } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import {
  adminGrantBrowserNonceDigest,
  createAdminGrantBrowserContext,
  parseAdminGrantBrowserCookie,
  type AdminGrantBrowserService,
} from '../../src/auth/admin-grant-browser-context'
import {
  AdminGrantActorInputError,
  changeRequiredPasswordWithProvenance,
  classifyAdminGrantActorInputSchema,
  readAdminGrantLocalCredential,
} from '../../src/auth/admin-grant-local-credential'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import {
  ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED_CODE,
  ADMIN_GRANT_ACTOR_INPUTS_ISOLATION_CODE,
  ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_CODE,
  down,
  quoteAdminGrantActorInputIdent,
  up,
} from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'
import { ORG, SESSION, USER, contextFor, requestShape, tokenFor } from '../helpers/security-action-proof-harness'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for admin-grant-actor-inputs.db.test.ts')
}

const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip
const ORIGIN = 'https://grant.example'
const NEXT_HASH = `$2a$10$${ 'a'.repeat(53) }`
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const kept: string[] = []

type Env = {
  schema: string
  pool: Pool
  db: Kysely<unknown>
  run<T>(handler: (executor: Queryable) => Promise<T>): Promise<T>
  rows(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
  install(): Promise<void>
}

function asExecutor(pool: Pool): Queryable {
  return {
    query: (text: string, params?: unknown[]) => pool.query(text, params) as Promise<QueryResult>,
  } as Queryable
}

async function withSchema(fn: (env: Env) => Promise<void>): Promise<void> {
  const schema = `agact_${randomBytes(8).toString('hex')}`
  kept.push(schema)
  const quoted = quoteAdminGrantActorInputIdent(schema)
  const admin = new Pool({ connectionString: databaseUrl })
  try {
    await admin.query(`CREATE SCHEMA ${quoted}`)
  } finally {
    await admin.end()
  }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const env: Env = {
    schema,
    pool,
    db,
    async run(handler) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const result = await handler({
            query: (text: string, params?: unknown[]) => client.query(text, params),
          } as Queryable)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
    async rows(text, params = []) {
      const result = await pool.query(text, params)
      return result.rows as Array<Record<string, unknown>>
    },
    async install() {
      await db.transaction().execute(async (trx) => {
        await up(trx)
      })
    },
  }
  try {
    const seen = await env.rows('SELECT current_schema() AS schema_name')
    if (seen[0]?.schema_name !== schema) throw new Error('ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_MISMATCH')
    await pool.query(`CREATE TABLE users (
      id text PRIMARY KEY,
      password_hash text,
      local_password_set boolean NOT NULL DEFAULT false,
      must_change_password boolean NOT NULL DEFAULT false,
      activation_status text NOT NULL,
      is_active boolean NOT NULL,
      role text,
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    )`)
    await pool.query(`CREATE TABLE user_sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    )`)
    await pool.query(`CREATE TABLE user_session_revocations (
      user_id text PRIMARY KEY,
      revoked_after timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by text,
      reason text
    )`)
    await pool.query('CREATE TABLE actor_input_keep (id text PRIMARY KEY)')
    await pool.query(`INSERT INTO actor_input_keep (id) VALUES ('keep')`)
    await fn(env)
  } finally {
    await db.destroy()
  }
}

async function insertUser(env: Env, id: string, mustChange = true): Promise<void> {
  await env.pool.query(
    `INSERT INTO users (id, password_hash, local_password_set, must_change_password, activation_status, is_active, role)
     VALUES ($1, 'old-hash', true, $2, 'activated', true, 'admin')`,
    [id, mustChange],
  )
}

async function insertSession(env: Env, id: string, userId: string): Promise<void> {
  await env.pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour')`,
    [id, userId],
  )
}

function actorRequest(userId: string, sid: string, headers: Record<string, string> = {}): Request {
  const token = tokenFor(userId, sid, ORG)
  return requestShape(userId, token, ORG, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN, ...headers },
  })
}

function captureResponse(): { res: Response, cookies: string[], sent: { value: boolean } } {
  const cookies: string[] = []
  const sent = { value: false }
  const res = {
    get headersSent() { return sent.value },
    append(field: string, value: string) {
      cookies.push(`${field}:${value}`)
      return this
    },
  }
  return { res: res as unknown as Response, cookies, sent }
}

describeDb('admin grant actor inputs', () => {
  afterAll(async () => {
    if (databaseUrl.length === 0 || kept.length === 0) return
    const admin = new Pool({ connectionString: databaseUrl })
    try {
      for (const schema of kept) {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteAdminGrantActorInputIdent(schema)} CASCADE`)
      }
    } finally {
      await admin.end()
    }
  })

  it('keeps null history, rejects spoofed versions, and refuses a dirty or autocommit down', async () => {
    await withSchema(async (env) => {
      await insertUser(env, 'user-before')
      await env.install()
      const before = await env.rows('SELECT local_credential_version::text AS version FROM users WHERE id = $1', ['user-before'])
      expect(before[0]?.version ?? null).toBeNull()
      const supplied = '11111111-1111-4111-8111-111111111111'
      await env.pool.query(
        `INSERT INTO users (id, password_hash, local_password_set, must_change_password, activation_status, is_active, role, local_credential_version)
         VALUES ('user-spoof', 'old-hash', true, true, 'activated', true, 'admin', $1::uuid)`,
        [supplied],
      )
      const spoofed = await env.rows('SELECT local_credential_version::text AS version FROM users WHERE id = $1', ['user-spoof'])
      const stored = String(spoofed[0]?.version ?? '')
      expect(stored).toMatch(UUID_TEXT)
      expect(stored).not.toBe(supplied)
      await env.pool.query(`UPDATE users SET updated_at = pg_catalog.clock_timestamp() WHERE id = 'user-spoof'`)
      const keptVersion = await env.rows('SELECT local_credential_version::text AS version FROM users WHERE id = $1', ['user-spoof'])
      expect(keptVersion[0]?.version).toBe(stored)
      await expect(env.pool.query(
        `INSERT INTO user_local_credential_establishments (user_id, credential_version, kind, source_session_id)
         VALUES ('user-spoof', $1::uuid, 'self_password_change', 'sid-raw')`,
        [stored],
      )).rejects.toMatchObject({ code: '42501' })
      await env.pool.query(
        `UPDATE users SET password_hash = $1, must_change_password = false, local_password_set = true WHERE id = 'user-spoof'`,
        [NEXT_HASH],
      )
      const establishments = await env.rows('SELECT count(*)::int AS n FROM user_local_credential_establishments')
      expect(establishments[0]?.n).toBe(0)
      await expect(env.db.transaction().execute(async (trx) => {
        await down(trx)
      })).rejects.toMatchObject({ code: ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED_CODE })
      const stillThere = await env.rows(`SELECT to_regclass('user_local_credential_establishments') AS relation`)
      expect(stillThere[0]?.relation).not.toBeNull()
      await expect(down(env.db)).rejects.toMatchObject({ code: ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_CODE })
    })
  })

  it('classifies absent, ready, and partial, then drops only the new objects', async () => {
    await withSchema(async (env) => {
      await insertUser(env, 'user-clean', false)
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('absent')
      await expect(up(env.db)).rejects.toMatchObject({ code: ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_CODE })
      await expect(env.db.transaction().execute(async (trx) => {
        await sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`.execute(trx)
        await up(trx)
      })).rejects.toMatchObject({ code: ADMIN_GRANT_ACTOR_INPUTS_ISOLATION_CODE })
      await env.install()
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('ready')
      const unchanged = await env.rows('SELECT local_credential_version IS NULL AS missing FROM users WHERE id = $1', ['user-clean'])
      expect(unchanged[0]?.missing).toBe(true)
      await env.pool.query('DROP TRIGGER admin_grant_browser_binding_guard ON security_action_browser_bindings')
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('partial')
      await env.db.transaction().execute(async (trx) => {
        await down(trx)
      })
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('absent')
      const users = await env.rows(`SELECT to_regclass('users') AS relation`)
      const kept = await env.rows(`SELECT id FROM actor_input_keep`)
      const column = await env.rows(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute att
             JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
             JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
            WHERE ns.nspname = $1
              AND rel.relname = 'users'
              AND att.attname = 'local_credential_version'
              AND NOT att.attisdropped
         ) AS present`,
        [env.schema],
      )
      expect(users[0]?.relation).not.toBeNull()
      expect(kept[0]?.id).toBe('keep')
      expect(column[0]?.present).toBe(false)
    })
  })

  it('establishes the current must-change through the helper for an admin', async () => {
    await withSchema(async (env) => {
      await env.install()
      await insertUser(env, USER)
      await insertSession(env, SESSION, USER)
      await env.pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '2020-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'already-there')`,
        [USER],
      )
      const session = contextFor(USER, SESSION, ORG)
      const established = await changeRequiredPasswordWithProvenance({
        session,
        passwordHash: NEXT_HASH,
      }, env.run)
      expect(established.kind).toBe('self_password_change')
      expect(established.userId).toBe(USER)
      expect(established.sourceSessionId).toBe(SESSION)
      expect(established.credentialVersion).toMatch(UUID_TEXT)
      const user = await env.rows(
        `SELECT password_hash, must_change_password, local_password_set, local_credential_version::text AS version
           FROM users WHERE id = $1`,
        [USER],
      )
      expect(user[0]?.password_hash).toBe(NEXT_HASH)
      expect(user[0]?.must_change_password).toBe(false)
      expect(user[0]?.local_password_set).toBe(true)
      expect(user[0]?.version).toBe(established.credentialVersion)
      const row = await env.rows(
        `SELECT id::text AS id, kind, source_session_id,
                established_at > pg_catalog.clock_timestamp() - interval '5 minutes' AS recent
           FROM user_local_credential_establishments WHERE user_id = $1`,
        [USER],
      )
      expect(row).toHaveLength(1)
      expect(row[0]?.id).toBe(established.establishmentId)
      expect(row[0]?.kind).toBe('self_password_change')
      expect(row[0]?.source_session_id).toBe(SESSION)
      expect(row[0]?.recent).toBe(true)
      const watermark = await env.rows(
        `SELECT reason, revoked_after > TIMESTAMPTZ '2020-01-01 00:00:00+00' AS advanced
           FROM user_session_revocations WHERE user_id = $1`,
        [USER],
      )
      expect(watermark[0]?.reason).toBe('password-change-required-cleared')
      expect(watermark[0]?.advanced).toBe(true)
      const later = contextFor(USER, 'sid-later', ORG)
      const witness = await readAdminGrantLocalCredential(asExecutor(env.pool), later)
      expect(witness.sourceSessionId).toBe(SESSION)
      expect(witness.credentialVersion).toBe(established.credentialVersion)
      await insertUser(env, 'user-future')
      await insertSession(env, 'sid-future', 'user-future')
      await env.pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ('user-future', TIMESTAMPTZ '2099-01-01 00:00:00+00', pg_catalog.clock_timestamp(), 'user-future', 'future-mark')`,
      )
      await expect(changeRequiredPasswordWithProvenance({
        session: contextFor('user-future', 'sid-future', ORG),
        passwordHash: NEXT_HASH,
      }, env.run)).rejects.toMatchObject({ code: 'ADMIN_GRANT_CREDENTIAL_INELIGIBLE' })
      const future = await env.rows(
        `SELECT reason, revoked_after = TIMESTAMPTZ '2099-01-01 00:00:00+00' AS same,
                must_change_password
           FROM user_session_revocations
           JOIN users ON users.id = user_session_revocations.user_id
          WHERE user_session_revocations.user_id = 'user-future'`,
      )
      expect(future[0]?.reason).toBe('future-mark')
      expect(future[0]?.same).toBe(true)
      expect(future[0]?.must_change_password).toBe(true)
    })
  })

  it('sets one server cookie for a new sid and does not replace a real watermark', async () => {
    await withSchema(async (env) => {
      await env.install()
      await insertUser(env, USER)
      await insertSession(env, SESSION, USER)
      await env.pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '2020-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'already-there')`,
        [USER],
      )
      const service = createAdminGrantBrowserContext({ publicOrigin: ORIGIN, transaction: env.run })
      const lost = captureResponse()
      lost.sent.value = true
      await expect(service.establish(actorRequest(USER, SESSION), lost.res)).rejects.toBeInstanceOf(AdminGrantActorInputError)
      expect(lost.cookies).toEqual([])
      const first = captureResponse()
      const bound = await service.establish(actorRequest(USER, SESSION, {
        cookie: `${'__Host-meta-agp'}=not-a-valid-nonce`,
      }), first.res)
      expect(first.cookies).toHaveLength(1)
      const parsed = parseAdminGrantBrowserCookie(first.cookies[0]?.slice('Set-Cookie:'.length) ?? '')
      expect(parsed.state).toBe('present')
      expect(first.cookies[0]).toContain('Path=/; HttpOnly; Secure; SameSite=Strict')
      expect(first.cookies[0]).not.toContain('Domain=')
      const digest = adminGrantBrowserNonceDigest(Buffer.from(parsed.nonce ?? '', 'base64url'))
      const stored = await env.rows(
        `SELECT b.nonce_digest, b.origin, b.user_id, b.org_id,
                b.expires_at = s.expires_at AS same_expiry,
                to_char(b.established_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS established_at_text
           FROM security_action_browser_bindings b
           JOIN user_sessions s ON s.id = b.session_id
          WHERE b.session_id = $1`,
        [SESSION],
      )
      expect(stored[0]?.nonce_digest).toBe(digest)
      expect(stored[0]?.origin).toBe(ORIGIN)
      expect(stored[0]?.user_id).toBe(USER)
      expect(stored[0]?.org_id).toBe(ORG)
      expect(stored[0]?.same_expiry).toBe(true)
      expect(stored[0]?.established_at_text).toMatch(INSTANT_TEXT)
      expect(bound.nonceDigest).toBe(digest)
      expect(bound.origin).toBe(ORIGIN)
      const watermark = await env.rows(
        `SELECT reason, revoked_after = TIMESTAMPTZ '2020-01-01 00:00:00+00' AS same
           FROM user_session_revocations WHERE user_id = $1`,
        [USER],
      )
      expect(watermark[0]?.reason).toBe('already-there')
      expect(watermark[0]?.same).toBe(true)
      const again = captureResponse()
      const repeated = await service.establish(actorRequest(USER, SESSION, {
        cookie: `__Host-meta-agp=${parsed.nonce}`,
      }), again.res)
      expect(again.cookies).toEqual([])
      expect(repeated.bindingId).toBe(bound.bindingId)
      const sameOrigin: AdminGrantBrowserService = createAdminGrantBrowserContext({ publicOrigin: ORIGIN, transaction: env.run })
      sameOrigin.assert(bound)
      const witness = await sameOrigin.assertCurrent(asExecutor(env.pool), bound)
      expect(witness.sessionId).toBe(SESSION)
      expect(witness.nonceDigest).toBe(digest)
      expect(witness.sessionExpiresAt).toMatch(INSTANT_TEXT)
      const otherOrigin = createAdminGrantBrowserContext({ publicOrigin: 'https://other.example', transaction: env.run })
      expect(() => otherOrigin.assert(bound)).toThrow(AdminGrantActorInputError)
      await insertSession(env, 'sid-next', USER)
      const recovered = captureResponse()
      await service.establish(actorRequest(USER, 'sid-next', {
        cookie: `__Host-meta-agp=${parsed.nonce}`,
      }), recovered.res)
      expect(recovered.cookies).toHaveLength(1)
      await env.pool.query(
        `UPDATE security_action_browser_bindings
            SET revoked_at = pg_catalog.clock_timestamp()
          WHERE session_id = $1`,
        [SESSION],
      )
      const stale = captureResponse()
      await expect(service.establish(actorRequest(USER, SESSION, {
        cookie: `__Host-meta-agp=${parsed.nonce}`,
      }), stale.res)).rejects.toMatchObject({ code: 'ADMIN_GRANT_BROWSER_SESSION_STALE' })
      expect(stale.cookies).toEqual([])
      const revoked = await env.rows(
        `SELECT count(*)::int AS n, bool_or(revoked_at IS NOT NULL) AS revoked
           FROM security_action_browser_bindings WHERE session_id = $1`,
        [SESSION],
      )
      expect(revoked[0]?.n).toBe(1)
      expect(revoked[0]?.revoked).toBe(true)
      await insertSession(env, 'sid-origin', USER)
      const mismatched = captureResponse()
      await expect(service.establish(actorRequest(USER, 'sid-origin', {
        origin: 'https://other.example',
      }), mismatched.res)).rejects.toMatchObject({ code: 'ADMIN_GRANT_BROWSER_ORIGIN_MISMATCH' })
      const originRows = await env.rows(
        `SELECT count(*)::int AS n FROM security_action_browser_bindings WHERE session_id = 'sid-origin'`,
      )
      expect(originRows[0]?.n).toBe(0)
    })
  })

  it('refuses browser positives when the binding guard is disabled or missing', async () => {
    await withSchema(async (env) => {
      await env.install()
      await insertUser(env, USER)
      await insertSession(env, SESSION, USER)
      await env.pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '2020-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'already-there')`,
        [USER],
      )
      const service: AdminGrantBrowserService = createAdminGrantBrowserContext({ publicOrigin: ORIGIN, transaction: env.run })
      const first = captureResponse()
      const bound = await service.establish(actorRequest(USER, SESSION), first.res)
      expect(first.cookies).toHaveLength(1)
      const cookie = first.cookies[0]?.slice('Set-Cookie:'.length) ?? ''
      const parsed = parseAdminGrantBrowserCookie(cookie)
      await env.pool.query('ALTER TABLE security_action_browser_bindings DISABLE TRIGGER admin_grant_browser_binding_guard')
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('partial')
      await insertSession(env, 'sid-disabled', USER)
      const disabled = captureResponse()
      await expect(service.establish(actorRequest(USER, 'sid-disabled'), disabled.res)).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      expect(disabled.cookies).toEqual([])
      const disabledRows = await env.rows(
        `SELECT count(*)::int AS n FROM security_action_browser_bindings WHERE session_id = 'sid-disabled'`,
      )
      expect(disabledRows[0]?.n).toBe(0)
      await expect(service.read(actorRequest(USER, SESSION, { cookie }))).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      await expect(service.assertCurrent(asExecutor(env.pool), bound)).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      await env.pool.query('ALTER TABLE security_action_browser_bindings ENABLE TRIGGER admin_grant_browser_binding_guard')
      await env.pool.query('DROP TRIGGER admin_grant_browser_binding_guard ON security_action_browser_bindings')
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('partial')
      await insertSession(env, 'sid-missing', USER)
      const missing = captureResponse()
      await expect(service.establish(actorRequest(USER, 'sid-missing'), missing.res)).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      expect(missing.cookies).toEqual([])
      const missingRows = await env.rows(
        `SELECT count(*)::int AS n FROM security_action_browser_bindings WHERE session_id = 'sid-missing'`,
      )
      expect(missingRows[0]?.n).toBe(0)
      await expect(service.read(actorRequest(USER, SESSION, { cookie }))).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      await expect(service.assertCurrent(asExecutor(env.pool), bound)).rejects.toMatchObject({
        code: 'ADMIN_GRANT_BROWSER_UNAVAILABLE',
      })
      const keptBinding = await env.rows(
        `SELECT count(*)::int AS n FROM security_action_browser_bindings WHERE session_id = $1`,
        [SESSION],
      )
      expect(keptBinding[0]?.n).toBe(1)
    })
  })

  it('drops empty orphan functions and the version trigger, then reinstalls', async () => {
    await withSchema(async (env) => {
      await insertUser(env, 'user-orphan')
      await env.install()
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('ready')
      await env.pool.query('DROP TABLE security_action_browser_bindings')
      await env.pool.query('DROP TABLE user_local_credential_establishments')
      await env.pool.query('ALTER TABLE users DROP COLUMN local_credential_version')
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('partial')
      const before = await env.rows(`
        SELECT
          (SELECT count(*)::int
             FROM pg_catalog.pg_proc proc
             JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
            WHERE ns.nspname = current_schema()
              AND proc.proname IN (
                'admin_grant_local_credential_version',
                'admin_grant_local_credential_establishment_guard',
                'admin_grant_browser_binding_guard'
              )) AS functions,
          (SELECT count(*)::int
             FROM pg_catalog.pg_trigger tg
             JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
             JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
            WHERE ns.nspname = current_schema()
              AND rel.relname = 'users'
              AND tg.tgname = 'admin_grant_local_credential_version'
              AND NOT tg.tgisinternal) AS version_trigger
      `)
      expect(before[0]?.functions).toBe(3)
      expect(before[0]?.version_trigger).toBe(1)
      await env.db.transaction().execute(async (trx) => {
        await down(trx)
      })
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('absent')
      const after = await env.rows(`
        SELECT
          (SELECT count(*)::int
             FROM pg_catalog.pg_proc proc
             JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
            WHERE ns.nspname = current_schema()
              AND proc.proname IN (
                'admin_grant_local_credential_version',
                'admin_grant_local_credential_establishment_guard',
                'admin_grant_browser_binding_guard'
              )) AS functions,
          (SELECT count(*)::int
             FROM pg_catalog.pg_trigger tg
             JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
             JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
            WHERE ns.nspname = current_schema()
              AND rel.relname = 'users'
              AND tg.tgname = 'admin_grant_local_credential_version'
              AND NOT tg.tgisinternal) AS version_trigger
      `)
      expect(after[0]?.functions).toBe(0)
      expect(after[0]?.version_trigger).toBe(0)
      const keptUser = await env.rows(`SELECT id FROM users WHERE id = 'user-orphan'`)
      const keptRow = await env.rows(`SELECT id FROM actor_input_keep`)
      expect(keptUser[0]?.id).toBe('user-orphan')
      expect(keptRow[0]?.id).toBe('keep')
      await env.install()
      expect(await classifyAdminGrantActorInputSchema(asExecutor(env.pool))).toBe('ready')
    })
  })
})
