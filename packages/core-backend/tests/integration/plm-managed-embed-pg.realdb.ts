/**
 * Disposable PostgreSQL proof for the configured BOM embed route.
 * Not collected by the default unit run. A skip is a failure.
 * The binding reader override is intentionally unused.
 *
 * Process-local fixtures, labelled and not cross-process acceptance:
 * - native HTTP responses come from setManagedNativeFetchForTests
 * - embed jti consumption uses an in-process Redis double, not a shared Redis
 *
 * The positive path uses a Meta OAuth/iframe origin distinct from the Native
 * installation origin. client_origin is Meta. frozen_origin is Native.
 */
import crypto from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import request from 'supertest'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { getDataSourceManager } from '../../src/routes/data-sources'
import plmEmbedRouter from '../../src/routes/plm-embed'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import { up, down } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up as continuousUp } from '../../src/db/migrations/zzzz20261022010000_plm_managed_continuous_completion'
import { down as renewalDown, up as renewalUp } from '../../src/db/migrations/zzzz20261022020000_plm_managed_renewal_recovery'
import { query } from '../../src/db/pg'
import {
  MANAGED_COMPANION_PURPOSE,
  MANAGED_INTENT_COOKIE,
  MANAGED_NONCE_COOKIE,
  MANAGED_SESSION_COOKIE,
  readSharedTransportAudit,
  resetSharedTransportAudit,
} from '../../src/services/plm-managed-companion'
import {
  completeManagedCallback,
  provisionManagedLink,
  revokeManagedLink,
  startManagedLogin,
  transferManagedLink,
  unlinkManagedSource,
} from '../../src/services/plm-managed-companion-flow'
import { setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'

const redisDouble = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'down' | 'throw',
  keys: new Set<string>(),
}))

vi.mock('../../src/db/redis', () => ({
  getRedisClient: async () => {
    if (redisDouble.mode === 'down') return null
    return {
      set: async (key: string) => {
        if (redisDouble.mode === 'throw') throw new Error('process-local redis double failed')
        if (redisDouble.keys.has(key)) return null
        redisDouble.keys.add(key)
        return 'OK'
      },
    }
  },
  closeRedisClient: async () => {},
}))

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

if (process.env.PLM_MANAGED_COMPANION_PG_REQUIRED === 'true') explicitUrl()

const pgUrl = explicitUrl()
const META_ORIGIN = 'http://127.0.0.1:9'
const NATIVE_ORIGIN = 'http://127.0.0.1:7'
const DECOY = 'http://127.0.0.1:8'
const ISSUER = `${NATIVE_ORIGIN}/installation`
const CALLBACK = `${META_ORIGIN}/api/plm/managed-login/callback`
const SECRET = 'synthetic-client-secret-configured-control'
const OWNER = 'meta-owner'
const OTHER = 'meta-other'
const ADMIN = 'meta-admin'
const TENANT = 'meta-tenant'
const ORG = 'meta-org'
const SOURCE = 'source-1'
const LEGACY = 'embed-legacy'
const AUD = 'metasheet2.embed'
const EMBED_PATH = '/api/plm-embed/bom-review/context'
const ACTOR = { id: OWNER, role: 'user' as const, authenticatedTenantId: TENANT }

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB_B64 = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')

type NativePlan = 'ok' | 'context-down' | 'unlink-during-context' | 'drop-binding-on-status'
let nativePlan: NativePlan = 'ok'
const nativeCalls: string[] = []

type CookieJar = Record<string, { value: string }>

function registrationJson(): string {
  return JSON.stringify([{
    issuer: ISSUER,
    clientId: 'managed-fixture',
    clientSecret: SECRET,
    callback: CALLBACK,
    origin: META_ORIGIN,
    nativeTenantId: 'default',
    nativeOrgId: 'fixture-org',
    nativeBaseUrl: NATIVE_ORIGIN,
  }])
}

function enable() {
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = registrationJson()
}

function mint(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    sub: '42',
    tenant_id: 'default',
    org_id: 'fixture-org',
    part_id: 'part',
    feature_key: 'bom_multitable',
    aud: AUD,
    embed_origin: META_ORIGIN,
    iat: now,
    exp: now + 120,
    jti: `j-${crypto.randomBytes(8).toString('hex')}`,
    typ: 'embed',
    ...overrides,
  }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'embed-1' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url')
  return `${header}.${payload}.${sig}`
}

