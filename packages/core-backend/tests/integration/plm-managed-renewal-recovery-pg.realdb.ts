/**
 * Real PostgreSQL proof for durable same-key renewal recovery.
 * The native fetch override is process-local. It is not a native cross-process
 * result, a browser session, or a wall-clock hour.
 * Simultaneous recovery requests are two calls in this process. The allocation
 * versus unlink case uses separate SQL connections.
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { isGateException } from '../../src/auth/api-path-policy'
import { verifyManagedCompanionToken } from '../../src/auth/plm-managed-session'
import { up, down } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up as continuousUp } from '../../src/db/migrations/zzzz20261022010000_plm_managed_continuous_completion'
import { down as renewalDown, up as renewalUp } from '../../src/db/migrations/zzzz20261022020000_plm_managed_renewal_recovery'
import { query } from '../../src/db/pg'
import managedLoginRouter from '../../src/routes/plm-managed-companion'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import {
  MANAGED_COMPANION_PURPOSE,
  MANAGED_INTENT_COOKIE,
  MANAGED_NONCE_COOKIE,
  MANAGED_SESSION_COOKIE,
  openCredential,
  readSharedTransportAudit,
  sealCredential,
} from '../../src/services/plm-managed-companion'
import {
  completeManagedBrowserLogin,
  provisionManagedLink,
  recoverManagedContinuousSession,
  RENEWAL_DELEGATION_LOCK_PREFIX,
  retryManagedRevoke,
  setManagedFlowHooksForTests,
  startManagedLogin,
  unlinkManagedSource,
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
const RENEW_KEYS = ['client_id', 'client_secret', 'credential', 'idempotency_key']

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
  credential?: string
}

const nativeCalls: NativeCall[] = []
let exchangeSpec: CredentialSpec = {
  jti: 'jti-pred',
  exp: Math.floor(Date.now() / 1000) + 90,
  delegationId: 'del-pred',
  expiresIn: 15,
  generationIndex: 0,
}
let successorSpec: CredentialSpec = {
  jti: 'jti-succ',
  exp: Math.floor(Date.now() / 1000) + 240,
  delegationId: 'del-succ',
  expiresIn: 15,
  generationIndex: 1,
}
let renewMode: 'ok' | 'unauthorized' | 'unavailable' | 'reset' = 'ok'

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
  return {
    subject: spec.subject ?? '42',
    tenant_id: spec.tenantId ?? 'default',
    org_id: spec.orgId ?? 'fixture-org',
    client_id: 'managed-fixture',
    issuer: ISSUER,
    scope: 'bom_review_read',
    delegation_id: spec.delegationId,
    expires_in: spec.expiresIn ?? 15,
    credential: spec.credential ?? yur(spec),
    root_part_id: spec.rootPartId ?? 'part',
    client_origin: spec.clientOrigin ?? ORIGIN,
    credential_jti: spec.credentialJti ?? spec.jti,
    generation_index: spec.generationIndex ?? 0,
  }
}

function installFetch(): void {
  setManagedNativeFetchForTests(async (url, init) => {
    const href = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    nativeCalls.push({ url: href, body })
    if (href.endsWith('/exchange-continuous')) return Response.json(continuousJson(exchangeSpec))
    if (href.endsWith('/renew')) {
      if (renewMode === 'reset') throw new Error('process-local socket reset')
      if (renewMode === 'unavailable') return new Response('unavailable', { status: 503 })
      if (renewMode === 'unauthorized') {
        return new Response(JSON.stringify({ detail: 'Invalid authorization code' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return Response.json(continuousJson(successorSpec))
    }
    if (href.endsWith('/status')) return new Response(null, { status: 401 })
    if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
    return new Response('missing', { status: 404 })
  })
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
    continuityMode: 'hour',
    ...overrides,
  }
}

function secret(): string {
  return resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
}

function epoch(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value))
  return Math.floor(date.getTime() / 1000)
}

function renewCalls(): NativeCall[] {
  return nativeCalls.filter((call) => call.url.endsWith('/renew'))
}

async function resetRows(): Promise<void> {
  const client = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-reset' })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM plm_managed_renewal_operations')
    await client.query('DELETE FROM plm_managed_revoke_outbox')
    await client.query('DELETE FROM plm_managed_sessions')
    await client.query('DELETE FROM plm_managed_browser_intents')
    await client.query('DELETE FROM plm_managed_source_bindings')
    await client.query('DELETE FROM plm_managed_identity_links')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
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

async function intentNotNull(): Promise<boolean> {
  const found = await query<{ attnotnull: boolean }>(
    `SELECT attribute.attnotnull
     FROM pg_attribute attribute
     JOIN pg_class relation ON relation.oid = attribute.attrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relname = 'plm_managed_sessions'
       AND attribute.attname = 'intent_id'`,
  )
  return found.rows[0]?.attnotnull === true
}

async function expectCommitted(statements: Array<{ sql: string; params?: unknown[] }>, pattern?: RegExp): Promise<void> {
  const client = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-schema-commit' })
  await client.connect()
  let failed = false
  try {
    await client.query('BEGIN')
    try {
      for (const statement of statements) await client.query(statement.sql, statement.params)
      await client.query('COMMIT')
    } catch (error) {
      failed = true
      if (!pattern) throw error
      expect(String(error)).toMatch(pattern)
      await client.query('ROLLBACK').catch(() => undefined)
    }
    if (pattern) expect(failed).toBe(true)
    if (!pattern && failed) throw new Error('committed transaction failed without a recorded error')
  } finally {
    await client.end()
  }
}

async function beginContinuous() {
  const created = await provisionManagedLink(ACTOR, provisionBody())
  const res = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: SOURCE, rootPartId: 'part' }, res as never)
  const intent = res.cookies[MANAGED_INTENT_COOKIE]?.value
  const nonce = res.cookies[MANAGED_NONCE_COOKIE]?.value
  return {
    created,
    res,
    state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
    intent,
    nonce,
  }
}

async function finish(started: { intent?: string; nonce?: string; state: string }) {
  const done = responseDouble()
  await completeManagedBrowserLogin({
    headers: {
      origin: ORIGIN,
      'x-metasheet-managed-bridge': 'complete',
      cookie: `${MANAGED_INTENT_COOKIE}=${started.intent}; ${MANAGED_NONCE_COOKIE}=${started.nonce}`,
    },
    body: { code: 'same-code', state: started.state },
  } as never, done as never)
  return done
}

async function issuePredecessor(expOffset: number) {
  const exp = Math.floor(Date.now() / 1000) + expOffset
  exchangeSpec = {
    jti: 'jti-pred',
    exp,
    delegationId: 'del-pred',
    expiresIn: 15,
    generationIndex: 0,
  }
  successorSpec = {
    jti: 'jti-succ',
    exp: exp + 180,
    delegationId: 'del-succ',
    expiresIn: 15,
    generationIndex: 1,
  }
  installFetch()
  const started = await beginContinuous()
  const done = await finish(started)
  expect(done.statusCode).toBe(200)
  const cookie = done.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
  expect(cookie).not.toBe('')
  const session = (await query<Record<string, unknown>>('SELECT * FROM plm_managed_sessions')).rows[0]
  expect(session).toBeTruthy()
  expect(epoch(session?.expires_at)).toBe(exp)
  expect(Number(session?.credential_generation)).toBe(0)
  nativeCalls.length = 0
  return { cookie, session, exp, linkId: String(session?.link_id ?? '') }
}

function recoverRequest(cookie: string, extra: Record<string, unknown> = {}) {
  const headers: Record<string, unknown> = {
    origin: ORIGIN,
    'x-metasheet-managed-bridge': 'renew-recovery',
    cookie: `${MANAGED_SESSION_COOKIE}=${cookie}`,
  }
  return {
    headers: { ...headers, ...(extra.headers as Record<string, unknown> | undefined) },
    body: Object.prototype.hasOwnProperty.call(extra, 'body') ? extra.body : {},
    user: Object.prototype.hasOwnProperty.call(extra, 'user') ? extra.user : undefined,
  }
}

async function recover(cookie: string, extra: Record<string, unknown> = {}) {
  const res = responseDouble()
  const req = recoverRequest(cookie, extra)
  await recoverManagedContinuousSession(req as never, res as never)
  return { res, req }
}

async function operations(): Promise<Array<Record<string, unknown>>> {
  const found = await query<Record<string, unknown>>(
    'SELECT * FROM plm_managed_renewal_operations ORDER BY created_at, id',
  )
  return found.rows
}

async function sessions(): Promise<Array<Record<string, unknown>>> {
  const found = await query<Record<string, unknown>>('SELECT * FROM plm_managed_sessions ORDER BY created_at, id')
  return found.rows
}

function cookieSid(token: string): string {
  const decoded = jwt.decode(token)
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return ''
  return typeof decoded.sid === 'string' ? decoded.sid : ''
}

function cookieExp(token: string): number {
  const decoded = jwt.decode(token)
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return 0
  return typeof decoded.exp === 'number' ? decoded.exp : 0
}

function ordinaryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { ...provisionBody(overrides) }
  delete body.continuityMode
  return body
}

async function ensureOwnedSource(sourceId: string): Promise<void> {
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Ordinary PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, owner_id = EXCLUDED.owner_id, is_active = true, deleted_at = NULL`,
    [sourceId, OWNER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
  )
}

function installOrdinaryExchange(
  spec: CredentialSpec,
  hooks: { revokeStatus: number; delayMs: number },
  received: { at: number },
): void {
  setManagedNativeFetchForTests(async (url, init) => {
    const href = String(url)
    const parsed = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    nativeCalls.push({ url: href, body: parsed })
    if (href.endsWith('/managed-login/exchange')) {
      received.at = Date.now()
      if (hooks.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, hooks.delayMs))
      return Response.json(continuousJson(spec))
    }
    if (href.endsWith('/revoke')) return new Response(null, { status: hooks.revokeStatus })
    return new Response(null, { status: 401 })
  })
}

function ordinaryMismatchSpec(delegationId: string): CredentialSpec {
  return {
    jti: `jti-${delegationId}`,
    exp: Math.floor(Date.now() / 1000) + 400,
    delegationId,
    expiresIn: 30,
    generationIndex: 0,
  }
}

function installOrdinarySubjectMismatch(spec: CredentialSpec, hooks: { revokeStatus: number }): void {
  setManagedNativeFetchForTests(async (url, init) => {
    const href = String(url)
    const parsed = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    nativeCalls.push({ url: href, body: parsed })
    if (href.endsWith('/exchange-continuous')) return Response.json(continuousJson(exchangeSpec))
    if (href.endsWith('/managed-login/exchange')) {
      return Response.json({ ...continuousJson(spec), subject: 'wrong-subject' })
    }
    if (href.endsWith('/renew')) return Response.json(continuousJson(successorSpec))
    if (href.endsWith('/revoke')) return new Response(null, { status: hooks.revokeStatus })
    return new Response(null, { status: 401 })
  })
}

async function beginOrdinary(sourceId: string): Promise<{ intent?: string; nonce?: string; state: string }> {
  await ensureOwnedSource(sourceId)
  await provisionManagedLink(ACTOR, ordinaryBody({ dataSourceId: sourceId }))
  const startedRes = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: sourceId, rootPartId: 'part' }, startedRes as never)
  return {
    intent: startedRes.cookies[MANAGED_INTENT_COOKIE]?.value,
    nonce: startedRes.cookies[MANAGED_NONCE_COOKIE]?.value,
    state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
  }
}

function revokeCallsFor(delegationId: string): NativeCall[] {
  return nativeCalls.filter((call) => call.url.endsWith('/revoke') && call.body?.delegation_id === delegationId)
}

function correctOtherSuccessor(exp: number): CredentialSpec {
  return {
    jti: 'jti-other-succ',
    exp: exp + 180,
    delegationId: 'del-other-succ',
    expiresIn: 15,
    generationIndex: 1,
  }
}

async function issueOtherPredecessor(): Promise<{ cookie: string; exp: number }> {
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Other PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, owner_id = EXCLUDED.owner_id, is_active = true, deleted_at = NULL`,
    ['source-2', OWNER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
  )
  const exp = Math.floor(Date.now() / 1000) + 90
  exchangeSpec = {
    jti: 'jti-other-pred',
    exp,
    delegationId: 'del-other-pred',
    expiresIn: 15,
    generationIndex: 0,
  }
  successorSpec = correctOtherSuccessor(exp)
  installFetch()
  await provisionManagedLink(ACTOR, provisionBody({ dataSourceId: 'source-2' }))
  const startedRes = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: 'source-2', rootPartId: 'part' }, startedRes as never)
  const done = await finish({
    intent: startedRes.cookies[MANAGED_INTENT_COOKIE]?.value,
    nonce: startedRes.cookies[MANAGED_NONCE_COOKIE]?.value,
    state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
  })
  expect(done.statusCode).toBe(200)
  const cookie = done.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
  expect(cookie).not.toBe('')
  return { cookie, exp }
}

async function installSuccessorPause(key: number, delegationId = 'del-other-succ'): Promise<Client> {
  if (!Number.isSafeInteger(key)) throw new Error('pause key must be an integer')
  if (!/^del-[a-z0-9-]+$/.test(delegationId)) throw new Error('pause delegation must be a test id')
  const blocker = new Client({ connectionString: pgUrl, application_name: `plm-renewal-drain-pause-${key}` })
  await blocker.connect()
  await blocker.query('SELECT pg_advisory_lock($1::bigint)', [key])
  await query(
    `CREATE FUNCTION plm_test_pause_successor() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
  )
  await query(
    `CREATE TRIGGER plm_test_pause_successor BEFORE INSERT ON plm_managed_sessions
     FOR EACH ROW WHEN (NEW.delegation_id = '${delegationId}')
     EXECUTE FUNCTION plm_test_pause_successor()`,
  )
  return blocker
}

async function beginOtherLogin(expOffset = 90): Promise<{ intent?: string; nonce?: string; state: string; exp: number }> {
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Other PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, owner_id = EXCLUDED.owner_id, is_active = true, deleted_at = NULL`,
    ['source-2', OWNER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
  )
  const exp = Math.floor(Date.now() / 1000) + expOffset
  exchangeSpec = {
    jti: 'jti-other-pred',
    exp,
    delegationId: 'del-other-pred',
    expiresIn: 15,
    generationIndex: 0,
  }
  successorSpec = {
    jti: 'jti-other-succ',
    exp: exp + 180,
    delegationId: 'del-other-pred',
    expiresIn: 15,
    generationIndex: 1,
  }
  installFetch()
  await provisionManagedLink(ACTOR, provisionBody({ dataSourceId: 'source-2' }))
  const startedRes = responseDouble()
  const started = await startManagedLogin(ACTOR, { dataSourceId: 'source-2', rootPartId: 'part' }, startedRes as never)
  return {
    intent: startedRes.cookies[MANAGED_INTENT_COOKIE]?.value,
    nonce: startedRes.cookies[MANAGED_NONCE_COOKIE]?.value,
    state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
    exp,
  }
}

async function releaseSuccessorPause(blocker: Client | null): Promise<void> {
  if (!blocker) return
  await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
}

async function dropSuccessorPause(blocker: Client | null): Promise<void> {
  await releaseSuccessorPause(blocker)
  if (blocker) await blocker.end().catch(() => undefined)
  await query('DROP TRIGGER IF EXISTS plm_test_pause_successor ON plm_managed_sessions')
  await query('DROP FUNCTION IF EXISTS plm_test_pause_successor()')
}

async function expectPauseClean(key: number): Promise<void> {
  expect((await query(`SELECT 1 FROM pg_proc WHERE proname = 'plm_test_pause_successor'`)).rows).toHaveLength(0)
  expect((await query(`SELECT 1 FROM pg_trigger WHERE tgname = 'plm_test_pause_successor'`)).rows).toHaveLength(0)
  expect((await query(
    `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
    [`plm-renewal-drain-pause-${key}`],
  )).rows).toHaveLength(0)
  expect((await query(
    `SELECT pid FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND state = 'active'
       AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
  )).rows).toHaveLength(0)
}

async function waitForPausedInsert(): Promise<number> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const paused = await query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
         AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
    )
    if (paused.rows[0]?.pid) return Number(paused.rows[0].pid)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return 0
}

async function holdDelegation(delegationId: string): Promise<Client> {
  const holder = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-expiry-advisory' })
  await holder.connect()
  await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
    `${RENEWAL_DELEGATION_LOCK_PREFIX}${delegationId}`,
  ])
  return holder
}

async function releaseDelegation(holder: Client, delegationId: string): Promise<void> {
  await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
    `${RENEWAL_DELEGATION_LOCK_PREFIX}${delegationId}`,
  ]).catch(() => undefined)
}

async function waitForDelegationWaiter(excludePid: number): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const waiting = await query(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
         AND pid <> $1
         AND query ILIKE '%pg_advisory_xact_lock%'`,
      [excludePid],
    )
    if (waiting.rows.length >= 1) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

async function waitForLock(applicationName: string, relation: string): Promise<{ query: string }> {
  let waiting: { query: string } | null = null
  let seen: Array<{ query: string; wait_event_type: string | null }> = []
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const activity = await query<{ query: string; wait_event_type: string | null }>(
      `SELECT query, wait_event_type
       FROM pg_stat_activity
       WHERE application_name = $1 AND state = 'active'`,
      [applicationName],
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
  const blocked = await query<{ relname: string; mode: string; granted: boolean }>(
    `SELECT relation.relname, lock.mode, lock.granted
     FROM pg_locks lock
     JOIN pg_class relation ON relation.oid = lock.relation
     JOIN pg_stat_activity activity ON activity.pid = lock.pid
     WHERE activity.application_name = $1 AND lock.locktype = 'relation'
     ORDER BY relation.relname, lock.granted DESC, lock.mode`,
    [applicationName],
  )
  expect(blocked.rows.some((row) => row.relname === relation && row.mode === 'AccessExclusiveLock' && row.granted === false)).toBe(true)
  return waiting!
}

async function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, port }
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
  await renewalUp(db)
  await pool.end()
  const encoding = await query<{ server_encoding: string }>('SHOW server_encoding')
  if (encoding.rows[0]?.server_encoding !== 'UTF8') {
    throw new Error(`expected UTF8 database, got ${encoding.rows[0]?.server_encoding ?? 'missing'}`)
  }
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
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
    [OWNER, ORG, TENANT],
  )
  await query(
    `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
     VALUES ($1, 'Owned PLM', $2, 'plm', $3::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, owner_id = EXCLUDED.owner_id, is_active = true, deleted_at = NULL`,
    [SOURCE, OWNER, config],
  )
})

afterEach(async () => {
  renewMode = 'ok'
  nativeCalls.length = 0
  setManagedFlowHooksForTests(null)
  setManagedNativeFetchForTests(null)
  enable()
  await query(
    `UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = ANY($2::text[])`,
    [OWNER, [ORG, TENANT]],
  )
  await query(
    `UPDATE data_sources SET config = $2::jsonb, owner_id = $3, is_active = true, deleted_at = NULL WHERE id = $1`,
    [SOURCE, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } }), OWNER],
  )
  await resetRows()
})

afterAll(async () => {
  await resetRows()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await renewalDown(db)
  await down(db)
  await pool.end()
})

describe('renewal recovery schema', () => {
  it('freezes one key, keeps successor intent null only for generations 1..7, and an empty downgrade restores the intent rule', async () => {
    const predecessor = await issuePredecessor(90)
    const committedShape = `
      INSERT INTO plm_managed_renewal_operations (
        id, predecessor_session_id, predecessor_delegation_id, idempotency_key, predecessor_jti, predecessor_exp,
        link_id, link_generation, binding_generation, source_fingerprint, meta_user_id, meta_tenant_id, meta_org_id,
        native_subject, native_tenant_id, native_org_id, root_part_id, client_origin, client_id, installation_issuer,
        scope, expected_successor_index, status, successor_session_id, successor_delegation_id, successor_jti,
        successor_exp, successor_credential_generation, credential_ciphertext
      )
      SELECT $2, id, delegation_id, $3, 'jti-pred', $4, link_id, generation, generation,
             (SELECT source_fingerprint FROM plm_managed_identity_links WHERE id = plm_managed_sessions.link_id),
             meta_user_id, meta_tenant_id, meta_org_id, native_subject, native_tenant_id, native_org_id,
             root_part_id, client_origin, client_id, installation_issuer, scope, 1, 'committed',
             'missing-session', 'del-successor', 'successor-jti', $4, $5, 'enc:fixture'
      FROM plm_managed_sessions WHERE id = $1`
    await expectCommitted(
      [{ sql: committedShape, params: [predecessor.session?.id, 'op-null-gen', 'n'.repeat(36), predecessor.exp, null] }],
      /plm_managed_renewal_operations_shape_check/,
    )
    await expectCommitted(
      [{ sql: committedShape, params: [predecessor.session?.id, 'op-dangling', 'p'.repeat(36), predecessor.exp, 1] }],
      /plm_managed_renewal_successor_session_fk|plm_managed_renewal_successor_inconsistent/,
    )
    expect(await operations()).toHaveLength(0)
    const inserted = await query(
      `INSERT INTO plm_managed_renewal_operations (
         id, predecessor_session_id, predecessor_delegation_id, idempotency_key, predecessor_jti, predecessor_exp,
         link_id, link_generation, binding_generation, source_fingerprint, meta_user_id, meta_tenant_id, meta_org_id,
         native_subject, native_tenant_id, native_org_id, root_part_id, client_origin, client_id, installation_issuer,
         scope, expected_successor_index, status
       )
       SELECT 'op-shape', id, delegation_id, $2, 'jti-pred', $3, link_id, generation, generation,
              (SELECT source_fingerprint FROM plm_managed_identity_links WHERE id = plm_managed_sessions.link_id),
              meta_user_id, meta_tenant_id, meta_org_id, native_subject, native_tenant_id, native_org_id,
              root_part_id, client_origin, client_id, installation_issuer, scope, 1, 'pending'
       FROM plm_managed_sessions WHERE id = $1
       RETURNING id`,
      [predecessor.session?.id, 'a'.repeat(36), predecessor.exp],
    )
    expect(inserted.rows).toHaveLength(1)
    await expect(query(
      `UPDATE plm_managed_renewal_operations SET idempotency_key = $1 WHERE id = 'op-shape'`,
      ['b'.repeat(36)],
    )).rejects.toThrow(/plm_managed_renewal_immutable/)
    await expect(query(
      `UPDATE plm_managed_renewal_operations SET predecessor_jti = 'other' WHERE id = 'op-shape'`,
    )).rejects.toThrow(/plm_managed_renewal_immutable/)
    await expect(query(
      `UPDATE plm_managed_renewal_operations
       SET status = 'committed', successor_session_id = 'sess-partial'
       WHERE id = 'op-shape'`,
    )).rejects.toThrow(/plm_managed_renewal_operations/)
    await expect(query(
      `INSERT INTO plm_managed_renewal_operations (
         id, predecessor_session_id, predecessor_delegation_id, idempotency_key, predecessor_jti, predecessor_exp,
         link_id, link_generation, binding_generation, source_fingerprint, meta_user_id, meta_tenant_id, meta_org_id,
         native_subject, native_tenant_id, native_org_id, root_part_id, client_origin, client_id, installation_issuer,
         scope, expected_successor_index, status
       )
       SELECT 'op-second', id, delegation_id, $2, 'jti-pred', $3, link_id, generation, generation,
              (SELECT source_fingerprint FROM plm_managed_identity_links WHERE id = plm_managed_sessions.link_id),
              meta_user_id, meta_tenant_id, meta_org_id, native_subject, native_tenant_id, native_org_id,
              root_part_id, client_origin, client_id, installation_issuer, scope, 1, 'pending'
       FROM plm_managed_sessions WHERE id = $1`,
      [predecessor.session?.id, 'c'.repeat(36), predecessor.exp],
    )).rejects.toThrow(/duplicate key|uq_|predecessor_session_id|unique/i)
    const sessionShape = `
      INSERT INTO plm_managed_sessions (
        id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
        scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
        root_part_id, client_origin, installation_issuer, client_id, created_at, credential_generation
      )
      SELECT $2, NULL, link_id, data_source_id, generation, $3, 'enc:yur_x',
             expires_at, scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id,
             meta_org_id, root_part_id, client_origin, installation_issuer, client_id, created_at, $4
      FROM plm_managed_sessions WHERE id = $1`
    await expectCommitted(
      [{ sql: sessionShape, params: [predecessor.session?.id, 'sess-null-ordinary', 'del-null-ordinary', null] }],
      /plm_managed_sessions_successor_intent_check/,
    )
    await expectCommitted(
      [{ sql: sessionShape, params: [predecessor.session?.id, 'sess-orphan', 'del-orphan', 1] }],
      /plm_managed_successor_unlinked/,
    )
    expect(await operations()).toHaveLength(1)
    await expectCommitted([
      {
        sql: `INSERT INTO plm_managed_sessions (
                id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
                scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
                root_part_id, client_origin, installation_issuer, client_id, created_at, credential_generation
              )
              SELECT 'sess-successor', NULL, link_id, data_source_id, generation, 'del-successor-row', 'enc:yur_succ',
                     now() + interval '60 seconds', scope, native_subject, native_tenant_id, native_org_id, meta_user_id,
                     meta_tenant_id, meta_org_id, root_part_id, client_origin, installation_issuer, client_id, now(), 1
              FROM plm_managed_sessions WHERE id = $1`,
        params: [predecessor.session?.id],
      },
      {
        sql: `UPDATE plm_managed_renewal_operations operation
              SET status = 'committed', successor_session_id = sess.id, successor_delegation_id = sess.delegation_id,
                  successor_jti = 'jti-succ-row', successor_exp = floor(extract(epoch FROM sess.expires_at))::bigint,
                  successor_credential_generation = sess.credential_generation, credential_ciphertext = sess.credential_ciphertext,
                  updated_at = now()
              FROM plm_managed_sessions sess
              WHERE operation.id = 'op-shape' AND sess.id = 'sess-successor'`,
      },
    ])
    expect((await operations()).find((row) => row.id === 'op-shape')?.status).toBe('committed')
    expect((await sessions()).some((row) => row.id === 'sess-successor' && row.intent_id === null)).toBe(true)
    const pool = new Pool({ connectionString: pgUrl, max: 1 })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    try {
      await expect(renewalDown(db)).rejects.toThrow(/plm_managed_renewal_evidence_present/)
      expect(await columnExists('plm_managed_renewal_operations', 'idempotency_key')).toBe(true)
      expect((await operations()).some((row) => row.id === 'op-shape')).toBe(true)
      await expectCommitted([
        { sql: 'DELETE FROM plm_managed_renewal_operations' },
        { sql: `DELETE FROM plm_managed_sessions WHERE id = 'sess-successor'` },
      ])
      await renewalDown(db)
      expect(await columnExists('plm_managed_renewal_operations', 'id')).toBe(false)
      expect(await intentNotNull()).toBe(true)
      expect(await columnExists('plm_managed_sessions', 'credential_generation')).toBe(true)
      expect(await columnExists('plm_managed_identity_links', 'continuity_mode')).toBe(true)
      expect((await query('SELECT id FROM plm_managed_sessions WHERE id = $1', [predecessor.session?.id])).rows).toHaveLength(1)
    } finally {
      if (!await columnExists('plm_managed_renewal_operations', 'id')) await renewalUp(db)
      await pool.end()
    }
  })

  it('acquires link, binding, and session locks before the operation lock, then a committed insert refuses downgrade', async () => {
    await resetRows()
    const holder = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-order-holder' })
    const downPool = new Pool({ connectionString: pgUrl, max: 1, application_name: 'plm-renewal-order-down' })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: downPool }) })
    let holderOpen = false
    let released = false
    let downResult: Promise<unknown> | null = null
    try {
      await holder.connect()
      holderOpen = true
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE plm_managed_renewal_operations IN ROW EXCLUSIVE MODE')
      expect((await query<{ n: number }>('SELECT count(*)::int AS n FROM plm_managed_renewal_operations')).rows[0]?.n).toBe(0)
      downResult = renewalDown(db)
      const waiting = await waitForLock('plm-renewal-order-down', 'plm_managed_renewal_operations')
      expect(waiting.query).toMatch(/LOCK TABLE\s+plm_managed_renewal_operations\s+IN ACCESS EXCLUSIVE MODE/i)
      expect(waiting.query).not.toMatch(/plm_managed_renewal_evidence_present/)
      expect(waiting.query).not.toMatch(/ALTER TABLE/i)
      const granted = await query<{ relname: string }>(
        `SELECT relation.relname
         FROM pg_locks lock
         JOIN pg_class relation ON relation.oid = lock.relation
         JOIN pg_stat_activity activity ON activity.pid = lock.pid
         WHERE activity.application_name = 'plm-renewal-order-down'
           AND lock.locktype = 'relation' AND lock.granted AND lock.mode = 'AccessExclusiveLock'
         ORDER BY relation.relname`,
      )
      expect(granted.rows.map((row) => row.relname)).toEqual([
        'plm_managed_identity_links',
        'plm_managed_sessions',
        'plm_managed_source_bindings',
      ])
      await holder.query('ROLLBACK')
      released = true
      await downResult
      expect(await columnExists('plm_managed_renewal_operations', 'id')).toBe(false)
      expect(await intentNotNull()).toBe(true)
    } finally {
      if (holderOpen && !released) await holder.query('ROLLBACK').catch(() => undefined)
      if (holderOpen) await holder.end().catch(() => undefined)
      if (downResult) await downResult.catch(() => undefined)
      if (!await columnExists('plm_managed_renewal_operations', 'id')) await renewalUp(db)
      await downPool.end()
    }

    const predecessor = await issuePredecessor(90)
    const writer = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-evidence-writer' })
    const evidencePool = new Pool({ connectionString: pgUrl, max: 1, application_name: 'plm-renewal-evidence-down' })
    const evidenceDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: evidencePool }) })
    let writerOpen = false
    let committed = false
    let evidenceDown: Promise<unknown> | null = null
    try {
      await writer.connect()
      writerOpen = true
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO plm_managed_renewal_operations (
           id, predecessor_session_id, predecessor_delegation_id, idempotency_key, predecessor_jti, predecessor_exp,
           link_id, link_generation, binding_generation, source_fingerprint, meta_user_id, meta_tenant_id, meta_org_id,
           native_subject, native_tenant_id, native_org_id, root_part_id, client_origin, client_id, installation_issuer,
           scope, expected_successor_index, status
         )
         SELECT 'op-race', id, delegation_id, $2, 'jti-pred', $3, link_id, generation, generation,
                (SELECT source_fingerprint FROM plm_managed_identity_links WHERE id = plm_managed_sessions.link_id),
                meta_user_id, meta_tenant_id, meta_org_id, native_subject, native_tenant_id, native_org_id,
                root_part_id, client_origin, client_id, installation_issuer, scope, 1, 'pending'
         FROM plm_managed_sessions WHERE id = $1`,
        [predecessor.session?.id, 'd'.repeat(36), predecessor.exp],
      )
      expect((await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plm_managed_renewal_operations`,
      )).rows[0]?.n).toBe(0)
      evidenceDown = renewalDown(evidenceDb)
      const waiting = await waitForLock('plm-renewal-evidence-down', 'plm_managed_identity_links')
      expect(waiting.query).toMatch(/LOCK TABLE\s+plm_managed_identity_links\s+IN ACCESS EXCLUSIVE MODE/i)
      expect(waiting.query).not.toMatch(/plm_managed_renewal_evidence_present/)
      expect(waiting.query).not.toMatch(/ALTER TABLE/i)
      await writer.query('COMMIT')
      committed = true
      await expect(evidenceDown).rejects.toThrow(/plm_managed_renewal_evidence_present/)
      expect((await query<{ id: string }>('SELECT id FROM plm_managed_renewal_operations WHERE id = $1', ['op-race'])).rows).toEqual([{ id: 'op-race' }])
      expect(await columnExists('plm_managed_renewal_operations', 'idempotency_key')).toBe(true)
      expect(await intentNotNull()).toBe(false)
    } finally {
      if (writerOpen && !committed) await writer.query('ROLLBACK').catch(() => undefined)
      if (writerOpen) await writer.end().catch(() => undefined)
      if (evidenceDown) await evidenceDown.catch(() => undefined)
      await evidencePool.end()
    }
  })
})

describe('renewal recovery admission', () => {
  it('keeps one key and one successor for two in-process requests, and does not revoke the predecessor', async () => {
    const sharedBefore = readSharedTransportAudit().calls
    const predecessor = await issuePredecessor(90)
    const firstGate = new Promise<void>((resolve) => {
      const prior = successorSpec
      successorSpec = prior
      resolve()
    })
    await firstGate
    const [left, right] = await Promise.all([
      recover(predecessor.cookie),
      recover(predecessor.cookie),
    ])
    expect(left.res.statusCode).toBe(200)
    expect(right.res.statusCode).toBe(200)
    const rows = await operations()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('committed')
    expect(String(rows[0]?.idempotency_key)).toMatch(/^[A-Za-z0-9_-]{36,64}$/)
    const renews = renewCalls()
    expect(renews).toHaveLength(2)
    expect(renews.every((call) => call.body?.idempotency_key === rows[0]?.idempotency_key)).toBe(true)
    expect(renews.every((call) => JSON.stringify(Object.keys(call.body ?? {}).sort()) === JSON.stringify(RENEW_KEYS))).toBe(true)
    expect(renews[0]?.body?.credential).toBe(openCredential(String(predecessor.session?.credential_ciphertext)))
    const stored = await sessions()
    const successor = stored.find((row) => Number(row.credential_generation) === 1)
    expect(successor).toBeTruthy()
    expect(successor?.intent_id ?? null).toBeNull()
    expect(epoch(successor?.expires_at)).toBe(successorSpec.exp)
    expect(epoch(successor?.expires_at)).not.toBe(Math.floor(Date.now() / 1000) + Number(successorSpec.expiresIn))
    expect(left.res.cookies[MANAGED_SESSION_COOKIE]?.value).toBeTruthy()
    expect(cookieSid(left.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')).toBe(successor?.id)
    expect(cookieSid(right.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')).toBe(successor?.id)
    expect(sealCredential(String(successorSpec.credential ?? yur(successorSpec)))).not.toBe(successor?.credential_ciphertext)
    expect(openCredential(String(successor?.credential_ciphertext))).toBe(yur(successorSpec))
    expect(successor?.credential_ciphertext).toBe(rows[0]?.credential_ciphertext)
    const predecessorRow = stored.find((row) => row.id === predecessor.session?.id)
    expect(predecessorRow?.revoked_at ?? null).toBeNull()
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    expect(readSharedTransportAudit().calls).toBe(sharedBefore)
    expect(left.req.user).toBeUndefined()
  })

  it('reuses one persisted credential and key across transport loss, local rollback, and a lost Set-Cookie replay', async () => {
    const predecessor = await issuePredecessor(90)
    renewMode = 'reset'
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 503, code: 'PLM_MANAGED_RENEW_UNAVAILABLE' })
    renewMode = 'unavailable'
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 503, code: 'PLM_MANAGED_RENEW_UNAVAILABLE' })
    expect(await operations()).toHaveLength(1)
    expect((await operations())[0]?.status).toBe('pending')
    expect((await sessions()).filter((row) => Number(row.credential_generation) === 1)).toHaveLength(0)
    const pendingKey = String((await operations())[0]?.idempotency_key)
    setManagedFlowHooksForTests({ failSessionInsert: true })
    renewMode = 'ok'
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 503, code: 'PLM_MANAGED_SESSION_COMMIT_FAILED' })
    expect((await operations())[0]?.status).toBe('pending')
    expect(String((await operations())[0]?.idempotency_key)).toBe(pendingKey)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    setManagedFlowHooksForTests(null)
    setManagedFlowHooksForTests({ loseExchangeResponse: true })
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 503, code: 'PLM_MANAGED_RENEW_UNAVAILABLE' })
    expect((await operations())[0]?.status).toBe('pending')
    setManagedFlowHooksForTests(null)
    const committed = await recover(predecessor.cookie)
    expect(committed.res.statusCode).toBe(200)
    const winner = (await operations())[0]
    expect(winner?.status).toBe('committed')
    expect(String(winner?.idempotency_key)).toBe(pendingKey)
    const beforeReplay = renewCalls().length
    const replay = await recover(predecessor.cookie)
    expect(replay.res.statusCode).toBe(200)
    expect(renewCalls().length).toBe(beforeReplay + 1)
    expect(renewCalls().at(-1)?.body?.idempotency_key).toBe(pendingKey)
    expect(renewCalls().at(-1)?.body?.credential).toBe(openCredential(String(predecessor.session?.credential_ciphertext)))
    const after = await operations()
    expect(after).toHaveLength(1)
    expect(after[0]?.successor_session_id).toBe(winner?.successor_session_id)
    expect(after[0]?.credential_ciphertext).toBe(winner?.credential_ciphertext)
    expect(String(after[0]?.successor_exp)).toBe(String(winner?.successor_exp))
    expect(cookieSid(replay.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')).toBe(winner?.successor_session_id)
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
  })

  it('refuses a client key, a not-due cookie, and expired, revoked, ordinary, or exact-field mismatches before allocation', async () => {
    const predecessor = await issuePredecessor(90)
    await expect(recover(predecessor.cookie, { body: { idempotency_key: 'e'.repeat(36), code: 'nope' } })).rejects.toMatchObject({
      status: 400,
      code: 'PLM_MANAGED_BODY_REFUSED',
    })
    expect(renewCalls()).toHaveLength(0)
    expect(await operations()).toHaveLength(0)
    await resetRows()
    const early = await issuePredecessor(400)
    await expect(recover(early.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_NOT_DUE' })
    expect(renewCalls()).toHaveLength(0)
    expect(await operations()).toHaveLength(0)
    await resetRows()
    const live = await issuePredecessor(90)
    await query('UPDATE plm_managed_sessions SET revoked_at = now() WHERE id = $1', [live.session?.id])
    await expect(recover(live.cookie)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    expect(await operations()).toHaveLength(0)
    expect(renewCalls()).toHaveLength(0)
    await resetRows()
    const exact = await issuePredecessor(90)
    const tokenExp = epoch(exact.session?.expires_at)
    const mismatchedExp = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: TENANT,
      sid: exact.session?.id,
      purpose: MANAGED_COMPANION_PURPOSE,
      exp: tokenExp - 1,
    }, secret())
    await expect(recover(mismatchedExp)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    const paddedTenant = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: ` ${TENANT}`,
      sid: exact.session?.id,
      purpose: MANAGED_COMPANION_PURPOSE,
      exp: tokenExp,
    }, secret())
    await expect(recover(paddedTenant)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    expect(await operations()).toHaveLength(0)
    await resetRows()
    const ordinary = await issuePredecessor(90)
    const intentId = String(ordinary.session?.intent_id ?? '')
    await query(
      `INSERT INTO plm_managed_browser_intents (
         id, link_id, generation, meta_user_id, meta_tenant_id, meta_org_id, data_source_id,
         root_part_id, client_origin, installation_issuer, native_tenant_id, native_org_id,
         callback, client_id, state_hash, nonce_hash, code_challenge, code_verifier_ciphertext,
         return_path, status, expires_at, created_at, request_mode
       )
       SELECT 'intent-ordinary', link_id, generation, meta_user_id, meta_tenant_id, meta_org_id, data_source_id,
              root_part_id, client_origin, installation_issuer, native_tenant_id, native_org_id,
              callback, client_id, state_hash, nonce_hash, code_challenge, code_verifier_ciphertext,
              return_path, 'consumed', now() + interval '60 seconds', now(), 'ordinary'
       FROM plm_managed_browser_intents WHERE id = $1`,
      [intentId],
    )
    await query(
      `INSERT INTO plm_managed_sessions (
         id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
         scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
         root_part_id, client_origin, installation_issuer, client_id, created_at, credential_generation
       )
       SELECT 'sess-ordinary', 'intent-ordinary', link_id, data_source_id, generation, 'del-ordinary',
              credential_ciphertext, now() + interval '60 seconds', scope, native_subject, native_tenant_id,
              native_org_id, meta_user_id, meta_tenant_id, meta_org_id, root_part_id, client_origin,
              installation_issuer, client_id, now(), NULL
       FROM plm_managed_sessions WHERE id = $1`,
      [ordinary.session?.id],
    )
    const ordinaryExp = epoch((await query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM plm_managed_sessions WHERE id = 'sess-ordinary'`,
    )).rows[0]?.expires_at)
    const ordinaryCookie = jwt.sign({
      userId: OWNER,
      email: 'meta-owner@example.test',
      role: 'user',
      tenantId: TENANT,
      sid: 'sess-ordinary',
      purpose: MANAGED_COMPANION_PURPOSE,
      exp: ordinaryExp,
    }, secret())
    await expect(recover(ordinaryCookie)).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_RENEW_NOT_CONTINUOUS' })
    expect(await operations()).toHaveLength(0)
    expect(renewCalls()).toHaveLength(0)
  })

  it('does not allocate when expiry passes during the link wait or the native call, and does not move the predecessor exp', async () => {
    const waiting = await issuePredecessor(4)
    const holder = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-expiry-holder' })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [waiting.linkId])
    let sawWait = false
    const pending = recover(waiting.cookie).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const activity = await query<{ pid: number }>(
        `SELECT activity.pid
         FROM pg_stat_activity activity
         WHERE activity.state = 'active' AND activity.wait_event_type = 'Lock'
           AND activity.query ILIKE '%plm_managed_identity_links%'
           AND activity.query ILIKE '%FOR UPDATE%'
           AND activity.application_name IS DISTINCT FROM 'plm-renewal-expiry-holder'`,
      )
      if (activity.rows.length > 0) {
        sawWait = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(sawWait).toBe(true)
    expect(renewCalls()).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 4500))
    await holder.query('COMMIT')
    await holder.end()
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ status: 401, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    }
    expect(await operations()).toHaveLength(0)
    expect(renewCalls()).toHaveLength(0)
    expect(epoch((await sessions())[0]?.expires_at)).toBe(waiting.exp)

    await resetRows()
    const crossing = await issuePredecessor(4)
    const originalExp = crossing.exp
    installFetch()
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/renew')) {
        await new Promise((resolve) => setTimeout(resolve, 4500))
        return Response.json(continuousJson(successorSpec))
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
      return new Response('missing', { status: 404 })
    })
    await expect(recover(crossing.cookie)).rejects.toMatchObject({ code: 'PLM_MANAGED_SESSION_REQUIRED' })
    const op = await operations()
    expect(op).toHaveLength(1)
    expect(op[0]?.status).toBe('refused')
    expect(op[0]?.successor_session_id ?? null).toBeNull()
    expect((await sessions()).some((row) => Number(row.credential_generation) > 0)).toBe(false)
    expect(epoch((await sessions())[0]?.expires_at)).toBe(originalExp)
    const outbox = await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')
    expect(outbox.rows.map((row) => row.delegation_id)).toEqual([successorSpec.delegationId])
  })

  it('refuses terminal native 401, a later replay denial, membership loss, and a moved source without a second key', async () => {
    const denied = await issuePredecessor(90)
    renewMode = 'unauthorized'
    await expect(recover(denied.cookie)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_RENEW_UNAUTHORIZED' })
    expect((await operations())[0]?.status).toBe('refused')
    expect((await sessions()).filter((row) => Number(row.credential_generation) === 1)).toHaveLength(0)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toHaveLength(0)
    await expect(recover(denied.cookie)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_RENEW_REFUSED' })
    expect(renewCalls()).toHaveLength(1)
    expect(await operations()).toHaveLength(1)

    await resetRows()
    renewMode = 'ok'
    installFetch()
    const committed = await issuePredecessor(90)
    const first = await recover(committed.cookie)
    expect(first.res.statusCode).toBe(200)
    const winner = (await operations())[0]
    renewMode = 'unauthorized'
    await expect(recover(committed.cookie)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_RENEW_UNAUTHORIZED' })
    const afterDeny = (await operations())[0]
    expect(afterDeny?.status).toBe('committed')
    expect(afterDeny?.successor_session_id).toBe(winner?.successor_session_id)
    expect(afterDeny?.credential_ciphertext).toBe(winner?.credential_ciphertext)
    expect(String(afterDeny?.successor_exp)).toBe(String(winner?.successor_exp))
    expect((await sessions()).find((row) => row.id === committed.session?.id)?.revoked_at ?? null).toBeNull()
    expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()

    await resetRows()
    const member = await issuePredecessor(90)
    installFetch()
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/renew')) {
        await query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])
        return Response.json(continuousJson(successorSpec))
      }
      return new Response('missing', { status: 404 })
    })
    await expect(recover(member.cookie)).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_META_MEMBERSHIP_REFUSED' })
    expect((await operations())[0]?.status).toBe('refused')
    expect((await sessions()).some((row) => Number(row.credential_generation) === 1)).toBe(false)
    await query('UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2', [OWNER, ORG])

    await resetRows()
    const moved = await issuePredecessor(90)
    await query(
      `UPDATE data_sources SET config = $2::jsonb WHERE id = $1`,
      [SOURCE, JSON.stringify({ connection: { url: 'http://127.0.0.1:8/plm' } })],
    )
    await expect(recover(moved.cookie)).rejects.toMatchObject({ status: 403 })
    expect(await operations()).toHaveLength(0)
    expect(renewCalls()).toHaveLength(0)
  })

  it('does not enqueue a tracked predecessor or another tracked successor', async () => {
    const predecessor = await issuePredecessor(90)
    const first = await recover(predecessor.cookie)
    expect(first.res.statusCode).toBe(200)
    expect(await sessions()).toHaveLength(2)
    expect(await operations()).toHaveLength(1)
    const winner = (await operations())[0]
    const winnerSessionId = String(winner?.successor_session_id ?? '')
    const winnerSeal = String(winner?.credential_ciphertext ?? '')

    successorSpec = {
      ...successorSpec,
      delegationId: 'del-pred',
      jti: 'wrong-jti-for-tracked-predecessor',
      credentialJti: 'wrong-jti-for-tracked-predecessor',
    }
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
    expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])

    await query(
      `INSERT INTO data_sources (id, name, owner_id, type, config, is_active)
       VALUES ($1, 'Other PLM', $2, 'plm', $3::jsonb, true)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, owner_id = EXCLUDED.owner_id, is_active = true, deleted_at = NULL`,
      ['source-2', OWNER, JSON.stringify({ connection: { url: `${ORIGIN}/plm` } })],
    )
    const otherExp = Math.floor(Date.now() / 1000) + 90
    exchangeSpec = {
      jti: 'jti-other-pred',
      exp: otherExp,
      delegationId: 'del-other-pred',
      expiresIn: 15,
      generationIndex: 0,
    }
    successorSpec = {
      jti: 'jti-other-succ',
      exp: otherExp + 180,
      delegationId: 'del-other-succ',
      expiresIn: 15,
      generationIndex: 1,
    }
    installFetch()
    const created = await provisionManagedLink(ACTOR, provisionBody({ dataSourceId: 'source-2' }))
    const startedRes = responseDouble()
    const started = await startManagedLogin(ACTOR, { dataSourceId: 'source-2', rootPartId: 'part' }, startedRes as never)
    const otherDone = await finish({
      intent: startedRes.cookies[MANAGED_INTENT_COOKIE]?.value,
      nonce: startedRes.cookies[MANAGED_NONCE_COOKIE]?.value,
      state: new URL(started.navigationUrl).searchParams.get('state') ?? '',
    })
    expect(otherDone.statusCode).toBe(200)
    expect(created.linkId).not.toBe('')
    const otherCookie = otherDone.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
    const otherRenewed = await recover(otherCookie)
    expect(otherRenewed.res.statusCode).toBe(200)
    const otherWinner = (await operations()).find((row) => row.successor_delegation_id === 'del-other-succ')
    expect(otherWinner?.status).toBe('committed')

    successorSpec = {
      ...successorSpec,
      delegationId: 'del-other-succ',
      jti: 'wrong-jti-for-other-tracked-successor',
      credentialJti: 'wrong-jti-for-other-tracked-successor',
    }
    await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
    expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])
    const after = (await operations()).find((row) => row.id === winner?.id)
    expect(after?.successor_session_id).toBe(winnerSessionId)
    expect(after?.credential_ciphertext).toBe(winnerSeal)
    expect((await sessions()).find((row) => row.id === winnerSessionId)?.revoked_at ?? null).toBeNull()
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    expect((await sessions()).find((row) => row.id === otherWinner?.successor_session_id)?.revoked_at ?? null).toBeNull()
  })

  it('waits on the delegation publication lock and enqueues a stranger after that lock rolls back', async () => {
    const predecessor = await issuePredecessor(90)
    const first = await recover(predecessor.cookie)
    expect(first.res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const holder = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-delegation-holder' })
    const observer = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-delegation-observer' })
    await holder.connect()
    await observer.connect()
    let released = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${RENEWAL_DELEGATION_LOCK_PREFIX}del-stranger`,
      ])
      successorSpec = {
        ...successorSpec,
        delegationId: 'del-stranger',
        jti: 'jti-stranger',
        credentialJti: 'jti-stranger',
      }
      const replay = recover(predecessor.cookie).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const deadline = Date.now() + 3000
      let sawWait = false
      while (Date.now() < deadline) {
        const waiting = await observer.query(
          `SELECT waiter.pid
           FROM pg_stat_activity waiter
           JOIN pg_locks wanted ON wanted.pid = waiter.pid AND wanted.locktype = 'advisory' AND NOT wanted.granted
           JOIN pg_locks held ON held.locktype = 'advisory' AND held.granted
             AND held.classid = wanted.classid AND held.objid = wanted.objid AND held.objsubid = wanted.objsubid
           JOIN pg_stat_activity holder_activity ON holder_activity.pid = held.pid
           WHERE holder_activity.application_name = 'plm-renewal-delegation-holder'
             AND waiter.wait_event_type = 'Lock' AND waiter.wait_event = 'advisory'
             AND waiter.query ILIKE '%pg_advisory_xact_lock%'
             AND waiter.application_name IS DISTINCT FROM 'plm-renewal-delegation-holder'
             AND waiter.application_name IS DISTINCT FROM 'plm-renewal-delegation-observer'`,
        )
        if (waiting.rows.length >= 1) {
          sawWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      expect(sawWait).toBe(true)
      await holder.query('ROLLBACK')
      released = true
      const result = await replay
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox ORDER BY delegation_id')).rows).toEqual([
        { delegation_id: 'del-stranger', status: 'pending' },
      ])
      const after = (await operations()).find((row) => row.id === winner?.id)
      expect(after?.status).toBe('committed')
      expect(after?.credential_ciphertext).toBe(winner?.credential_ciphertext)
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
    } finally {
      if (!released) {
        try { await holder.query('ROLLBACK') } catch { /* the holder may already be closed */ }
      }
      await holder.end().catch(() => undefined)
      await observer.end().catch(() => undefined)
    }
  })

  it('reserves the successor before insert so classification waits and the drainer leaves both sessions live', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const other = await issueOtherPredecessor()
    const blocker = await installSuccessorPause(2026102211)
    const publisher = recover(other.cookie).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let classifierSettled = false
    let classifier: Promise<{ ok: true; value: Awaited<ReturnType<typeof recover>> } | { ok: false; error: unknown }> | undefined
    try {
      const pausedPid = await waitForPausedInsert()
      expect(pausedPid).toBeGreaterThan(0)
      const relations = await query<{ relname: string }>(
        `SELECT relation.relname
         FROM pg_locks lock
         JOIN pg_class relation ON relation.oid = lock.relation
         WHERE lock.pid = $1 AND lock.locktype = 'relation' AND lock.granted`,
        [pausedPid],
      )
      const held = new Set(relations.rows.map((row) => row.relname))
      expect(held.has('plm_managed_identity_links')).toBe(true)
      expect(held.has('plm_managed_source_bindings')).toBe(true)
      expect(held.has('plm_managed_sessions')).toBe(true)
      expect(held.has('plm_managed_renewal_operations')).toBe(true)
      expect((await query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [pausedPid],
      )).rows).toHaveLength(1)
      successorSpec = { ...correctOtherSuccessor(other.exp), jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      classifier = recover(predecessor.cookie).then(
        (value) => {
          classifierSettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          classifierSettled = true
          return { ok: false as const, error }
        },
      )
      expect(await waitForDelegationWaiter(pausedPid)).toBe(true)
      expect(classifierSettled).toBe(false)
      expect((await query(`SELECT id FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`)).rows).toHaveLength(0)
      await blocker.query('SELECT pg_advisory_unlock(2026102211)')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (published.ok) expect(published.value.res.statusCode).toBe(200)
      const classified = await classifier
      expect(classified.ok).toBe(false)
      if (!classified.ok) expect(classified.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      const tracked = (await sessions()).find((row) => row.delegation_id === 'del-other-succ')
      expect(tracked?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
      expect((await operations()).filter((row) => row.status === 'committed')).toHaveLength(2)
      expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])
      const beforeDrain = revokeCallsFor('del-other-succ').length
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: SOURCE })).toMatchObject({ ok: true, state: 'acked' })
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-2' })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-succ')).toHaveLength(beforeDrain)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      expect((await sessions()).find((row) => row.id === tracked?.id)?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
    } finally {
      await releaseSuccessorPause(blocker)
      await publisher.catch(() => undefined)
      await classifier?.catch(() => undefined)
      await dropSuccessorPause(blocker)
    }
    await expectPauseClean(2026102211)
  })

  it('refuses a successor after retryManagedRevoke has sent, and keeps the acked evidence', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const winnerSessionId = String(winner?.successor_session_id ?? '')
    const other = await issueOtherPredecessor()
    let releaseRenew: (() => void) | undefined
    const renewGate = new Promise<void>((resolve) => {
      releaseRenew = resolve
    })
    let pauseNextRenew = true
    let renewEntered = false
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/renew')) {
        if (pauseNextRenew) {
          pauseNextRenew = false
          renewEntered = true
          await renewGate
        }
        return Response.json(continuousJson(successorSpec))
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
      if (href.endsWith('/exchange-continuous')) return Response.json(continuousJson(exchangeSpec))
      if (href.endsWith('/status')) return new Response(null, { status: 401 })
      return new Response('missing', { status: 404 })
    })
    const renewsAtGate = renewCalls().length
    const publisher = recover(other.cookie).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      const enteredDeadline = Date.now() + 5000
      while (!renewEntered && Date.now() < enteredDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(renewEntered).toBe(true)
      expect((await query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active'
           AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
      )).rows).toHaveLength(0)
      expect((await query(
        `SELECT activity.pid
         FROM pg_stat_activity activity
         JOIN pg_locks lock ON lock.pid = activity.pid AND lock.granted
         JOIN pg_class relation ON relation.oid = lock.relation
         WHERE relation.relname = 'plm_managed_renewal_operations' AND activity.state = 'active'`,
      )).rows).toHaveLength(0)
      expect(renewCalls()).toHaveLength(renewsAtGate + 1)
      successorSpec = { ...correctOtherSuccessor(other.exp), jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`,
      )
      expect(pending.rows).toHaveLength(1)
      expect(pending.rows[0]?.status).toBe('pending')
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-succ')).toHaveLength(1)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      successorSpec = correctOtherSuccessor(other.exp)
      releaseRenew?.()
      releaseRenew = undefined
      const published = await publisher
      expect(published.ok).toBe(false)
      if (!published.ok) expect(published.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-succ')).toBe(false)
      expect((await sessions()).find((row) => row.id === winnerSessionId)?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.delegation_id === 'del-other-pred')?.revoked_at ?? null).toBeNull()
      expect((await operations()).find((row) => row.predecessor_delegation_id === 'del-other-pred')?.status).toBe('refused')
      expect((await operations()).find((row) => row.id === winner?.id)?.status).toBe('committed')
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      const revokeCount = revokeCallsFor('del-other-succ').length
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-succ')).toHaveLength(revokeCount)
      const renews = renewCalls().length
      await expect(recover(other.cookie)).rejects.toMatchObject({ status: 401, code: 'PLM_MANAGED_RENEW_REFUSED' })
      expect(renewCalls()).toHaveLength(renews)
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-succ')).toBe(false)
      expect((await sessions()).find((row) => row.id === winnerSessionId)?.revoked_at ?? null).toBeNull()
    } finally {
      releaseRenew?.()
      await publisher.catch(() => undefined)
    }
    await expectPauseClean(2026102212)
  })

  it('after a rolled-back reservation, retryManagedRevoke acks only the untracked delegation', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const other = await issueOtherPredecessor()
    const blocker = await installSuccessorPause(2026102213)
    const publisher = recover(other.cookie).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let classifierSettled = false
    let classifier: Promise<{ ok: true; value: Awaited<ReturnType<typeof recover>> } | { ok: false; error: unknown }> | undefined
    try {
      const pausedPid = await waitForPausedInsert()
      expect(pausedPid).toBeGreaterThan(0)
      expect((await query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [pausedPid],
      )).rows).toHaveLength(1)
      successorSpec = { ...correctOtherSuccessor(other.exp), jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      classifier = recover(predecessor.cookie).then(
        (value) => {
          classifierSettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          classifierSettled = true
          return { ok: false as const, error }
        },
      )
      expect(await waitForDelegationWaiter(pausedPid)).toBe(true)
      expect(classifierSettled).toBe(false)
      expect((await query(`SELECT id FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`)).rows).toHaveLength(0)
      await query('SELECT pg_cancel_backend($1)', [pausedPid])
      const aborted = await publisher
      expect(aborted.ok).toBe(false)
      const classified = await classifier
      expect(classified.ok).toBe(false)
      if (!classified.ok) expect(classified.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-succ')).toBe(false)
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`,
      )
      expect(pending.rows).toHaveLength(1)
      expect(pending.rows[0]?.status).toBe('pending')
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-succ')).toHaveLength(1)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-succ'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-succ')).toBe(false)
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
      expect((await operations()).find((row) => row.id === winner?.id)?.status).toBe('committed')
    } finally {
      await releaseSuccessorPause(blocker)
      await publisher.catch(() => undefined)
      await classifier?.catch(() => undefined)
      await dropSuccessorPause(blocker)
    }
    await expectPauseClean(2026102213)
  })

  it('reserves an initial delegation before insert so classification waits and the drainer leaves it live', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const started = await beginOtherLogin()
    const blocker = await installSuccessorPause(2026102214, 'del-other-pred')
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let classifierSettled = false
    let classifier: Promise<{ ok: true; value: Awaited<ReturnType<typeof recover>> } | { ok: false; error: unknown }> | undefined
    try {
      const pausedPid = await waitForPausedInsert()
      expect(pausedPid).toBeGreaterThan(0)
      expect((await query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [pausedPid],
      )).rows).toHaveLength(1)
      successorSpec = { ...successorSpec, jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      classifier = recover(predecessor.cookie).then(
        (value) => {
          classifierSettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          classifierSettled = true
          return { ok: false as const, error }
        },
      )
      expect(await waitForDelegationWaiter(pausedPid)).toBe(true)
      expect(classifierSettled).toBe(false)
      expect((await query(`SELECT id FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`)).rows).toHaveLength(0)
      await blocker.query('SELECT pg_advisory_unlock(2026102214)')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (published.ok) expect(published.value.statusCode).toBe(200)
      const classified = await classifier
      expect(classified.ok).toBe(false)
      if (!classified.ok) expect(classified.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      const tracked = (await sessions()).find((row) => row.delegation_id === 'del-other-pred')
      expect(tracked?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
      expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])
      const beforeDrain = revokeCallsFor('del-other-pred').length
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: SOURCE })).toMatchObject({ ok: true, state: 'acked' })
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-2' })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(beforeDrain)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await sessions()).find((row) => row.id === tracked?.id)?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
    } finally {
      await releaseSuccessorPause(blocker)
      await publisher.catch(() => undefined)
      await classifier?.catch(() => undefined)
      await dropSuccessorPause(blocker)
    }
    await expectPauseClean(2026102214)
  })

  it('refuses an initial session after retryManagedRevoke has sent, and keeps the acked evidence', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const winnerSessionId = String(winner?.successor_session_id ?? '')
    const started = await beginOtherLogin()
    let releaseExchange: (() => void) | undefined
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    let pauseNextExchange = true
    let exchangeEntered = false
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/exchange-continuous')) {
        if (pauseNextExchange) {
          pauseNextExchange = false
          exchangeEntered = true
          await exchangeGate
        }
        return Response.json(continuousJson(exchangeSpec))
      }
      if (href.endsWith('/renew')) return Response.json(continuousJson(successorSpec))
      if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
      if (href.endsWith('/status')) return new Response(null, { status: 401 })
      return new Response('missing', { status: 404 })
    })
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      const enteredDeadline = Date.now() + 5000
      while (!exchangeEntered && Date.now() < enteredDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(exchangeEntered).toBe(true)
      expect((await query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active'
           AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
      )).rows).toHaveLength(0)
      successorSpec = { ...successorSpec, jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      await expect(recover(predecessor.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )
      expect(pending.rows).toHaveLength(1)
      expect(pending.rows[0]?.status).toBe('pending')
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(1)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      releaseExchange?.()
      releaseExchange = undefined
      const published = await publisher
      expect(published.ok).toBe(true)
      if (published.ok) {
        expect(published.value.statusCode).toBe(409)
        expect(published.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
        expect(published.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      }
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await sessions()).find((row) => row.id === winnerSessionId)?.revoked_at ?? null).toBeNull()
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      const revokeCount = revokeCallsFor('del-other-pred').length
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(revokeCount)
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await sessions()).find((row) => row.id === winnerSessionId)?.revoked_at ?? null).toBeNull()
    } finally {
      releaseExchange?.()
      await publisher.catch(() => undefined)
    }
    await expectPauseClean(2026102215)
  })

  it('after a rolled-back initial reservation, retryManagedRevoke acks only the untracked delegation', async () => {
    const predecessor = await issuePredecessor(90)
    expect((await recover(predecessor.cookie)).res.statusCode).toBe(200)
    const winner = (await operations())[0]
    const started = await beginOtherLogin()
    const blocker = await installSuccessorPause(2026102216, 'del-other-pred')
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let classifierSettled = false
    let classifier: Promise<{ ok: true; value: Awaited<ReturnType<typeof recover>> } | { ok: false; error: unknown }> | undefined
    try {
      const pausedPid = await waitForPausedInsert()
      expect(pausedPid).toBeGreaterThan(0)
      expect((await query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [pausedPid],
      )).rows).toHaveLength(1)
      successorSpec = { ...successorSpec, jti: 'wrong-jti', credentialJti: 'wrong-jti' }
      classifier = recover(predecessor.cookie).then(
        (value) => {
          classifierSettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          classifierSettled = true
          return { ok: false as const, error }
        },
      )
      expect(await waitForDelegationWaiter(pausedPid)).toBe(true)
      expect(classifierSettled).toBe(false)
      expect((await query(`SELECT id FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`)).rows).toHaveLength(0)
      await query('SELECT pg_cancel_backend($1)', [pausedPid])
      const aborted = await publisher
      expect(aborted.ok).toBe(true)
      if (aborted.ok) expect(aborted.value.statusCode).not.toBe(200)
      const classified = await classifier
      expect(classified.ok).toBe(false)
      if (!classified.ok) expect(classified.error).toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )
      expect(pending.rows).toHaveLength(1)
      expect(pending.rows[0]?.status).toBe('pending')
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(1)
      expect(revokeCallsFor('del-succ')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await sessions()).find((row) => row.id === winner?.successor_session_id)?.revoked_at ?? null).toBeNull()
      expect((await operations()).find((row) => row.id === winner?.id)?.status).toBe('committed')
    } finally {
      await releaseSuccessorPause(blocker)
      await publisher.catch(() => undefined)
      await classifier?.catch(() => undefined)
      await dropSuccessorPause(blocker)
    }
    await expectPauseClean(2026102216)
  })

  it('refuses a successor when the predecessor expires during the delegation lock wait', async () => {
    const predecessor = await issuePredecessor(8)
    const holder = await holdDelegation('del-succ')
    const publisher = recover(predecessor.cookie).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      expect(await waitForDelegationWaiter(0)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, predecessor.exp * 1000 - Date.now()) + 1500))
      await releaseDelegation(holder, 'del-succ')
      const published = await publisher
      expect(published.ok).toBe(false)
      if (!published.ok) expect(published.error).toMatchObject({ status: 401, code: 'PLM_MANAGED_SESSION_REQUIRED' })
      expect((await sessions()).some((row) => row.delegation_id === 'del-succ')).toBe(false)
      expect((await sessions()).find((row) => row.delegation_id === 'del-pred')?.revoked_at ?? null).toBeNull()
      expect(epoch((await sessions()).find((row) => row.delegation_id === 'del-pred')?.expires_at)).toBe(predecessor.exp)
      expect((await operations())[0]?.status).toBe('refused')
      expect((await operations())[0]?.successor_session_id ?? null).toBeNull()
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-succ'`,
      )
      expect(pending.rows).toEqual([{ id: pending.rows[0]?.id, status: 'pending' }])
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-succ')).toHaveLength(1)
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await sessions()).find((row) => row.delegation_id === 'del-pred')?.revoked_at ?? null).toBeNull()
    } finally {
      await releaseDelegation(holder, 'del-succ')
      await holder.end().catch(() => undefined)
      await publisher.catch(() => undefined)
    }
  })

  it('refuses an initial session when its credential expires during the delegation lock wait', async () => {
    const started = await beginOtherLogin(8)
    const holder = await holdDelegation('del-other-pred')
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      expect(await waitForDelegationWaiter(0)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started.exp * 1000 - Date.now()) + 1500))
      await releaseDelegation(holder, 'del-other-pred')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (published.ok) {
        expect(published.value.statusCode).toBe(503)
        expect(published.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_SESSION_EXPIRY_REFUSED' } })
        expect(published.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      }
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )
      expect(pending.rows).toHaveLength(1)
      expect(pending.rows[0]?.status).toBe('pending')
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(1)
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
    } finally {
      await releaseDelegation(holder, 'del-other-pred')
      await holder.end().catch(() => undefined)
      await publisher.catch(() => undefined)
    }
  })

  it('uses separate connections for allocation and unlink, and a stranger response does not revoke the winner', async () => {
    const predecessor = await issuePredecessor(90)
    const holder = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-unlink-holder' })
    const observer = new Client({ connectionString: pgUrl, application_name: 'plm-renewal-unlink-observer' })
    await holder.connect()
    await observer.connect()
    const lockWaiters = async () => observer.query<{ pid: number }>(
      `SELECT activity.pid
       FROM pg_stat_activity activity
       WHERE activity.state = 'active' AND activity.wait_event_type = 'Lock'
         AND activity.query ILIKE '%plm_managed_identity_links%'
         AND activity.query ILIKE '%FOR UPDATE%'
         AND activity.application_name IS DISTINCT FROM 'plm-renewal-unlink-holder'
         AND activity.application_name IS DISTINCT FROM 'plm-renewal-unlink-observer'`,
    )
    let released = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [predecessor.linkId])
      const recovery = recover(predecessor.cookie).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const recoveryDeadline = Date.now() + 3000
      let sawRecovery = false
      while (Date.now() < recoveryDeadline) {
        if ((await lockWaiters()).rows.length >= 1) {
          sawRecovery = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      if (!sawRecovery) {
        const activity = await observer.query(
          `SELECT datname, application_name, state, wait_event_type, left(query, 180) AS query
           FROM pg_stat_activity WHERE pid <> pg_backend_pid()`,
        )
        throw new Error(`recovery did not wait on the link ${JSON.stringify(activity.rows)}`)
      }
      expect(renewCalls()).toHaveLength(0)
      const unlinkPromise = unlinkManagedSource(ACTOR, { dataSourceId: SOURCE }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const contendDeadline = Date.now() + 3000
      let sawBoth = false
      while (Date.now() < contendDeadline) {
        if ((await lockWaiters()).rows.length >= 2 && renewCalls().length === 0) {
          sawBoth = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      expect(sawBoth).toBe(true)
      expect(renewCalls()).toHaveLength(0)
      await holder.query('COMMIT')
      released = true
      const [recovered, unlinked] = await Promise.all([recovery, unlinkPromise])
      expect(unlinked.ok).toBe(true)
      expect(recovered.ok === true || recovered.ok === false).toBe(true)
    } finally {
      if (!released) {
        try { await holder.query('ROLLBACK') } catch { /* the holder may already be closed */ }
      }
      await holder.end().catch(() => undefined)
      await observer.end().catch(() => undefined)
    }
    const left = await sessions()
    expect(left.length).toBeGreaterThan(0)
    expect(left.every((row) => row.revoked_at)).toBe(true)

    await resetRows()
    const winner = await issuePredecessor(90)
    const first = await recover(winner.cookie)
    expect(first.res.statusCode).toBe(200)
    const stored = (await operations())[0]
    const strangerExp = successorSpec.exp
    successorSpec = {
      ...successorSpec,
      jti: 'jti-stranger',
      delegationId: 'del-stranger',
      credentialJti: 'jti-stranger',
    }
    await expect(recover(winner.cookie)).rejects.toMatchObject({ status: 409, code: 'PLM_MANAGED_RENEW_MISMATCH' })
    const after = (await operations())[0]
    expect(after?.successor_session_id).toBe(stored?.successor_session_id)
    expect(after?.credential_ciphertext).toBe(stored?.credential_ciphertext)
    expect(String(after?.successor_exp)).toBe(String(stored?.successor_exp))
    expect(epoch((await sessions()).find((row) => row.id === stored?.successor_session_id)?.expires_at)).toBe(strangerExp)
    expect((await sessions()).find((row) => row.id === stored?.successor_session_id)?.revoked_at ?? null).toBeNull()
    const outbox = await query<{ delegation_id: string }>('SELECT delegation_id FROM plm_managed_revoke_outbox')
    expect(outbox.rows.map((row) => row.delegation_id)).toEqual(['del-stranger'])
  })

  it('returns continuity mode and native credential generation after current verification', async () => {
    const predecessor = await issuePredecessor(90)
    const linkRevision = Number(predecessor.session?.generation)
    expect(linkRevision).toBeGreaterThanOrEqual(1)
    const active = (delegationId: string) => Response.json({
      active: true,
      subject: '42',
      tenant_id: 'default',
      org_id: 'fixture-org',
      client_id: 'managed-fixture',
      issuer: ISSUER,
      scope: 'bom_review_read',
      delegation_id: delegationId,
      expires_in: 120,
      root_part_id: 'part',
      client_origin: ORIGIN,
    })
    let predecessorLive = true
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/status')) {
        const delegationId = typeof body?.delegation_id === 'string' ? body.delegation_id : ''
        if (delegationId === 'del-pred' && predecessorLive) return active(delegationId)
        if (delegationId === 'del-succ') return active(delegationId)
        return new Response(null, { status: 401 })
      }
      if (href.endsWith('/renew')) return Response.json(continuousJson(successorSpec))
      if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
      return new Response('missing', { status: 404 })
    })
    const readCurrent = async (cookie: string) => {
      const app = express()
      app.use(express.json())
      app.use('/api/plm/managed-login', managedLoginRouter)
      const currentServer = await listen(app)
      try {
        const response = await fetch(`http://127.0.0.1:${currentServer.port}/api/plm/managed-login/current`, {
          headers: { cookie: `${MANAGED_SESSION_COOKIE}=${cookie}` },
        })
        return { status: response.status, body: await response.json() as { data?: { managedSession?: Record<string, unknown> } } }
      } finally {
        await new Promise<void>((resolve, reject) => currentServer.server.close((error) => error ? reject(error) : resolve()))
      }
    }
    const before = await readCurrent(predecessor.cookie)
    expect(before.status).toBe(200)
    expect(before.body.data?.managedSession).toMatchObject({
      mode: 'managed-cookie',
      revision: linkRevision,
      continuityMode: 'continuous',
      credentialGeneration: 0,
    })
    expect(before.body.data?.managedSession?.revision).not.toBe(before.body.data?.managedSession?.credentialGeneration)
    const renewed = await recover(predecessor.cookie)
    expect(renewed.res.statusCode).toBe(200)
    const successorCookie = renewed.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
    const after = await readCurrent(successorCookie)
    expect(after.status).toBe(200)
    expect(after.body.data?.managedSession).toMatchObject({
      revision: linkRevision,
      continuityMode: 'continuous',
      credentialGeneration: 1,
    })
    predecessorLive = false
    const rotated = await readCurrent(predecessor.cookie)
    expect(rotated.status).toBe(401)
    expect(JSON.stringify(rotated.body)).not.toContain('credentialGeneration')

    await resetRows()
    const ordinarySpec: CredentialSpec = {
      jti: 'jti-ordinary-descriptor',
      exp: Math.floor(Date.now() / 1000) + 400,
      delegationId: 'del-ordinary-descriptor',
      expiresIn: 30,
      generationIndex: 0,
    }
    installOrdinaryExchange(ordinarySpec, { revokeStatus: 204, delayMs: 0 }, { at: 0 })
    const started = await beginOrdinary('source-ordinary-descriptor')
    const done = await finish(started)
    expect(done.statusCode).toBe(200)
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      if (href.endsWith('/status') && body?.delegation_id === 'del-ordinary-descriptor') return active('del-ordinary-descriptor')
      return new Response(null, { status: 401 })
    })
    const ordinary = await readCurrent(done.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')
    expect(ordinary.status).toBe(200)
    expect(ordinary.body.data?.managedSession).toMatchObject({
      continuityMode: 'ordinary',
      credentialGeneration: null,
    })
    expect(Number(ordinary.body.data?.managedSession?.revision)).toBeGreaterThanOrEqual(1)
  })

  it('denies a rotated predecessor on ordinary verification and current, and still admits exact recovery', async () => {
    const predecessor = await issuePredecessor(90)
    const renewed = await recover(predecessor.cookie)
    expect(renewed.res.statusCode).toBe(200)
    const successorId = cookieSid(renewed.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')
    installFetch()
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body })
      if (href.endsWith('/status')) {
        if (body?.delegation_id === 'del-pred') return new Response(null, { status: 401 })
        return Response.json({
          active: true,
          subject: '42',
          tenant_id: 'default',
          org_id: 'fixture-org',
          client_id: 'managed-fixture',
          issuer: ISSUER,
          scope: 'bom_review_read',
          delegation_id: body?.delegation_id,
          expires_in: 120,
          root_part_id: 'part',
          client_origin: ORIGIN,
        })
      }
      if (href.endsWith('/renew')) return Response.json(continuousJson(successorSpec))
      if (href.endsWith('/revoke')) return new Response(null, { status: 204 })
      return new Response('missing', { status: 404 })
    })
    expect(await verifyManagedCompanionToken(predecessor.cookie)).toBeNull()
    const app = express()
    app.use(express.json())
    app.use('/api/plm/managed-login', managedLoginRouter)
    const currentServer = await listen(app)
    try {
      const current = await fetch(`http://127.0.0.1:${currentServer.port}/api/plm/managed-login/current`, {
        headers: { cookie: `${MANAGED_SESSION_COOKIE}=${predecessor.cookie}` },
      })
      expect(current.status).toBe(401)
      const method = await fetch(`http://127.0.0.1:${currentServer.port}/api/plm/managed-login/renew-recovery`, {
        method: 'GET',
        headers: { cookie: `${MANAGED_SESSION_COOKIE}=${predecessor.cookie}` },
      })
      expect(method.status).toBe(405)
      expect(method.headers.get('allow')).toBe('POST')
    } finally {
      await new Promise<void>((resolve, reject) => currentServer.server.close((error) => error ? reject(error) : resolve()))
    }
    const again = await recover(predecessor.cookie)
    expect(again.res.statusCode).toBe(200)
    expect(cookieSid(again.res.cookies[MANAGED_SESSION_COOKIE]?.value ?? '')).toBe(successorId)
    expect(renewCalls().some((call) => call.url.endsWith('/renew'))).toBe(true)
    const sentinel = { id: 'sentinel' }
    await expect(recover(predecessor.cookie, {
      user: sentinel,
      headers: {
        origin: ORIGIN,
        'x-metasheet-managed-bridge': 'renew-recovery',
        cookie: `${MANAGED_SESSION_COOKIE}=${predecessor.cookie}`,
        authorization: 'Bearer not-a-session',
      },
    })).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_BEARER_REFUSED' })
    await expect(recover(predecessor.cookie, {
      headers: {
        origin: 'http://127.0.0.1:8',
        'x-metasheet-managed-bridge': 'renew-recovery',
        cookie: `${MANAGED_SESSION_COOKIE}=${predecessor.cookie}`,
      },
    })).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_ORIGIN_REFUSED' })
    await expect(recover(predecessor.cookie, {
      headers: {
        origin: ORIGIN,
        'x-metasheet-managed-bridge': 'complete',
        cookie: `${MANAGED_SESSION_COOKIE}=${predecessor.cookie}`,
      },
    })).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_BRIDGE_REFUSED' })
    expect(isGateException('/api/plm/managed-login/renew-recovery')).toBe(true)
    expect(isGateException('/api/plm/managed-login/renew-recovery/')).toBe(true)
    expect(isGateException('/api/plm/managed-login/renew-recovery/extra')).toBe(false)
    expect(isGateException('/api/plm/managed-login/renew-recovery-sibling')).toBe(false)
    expect(sentinel.id).toBe('sentinel')
  })

  it('publishes an ordinary session on the frozen expires_in deadline', async () => {
    const farExp = Math.floor(Date.now() / 1000) + 400
    const spec: CredentialSpec = {
      jti: 'jti-ordinary-ok',
      exp: farExp,
      delegationId: 'del-ordinary-ok',
      expiresIn: 30,
      generationIndex: 0,
    }
    const received = { at: 0 }
    const started = await beginOrdinary('source-ordinary-ok')
    installOrdinaryExchange(spec, { revokeStatus: 204, delayMs: 0 }, received)
    const done = await finish(started)
    expect(done.statusCode).toBe(200)
    const token = done.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
    expect(token).not.toBe('')
    const row = (await sessions())[0]
    expect(row?.delegation_id).toBe('del-ordinary-ok')
    const storedExp = epoch(row?.expires_at)
    expect(storedExp - epoch(row?.created_at)).toBe(30)
    expect(storedExp).not.toBe(farExp)
    expect(cookieExp(token)).toBe(storedExp)
    expect(cookieSid(token)).toBe(row?.id)
    const maxAge = Number(done.cookies[MANAGED_SESSION_COOKIE]?.options.maxAge)
    const remaining = storedExp * 1000 - Date.now()
    expect(maxAge).toBeGreaterThan(15_000)
    expect(maxAge).toBeLessThanOrEqual(30_000)
    expect(maxAge).toBeGreaterThanOrEqual(remaining)
    expect(maxAge - remaining).toBeLessThan(2_000)
    expect((await query('SELECT id FROM plm_managed_revoke_outbox')).rows).toEqual([])
    expect(revokeCallsFor('del-ordinary-ok')).toEqual([])
    expect((await query<{ continuity_mode: string }>(
      `SELECT continuity_mode FROM plm_managed_identity_links WHERE data_source_id = 'source-ordinary-ok'`,
    )).rows).toEqual([{ continuity_mode: 'ordinary' }])
  })

  it('refuses an ordinary session when expires_in elapses during the delegation publication wait', async () => {
    const predecessor = await issuePredecessor(90)
    const farExp = Math.floor(Date.now() / 1000) + 400
    const spec: CredentialSpec = {
      jti: 'jti-ordinary-expired',
      exp: farExp,
      delegationId: 'del-ordinary-expired',
      expiresIn: 2,
      generationIndex: 0,
    }
    const hooks = { revokeStatus: 503, delayMs: 0 }
    const received = { at: 0 }
    const started = await beginOrdinary('source-ordinary-expired')
    installOrdinaryExchange(spec, hooks, received)
    const holder = await holdDelegation('del-ordinary-expired')
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      expect(await waitForDelegationWaiter(0)).toBe(true)
      expect(received.at).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, received.at + 2600 - Date.now())))
      expect(Date.now() - received.at).toBeGreaterThanOrEqual(2500)
      await releaseDelegation(holder, 'del-ordinary-expired')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (published.ok) {
        expect(published.value.statusCode).toBe(503)
        expect(published.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_SESSION_EXPIRY_REFUSED' } })
        expect(published.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      }
      expect((await sessions()).map((row) => row.delegation_id)).toEqual(['del-pred'])
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
      expect(epoch((await sessions()).find((row) => row.id === predecessor.session?.id)?.expires_at)).toBe(predecessor.exp)
      expect((await query<{ delegation_id: string | null }>(
        `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
        [started.intent],
      )).rows[0]?.delegation_id ?? null).toBeNull()
      const pending = await query<{ id: string; delegation_id: string; status: string }>(
        `SELECT id, delegation_id, status FROM plm_managed_revoke_outbox ORDER BY delegation_id`,
      )
      expect(pending.rows.map((row) => ({ delegation_id: row.delegation_id, status: row.status }))).toEqual([
        { delegation_id: 'del-ordinary-expired', status: 'pending' },
      ])
      expect(revokeCallsFor('del-ordinary-expired')).toHaveLength(1)
      expect(revokeCallsFor('del-pred')).toEqual([])
      hooks.revokeStatus = 204
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-ordinary-expired')).toHaveLength(2)
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await query<{ delegation_id: string; status: string }>(
        `SELECT delegation_id, status FROM plm_managed_revoke_outbox ORDER BY delegation_id`,
      )).rows).toEqual([{ delegation_id: 'del-ordinary-expired', status: 'acked' }])
      const again = revokeCallsFor('del-ordinary-expired').length
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-ordinary-expired')).toHaveLength(again)
      expect((await sessions()).some((row) => row.delegation_id === 'del-ordinary-expired')).toBe(false)
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    } finally {
      await releaseDelegation(holder, 'del-ordinary-expired')
      await holder.end().catch(() => undefined)
      await publisher.catch(() => undefined)
    }
  })

  it('keeps the ordinary cookie inside the frozen expires_in deadline after a partial publication wait', async () => {
    const farExp = Math.floor(Date.now() / 1000) + 400
    const spec: CredentialSpec = {
      jti: 'jti-ordinary-partial',
      exp: farExp,
      delegationId: 'del-ordinary-partial',
      expiresIn: 15,
      generationIndex: 0,
    }
    const received = { at: 0 }
    const started = await beginOrdinary('source-ordinary-partial')
    installOrdinaryExchange(spec, { revokeStatus: 204, delayMs: 0 }, received)
    const holder = await holdDelegation('del-ordinary-partial')
    const publisher = finish(started).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      expect(await waitForDelegationWaiter(0)).toBe(true)
      expect(received.at).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, received.at + 3000 - Date.now())))
      const elapsed = Date.now() - received.at
      expect(elapsed).toBeGreaterThanOrEqual(2500)
      await releaseDelegation(holder, 'del-ordinary-partial')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (!published.ok) throw new Error('ordinary partial publication did not return a response')
      expect(published.value.statusCode).toBe(200)
      const token = published.value.cookies[MANAGED_SESSION_COOKIE]?.value ?? ''
      expect(token).not.toBe('')
      const row = (await sessions()).find((item) => item.delegation_id === 'del-ordinary-partial')
      expect(row).toBeTruthy()
      const storedExp = epoch(row?.expires_at)
      expect(storedExp - epoch(row?.created_at)).toBe(15)
      expect(storedExp).not.toBe(farExp)
      expect(storedExp).toBeLessThan(Math.floor(Date.now() / 1000) + 15 - 1)
      expect(cookieExp(token)).toBe(storedExp)
      const maxAge = Number(published.value.cookies[MANAGED_SESSION_COOKIE]?.options.maxAge)
      const remaining = storedExp * 1000 - Date.now()
      expect(maxAge).toBeLessThan(14_000)
      expect(maxAge).toBeGreaterThan(1_000)
      expect(maxAge).toBeGreaterThanOrEqual(remaining)
      expect(maxAge - remaining).toBeLessThan(2_000)
      expect((await query('SELECT delegation_id FROM plm_managed_revoke_outbox')).rows).toEqual([])
      expect(revokeCallsFor('del-ordinary-partial')).toEqual([])
    } finally {
      await releaseDelegation(holder, 'del-ordinary-partial')
      await holder.end().catch(() => undefined)
      await publisher.catch(() => undefined)
    }
  })

  it('refuses an ordinary session when the exchange itself consumes expires_in, and compensates only that untracked delegation', async () => {
    const predecessor = await issuePredecessor(90)
    const farExp = Math.floor(Date.now() / 1000) + 400
    const spec: CredentialSpec = {
      jti: 'jti-ordinary-exchange-expired',
      exp: farExp,
      delegationId: 'del-ordinary-exchange-expired',
      expiresIn: 2,
      generationIndex: 0,
    }
    const hooks = { revokeStatus: 503, delayMs: 2600 }
    const received = { at: 0 }
    const started = await beginOrdinary('source-ordinary-exchange-expired')
    installOrdinaryExchange(spec, hooks, received)
    const done = await finish(started)
    expect(received.at).toBeGreaterThan(0)
    expect(Date.now() - received.at).toBeGreaterThanOrEqual(2500)
    expect(done.statusCode).toBe(503)
    expect(done.payload).toMatchObject({ error: { code: 'PLM_MANAGED_SESSION_EXPIRY_REFUSED' } })
    expect(done.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await sessions()).map((row) => row.delegation_id)).toEqual(['del-pred'])
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    expect((await query<{ delegation_id: string | null }>(
      `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
      [started.intent],
    )).rows[0]?.delegation_id ?? null).toBeNull()
    const pending = await query<{ id: string; delegation_id: string; status: string }>(
      `SELECT id, delegation_id, status FROM plm_managed_revoke_outbox ORDER BY delegation_id`,
    )
    expect(pending.rows.map((row) => ({ delegation_id: row.delegation_id, status: row.status }))).toEqual([
      { delegation_id: 'del-ordinary-exchange-expired', status: 'pending' },
    ])
    expect(revokeCallsFor('del-ordinary-exchange-expired')).toHaveLength(1)
    expect(revokeCallsFor('del-pred')).toEqual([])
    hooks.revokeStatus = 204
    const outboxId = String(pending.rows[0]?.id ?? '')
    expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
    expect(revokeCallsFor('del-ordinary-exchange-expired')).toHaveLength(2)
    expect(revokeCallsFor('del-pred')).toEqual([])
    expect((await sessions()).some((row) => row.delegation_id === 'del-ordinary-exchange-expired')).toBe(false)
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
  })

  it('waits out a paused initial publisher before ordinary compensation and leaves that winner unrevoked', async () => {
    const predecessor = await issuePredecessor(90)
    const ordinaryStarted = await beginOrdinary('source-ordinary-publisher-first')
    const other = await beginOtherLogin()
    const blocker = await installSuccessorPause(2026102221, 'del-other-pred')
    const publisher = finish(other).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let ordinarySettled = false
    let ordinaryFlight: Promise<{ ok: true; value: Awaited<ReturnType<typeof finish>> } | { ok: false; error: unknown }> | undefined
    try {
      const pausedPid = await waitForPausedInsert()
      expect(pausedPid).toBeGreaterThan(0)
      expect((await query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [pausedPid],
      )).rows.length).toBeGreaterThan(0)
      installOrdinarySubjectMismatch(ordinaryMismatchSpec('del-other-pred'), { revokeStatus: 204 })
      ordinaryFlight = finish(ordinaryStarted).then(
        (value) => {
          ordinarySettled = true
          return { ok: true as const, value }
        },
        (error: unknown) => {
          ordinarySettled = true
          return { ok: false as const, error }
        },
      )
      expect(await waitForDelegationWaiter(pausedPid)).toBe(true)
      expect(ordinarySettled).toBe(false)
      expect((await query(`SELECT id FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`)).rows).toEqual([])
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      await blocker.query('SELECT pg_advisory_unlock(2026102221)')
      const published = await publisher
      expect(published.ok).toBe(true)
      if (!published.ok) throw new Error('paused initial publisher did not return a response')
      expect(published.value.statusCode).toBe(200)
      expect(published.value.cookies[MANAGED_SESSION_COOKIE]?.value ?? '').not.toBe('')
      const ordinary = await ordinaryFlight
      expect(ordinary.ok).toBe(true)
      if (!ordinary.ok) throw new Error('ordinary compensation did not return a response')
      expect(ordinary.value.statusCode).toBe(403)
      expect(ordinary.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(ordinary.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      const winner = (await sessions()).find((row) => row.delegation_id === 'del-other-pred')
      expect(winner).toBeTruthy()
      expect(winner?.revoked_at ?? null).toBeNull()
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
      expect(epoch((await sessions()).find((row) => row.id === predecessor.session?.id)?.expires_at)).toBe(predecessor.exp)
      expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])
      expect(revokeCallsFor('del-other-pred')).toEqual([])
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await query<{ delegation_id: string | null }>(
        `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
        [ordinaryStarted.intent],
      )).rows[0]?.delegation_id).toBe('del-other-pred')
      const beforeDrain = revokeCallsFor('del-other-pred').length
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-2' })).toMatchObject({ ok: true, state: 'acked' })
      expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-ordinary-publisher-first' })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(beforeDrain)
      expect((await sessions()).find((row) => row.id === winner?.id)?.revoked_at ?? null).toBeNull()
    } finally {
      await releaseSuccessorPause(blocker)
      await publisher.catch(() => undefined)
      await ordinaryFlight?.catch(() => undefined)
      await dropSuccessorPause(blocker)
    }
    await expectPauseClean(2026102221)
  })

  it('leaves acked ordinary compensation evidence that blocks the later initial publisher', async () => {
    const predecessor = await issuePredecessor(90)
    const ordinaryStarted = await beginOrdinary('source-ordinary-comp-acked')
    const other = await beginOtherLogin()
    let releaseExchange: (() => void) | undefined
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    let pauseNextExchange = true
    let exchangeEntered = false
    const hooks = { revokeStatus: 204 }
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const parsed = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body: parsed })
      if (href.endsWith('/exchange-continuous')) {
        if (pauseNextExchange) {
          pauseNextExchange = false
          exchangeEntered = true
          await exchangeGate
        }
        return Response.json(continuousJson(exchangeSpec))
      }
      if (href.endsWith('/managed-login/exchange')) {
        return Response.json({ ...continuousJson(ordinaryMismatchSpec('del-other-pred')), subject: 'wrong-subject' })
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: hooks.revokeStatus })
      return new Response(null, { status: 401 })
    })
    const publisher = finish(other).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      const enteredDeadline = Date.now() + 5000
      while (!exchangeEntered && Date.now() < enteredDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(exchangeEntered).toBe(true)
      expect((await query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active'
           AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
      )).rows).toHaveLength(0)
      const ordinary = await finish(ordinaryStarted)
      expect(ordinary.statusCode).toBe(403)
      expect(ordinary.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(ordinary.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      const acked = await query<{ id: string; delegation_id: string; status: string }>(
        `SELECT id, delegation_id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )
      expect(acked.rows).toHaveLength(1)
      expect(acked.rows[0]?.status).toBe('acked')
      const outboxId = String(acked.rows[0]?.id ?? '')
      expect(revokeCallsFor('del-other-pred')).toHaveLength(1)
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
      expect((await query<{ delegation_id: string | null }>(
        `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
        [ordinaryStarted.intent],
      )).rows[0]?.delegation_id).toBe('del-other-pred')
      releaseExchange?.()
      releaseExchange = undefined
      const published = await publisher
      expect(published.ok).toBe(true)
      if (!published.ok) throw new Error('later initial publisher did not return a response')
      expect(published.value.statusCode).toBe(409)
      expect(published.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(published.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      const revokeCount = revokeCallsFor('del-other-pred').length
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(revokeCount)
      expect(revokeCallsFor('del-pred')).toEqual([])
      const laterRes = responseDouble()
      const laterStart = await startManagedLogin(ACTOR, { dataSourceId: 'source-2', rootPartId: 'part' }, laterRes as never)
      const later = await finish({
        intent: laterRes.cookies[MANAGED_INTENT_COOKIE]?.value,
        nonce: laterRes.cookies[MANAGED_NONCE_COOKIE]?.value,
        state: new URL(laterStart.navigationUrl).searchParams.get('state') ?? '',
      })
      expect(later.statusCode).toBe(409)
      expect(later.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(later.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect(revokeCallsFor('del-other-pred')).toHaveLength(revokeCount)
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    } finally {
      releaseExchange?.()
      await publisher.catch(() => undefined)
    }
  })

  it('leaves pending ordinary compensation evidence that blocks the later initial publisher', async () => {
    const predecessor = await issuePredecessor(90)
    const ordinaryStarted = await beginOrdinary('source-ordinary-comp-pending')
    const other = await beginOtherLogin()
    let releaseExchange: (() => void) | undefined
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    let pauseNextExchange = true
    let exchangeEntered = false
    const hooks = { revokeStatus: 503 }
    setManagedNativeFetchForTests(async (url, init) => {
      const href = String(url)
      const parsed = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
      nativeCalls.push({ url: href, body: parsed })
      if (href.endsWith('/exchange-continuous')) {
        if (pauseNextExchange) {
          pauseNextExchange = false
          exchangeEntered = true
          await exchangeGate
        }
        return Response.json(continuousJson(exchangeSpec))
      }
      if (href.endsWith('/managed-login/exchange')) {
        return Response.json({ ...continuousJson(ordinaryMismatchSpec('del-other-pred')), subject: 'wrong-subject' })
      }
      if (href.endsWith('/revoke')) return new Response(null, { status: hooks.revokeStatus })
      return new Response(null, { status: 401 })
    })
    const publisher = finish(other).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      const enteredDeadline = Date.now() + 5000
      while (!exchangeEntered && Date.now() < enteredDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(exchangeEntered).toBe(true)
      expect((await query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active'
           AND query LIKE '%INSERT INTO plm_managed_sessions%'`,
      )).rows).toHaveLength(0)
      const ordinary = await finish(ordinaryStarted)
      expect(ordinary.statusCode).toBe(403)
      expect(ordinary.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      const pending = await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )
      expect(pending.rows).toEqual([{ id: pending.rows[0]?.id, status: 'pending' }])
      const outboxId = String(pending.rows[0]?.id ?? '')
      expect(revokeCallsFor('del-other-pred')).toHaveLength(1)
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await query<{ delegation_id: string | null }>(
        `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
        [ordinaryStarted.intent],
      )).rows[0]?.delegation_id ?? null).toBeNull()
      releaseExchange?.()
      releaseExchange = undefined
      const published = await publisher
      expect(published.ok).toBe(true)
      if (!published.ok) throw new Error('later initial publisher did not return a response')
      expect(published.value.statusCode).toBe(409)
      expect(published.value.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(published.value.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'pending' }])
      hooks.revokeStatus = 204
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(2)
      expect(revokeCallsFor('del-pred')).toEqual([])
      expect((await query<{ id: string; status: string }>(
        `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-other-pred'`,
      )).rows).toEqual([{ id: outboxId, status: 'acked' }])
      const laterRes = responseDouble()
      const laterStart = await startManagedLogin(ACTOR, { dataSourceId: 'source-2', rootPartId: 'part' }, laterRes as never)
      const later = await finish({
        intent: laterRes.cookies[MANAGED_INTENT_COOKIE]?.value,
        nonce: laterRes.cookies[MANAGED_NONCE_COOKIE]?.value,
        state: new URL(laterStart.navigationUrl).searchParams.get('state') ?? '',
      })
      expect(later.statusCode).toBe(409)
      expect(later.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
      expect(later.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
      expect((await sessions()).some((row) => row.delegation_id === 'del-other-pred')).toBe(false)
      expect(revokeCallsFor('del-other-pred')).toHaveLength(2)
      expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
      const again = revokeCallsFor('del-other-pred').length
      expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
      expect(revokeCallsFor('del-other-pred')).toHaveLength(again)
    } finally {
      releaseExchange?.()
      await publisher.catch(() => undefined)
    }
  })

  it('does not revoke or enqueue when ordinary compensation observes an already committed delegation', async () => {
    const predecessor = await issuePredecessor(90)
    const other = await beginOtherLogin()
    const published = await finish(other)
    expect(published.statusCode).toBe(200)
    const winner = (await sessions()).find((row) => row.delegation_id === 'del-other-pred')
    expect(winner?.revoked_at ?? null).toBeNull()
    const ordinaryStarted = await beginOrdinary('source-ordinary-tracked-noop')
    installOrdinarySubjectMismatch(ordinaryMismatchSpec('del-other-pred'), { revokeStatus: 204 })
    const ordinary = await finish(ordinaryStarted)
    expect(ordinary.statusCode).toBe(403)
    expect(ordinary.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
    expect(ordinary.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await query('SELECT delegation_id, status FROM plm_managed_revoke_outbox')).rows).toEqual([])
    expect(revokeCallsFor('del-other-pred')).toEqual([])
    expect(revokeCallsFor('del-pred')).toEqual([])
    expect((await sessions()).find((row) => row.id === winner?.id)?.revoked_at ?? null).toBeNull()
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    expect(epoch((await sessions()).find((row) => row.id === predecessor.session?.id)?.expires_at)).toBe(predecessor.exp)
    expect((await query<{ delegation_id: string | null }>(
      `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
      [ordinaryStarted.intent],
    )).rows[0]?.delegation_id).toBe('del-other-pred')
    expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-2' })).toMatchObject({ ok: true, state: 'acked' })
    expect(await retryManagedRevoke(ACTOR, { dataSourceId: 'source-ordinary-tracked-noop' })).toMatchObject({ ok: true, state: 'acked' })
    expect(revokeCallsFor('del-other-pred')).toEqual([])
    expect((await sessions()).find((row) => row.id === winner?.id)?.revoked_at ?? null).toBeNull()
  })

  it('drains an untracked ordinary subject mismatch and does not revoke a committed predecessor', async () => {
    const predecessor = await issuePredecessor(90)
    const ordinaryStarted = await beginOrdinary('source-ordinary-untracked-drain')
    const hooks = { revokeStatus: 204 }
    installOrdinarySubjectMismatch(ordinaryMismatchSpec('del-ordinary-untracked'), hooks)
    const ordinary = await finish(ordinaryStarted)
    expect(ordinary.statusCode).toBe(403)
    expect(ordinary.payload).toMatchObject({ error: { code: 'PLM_MANAGED_EXCHANGE_MISMATCH' } })
    expect(ordinary.cookies[MANAGED_SESSION_COOKIE]).toBeUndefined()
    expect((await sessions()).map((row) => row.delegation_id)).toEqual(['del-pred'])
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    expect(epoch((await sessions()).find((row) => row.id === predecessor.session?.id)?.expires_at)).toBe(predecessor.exp)
    const acked = await query<{ id: string; delegation_id: string; status: string }>(
      `SELECT id, delegation_id, status FROM plm_managed_revoke_outbox ORDER BY delegation_id`,
    )
    expect(acked.rows.map((row) => ({ delegation_id: row.delegation_id, status: row.status }))).toEqual([
      { delegation_id: 'del-ordinary-untracked', status: 'acked' },
    ])
    expect(revokeCallsFor('del-ordinary-untracked')).toHaveLength(1)
    expect(revokeCallsFor('del-pred')).toEqual([])
    expect((await query<{ delegation_id: string | null }>(
      `SELECT delegation_id FROM plm_managed_browser_intents WHERE id = $1`,
      [ordinaryStarted.intent],
    )).rows[0]?.delegation_id).toBe('del-ordinary-untracked')
    const outboxId = String(acked.rows[0]?.id ?? '')
    const again = revokeCallsFor('del-ordinary-untracked').length
    expect(await retryManagedRevoke(ACTOR, { outboxId })).toMatchObject({ ok: true, state: 'acked' })
    expect(revokeCallsFor('del-ordinary-untracked')).toHaveLength(again)
    expect(revokeCallsFor('del-pred')).toEqual([])
    expect((await sessions()).some((row) => row.delegation_id === 'del-ordinary-untracked')).toBe(false)
    expect((await sessions()).find((row) => row.id === predecessor.session?.id)?.revoked_at ?? null).toBeNull()
    expect((await query<{ id: string; status: string }>(
      `SELECT id, status FROM plm_managed_revoke_outbox WHERE delegation_id = 'del-ordinary-untracked'`,
    )).rows).toEqual([{ id: outboxId, status: 'acked' }])
  })
})
