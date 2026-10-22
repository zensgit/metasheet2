/**
 * Disposable PostgreSQL proof for the managed-login consumer.
 * Not collected by the default unit run. A skip is a failure.
 * The binding reader override is intentionally unused.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { authService } from '../../src/auth/AuthService'
import { isGateException } from '../../src/auth/api-path-policy'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import { up, down } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up as continuousUp } from '../../src/db/migrations/zzzz20261022010000_plm_managed_continuous_completion'
import { down as renewalDown, up as renewalUp } from '../../src/db/migrations/zzzz20261022020000_plm_managed_renewal_recovery'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { authRouter } from '../../src/routes/auth'
import managedLoginRouter from '../../src/routes/plm-managed-companion'
import {
  MANAGED_COMPANION_PURPOSE,
  MANAGED_INTENT_COOKIE,
  MANAGED_NONCE_COOKIE,
  MANAGED_SESSION_COOKIE,
  ManagedCompanionRefusal,
  assertLegacySharedTransportAllowed,
  classifyManagedSource,
  enterLegacySharedTransport,
  readSharedTransportAudit,
  resetSharedTransportAudit,
  sourceFingerprint,
} from '../../src/services/plm-managed-companion'
import {
  completeManagedBrowserLogin,
  completeManagedCallback,
  handoffManagedCallback,
  provisionManagedLink,
  readManagedSessionStatus,
  relayManagedBomContext,
  retryManagedRevoke,
  revokeManagedLink,
  startManagedBrowserLogin,
  startManagedLogin,
  transferManagedLink,
  unlinkManagedSource,
  setManagedFixtureClockForTests,
  setManagedFlowHooksForTests,
} from '../../src/services/plm-managed-companion-flow'
import { setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

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
const ownedSocketRunner = fileURLToPath(new URL(
  '../../../../scripts/verification/plm-managed-companion-pg/owned-socket.mjs',
  import.meta.url,
))

interface OwnedSocketProof {
  ok: boolean
  command: string
  nonce: string
  root: string
  data: string
  socket: string
  postgresStopped: boolean
  postgresRunning: boolean
  directoryRemoved: boolean
  locale: string
  markerMatched: boolean
}

function runOwnedSocket(command: 'stop' | 'boot', root: string, nonce: string): OwnedSocketProof {
  const stdout = execFileSync(process.execPath, [
    ownedSocketRunner,
    command,
    '--root',
    root,
    '--nonce',
    nonce,
  ], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  return JSON.parse(stdout) as OwnedSocketProof
}
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

type CookieJar = Record<string, { value: string; options: Record<string, unknown> }>

function registrationJson(): string {
  return JSON.stringify([{
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

function enable() {
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = registrationJson()
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

function exchangeBody(overrides: Record<string, unknown> = {}) {
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
    client_origin: ORIGIN,
    ...overrides,
  }
}

const nativeCalls: Array<{ url: string; body: Record<string, unknown> | null }> = []
let exchangeOverrides: Record<string, unknown> = {}
let revokeStatus = 204
let exchangeStatus = 200
let nativeActive = true

function installNative(advisory?: () => unknown, beforeContext?: () => Promise<void>) {
  setManagedNativeFetchForTests(async (url, init) => {
    const href = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    nativeCalls.push({ url: href, body })
    if (href.endsWith('/exchange')) {
      if (exchangeStatus !== 200) return new Response('refused', { status: exchangeStatus })
      return Response.json(exchangeBody(exchangeOverrides))
    }
    if (href.endsWith('/status')) {
      const issued = exchangeBody(exchangeOverrides)
      const delegation = typeof body?.delegation_id === 'string' ? body.delegation_id : ''
      return Response.json({
        ...issued,
        active: nativeActive,
        subject: delegation === 'del-other' ? '77' : issued.subject,
        delegation_id: delegation || issued.delegation_id,
      })
    }
    if (href.endsWith('/revoke')) return new Response(null, { status: revokeStatus })
    if (href.includes('/managed-context')) {
      if (beforeContext) await beforeContext()
      return Response.json({ ...contextBody(String(href.split('/').at(-2))),
        ...(advisory ? { integration_capabilities: advisory() } : {}) })
    }
    return new Response('missing', { status: 404 })
  })
}

function responseDouble() {
  const cookies: CookieJar = {}
  const cleared: string[] = []
  let statusCode = 200
  let payload: unknown
  let location = ''
  const res = {
    cookies,
    cleared,
    get statusCode() { return statusCode },
    get payload() { return payload },
    get location() { return location },
    headersSent: false,
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
      this.headersSent = true
      return this
    },
    redirect(code: number, url: string) {
      statusCode = code
      location = url
      this.headersSent = true
    },
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

async function beginLogin(root = 'part') {
  const created = await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody({ rootPartId: root }))
  const res = responseDouble()
  const started = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: root }, res as never)
  const navigation = new URL(started.navigationUrl)
  return { created, res, navigation, state: navigation.searchParams.get('state') ?? '' }
}

function browserStartRequest(hint: string, body: Record<string, unknown> = {}) {
  return {
    headers: {
      origin: ORIGIN,
      'x-metasheet-managed-bridge': 'browser-start',
    },
    body: {
      issuer: ISSUER,
      nativeTenantId: 'default',
      nativeOrgId: 'fixture-org',
      clientId: 'managed-fixture',
      rootPartId: 'part',
      nativeSubjectHint: hint,
      ...body,
    },
  }
}

function browserCompleteRequest(res: ReturnType<typeof responseDouble>, state: string, extras: Record<string, unknown> = {}) {
  const intent = res.cookies[MANAGED_INTENT_COOKIE]?.value
  const nonce = res.cookies[MANAGED_NONCE_COOKIE]?.value
  return {
    headers: {
      origin: ORIGIN,
      'x-metasheet-managed-bridge': 'complete',
      cookie: `${MANAGED_INTENT_COOKIE}=${intent}; ${MANAGED_NONCE_COOKIE}=${nonce}`,
      ...(extras.headers as Record<string, string> | undefined),
    },
    body: { code: 'one-use-code', state },
  }
}

async function insertOwnedSource(id: string, owner: string) {
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, $2, $3, 'plm', $4::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, config = EXCLUDED.config, is_active = true, deleted_at = NULL`,
    [id, id, owner, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
  )
}

function callbackRequest(res: ReturnType<typeof responseDouble>, state: string, extras: Record<string, unknown> = {}) {
  const intent = res.cookies[MANAGED_INTENT_COOKIE]?.value
  const nonce = res.cookies[MANAGED_NONCE_COOKIE]?.value
  const extraCookie = typeof extras.cookie === 'string' && extras.cookie.length > 0 ? `; ${extras.cookie}` : ''
  return {
    query: { code: 'one-use-code', state, ...((extras.query as object) ?? {}) },
    headers: {
      cookie: `${MANAGED_INTENT_COOKIE}=${intent}; ${MANAGED_NONCE_COOKIE}=${nonce}${extraCookie}`,
      ...(extras.authorization ? { authorization: extras.authorization } : {}),
    },
  }
}

async function countSessions() {
  const found = await query('SELECT id, revoked_at, credential_ciphertext FROM plm_managed_sessions')
  return found.rows
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
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true), ($3, $4, true), ($1, $5, true)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [OWNER, ORG, OTHER, 'meta-org-other', TENANT],
  )
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Owned PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE, OWNER, config],
  )
})

afterEach(async () => {
  exchangeOverrides = {}
  revokeStatus = 204
  exchangeStatus = 200
  nativeActive = true
  nativeCalls.length = 0
  setManagedFlowHooksForTests(null)
  setManagedNativeFetchForTests(null)
  resetSharedTransportAudit()
  enable()
  await resetRowsIfPresent()
})

afterAll(async () => {
  await resetRows()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await renewalDown(db)
  await down(db)
  await pool.end()
})

describe('managed companion postgresql', () => {
  it('refuses a missing schema with the flag off and allows only a proven empty binding', async () => {
    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    try {
      await resetRows()
      await renewalDown(db)
      await down(db)
      await expect(provisionManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, provisionBody())).rejects.toMatchObject({ code: 'PLM_MANAGED_SCHEMA_MISSING' })
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'schema-missing' })
      process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
      resetSharedTransportAudit()
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'schema-missing' })
      const shared = vi.fn(async () => 'shared credential used')
      await expect(enterLegacySharedTransport(SOURCE, 'schema-missing-flag-off', shared)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_MANAGED_SCHEMA_MISSING',
      })
      expect(shared).not.toHaveBeenCalled()
      expect(readSharedTransportAudit().calls).toBe(0)
      delete process.env.PLM_MANAGED_COMPANION_ENABLED
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'schema-missing' })

      await up(db)
      await continuousUp(db)
      await renewalUp(db)
      process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
      resetSharedTransportAudit()
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'unbound' })
      await expect(enterLegacySharedTransport(SOURCE, 'proven-unbound', async () => 'legacy positive')).resolves.toBe('legacy positive')
      expect(readSharedTransportAudit().calls).toBe(1)
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

  it('does not treat a missing database URL as proof a persisted binding is unbound', async () => {
    await provisionManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, provisionBody())
    const savedUrl = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    delete process.env.PLM_MANAGED_COMPANION_ENABLED
    try {
      resetSharedTransportAudit()
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'unavailable' })
      const shared = vi.fn(async () => 'shared credential used')
      await expect(enterLegacySharedTransport(SOURCE, 'missing-database-url', shared)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_MANAGED_BINDING_UNAVAILABLE',
      })
      expect(shared).not.toHaveBeenCalled()
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = savedUrl
      enable()
    }
    await expect(classifyManagedSource(SOURCE)).resolves.toMatchObject({ kind: 'bound' })
    await resetRows()
  })

  it('refuses shared transport when the owned database is down and the flag is off', async () => {
    await provisionManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, provisionBody())
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
    await expect(classifyManagedSource(SOURCE)).resolves.toMatchObject({ kind: 'bound' })
    const socket = new URL(pgUrl).searchParams.get('host') ?? ''
    const root = path.dirname(socket)
    const data = path.join(path.dirname(socket), 'data')
    const marker = JSON.parse(readFileSync(path.join(root, '.plm-managed-owned'), 'utf8')) as { nonce?: string, kind?: string }
    if (marker.kind !== 'plm-managed-companion-socket' || !marker.nonce) {
      throw new Error('refusing to stop a cluster without the owned socket marker')
    }
    if (root !== path.join('/tmp', 'plm-managed-consumer-pg-' + marker.nonce) || data !== path.join(root, 'data') || socket !== path.join(root, 's')) {
      throw new Error('refusing to stop a cluster whose nonce, data, and socket do not match')
    }
    const internal = poolManager.get().getInternalPool()
    const onError = () => undefined
    internal.on('error', onError)
    let stopped = false
    try {
      const stopProof = runOwnedSocket('stop', root, marker.nonce)
      stopped = stopProof.ok === true && stopProof.postgresStopped === true && stopProof.postgresRunning === false
      if (!stopped || stopProof.directoryRemoved !== false || stopProof.locale !== 'C' || stopProof.markerMatched !== true) {
        throw new Error('owned socket stop did not prove the postmaster stopped')
      }
      if (stopProof.nonce !== marker.nonce || stopProof.root !== root || stopProof.data !== data || stopProof.socket !== socket) {
        throw new Error('owned socket stop proof does not match the nonce, data, and socket')
      }
      resetSharedTransportAudit()
      await expect(classifyManagedSource(SOURCE)).resolves.toEqual({ kind: 'unavailable' })
      const shared = vi.fn(async () => 'shared credential used')
      await expect(enterLegacySharedTransport(SOURCE, 'database-outage', shared)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_MANAGED_BINDING_UNAVAILABLE',
      })
      expect(shared).not.toHaveBeenCalled()
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      if (stopped) {
        const bootProof = runOwnedSocket('boot', root, marker.nonce)
        if (!bootProof.ok || bootProof.postgresRunning !== true || bootProof.postgresStopped !== false || bootProof.directoryRemoved !== false) {
          throw new Error('owned socket boot did not prove the postmaster restarted')
        }
        if (bootProof.locale !== 'C' || bootProof.markerMatched !== true) {
          throw new Error('owned socket boot proof is missing ownership or locale')
        }
        if (bootProof.nonce !== marker.nonce || bootProof.root !== root || bootProof.data !== data || bootProof.socket !== socket) {
          throw new Error('owned socket boot proof does not match the nonce, data, and socket')
        }
      }
      internal.off('error', onError)
      enable()
      let restored = false
      let lastError: unknown
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await query('SELECT 1')
          restored = true
          break
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
      if (!restored) throw lastError
    }
    await expect(classifyManagedSource(SOURCE)).resolves.toMatchObject({ kind: 'bound' })
    await resetRows()
  })

  it('requires an existing owner opt-in and refuses copied or implied identity', async () => {
    await expect(provisionManagedLink({ id: OTHER }, provisionBody({ ownerOptIn: false }))).rejects.toMatchObject({ code: 'PLM_MANAGED_OWNER_OPT_IN_REQUIRED' })
    await expect(provisionManagedLink({ id: OTHER }, provisionBody())).rejects.toMatchObject({ code: 'PLM_MANAGED_ACTOR_REFUSED' })
    await expect(provisionManagedLink({ id: ADMIN, role: 'admin' }, provisionBody({ metaUserId: 'missing-user' }))).rejects.toMatchObject({ code: 'PLM_MANAGED_META_USER_REFUSED' })
    const before = await query('SELECT count(*)::int AS n FROM users')
    await expect(provisionManagedLink(
      { id: ADMIN, role: 'admin' },
      provisionBody({ metaUserId: OTHER, metaOrgId: 'not-a-member-org' }),
    )).rejects.toMatchObject({ code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' })
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [OTHER, ORG],
    )
    await expect(provisionManagedLink(
      { id: ADMIN, role: 'admin', authenticatedTenantId: ORG },
      provisionBody({ nativeAuthUserId: '42', metaUserId: OTHER, metaTenantId: ORG }),
    )).rejects.toMatchObject({ code: 'PLM_MANAGED_SOURCE_REFUSED' })
    await query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [OTHER, ORG])
    const after = await query('SELECT count(*)::int AS n FROM users')
    expect(after.rows[0].n).toBe(before.rows[0].n)
    const created = await provisionManagedLink({ id: ADMIN, role: 'admin', authenticatedTenantId: TENANT }, provisionBody())
    expect(created.generation).toBe(1)
    await query(
      `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
       VALUES ('source-900', 'Owned PLM 900', $1, 'plm', $2::jsonb, true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
    )
    await expect(provisionManagedLink(
      { id: OWNER, authenticatedTenantId: TENANT },
      provisionBody({ nativeAuthUserId: '900', dataSourceId: 'source-900' }),
    )).resolves.toMatchObject({ generation: 1 })
    const rows = await query('SELECT native_auth_user_id, meta_tenant_id, meta_org_id FROM plm_managed_identity_links ORDER BY native_auth_user_id')
    expect(rows.rows.map((row) => row.native_auth_user_id)).toEqual(['42', '900'])
    expect(rows.rows[0].meta_tenant_id).toBe(TENANT)
    expect(rows.rows[0].meta_org_id).toBe(ORG)
    expect(TENANT).not.toBe(ORG)
    await resetRows()
  })

  it('stores a hashed browser intent and compares the frozen root before a local session', async () => {
    installNative()
    const { res, navigation, state } = await beginLogin()
    expect(navigation.origin + navigation.pathname).toBe(`${ORIGIN}/managed-login`)
    expect(navigation.search).not.toMatch(/clientSecret|code_verifier|yur_/)
    const intentCookie = res.cookies[MANAGED_INTENT_COOKIE]
    const nonceCookie = res.cookies[MANAGED_NONCE_COOKIE]
    expect(intentCookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' })
    expect(nonceCookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax' })
    const stored = await query('SELECT state_hash, code_verifier_ciphertext, return_path FROM plm_managed_browser_intents')
    expect(stored.rows[0].state_hash).toHaveLength(64)
    expect(String(stored.rows[0].code_verifier_ciphertext).startsWith('enc:')).toBe(true)
    expect(stored.rows[0].return_path).toBe('/plm/bom-review')
    expect(JSON.stringify(stored.rows)).not.toContain(state)

    const wrong = responseDouble()
    await expect(completeManagedCallback({
      ...callbackRequest(res, 'wrong-state'),
    } as never, wrong as never)).rejects.toMatchObject({ code: 'PLM_MANAGED_BROWSER_MISMATCH' })
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    expect((await query("SELECT status FROM plm_managed_browser_intents")).rows[0].status).toBe('pending')

    exchangeOverrides = { root_part_id: 'other-part' }
    const mismatched = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, mismatched as never)
    expect(mismatched.statusCode).toBe(302)
    expect(mismatched.location).toContain('managed=refused')
    expect(mismatched.location).not.toContain('one-use-code')
    expect(mismatched.location).not.toContain('yur_')
    expect(await countSessions()).toHaveLength(0)
    expect(nativeCalls.some((call) => call.url.endsWith('/revoke'))).toBe(true)
    await resetRows()
  })

  it('creates one session from a matching exchange and reads with the stored credential', async () => {
    installNative()
    const { res, state } = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, done as never)
    expect(done.statusCode).toBe(302)
    expect(done.location).toContain('managed=ready')
    expect(done.location).not.toContain('code=')
    const sessionCookie = done.cookies[MANAGED_SESSION_COOKIE]
    expect(sessionCookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax' })
    const payload = jwt.decode(sessionCookie.value) as { purpose?: string; tenantId?: string }
    expect(payload.purpose).toBe(MANAGED_COMPANION_PURPOSE)
    expect(payload.tenantId).toBe(TENANT)
    expect(sessionCookie.value).not.toContain('yur_')
    const sessions = await countSessions()
    expect(sessions).toHaveLength(1)
    expect(String(sessions[0].credential_ciphertext).startsWith('enc:')).toBe(true)
    const exchange = nativeCalls.find((call) => call.url.endsWith('/exchange'))
    expect(exchange?.body).toMatchObject({ client_id: 'managed-fixture', callback: CALLBACK })
    expect(JSON.stringify(exchange?.body)).not.toContain('root_part_id')

    resetSharedTransportAudit()
    const relay = await managedRequestContext.run(
      { userId: OWNER, sessionId: String(sessions[0].id), conflict: false },
      () => relayManagedBomContext({ userId: OWNER, dataSourceId: SOURCE, partId: 'part' }),
    )
    expect(relay).toMatchObject({ kind: 'ok', entitled: true })
    if (relay.kind === 'ok') {
      const context = relay.context as { lines: Array<{ bom_line_id: string }> }
      expect(context.lines[0].bom_line_id).toBe('line')
    }
    expect(nativeCalls.some((call) => call.url.includes('/managed-context'))).toBe(true)
    const readCall = nativeCalls.find((call) => call.url.includes('/managed-context'))
    expect(JSON.stringify(readCall)).not.toContain('yur_synthetic-read')
    expect(readSharedTransportAudit().calls).toBe(0)
    await expect(assertLegacySharedTransportAllowed(SOURCE)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    expect(readSharedTransportAudit().calls).toBe(0)

    const app = express()
    app.get('/bom', jwtAuthMiddleware, async (req, res) => {
      const result = await relayManagedBomContext({
        userId: req.user?.id,
        dataSourceId: SOURCE,
        partId: 'part',
      })
      res.json(result)
    })
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const port = (server.address() as { port: number }).port
    const httpRead = await fetch(`http://127.0.0.1:${port}/bom`, {
      headers: { cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie.value}` },
    })
    const httpBody = await httpRead.json() as { kind: string }
    expect(httpBody.kind).toBe('ok')
    server.close()

    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const other = jwt.sign({
      userId: OTHER,
      email: 'other@example.test',
      role: 'admin',
      roles: ['admin'],
      perms: ['*:*'],
      tenantId: ORG,
    }, secret, { expiresIn: '5m' })
    process.env.RBAC_TOKEN_TRUST = 'true'
    const conflictApp = express()
    conflictApp.get('/bom', jwtAuthMiddleware, async (req, res) => {
      res.json(await relayManagedBomContext({ userId: req.user?.id, dataSourceId: SOURCE, partId: 'part' }))
    })
    const conflictServer = await new Promise<Server>((resolve) => {
      const listening = conflictApp.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const conflictPort = (conflictServer.address() as { port: number }).port
    const conflict = await fetch(`http://127.0.0.1:${conflictPort}/bom`, {
      headers: {
        authorization: `Bearer ${other}`,
        cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie.value}`,
      },
    })
    expect((await conflict.json() as { code: string }).code).toBe('PLM_MANAGED_SESSION_REQUIRED')
    conflictServer.close()
    delete process.env.RBAC_TOKEN_TRUST

    const repeat = responseDouble()
    await expect(completeManagedCallback(callbackRequest(res, state) as never, repeat as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_INTENT_CONSUMED',
    })
    expect(await countSessions()).toHaveLength(1)
    await resetRows()
  })

  it('does not replace another signed-in person or launder a managed token', async () => {
    installNative()
    const { res, state, created } = await beginLogin()
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    process.env.RBAC_TOKEN_TRUST = 'true'
    const other = jwt.sign({
      userId: OTHER, email: 'other@example.test', role: 'admin', roles: ['admin'], perms: ['*:*'], tenantId: ORG,
    }, secret, { expiresIn: '5m' })
    const conflict = responseDouble()
    await completeManagedCallback(
      callbackRequest(res, state, { authorization: `Bearer ${other}` }) as never,
      conflict as never,
    )
    expect(conflict.statusCode).toBe(409)
    expect(JSON.stringify(conflict.payload)).toContain('PLM_MANAGED_PERSON_CONFLICT')
    expect(conflict.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    expect((await query('SELECT status FROM plm_managed_browser_intents')).rows[0].status).toBe('pending')

    const freshRes = responseDouble()
    const restarted = await startManagedLogin(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE, rootPartId: 'part' },
      freshRes as never,
    )
    const freshState = new URL(restarted.navigationUrl).searchParams.get('state') ?? ''
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(freshRes, freshState) as never, done as never)
    const token = done.cookies[MANAGED_SESSION_COOKIE].value
    const normal = jwt.sign({
      userId: OWNER, email: 'owner@example.test', role: 'user', roles: ['user'], perms: ['attendance:read'], tenantId: ORG,
    }, secret, { expiresIn: '5m' })
    expect((await authService.verifyToken(normal))?.id).toBe(OWNER)
    const managedUser = await authService.verifyToken(token)
    expect(managedUser?.id).toBe(OWNER)
    expect((managedUser as { managedPurpose?: string }).managedPurpose).toBe(MANAGED_COMPANION_PURPOSE)
    const getUser = vi.spyOn(authService as unknown as { getUserById: (id: string) => Promise<unknown> }, 'getUserById')
    expect(await authService.refreshToken(token)).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
    getUser.mockRestore()

    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const port = (server.address() as { port: number }).port
    const orgSwitch = await fetch(`http://127.0.0.1:${port}/api/auth/session-org`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG }),
    })
    expect(orgSwitch.status).toBe(403)
    expect(await orgSwitch.json()).toMatchObject({ code: 'MANAGED_SESSION_REISSUE_REJECTED' })
    const normalSwitch = await fetch(`http://127.0.0.1:${port}/api/auth/session-org`, {
      method: 'POST',
      headers: { authorization: `Bearer ${normal}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG }),
    })
    expect(normalSwitch.status).toBe(200)
    const normalBody = await normalSwitch.json() as { data?: { token?: string } }
    expect(normalBody.data?.token).toBeTruthy()
    expect(jwt.decode(String(normalBody.data?.token))).not.toMatchObject({ purpose: MANAGED_COMPANION_PURPOSE })
    const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
    expect(await authService.verifyToken(token)).toBeNull()
    server.close()
    expect(created.linkId).toBeTruthy()
    delete process.env.RBAC_TOKEN_TRUST
    await resetRows()
  })

  it('commits the local block before native revoke and retries until ack', async () => {
    installNative()
    revokeStatus = 503
    const { res, state } = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, done as never)
    const stopped = await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
    expect(stopped.state).toBe('pending')
    const link = await query('SELECT status FROM plm_managed_identity_links')
    expect(link.rows[0].status).toBe('revoked')
    const outbox = await query('SELECT id, status, delegation_id, generation FROM plm_managed_revoke_outbox')
    expect(outbox.rows[0].status).toBe('pending')
    const late = responseDouble()
    await expect(completeManagedCallback(callbackRequest(res, state) as never, late as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_INTENT_CONSUMED',
    })
    expect(await countSessions()).toHaveLength(1)
    expect((await query('SELECT revoked_at FROM plm_managed_sessions')).rows[0].revoked_at).toBeTruthy()
    revokeStatus = 204
    const acked = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { outboxId: outbox.rows[0].id })
    expect(acked.state).toBe('acked')
    expect((await query('SELECT status FROM plm_managed_revoke_outbox')).rows[0].status).toBe('acked')
    const again = await retryManagedRevoke({ id: ADMIN, role: 'admin' }, { outboxId: outbox.rows[0].id })
    expect(again.state).toBe('acked')
    await expect(relayManagedBomContext({ userId: OWNER, dataSourceId: SOURCE, partId: 'part' })).resolves.toMatchObject({
      kind: 'refusal',
    })
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
    const cleanup = await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)
    expect(cleanup.linked).toBe(false)
    enable()
    await resetRows()
  })

  it('discards an orphan delegation when the local commit fails and ignores a lost exchange', async () => {
    installNative()
    setManagedFlowHooksForTests({ loseExchangeResponse: true })
    const lost = await beginLogin()
    const lostRes = responseDouble()
    await completeManagedCallback(callbackRequest(lost.res, lost.state) as never, lostRes as never)
    expect(lostRes.location).toContain('PLM_MANAGED_EXCHANGE_LOST')
    expect(await countSessions()).toHaveLength(0)
    expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
    expect((await query('SELECT delegation_id FROM plm_managed_browser_intents')).rows[0].delegation_id).toBeNull()
    const callsAfterLoss = nativeCalls.filter((call) => call.url.endsWith('/exchange')).length
    const replay = responseDouble()
    await expect(completeManagedCallback(callbackRequest(lost.res, lost.state) as never, replay as never)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(callsAfterLoss)
    await resetRows()

    installNative()
    revokeStatus = 503
    setManagedFlowHooksForTests({ failSessionInsert: true })
    const failed = await beginLogin()
    const failedRes = responseDouble()
    await completeManagedCallback(callbackRequest(failed.res, failed.state) as never, failedRes as never)
    expect(failedRes.location).toContain('PLM_MANAGED_SESSION_COMMIT_FAILED')
    expect(await countSessions()).toHaveLength(0)
    const outbox = await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')
    expect(outbox.rows[0]).toMatchObject({ delegation_id: 'del-1', status: 'pending' })
    expect((await query('SELECT delegation_id FROM plm_managed_browser_intents')).rows[0].delegation_id).toBeNull()
    await resetRows()
  })

  it('stops on owner transfer and requires a fresh owner generation to rebind', async () => {
    installNative()
    const first = await beginLogin()
    await completeManagedCallback(callbackRequest(first.res, first.state) as never, responseDouble() as never)
    await expect(transferManagedLink({ id: ADMIN, role: 'admin' }, first.created.linkId, {})).rejects.toMatchObject({
      code: 'PLM_MANAGED_TRANSFER_OWNER_REQUIRED',
    })
    const transferred = await transferManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, first.created.linkId, {})
    expect(transferred.state).toBe('acked')
    expect((await query('SELECT status FROM plm_managed_identity_links')).rows[0].status).toBe('transferred')
    await expect(provisionManagedLink({ id: ADMIN, role: 'admin', authenticatedTenantId: TENANT }, provisionBody())).rejects.toMatchObject({
      code: 'PLM_MANAGED_REBIND_OWNER_REQUIRED',
    })
    const rebound = await provisionManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, provisionBody())
    expect(rebound.generation).toBe(2)
    expect(rebound.linkId).not.toBe(first.created.linkId)
    const binding = await query('SELECT generation, link_id, status FROM plm_managed_source_bindings')
    expect(binding.rows[0]).toMatchObject({ generation: 2, link_id: rebound.linkId, status: 'active' })
    await expect(revokeManagedLink({ id: OTHER }, rebound.linkId, {})).rejects.toMatchObject({ code: 'PLM_MANAGED_LINK_NOT_FOUND' })
    await resetRows()
  })

  it('serializes callback, unlink, and retry on independent connections', async () => {
    installNative()
    const started = await beginLogin()
    const [first, second] = await Promise.allSettled([
      completeManagedCallback(callbackRequest(started.res, started.state) as never, responseDouble() as never),
      completeManagedCallback(callbackRequest(started.res, started.state) as never, responseDouble() as never),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(await countSessions()).toHaveLength(1)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(1)

    let holder: Client | null = new Client({ connectionString: pgUrl })
    let lock: Client | null = null
    try {
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [started.created.linkId])
      let unlinkResult: Promise<unknown> | undefined
      const waiter = (async () => {
        unlinkResult = unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
        await unlinkResult
      })()
      const seen = await blockedBy(holder.processID)
      expect(seen).toBe(true)
      await holder.query('COMMIT')
      await waiter
      await expect(unlinkResult).resolves.toMatchObject({ ok: true })
      await holder.end()
      holder = null

      exchangeOverrides = { delegation_id: 'del-race-2' }
      const again = await beginLogin()
      await completeManagedCallback(callbackRequest(again.res, again.state) as never, responseDouble() as never)
      revokeStatus = 503
      await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      const outbox = await query<{ id: string }>('SELECT id FROM plm_managed_revoke_outbox WHERE status = $1', ['pending'])
      expect(outbox.rows[0]?.id).toBeTruthy()
      lock = new Client({ connectionString: pgUrl })
      await lock.connect()
      await lock.query('BEGIN')
      await lock.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [again.created.linkId])
      let retryDone = false
      const retrying = retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { outboxId: outbox.rows[0].id }).then((result) => {
        retryDone = true
        return result
      })
      expect(await blockedBy(lock.processID)).toBe(true)
      expect(retryDone).toBe(false)
      await lock.query('COMMIT')
      await expect(retrying).resolves.toMatchObject({ state: 'pending' })
      await lock.end()
      lock = null
    } finally {
      if (holder) {
        await holder.query('ROLLBACK').catch(() => undefined)
        await holder.end().catch(() => undefined)
      }
      if (lock) {
        await lock.query('ROLLBACK').catch(() => undefined)
        await lock.end().catch(() => undefined)
      }
    }
  })

  it('rejects drifted scope, expired rows, and a revoke aimed at another registration', async () => {
    installNative()
    const bare = await beginLogin()
    const acked = await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
    expect(acked.state).toBe('acked')
    expect((await query('SELECT count(*)::int AS n FROM plm_managed_revoke_outbox')).rows[0].n).toBe(0)
    expect((await query('SELECT status FROM plm_managed_identity_links WHERE id = $1', [bare.created.linkId])).rows[0].status).toBe('revoked')

    const { res, state, created } = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, done as never)
    const token = done.cookies[MANAGED_SESSION_COOKIE].value
    expect((await authService.verifyToken(token))?.id).toBe(OWNER)
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
    expect(await authService.verifyToken(token)).toBeNull()
    const paused = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: 'part' }, responseDouble() as never).catch((error: unknown) => error)
    expect(paused).toMatchObject({ code: 'PLM_MANAGED_DISABLED' })
    enable()

    const savedClients = process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON ?? ''
    const drifted = JSON.parse(savedClients) as Array<Record<string, string>>
    drifted[0] = { ...drifted[0], callback: `${ORIGIN}/api/plm/managed-login/not-registered` }
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify(drifted)
    await expect(startManagedLogin(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE, rootPartId: 'part' },
      responseDouble() as never,
    )).rejects.toMatchObject({ code: 'PLM_MANAGED_REGISTRATION_MISMATCH' })
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = savedClients

    const sessionsBefore = await countSessions()
    exchangeOverrides = { delegation_id: 'del-issuer', issuer: `${ORIGIN}/other-installation` }
    const issuerRes = responseDouble()
    const issuerStart = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: 'part' }, issuerRes as never)
    const issuerState = new URL(issuerStart.navigationUrl).searchParams.get('state') ?? ''
    const issuerReplay = callbackRequest(issuerRes, issuerState)
    await completeManagedCallback(issuerReplay as never, issuerRes as never)
    expect(issuerRes.location).toContain('PLM_MANAGED_EXCHANGE_MISMATCH')
    await expect(completeManagedCallback(issuerReplay as never, responseDouble() as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_INTENT_CONSUMED',
    })

    exchangeOverrides = { delegation_id: 'del-client', client_id: 'other-client' }
    const clientRes = responseDouble()
    const clientStart = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: 'part' }, clientRes as never)
    await completeManagedCallback(
      callbackRequest(clientRes, new URL(clientStart.navigationUrl).searchParams.get('state') ?? '') as never,
      clientRes as never,
    )
    expect(clientRes.location).toContain('PLM_MANAGED_EXCHANGE_MISMATCH')
    expect(await countSessions()).toHaveLength(sessionsBefore.length)

    const memberRes = responseDouble()
    const memberStart = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: 'part' }, memberRes as never)
    await query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])
    try {
      exchangeOverrides = { delegation_id: 'del-member' }
      await completeManagedCallback(
        callbackRequest(memberRes, new URL(memberStart.navigationUrl).searchParams.get('state') ?? '') as never,
        memberRes as never,
      )
      expect(memberRes.location).toContain('PLM_MANAGED_META_MEMBERSHIP_REFUSED')
    } finally {
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [OWNER, ORG],
      )
    }

    const sourceRes = responseDouble()
    const sourceStart = await startManagedLogin({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, { dataSourceId: SOURCE, rootPartId: 'part' }, sourceRes as never)
    await query('UPDATE data_sources SET config = $2::jsonb WHERE id = $1', [
      SOURCE,
      JSON.stringify({ connection: { url: 'http://127.0.0.1:8/plm' } }),
    ])
    try {
      exchangeOverrides = { delegation_id: 'del-source' }
      await completeManagedCallback(
        callbackRequest(sourceRes, new URL(sourceStart.navigationUrl).searchParams.get('state') ?? '') as never,
        sourceRes as never,
      )
      expect(sourceRes.location).toContain('PLM_MANAGED_SOURCE_REFUSED')
    } finally {
      await query('UPDATE data_sources SET config = $2::jsonb WHERE id = $1', [
        SOURCE,
        JSON.stringify({ connection: { url: `${ORIGIN}/plm` } }),
      ])
    }
    expect(await countSessions()).toHaveLength(sessionsBefore.length)

    await query(
      `INSERT INTO plm_managed_browser_intents (
         id, link_id, generation, meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id,
         client_origin, installation_issuer, native_tenant_id, native_org_id, callback, client_id, state_hash,
         nonce_hash, code_challenge, code_verifier_ciphertext, return_path, status, expires_at, created_at
       ) VALUES (
         'intent-expired', $1, $2, $3, $4, $5, $6, 'part', $7, $8, 'default', 'fixture-org', $9, 'managed-fixture',
         $10, $11, $12, 'enc:verifier', '/plm/bom-review', 'consumed', now() - interval '30 seconds', now() - interval '200 seconds'
       )`,
      [created.linkId, created.generation, OWNER, TENANT, ORG, SOURCE, ORIGIN, ISSUER, CALLBACK, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(43)],
    )
    await query(
      `INSERT INTO plm_managed_sessions (
         id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
         scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
         root_part_id, client_origin, installation_issuer, client_id, created_at
       ) VALUES (
         'session-expired', 'intent-expired', $1, $2, $3, 'del-expired', 'enc:yur_expired', now() - interval '30 seconds',
         'bom_review_read', '42', 'default', 'fixture-org', $4, $5, $6, 'part', $7, $8, 'managed-fixture',
         now() - interval '200 seconds'
       )`,
      [created.linkId, SOURCE, created.generation, OWNER, TENANT, ORG, ORIGIN, ISSUER],
    )
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const forged = jwt.sign({
      userId: OWNER,
      email: 'owner@example.test',
      role: 'user',
      tenantId: TENANT,
      sid: 'session-expired',
      purpose: MANAGED_COMPANION_PURPOSE,
      exp: Math.floor(Date.now() / 1000) + 120,
    }, secret)
    expect(await authService.verifyToken(forged)).toBeNull()
    expect((await authService.verifyToken(token))?.id).toBe(OWNER)

    const liveId = String(sessionsBefore[0].id)
    await query('UPDATE plm_managed_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [liveId])
    await expect(query('UPDATE plm_managed_sessions SET revoked_at = now() WHERE id = $1', [liveId])).rejects.toThrow(/plm_managed_session_revocation_monotonic/)
    await expect(query('UPDATE plm_managed_identity_links SET generation = generation + 1 WHERE id = $1', [created.linkId])).rejects.toThrow(/plm_managed_link_immutable/)

    revokeStatus = 503
    exchangeOverrides = {}
    const stopped = await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
    expect(stopped.state).toBe('pending')
    const revokeCalls = nativeCalls.filter((call) => call.url.endsWith('/revoke')).length
    const outbox = await query<{ id: string }>('SELECT id FROM plm_managed_revoke_outbox WHERE status = $1 AND delegation_id = $2', ['pending', 'del-1'])
    const replaced = JSON.parse(savedClients) as Array<Record<string, string>>
    replaced[0] = { ...replaced[0], clientId: 'other-client' }
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify(replaced)
    const retried = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { outboxId: outbox.rows[0].id })
    expect(retried.state).toBe('pending')
    expect((await query('SELECT last_error, status FROM plm_managed_revoke_outbox WHERE id = $1', [outbox.rows[0].id])).rows[0]).toMatchObject({
      last_error: 'registration_mismatch',
      status: 'pending',
    })
    expect(nativeCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(revokeCalls)
    enable()
  })

  it('refuses a managed must-change token before password mutation or an ordinary session', async () => {
    installNative()
    const { res, state } = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, done as never)
    const managedToken = done.cookies[MANAGED_SESSION_COOKIE].value
    const beforeUser = await query<{ password_hash: string; must_change_password: boolean }>(
      'SELECT password_hash, must_change_password FROM users WHERE id = $1',
      [OWNER],
    )
    const beforeSessions = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [OWNER])
    await query('UPDATE users SET must_change_password = true WHERE id = $1', [OWNER])
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/password/change`, {
        method: 'POST',
        headers: { authorization: `Bearer ${managedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'S3cure-Pass' }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'MANAGED_SESSION_REISSUE_REJECTED' })
      const afterUser = await query<{ password_hash: string; must_change_password: boolean }>(
        'SELECT password_hash, must_change_password FROM users WHERE id = $1',
        [OWNER],
      )
      const afterSessions = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [OWNER])
      expect(afterUser.rows[0].password_hash).toBe(beforeUser.rows[0].password_hash)
      expect(afterUser.rows[0].must_change_password).toBe(true)
      expect(afterSessions.rows[0].n).toBe(beforeSessions.rows[0].n)
      const managedRow = await query<{ revoked_at: string | null }>('SELECT revoked_at FROM plm_managed_sessions')
      expect(managedRow.rows[0].revoked_at).toBeNull()
    } finally {
      server.close()
      await query('UPDATE users SET must_change_password = false WHERE id = $1', [OWNER])
    }
  })

  it('still lets a normal must-change token set a password and insert one ordinary session', async () => {
    delete process.env.RBAC_TOKEN_TRUST
    await query('UPDATE users SET must_change_password = true, password_hash = $2 WHERE id = $1', [OTHER, 'unused'])
    await query('DELETE FROM user_sessions WHERE user_id = $1', [OTHER])
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const normal = jwt.sign({
      userId: OTHER,
      email: 'meta-other@example.test',
      role: 'user',
      tenantId: 'meta-org-other',
    }, secret, { expiresIn: '5m' })
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/password/change`, {
        method: 'POST',
        headers: { authorization: `Bearer ${normal}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'S3cure-Pass' }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { data?: { token?: string } }
      const issued = jwt.decode(String(body.data?.token)) as { purpose?: string; exp?: number; iat?: number }
      expect(issued.purpose).toBeUndefined()
      expect((issued.exp ?? 0) - (issued.iat ?? 0)).toBeGreaterThan(600)
      const afterUser = await query<{ password_hash: string; must_change_password: boolean }>(
        'SELECT password_hash, must_change_password FROM users WHERE id = $1',
        [OTHER],
      )
      expect(afterUser.rows[0].password_hash).not.toBe('unused')
      expect(afterUser.rows[0].must_change_password).toBe(false)
      const sessions = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [OTHER])
      expect(sessions.rows[0].n).toBe(1)
    } finally {
      server.close()
      await query('UPDATE users SET must_change_password = false, password_hash = $2 WHERE id = $1', [OTHER, 'unused'])
      await query('DELETE FROM user_sessions WHERE user_id = $1', [OTHER])
    }
  })

  it('refuses a meta tenant that is not the authenticated actor membership, including a native id', async () => {
    delete process.env.RBAC_TOKEN_TRUST
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const sessionToken = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: ORG,
    }, secret, { expiresIn: '5m' })
    const app = express()
    app.use(express.json())
    app.use('/api', jwtAuthMiddleware)
    app.use('/api/plm/managed-login', managedLoginRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const postLink = async (body: Record<string, unknown>) => {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/api/plm/managed-login/links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json() as { ok?: boolean; error?: { code?: string }; linkId?: string }
      return { status: response.status, payload }
    }
    try {
      const nativeEqual = await postLink(provisionBody({ metaTenantId: 'default', metaOrgId: ORG }))
      expect(nativeEqual.status).toBe(403)
      expect(nativeEqual.payload).toMatchObject({ ok: false, error: { code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' } })
      expect((await query('SELECT count(*)::int AS n FROM plm_managed_identity_links')).rows[0].n).toBe(0)

      const forged = await postLink(provisionBody({ metaTenantId: 'forged-tenant-b', metaOrgId: ORG }))
      expect(forged.status).toBe(403)
      expect(forged.payload).toMatchObject({ ok: false, error: { code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' } })
      expect((await query('SELECT count(*)::int AS n FROM plm_managed_identity_links')).rows[0].n).toBe(0)

      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'forged-tenant-b', true)
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [OWNER],
      )
      const otherMembership = await postLink(provisionBody({ metaTenantId: 'forged-tenant-b', metaOrgId: 'forged-tenant-b' }))
      expect(otherMembership.status).toBe(403)
      expect(otherMembership.payload).toMatchObject({ ok: false, error: { code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' } })
      expect((await query('SELECT count(*)::int AS n FROM plm_managed_identity_links')).rows[0].n).toBe(0)

      const paired = await postLink(provisionBody({ metaTenantId: ORG, metaOrgId: ORG }))
      expect(paired.status).toBe(200)
      expect(paired.payload.ok).toBe(true)
      const stored = await query<{ meta_tenant_id: string; meta_org_id: string }>(
        'SELECT meta_tenant_id, meta_org_id FROM plm_managed_identity_links',
      )
      expect(stored.rows[0]).toEqual({ meta_tenant_id: ORG, meta_org_id: ORG })
    } finally {
      server.close()
      await query("DELETE FROM user_orgs WHERE user_id = $1 AND org_id = 'forged-tenant-b'", [OWNER])
    }
  })

  it('does not trust a persisted meta tenant that lacks canonical membership', async () => {
    installNative()
    const fingerprint = sourceFingerprint({
      type: 'plm',
      origin: ORIGIN,
      ownerId: OWNER,
      rootPartId: 'part',
      tenantId: null,
      workspaceId: null,
      scopeKind: null,
    })
    await query(
      `INSERT INTO plm_managed_identity_links (
         id, installation_issuer, native_auth_user_id, native_tenant_id, native_org_id, client_id, callback,
         meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id, client_origin, generation,
         status, owner_user_id, created_by, source_fingerprint
       ) VALUES (
         'link-forged-tenant', $1, '42', 'default', 'fixture-org', 'managed-fixture', $2,
         $3, 'forged-tenant-b', $4, $5, 'part', $6, 1, 'active', $3, $3, $7
       )`,
      [ISSUER, CALLBACK, OWNER, ORG, SOURCE, ORIGIN, fingerprint],
    )
    await query(
      `INSERT INTO plm_managed_source_bindings (
         data_source_id, link_id, generation, source_fingerprint, status, frozen_origin, frozen_root_part_id
       ) VALUES ($1, 'link-forged-tenant', 1, $2, 'active', $3, 'part')`,
      [SOURCE, fingerprint, ORIGIN],
    )
    await query(
      `INSERT INTO plm_managed_browser_intents (
         id, link_id, generation, meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id,
         client_origin, installation_issuer, native_tenant_id, native_org_id, callback, client_id, state_hash,
         nonce_hash, code_challenge, code_verifier_ciphertext, return_path, status, expires_at, created_at
       ) VALUES (
         'intent-forged-tenant', 'link-forged-tenant', 1, $1, 'forged-tenant-b', $2, $3, 'part',
         $4, $5, 'default', 'fixture-org', $6, 'managed-fixture', $7, $8, $9, 'enc:verifier',
         '/plm/bom-review', 'consumed', now() + interval '200 seconds', now()
       )`,
      [OWNER, ORG, SOURCE, ORIGIN, ISSUER, CALLBACK, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(43)],
    )
    const session = await query<{ expires_at: Date }>(
      `INSERT INTO plm_managed_sessions (
         id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
         scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
         root_part_id, client_origin, installation_issuer, client_id, created_at
       ) VALUES (
         'session-forged-tenant', 'intent-forged-tenant', 'link-forged-tenant', $1, 1, 'del-forged-tenant',
         'enc:yur_forged', now() + interval '200 seconds', 'bom_review_read', '42', 'default', 'fixture-org',
         $2, 'forged-tenant-b', $3, 'part', $4, $5, 'managed-fixture', now()
       ) RETURNING expires_at`,
      [SOURCE, OWNER, ORG, ORIGIN, ISSUER],
    )
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const forged = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: 'forged-tenant-b',
      sid: 'session-forged-tenant',
      purpose: MANAGED_COMPANION_PURPOSE,
      exp: Math.floor(new Date(session.rows[0].expires_at).getTime() / 1000),
    }, secret)
    expect(await authService.verifyToken(forged)).toBeNull()
  })

  it('invalidates a same-owner move of the persistent source tenant, workspace, or scope', async () => {
    installNative()
    const started = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(started.res, started.state) as never, done as never)
    const token = done.cookies[MANAGED_SESSION_COOKIE].value
    expect((await authService.verifyToken(token))?.id).toBe(OWNER)
    const moves: Array<{ sql: string; restore: string }> = [
      {
        sql: `UPDATE data_sources SET tenant_id = 'moved-tenant' WHERE id = $1`,
        restore: 'UPDATE data_sources SET tenant_id = NULL WHERE id = $1',
      },
      {
        sql: `UPDATE data_sources SET workspace_id = 'moved-workspace' WHERE id = $1`,
        restore: 'UPDATE data_sources SET workspace_id = NULL WHERE id = $1',
      },
      {
        sql: `UPDATE data_sources SET scope_kind = 'workspace' WHERE id = $1`,
        restore: 'UPDATE data_sources SET scope_kind = NULL WHERE id = $1',
      },
    ]
    for (const move of moves) {
      await query(move.sql, [SOURCE])
      try {
        await expect(startManagedLogin(
          { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
          { dataSourceId: SOURCE, rootPartId: 'part' },
          responseDouble() as never,
        )).rejects.toMatchObject({ code: 'PLM_MANAGED_SOURCE_CHANGED' })
        expect((await query('SELECT count(*)::int AS n FROM plm_managed_browser_intents WHERE status = $1', ['pending'])).rows[0].n).toBe(0)
        expect(await authService.verifyToken(token)).toBeNull()
        resetSharedTransportAudit()
        await expect(enterLegacySharedTransport(SOURCE, 'source-moved', async () => 'shared')).rejects.toMatchObject({
          code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED',
        })
        expect(readSharedTransportAudit().calls).toBe(0)
      } finally {
        await query(move.restore, [SOURCE])
      }
    }
    expect((await authService.verifyToken(token))?.id).toBe(OWNER)
  })

  it('does not let another person managed cookie replace the pending login', async () => {
    installNative()
    await query(
      `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
       VALUES ('source-other', 'Other PLM', $1, 'plm', $2::jsonb, true)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
    )
    exchangeOverrides = { subject: '77', delegation_id: 'del-other' }
    await provisionManagedLink(
      { id: OTHER, role: 'user', authenticatedTenantId: 'meta-org-other' },
      provisionBody({
        nativeAuthUserId: '77',
        metaUserId: OTHER,
        metaTenantId: 'meta-org-other',
        metaOrgId: 'meta-org-other',
        dataSourceId: 'source-other',
      }),
    )
    const otherStart = responseDouble()
    const otherNav = await startManagedLogin(
      { id: OTHER, role: 'user', authenticatedTenantId: 'meta-org-other' },
      { dataSourceId: 'source-other', rootPartId: 'part' },
      otherStart as never,
    )
    const otherDone = responseDouble()
    await completeManagedCallback(
      callbackRequest(otherStart, new URL(otherNav.navigationUrl).searchParams.get('state') ?? '') as never,
      otherDone as never,
    )
    const otherCookie = otherDone.cookies[MANAGED_SESSION_COOKIE].value
    expect((await authService.verifyToken(otherCookie))?.id).toBe(OTHER)
    exchangeOverrides = {}

    exchangeOverrides = { delegation_id: 'del-owner-1' }
    const first = await beginLogin()
    const firstDone = responseDouble()
    await completeManagedCallback(callbackRequest(first.res, first.state) as never, firstDone as never)
    const ownerCookie = firstDone.cookies[MANAGED_SESSION_COOKIE].value
    expect(firstDone.location).toContain('managed=ready')

    exchangeOverrides = { delegation_id: 'del-owner-2' }
    const again = responseDouble()
    const restarted = await startManagedLogin(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE, rootPartId: 'part' },
      again as never,
    )
    const againDone = responseDouble()
    await completeManagedCallback(
      callbackRequest(again, new URL(restarted.navigationUrl).searchParams.get('state') ?? '', {
        cookie: `${MANAGED_SESSION_COOKIE}=${ownerCookie}`,
      }) as never,
      againDone as never,
    )
    expect(againDone.location).toContain('managed=ready')

    exchangeOverrides = { delegation_id: 'del-owner-3' }
    const stale = responseDouble()
    const staleNav = await startManagedLogin(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE, rootPartId: 'part' },
      stale as never,
    )
    const staleDone = responseDouble()
    await completeManagedCallback(
      callbackRequest(stale, new URL(staleNav.navigationUrl).searchParams.get('state') ?? '', {
        cookie: `${MANAGED_SESSION_COOKIE}=not-a-jwt`,
      }) as never,
      staleDone as never,
    )
    expect(staleDone.location).toContain('managed=ready')

    const pending = responseDouble()
    const pendingNav = await startManagedLogin(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE, rootPartId: 'part' },
      pending as never,
    )
    const exchangesBefore = nativeCalls.filter((call) => call.url.endsWith('/exchange')).length
    const sessionsBefore = await countSessions()
    const conflict = responseDouble()
    await completeManagedCallback(
      callbackRequest(pending, new URL(pendingNav.navigationUrl).searchParams.get('state') ?? '', {
        cookie: `${MANAGED_SESSION_COOKIE}=${otherCookie}`,
      }) as never,
      conflict as never,
    )
    expect(conflict.statusCode).toBe(409)
    expect(JSON.stringify(conflict.payload)).toContain('PLM_MANAGED_PERSON_CONFLICT')
    expect(conflict.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect(conflict.cleared).not.toContain(MANAGED_SESSION_COOKIE)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(exchangesBefore)
    expect(await countSessions()).toHaveLength(sessionsBefore.length)
    expect((await authService.verifyToken(otherCookie))?.id).toBe(OTHER)
    expect((await query(
      `SELECT status FROM plm_managed_browser_intents WHERE data_source_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [SOURCE],
    )).rows[0].status).toBe('pending')
  })

  it('rejects a managed cookie whose tenant differs from the ordinary bearer', async () => {
    installNative()
    delete process.env.RBAC_TOKEN_TRUST
    const started = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(started.res, started.state) as never, done as never)
    const sessionCookie = done.cookies[MANAGED_SESSION_COOKIE].value
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const app = express()
    app.get('/api/bom', jwtAuthMiddleware, async (req, res) => {
      res.json(await relayManagedBomContext({ userId: req.user?.id, dataSourceId: SOURCE, partId: 'part' }))
    })
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    try {
      const port = (server.address() as { port: number }).port
      const read = async (tenantId: string) => {
        const bearer = jwt.sign({
          userId: OWNER,
          email: 'meta-owner@example.test',
          role: 'user',
          tenantId,
        }, secret, { expiresIn: '5m' })
        const response = await fetch(`http://127.0.0.1:${port}/api/bom`, {
          headers: {
            authorization: `Bearer ${bearer}`,
            cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie}`,
          },
        })
        return response.json() as Promise<{ kind?: string; code?: string }>
      }
      expect(await read(ORG)).toMatchObject({ kind: 'refusal', code: 'PLM_MANAGED_SESSION_REQUIRED' })
      expect(await read(TENANT)).toMatchObject({ kind: 'ok' })
    } finally {
      server.close()
    }
  })

  it('rebinds a different native person after unlink at the next source generation', async () => {
    const first = await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    expect((await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })).state).toBe('acked')
    await expect(provisionManagedLink(
      { id: ADMIN, role: 'admin', authenticatedTenantId: TENANT },
      provisionBody({ nativeAuthUserId: '900' }),
    )).rejects.toMatchObject({ code: 'PLM_MANAGED_REBIND_OWNER_REQUIRED' })
    const rebound = await provisionManagedLink(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      provisionBody({ nativeAuthUserId: '900' }),
    )
    expect(rebound.generation).toBe(first.generation + 1)
    expect(rebound.linkId).not.toBe(first.linkId)
    expect((await query(
      'SELECT generation, status, native_auth_user_id FROM plm_managed_identity_links WHERE id = $1',
      [first.linkId],
    )).rows[0]).toMatchObject({ generation: first.generation, status: 'revoked', native_auth_user_id: '42' })
    expect((await query('SELECT generation, link_id, status FROM plm_managed_source_bindings')).rows[0]).toMatchObject({
      generation: rebound.generation,
      link_id: rebound.linkId,
      status: 'active',
    })
  })

  it('rebinds a different native person after transfer at the next source generation', async () => {
    const first = await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    expect((await transferManagedLink({ id: OWNER, authenticatedTenantId: TENANT }, first.linkId, {})).state).toBe('acked')
    const rebound = await provisionManagedLink(
      { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
      provisionBody({ nativeAuthUserId: '901' }),
    )
    expect(rebound.generation).toBe(2)
    expect((await query(
      'SELECT generation, status, native_auth_user_id FROM plm_managed_identity_links WHERE id = $1',
      [first.linkId],
    )).rows[0]).toMatchObject({ generation: 1, status: 'transferred', native_auth_user_id: '42' })
  })

  it('lets one concurrent different-native-person rebind win the next generation', async () => {
    const first = await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
    const [left, right] = await Promise.allSettled([
      provisionManagedLink(
        { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
        provisionBody({ nativeAuthUserId: '910' }),
      ),
      provisionManagedLink(
        { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
        provisionBody({ nativeAuthUserId: '911' }),
      ),
    ])
    const fulfilled = [left, right].filter((result) => result.status === 'fulfilled')
    const rejected = [left, right].filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'PLM_MANAGED_BINDING_REFUSED' })
    expect((fulfilled[0] as PromiseFulfilledResult<{ generation: number }>).value.generation).toBe(first.generation + 1)
    expect((await query(`SELECT count(*)::int AS n FROM plm_managed_source_bindings WHERE status = 'active'`)).rows[0].n).toBe(1)
    expect((await query(
      'SELECT generation, status FROM plm_managed_identity_links WHERE id = $1',
      [first.linkId],
    )).rows[0]).toMatchObject({ generation: first.generation, status: 'revoked' })
  })

  it('stays pending when unlink lands during exchange and native revoke fails', async () => {
    let releaseExchange: (response: Response) => void = () => undefined
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    revokeStatus = 503
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/exchange')) {
        markEntered()
        return new Promise((resolve) => {
          releaseExchange = resolve
        })
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: revokeStatus })
      return new Response('missing', { status: 404 })
    })
    const started = await beginLogin()
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseExchange(Response.json(exchangeBody()))
    }
    const callback = completeManagedCallback(callbackRequest(started.res, started.state) as never, responseDouble() as never)
    const settled = callback.then(() => undefined, () => undefined)
    try {
      await entered
      const deadline = Date.now() + 3000
      let consumed = false
      while (Date.now() < deadline) {
        const row = await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')
        if (row.rows[0]?.status === 'consumed') {
          consumed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      expect(consumed).toBe(true)
      const stopped = await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(stopped.state).toBe('pending')
      const during = await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)
      expect(during.pendingRevoke).toBe(true)
      expect(during.linked).toBe(false)
      expect((await query('SELECT status FROM plm_managed_identity_links')).rows[0].status).toBe('revoked')
      expect((await query('SELECT status FROM plm_managed_source_bindings')).rows[0].status).toBe('blocked')
      release()
      await settled
      expect((await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)).pendingRevoke).toBe(true)
      revokeStatus = 204
      const retried = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(retried.state).toBe('acked')
      expect((await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)).pendingRevoke).toBe(false)
    } finally {
      release()
      await settled
    }
  })

  it('stays pending after browser expiry while a held exchange can still mint a native grant', async () => {
    let releaseExchange: (response: Response) => void = () => undefined
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/exchange')) {
        markEntered()
        return new Promise((resolve) => {
          releaseExchange = resolve
        })
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: revokeStatus })
      return new Response('missing', { status: 404 })
    })
    const started = await beginLogin()
    await query(
      `UPDATE plm_managed_browser_intents
       SET created_at = tick.stamp - interval '297 seconds',
           expires_at = tick.stamp + interval '3 seconds'
       FROM (SELECT clock_timestamp() AS stamp) AS tick`,
    )
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseExchange(Response.json(exchangeBody()))
    }
    const callback = completeManagedCallback(callbackRequest(started.res, started.state) as never, responseDouble() as never)
    const settled = callback.then(() => undefined, () => undefined)
    try {
      await entered
      const deadline = Date.now() + 2500
      let consumed = false
      while (Date.now() < deadline) {
        const row = await query<{ status: string }>('SELECT status FROM plm_managed_browser_intents')
        if (row.rows[0]?.status === 'consumed') {
          consumed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      expect(consumed).toBe(true)
      const expired = await query<{
        expires_at: Date | string
        consumed_at: Date | string
        browser_expired: boolean
        inside_native_bound: boolean
        delegation_id: string | null
      }>(
        `UPDATE plm_managed_browser_intents
         SET expires_at = tick.stamp - interval '1 second'
         FROM (SELECT clock_timestamp() AS stamp) AS tick
         WHERE status = 'consumed' AND delegation_id IS NULL
         RETURNING expires_at, consumed_at, delegation_id,
           (expires_at <= clock_timestamp()) AS browser_expired,
           (consumed_at + interval '608 seconds' > clock_timestamp()) AS inside_native_bound`,
      )
      const row = expired.rows[0]
      expect(row?.browser_expired).toBe(true)
      expect(row?.inside_native_bound).toBe(true)
      expect(row?.delegation_id).toBeNull()
      await expect(query(
        'UPDATE plm_managed_browser_intents SET code_challenge = $1',
        ['A'.repeat(43)],
      )).rejects.toThrow(/plm_managed_intent_immutable/)
      const expiredAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
      const consumedAt = row.consumed_at instanceof Date ? row.consumed_at : new Date(row.consumed_at)
      setManagedFixtureClockForTests(new Date(expiredAt.getTime() + 1000))
      const stopped = await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(stopped.state).toBe('pending')
      expect((await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)).pendingRevoke).toBe(true)
      const early = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(early.state).toBe('pending')
      expect((await query('SELECT delegation_id FROM plm_managed_browser_intents')).rows[0].delegation_id).toBeNull()
      expect((await query('SELECT count(*)::int AS n FROM plm_managed_revoke_outbox')).rows[0].n).toBe(0)
      setManagedFixtureClockForTests(new Date(consumedAt.getTime() + 600_000 + 1_000))
      const withinAbort = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(withinAbort.state).toBe('pending')
      const aged = await query<{
        consumed_at: Date | string
        observed_now: Date | string
        past_client_abort_bound: boolean
        past_delayed_native_grant: boolean
        past_int_second_bound: boolean
        delegation_id: string | null
      }>(
        `UPDATE plm_managed_browser_intents
         SET consumed_at = tick.stamp - interval '100 years'
         FROM (SELECT clock_timestamp() AS stamp) AS tick
         WHERE status = 'consumed' AND delegation_id IS NULL
         RETURNING consumed_at, delegation_id,
           clock_timestamp() AS observed_now,
           (consumed_at + interval '608 seconds' <= clock_timestamp()) AS past_client_abort_bound,
           (consumed_at + interval '700 seconds' <= clock_timestamp()) AS past_delayed_native_grant,
           (consumed_at + interval '2147483647 seconds' <= clock_timestamp()) AS past_int_second_bound`,
      )
      const agedRow = aged.rows[0]
      expect(agedRow?.past_client_abort_bound).toBe(true)
      expect(agedRow?.past_delayed_native_grant).toBe(true)
      expect(agedRow?.past_int_second_bound).toBe(true)
      expect(agedRow?.delegation_id).toBeNull()
      const observedNow = agedRow?.observed_now instanceof Date ? agedRow.observed_now : new Date(String(agedRow?.observed_now))
      setManagedFixtureClockForTests(observedNow)
      const held = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(held.state, 'held exchange past a delayed native grant stays pending').toBe('pending')
      expect((await readManagedSessionStatus({ id: OWNER, authenticatedTenantId: TENANT }, SOURCE)).pendingRevoke).toBe(true)
      expect((await query('SELECT count(*)::int AS n FROM plm_managed_revoke_outbox')).rows[0].n).toBe(0)
      expect((await query('SELECT delegation_id FROM plm_managed_browser_intents')).rows[0].delegation_id).toBeNull()
    } finally {
      setManagedFixtureClockForTests(null)
      release()
      await settled
    }
  })

  it('acks only the intent that produced the revoke when two held exchanges finish newer first', async () => {
    const releases: Array<(response: Response) => void> = []
    const marks: Array<() => void> = []
    const entered = [0, 1].map(() => new Promise<void>((resolve) => {
      marks.push(resolve)
    }))
    let seen = 0
    const released = [false, false]
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/exchange')) {
        const index = seen
        seen += 1
        marks[index]?.()
        return new Promise((resolve) => {
          releases[index] = resolve
        })
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: revokeStatus })
      return new Response('missing', { status: 404 })
    })
    const releaseAt = (index: number, delegationId: string) => {
      if (released[index] || !releases[index]) return
      released[index] = true
      releases[index](Response.json(exchangeBody({ delegation_id: delegationId })))
    }
    let settledA: Promise<void> = Promise.resolve()
    let settledB: Promise<void> = Promise.resolve()
    setManagedFlowHooksForTests({ failSessionInsert: true })
    revokeStatus = 503
    try {
      const older = await beginLogin()
      const olderDone = responseDouble()
      const olderCallback = completeManagedCallback(callbackRequest(older.res, older.state) as never, olderDone as never)
      settledA = olderCallback.then(() => undefined, () => undefined)
      await entered[0]
      const olderId = (await query<{ id: string; status: string }>('SELECT id, status FROM plm_managed_browser_intents')).rows[0]
      expect(olderId?.status).toBe('consumed')
      const newerRes = responseDouble()
      const newerStarted = await startManagedLogin(
        { id: OWNER, role: 'user', authenticatedTenantId: TENANT },
        { dataSourceId: SOURCE, rootPartId: 'part' },
        newerRes as never,
      )
      const newerState = new URL(newerStarted.navigationUrl).searchParams.get('state') ?? ''
      const newerDone = responseDouble()
      const newerCallback = completeManagedCallback(callbackRequest(newerRes, newerState) as never, newerDone as never)
      settledB = newerCallback.then(() => undefined, () => undefined)
      await entered[1]
      const intents = await query<{ id: string; consumed_at: Date | string }>(
        `SELECT id, consumed_at FROM plm_managed_browser_intents ORDER BY consumed_at ASC, id ASC`,
      )
      expect(intents.rows).toHaveLength(2)
      expect(intents.rows[0]?.id).toBe(olderId?.id)
      const newerId = intents.rows[1]?.id ?? ''
      releaseAt(1, 'del-b')
      await settledB
      expect(newerDone.location).toContain('PLM_MANAGED_SESSION_COMMIT_FAILED')
      expect((await query(
        'SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1',
        [newerId],
      )).rows[0].delegation_id).toBeNull()
      expect((await query(
        'SELECT delegation_id, status FROM plm_managed_revoke_outbox',
      )).rows).toEqual([expect.objectContaining({ delegation_id: 'del-b', status: 'pending' })])
      revokeStatus = 204
      await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      const stamped = await query<{ id: string; delegation_id: string | null }>(
        'SELECT id, delegation_id FROM plm_managed_browser_intents',
      )
      const delegationOf = (id: string) => stamped.rows.find((row) => row.id === id)?.delegation_id ?? null
      expect(delegationOf(olderId?.id ?? '')).toBeNull()
      expect(delegationOf(newerId)).toBe('del-b')
      revokeStatus = 503
      releaseAt(0, 'del-a')
      await settledA
      expect(olderDone.location).toContain('PLM_MANAGED_SESSION_COMMIT_FAILED')
      expect((await query(
        'SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1',
        [olderId?.id],
      )).rows[0].delegation_id).toBeNull()
      expect((await query(
        'SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1',
        [newerId],
      )).rows[0].delegation_id).toBe('del-b')
      const waiting = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(waiting.state).toBe('pending')
      expect((await query(
        `SELECT delegation_id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-a'`,
      )).rows[0]).toMatchObject({ delegation_id: 'del-a', status: 'pending' })
      revokeStatus = 204
      const acked = await retryManagedRevoke({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      expect(acked.state).toBe('acked')
      expect((await query(
        'SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1',
        [olderId?.id],
      )).rows[0].delegation_id).toBe('del-a')
      expect((await query(
        'SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1',
        [newerId],
      )).rows[0].delegation_id).toBe('del-b')
      const outbox = await query<{ delegation_id: string; intent_id: string; status: string }>(
        'SELECT delegation_id, intent_id, status FROM plm_managed_revoke_outbox',
      )
      expect(outbox.rows).toHaveLength(2)
      expect(outbox.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ delegation_id: 'del-b', intent_id: newerId, status: 'acked' }),
        expect.objectContaining({ delegation_id: 'del-a', intent_id: olderId?.id, status: 'acked' }),
      ]))
    } finally {
      releaseAt(0, 'del-a')
      releaseAt(1, 'del-b')
      await Promise.allSettled([settledA, settledB])
    }
  })

  it('retries a pending revoke from the public source id without an outbox lookup', async () => {
    installNative()
    revokeStatus = 503
    delete process.env.RBAC_TOKEN_TRUST
    const started = await beginLogin()
    await completeManagedCallback(callbackRequest(started.res, started.state) as never, responseDouble() as never)
    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    const ownerToken = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: TENANT,
    }, secret, { expiresIn: '5m' })
    const otherToken = jwt.sign({
      userId: OTHER,
      email: 'meta-other@example.test',
      role: 'user',
      tenantId: 'meta-org-other',
    }, secret, { expiresIn: '5m' })
    const app = express()
    app.use(express.json())
    app.use('/api', jwtAuthMiddleware)
    app.use('/api/plm/managed-login', managedLoginRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const payload = await response.json() as { ok?: boolean; state?: string; pendingRevoke?: boolean; error?: { code?: string } }
      return { status: response.status, payload }
    }
    try {
      const unlinked = await call(ownerToken, 'POST', '/api/plm/managed-login/unlink', { dataSourceId: SOURCE })
      expect(unlinked.status).toBe(200)
      expect(unlinked.payload).toEqual({ ok: true, state: 'pending' })
      const session = await call(ownerToken, 'GET', `/api/plm/managed-login/session?dataSourceId=${SOURCE}`)
      expect(session.payload.pendingRevoke).toBe(true)
      const waiting = await call(ownerToken, 'POST', '/api/plm/managed-login/revoke-retry', { dataSourceId: SOURCE })
      expect(waiting.status).toBe(200)
      expect(waiting.payload).toEqual({ ok: true, state: 'pending' })
      const refused = await call(otherToken, 'POST', '/api/plm/managed-login/revoke-retry', { dataSourceId: SOURCE })
      expect(refused.status).toBe(403)
      expect(refused.payload).toMatchObject({ error: { code: 'PLM_MANAGED_ACTOR_REFUSED' } })
      expect(JSON.stringify(waiting.payload)).not.toMatch(/yur_|delegation|outbox/i)
      revokeStatus = 204
      const acked = await call(ownerToken, 'POST', '/api/plm/managed-login/revoke-retry', { dataSourceId: SOURCE })
      expect(acked.status).toBe(200)
      expect(acked.payload).toEqual({ ok: true, state: 'acked' })
      const after = await call(ownerToken, 'GET', `/api/plm/managed-login/session?dataSourceId=${SOURCE}`)
      expect(after.payload.pendingRevoke).toBe(false)
      expect(JSON.stringify([unlinked.payload, session.payload, waiting.payload, acked.payload, after.payload])).not.toMatch(/yur_/)
    } finally {
      server.close()
    }
  })

  it('selects each mapped native person by hint and rejects a swapped exchange', async () => {
    installNative()
    await query(
      `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set, password_hash)
       VALUES ('meta-peer', 'meta-peer@example.test', 'meta-peer', 'user', '[]'::jsonb, true, 'activated', false, true, 'unused')
       ON CONFLICT (id) DO NOTHING`,
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ('meta-peer', $1, true), ('meta-peer', $2, true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TENANT, ORG],
    )
    await insertOwnedSource('source-peer', 'meta-peer')
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    await provisionManagedLink({ id: 'meta-peer', role: 'user', authenticatedTenantId: TENANT }, provisionBody({
      nativeAuthUserId: '77',
      metaUserId: 'meta-peer',
      dataSourceId: 'source-peer',
    }))
    const first = responseDouble()
    const second = responseDouble()
    const startedFirst = await startManagedBrowserLogin(browserStartRequest('42') as never, first as never)
    const startedSecond = await startManagedBrowserLogin(browserStartRequest('77') as never, second as never)
    expect(startedFirst.navigationUrl).not.toMatch(/meta-owner|meta-peer|yur_/)
    expect(new URL(startedSecond.navigationUrl).searchParams.get('state')).toBeTruthy()
    const stateFirst = new URL(startedFirst.navigationUrl).searchParams.get('state') ?? ''
    const stateSecond = new URL(startedSecond.navigationUrl).searchParams.get('state') ?? ''
    exchangeOverrides = { subject: '42', delegation_id: 'del-hint-42' }
    const doneFirst = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(first, stateFirst) as never, doneFirst as never)
    exchangeOverrides = { subject: '77', delegation_id: 'del-hint-77' }
    const doneSecond = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(second, stateSecond) as never, doneSecond as never)
    const sessions = await query<{ meta_user_id: string; native_subject: string }>('SELECT meta_user_id, native_subject FROM plm_managed_sessions ORDER BY native_subject')
    expect(sessions.rows).toEqual([
      { meta_user_id: OWNER, native_subject: '42' },
      { meta_user_id: 'meta-peer', native_subject: '77' },
    ])
    expect(JSON.stringify(doneFirst.payload)).not.toMatch(/yur_|code_verifier|clientSecret/)
    await resetRows()
    await provisionManagedLink({ id: 'meta-peer', role: 'user', authenticatedTenantId: TENANT }, provisionBody({
      nativeAuthUserId: '77',
      metaUserId: 'meta-peer',
      dataSourceId: 'source-peer',
    }))
    const swappedStart = responseDouble()
    const swapped = await startManagedBrowserLogin(browserStartRequest('77') as never, swappedStart as never)
    const swappedState = new URL(swapped.navigationUrl).searchParams.get('state') ?? ''
    exchangeOverrides = { subject: '42', delegation_id: 'del-swapped' }
    const swappedDone = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(swappedStart, swappedState) as never, swappedDone as never)
    expect(swappedDone.statusCode).toBe(403)
    expect(JSON.stringify(swappedDone.payload)).toContain('PLM_MANAGED_EXCHANGE_MISMATCH')
    expect(swappedDone.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect(await countSessions()).toHaveLength(0)
    const users = await query<{ n: number }>('SELECT count(*)::int AS n FROM users')
    expect(users.rows[0].n).toBeGreaterThan(0)
    await expect(startManagedBrowserLogin(browserStartRequest('meta-peer') as never, responseDouble() as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_LINK_NOT_FOUND',
    })
  })

  it('refuses a duplicate mapped person and does not create a user for an extra body key', async () => {
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    await insertOwnedSource('source-dup', OWNER)
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody({ dataSourceId: 'source-dup' }))
    const beforeUsers = await query<{ n: number }>('SELECT count(*)::int AS n FROM users')
    await expect(startManagedBrowserLogin(browserStartRequest('42') as never, responseDouble() as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_LINK_AMBIGUOUS',
    })
    expect((await query<{ n: number }>('SELECT count(*)::int AS n FROM plm_managed_browser_intents')).rows[0].n).toBe(0)
    await expect(startManagedBrowserLogin(browserStartRequest('42', { email: 'owner@example.test' }) as never, responseDouble() as never)).rejects.toMatchObject({
      code: 'PLM_MANAGED_BODY_REFUSED',
    })
    const afterUsers = await query<{ n: number }>('SELECT count(*)::int AS n FROM users')
    expect(afterUsers.rows[0].n).toBe(beforeUsers.rows[0].n)
  })

  it('hands the callback to the return view and exchanges only on same-origin complete', async () => {
    installNative()
    const { res, state } = await beginLogin()
    const handoff = responseDouble()
    handoffManagedCallback({ query: { code: 'one-use-code', state } } as never, handoff as never)
    expect(handoff.statusCode).toBe(302)
    expect(handoff.location.startsWith('/plm/managed-return?')).toBe(true)
    expect(handoff.location).not.toMatch(/yur_|code_verifier/)
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    expect((await query('SELECT status FROM plm_managed_browser_intents')).rows[0].status).toBe('pending')
    const done = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(res, state) as never, done as never)
    expect(done.statusCode).toBe(200)
    expect(done.payload).toMatchObject({ ok: true })
    expect(JSON.stringify(done.payload)).not.toMatch(/token|yur_|code_verifier/)
    expect(String((done.payload as { destination: string }).destination)).toContain('managed=ready')
    expect(done.cookies[MANAGED_SESSION_COOKIE]?.options).toMatchObject({ httpOnly: true, sameSite: 'lax' })
    expect(await countSessions()).toHaveLength(1)
  })

  it('refuses an invalid or other-tenant bearer before consume', async () => {
    installNative()
    const invalid = await beginLogin()
    const invalidDone = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(invalid.res, invalid.state, {
      headers: { authorization: 'Bearer not-a-jwt' },
    }) as never, invalidDone as never)
    expect(invalidDone.statusCode).toBe(401)
    expect(JSON.stringify(invalidDone.payload)).toContain('PLM_MANAGED_BEARER_REFUSED')
    expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    expect((await query('SELECT status FROM plm_managed_browser_intents')).rows[0].status).toBe('pending')

    const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
    process.env.RBAC_TOKEN_TRUST = 'true'
    const other = jwt.sign({
      userId: OTHER, email: 'other@example.test', role: 'user', tenantId: 'meta-org-other',
    }, secret, { expiresIn: '5m' })
    const conflict = responseDouble()
    await completeManagedBrowserLogin(browserCompleteRequest(invalid.res, invalid.state, {
      headers: { authorization: `Bearer ${other}` },
    }) as never, conflict as never)
    expect(conflict.statusCode).toBe(409)
    expect(JSON.stringify(conflict.payload)).toContain('PLM_MANAGED_PERSON_CONFLICT')
    expect((await query('SELECT status FROM plm_managed_browser_intents')).rows[0].status).toBe('pending')
    expect(await countSessions()).toHaveLength(0)
    expect(conflict.cleared).not.toContain(MANAGED_SESSION_COOKIE)
    delete process.env.RBAC_TOKEN_TRUST
  })

  it('lets concurrent distinct hints succeed and concurrent duplicate mappings refuse', async () => {
    installNative()
    await query(
      `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set, password_hash)
       VALUES ('meta-peer', 'meta-peer@example.test', 'meta-peer', 'user', '[]'::jsonb, true, 'activated', false, true, 'unused')
       ON CONFLICT (id) DO NOTHING`,
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ('meta-peer', $1, true), ('meta-peer', $2, true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TENANT, ORG],
    )
    await insertOwnedSource('source-peer', 'meta-peer')
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    await provisionManagedLink({ id: 'meta-peer', role: 'user', authenticatedTenantId: TENANT }, provisionBody({
      nativeAuthUserId: '77', metaUserId: 'meta-peer', dataSourceId: 'source-peer',
    }))
    const left = responseDouble()
    const right = responseDouble()
    const [one, two] = await Promise.all([
      startManagedBrowserLogin(browserStartRequest('42') as never, left as never),
      startManagedBrowserLogin(browserStartRequest('77') as never, right as never),
    ])
    expect(one.ok).toBe(true)
    expect(two.ok).toBe(true)
    expect((await query<{ n: number }>('SELECT count(*)::int AS n FROM plm_managed_browser_intents')).rows[0].n).toBe(2)
    await resetRows()
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    await insertOwnedSource('source-dup', OWNER)
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody({ dataSourceId: 'source-dup' }))
    const refused = await Promise.allSettled([
      startManagedBrowserLogin(browserStartRequest('42') as never, responseDouble() as never),
      startManagedBrowserLogin(browserStartRequest('42') as never, responseDouble() as never),
    ])
    expect(refused.every((item) => item.status === 'rejected' && (item.reason as { code?: string }).code === 'PLM_MANAGED_LINK_AMBIGUOUS')).toBe(true)
    expect((await query<{ n: number }>('SELECT count(*)::int AS n FROM plm_managed_browser_intents')).rows[0].n).toBe(0)
  })

  it('returns a non-credential current snapshot and revokes an expired or flag-off cookie', async () => {
    installNative()
    const started = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(started.res, started.state) as never, done as never)
    const sessionCookie = done.cookies[MANAGED_SESSION_COOKIE].value
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      if (isGateException(req.path)) return next()
      return jwtAuthMiddleware(req, res, next)
    })
    app.use('/api/auth', authRouter)
    app.use('/api/plm/managed-login', managedLoginRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const port = (server.address() as { port: number }).port
    const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, text: await response.text(), setCookie: response.headers.get('set-cookie') ?? '' }
    }
    try {
      const current = await call('GET', '/api/plm/managed-login/current', { cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie}` })
      const payload = JSON.parse(current.text) as {
        data: {
          user: {
            id: string
            email: string | null
            name: string
            role: string
            permissions: string[]
            tenantId: string | null
            must_change_password: boolean
          }
          features: { plm: boolean }
          managedSession: Record<string, unknown>
        }
      }
      expect(current.status).toBe(200)
      expect(payload.data.user).toEqual({
        id: OWNER,
        email: `${OWNER}@example.test`,
        name: OWNER,
        role: 'user',
        permissions: [],
        tenantId: TENANT,
        must_change_password: false,
      })
      expect(payload.data.features.plm).toBe(true)
      expect(payload.data.managedSession).toMatchObject({
        mode: 'managed-cookie',
        userId: OWNER,
        tenantId: TENANT,
        revision: 1,
        continuityMode: 'ordinary',
        credentialGeneration: null,
      })
      expect(Object.keys(payload.data.managedSession).sort()).toEqual([
        'continuityMode', 'credentialGeneration', 'expiresAt', 'mode', 'revision', 'sessionId', 'tenantId', 'userId',
      ])
      expect(typeof payload.data.managedSession.sessionId).toBe('string')
      expect(typeof payload.data.managedSession.expiresAt).toBe('string')
      expect(current.text).not.toMatch(/yur_|code_verifier|clientSecret|client_secret|eyJ/)
      nativeActive = false
      const closed = await call('GET', '/api/plm/managed-login/current', { cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie}` })
      expect(closed.status).toBe(401)
      expect(closed.text).not.toMatch(/yur_/)
      nativeActive = true
      const wrongMethod = await call('POST', '/api/plm/managed-login/current', { cookie: `${MANAGED_SESSION_COOKIE}=${sessionCookie}` }, {})
      expect(wrongMethod.status).toBe(405)
      const sessionsBefore = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions')
      const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
      const expired = jwt.sign({
        userId: OWNER,
        email: 'meta-owner@example.test',
        role: 'user',
        tenantId: TENANT,
        sid: payload.data.managedSession.sessionId,
        purpose: MANAGED_COMPANION_PURPOSE,
        exp: Math.floor(Date.now() / 1000) - 60,
      }, secret)
      const expiredCurrent = await call('GET', '/api/plm/managed-login/current', { cookie: `${MANAGED_SESSION_COOKIE}=${expired}` })
      expect(expiredCurrent.status).toBe(401)
      process.env.PLM_MANAGED_COMPANION_ENABLED = 'false'
      const loggedOut = await call('POST', '/api/plm/managed-login/logout', {
        cookie: `${MANAGED_SESSION_COOKIE}=${expired}`,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-metasheet-managed-bridge': 'logout',
      }, {})
      expect(loggedOut.status).toBe(200)
      expect(JSON.parse(loggedOut.text)).toEqual({ ok: true, revoked: true })
      expect(loggedOut.setCookie).toContain(MANAGED_SESSION_COOKIE)
      expect(loggedOut.setCookie).not.toContain(expired)
      expect(loggedOut.text).not.toMatch(/yur_|eyJ/)
      const revoked = await query<{ revoked_at: string | null }>('SELECT revoked_at FROM plm_managed_sessions')
      expect(revoked.rows[0].revoked_at).toBeTruthy()
      const sessionsAfter = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_sessions')
      expect(sessionsAfter.rows[0].n).toBe(sessionsBefore.rows[0].n)
    } finally {
      server.close()
      enable()
    }
  })

  it('keeps ordinary owner start behind the actor and exposes only exact public methods', async () => {
    installNative()
    await provisionManagedLink({ id: OWNER, role: 'user', authenticatedTenantId: TENANT }, provisionBody())
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      if (isGateException(req.path)) return next()
      return jwtAuthMiddleware(req, res, next)
    })
    app.use('/api/plm/managed-login', managedLoginRouter)
    const server = await new Promise<Server>((resolve) => {
      const listening = createServer(app).listen(0, '127.0.0.1', () => resolve(listening))
    })
    const port = (server.address() as { port: number }).port
    try {
      const anonymousStart = await fetch(`http://127.0.0.1:${port}/api/plm/managed-login/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataSourceId: SOURCE, rootPartId: 'part' }),
      })
      expect(anonymousStart.status).toBe(401)
      process.env.RBAC_TOKEN_TRUST = 'true'
      const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
      const owner = jwt.sign({
        userId: OWNER, email: 'meta-owner@example.test', role: 'user', tenantId: TENANT,
      }, secret, { expiresIn: '5m' })
      const owned = await fetch(`http://127.0.0.1:${port}/api/plm/managed-login/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
        body: JSON.stringify({ dataSourceId: SOURCE, rootPartId: 'part' }),
      })
      const ownedBody = await owned.json() as { ok?: boolean; navigationUrl?: string }
      expect(owned.status).toBe(200)
      expect(ownedBody.ok).toBe(true)
      expect(String(ownedBody.navigationUrl)).toContain('/managed-login')
      const publicStart = await fetch(`http://127.0.0.1:${port}/api/plm/managed-login/browser-start`, {
        method: 'GET',
      })
      expect(publicStart.status).toBe(405)
      const callback = await fetch(`http://127.0.0.1:${port}/api/plm/managed-login/callback?code=one&state=two`, { redirect: 'manual' })
      expect(callback.status).toBe(302)
      expect(callback.headers.get('location')).toContain('/plm/managed-return?')
      expect(nativeCalls.filter((call) => call.url.endsWith('/exchange'))).toHaveLength(0)
    } finally {
      delete process.env.RBAC_TOKEN_TRUST
      server.close()
    }
  })

  it('refuses down while evidence remains and allows it when empty', async () => {
    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    await pool.query('CREATE SCHEMA IF NOT EXISTS managed_down')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS managed_down.users (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS managed_down.data_sources (id text PRIMARY KEY);
    `)
    await pool.query('INSERT INTO managed_down.users VALUES ($1) ON CONFLICT DO NOTHING', [OWNER])
    await pool.query('INSERT INTO managed_down.data_sources VALUES ($1) ON CONFLICT DO NOTHING', [SOURCE])
    const scoped = new Pool({ connectionString: pgUrl, max: 1, options: '-c search_path=managed_down' })
    const db = new Kysely({ dialect: new PostgresDialect({ pool: scoped }) })
    await up(db)
    await scoped.query(
      `INSERT INTO plm_managed_identity_links (
         id, installation_issuer, native_auth_user_id, native_tenant_id, native_org_id, client_id, callback,
         meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id, client_origin, generation,
         status, owner_user_id, created_by, source_fingerprint
       ) VALUES (
         'evidence', $1, '42', 'default', 'fixture-org', 'managed-fixture', $2,
         $3, $4, $5, $6, 'part', $7, 1, 'active', $3, $3, $8
       )`,
      [ISSUER, CALLBACK, OWNER, TENANT, ORG, SOURCE, ORIGIN, 'a'.repeat(64)],
    )
    await expect(down(db)).rejects.toThrow(/plm_managed_companion_evidence_present/)
    await scoped.query('DELETE FROM plm_managed_identity_links')
    await down(db)
    await scoped.end()
    await pool.query('DROP SCHEMA managed_down CASCADE')
    await pool.end()
  })
})

async function blockedBy(holderPid: number): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const found = await query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    )
    if (found.rows.some((row) => (row.blockers as number[]).map(Number).includes(holderPid))) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}


describe('live advisory through real persistent managed sessions', () => {
  function advisory(entitled = true) {
    return { provider: 'yuantus-plm', schema_version: 'v1', advisory: true, features: {
      bom_eco_revision: { supported: true, entitled, actions: ['eco_revision_intent'] },
    } }
  }
  async function currentRead() {
    const { res, state } = await beginLogin()
    const done = responseDouble()
    await completeManagedCallback(callbackRequest(res, state) as never, done as never)
    expect(done.statusCode).toBe(302)
    const sessions = await countSessions()
    expect(sessions).toHaveLength(1)
    const adapter = new PLMAdapter({ get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { id: SOURCE, name: 'owned', type: 'plm', connection: { url: ORIGIN },
        credentials: { token: 'shared-control-must-not-be-used' } } as never)
    return { read: () => managedRequestContext.run({ userId: OWNER,
      sessionId: String(sessions[0].id), metaTenantId: TENANT, conflict: false },
      () => adapter.getIntegrationCapabilities()), sessionId: String(sessions[0].id) }
  }

  it('reads live advisory without shared fallback and observes license changes', async () => {
    let entitled = true
    installNative(() => advisory(entitled))
    const { read } = await currentRead()
    const first = await read()
    expect(first.available).toBe(true)
    if (!first.available) throw Error('authenticated advisory missing')
    expect(first.manifest.features.bom_eco_revision?.entitled).toBe(true)
    entitled = false
    expect((await read()).manifest?.features.bom_eco_revision?.entitled).toBe(false)
    expect(nativeCalls.filter(call => call.url.includes('/managed-context'))).toHaveLength(2)
    expect(nativeCalls.some(call => call.url.includes('/integrations/capabilities'))).toBe(false)
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it('rejects live advisory after concurrent owner transfer from another Node process', async () => {
    let reached!: () => void
    let release!: () => void
    const arrived = new Promise<void>(resolve => { reached = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    installNative(() => advisory(), async () => { reached(); await held })
    const { read } = await currentRead()
    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const pending = read()
    try {
      await arrived
      const parentBackend = Number((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const child = String.raw`const {Client}=require('pg');(async()=>{
        const raw=process.env.PLM_MANAGED_COMPANION_TEST_PG_URL;
        if(!raw||!new URL(raw).searchParams.get('host')?.startsWith('/tmp/plm-managed-consumer-pg-'))throw Error('owned_socket_required');
        const c=new Client({connectionString:raw});await c.connect();try{
          const backend=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const changed=await c.query('UPDATE data_sources SET owner_id=$1 WHERE id=$2',[process.argv[1],process.argv[2]]);
          console.log(JSON.stringify({pid:process.pid,backend,rowCount:changed.rowCount}));
        }finally{await c.end()}
      })().catch(()=>{process.stderr.write('owned_mutator_failed');process.exitCode=1})`
      const changed = JSON.parse(execFileSync(process.execPath, ['-e', child, OTHER, SOURCE], {
        encoding: 'utf8', env: { ...process.env }, timeout: 10000,
      })) as { pid: number; backend: number; rowCount: number }
      expect(changed.pid).not.toBe(process.pid)
      expect(changed.backend).not.toBe(parentBackend)
      expect(changed.rowCount).toBe(1)
      release()
      expect(await pending).toEqual({ available: false, reason: 'unavailable' })
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      release()
      await pending
      await pool.query('UPDATE data_sources SET owner_id=$1 WHERE id=$2', [OWNER, SOURCE])
      await pool.end()
    }
  })

  it('rejects live advisory after concurrent unlink and keeps the local revoke durable', async () => {
    let reached!: () => void
    let release!: () => void
    const arrived = new Promise<void>(resolve => { reached = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    installNative(() => advisory(), async () => { reached(); await held })
    const { read, sessionId } = await currentRead()
    const pending = read()
    try {
      await arrived
      await unlinkManagedSource({ id: OWNER, authenticatedTenantId: TENANT }, { dataSourceId: SOURCE })
      release()
      expect(await pending).toEqual({ available: false, reason: 'unavailable' })
      expect((await query('SELECT revoked_at FROM plm_managed_sessions WHERE id=$1', [sessionId])).rows[0].revoked_at).not.toBeNull()
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      release()
      await pending
    }
  })

  it('degrades live advisory for an older provider while its authenticated read remains usable', async () => {
    installNative()
    const { read, sessionId } = await currentRead()
    expect(await read()).toEqual({ available: false, reason: 'unavailable' })
    const context = await managedRequestContext.run({ userId: OWNER, sessionId, conflict: false },
      () => relayManagedBomContext({ userId: OWNER, dataSourceId: SOURCE, partId: 'part' }))
    expect(context).toMatchObject({ kind: 'ok', entitled: true })
    expect(readSharedTransportAudit().calls).toBe(0)
  })
})

function nativeHold() {
  let signal!: () => void
  let resume!: () => void
  const arrived = new Promise<void>((resolve) => { signal = resolve })
  const held = new Promise<void>((resolve) => { resume = resolve })
  let opened = false
  return {
    arrived,
    beforeContext: async () => {
      signal()
      await held
    },
    release() {
      if (opened) return
      opened = true
      resume()
    },
  }
}

async function loggedBomRead(beforeContext?: () => Promise<void>) {
  installNative(undefined, beforeContext)
  const started = await beginLogin()
  const done = responseDouble()
  await completeManagedCallback(callbackRequest(started.res, started.state) as never, done as never)
  expect(done.statusCode).toBe(302)
  const sessions = await countSessions()
  expect(sessions).toHaveLength(1)
  const sessionId = String(sessions[0].id)
  const read = () => managedRequestContext.run(
    { userId: OWNER, sessionId, metaTenantId: TENANT, conflict: false },
    () => relayManagedBomContext({ userId: OWNER, dataSourceId: SOURCE, partId: 'part' }),
  )
  return { sessionId, read }
}

async function sourceSnapshot() {
  const row = (await query(
    'SELECT owner_id, config, tenant_id, workspace_id, scope_kind FROM data_sources WHERE id = $1',
    [SOURCE],
  )).rows[0]
  return row
}

async function restoreSource(row: Record<string, unknown>) {
  await query(
    `UPDATE data_sources
     SET owner_id = $2, config = $3::jsonb, tenant_id = $4, workspace_id = $5, scope_kind = $6
     WHERE id = $1`,
    [SOURCE, row.owner_id, JSON.stringify(row.config), row.tenant_id, row.workspace_id, row.scope_kind],
  )
}

async function insertClone(table: 'plm_managed_browser_intents' | 'plm_managed_sessions', row: Record<string, unknown>, overrides: Record<string, unknown>) {
  const columns = Object.keys(row).filter((column) => /^[a-z_]+$/.test(column))
  const values = columns.map((column) => (Object.hasOwn(overrides, column) ? overrides[column] : row[column]))
  await query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  )
}

async function holdActiveLink() {
  const client = new Client({ connectionString: pgUrl })
  await client.connect()
  await client.query('BEGIN')
  const locked = await client.query(
    `SELECT id FROM plm_managed_identity_links WHERE data_source_id = $1 AND status = 'active' FOR UPDATE`,
    [SOURCE],
  )
  if (locked.rowCount !== 1) {
    await client.query('ROLLBACK')
    await client.end()
    throw new Error(`expected one active link, got ${locked.rowCount}`)
  }
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  let closed = false
  return {
    client,
    pid,
    async commit() {
      if (closed) return
      closed = true
      await client.query('COMMIT')
      await client.end()
    },
    async rollback() {
      if (closed) return
      closed = true
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end().catch(() => undefined)
    },
  }
}

describe('direct managed BOM publication', () => {
  async function held(mutate: () => Promise<void>) {
    const hold = nativeHold()
    const { read } = await loggedBomRead(hold.beforeContext)
    const pending = read()
    try {
      await hold.arrived
      await mutate()
      hold.release()
      const result = await pending
      expect(result.kind).not.toBe('legacy')
      expect(readSharedTransportAudit().calls).toBe(0)
      return result
    } finally {
      hold.release()
      await pending.catch(() => undefined)
    }
  }

  async function heldLock(mutate: (client: Client) => Promise<void>) {
    const hold = nativeHold()
    const { read } = await loggedBomRead(hold.beforeContext)
    const pending = read()
    let holder: Awaited<ReturnType<typeof holdActiveLink>> | null = null
    try {
      await hold.arrived
      holder = await holdActiveLink()
      hold.release()
      expect(await blockedBy(holder.pid)).toBe(true)
      await mutate(holder.client)
      await holder.commit()
      holder = null
      const result = await pending
      expect(result.kind).not.toBe('legacy')
      expect(readSharedTransportAudit().calls).toBe(0)
      return result
    } finally {
      hold.release()
      await holder?.rollback()
      await pending.catch(() => undefined)
    }
  }

  it('publishes the unchanged frozen context', async () => {
    const { read } = await loggedBomRead()
    const result = await read()
    expect(result).toMatchObject({ kind: 'ok', entitled: true })
    if (result.kind !== 'ok') throw new Error('unchanged context missing')
    expect((result.context as { lines: Array<{ bom_line_id: string }> }).lines[0].bom_line_id).toBe('line')
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it('publishes the same context after the native response and the publication lock wait', async () => {
    const network = await held(async () => undefined)
    expect(network).toMatchObject({ kind: 'ok', entitled: true })
    await resetRows()
    const locked = await heldLock(async () => undefined)
    expect(locked).toMatchObject({ kind: 'ok', entitled: true })
  })

  async function heldSource(mutate: () => Promise<void>) {
    const hold = nativeHold()
    const { read } = await loggedBomRead(hold.beforeContext)
    const pending = read()
    const client = new Client({ connectionString: pgUrl })
    let open = false
    try {
      await hold.arrived
      await client.connect()
      open = true
      await client.query('BEGIN')
      await client.query('SELECT id FROM data_sources WHERE id = $1 FOR UPDATE', [SOURCE])
      const holderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      hold.release()
      expect(await blockedBy(holderPid), 'publication must wait on the source row').toBe(true)
      await mutate()
      await client.query('COMMIT')
      open = false
      const result = await pending
      expect(result.kind).not.toBe('legacy')
      expect(readSharedTransportAudit().calls).toBe(0)
      return result
    } finally {
      hold.release()
      if (open) await client.query('ROLLBACK').catch(() => undefined)
      await client.end().catch(() => undefined)
      await pending.catch(() => undefined)
    }
  }

  it('publishes when the source lock clears and the source is unchanged', async () => {
    const result = await heldSource(async () => undefined)
    expect(result).toMatchObject({ kind: 'ok', entitled: true })
    if (result.kind !== 'ok') throw new Error('unchanged source wait missing')
    expect((result.context as { lines: Array<{ bom_line_id: string }> }).lines[0].bom_line_id).toBe('line')
  })

  it('refuses membership removed while publication waits on the source row', async () => {
    try {
      const result = await heldSource(async () => {
        const changed = await query(
          'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2',
          [OWNER, ORG],
        )
        expect(changed.rowCount).toBe(1)
      })
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' })
    } finally {
      await query('UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])
    }
  })

  it('refuses an owner transfer committed by another Node process during the native response', async () => {
    const original = await sourceSnapshot()
    const hold = nativeHold()
    const { read } = await loggedBomRead(hold.beforeContext)
    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const pending = read()
    try {
      await hold.arrived
      const parentBackend = Number((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const child = String.raw`const {Client}=require('pg');(async()=>{
        const raw=process.env.PLM_MANAGED_COMPANION_TEST_PG_URL;
        if(!raw||!new URL(raw).searchParams.get('host')?.startsWith('/tmp/plm-managed-consumer-pg-'))throw Error('owned_socket_required');
        const c=new Client({connectionString:raw});await c.connect();try{
          const backend=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const changed=await c.query('UPDATE data_sources SET owner_id=$1 WHERE id=$2',[process.argv[1],process.argv[2]]);
          console.log(JSON.stringify({pid:process.pid,backend,rowCount:changed.rowCount}));
        }finally{await c.end()}
      })().catch(()=>{process.stderr.write('owned_mutator_failed');process.exitCode=1})`
      const changed = JSON.parse(execFileSync(process.execPath, ['-e', child, OTHER, SOURCE], {
        encoding: 'utf8', env: { ...process.env }, timeout: 10000,
      })) as { pid: number; backend: number; rowCount: number }
      expect(changed.pid).not.toBe(process.pid)
      expect(changed.backend).not.toBe(parentBackend)
      expect(changed.rowCount).toBe(1)
      hold.release()
      await expect(pending).resolves.toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SOURCE_REFUSED' })
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      hold.release()
      await pending.catch(() => undefined)
      await restoreSource(original)
      await pool.end()
    }
  })

  it.each([
    ['config', `UPDATE data_sources SET config = $2::jsonb WHERE id = $1`, JSON.stringify({ connection: { url: 'http://127.0.0.1:8/plm' } }), 'PLM_MANAGED_SOURCE_REFUSED'],
    ['scope_kind', `UPDATE data_sources SET scope_kind = $2 WHERE id = $1`, 'workspace', 'PLM_MANAGED_SOURCE_CHANGED'],
    ['tenant_id', `UPDATE data_sources SET tenant_id = $2 WHERE id = $1`, 'moved-tenant', 'PLM_MANAGED_SOURCE_CHANGED'],
    ['workspace_id', `UPDATE data_sources SET workspace_id = $2 WHERE id = $1`, 'moved-workspace', 'PLM_MANAGED_SOURCE_CHANGED'],
  ] as const)('refuses a %s change committed during the native response', async (_name, sql, value, code) => {
    const original = await sourceSnapshot()
    try {
      const result = await held(() => query(sql, [SOURCE, value]))
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code })
    } finally {
      await restoreSource(original)
    }
  })

  it.each([
    ['config', `UPDATE data_sources SET config = $2::jsonb WHERE id = $1`, JSON.stringify({ connection: { url: 'http://127.0.0.1:8/plm' } }), 'PLM_MANAGED_SOURCE_REFUSED'],
    ['scope_kind', `UPDATE data_sources SET scope_kind = $2 WHERE id = $1`, 'workspace', 'PLM_MANAGED_SOURCE_CHANGED'],
    ['tenant_id', `UPDATE data_sources SET tenant_id = $2 WHERE id = $1`, 'moved-tenant', 'PLM_MANAGED_SOURCE_CHANGED'],
    ['workspace_id', `UPDATE data_sources SET workspace_id = $2 WHERE id = $1`, 'moved-workspace', 'PLM_MANAGED_SOURCE_CHANGED'],
  ] as const)('refuses a %s change committed while the publication lock is held', async (_name, sql, value, code) => {
    const original = await sourceSnapshot()
    try {
      const result = await heldLock((client) => client.query(sql, [SOURCE, value]).then(() => undefined))
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code })
    } finally {
      await restoreSource(original)
    }
  })

  it('refuses an owner change committed while the publication lock is held', async () => {
    const original = await sourceSnapshot()
    try {
      const result = await heldLock(async (client) => {
        const changed = await client.query('UPDATE data_sources SET owner_id = $1 WHERE id = $2', [OTHER, SOURCE])
        expect(changed.rowCount).toBe(1)
      })
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SOURCE_REFUSED' })
    } finally {
      await restoreSource(original)
    }
  })

  async function stopLockedLink(client: Client) {
    const stopped = await client.query(
      `UPDATE plm_managed_identity_links
       SET status = 'revoked', stopped_at = clock_timestamp(), stop_reason = 'revoked', updated_at = clock_timestamp()
       WHERE data_source_id = $1 AND status = 'active'`,
      [SOURCE],
    )
    expect(stopped.rowCount).toBe(1)
    await client.query(
      `UPDATE plm_managed_source_bindings
       SET status = 'blocked', updated_at = clock_timestamp()
       WHERE data_source_id = $1 AND status = 'active'`,
      [SOURCE],
    )
    await client.query(
      `UPDATE plm_managed_sessions SET revoked_at = clock_timestamp()
       WHERE data_source_id = $1 AND revoked_at IS NULL`,
      [SOURCE],
    )
  }

  it('refuses unlink during the native response without becoming legacy', async () => {
    const result = await held(() => unlinkManagedSource(
      { id: OWNER, authenticatedTenantId: TENANT },
      { dataSourceId: SOURCE },
    ).then(() => undefined))
    expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_LINK_STOPPED' })
  })

  it('refuses unlink committed while the publication lock is held', async () => {
    const result = await heldLock(stopLockedLink)
    expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_LINK_STOPPED' })
  })

  it('refuses a deleted binding during the native response without becoming legacy', async () => {
    const result = await held(async () => {
      const removed = await query('DELETE FROM plm_managed_source_bindings WHERE data_source_id = $1', [SOURCE])
      expect(removed.rowCount).toBe(1)
    })
    expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_READ_REFUSED' })
  })

  it('refuses session revoke during the native response and while the publication lock is held', async () => {
    const duringNetwork = await held(() => query(
      'UPDATE plm_managed_sessions SET revoked_at = clock_timestamp() WHERE revoked_at IS NULL',
    ).then(() => undefined))
    expect(duringNetwork).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    await resetRows()
    const duringLock = await heldLock(async (client) => {
      const revoked = await client.query(
        'UPDATE plm_managed_sessions SET revoked_at = clock_timestamp() WHERE data_source_id = $1 AND revoked_at IS NULL',
        [SOURCE],
      )
      expect(revoked.rowCount).toBe(1)
    })
    expect(duringLock).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
  })

  async function expireFrozenSession(client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> }, sessionId?: string) {
    await client.query('ALTER TABLE plm_managed_sessions DISABLE TRIGGER plm_managed_sessions_guard')
    try {
      const expired = await client.query(
        `UPDATE plm_managed_sessions
         SET created_at = clock_timestamp() - interval '2 minutes',
             expires_at = clock_timestamp() - interval '1 second'
         WHERE revoked_at IS NULL ${sessionId ? 'AND id = $1' : ''}`,
        sessionId ? [sessionId] : [],
      )
      expect(expired.rowCount).toBe(1)
    } finally {
      await client.query('SET CONSTRAINTS plm_managed_sessions_successor_commit IMMEDIATE')
      await client.query('ALTER TABLE plm_managed_sessions ENABLE TRIGGER plm_managed_sessions_guard')
    }
  }

  it('refuses session expiry committed during the native response', async () => {
    try {
      const result = await held(() => expireFrozenSession({ query }))
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    } finally {
      await query('ALTER TABLE plm_managed_sessions ENABLE TRIGGER plm_managed_sessions_guard')
    }
  })

  it('refuses session expiry committed while the publication lock is held', async () => {
    try {
      const result = await heldLock((client) => expireFrozenSession(client))
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    } finally {
      await query('ALTER TABLE plm_managed_sessions ENABLE TRIGGER plm_managed_sessions_guard')
    }
  })

  it('refuses a native tenant swapped for the Meta tenant during the native response', async () => {
    const result = await held(() => query(
      `UPDATE plm_managed_sessions SET native_tenant_id = $1 WHERE native_tenant_id = 'default'`,
      [TENANT],
    ).then(() => undefined))
    expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_IDENTITY_REFUSED' })
  })

  it('refuses a membership removed during the native response', async () => {
    try {
      const result = await held(() => query(
        'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2',
        [OWNER, TENANT],
      ).then(() => undefined))
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' })
    } finally {
      await query('UPDATE user_orgs SET is_active = true WHERE user_id = $1', [OWNER])
    }
  })

  it.each(['false', 'TRUE', '0', '', 'unset'])('does not publish or use shared transport when the flag becomes %s during the native response', async (flag) => {
    try {
      const result = await held(async () => {
        if (flag === 'unset') delete process.env.PLM_MANAGED_COMPANION_ENABLED
        else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
      })
      expect(result).toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_DISABLED' })
    } finally {
      enable()
    }
  })

  it('does not substitute a later live session after the frozen session is revoked', async () => {
    const hold = nativeHold()
    const { read, sessionId } = await loggedBomRead(hold.beforeContext)
    const intent = (await query('SELECT * FROM plm_managed_browser_intents')).rows[0]
    const session = (await query('SELECT * FROM plm_managed_sessions WHERE id = $1', [sessionId])).rows[0]
    await insertClone('plm_managed_browser_intents', intent, {
      id: 'intent-later-read',
      state_hash: 'e'.repeat(64),
      nonce_hash: 'a'.repeat(64),
      code_challenge: 'b'.repeat(43),
      delegation_id: null,
      credential_ciphertext: null,
    })
    await insertClone('plm_managed_sessions', session, {
      id: 'session-later-read',
      intent_id: 'intent-later-read',
      delegation_id: 'del-later-read',
      revoked_at: null,
    })
    const pending = read()
    try {
      await hold.arrived
      const revoked = await query(
        'UPDATE plm_managed_sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL',
        [sessionId],
      )
      expect(revoked.rowCount).toBe(1)
      hold.release()
      await expect(pending).resolves.toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
      expect((await query('SELECT revoked_at FROM plm_managed_sessions WHERE id = $1', ['session-later-read'])).rows[0].revoked_at).toBeNull()
      expect(readSharedTransportAudit().calls).toBe(0)
    } finally {
      hold.release()
      await pending.catch(() => undefined)
    }
  })
})


async function personalReadHandoff(run:()=>Promise<void>, options:Record<string,unknown>={}) {
  const keys=['PLM_PERSONAL_BOM_CHANGE_READ_ENABLED','PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID','PLM_APPROVAL_CARD_CONNECTION_ID']
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]))
  const original=(await query('SELECT config FROM data_sources WHERE id=$1',[SOURCE])).rows[0].config
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='true'
  delete process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID
  const config={connection:{url:ORIGIN},credentials:{token:'enc:owned-unusable-shared'},options:{apiMode:'yuantus',tenantId:'default',orgId:'fixture-org',kept:'unchanged',...options}}
  try {await query('UPDATE data_sources SET config=$2::jsonb WHERE id=$1',[SOURCE,JSON.stringify(config)]);await run()}
  finally {await query('UPDATE data_sources SET config=$2::jsonb WHERE id=$1',[SOURCE,JSON.stringify(original)]);for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]}}
}
const provisionPersonalRead=()=>provisionManagedLink({id:OWNER,authenticatedTenantId:TENANT},provisionBody())
const personalReadSource=async()=>(await query('SELECT config FROM data_sources WHERE id=$1',[SOURCE])).rows[0].config
it('personal read handoff seeds only the explicit Native connection in the actual link transaction',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='native-personal-read'
  const before=await personalReadSource();expect(await provisionPersonalRead()).toMatchObject({generation:1})
  expect(await personalReadSource()).toEqual({...before,options:{...before.options,personalChangeReadConnectionId:'native-personal-read'}})
  expect(nativeCalls).toHaveLength(0)
  const link=(await query('SELECT native_auth_user_id,meta_user_id FROM plm_managed_identity_links')).rows[0]
  expect(link).toEqual({native_auth_user_id:'42',meta_user_id:OWNER})
 })
})
it('personal read handoff keeps existing persisted connection without an environment fallback',async()=>{
 await personalReadHandoff(async()=>{
  const before=await personalReadSource();expect(await provisionPersonalRead()).toMatchObject({generation:1});expect(await personalReadSource()).toEqual(before)
 },{personalChangeReadConnectionId:'persisted-native-id'})
})
it('personal read handoff refuses using the approval connection setting when dedicated source identity is missing',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_APPROVAL_CARD_CONNECTION_ID='approval-setting-is-not-read-config'
  const before=await personalReadSource();await expect(provisionPersonalRead()).rejects.toMatchObject({code:'PLM_CHANGE_READ_CONFIGURATION_REQUIRED'})
  expect(await personalReadSource()).toEqual(before);expect((await query('SELECT * FROM plm_managed_identity_links')).rows).toHaveLength(0)
 })
})
it('personal read handoff refuses replacing a persisted connection from install settings',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='different-native-id'
  const before=await personalReadSource();await expect(provisionPersonalRead()).rejects.toMatchObject({code:'PLM_CHANGE_READ_CONFIGURATION_REQUIRED'});expect(await personalReadSource()).toEqual(before)
 },{personalChangeReadConnectionId:'original-native-id'})
})
it.each(['false','TRUE','1',''])('personal read handoff flag %s preserves legacy provisioning bytes',async flag=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED=flag;process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='not-copied'
  const before=await personalReadSource();expect(await provisionPersonalRead()).toMatchObject({generation:1});expect(await personalReadSource()).toEqual(before)
 })
})
it.each([{tenantId:'meta-tenant'},{orgId:'meta-org'}])('personal read handoff checks Native scope separately from Meta scope %#',async options=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='native-id';await expect(provisionPersonalRead()).rejects.toMatchObject({code:'PLM_CHANGE_READ_CONFIGURATION_REQUIRED'})
  expect((await query('SELECT * FROM plm_managed_identity_links')).rows).toHaveLength(0)
 },options)
})
it('personal read handoff rejects an opaque grant pasted as a connection identifier',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='yue_'+'a'.repeat(32)+'_'+'b'.repeat(43)
  const before=await personalReadSource();await expect(provisionPersonalRead()).rejects.toMatchObject({code:'PLM_CHANGE_READ_CONFIGURATION_REQUIRED'});expect(await personalReadSource()).toEqual(before)
 })
})
it('personal read handoff serializes concurrent provisioning without overwriting source options',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='native-id'
  const results=await Promise.allSettled([provisionPersonalRead(),provisionPersonalRead()])
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((results.find(x=>x.status==='rejected')as PromiseRejectedResult).reason.status).toBe(409)
  expect((await personalReadSource()).options).toEqual({apiMode:'yuantus',tenantId:'default',orgId:'fixture-org',kept:'unchanged',personalChangeReadConnectionId:'native-id'})
 })
})
it('personal read handoff rolls its seed back when the actual link insert fails',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='native-id';const before=await personalReadSource()
  await query("CREATE FUNCTION owned_read_handoff_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_link_insert_fault'; END $$;CREATE TRIGGER owned_read_handoff_abort BEFORE INSERT ON plm_managed_identity_links FOR EACH ROW EXECUTE FUNCTION owned_read_handoff_abort()")
  try {await expect(provisionPersonalRead()).rejects.toThrow('owned_link_insert_fault');expect(await personalReadSource()).toEqual(before)}
  finally {await query('DROP TRIGGER owned_read_handoff_abort ON plm_managed_identity_links;DROP FUNCTION owned_read_handoff_abort()')}
 })
})

it('personal read handoff preserves the Visual source platform-admin configuration boundary',async()=>{
 await personalReadHandoff(async()=>{
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID='native-id';const before=await personalReadSource()
  await expect(provisionPersonalRead()).rejects.toMatchObject({code:'PLM_CHANGE_READ_CONFIGURATION_REQUIRED'});expect(await personalReadSource()).toEqual(before)
 },{visualReviewEnabled:true})
})