function contextBody(part = 'part') {
  return {
    projection_contract: 'bom_review_managed.v1',
    feature_key: 'bom_multitable',
    upgrade: { available: false },
    snapshot_at: '2026-10-18T00:00:00.000000Z',
    entitled: true,
    source: { part_id: part, tenant_id: 'default', org_id: 'fixture-org', auth_user_id: '42' },
    context: {
      part: { part_id: part, item_number: 'P', name: 'Parent', state: 'Draft', generation: 1 },
      lines: [{
        bom_line_id: 'line',
        part_id: 'child',
        item_number: 'C',
        name: 'Child',
        state: 'Draft',
        generation: 1,
        quantity: 1,
        uom: 'ea',
        find_num: '10',
        refdes: null,
        level: 1,
        path: ['part', 'child'],
        path_labels: ['Parent', 'Child'],
        source_version: 1,
        source_updated_at: '2026-10-18T00:00:00Z',
        sync_status: 'snapshot',
      }],
      source_version: 1,
      source_updated_at: '2026-10-18T00:00:00Z',
      sync_status: 'snapshot',
      template_key: 'bom_review',
    },
  }
}

function exchangeBody() {
  return {
    subject: '42',
    tenant_id: 'default',
    org_id: 'fixture-org',
    client_id: 'managed-fixture',
    issuer: ISSUER,
    scope: 'bom_review_read',
    delegation_id: 'del-1',
    expires_in: 300,
    credential: 'yur_synthetic-read',
    root_part_id: 'part',
    client_origin: META_ORIGIN,
  }
}

function installNative() {
  setManagedNativeFetchForTests(async (url) => {
    const href = String(url)
    nativeCalls.push(href)
    if (href.endsWith('/exchange')) return Response.json(exchangeBody())
    if (href.endsWith('/status')) {
      if (nativePlan === 'drop-binding-on-status') {
        nativePlan = 'ok'
        await query('DELETE FROM plm_managed_source_bindings')
      }
      return Response.json({ ...exchangeBody(), active: true })
    }
    if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
    if (href.includes('/managed-context')) {
      if (nativePlan === 'unlink-during-context') {
        nativePlan = 'ok'
        await unlinkManagedSource(ACTOR, { dataSourceId: SOURCE })
      }
      if (nativePlan === 'context-down') return new Response('down', { status: 502 })
      const part = decodeURIComponent(String(href.split('/').at(-2)))
      return Response.json(contextBody(part))
    }
    return new Response('missing', { status: 404 })
  })
}

function responseDouble() {
  const cookies: CookieJar = {}
  let statusCode = 200
  const res = {
    cookies,
    get statusCode() { return statusCode },
    headersSent: false,
    cookie(name: string, value: string) {
      cookies[name] = { value }
    },
    clearCookie(name: string) {
      delete cookies[name]
    },
    status(code: number) {
      statusCode = code
      return this
    },
    json() {
      this.headersSent = true
      return this
    },
    redirect(code: number) {
      statusCode = code
      this.headersSent = true
    },
    set() { return this },
  }
  return res
}

function provisionBody() {
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
  }
}

async function resetRows() {
  try {
    await query('DELETE FROM plm_managed_renewal_operations')
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
  }
  await query('DELETE FROM plm_managed_revoke_outbox')
  await query('DELETE FROM plm_managed_sessions')
  await query('DELETE FROM plm_managed_browser_intents')
  await query('DELETE FROM plm_managed_source_bindings')
  await query('DELETE FROM plm_managed_identity_links')
}

async function resetRowsIfPresent() {
  try {
    await resetRows()
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
  }
}

function callbackRequest(res: ReturnType<typeof responseDouble>, state: string) {
  const intent = res.cookies[MANAGED_INTENT_COOKIE]?.value
  const nonce = res.cookies[MANAGED_NONCE_COOKIE]?.value
  return {
    query: { code: 'one-use-code', state },
    headers: { cookie: `${MANAGED_INTENT_COOKIE}=${intent}; ${MANAGED_NONCE_COOKIE}=${nonce}` },
  }
}

async function login(): Promise<{ cookie: string; linkId: string }> {
  installNative()
  const created = await provisionManagedLink(ACTOR, provisionBody())
  const res = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, res as never)
  const state = new URL(started.navigationUrl).searchParams.get('state') ?? ''
  const done = responseDouble()
  await completeManagedCallback(callbackRequest(res, state) as never, done as never)
  const cookie = done.cookies[MANAGED_SESSION_COOKIE]?.value
  if (!cookie || done.statusCode !== 302) throw new Error(`managed login did not issue a session (${done.statusCode})`)
  return { cookie, linkId: created.linkId }
}

