/**
 * Real PostgreSQL proof for frozen continuous mode and the initial completion.
 * The native fetch override is process-local. It runs only when NODE_ENV is not
 * production and PLM_MANAGED_COMPANION_TEST_HOOKS=true. It is not a native
 * cross-process result.
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { query } from '../../src/db/pg'
import { up, down } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { down as continuousDown, up as continuousUp } from '../../src/db/migrations/zzzz20261022010000_plm_managed_continuous_completion'
import managedLoginRouter from '../../src/routes/plm-managed-companion'
import {
  MANAGED_INTENT_COOKIE,
  MANAGED_NONCE_COOKIE,
  MANAGED_SESSION_COOKIE,
  openCredential,
  sealCredential,
} from '../../src/services/plm-managed-companion'
import {
  completeManagedBrowserLogin,
  provisionManagedLink,
  startManagedBrowserLogin,
  startManagedLogin,
  unlinkManagedSource,
  setManagedFlowHooksForTests,
} from '../../src/services/plm-managed-companion-flow'
import { setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'

function explicitUrl(): string {
  const raw = process.env.PLM_MANAGED_COMPANION_TEST_PG_URL
  if (!raw) throw new Error('Explicit disposable managed-companion PostgreSQL URL required')
  const url = new URL(raw)
  const socket = url.searchParams.get('host') ?? ''
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !socket.startsWith('/tmp/plm-managed-consumer-pg-')) {
    throw new Error('Managed-companion PostgreSQL URL must be an owned socket DSN')
  }
  if (process.env.DATABASE_URL !== raw) throw new Error('DATABASE_URL must be the explicit managed-companion DSN')
  return raw
}

const pgUrl = explicitUrl()
const ORIGIN = 'http://127.0.0.1:9'
const ISSUER = `${ORIGIN}/installation`
const CALLBACK = `${ORIGIN}/api/plm/managed-login/callback`
const SECRET = 'synthetic-client-secret-configured-control'
const OWNER = 'meta-owner'
const OTHER = 'meta-other'
const ADMIN = 'meta-admin'
const TENANT = 'meta-tenant'
const ORG = 'meta-org'
const SOURCE = 'source-1'
const ACTOR = { id: OWNER, role: 'user' as const, authenticatedTenantId: TENANT }

type CookieJar = Record<string, { value: string; options: Record<string, unknown> }>
type NativeCall = { url: string; body: Record<string, unknown> | null }
type CredentialSpec = {
  jti: string
  exp: number
  delegationId: string
  subject?: string
  expiresIn?: number
  generationIndex?: number
  credentialJti?: string
  tenantId?: string
  orgId?: string
  rootPartId?: string
  clientOrigin?: string
  omitGeneration?: boolean
  credential?: string
}

const nativeCalls: NativeCall[] = []
let revokeStatus = 204

function enable(): void {
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{
    issuer: ISSUER,
    clientId: 'managed-fixture',
    clientSecret: SECRET,
    callback: CALLBACK,
    origin: ORIGIN,
    nativeTenantId: 'default',
    nativeOrgId: 'fixture-org',
    nativeBaseUrl: ORIGIN,
  }])
}

function yur(spec: CredentialSpec): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    typ: 'bom_review_read_delegation',
    aud: 'metasheet-bom-review',
    sub: spec.subject ?? '42',
    delegation_id: spec.delegationId,
    jti: spec.jti,
    iat: spec.exp - 120,
    exp: spec.exp,
  })).toString('base64url')
  return `yur_${header}.${payload}.synthetic-signature`
}

function continuousJson(spec: CredentialSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: spec.subject ?? '42',
    tenant_id: spec.tenantId ?? 'default',
    org_id: spec.orgId ?? 'fixture-org',
    client_id: 'managed-fixture',
    issuer: ISSUER,
    scope: 'bom_review_read',
    delegation_id: spec.delegationId,
    expires_in: spec.expiresIn ?? 30,
    credential: spec.credential ?? yur(spec),
    root_part_id: spec.rootPartId ?? 'part',
    client_origin: spec.clientOrigin ?? ORIGIN,
    credential_jti: spec.credentialJti ?? spec.jti,
  }
  if (!spec.omitGeneration) body.generation_index = spec.generationIndex ?? 0
  return body
}

function installContinuous(handler?: (href: string, body: Record<string, unknown> | null) => Promise<Response> | Response): void {
  setManagedNativeFetchForTests(async (url, init) => {
    const href = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    nativeCalls.push({ url: href, body })
    if (handler) return handler(href, body)
    if (href.endsWith('/exchange-continuous')) return Response.json(continuousJson(defaultSpec()))
    if (href.endsWith('/revoke')) return new Response(null, { status: revokeStatus })
    return new Response('missing', { status: 404 })
  })
}

function defaultSpec(): CredentialSpec {
  return {
    jti: 'jti-continuous',
    exp: Math.floor(Date.now() / 1000) + 180,
    delegationId: 'del-continuous',
    expiresIn: 30,
  }
}

function responseDouble() {
  const cookies: CookieJar = {}
  const cleared: string[] = []
  let statusCode = 200
  let payload: unknown = null
  const res = {
    cookies,
    cleared,
    get statusCode() { return statusCode },
    get payload() { return payload },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      cookies[name] = { value, options }
    },
    clearCookie(name: string) {
      cleared.push(name)
      delete cookies[name]
    },
    status(code: number) {
      statusCode = code
      return this
    },
    json(body: unknown) {
      payload = body
      return this
    },
    redirect() { return this },
    set() { return this },
  }
  return res
}

function provisionBody(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    nativeAuthUserId: '42',
    nativeTenantId: 'default',
    nativeOrgId: 'fixture-org',
    metaUserId: OWNER,
    metaTenantId: TENANT,
    metaOrgId: ORG,
    dataSourceId: SOURCE,
    rootPartId: 'part',
    ownerOptIn: true,
    ...overrides,
  }
}

function completeRequest(started: { res: ReturnType<typeof responseDouble>; state: string }, code = 'same-code') {
  const intent = started.res.cookies[MANAGED_INTENT_COOKIE]?.value
  const nonce = started.res.cookies[MANAGED_NONCE_COOKIE]?.value
  return {
    headers: {
      origin: ORIGIN,
      'x-metasheet-managed-bridge': 'complete',
      cookie: `${MANAGED_INTENT_COOKIE}=${intent}; ${MANAGED_NONCE_COOKIE}=${nonce}`,
    },
    body: { code, state: started.state },
  }
}

async function beginContinuous() {
  const created = await provisionManagedLink(ACTOR, provisionBody({ continuityMode: 'hour' }))
  const res = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, res as never)
  return {
    created,
    res,
    state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
    navigation: new URL(started.navigationUrl),
  }
}

async function finish(started: { res: ReturnType<typeof responseDouble>; state: string }, code = 'same-code') {
  const done = responseDouble()
  await completeManagedBrowserLogin(completeRequest(started, code) as never, done as never)
  return done
}

async function resetRows(): Promise<void> {
  await query('DELETE FROM plm_managed_revoke_outbox')
  await query('DELETE FROM plm_managed_sessions')
  await query('DELETE FROM plm_managed_browser_intents')
  await query('DELETE FROM plm_managed_source_bindings')
  await query('DELETE FROM plm_managed_identity_links')
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const found = await query(
    `SELECT 1
     FROM pg_attribute attribute
     JOIN pg_class relation ON relation.oid = attribute.attrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relname = $1
       AND attribute.attname = $2 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
    [table, column],
  )
  return found.rows.length === 1
}

async function intentGuard(): Promise<string> {
  const found = await query<{ def: string }>(
    `SELECT pg_get_functiondef('public.plm_managed_browser_intents_guard()'::regprocedure) AS def`,
  )
  return found.rows[0]?.def ?? ''
}

async function settleDowngradeRace(input: {
  writer: Client
  writerOpen: boolean
  committed: boolean
  downResult: Promise<unknown> | null
  downPool: Pool
  db: Kysely<unknown>
}): Promise<void> {
  const failures: string[] = []
  const step = async (name: string, action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (input.writerOpen && !input.committed) {
    await step('writer rollback', () => input.writer.query('ROLLBACK').then(() => undefined))
  }
  if (input.writerOpen) {
    await step('writer end', () => input.writer.end())
  }
  if (input.downResult) {
    await step('down settlement', () => input.downResult!.then(() => undefined))
  }
  await step('schema restore', async () => {
    if (!await columnExists('plm_managed_identity_links', 'continuity_mode')) await continuousUp(input.db)
  })
  await step('down pool end', () => input.downPool.end())
  await step('backend check', async () => {
    const left = await query<{ application_name: string; state: string | null }>(
      `SELECT application_name, state
       FROM pg_stat_activity
       WHERE application_name IN ('plm-continuous-evidence-writer', 'plm-continuous-downgrade')`,
    )
    if (left.rows.length > 0) {
      throw new Error(`connections still present: ${JSON.stringify(left.rows)}`)
    }
  })
  if (failures.length > 0) {
    throw new Error(`downgrade race cleanup did not settle: ${failures.join('; ')}`)
  }
}

function epoch(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value))
  return Math.floor(date.getTime() / 1000)
}

beforeAll(async () => {
  enable()
  const pool = new Pool({ connectionString: pgUrl, max: 2 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await pool.query(`
    DROP TABLE IF EXISTS plm_managed_revoke_outbox, plm_managed_sessions, plm_managed_browser_intents, plm_managed_source_bindings, plm_managed_identity_links CASCADE;
    DROP FUNCTION IF EXISTS plm_managed_identity_links_guard();
    DROP FUNCTION IF EXISTS plm_managed_browser_intents_guard();
    DROP FUNCTION IF EXISTS plm_managed_sessions_guard();
    DROP FUNCTION IF EXISTS plm_managed_source_bindings_guard();
    DROP FUNCTION IF EXISTS plm_managed_revoke_outbox_guard();
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, email text, username text, mobile text, name text, role text,
      permissions jsonb, password_hash text, is_active boolean, must_change_password boolean,
      activation_status text, local_password_set boolean, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_orgs (user_id text, org_id text, is_active boolean);
    CREATE UNIQUE INDEX IF NOT EXISTS user_orgs_user_org_uidx ON user_orgs (user_id, org_id);
    CREATE TABLE IF NOT EXISTS data_sources (
      id text PRIMARY KEY, name text, owner_id text, type text, config jsonb, is_active boolean,
      deleted_at timestamptz, tenant_id text, workspace_id text, scope_kind text
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id text PRIMARY KEY, user_id text, issued_at timestamptz, expires_at timestamptz,
      last_seen_at timestamptz, revoked_at timestamptz, revoked_by text, revoke_reason text,
      ip_address text, user_agent text, created_at timestamptz, updated_at timestamptz
    );
  `)
  await up(db)
  await continuousUp(db)
  await pool.end()
  const config = JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })
  for (const [id, role] of [[OWNER, 'user'], [OTHER, 'user'], [ADMIN, 'admin']] as const) {
    await query(
      `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set, password_hash)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, true, 'activated', false, true, 'unused')
       ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@example.test`, id, role],
    )
  }
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true), ($1, $3, true)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [OWNER, ORG, TENANT],
  )
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Owned PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, is_active = true, deleted_at = NULL`,
    [SOURCE, OWNER, config],
  )
})

afterEach(async () => {
  revokeStatus = 204
  nativeCalls.length = 0
  setManagedFlowHooksForTests(null)
  setManagedNativeFetchForTests(null)
  enable()
  await resetRows()
})

afterAll(async () => {
  await resetRows()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await down(db)
  await pool.end()
})

describe('continuous completion schema', () => {
  it('freezes mode and the completion hash, and a downgrade that would drop evidence rolls back', async () => {
    const ordinary = await provisionManagedLink(ACTOR, provisionBody())
    const mode = await query<{ continuity_mode: string }>('SELECT continuity_mode FROM plm_managed_identity_links WHERE id = $1', [ordinary.linkId])
    expect(mode.rows[0]?.continuity_mode).toBe('ordinary')
    await expect(provisionManagedLink(ACTOR, { ...provisionBody(), continuityMode: 'day' })).rejects.toMatchObject({ code: 'PLM_MANAGED_BODY_REFUSED' })
    await expect(provisionManagedLink(ACTOR, { ...provisionBody(), extra: true })).rejects.toMatchObject({ code: 'PLM_MANAGED_BODY_REFUSED' })
    await expect(query(
      'UPDATE plm_managed_identity_links SET continuity_mode = $2 WHERE id = $1',
      [ordinary.linkId, 'continuous'],
    )).rejects.toThrow(/plm_managed_link_immutable/)

    const hourRes = responseDouble()
    await provisionManagedLink(ACTOR, provisionBody({ dataSourceId: SOURCE, continuityMode: 'hour' })).catch(() => undefined)
    await resetRows()
    const hour = await provisionManagedLink(ACTOR, provisionBody({ continuityMode: 'hour' }))
    expect((await query<{ continuity_mode: string }>('SELECT continuity_mode FROM plm_managed_identity_links WHERE id = $1', [hour.linkId])).rows[0]?.continuity_mode).toBe('continuous')
    const started = await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, hourRes as never)
    const intentId = hourRes.cookies[MANAGED_INTENT_COOKIE]?.value
    expect(new URL(started.navigationUrl).searchParams.get('continuity_hint')).toBe('hour')
    expect((await query<{ request_mode: string; completion_code_hash: string | null }>(
      'SELECT request_mode, completion_code_hash FROM plm_managed_browser_intents WHERE id = $1',
      [intentId],
    )).rows[0]).toEqual({ request_mode: 'continuous', completion_code_hash: null })
    const firstHash = 'a'.repeat(64)
    const secondHash = 'b'.repeat(64)
    await query('UPDATE plm_managed_browser_intents SET completion_code_hash = $2 WHERE id = $1', [intentId, firstHash])
    await expect(query('UPDATE plm_managed_browser_intents SET completion_code_hash = $2 WHERE id = $1', [intentId, secondHash])).rejects.toThrow(/plm_managed_intent_completion_hash_immutable/)
    await expect(query('UPDATE plm_managed_browser_intents SET completion_code_hash = NULL WHERE id = $1', [intentId])).rejects.toThrow(/plm_managed_intent_completion_hash_immutable/)
    await expect(query(
      `UPDATE plm_managed_browser_intents
       SET completion_code_hash = $2, status = 'consumed'
       WHERE id = $1`,
      [intentId, secondHash],
    )).rejects.toThrow(/plm_managed_intent_completion_hash_/)
    await expect(query('UPDATE plm_managed_browser_intents SET request_mode = $2 WHERE id = $1', [intentId, 'ordinary'])).rejects.toThrow(/plm_managed_intent_immutable/)
    await query(`UPDATE plm_managed_browser_intents SET status = 'consumed', consumed_at = now() WHERE id = $1`, [intentId])
    await expect(query('UPDATE plm_managed_browser_intents SET completion_code_hash = $2 WHERE id = $1', [intentId, secondHash])).rejects.toThrow(/plm_managed_intent_completion_hash_/)
    const refusedRes = responseDouble()
    await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, refusedRes as never)
    const refusedIntent = refusedRes.cookies[MANAGED_INTENT_COOKIE]?.value
    expect(refusedIntent).toBeTruthy()
    await query(`UPDATE plm_managed_browser_intents SET status = 'refused' WHERE id = $1 AND status = 'pending'`, [refusedIntent])
    expect((await query(
      `SELECT 1 FROM plm_managed_browser_intents WHERE id = $1 AND status = 'consumed' AND delegation_id IS NULL`,
      [refusedIntent],
    )).rows).toHaveLength(0)
    await expect(query(`UPDATE plm_managed_browser_intents SET delegation_id = 'del-refused' WHERE id = $1`, [refusedIntent])).rejects.toThrow(/plm_managed_intents_refused_shape_check/)
    await expect(query(`UPDATE plm_managed_browser_intents SET status = 'pending' WHERE id = $1`, [refusedIntent])).rejects.toThrow(/plm_managed_intent_status_terminal/)
    await expect(query(
      `INSERT INTO plm_managed_sessions (
         id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
         scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
         root_part_id, client_origin, installation_issuer, client_id, created_at, credential_generation
       ) VALUES (
         'session-range', $1, $2, $3, $4, 'del-range', 'enc:yur_range', now() + interval '60 seconds',
         'bom_review_read', '42', 'default', 'fixture-org', $5, $6, $7, 'part', $8, $9, 'managed-fixture', now(), 8
       )`,
      [refusedIntent, hour.linkId, SOURCE, hour.generation, OWNER, TENANT, ORG, ORIGIN, ISSUER],
    )).rejects.toThrow(/plm_managed_sessions_credential_generation_check/)

    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    try {
      await expect(continuousDown(db)).rejects.toThrow(/plm_managed_continuous_evidence_present/)
      expect(await columnExists('plm_managed_identity_links', 'continuity_mode')).toBe(true)
      expect(await columnExists('plm_managed_browser_intents', 'completion_code_hash')).toBe(true)
      expect(await columnExists('plm_managed_sessions', 'credential_generation')).toBe(true)
      const guard = await intentGuard()
      expect(guard).toContain('plm_managed_intent_completion_hash_immutable')
      expect(guard).toContain('plm_managed_intent_status_terminal')
      expect(guard).toContain('plm_managed_intent_delegation_immutable')
      await expect(query('UPDATE plm_managed_identity_links SET generation = generation + 1 WHERE id = $1', [hour.linkId])).rejects.toThrow(/plm_managed_link_immutable/)

      await query('DELETE FROM plm_managed_revoke_outbox')
      await query('DELETE FROM plm_managed_sessions')
      await query('DELETE FROM plm_managed_browser_intents')
      await expect(query(`UPDATE plm_managed_identity_links SET continuity_mode = 'ordinary'`)).rejects.toThrow(/plm_managed_link_immutable/)
      await query('DELETE FROM plm_managed_source_bindings')
      await query('DELETE FROM plm_managed_identity_links')
      const kept = await provisionManagedLink(ACTOR, provisionBody())
      await continuousDown(db)
      expect(await columnExists('plm_managed_identity_links', 'continuity_mode')).toBe(false)
      expect(await columnExists('plm_managed_browser_intents', 'request_mode')).toBe(false)
      expect(await columnExists('plm_managed_sessions', 'credential_generation')).toBe(false)
      expect((await query('SELECT id FROM plm_managed_identity_links WHERE id = $1', [kept.linkId])).rows).toHaveLength(1)
      expect(await intentGuard()).not.toContain('plm_managed_intent_completion_hash_immutable')
      expect(await intentGuard()).toContain('plm_managed_intent_status_terminal')
      await expect(query('UPDATE plm_managed_identity_links SET generation = generation + 1 WHERE id = $1', [kept.linkId])).rejects.toThrow(/plm_managed_link_immutable/)
    } finally {
      if (!await columnExists('plm_managed_identity_links', 'continuity_mode')) await continuousUp(db)
      await pool.end()
    }
  })

  it('waits for an open continuous insert, then refuses downgrade without dropping evidence', async () => {
    const writer = new Client({ connectionString: pgUrl, application_name: 'plm-continuous-evidence-writer' })
    const downPool = new Pool({ connectionString: pgUrl, max: 1, application_name: 'plm-continuous-downgrade' })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: downPool }) })
    const linkId = 'link-open-continuous-evidence'
    let writerOpen = false
    let committed = false
    let bodyError: unknown = null
    let downResult: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null
    try {
      await writer.connect()
      writerOpen = true
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO plm_managed_identity_links (
           id, installation_issuer, native_auth_user_id, native_tenant_id, native_org_id, client_id, callback,
           meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id, client_origin, generation,
           status, owner_user_id, created_by, source_fingerprint, continuity_mode
         ) VALUES (
           $1, $2, '42', 'default', 'fixture-org', 'managed-fixture', $3,
           $4, $5, $6, $7, 'part', $8, 1,
           'active', $4, $4, $9, 'continuous'
         )`,
        [linkId, ISSUER, CALLBACK, OWNER, TENANT, ORG, SOURCE, ORIGIN, 'a'.repeat(64)],
      )
      // Count on another connection before down starts. A SELECT of this table
      // after AccessExclusiveLock is queued takes ACCESS SHARE and waits behind
      // that DDL, so the writer COMMIT would never run.
      expect((await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plm_managed_identity_links WHERE continuity_mode IS DISTINCT FROM 'ordinary'`,
      )).rows[0]?.n).toBe(0)
      downResult = continuousDown(db).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      let waiting: { query: string } | null = null
      let seen: Array<{ query: string; wait_event_type: string | null }> = []
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const activity = await query<{ query: string; wait_event_type: string | null }>(
          `SELECT query, wait_event_type
           FROM pg_stat_activity
           WHERE application_name = 'plm-continuous-downgrade' AND state = 'active'`,
        )
        seen = activity.rows
        const row = activity.rows.find((item) => item.wait_event_type === 'Lock' && /LOCK TABLE/i.test(item.query))
        if (row) {
          waiting = row
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      expect(waiting, JSON.stringify(seen)).not.toBeNull()
      expect(waiting?.query ?? '').toMatch(/LOCK TABLE\s+plm_managed_identity_links\s+IN ACCESS EXCLUSIVE MODE/i)
      expect(waiting?.query ?? '').not.toMatch(/ALTER TABLE/i)
      expect(waiting?.query ?? '').not.toMatch(/plm_managed_continuous_evidence_present/)
      const blocked = await query<{ relname: string; mode: string }>(
        `SELECT relation.relname, lock.mode
         FROM pg_locks lock
         JOIN pg_class relation ON relation.oid = lock.relation
         JOIN pg_stat_activity activity ON activity.pid = lock.pid
         WHERE activity.application_name = 'plm-continuous-downgrade'
           AND lock.locktype = 'relation'
           AND NOT lock.granted
         ORDER BY relation.relname, lock.mode`,
      )
      expect(blocked.rows).toEqual([{ relname: 'plm_managed_identity_links', mode: 'AccessExclusiveLock' }])
      // While that lock is queued, the only reads are pg_stat_activity and pg_locks.
      await writer.query('COMMIT')
      committed = true
      const outcome = await downResult
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        expect(message).toMatch(/plm_managed_continuous_evidence_present/)
      }
      expect(await columnExists('plm_managed_identity_links', 'continuity_mode')).toBe(true)
      expect(await columnExists('plm_managed_browser_intents', 'request_mode')).toBe(true)
      expect(await columnExists('plm_managed_browser_intents', 'completion_code_hash')).toBe(true)
      expect(await columnExists('plm_managed_sessions', 'credential_generation')).toBe(true)
      const guard = await intentGuard()
      expect(guard).toContain('plm_managed_intent_completion_hash_immutable')
      expect(guard).toContain('plm_managed_intent_status_terminal')
      expect(guard).toContain('plm_managed_intent_delegation_immutable')
      const linkGuard = await query<{ def: string }>(
        `SELECT pg_get_functiondef('public.plm_managed_identity_links_guard()'::regprocedure) AS def`,
      )
      expect(linkGuard.rows[0]?.def ?? '').toContain('continuity_mode')
      expect(linkGuard.rows[0]?.def ?? '').toContain('plm_managed_link_immutable')
      const names = await query<{ conname: string }>(
        `SELECT con.conname
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE nsp.nspname = 'public'
           AND con.conname IN (
             'plm_managed_links_continuity_mode_check',
             'plm_managed_intents_refused_shape_check',
             'plm_managed_intents_status_check',
             'plm_managed_sessions_credential_generation_check'
           )
         ORDER BY con.conname`,
      )
      expect(names.rows.map((row) => row.conname)).toEqual([
        'plm_managed_intents_refused_shape_check',
        'plm_managed_intents_status_check',
        'plm_managed_links_continuity_mode_check',
        'plm_managed_sessions_credential_generation_check',
      ])
      expect((await query<{ continuity_mode: string }>(
        'SELECT continuity_mode FROM plm_managed_identity_links WHERE id = $1',
        [linkId],
      )).rows).toEqual([{ continuity_mode: 'continuous' }])
    } catch (error) {
      bodyError = error
    } finally {
      let cleanupError: unknown = null
      try {
        await settleDowngradeRace({ writer, writerOpen, committed, downResult, downPool, db })
      } catch (error) {
        cleanupError = error
      }
      if (bodyError && cleanupError) {
        const bodyText = bodyError instanceof Error ? bodyError.message : String(bodyError)
        const cleanupText = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        throw new Error(`${bodyText}; ${cleanupText}`)
      }
      if (cleanupError) throw cleanupError
      if (bodyError) throw bodyError
    }
  })
})

describe('continuous initial completion', () => {
  it('keeps an ordinary completion on exchange and leaves the recovery columns empty', async () => {
    installContinuous((href) => {
      if (href.endsWith('/exchange')) {
        return Response.json({
          subject: '42', tenant_id: 'default', org_id: 'fixture-org', client_id: 'managed-fixture', issuer: ISSUER,
          scope: 'bom_review_read', delegation_id: 'del-ordinary', expires_in: 300, credential: 'yur_synthetic-read',
          root_part_id: 'part', client_origin: ORIGIN,
        })
      }
      return new Response('missing', { status: 404 })
    })
    const created = await provisionManagedLink(ACTOR, provisionBody())
    const res = responseDouble()
    const started = await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, res as never)
    const navigation = new URL(started.navigationUrl)
    expect([...navigation.searchParams.keys()]).toHaveLength(10)
    expect(navigation.searchParams.has('continuity_hint')).toBe(false)
    const done = await finish({ res, state: navigation.searchParams.get('state') ?? '' })
    expect(done.statusCode).toBe(200)
    expect(done.cookies[MANAGED_SESSION_COOKIE]).toBeTruthy()
    expect(nativeCalls.map((call) => call.url).some((url) => url.endsWith('/exchange-continuous'))).toBe(false)
    expect(nativeCalls.map((call) => call.url).some((url) => url.endsWith('/exchange'))).toBe(true)
    const intent = await query<{ completion_code_hash: string | null; request_mode: string }>(
      'SELECT completion_code_hash, request_mode FROM plm_managed_browser_intents',
    )
    expect(intent.rows[0]).toEqual({ completion_code_hash: null, request_mode: 'ordinary' })
    const session = await query<{ credential_generation: number | null; generation: number }>(
      'SELECT credential_generation, generation FROM plm_managed_sessions',
    )
    expect(session.rows[0]?.credential_generation).toBeNull()
    expect(session.rows[0]?.generation).toBe(created.generation)
    const browser = responseDouble()
    await expect(startManagedBrowserLogin({
      headers: { origin: ORIGIN, 'x-metasheet-managed-bridge': 'browser-start' },
      body: {
        issuer: ISSUER, nativeTenantId: 'default', nativeOrgId: 'fixture-org', clientId: 'managed-fixture',
        rootPartId: 'part', nativeSubjectHint: '42', continuityMode: 'hour',
      },
    } as never, browser as never)).rejects.toMatchObject({ code: 'PLM_MANAGED_BODY_REFUSED' })
  })

  it('stores absolute exp, retries the same code, and does not compare ciphertext', async () => {
    const exp = Math.floor(Date.now() / 1000) + 180
    const spec: CredentialSpec = { jti: 'jti-fixed', exp, delegationId: 'del-fixed', expiresIn: 30 }
    let calls = 0
    installContinuous(async (href) => {
      if (!href.endsWith('/exchange-continuous')) return new Response('missing', { status: 404 })
      calls += 1
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1500))
      return Response.json(continuousJson(spec))
    })
    const started = await beginContinuous()
    expect(started.navigation.searchParams.get('continuity_hint')).toBe('hour')
    expect([...started.navigation.searchParams.keys()].filter((key) => key !== 'continuity_hint')).toHaveLength(10)
    const browser = responseDouble()
    const browserStart = await startManagedBrowserLogin({
      headers: { origin: ORIGIN, 'x-metasheet-managed-bridge': 'browser-start' },
      body: {
        issuer: ISSUER, nativeTenantId: 'default', nativeOrgId: 'fixture-org', clientId: 'managed-fixture',
        rootPartId: 'part', nativeSubjectHint: '42',
      },
    } as never, browser as never)
    expect(new URL(browserStart.navigationUrl).searchParams.get('continuity_hint')).toBe('hour')
    expect(Object.keys((browserStart as { navigationUrl: string }).navigationUrl ? {
      issuer: ISSUER,
    } : {})).not.toContain('continuityMode')

    const first = await finish(started)
    expect(first.statusCode).toBe(200)
    expect(first.cookies[MANAGED_SESSION_COOKIE]?.value).toBeTruthy()
    expect(first.cleared).toEqual(expect.arrayContaining([MANAGED_INTENT_COOKIE, MANAGED_NONCE_COOKIE]))
    const stored = await query<{
      id: string
      generation: number
      credential_generation: number
      expires_at: Date
      created_at: Date
      credential_ciphertext: string
      delegation_id: string
    }>('SELECT id, generation, credential_generation, expires_at, created_at, credential_ciphertext, delegation_id FROM plm_managed_sessions')
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]?.credential_generation).toBe(0)
    expect(stored.rows[0]?.generation).toBe(started.created.generation)
    expect(epoch(stored.rows[0]?.expires_at)).toBe(exp)
    expect(epoch(stored.rows[0]?.expires_at) - epoch(stored.rows[0]?.created_at)).toBeGreaterThan(60)
    expect(first.cookies[MANAGED_SESSION_COOKIE]?.options.maxAge).not.toBe(30_000)
    const decoded = jwt.decode(first.cookies[MANAGED_SESSION_COOKIE]?.value ?? '') as { sid?: string; exp?: number }
    expect(decoded.sid).toBe(stored.rows[0]?.id)
    expect(decoded.exp).toBe(exp)
    const opened = openCredential(stored.rows[0]?.credential_ciphertext ?? '')
    expect(sealCredential(opened)).not.toBe(stored.rows[0]?.credential_ciphertext)
    const hash = await query<{ completion_code_hash: string; status: string }>(
      `SELECT completion_code_hash, status FROM plm_managed_browser_intents WHERE status = 'consumed'`,
    )
    expect(hash.rows).toHaveLength(1)
    expect(hash.rows[0]?.status).toBe('consumed')
    expect(hash.rows[0]?.completion_code_hash).toMatch(/^[0-9a-f]{64}$/)

    const replay = await finish(started)
    expect(replay.statusCode).toBe(200)
    expect(replay.cookies[MANAGED_SESSION_COOKIE]?.value).toBeTruthy()
    const after = await query<{ id: string; expires_at: Date; credential_ciphertext: string }>(
      'SELECT id, expires_at, credential_ciphertext FROM plm_managed_sessions',
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.id).toBe(stored.rows[0]?.id)
    expect(after.rows[0]?.credential_ciphertext).toBe(stored.rows[0]?.credential_ciphertext)
    expect(epoch(after.rows[0]?.expires_at)).toBe(exp)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange-continuous'))).toHaveLength(2)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
  })

  it('keeps the pending hash across transport loss and local rollback, then commits once', async () => {
    const spec = defaultSpec()
    installContinuous((href) => {
      if (href.endsWith('/exchange-continuous')) return Response.json(continuousJson(spec))
      return new Response('missing', { status: 404 })
    })
    const unavailable = await beginContinuous()
    installContinuous((href) => {
      if (href.endsWith('/exchange-continuous')) return new Response('down', { status: 503 })
      return new Response('missing', { status: 404 })
    })
    const waiting = await finish(unavailable)
    expect(waiting.statusCode).toBe(503)
    expect(waiting.cleared).not.toContain(MANAGED_INTENT_COOKIE)
    expect(waiting.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    const pending = await query<{ status: string; completion_code_hash: string | null }>('SELECT status, completion_code_hash FROM plm_managed_browser_intents')
    expect(pending.rows[0]?.status).toBe('pending')
    expect(pending.rows[0]?.completion_code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)

    installContinuous((href) => {
      if (!href.endsWith('/exchange-continuous')) return new Response('missing', { status: 404 })
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    const timedOut = await finish(unavailable)
    expect(timedOut.statusCode).toBe(503)
    expect(timedOut.cleared).not.toContain(MANAGED_INTENT_COOKIE)
    expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status).toBe('pending')

    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson(spec))
      : new Response('missing', { status: 404 }))
    setManagedFlowHooksForTests({ loseExchangeResponse: true })
    const lost = await finish(unavailable)
    expect(lost.statusCode).toBe(503)
    expect(lost.cleared).not.toContain(MANAGED_NONCE_COOKIE)
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    setManagedFlowHooksForTests({ failSessionInsert: true })
    const rolled = await finish(unavailable)
    expect(rolled.statusCode).toBe(503)
    expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status).toBe('pending')
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    setManagedFlowHooksForTests(null)
    const committed = await finish(unavailable)
    expect(committed.statusCode).toBe(200)
    expect((await query('SELECT credential_generation FROM plm_managed_sessions')).rows).toEqual([{ credential_generation: 0 }])
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
  })

  it('refuses a different code, a terminal 401, and the wrong generation without a cookie', async () => {
    const spec = defaultSpec()
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson(spec))
      : new Response('missing', { status: 404 }))
    const started = await beginContinuous()
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? new Response('no', { status: 401 })
      : new Response('missing', { status: 404 }))
    const denied = await finish(started)
    expect(denied.statusCode).toBe(401)
    expect(denied.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect(denied.cleared).toEqual(expect.arrayContaining([MANAGED_INTENT_COOKIE, MANAGED_NONCE_COOKIE]))
    expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status).toBe('refused')
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)

    await resetRows()
    nativeCalls.length = 0
    const wrong = await beginContinuous()
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? new Response('down', { status: 503 })
      : new Response('missing', { status: 404 }))
    const wrongHash = await finish(wrong, 'first-code')
    expect(wrongHash.statusCode).toBe(503)
    expect(wrongHash.cleared).not.toContain(MANAGED_INTENT_COOKIE)
    const other = await finish(wrong, 'other-code')
    expect(other.statusCode).toBe(401)
    expect(other.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange-continuous'))).toHaveLength(1)
    expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status).toBe('refused')

    await resetRows()
    nativeCalls.length = 0
    const mode = await beginContinuous()
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson({ ...defaultSpec(), generationIndex: 1, delegationId: 'del-wrong-mode' }))
      : new Response('missing', { status: 404 }))
    const badMode = await finish(mode)
    expect(badMode.statusCode).toBe(403)
    expect(badMode.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows.map((row) => row.delegation_id)).toEqual(['del-wrong-mode'])
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson({ ...defaultSpec(), omitGeneration: true }))
      : new Response('missing', { status: 404 }))
    await resetRows()
    const hidden = await beginContinuous()
    const hiddenGeneration = await finish(hidden)
    expect(hiddenGeneration.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)
  })

  it('rejects a changed tenant, org, subject, root, or source and a native denial after commit', async () => {
    const cases: Array<{ name: string; spec: Partial<CredentialSpec> }> = [
      { name: 'tenant', spec: { tenantId: 'other-tenant', delegationId: 'del-tenant' } },
      { name: 'org', spec: { orgId: 'other-org', delegationId: 'del-org' } },
      { name: 'subject', spec: { subject: '99', delegationId: 'del-subject' } },
      { name: 'root', spec: { rootPartId: 'other-part', delegationId: 'del-root' } },
      { name: 'origin', spec: { clientOrigin: 'http://127.0.0.1:8', delegationId: 'del-origin' } },
    ]
    for (const item of cases) {
      await resetRows()
      nativeCalls.length = 0
      const spec = { ...defaultSpec(), ...item.spec }
      installContinuous((href) => href.endsWith('/exchange-continuous')
        ? Response.json(continuousJson(spec))
        : new Response('missing', { status: 404 }))
      const done = await finish(await beginContinuous())
      expect(done.cookies[MANAGED_SESSION_COOKIE], item.name).toBeUndefined()
      expect((await query('SELECT id FROM plm_managed_sessions')).rows, item.name).toHaveLength(0)
      expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status, item.name).toBe('refused')
      expect((await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows.map((row) => row.delegation_id), item.name).toEqual([spec.delegationId])
    }

    await resetRows()
    nativeCalls.length = 0
    const started = await beginContinuous()
    await query('UPDATE data_sources SET config = $2::jsonb WHERE id = $1', [SOURCE, JSON.stringify({ connection: { url: 'http://127.0.0.1:8/plm' } })])
    try {
      installContinuous()
      const changed = await finish(started)
      expect(changed.statusCode).toBe(403)
      expect(changed.cleared).not.toContain(MANAGED_INTENT_COOKIE)
      expect(nativeCalls).toHaveLength(0)
      expect((await query<{ status: string; completion_code_hash: string | null }>('SELECT status, completion_code_hash FROM plm_managed_browser_intents')).rows[0]).toEqual({
        status: 'pending',
        completion_code_hash: null,
      })
      expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    } finally {
      await query('UPDATE data_sources SET config = $2::jsonb WHERE id = $1', [SOURCE, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })])
    }

    await resetRows()
    const live = defaultSpec()
    let generation = 0
    installContinuous((href) => {
      if (!href.endsWith('/exchange-continuous')) return new Response('missing', { status: 404 })
      generation += 1
      if (generation > 1) return new Response('revoked', { status: 401 })
      return Response.json(continuousJson(live))
    })
    const committed = await beginContinuous()
    expect((await finish(committed)).statusCode).toBe(200)
    const denied = await finish(committed)
    expect(denied.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query<{ revoked_at: Date | null; delegation_id: string }>('SELECT revoked_at, delegation_id FROM plm_managed_sessions')).rows).toEqual([{
      revoked_at: null,
      delegation_id: live.delegationId,
    }])
    expect((await query('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)

    const mismatch = { ...defaultSpec(), delegationId: 'del-other', jti: 'jti-other', exp: live.exp }
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson(mismatch))
      : new Response('missing', { status: 404 }))
    const diverged = await finish(committed)
    expect(diverged.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_sessions')).rows.map((row) => row.delegation_id)).toEqual([live.delegationId])
    expect((await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows.map((row) => row.delegation_id)).toEqual(['del-other'])
  })

  it('refuses an empty credential, a wrong prefix, a mismatched jti, and an absolute exp outside 1..600 without a session', async () => {
    const now = Math.floor(Date.now() / 1000)
    const cases: Array<{ name: string; spec: CredentialSpec; status: number; code: string }> = [
      { name: 'empty credential', spec: { ...defaultSpec(), delegationId: 'del-empty', credential: '' }, status: 403, code: 'PLM_MANAGED_EXCHANGE_MISMATCH' },
      { name: 'wrong prefix', spec: { ...defaultSpec(), delegationId: 'del-prefix', credential: 'not-yur' }, status: 403, code: 'PLM_MANAGED_EXCHANGE_MISMATCH' },
      { name: 'credential jti', spec: { ...defaultSpec(), delegationId: 'del-jti', credentialJti: 'jti-other' }, status: 403, code: 'PLM_MANAGED_EXCHANGE_MISMATCH' },
      { name: 'expired exp', spec: { ...defaultSpec(), delegationId: 'del-expired', exp: now - 60 }, status: 503, code: 'PLM_MANAGED_SESSION_EXPIRY_REFUSED' },
      { name: 'exp over 600s', spec: { ...defaultSpec(), delegationId: 'del-long', exp: now + 900 }, status: 503, code: 'PLM_MANAGED_SESSION_EXPIRY_REFUSED' },
    ]
    for (const item of cases) {
      await resetRows()
      nativeCalls.length = 0
      installContinuous((href) => href.endsWith('/exchange-continuous')
        ? Response.json(continuousJson(item.spec))
        : new Response('missing', { status: 404 }))
      const done = await finish(await beginContinuous())
      expect(done.statusCode, item.name).toBe(item.status)
      expect(done.payload, item.name).toMatchObject({ ok: false, error: { code: item.code } })
      expect(done.cookies[MANAGED_SESSION_COOKIE], item.name).toBeUndefined()
      expect((await query('SELECT id FROM plm_managed_sessions')).rows, item.name).toHaveLength(0)
      expect((await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')).rows[0]?.status, item.name).toBe('refused')
    }
  })

  it('refuses a committed replay with a changed jti or exp, and a replay after local membership is revoked', async () => {
    const exp = Math.floor(Date.now() / 1000) + 180
    const spec: CredentialSpec = { jti: 'jti-winner', exp, delegationId: 'del-winner', expiresIn: 30 }
    let next = spec
    installContinuous((href) => href.endsWith('/exchange-continuous')
      ? Response.json(continuousJson(next))
      : new Response('missing', { status: 404 }))
    const started = await beginContinuous()
    expect((await finish(started)).statusCode).toBe(200)
    const winner = (await query<{ id: string; credential_ciphertext: string; expires_at: Date; revoked_at: Date | null }>(
      'SELECT id, credential_ciphertext, expires_at, revoked_at FROM plm_managed_sessions',
    )).rows[0]
    expect(winner?.id).toBeTruthy()
    const preserved = async (name: string) => {
      const row = (await query<{ id: string; credential_ciphertext: string; expires_at: Date; revoked_at: Date | null }>(
        'SELECT id, credential_ciphertext, expires_at, revoked_at FROM plm_managed_sessions',
      )).rows
      expect(row, name).toEqual([winner])
      expect(epoch(row[0]?.expires_at), name).toBe(exp)
      expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows, name).toHaveLength(0)
      expect(nativeCalls.filter((call) => call.url.endsWith('/revoke')), name).toHaveLength(0)
    }
    for (const replay of [
      { name: 'changed jti', spec: { ...spec, jti: 'jti-replay' } },
      { name: 'changed exp', spec: { ...spec, exp: exp + 30 } },
    ]) {
      next = replay.spec
      nativeCalls.length = 0
      const denied = await finish(started)
      expect(denied.statusCode, replay.name).toBe(409)
      expect(denied.payload, replay.name).toMatchObject({ ok: false, error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(denied.cookies[MANAGED_SESSION_COOKIE], replay.name).toBeUndefined()
      expect(nativeCalls.filter((call) => call.url.endsWith('/exchange-continuous')), replay.name).toHaveLength(1)
      await preserved(replay.name)
    }
    next = spec
    await query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])
    try {
      nativeCalls.length = 0
      const denied = await finish(started)
      expect(denied.statusCode).toBe(403)
      expect(denied.payload).toMatchObject({ ok: false, error: { code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' } })
      expect(denied.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      expect(nativeCalls.filter((call) => call.url.endsWith('/exchange-continuous'))).toHaveLength(1)
      await preserved('revoked membership')
    } finally {
      await query('UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])
    }
  })

  it('lets two concurrent in-process requests share one code and does not let unlink or the loser revoke the winner', async () => {
    const spec = defaultSpec()
    let arrived = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    installContinuous(async (href) => {
      if (!href.endsWith('/exchange-continuous')) return new Response('missing', { status: 404 })
      arrived += 1
      if (arrived >= 2) release()
      await gate
      return Response.json(continuousJson(spec))
    })
    const started = await beginContinuous()
    const app = express()
    app.use(express.json())
    app.use('/api/plm/managed-login', managedLoginRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const port = (server.address() as { port: number }).port
    const intent = started.res.cookies[MANAGED_INTENT_COOKIE]?.value
    const nonce = started.res.cookies[MANAGED_NONCE_COOKIE]?.value
    const post = () => fetch(`http://127.0.0.1:${port}/api/plm/managed-login/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-metasheet-managed-bridge': 'complete',
        cookie: `${MANAGED_INTENT_COOKIE}=${intent}; ${MANAGED_NONCE_COOKIE}=${nonce}`,
      },
      body: JSON.stringify({ code: 'same-code', state: started.state }),
    })
    try {
      // Two concurrent requests in this one process. Independent OS processes remain a later root check.
      const [left, right] = await Promise.all([post(), post()])
      expect(left.status).toBe(200)
      expect(right.status).toBe(200)
      const cookies = [left, right].map((response) => response.headers.getSetCookie().find((line) => line.startsWith(`${MANAGED_SESSION_COOKIE}=`)) ?? '')
      expect(cookies.every((line) => line.includes(MANAGED_SESSION_COOKIE))).toBe(true)
      const ids = cookies.map((line) => {
        const token = line.slice(`${MANAGED_SESSION_COOKIE}=`.length).split(';')[0]
        return (jwt.decode(token) as { sid?: string } | null)?.sid
      })
      const sessions = await query<{ id: string; delegation_id: string; credential_ciphertext: string }>(
        'SELECT id, delegation_id, credential_ciphertext FROM plm_managed_sessions',
      )
      expect(sessions.rows).toHaveLength(1)
      expect(ids).toEqual([sessions.rows[0]?.id, sessions.rows[0]?.id])
      expect(sessions.rows[0]?.delegation_id).toBe(spec.delegationId)
      expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
      expect(nativeCalls.filter((call) => call.url.endsWith('/exchange-continuous'))).toHaveLength(2)
      expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
    } finally {
      server.close()
    }

    await resetRows()
    nativeCalls.length = 0
    let opened: () => void = () => undefined
    const seen = new Promise<void>((resolve) => { opened = resolve })
    let unblock: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => { unblock = resolve })
    installContinuous(async (href) => {
      if (!href.endsWith('/exchange-continuous')) return new Response('missing', { status: 404 })
      opened()
      await blocked
      return Response.json(continuousJson({ ...defaultSpec(), delegationId: 'del-unlinked' }))
    })
    const racing = await beginContinuous()
    const pending = finish(racing)
    await seen
    await unlinkManagedSource(ACTOR, { dataSourceId: SOURCE })
    unblock()
    const lost = await pending
    expect(lost.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query('SELECT id FROM plm_managed_sessions')).rows).toHaveLength(0)
    expect((await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows.map((row) => row.delegation_id)).toEqual(['del-unlinked'])
    expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
  })
})
