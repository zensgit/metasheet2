/**
 * Admin grant proof against real Postgres.
 * The first three cases are storage fixtures. They are not a password producer and not a T4 receipt.
 * The later cases are the original issuer: real password provenance, browser establish, bcrypt issue,
 * T4 consume, one-use, budget, expiry drift, and native lock order.
 * The compare case records the two admin roots on one backend. The last case holds the real actor
 * row lock in both grant orders, proves the waiter, then releases it.
 * The scratch schema is harness cleanup. Migration down is exercised separately and does not cascade.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

const gate = vi.hoisted(() => {
  if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) {
    throw new Error('admin-grant-proof.db.test.ts requires EXPECT_DB=1 and DATABASE_URL')
  }
  const originalUrl = process.env.DATABASE_URL
  const bytes = new Uint8Array(8)
  const webcrypto = (globalThis as { crypto?: { getRandomValues: (array: Uint8Array) => Uint8Array } }).crypto
  if (!webcrypto) throw new Error('admin-grant-proof.db.test.ts requires Web Crypto')
  webcrypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  const schema = `agp_proof_${hex}`
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('owned schema was refused')
  const savedPoolMin = process.env.DB_POOL_MIN
  function withSingleOption(base: string, options: string): string {
    const url = new URL(base)
    url.searchParams.set('options', options)
    return url.href.replace(/(^|[?&])options=([^&]*)/, (_match, separator: string, value: string) => `${separator}options=${value.replace(/\+/g, '%20')}`)
  }
  process.env.SECRET_PROVIDER = 'env'
  process.env.DB_POOL_MIN = '0'
  process.env.DATABASE_URL = withSingleOption(originalUrl, `-c search_path=${schema},public`)
  return { originalUrl, schema, savedPoolMin, withSingleOption }
})

const compareWatch = vi.hoisted(() => ({
  note: null as null | (() => Promise<void>),
}))

vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>()
  return {
    ...actual,
    compare: vi.fn(function (this: unknown, ...args: Parameters<typeof actual.compare>) {
      if (!compareWatch.note) return Reflect.apply(actual.compare, this, args)
      return compareWatch.note().then(() => Reflect.apply(actual.compare, this, args))
    }),
  }
})

import * as bcrypt from 'bcryptjs'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { authService } from '../../src/auth/AuthService'
import { adminGrantApplicationMaterialFingerprint } from '../../src/auth/admin-grant-application-material'
import { encodeAdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import type { AdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import { executeAdminLoginGrantEnable } from '../../src/auth/admin-login-grant-command'
import { createAdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import type { AdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import {
  AdminGrantActorInputError,
  changeRequiredPasswordWithProvenance,
} from '../../src/auth/admin-grant-local-credential'
import {
  AdminGrantProofContractError,
  AdminGrantProofError,
  createAdminGrantProofService,
  retainAdminGrantBrowserContext,
} from '../../src/auth/admin-grant-proof'
import type { ConsumedAdminGrantProof } from '../../src/auth/admin-grant-proof'
import {
  adminGrantIntentDigest,
  insertFailedAdminGrantProof,
  insertIssuedAdminGrantProofSet,
  parseAdminGrantProof,
} from '../../src/auth/admin-grant-proof-storage'
import {
  createSecurityActionProofService,
  readAuthenticatedSessionContext,
  SecurityActionProofError,
} from '../../src/auth/security-action-proof'
import type { AuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import { SECURITY_ACTION_POLICY_REVISION } from '../../src/auth/external-login-assurance'
import { runOwnedAttempt } from '../../src/auth/security-action-attempt-admission'
import { assessSecurityActionPrivilege } from '../../src/auth/security-action-privilege'
import { pool as globalPool } from '../../src/db/pg'
import { STRICT_LOGIN_GRANT_MIGRATION_NAME } from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'
import { AUTHORIZATION_INPUT_STATEMENTS, withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'

process.env.DATABASE_URL = gate.originalUrl
if (gate.savedPoolMin === undefined) delete process.env.DB_POOL_MIN
else process.env.DB_POOL_MIN = gate.savedPoolMin

const compareSpy = vi.mocked(bcrypt.compare)

const ORIGIN = 'https://grant.example'
const OTHER_ORIGIN = 'https://other.example'
const PASSWORD = 'phrase-value'
const MATERIAL = {
  appKey: 'synthetic-app-key',
  appSecret: 'synthetic-ciphertext',
  baseUrl: 'https://directory.invalid/synthetic',
  workNotificationAgentId: 'synthetic-agent',
}
const APP_SCOPE = 'synthetic-app'
const STORAGE = 'T3 storage fixture, not a password producer and not a T4 receipt'

const proofService = createAdminGrantProofService({ publicOrigin: ORIGIN })
const browserService = createAdminGrantBrowserContext({ publicOrigin: ORIGIN })

const ACTOR_KEY_SHARE_SQL = 'SELECT 1 AS present FROM users WHERE id = $1 FOR KEY SHARE'
const ACTOR_R5_SQL = `SELECT id::text AS id,
              name,
              email,
              username,
              mobile,
              activation_status,
              role,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0)::bigint AS access_generation,
              (to_jsonb(users) ->> 'deleted_at') AS deleted_at,
              (to_jsonb(users) ->> 'purged_at') AS purged_at
         FROM users
        WHERE id = $1::text
        FOR UPDATE`
const REVALIDATION_SQL = 'AS member_group_scopes'
const RECEIVER_SQL = 'FROM directory_integrations'

type AdminRootNote = { pid: number; first: string; inserted: boolean }
type OpenAdminRoot = {
  pid: number
  first: string | null
  revalidated: boolean
  received: boolean
  inserted: boolean
}
type WrappedClient = {
  client: PoolClient
  descriptor: PropertyDescriptor | undefined
  savedQuery: PoolClient['query']
}

function queryText(args: readonly unknown[]): string {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && 'text' in first && typeof (first as { text?: unknown }).text === 'string') {
    return (first as { text: string }).text
  }
  return ''
}

function queryParams(args: readonly unknown[]): readonly unknown[] {
  const first = args[0]
  if (typeof first === 'string') return Array.isArray(args[1]) ? args[1] as readonly unknown[] : []
  if (first && typeof first === 'object' && 'values' in first && Array.isArray((first as { values?: unknown }).values)) {
    return (first as { values: readonly unknown[] }).values
  }
  return []
}

function backendPid(client: PoolClient): number {
  const pid = Number((client as PoolClient & { processID?: unknown }).processID)
  return Number.isInteger(pid) ? pid : 0
}

function isPromise(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function'
}

function installProductForwarder(decide: (client: PoolClient, args: readonly unknown[], native: unknown) => unknown): {
  restore: () => void
  descriptor: PropertyDescriptor | undefined
  savedConnect: PgPool['connect']
  clients: WrappedClient[]
} {
  if (!globalPool) throw new Error('product pool is absent')
  const owner = globalPool
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'connect')
  const savedConnect = owner.connect
  const clients: WrappedClient[] = []
  const attached = new WeakSet<PoolClient>()
  const attach = (client: PoolClient) => {
    if (attached.has(client)) return
    attached.add(client)
    const queryDescriptor = Object.getOwnPropertyDescriptor(client, 'query')
    const savedQuery = client.query
    const observedQuery = function (this: PoolClient, ...args: unknown[]) {
      return decide(this, args, Reflect.apply(savedQuery, this, args))
    }
    client.query = observedQuery as PoolClient['query']
    clients.push({ client, descriptor: queryDescriptor, savedQuery })
  }
  const observedConnect = function (this: PgPool, ...args: unknown[]) {
    const callback = args.length === 1 && typeof args[0] === 'function'
      ? args[0] as (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void
      : undefined
    if (callback) {
      return Reflect.apply(savedConnect, this, [(err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => {
        if (client) attach(client)
        callback(err, client, done)
      }])
    }
    const pending = Reflect.apply(savedConnect, this, args) as Promise<PoolClient>
    if (!isPromise(pending)) return pending
    return pending.then((client) => {
      attach(client)
      return client
    })
  }
  owner.connect = observedConnect as PgPool['connect']
  return {
    descriptor,
    savedConnect,
    clients,
    restore: () => {
      if (owner.connect === observedConnect) {
        if (descriptor) Object.defineProperty(owner, 'connect', descriptor)
        else delete (owner as { connect?: PgPool['connect'] }).connect
      }
      for (const wrapped of clients) {
        const current = wrapped.client.query
        if (current === wrapped.savedQuery) continue
        if (wrapped.descriptor) Object.defineProperty(wrapped.client, 'query', wrapped.descriptor)
        else delete (wrapped.client as { query?: PoolClient['query'] }).query
      }
    },
  }
}

function watchAdminRoots(roots: AdminRootNote[]): ReturnType<typeof installProductForwarder> {
  const open = new WeakMap<PoolClient, OpenAdminRoot>()
  return installProductForwarder((client, args, native) => {
    const text = queryText(args)
    const trimmed = text.trim()
    const state = open.get(client)
    if (state && state.first === null && trimmed !== 'COMMIT' && trimmed !== 'ROLLBACK' && trimmed.length > 0) {
      state.first = trimmed
    }
    if (state && text.includes(REVALIDATION_SQL)) state.revalidated = true
    if (state && text.includes(RECEIVER_SQL) && text.includes('FOR SHARE')) state.received = true
    if (state && text.includes('INSERT INTO security_action_challenges') && text.includes("'admin_login_grant_enable'") && text.includes("'issued'")) {
      state.inserted = true
    }
    if (!isPromise(native)) return native
    if (trimmed === 'BEGIN') {
      return native.then((value) => {
        open.set(client, {
          pid: backendPid(client),
          first: null,
          revalidated: false,
          received: false,
          inserted: false,
        })
        return value
      })
    }
    if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return native.then((value) => {
        const done = open.get(client)
        open.delete(client)
        if (trimmed === 'COMMIT' && done?.revalidated && done.received && done.first === AUTHORIZATION_INPUT_STATEMENTS.setTransaction && done.pid > 0) {
          roots.push({ pid: done.pid, first: done.first, inserted: done.inserted })
        }
        return value
      }, (error: unknown) => {
        open.delete(client)
        throw error
      })
    }
    return native
  })
}

function pauseAfterActorLock(actorId: string, sql: string): {
  held: Promise<number>
  release: () => void
  restore: () => void
  descriptor: PropertyDescriptor | undefined
  savedConnect: PgPool['connect']
  clients: WrappedClient[]
} {
  let opened = false
  let settled = false
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let settleHeld: (pid: number) => void = () => undefined
  let failHeld: (error: unknown) => void = () => undefined
  const held = new Promise<number>((resolve, reject) => {
    settleHeld = resolve
    failHeld = reject
  })
  const succeed = (pid: number) => {
    if (settled) return
    settled = true
    settleHeld(pid)
  }
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    failHeld(error)
  }
  const openGate = () => {
    if (opened) return
    opened = true
    releaseGate()
  }
  const release = () => {
    openGate()
    fail(new Error('actor lock pause released before the native query fulfilled'))
  }
  let armed = false
  const watcher = installProductForwarder((client, args, native) => {
    const params = queryParams(args)
    if (!armed && queryText(args) === sql && params.length === 1 && params[0] === actorId) {
      armed = true
      if (!isPromise(native)) {
        fail(new Error('actor lock query did not return a result'))
        return native
      }
      // The native statement has finished, so the transaction owns the row lock while delivery waits.
      return native.then((value) => {
        const pid = backendPid(client)
        if (pid < 1) {
          fail(new Error('owner backend pid was not observed'))
          openGate()
          return value
        }
        succeed(pid)
        return gate.then(() => value)
      }, (error: unknown) => {
        fail(error)
        openGate()
        throw error
      })
    }
    return native
  })
  return {
    held,
    release,
    descriptor: watcher.descriptor,
    savedConnect: watcher.savedConnect,
    clients: watcher.clients,
    restore: () => {
      release()
      watcher.restore()
    },
  }
}

function pin(index: number, witness = 'cd'.repeat(32)) {
  return {
    userId: `target-${index}`,
    identityId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    bindingRevision: '1',
    evidenceId: `evidence-${index}`,
    evidenceWitness: `witness-${index}`,
    accessGeneration: '1',
    privilegeWitness: witness,
  }
}

describe('admin grant proof native issuer', () => {
  const pool = new PgPool({
    connectionString: gate.originalUrl,
    options: `-c search_path=${gate.schema},public`,
  })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${gate.schema}`)
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        username text,
        name text,
        email text,
        mobile text,
        password_hash text,
        is_active boolean DEFAULT true,
        is_admin boolean DEFAULT false,
        role text DEFAULT 'user',
        permissions jsonb DEFAULT '[]'::jsonb,
        activation_status text DEFAULT 'activated',
        local_password_set boolean,
        must_change_password boolean,
        access_generation bigint DEFAULT 0,
        deleted_at timestamptz,
        purged_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE user_orgs (
        user_id text,
        org_id text,
        is_active boolean
      );
      CREATE TABLE roles (id text PRIMARY KEY, name text);
      CREATE TABLE user_roles (user_id text, role_id text);
      CREATE TABLE user_permissions (user_id text, permission_code text);
      CREATE TABLE role_permissions (role_id text, permission_code text);
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean);
      CREATE TABLE delegated_role_admin_scopes (
        admin_user_id text,
        namespace text,
        directory_department_id uuid,
        include_children boolean
      );
      CREATE TABLE delegated_role_admin_member_groups (
        admin_user_id text,
        namespace text,
        group_id uuid
      );
      CREATE TABLE delegated_role_admin_activation (
        admin_user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        namespace text NOT NULL,
        enabled boolean NOT NULL,
        revision uuid NOT NULL,
        PRIMARY KEY (admin_user_id, namespace)
      );
      CREATE TABLE directory_integrations (
        id uuid PRIMARY KEY,
        org_id text NOT NULL,
        provider text NOT NULL,
        name text NOT NULL,
        status text,
        corp_id text,
        config jsonb
      );
      CREATE TABLE directory_integration_capabilities (
        integration_id uuid PRIMARY KEY,
        bound_provider text,
        bound_org_id text,
        login_enabled boolean,
        login_bound_tenant text,
        login_bound_app_scope text,
        revision bigint
      );
      CREATE TABLE user_external_identities (
        id uuid PRIMARY KEY,
        provider text NOT NULL,
        external_key text NOT NULL,
        local_user_id text NOT NULL,
        corp_id text,
        provider_open_id text,
        provider_union_id text
      );
      CREATE TABLE directory_connection_application_pins (
        connection_id uuid PRIMARY KEY,
        application_revision text NOT NULL,
        material_fingerprint text NOT NULL,
        updated_by text
      );
      CREATE TABLE user_external_identity_binding_pins (
        identity_id uuid PRIMARY KEY,
        binding_revision bigint NOT NULL,
        provider text NOT NULL,
        local_user_id text NOT NULL,
        external_key text NOT NULL,
        corp_id text,
        provider_open_id text,
        provider_union_id text
      );
      CREATE TABLE user_external_identity_evidence (
        id text PRIMARY KEY,
        evidence_witness text NOT NULL,
        identity_id text NOT NULL,
        live_identity_id uuid,
        binding_revision bigint NOT NULL,
        producer_id text NOT NULL,
        assurance text NOT NULL,
        subject_key text NOT NULL,
        app_scope text NOT NULL,
        org_id text NOT NULL,
        connection_id uuid NOT NULL,
        capability_revision_seen bigint NOT NULL,
        application_revision text NOT NULL,
        material_fingerprint text NOT NULL,
        evidence_revision bigint NOT NULL,
        witnessed_at timestamptz NOT NULL,
        fresh_until timestamptz NOT NULL,
        revocation_generation bigint NOT NULL,
        slot_snapshot jsonb NOT NULL,
        created_by text NOT NULL,
        revoked_at timestamptz
      );
      CREATE TABLE user_sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
      CREATE TABLE user_session_revocations (
        user_id text PRIMARY KEY,
        revoked_after timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text,
        reason text
      );
      CREATE TABLE directory_deprovision_events (id uuid PRIMARY KEY);
      CREATE TABLE directory_sync_runs (id uuid PRIMARY KEY);
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text,
        event_category text,
        event_severity text,
        resource_type text,
        resource_id text,
        action text,
        action_details jsonb
      );
      CREATE TABLE kysely_migration (
        name varchar(255) PRIMARY KEY,
        timestamp varchar(255) NOT NULL
      );
    `)
    const challenges = await import('../../src/db/migrations/zzzz20261106120000_create_security_action_challenges.js')
    await challenges.up(db)
    const flight = await import('../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight.js')
    await flight.up(db)
    const actor = await import('../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs.js')
    const proof = await import('../../src/db/migrations/zzzz20261118100000_admin_grant_proof_sets.js')
    await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
      await actor.up(trx)
    })
    await proof.up(db)
    const strictGrant = await import('../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope.js')
    await strictGrant.up(db)
    await pool.query(
      'INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)',
      [STRICT_LOGIN_GRANT_MIGRATION_NAME, 'fixture'],
    )
  })

  afterAll(async () => {
    const failures: unknown[] = []
    try {
      await globalPool.end()
    } catch (error) {
      failures.push(error)
    }
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${gate.schema} CASCADE`)
    } catch (error) {
      failures.push(error)
    }
    try {
      await pool.end()
    } catch (error) {
      failures.push(error)
    }
    const first = failures[0]
    if (first) throw first
  })

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const value = await work(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function fixtureBinding(client: PoolClient, userId: string, sessionId: string): Promise<{
    browserBindingId: string
    credentialEstablishmentId: string
    credentialVersion: string
    expiresAt: string
  }> {
    await client.query(
      `INSERT INTO users (id, password_hash, local_password_set, must_change_password)
       VALUES ($1, $2, true, true)`,
      [userId, '$2b$04$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    )
    await client.query(
      `UPDATE users
          SET password_hash = $2, local_password_set = true, must_change_password = false
        WHERE id = $1`,
      [userId, '$2b$04$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    )
    const version = await client.query<{ local_credential_version: string }>(
      'SELECT local_credential_version::text AS local_credential_version FROM users WHERE id = $1',
      [userId],
    )
    const credentialVersion = version.rows[0]?.local_credential_version
    if (!credentialVersion) throw new Error('storage fixture credential version missing')
    const established = await client.query<{ id: string }>(
      `INSERT INTO user_local_credential_establishments
         (user_id, credential_version, kind, source_session_id)
       VALUES ($1, $2::uuid, 'self_password_change', $3)
       RETURNING id::text AS id`,
      [userId, credentialVersion, sessionId],
    )
    const browser = await client.query<{ id: string; expires_at: string }>(
      `INSERT INTO security_action_browser_bindings
         (session_id, user_id, org_id, origin, nonce_digest, expires_at)
       VALUES ($1, $2, 'org-1', 'https://grant.example', $3, clock_timestamp() + interval '1 hour')
       RETURNING id::text AS id, expires_at::text AS expires_at`,
      [sessionId, userId, 'ef'.repeat(32)],
    )
    const credentialEstablishmentId = established.rows[0]?.id
    const browserBindingId = browser.rows[0]?.id
    if (!credentialEstablishmentId || !browserBindingId) throw new Error('storage fixture binding missing')
    const expiresAt = browser.rows[0]?.expires_at
    if (!expiresAt) throw new Error('storage fixture expiry missing')
    return { browserBindingId, credentialEstablishmentId, credentialVersion, expiresAt }
  }

  function codeOf(error: unknown): string {
    if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
      throw new Error('missing error code')
    }
    return error.code
  }

  async function waitUntilBlockedBy(blockerPid: number): Promise<number> {
    const deadline = Date.now() + 3500
    while (Date.now() < deadline) {
      const blocked = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE pid <> $1 AND state = 'active' AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
          ORDER BY pid`,
        [blockerPid],
      )
      const waiter = blocked.rows[0]?.pid
      if (waiter !== undefined && waiter !== null) return Number(waiter)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    throw new Error('timed out waiting for a backend to block on the owned lock')
  }

  async function standardWitness(userId: string): Promise<string> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const assessment = await assessSecurityActionPrivilege({
        query: async (text, params) => {
          const result = await client.query(text, params)
          return { rows: result.rows, rowCount: result.rowCount }
        },
      }, userId)
      await client.query('ROLLBACK')
      if (assessment.privilegeClass !== 'standard') throw new Error('target privilege was not standard')
      return assessment.witness
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function waitPastWatermark(userId: string): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      const row = await pool.query<{ ms: string; now_ms: string }>(
        `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS ms,
                floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms
           FROM user_session_revocations WHERE user_id = $1`,
        [userId],
      )
      const ms = Number(row.rows[0]?.ms)
      const nowMs = Number(row.rows[0]?.now_ms)
      if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) throw new Error('watermark missing')
      const readyAt = (Math.floor(ms / 1000) + 1) * 1000
      if (nowMs >= readyAt && Date.now() >= readyAt) return
      if (Date.now() > deadline) throw new Error('watermark wait exceeded')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  function requestFor(userId: string, orgId: string, token: string, cookie = ''): Request {
    return {
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        ...(cookie.length > 0 ? { cookie } : {}),
      },
      user: { id: userId },
      authenticatedTenantId: orgId,
    } as unknown as Request
  }

  function responseFor(): Response & { cookies: string[] } {
    const cookies: string[] = []
    return {
      headersSent: false,
      cookies,
      append(_name: string, value: string) {
        cookies.push(value)
      },
    } as unknown as Response & { cookies: string[] }
  }

  async function openSession(userId: string, orgId: string, role: string): Promise<{
    session: AuthenticatedSessionContext
    token: string
    request: Request
  }> {
    const sessionId = `sid-${randomUUID()}`
    if (sessionId.startsWith('xs.')) throw new Error('ordinary session id was refused')
    await pool.query(
      `INSERT INTO user_sessions (id, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + interval '2 hours')`,
      [sessionId, userId],
    )
    const token = authService.createToken({
      id: userId,
      email: `${userId}@grant.example`,
      role,
      tenantId: orgId,
    } as Parameters<typeof authService.createToken>[0], { sid: sessionId })
    const request = requestFor(userId, orgId, token)
    const session = readAuthenticatedSessionContext(request)
    if (!session || session.sessionId !== sessionId || session.sessionId.startsWith('xs.')) {
      throw new Error('genuine session was refused')
    }
    return { session, token, request }
  }

  async function plant(targetCount: number, commandId: string): Promise<{
    actorId: string
    orgId: string
    connectionId: string
    intent: AdminGrantIntent
    session: AuthenticatedSessionContext
    browser: AdminGrantBrowserContext
    password: string
    cookie: string
    request: Request
  }> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    const actorId = `a${suffix}`
    const orgId = `org-${suffix}`
    const corpId = `corp-${suffix}`
    const connectionId = randomUUID()
    const fingerprint = adminGrantApplicationMaterialFingerprint(MATERIAL)
    const placeholder = bcrypt.hashSync('previous-secret', 4)
    const nextHash = bcrypt.hashSync(PASSWORD, 4)
    await pool.query(
      `INSERT INTO users
         (id, username, name, email, password_hash, is_active, is_admin, role, permissions, activation_status,
          local_password_set, must_change_password, access_generation)
       VALUES ($1, $1, $1, $2, $3, true, false, 'admin', '[]'::jsonb, 'activated', true, true, 1)`,
      [actorId, `${actorId}@grant.example`, placeholder],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
      [actorId, orgId],
    )
    const targets: Array<{
      userId: string
      identityId: string
      evidenceId: string
      evidenceWitness: string
      externalKey: string
    }> = []
    for (let index = 1; index <= targetCount; index += 1) {
      const userId = `t${suffix}-${index}`
      const identityId = randomUUID()
      const evidenceId = `ev-${suffix}-${index}`
      const evidenceWitness = `wit-${suffix}-${index}`
      const externalKey = `ext-${suffix}-${index}`
      targets.push({ userId, identityId, evidenceId, evidenceWitness, externalKey })
      await pool.query(
        `INSERT INTO users
           (id, username, name, email, is_active, is_admin, role, permissions, activation_status,
            local_password_set, must_change_password, access_generation)
         VALUES ($1, $1, $1, $2, true, false, 'user', '[]'::jsonb, 'activated', false, false, 1)`,
        [userId, `${userId}@grant.example`],
      )
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [userId, orgId],
      )
      await pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', clock_timestamp(), $1, 'admin-grant-baseline')`,
        [userId],
      )
      await pool.query(
        `INSERT INTO user_external_identities
           (id, provider, external_key, local_user_id, corp_id)
         VALUES ($1::uuid, 'dingtalk', $2, $3, $4)`,
        [identityId, externalKey, userId, corpId],
      )
      await pool.query(
        `INSERT INTO user_external_identity_binding_pins
           (identity_id, binding_revision, provider, local_user_id, external_key, corp_id)
         VALUES ($1::uuid, 1, 'dingtalk', $2, $3, $4)`,
        [identityId, userId, externalKey, corpId],
      )
    }
    await pool.query(
      `INSERT INTO directory_integrations
         (id, org_id, provider, name, status, corp_id, config)
       VALUES ($1::uuid, $2, 'dingtalk', 'fixture-not-a-producer', 'active', $3, $4::jsonb)`,
      [connectionId, orgId, corpId, JSON.stringify(MATERIAL)],
    )
    await pool.query(
      `INSERT INTO directory_integration_capabilities
         (integration_id, bound_provider, bound_org_id, login_enabled, login_bound_tenant, login_bound_app_scope, revision)
       VALUES ($1::uuid, 'dingtalk', $2, true, $3, $4, 1)`,
      [connectionId, orgId, corpId, APP_SCOPE],
    )
    await pool.query(
      `INSERT INTO directory_connection_application_pins
         (connection_id, application_revision, material_fingerprint, updated_by)
       VALUES ($1::uuid, '1', $2, 'suite')`,
      [connectionId, fingerprint],
    )
    const first = targets[0]
    const second = targets[1]
    if (!first) throw new Error('target missing')
    const witness = await standardWitness(first.userId)
    if (second) expect(await standardWitness(second.userId)).toBe(witness)
    for (const target of targets) {
      const slot = {
        corpId,
        externalKey: target.externalKey,
        localUserId: target.userId,
        provider: 'dingtalk',
        providerOpenId: null,
        providerUnionId: null,
      }
      const externalKey = target.externalKey
      await pool.query(
        `INSERT INTO user_external_identity_evidence
           (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
            assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
            application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
            revocation_generation, slot_snapshot, created_by)
         VALUES ($1, $2, $3, $4::uuid, 1, 'fixture-not-a-producer',
                 'self_authenticated', $5, $6, $7, $8::uuid, 1, '1', $9,
                 1, clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day',
                 0, $10::jsonb, 'suite')`,
        [
          target.evidenceId,
          target.evidenceWitness,
          target.identityId,
          target.identityId,
          externalKey,
          APP_SCOPE,
          orgId,
          connectionId,
          fingerprint,
          JSON.stringify(slot),
        ],
      )
    }
    const prelude = await openSession(actorId, orgId, 'admin')
    await changeRequiredPasswordWithProvenance({ session: prelude.session, passwordHash: nextHash })
    await waitPastWatermark(actorId)
    const opened = await openSession(actorId, orgId, 'admin')
    const response = responseFor()
    const browser = await browserService.establish(opened.request, response)
    const setCookie = response.cookies[0]
    if (!setCookie) throw new Error('browser cookie was not written')
    const cookie = setCookie.split(';', 1)[0] ?? ''
    const session = browser.session
    retainAdminGrantBrowserContext(ORIGIN, session, browser)
    const intent: AdminGrantIntent = {
      purpose: 'admin_login_grant_enable',
      commandId,
      actorId,
      orgId,
      provider: 'dingtalk',
      connectionId,
      applicationRevision: '1',
      targets: targets.map((target) => ({
        userId: target.userId,
        identityId: target.identityId,
        bindingRevision: '1',
        evidenceId: target.evidenceId,
        evidenceWitness: target.evidenceWitness,
        accessGeneration: '1',
        privilegeWitness: witness,
      })),
    }
    return {
      actorId,
      orgId,
      connectionId,
      intent,
      session,
      browser,
      password: PASSWORD,
      cookie,
      request: opened.request,
    }
  }

  async function issuePlanted(planted: Awaited<ReturnType<typeof plant>>) {
    const before = compareSpy.mock.calls.length
    const issued = await proofService.issue(planted.session, {
      intent: planted.intent,
      method: 'local_password',
      password: planted.password,
    })
    expect(compareSpy.mock.calls.length - before).toBe(1)
    expect(issued.purpose).toBe('admin_login_grant_enable')
    expect(issued.method).toBe('local_password')
    expect(issued.assurance).toBe('local_password')
    expect(issued.ttlSeconds).toBe(300)
    expect(issued.targetCount).toBe(planted.intent.targets.length)
    expect(issued.commandId).toBe(planted.intent.commandId)
    return issued
  }

  async function counts(proofId: string): Promise<{
    status: string
    grants: number
    receipts: number
    proofReceipts: number
    audits: number
  }> {
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM security_action_challenges WHERE id = $1::uuid`,
      [proofId],
    )
    const grants = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM user_external_identity_login_grants')
    const receipts = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM admin_login_grant_command_receipts')
    const proofReceipts = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM admin_login_grant_command_receipts WHERE proof_id = $1::uuid`,
      [proofId],
    )
    const audits = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'admin_login_grant_enable'`,
    )
    return {
      status: status.rows[0]?.status ?? '',
      grants: grants.rows[0]?.n ?? -1,
      receipts: receipts.rows[0]?.n ?? -1,
      proofReceipts: proofReceipts.rows[0]?.n ?? -1,
      audits: audits.rows[0]?.n ?? -1,
    }
  }

  it(`${STORAGE}: stores a failed row with the original null shape and no children`, async () => {
    const userId = `actor-${randomUUID()}`
    const id = randomUUID()
    await withClient(async (client) => {
      await client.query('INSERT INTO users (id) VALUES ($1)', [userId])
      await insertFailedAdminGrantProof({
        query: (text, params) => client.query(text, params),
      }, {
        id,
        userId,
        sessionId: `sid-${id}`,
        orgId: 'org-1',
        connectionId: '11111111-1111-4111-8111-111111111111',
        targetWitness: 'ab'.repeat(32),
        accessGeneration: '1',
        credentialWitness: 'cd'.repeat(32),
        privilegeWitness: 'ef'.repeat(32),
        privilegeClass: 'high',
      })
    })
    const row = await pool.query(
      `SELECT assurance, proof_hash, client_binding_digest, expires_at, failure_code, status
         FROM security_action_challenges WHERE id = $1::uuid`,
      [id],
    )
    expect(row.rows[0]).toMatchObject({
      assurance: null,
      proof_hash: null,
      client_binding_digest: null,
      expires_at: null,
      failure_code: 'credential_rejected',
      status: 'failed',
    })
    const children = await pool.query('SELECT count(*)::int AS count FROM admin_grant_proof_targets WHERE challenge_id = $1::uuid', [id])
    const seals = await pool.query('SELECT count(*)::int AS count FROM admin_grant_proof_seals WHERE challenge_id = $1::uuid', [id])
    expect(children.rows[0]?.count).toBe(0)
    expect(seals.rows[0]?.count).toBe(0)
  })

  it(`${STORAGE}: commits 101 targets and a canonical command above 256KiB`, async () => {
    async function seal(targetCount: number, commandId: string): Promise<number> {
      const targets = Array.from({ length: targetCount }, (_item, index) => pin(index + 1))
      const stored = {
        purpose: 'admin_login_grant_enable' as const,
        commandId,
        actorId: `actor-${randomUUID()}`,
        orgId: 'org-1',
        provider: 'dingtalk' as const,
        connectionId: '11111111-1111-4111-8111-111111111111',
        applicationRevision: '1',
        targets,
      }
      const canonical = encodeAdminGrantIntent(stored)
      const id = randomUUID()
      const sessionId = `sid-${id}`
      await withClient(async (client) => {
        const binding = await fixtureBinding(client, stored.actorId, sessionId)
        await insertIssuedAdminGrantProofSet({
          query: (text, params) => client.query(text, params),
        }, {
          id,
          userId: stored.actorId,
          sessionId,
          orgId: stored.orgId,
          connectionId: stored.connectionId,
          targetWitness: adminGrantIntentDigest(canonical),
          proofHash: '11'.repeat(32),
          clientBindingDigest: '22'.repeat(32),
          accessGeneration: '1',
          credentialWitness: '33'.repeat(32),
          privilegeWitness: '44'.repeat(32),
          privilegeClass: 'high',
          canonicalIntent: canonical,
          commandId,
          applicationRevision: '1',
          browserBindingId: binding.browserBindingId,
          credentialEstablishmentId: binding.credentialEstablishmentId,
          credentialVersion: binding.credentialVersion,
          watermarkUs: '0',
          tokenIssuedAt: 1700000000000,
          sessionExpiresAt: binding.expiresAt,
          browserExpiresAt: binding.expiresAt,
          children: targets.map((target, index) => ({ ordinal: index + 1, ...target })),
        })
      })
      const count = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM admin_grant_proof_targets WHERE challenge_id = $1::uuid',
        [id],
      )
      return count.rows[0]?.count ?? 0
    }
    expect(await seal(101, 'command-101')).toBe(101)
    const longCommand = `c${'m'.repeat(300000)}`
    const encoded = encodeAdminGrantIntent({
      purpose: 'admin_login_grant_enable',
      actorId: 'actor-long',
      orgId: 'org-1',
      provider: 'dingtalk',
      connectionId: '11111111-1111-4111-8111-111111111111',
      applicationRevision: '1',
      targets: [pin(1)],
      commandId: longCommand,
    })
    expect(Buffer.byteLength(encoded, 'utf8')).toBeGreaterThan(262144)
    expect(await seal(1, longCommand)).toBe(1)
  })

  it(`${STORAGE}: refuses a child on a failed parent and a down that would drop retained history`, async () => {
    const proof = await import('../../src/db/migrations/zzzz20261118100000_admin_grant_proof_sets.js')
    const userId = `actor-${randomUUID()}`
    const id = randomUUID()
    await withClient(async (client) => {
      await client.query('INSERT INTO users (id) VALUES ($1)', [userId])
      await insertFailedAdminGrantProof({
        query: (text, params) => client.query(text, params),
      }, {
        id,
        userId,
        sessionId: `sid-${id}`,
        orgId: 'org-1',
        connectionId: '11111111-1111-4111-8111-111111111111',
        targetWitness: 'ab'.repeat(32),
        accessGeneration: '1',
        credentialWitness: 'cd'.repeat(32),
        privilegeWitness: 'ef'.repeat(32),
        privilegeClass: 'high',
      })
    })
    await expect(withClient(async (client) => {
      await client.query(
        `INSERT INTO admin_grant_proof_targets
           (challenge_id, ordinal, user_id, identity_id, binding_revision, evidence_id, evidence_witness,
            access_generation, privilege_witness)
         VALUES ($1::uuid, 1, 'target-1', '00000000-0000-4000-8000-000000000001'::uuid, 1, 'evidence-1', 'witness-1', 1, $2)`,
        [id, 'ab'.repeat(32)],
      )
    })).rejects.toBeTruthy()
    await expect(db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
      await proof.down(trx)
    })).rejects.toBeTruthy()
    const still = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${gate.schema}.security_action_challenges WHERE purpose = 'admin_login_grant_enable'`,
    )
    expect(Number(still.rows[0]?.count)).toBeGreaterThan(0)
  })

  it('issues and consumes 101 targets through the real command', async () => {
    const planted = await plant(101, `command-101-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    expect(before.status).toBe('issued')
    const execution = await executeAdminLoginGrantEnable({
      publicOrigin: ORIGIN,
      context: planted.session,
      browser: planted.browser,
      intent: planted.intent,
      proof: issued.proof,
    })
    expect(execution.status).toBe('committed')
    if (execution.status !== 'committed') return
    expect(execution.receipt.targetCount).toBe(101)
    expect(execution.receipt.proofId).toBe(parsed.id)
    expect(execution.receipt.grants).toHaveLength(101)
    const after = await counts(parsed.id)
    expect(after.status).toBe('consumed')
    expect(after.grants).toBe(before.grants + 101)
    expect(after.proofReceipts).toBe(1)
    expect(after.receipts).toBe(before.receipts + 1)
    expect(after.audits).toBe(before.audits + 1)
    const again = await executeAdminLoginGrantEnable({
      publicOrigin: ORIGIN,
      context: planted.session,
      browser: planted.browser,
      intent: planted.intent,
      proof: issued.proof,
    })
    expect(again.status).toBe('committed')
    const replayed = await counts(parsed.id)
    expect(replayed.grants).toBe(after.grants)
    expect(replayed.receipts).toBe(after.receipts)
    expect(replayed.status).toBe('consumed')
  })

  it('issues and consumes a canonical command above 256KiB', async () => {
    const commandId = `c${'m'.repeat(300000)}`
    const planted = await plant(1, commandId)
    expect(Buffer.byteLength(encodeAdminGrantIntent(planted.intent), 'utf8')).toBeGreaterThan(262144)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const execution = await executeAdminLoginGrantEnable({
      publicOrigin: ORIGIN,
      context: planted.session,
      browser: planted.browser,
      intent: planted.intent,
      proof: issued.proof,
    })
    expect(execution.status).toBe('committed')
    if (execution.status !== 'committed') return
    expect(execution.receipt.commandId).toBe(commandId)
    expect(execution.receipt.targetCount).toBe(1)
    const after = await counts(parsed.id)
    expect(after.status).toBe('consumed')
    expect(after.proofReceipts).toBe(1)
  })

  it('keeps the fifth existing failure at 429 without a sixth compare or row', async () => {
    const planted = await plant(1, `budget-${randomUUID()}`)
    for (let index = 0; index < 5; index += 1) {
      await withClient(async (client) => {
        await insertFailedAdminGrantProof({
          query: (text, params) => client.query(text, params),
        }, {
          id: randomUUID(),
          userId: planted.actorId,
          sessionId: planted.session.sessionId,
          orgId: planted.orgId,
          connectionId: planted.connectionId,
          targetWitness: 'ab'.repeat(32),
          accessGeneration: '1',
          credentialWitness: 'cd'.repeat(32),
          privilegeWitness: 'ef'.repeat(32),
          privilegeClass: 'high',
        })
      })
    }
    const beforeRows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_action_challenges WHERE user_id = $1 AND status = 'failed'`,
      [planted.actorId],
    )
    const beforeCompare = compareSpy.mock.calls.length
    let refused: unknown = null
    try {
      await proofService.issue(planted.session, {
        intent: planted.intent,
        method: 'local_password',
        password: planted.password,
      })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(AdminGrantProofError)
    expect(codeOf(refused)).toBe('ADMIN_GRANT_RATE_LIMITED')
    expect((refused as AdminGrantProofError).status).toBe(429)
    expect(typeof (refused as AdminGrantProofError).retryAfter).toBe('number')
    expect(compareSpy.mock.calls.length).toBe(beforeCompare)
    const afterRows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_action_challenges WHERE user_id = $1 AND status = 'failed'`,
      [planted.actorId],
    )
    expect(afterRows.rows[0]?.n).toBe(beforeRows.rows[0]?.n)
    expect(afterRows.rows[0]?.n).toBe(5)
  })

  it('rejects an issued proof after delegation is paused and resumed with a new revision', async () => {
    const planted = await plant(1, `delegation-revision-${randomUUID()}`)
    await pool.query(
      'INSERT INTO delegated_role_admin_activation (admin_user_id, namespace, enabled, revision) VALUES ($1, $2, true, $3)',
      [planted.actorId, 'stock-prep', randomUUID()],
    )
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    for (const enabled of [false, true]) {
      await pool.query(
        'UPDATE delegated_role_admin_activation SET enabled = $2, revision = $3 WHERE admin_user_id = $1 AND namespace = $4',
        [planted.actorId, enabled, randomUUID(), 'stock-prep'],
      )
    }
    await expect(executeAdminLoginGrantEnable({
      publicOrigin: ORIGIN,
      context: planted.session,
      browser: planted.browser,
      intent: planted.intent,
      proof: issued.proof,
    })).rejects.toMatchObject({ code: 'ADMIN_GRANT_PROOF_INVALID' })
    const after = await counts(parsed.id)
    expect(after.status).toBe('issued')
    expect(after.grants).toBe(before.grants)
    expect(after.proofReceipts).toBe(0)
  })

  it('rejects consume when the session expiry moves by one microsecond', async () => {
    const planted = await plant(1, `drift-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    await pool.query(
      `UPDATE user_sessions SET expires_at = expires_at + interval '1 microsecond' WHERE id = $1`,
      [planted.session.sessionId],
    )
    let refused: unknown = null
    try {
      await executeAdminLoginGrantEnable({
        publicOrigin: ORIGIN,
        context: planted.session,
        browser: planted.browser,
        intent: planted.intent,
        proof: issued.proof,
      })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(AdminGrantProofError)
    expect(codeOf(refused)).toBe('ADMIN_GRANT_PROOF_INVALID')
    const after = await counts(parsed.id)
    expect(after.status).toBe('issued')
    expect(after.grants).toBe(before.grants)
    expect(after.proofReceipts).toBe(0)
  })

  it('refuses a seal update and leaves the issued row unchanged', async () => {
    const planted = await plant(1, `seal-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await pool.query<{ watermark_us: string }>(
      `SELECT watermark_us FROM admin_grant_proof_seals WHERE challenge_id = $1::uuid`,
      [parsed.id],
    )
    const current = before.rows[0]?.watermark_us
    if (!current) throw new Error('seal missing')
    const next = current === '9' ? '8' : '9'
    await expect(pool.query(
      `UPDATE admin_grant_proof_seals SET watermark_us = $2 WHERE challenge_id = $1::uuid`,
      [parsed.id, next],
    )).rejects.toBeTruthy()
    const after = await pool.query<{ watermark_us: string }>(
      `SELECT watermark_us FROM admin_grant_proof_seals WHERE challenge_id = $1::uuid`,
      [parsed.id],
    )
    expect(after.rows[0]?.watermark_us).toBe(current)
    expect((await counts(parsed.id)).status).toBe('issued')
  })

  it('rolls back an open consume and keeps the same-origin identity checks', async () => {
    const planted = await plant(1, `identity-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    const prepared = await proofService.prepareConsume(planted.session, {
      intent: planted.intent,
      proof: issued.proof,
    })
    const replacementResponse = responseFor()
    const replacement = await browserService.establish(
      requestFor(planted.actorId, planted.orgId, planted.request.headers.authorization?.slice(7) ?? '', planted.cookie),
      replacementResponse,
    )
    if (replacement.session === planted.session) throw new Error('replacement session was not distinct')
    let rolled: unknown = null
    try {
      await withAuthorizationInputTransaction(prepared.privilegePlan.lockPlan, async (tx) => {
        const consumed = await proofService.consumeOnTx(tx, planted.session, prepared)
        const same = createAdminGrantProofService({ publicOrigin: ORIGIN })
        same.assertConsumedOnTx(consumed, tx, planted.session, planted.intent)
        same.assertConsumedOnTx(consumed, tx, planted.session, planted.intent)
        const copied = { ...consumed } as ConsumedAdminGrantProof
        let copiedError: unknown = null
        try {
          same.assertConsumedOnTx(copied, tx, planted.session, planted.intent)
        } catch (error) {
          copiedError = error
        }
        expect(copiedError).toBeInstanceOf(AdminGrantProofContractError)
        expect(codeOf(copiedError)).toBe('ADMIN_GRANT_CONSUME_BRAND')
        const otherRequest = requestFor(planted.actorId, planted.orgId, planted.request.headers.authorization?.slice(7) ?? '')
        const otherSession = readAuthenticatedSessionContext(otherRequest)
        if (!otherSession || otherSession === planted.session) throw new Error('same-valued session was not distinct')
        let sessionError: unknown = null
        try {
          same.assertConsumedOnTx(consumed, tx, otherSession, planted.intent)
        } catch (error) {
          sessionError = error
        }
        expect(codeOf(sessionError)).toBe('ADMIN_GRANT_CONSUME_BRAND')
        const otherOrigin = createAdminGrantProofService({ publicOrigin: OTHER_ORIGIN })
        let originError: unknown = null
        try {
          otherOrigin.assertConsumedOnTx(consumed, tx, planted.session, planted.intent)
        } catch (error) {
          originError = error
        }
        expect(codeOf(originError)).toBe('ADMIN_GRANT_CONTEXT_REQUIRED')
        let txError: unknown = null
        try {
          same.assertConsumedOnTx(consumed, { open: true } as never, planted.session, planted.intent)
        } catch (error) {
          txError = error
        }
        expect(codeOf(txError)).toBe('ADMIN_GRANT_TRANSACTION_REQUIRED')
        let retainError: unknown = null
        try {
          retainAdminGrantBrowserContext(ORIGIN, planted.session, replacement)
        } catch (error) {
          retainError = error
        }
        expect(retainError).toBeInstanceOf(AdminGrantProofContractError)
        expect(codeOf(retainError)).toBe('ADMIN_GRANT_CONTEXT_REQUIRED')
        same.assertConsumedOnTx(consumed, tx, planted.session, planted.intent)
        throw new Error('rollback open consume')
      })
    } catch (error) {
      rolled = error
    }
    expect(rolled).toBeInstanceOf(Error)
    expect((rolled as Error).message).toBe('rollback open consume')
    const after = await counts(parsed.id)
    expect(after.status).toBe('issued')
    expect(after.grants).toBe(before.grants)
    expect(after.proofReceipts).toBe(0)
  })

  it('lets a binding update wait on the consume share and commit only after the receipt', async () => {
    const planted = await plant(1, `lock-share-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const holder = await pool.connect()
    const updater = await pool.connect()
    let execution: ReturnType<typeof executeAdminLoginGrantEnable> | undefined
    let executionSettled: Promise<void> = Promise.resolve()
    let update: Promise<unknown> | undefined
    let updateSettled: Promise<void> = Promise.resolve()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM security_action_challenges WHERE id = $1::uuid FOR UPDATE', [parsed.id])
      const holderPid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      execution = executeAdminLoginGrantEnable({
        publicOrigin: ORIGIN,
        context: planted.session,
        browser: planted.browser,
        intent: planted.intent,
        proof: issued.proof,
      })
      executionSettled = execution.then(() => undefined, () => undefined)
      const consumePid = await waitUntilBlockedBy(holderPid)
      update = updater.query(
        `UPDATE security_action_browser_bindings SET revoked_at = clock_timestamp() WHERE session_id = $1`,
        [planted.session.sessionId],
      )
      updateSettled = update.then(() => undefined, () => undefined)
      await waitUntilBlockedBy(consumePid)
      await holder.query('COMMIT')
      const outcome = await execution
      await update
      expect(outcome.status).toBe('committed')
      const after = await counts(parsed.id)
      expect(after.status).toBe('consumed')
      expect(after.proofReceipts).toBe(1)
      const revoked = await pool.query<{ revoked: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked FROM security_action_browser_bindings WHERE session_id = $1`,
        [planted.session.sessionId],
      )
      expect(revoked.rows[0]?.revoked).toBe(true)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await executionSettled
      await updateSettled
      holder.release()
      updater.release()
    }
  })

  it('refuses current-browser admission before fresh consume when the binding update commits first', async () => {
    const planted = await plant(1, `lock-revoke-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    const revoker = await pool.connect()
    let execution: ReturnType<typeof executeAdminLoginGrantEnable> | undefined
    let executionSettled: Promise<void> = Promise.resolve()
    try {
      await revoker.query('BEGIN')
      await revoker.query(
        `UPDATE security_action_browser_bindings SET revoked_at = clock_timestamp() WHERE session_id = $1`,
        [planted.session.sessionId],
      )
      const revokerPid = Number((await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      execution = executeAdminLoginGrantEnable({
        publicOrigin: ORIGIN,
        context: planted.session,
        browser: planted.browser,
        intent: planted.intent,
        proof: issued.proof,
      })
      executionSettled = execution.then(() => undefined, () => undefined)
      await waitUntilBlockedBy(revokerPid)
      await revoker.query('COMMIT')
      let refused: unknown = null
      try {
        await execution
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(AdminGrantActorInputError)
      expect(codeOf(refused)).toBe('ADMIN_GRANT_BROWSER_SESSION_STALE')
      expect((refused as AdminGrantActorInputError).message).toBe('Admin grant actor input refused')
      const after = await counts(parsed.id)
      expect(after.status).toBe('issued')
      expect(after.grants).toBe(before.grants)
      expect(after.proofReceipts).toBe(0)
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined)
      await executionSettled
      revoker.release()
    }
  })

  async function admitSession(userId: string, orgId: string): Promise<AuthenticatedSessionContext> {
    const opened = await openSession(userId, orgId, 'admin')
    const response = responseFor()
    const browser = await browserService.establish(opened.request, response)
    const session = browser.session
    retainAdminGrantBrowserContext(ORIGIN, session, browser)
    return session
  }

  async function flightCount(sessionId: string): Promise<number> {
    const rows = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM security_action_session_flight WHERE session_id = $1',
      [sessionId],
    )
    return rows.rows[0]?.n ?? -1
  }

  async function failedPurposes(userId: string): Promise<Record<string, number>> {
    const rows = await pool.query<{ purpose: string; n: number }>(
      `SELECT purpose, count(*)::int AS n
         FROM security_action_challenges
        WHERE user_id = $1 AND status = 'failed'
        GROUP BY purpose`,
      [userId],
    )
    const counts: Record<string, number> = {}
    for (const row of rows.rows) counts[row.purpose] = row.n
    return counts
  }

  async function idleAttemptPid(sessionId: string): Promise<number> {
    const key = `security-action-sid:${sessionId}`
    const hashed = await pool.query<{ k: string }>(
      'SELECT pg_catalog.hashtextextended($1::text, 0)::text AS k',
      [key],
    )
    const raw = BigInt(hashed.rows[0]?.k ?? '0')
    const unsigned = raw < 0n ? raw + (1n << 64n) : raw
    const classid = ((unsigned >> 32n) & 0xffffffffn).toString()
    const objid = (unsigned & 0xffffffffn).toString()
    const rows = await pool.query<{ pid: number; no_transaction: boolean; state: string }>(
      `SELECT a.pid, a.xact_start IS NULL AS no_transaction, a.state
         FROM pg_catalog.pg_locks l
         JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.granted = true
          AND l.objsubid = 1
          AND l.classid = $1::oid
          AND l.objid = $2::oid
          AND a.pid <> pg_backend_pid()`,
      [classid, objid],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.no_transaction).toBe(true)
    expect(rows.rows[0]?.state).not.toBe('idle in transaction')
    return Number(rows.rows[0]?.pid)
  }

  async function terminateOwned(pid: number): Promise<void> {
    const terminated = await pool.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(a.pid) AS terminated
         FROM pg_stat_activity a
        WHERE a.pid = $1::int
          AND a.datname = current_database()
          AND a.backend_type = 'client backend'
          AND a.pid <> pg_backend_pid()`,
      [pid],
    )
    if (terminated.rows.length !== 1 || terminated.rows[0]?.terminated !== true) {
      throw new Error('terminate missed the owned backend')
    }
  }

  async function rejectAdmin(session: AuthenticatedSessionContext, intent: AdminGrantIntent): Promise<void> {
    const before = compareSpy.mock.calls.length
    let refused: unknown = null
    try {
      await proofService.issue(session, {
        intent,
        method: 'local_password',
        password: 'wrong-phrase',
      })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(AdminGrantProofError)
    expect(codeOf(refused)).toBe('ADMIN_GRANT_CREDENTIAL_REJECTED')
    expect(compareSpy.mock.calls.length - before).toBe(1)
  }

  function otherIssue(session: AuthenticatedSessionContext, connectionId: string) {
    const resolver = async () => ({
      ok: true as const,
      kind: 'identity_revision' as const,
      witness: 'ab'.repeat(32),
    })
    const service = createSecurityActionProofService({
      isPurposeAvailable: () => true,
      resolvers: { login_grant_disable: resolver },
      runOwnedAttempt,
      recordAudit: async () => undefined,
      policyRevision: SECURITY_ACTION_POLICY_REVISION,
    })
    return service.issue(session, {
      purpose: 'login_grant_disable',
      connectionId,
      targetIdentityId: '22222222-2222-4222-8222-222222222222',
      expectedBindingRevision: 1,
      method: 'local_password',
      password: 'wrong-phrase',
    })
  }

  async function rejectOther(session: AuthenticatedSessionContext, connectionId: string): Promise<void> {
    const previous = process.env.SECURITY_ACTION_PROOF_ENABLED
    process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
    const before = compareSpy.mock.calls.length
    try {
      let refused: unknown = null
      try {
        await otherIssue(session, connectionId)
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(SecurityActionProofError)
      expect(codeOf(refused)).toBe('SECURITY_ACTION_CREDENTIAL_REJECTED')
      expect(compareSpy.mock.calls.length - before).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
      else process.env.SECURITY_ACTION_PROOF_ENABLED = previous
    }
  }

  it('observes the compare on the attempt backend with no open transaction', async () => {
    const planted = await plant(1, `same-pid-${randomUUID()}`)
    const roots: AdminRootNote[] = []
    const watcher = watchAdminRoots(roots)
    let seen = 0
    let comparePid = 0
    let settled: Promise<void> = Promise.resolve()
    compareWatch.note = async () => {
      const pid = await idleAttemptPid(planted.session.sessionId)
      const self = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      expect(pid).not.toBe(Number(self.rows[0]?.pid))
      expect(await flightCount(planted.session.sessionId)).toBe(1)
      expect(roots).toEqual([{ pid, first: AUTHORIZATION_INPUT_STATEMENTS.setTransaction, inserted: false }])
      comparePid = pid
      seen += 1
    }
    try {
      const pending = issuePlanted(planted)
      settled = pending.then(() => undefined, () => undefined)
      await pending
      expect(seen).toBe(1)
      expect(comparePid).toBeGreaterThan(0)
      expect(roots).toEqual([
        { pid: comparePid, first: AUTHORIZATION_INPUT_STATEMENTS.setTransaction, inserted: false },
        { pid: comparePid, first: AUTHORIZATION_INPUT_STATEMENTS.setTransaction, inserted: true },
      ])
      expect(await flightCount(planted.session.sessionId)).toBe(0)
    } finally {
      compareWatch.note = null
      watcher.restore()
      await settled
    }
    if (!globalPool) throw new Error('product pool is absent')
    expect(globalPool.connect).toBe(watcher.savedConnect)
    expect(Object.getOwnPropertyDescriptor(globalPool, 'connect')).toEqual(watcher.descriptor)
    for (const wrapped of watcher.clients) {
      expect(wrapped.client.query).toBe(wrapped.savedQuery)
      expect(Object.getOwnPropertyDescriptor(wrapped.client, 'query')).toEqual(wrapped.descriptor)
    }
  })

  it.each([
    ['admin failures before the other purpose', 'admin-first'],
    ['other purpose before the admin failures', 'other-first'],
  ] as const)('counts five real failures across two purposes and three sessions before the sixth compare (%s)', async (_label, order) => {
    const planted = await plant(1, `budget-${order}-${randomUUID()}`)
    const other = await openSession(planted.actorId, planted.orgId, 'admin')
    const block = await admitSession(planted.actorId, planted.orgId)
    const adminTimes = async () => {
      for (let index = 0; index < 3; index += 1) await rejectAdmin(planted.session, planted.intent)
    }
    const otherTimes = async () => {
      for (let index = 0; index < 2; index += 1) await rejectOther(other.session, planted.connectionId)
    }
    if (order === 'admin-first') {
      await adminTimes()
      await otherTimes()
    } else {
      await otherTimes()
      await adminTimes()
    }
    const before = compareSpy.mock.calls.length
    let refused: unknown = null
    try {
      await proofService.issue(block, {
        intent: planted.intent,
        method: 'local_password',
        password: planted.password,
      })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(AdminGrantProofError)
    expect(codeOf(refused)).toBe('ADMIN_GRANT_RATE_LIMITED')
    expect((refused as AdminGrantProofError).status).toBe(429)
    expect(typeof (refused as AdminGrantProofError).retryAfter).toBe('number')
    expect((refused as AdminGrantProofError).retryAfter).toBeGreaterThan(0)
    expect(compareSpy.mock.calls.length).toBe(before)
    expect(await failedPurposes(planted.actorId)).toEqual({
      admin_login_grant_enable: 3,
      login_grant_disable: 2,
    })
    expect(planted.session.sessionId).not.toBe(other.session.sessionId)
    expect(other.session.sessionId).not.toBe(block.sessionId)
  })

  it('refuses the post-compare budget when the fifth real failure commits during compare', async () => {
    const planted = await plant(1, `budget-after-${randomUUID()}`)
    const other = await openSession(planted.actorId, planted.orgId, 'admin')
    for (let index = 0; index < 2; index += 1) await rejectAdmin(planted.session, planted.intent)
    for (let index = 0; index < 2; index += 1) await rejectOther(other.session, planted.connectionId)
    let gate = true
    compareWatch.note = async () => {
      if (!gate) return
      gate = false
      const pid = await idleAttemptPid(planted.session.sessionId)
      expect(pid).toBeGreaterThan(0)
      expect(await flightCount(planted.session.sessionId)).toBe(1)
      await rejectOther(other.session, planted.connectionId)
    }
    const before = compareSpy.mock.calls.length
    try {
      let refused: unknown = null
      try {
        await proofService.issue(planted.session, {
          intent: planted.intent,
          method: 'local_password',
          password: 'wrong-phrase',
        })
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(AdminGrantProofError)
      expect(codeOf(refused)).toBe('ADMIN_GRANT_RATE_LIMITED')
      expect(compareSpy.mock.calls.length - before).toBe(2)
      expect(await failedPurposes(planted.actorId)).toEqual({
        admin_login_grant_enable: 2,
        login_grant_disable: 3,
      })
    } finally {
      compareWatch.note = null
    }
  })

  it('returns unavailable when the attempt backend is lost during compare and writes no failure', async () => {
    const planted = await plant(1, `lost-compare-${randomUUID()}`)
    compareWatch.note = async () => {
      const pid = await idleAttemptPid(planted.session.sessionId)
      expect(await flightCount(planted.session.sessionId)).toBe(1)
      await terminateOwned(pid)
    }
    try {
      let refused: unknown = null
      try {
        await proofService.issue(planted.session, {
          intent: planted.intent,
          method: 'local_password',
          password: planted.password,
        })
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(AdminGrantProofError)
      expect(codeOf(refused)).toBe('ADMIN_GRANT_UNAVAILABLE')
      expect(await failedPurposes(planted.actorId)).toEqual({})
      expect(await flightCount(planted.session.sessionId)).toBe(0)
      const issued = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM security_action_challenges WHERE user_id = $1 AND status = 'issued'`,
        [planted.actorId],
      )
      expect(issued.rows[0]?.n).toBe(0)
    } finally {
      compareWatch.note = null
    }
  })

  it('leaves the issued proof unchanged when the consume backend is lost before commit', async () => {
    const planted = await plant(1, `lost-consume-${randomUUID()}`)
    const issued = await issuePlanted(planted)
    const parsed = parseAdminGrantProof(issued.proof)
    if (!parsed) throw new Error('issued proof was not agp1')
    const before = await counts(parsed.id)
    const proofBefore = await pool.query(
      `SELECT status, expires_at::text, consumed_at::text, consumed_action_ref
         FROM security_action_challenges WHERE id = $1::uuid`,
      [parsed.id],
    )
    const holder = await pool.connect()
    let execution: ReturnType<typeof executeAdminLoginGrantEnable> | undefined
    let executionSettled: Promise<void> = Promise.resolve()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM security_action_challenges WHERE id = $1::uuid FOR UPDATE', [parsed.id])
      const holderPid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      execution = executeAdminLoginGrantEnable({
        publicOrigin: ORIGIN,
        context: planted.session,
        browser: planted.browser,
        intent: planted.intent,
        proof: issued.proof,
      })
      executionSettled = execution.then(() => undefined, () => undefined)
      const consumePid = await waitUntilBlockedBy(holderPid)
      await terminateOwned(consumePid)
      let outcome: unknown = null
      try {
        outcome = await execution
      } catch (error) {
        outcome = error
      }
      if (outcome instanceof Error) {
        expect(outcome).toBeInstanceOf(Error)
      } else {
        expect(outcome).toMatchObject({ status: 'uncertain' })
      }
      const after = await counts(parsed.id)
      expect(after).toEqual(before)
      const proofAfter = await pool.query(
        `SELECT status, expires_at::text, consumed_at::text, consumed_action_ref
           FROM security_action_challenges WHERE id = $1::uuid`,
        [parsed.id],
      )
      expect(proofAfter.rows).toEqual(proofBefore.rows)
      expect(proofAfter.rows[0]).toMatchObject({ status: 'issued', consumed_at: null, consumed_action_ref: null })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await executionSettled
      holder.release()
    }
  })

  async function readActorLockEdge(holderPid: number, pendingSql: string): Promise<{
    waiterPid: number
    query: string
  } | undefined> {
    const client = await pool.connect()
    let began = false
    try {
      await client.query('BEGIN')
      began = true
      await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()')
      const waiting = await client.query<{ waiter_pid: number; waiter_query: string; blocking: boolean; holder_open: boolean }>(
        `SELECT a.pid::int AS waiter_pid,
                btrim(a.query) AS waiter_query,
                pg_catalog.pg_blocking_pids(a.pid) @> ARRAY[$1::int] AS blocking,
                h.xact_start IS NOT NULL AS holder_open
           FROM pg_catalog.pg_stat_activity a
           JOIN pg_catalog.pg_stat_activity h ON h.pid = $1
          WHERE a.pid <> pg_catalog.pg_backend_pid()
            AND a.pid <> $1
            AND a.datname = current_database()
            AND a.state = 'active'
            AND a.wait_event_type = 'Lock'
            AND pg_catalog.pg_blocking_pids(a.pid) @> ARRAY[$1::int]
            AND btrim(a.query) = $2`,
        [holderPid, pendingSql],
      )
      const row = waiting.rows.length === 1 ? waiting.rows[0] : undefined
      if (!row || row.blocking !== true || row.holder_open !== true) return undefined
      const locks = await client.query<{ waiter_ungranted: boolean }>(
        `SELECT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_locks l
             WHERE l.pid = $1
               AND NOT l.granted
          ) AS waiter_ungranted`,
        [row.waiter_pid],
      )
      if (locks.rows[0]?.waiter_ungranted !== true) return undefined
      return { waiterPid: Number(row.waiter_pid), query: row.waiter_query }
    } finally {
      if (began) await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  }

  async function pollActorLockEdge(holderPid: number, pendingSql: string): Promise<{
    waiterPid: number
    query: string
  }> {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const edge = await readActorLockEdge(holderPid, pendingSql)
      if (edge && edge.waiterPid !== holderPid) return edge
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('timed out waiting for the actor lock edge')
  }

  it.each([
    ['new actor R5 held before the old key share', 'r5-first', ACTOR_R5_SQL, ACTOR_KEY_SHARE_SQL],
    ['old key share held before the new actor R5', 'key-share-first', ACTOR_KEY_SHARE_SQL, ACTOR_R5_SQL],
  ] as const)('blocks the opposite grant on the actor row and then releases (%s)', async (_label, order, holderSql, waiterSql) => {
    const planted = await plant(1, `edge-${order}-${randomUUID()}`)
    const other = await openSession(planted.actorId, planted.orgId, 'admin')
    expect(other.session.sessionId).not.toBe(planted.session.sessionId)
    const previous = process.env.SECURITY_ACTION_PROOF_ENABLED
    process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
    const before = compareSpy.mock.calls.length
    const pause = pauseAfterActorLock(planted.actorId, holderSql)
    const issueAdmin = () => proofService.issue(planted.session, {
      intent: planted.intent,
      method: 'local_password',
      password: planted.password,
    })
    const issueOld = () => otherIssue(other.session, planted.connectionId)
    type AttemptOutcome = { ok: true; value: unknown } | { ok: false; error: unknown }
    const settleAttempt = (work: Promise<unknown>): Promise<AttemptOutcome> => work.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let holderOutcome: Promise<AttemptOutcome> = Promise.resolve({ ok: true as const, value: undefined })
    let waiterOutcome: Promise<AttemptOutcome> = Promise.resolve({ ok: true as const, value: undefined })
    try {
      holderOutcome = settleAttempt(order === 'r5-first' ? issueAdmin() : issueOld())
      const holderPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for the held actor lock')), 8000)
        let done = false
        const finishOk = (pid: number) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(pid)
        }
        const finishErr = (error: unknown) => {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(error)
        }
        pause.held.then((pid) => finishOk(pid), (error: unknown) => finishErr(error))
        holderOutcome.then((outcome) => {
          if (outcome.ok === true) finishErr(new Error('holder finished before the actor lock was held'))
          else finishErr(outcome.error)
        })
      })
      expect(holderPid).toBeGreaterThan(0)
      waiterOutcome = settleAttempt(order === 'r5-first' ? issueOld() : issueAdmin())
      const edge = await pollActorLockEdge(holderPid, waiterSql)
      expect(edge.waiterPid).toBeGreaterThan(0)
      expect(edge.waiterPid).not.toBe(holderPid)
      expect(edge.query).toBe(waiterSql)
      const linked = await pool.query<{ linked: boolean }>(
        'SELECT pg_catalog.pg_blocking_pids($1::integer) @> ARRAY[$2::integer] AS linked',
        [edge.waiterPid, holderPid],
      )
      expect(linked.rows[0]?.linked).toBe(true)
      pause.release()
      const admin = await (order === 'r5-first' ? holderOutcome : waiterOutcome)
      const old = await (order === 'r5-first' ? waiterOutcome : holderOutcome)
      expect(admin.ok).toBe(true)
      if (admin.ok) {
        expect(admin.value).toMatchObject({
          purpose: 'admin_login_grant_enable',
          method: 'local_password',
          assurance: 'local_password',
          ttlSeconds: 300,
          targetCount: 1,
        })
      }
      expect(old.ok).toBe(false)
      if (old.ok === false) {
        expect(old.error).toBeInstanceOf(SecurityActionProofError)
        expect(codeOf(old.error)).toBe('SECURITY_ACTION_CREDENTIAL_REJECTED')
      }
      expect(compareSpy.mock.calls.length - before).toBe(2)
      expect(await failedPurposes(planted.actorId)).toEqual({ login_grant_disable: 1 })
      const issued = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM security_action_challenges
          WHERE user_id = $1 AND purpose = 'admin_login_grant_enable' AND status = 'issued'`,
        [planted.actorId],
      )
      expect(issued.rows[0]?.n).toBe(1)
      expect(await flightCount(planted.session.sessionId)).toBe(0)
      expect(await flightCount(other.session.sessionId)).toBe(0)
    } finally {
      pause.release()
      pause.restore()
      await holderOutcome
      await waiterOutcome
      if (previous === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
      else process.env.SECURITY_ACTION_PROOF_ENABLED = previous
    }
    if (!globalPool) throw new Error('product pool is absent')
    expect(globalPool.connect).toBe(pause.savedConnect)
    expect(Object.getOwnPropertyDescriptor(globalPool, 'connect')).toEqual(pause.descriptor)
    for (const wrapped of pause.clients) {
      expect(wrapped.client.query).toBe(wrapped.savedQuery)
      expect(Object.getOwnPropertyDescriptor(wrapped.client, 'query')).toEqual(wrapped.descriptor)
    }
  })
})