function contextCallCount(): number {
  return nativeCalls.filter((href) => href.includes('/managed-context')).length
}

function ordinaryBearer(userId: string): string {
  const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
  return jwt.sign({
    userId,
    email: `${userId}@example.test`,
    role: 'user',
    roles: ['user'],
    perms: ['attendance:read'],
    tenantId: ORG,
  }, secret, { expiresIn: '5m' })
}

let app: express.Express
let sourceSpy: { mockClear: () => void; mock: { calls: unknown[][] } }

function ask(token: string, headers: Record<string, string> = {}) {
  const req = request(app).get(EMBED_PATH).set('X-PLM-Embed-Token', token)
  for (const [key, value] of Object.entries(headers)) req.set(key, value)
  return req
}

function withCookie(cookie: string): Record<string, string> {
  return { Cookie: `${MANAGED_SESSION_COOKIE}=${cookie}` }
}

function assertNoSharedAdapter() {
  expect(sourceSpy.mock.calls).toEqual([])
  expect(readSharedTransportAudit().calls).toBe(0)
}

async function ensureLegacyAdapter() {
  const manager = getDataSourceManager()
  try {
    manager.getDataSource(LEGACY)
  } catch {
    await manager.addDataSource({
      id: LEGACY,
      name: 'Embed legacy',
      type: 'plm',
      connection: { url: '', headers: { 'x-tenant-id': 'default', 'x-org-id': 'org-1' } },
    }, { persist: false })
  }
}

beforeAll(async () => {
  enable()
  const pool = new Pool({ connectionString: pgUrl, max: 2 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await pool.query(`
    DROP TABLE IF EXISTS plm_managed_renewal_operations CASCADE;
    DROP TABLE IF EXISTS plm_managed_revoke_outbox, plm_managed_sessions, plm_managed_browser_intents, plm_managed_source_bindings, plm_managed_identity_links CASCADE;
    DROP FUNCTION IF EXISTS plm_managed_renewal_operations_guard();
    DROP FUNCTION IF EXISTS plm_managed_renewal_commit_guard();
    DROP FUNCTION IF EXISTS plm_managed_identity_links_guard();
    DROP FUNCTION IF EXISTS plm_managed_browser_intents_guard();
    DROP FUNCTION IF EXISTS plm_managed_sessions_guard();
    DROP FUNCTION IF EXISTS plm_managed_source_bindings_guard();
    DROP FUNCTION IF EXISTS plm_managed_revoke_outbox_guard();
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text,
      username text,
      mobile text,
      name text,
      role text,
      permissions jsonb,
      password_hash text,
      is_active boolean,
      must_change_password boolean,
      activation_status text,
      local_password_set boolean,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_orgs (
      user_id text,
      org_id text,
      is_active boolean
    );
    DELETE FROM user_orgs a USING user_orgs b
      WHERE a.ctid > b.ctid AND a.user_id = b.user_id AND a.org_id = b.org_id;
    CREATE UNIQUE INDEX IF NOT EXISTS user_orgs_user_org_uidx ON user_orgs (user_id, org_id);
    CREATE TABLE IF NOT EXISTS data_sources (
      id text PRIMARY KEY,
      name text,
      owner_id text,
      type text,
      config jsonb,
      is_active boolean,
      deleted_at timestamptz,
      tenant_id text,
      workspace_id text,
      scope_kind text
    );
    ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS tenant_id text;
    ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS workspace_id text;
    ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS scope_kind text;
    CREATE TABLE IF NOT EXISTS user_sessions (
      id text PRIMARY KEY,
      user_id text,
      issued_at timestamptz,
      expires_at timestamptz,
      last_seen_at timestamptz,
      revoked_at timestamptz,
      revoked_by text,
      revoke_reason text,
      ip_address text,
      user_agent text,
      created_at timestamptz,
      updated_at timestamptz
    );
  `)
  await up(db)
  await continuousUp(db)
  await renewalUp(db)
  await pool.end()
  const config = JSON.stringify({ connection: { url: `${NATIVE_ORIGIN}/plm` } })
  for (const [id, role] of [[OWNER, 'user'], [OTHER, 'user'], [ADMIN, 'admin']] as const) {
    await query(
      `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set, password_hash)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, true, 'activated', false, true, 'unused')
       ON CONFLICT (id) DO UPDATE SET is_active = true, activation_status = 'activated', must_change_password = false, role = EXCLUDED.role`,
      [id, `${id}@example.test`, id, role],
    )
  }
  await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [[OWNER, OTHER, ADMIN]])
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true), ($1, $3, true), ($4, $5, true)`,
    [OWNER, ORG, TENANT, OTHER, 'meta-org-other'],
  )
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active, deleted_at)
     VALUES ($1, 'Owned PLM', $2, 'plm', $3::jsonb, true, NULL)
     ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, type = 'plm', config = EXCLUDED.config, is_active = true, deleted_at = NULL`,
    [SOURCE, OWNER, config],
  )
  app = express()
  app.use(plmEmbedRouter())
  sourceSpy = vi.spyOn(DataSourceManager.prototype, 'getDataSource')
})

beforeEach(() => {
  enable()
  nativePlan = 'ok'
  nativeCalls.length = 0
  redisDouble.mode = 'ok'
  redisDouble.keys.clear()
  resetSharedTransportAudit()
  sourceSpy.mockClear()
  process.env.YUANTUS_EMBED_PUBLIC_KEY = PUB_B64
  process.env.YUANTUS_EMBED_KEY_ID = 'embed-1'
  process.env.PLM_EMBED_AUDIENCE = AUD
  process.env.PLM_EMBED_ALLOWED_ORIGINS = `${META_ORIGIN},${NATIVE_ORIGIN},${DECOY}`
  process.env.PLM_EMBED_DATA_SOURCE_ID = SOURCE
})

afterEach(async () => {
  nativePlan = 'ok'
  setManagedNativeFetchForTests(null)
  resetSharedTransportAudit()
  enable()
  await resetRowsIfPresent()
})

afterAll(async () => {
  setManagedNativeFetchForTests(null)
  await resetRowsIfPresent()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await renewalDown(db)
  await down(db)
  await pool.end()
  sourceSpy.mockClear()
})

describe('managed embed postgresql', () => {
  it('serves the existing context wire shape from a verified managed cookie and the personal relay', async () => {
    const { cookie } = await login()
    const identity = await query(
      `SELECT l.native_auth_user_id, l.meta_user_id, l.native_tenant_id, l.meta_tenant_id,
              l.native_org_id, l.meta_org_id, l.client_origin, b.frozen_origin
         FROM plm_managed_identity_links l
         JOIN plm_managed_source_bindings b ON b.link_id = l.id`,
    )
    expect(identity.rows[0]).toMatchObject({
      native_auth_user_id: '42',
      meta_user_id: OWNER,
      native_tenant_id: 'default',
      meta_tenant_id: TENANT,
      native_org_id: 'fixture-org',
      meta_org_id: ORG,
      client_origin: META_ORIGIN,
      frozen_origin: NATIVE_ORIGIN,
    })
    expect(OWNER).not.toBe('42')
    expect(TENANT).not.toBe('default')
    expect(ORG).not.toBe('fixture-org')
    expect(META_ORIGIN).not.toBe(NATIVE_ORIGIN)
    sourceSpy.mockClear()
    resetSharedTransportAudit()
    const res = await ask(mint({ sub: '42', jti: 'managed-success' }), withCookie(cookie))
    expect(res.status).toBe(200)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toMatchObject({
      ok: true,
      data: { available: true, entitled: true, part_id: 'part' },
    })
    expect(res.body.data.reason).toBeUndefined()
    expect(res.body.data.context.lines[0].bom_line_id).toBe('line')
    expect(res.body.data.context.part.part_id).toBe('part')
    expect(contextCallCount()).toBe(1)
    assertNoSharedAdapter()
  })

  it('refuses token-only, ordinary bearer, and mixed credentials on a bound source', async () => {
    const { cookie } = await login()
    sourceSpy.mockClear()
    const tokenOnly = await ask(mint())
    expect(tokenOnly.status).toBe(403)
    expect(tokenOnly.body.error.code).toBe('PLM_MANAGED_SESSION_REQUIRED')
    expect(tokenOnly.headers.location).toBeUndefined()
    const bearer = await ask(mint(), { Authorization: `Bearer ${ordinaryBearer(OWNER)}` })
    expect(bearer.status).toBe(403)
    expect(bearer.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    const mixedSame = await ask(mint(), {
      Authorization: `Bearer ${ordinaryBearer(OWNER)}`,
      ...withCookie(cookie),
    })
    expect(mixedSame.status).toBe(403)
    expect(mixedSame.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    const mixedOther = await ask(mint(), {
      Authorization: `Bearer ${ordinaryBearer(OTHER)}`,
      ...withCookie(cookie),
    })
    expect(mixedOther.status).toBe(403)
    expect(mixedOther.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    expect(contextCallCount()).toBe(0)
    expect(redisDouble.keys.size).toBe(0)
    assertNoSharedAdapter()
  })

  it('refuses embed claims that use another native scope or a Meta id as the native subject', async () => {
    const { cookie } = await login()
    sourceSpy.mockClear()
    redisDouble.keys.clear()
    const cases: Array<Record<string, unknown>> = [
      { sub: '77' },
      { sub: OWNER },
      { tenant_id: TENANT },
      { org_id: ORG },
      { tenant_id: 'other-native' },
      { org_id: 'other-native-org' },
      { part_id: 'other-part' },
      { embed_origin: DECOY },
      { embed_origin: NATIVE_ORIGIN },
    ]
    for (const overrides of cases) {
      const res = await ask(mint(overrides), withCookie(cookie))
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('PLM_MANAGED_IDENTITY_REFUSED')
    }
    expect(contextCallCount()).toBe(0)
    expect(redisDouble.keys.size).toBe(0)
    assertNoSharedAdapter()
  })

  it('refuses a revoked session, an expired cookie, an unlinked source, and a transferred source', async () => {
    const revoked = await login()
    await query(`UPDATE plm_managed_sessions SET revoked_at = now() WHERE revoked_at IS NULL`)
    sourceSpy.mockClear()
    const revokedRes = await ask(mint(), withCookie(revoked.cookie))
    expect(revokedRes.status).toBe(401)
    expect(revokedRes.body.error.code).toBe('UNAUTHORIZED')
    expect(revokedRes.headers.location).toBeUndefined()

    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const expired = jwt.sign({
      purpose: MANAGED_COMPANION_PURPOSE,
      userId: OWNER,
      sid: 'expired-session',
      tenantId: TENANT,
      exp: Math.floor(Date.now() / 1000) - 30,
    }, secret)
    const expiredRes = await ask(mint(), withCookie(expired))
    expect(expiredRes.status).toBe(401)
    expect(expiredRes.body.error.code).toBe('UNAUTHORIZED')

    await resetRows()
    nativeCalls.length = 0
    const unlinked = await login()
    await unlinkManagedSource(ACTOR, { dataSourceId: SOURCE })
    const unlinkedRes = await ask(mint(), withCookie(unlinked.cookie))
    expect(unlinkedRes.status).toBe(401)
    expect(unlinkedRes.body.ok).not.toBe(true)

    await resetRows()
    nativeCalls.length = 0
    const transferred = await login()
    await transferManagedLink(ACTOR, transferred.linkId, {})
    const transferredRes = await ask(mint(), withCookie(transferred.cookie))
    expect(transferredRes.status).toBe(401)
    expect(transferredRes.body.ok).not.toBe(true)
    expect(contextCallCount()).toBe(0)
    assertNoSharedAdapter()
  })

  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'a bound source with managed flag %s never uses the shared adapter',
    async (flag) => {
      const { cookie } = await login()
      if (flag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
      else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
      sourceSpy.mockClear()
      redisDouble.keys.clear()
      const res = await ask(mint(), withCookie(cookie))
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('PLM_MANAGED_DISABLED')
      expect(contextCallCount()).toBe(0)
      expect(redisDouble.keys.size).toBe(0)
      assertNoSharedAdapter()
    },
  )

  it('replays and a failed jti store fail closed before the personal read', async () => {
    const { cookie } = await login()
    sourceSpy.mockClear()
    const token = mint({ jti: 'replay-once' })
    const first = await ask(token, withCookie(cookie))
    expect(first.status).toBe(200)
    const second = await ask(token, withCookie(cookie))
    expect(second.status).toBe(401)
    expect(second.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    expect(contextCallCount()).toBe(1)

    redisDouble.mode = 'down'
    const down = await ask(mint({ jti: 'store-down' }), withCookie(cookie))
    expect(down.status).toBe(503)
    expect(down.body.error.code).toBe('EMBED_UNAVAILABLE')
    redisDouble.mode = 'throw'
    const thrown = await ask(mint({ jti: 'store-throw' }), withCookie(cookie))
    expect(thrown.status).toBe(503)
    expect(thrown.body.error.code).toBe('EMBED_UNAVAILABLE')
    expect(contextCallCount()).toBe(1)
    assertNoSharedAdapter()
  })

  it('a native provider failure stays a managed refusal and does not degrade onto the adapter', async () => {
    const { cookie } = await login()
    nativePlan = 'context-down'
    sourceSpy.mockClear()
    const res = await ask(mint(), withCookie(cookie))
    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'PLM_MANAGED_READ_REFUSED', message: 'Managed embed read refused' },
    })
    expect(res.body.data).toBeUndefined()
    assertNoSharedAdapter()
  })

  it('keeps a source that was bound at entry off the adapter when it is unlinked or unbound before publish', async () => {
    const unlinked = await login()
    nativePlan = 'unlink-during-context'
    sourceSpy.mockClear()
    const stopped = await ask(mint(), withCookie(unlinked.cookie))
    expect(stopped.status).toBe(403)
    expect(stopped.body.error.code).toBe('PLM_MANAGED_LINK_STOPPED')
    expect(stopped.body.data).toBeUndefined()
    assertNoSharedAdapter()

    await resetRows()
    nativeCalls.length = 0
    const dropped = await login()
    nativePlan = 'drop-binding-on-status'
    sourceSpy.mockClear()
    resetSharedTransportAudit()
    const legacy = await ask(mint(), withCookie(dropped.cookie))
    expect(legacy.status).toBe(403)
    expect(legacy.body.error.code).toBe('PLM_MANAGED_SHARED_TRANSPORT_REFUSED')
    expect(contextCallCount()).toBe(0)
    assertNoSharedAdapter()
  })

  it('schema-missing and a missing database URL stay closed for a bound source', async () => {
    await provisionManagedLink(ACTOR, provisionBody())
    const savedUrl = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      sourceSpy.mockClear()
      const unavailable = await ask(mint(), withCookie('present'))
      expect(unavailable.status).toBe(403)
      expect(unavailable.body.error.code).toBe('PLM_MANAGED_BINDING_UNAVAILABLE')
      assertNoSharedAdapter()
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = savedUrl
    }

    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    try {
      await resetRows()
      await renewalDown(db)
      await down(db)
      sourceSpy.mockClear()
      resetSharedTransportAudit()
      const missing = await ask(mint())
      expect(missing.status).toBe(403)
      expect(missing.body.error.code).toBe('PLM_MANAGED_SCHEMA_MISSING')
      assertNoSharedAdapter()
    } finally {
      const present = await query('SELECT to_regclass($1) AS name', ['public.plm_managed_identity_links'])
      if (!present.rows[0]?.name) {
        await up(db)
        await continuousUp(db)
      }
      const renewal = await query('SELECT to_regclass($1) AS name', ['public.plm_managed_renewal_operations'])
      if (!renewal.rows[0]?.name) await renewalUp(db)
      await pool.end()
      enable()
    }
  })

  it('a proven unbound source keeps the token-only adapter path for every managed flag and refuses credential conflicts', async () => {
    await ensureLegacyAdapter()
    process.env.PLM_EMBED_DATA_SOURCE_ID = LEGACY
    const flags: Array<string | undefined> = [undefined, '', 'false', 'TRUE', '1', 'true']
    for (const flag of flags) {
      if (flag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
      else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
      sourceSpy.mockClear()
      resetSharedTransportAudit()
      const res = await ask(mint({
        sub: '7',
        tenant_id: 'default',
        org_id: 'org-1',
        part_id: 'P1',
        jti: `legacy-${String(flag)}`,
      }))
      expect(res.status).toBe(200)
      expect(res.body.data.entitled).toBe(true)
      expect(res.body.data.part_id).toBe('P1')
      expect(res.body.data.context.part.part_id).toBe('P1')
      expect(sourceSpy.mock.calls.map((call) => call[0])).toEqual([LEGACY])
      expect(readSharedTransportAudit().calls).toBeGreaterThan(0)
    }
    sourceSpy.mockClear()
    resetSharedTransportAudit()
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    const bearer = await ask(mint({ tenant_id: 'default', org_id: 'org-1', part_id: 'P1' }), {
      Authorization: `Bearer ${ordinaryBearer(OWNER)}`,
    })
    expect(bearer.status).toBe(403)
    expect(bearer.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    const cookie = await ask(mint({ tenant_id: 'default', org_id: 'org-1', part_id: 'P1' }), withCookie('present'))
    expect(cookie.status).toBe(403)
    expect(cookie.body.error.code).toBe('PLM_MANAGED_READ_REFUSED')
    expect(sourceSpy.mock.calls).toEqual([])
    expect(readSharedTransportAudit().calls).toBe(0)
  })
})
