/**
 * Native strict DingTalk entry. This author does not run it.
 * Without EXPECT_DB=1 the suite is skipped. A skip is not a pass.
 * EXPECT_DB=1 without DATABASE_URL throws.
 * Identity, pin, and evidence rows are a named fixture boundary, not T2 provider or ceremony output.
 * The current grant is inserted only by executeAdminLoginGrantEnable after issue().
 * Lifetime cases share this shell. A second file would only repeat it.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { adminGrantApplicationMaterialFingerprint } from '../../src/auth/admin-grant-application-material'
import { createAdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import type { AdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import { normalizeAdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import type { AdminGrantIntent, AdminGrantTargetPin } from '../../src/auth/admin-login-grant-intent'
import { executeAdminLoginGrantEnable } from '../../src/auth/admin-login-grant-command'
import type { AdminLoginGrantCommandExecution } from '../../src/auth/admin-login-grant-command'
import { changeRequiredPasswordWithProvenance } from '../../src/auth/admin-grant-local-credential'
import { createAdminGrantProofService, retainAdminGrantBrowserContext } from '../../src/auth/admin-grant-proof'
import type { AuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import { assessSecurityActionPrivilege } from '../../src/auth/security-action-privilege'
import { authService } from '../../src/auth/AuthService'
import {
  STRICT_DINGTALK_ENTRY_GATES,
  STRICT_SESSION_MAX_AGE_ENV,
  StrictDingTalkEntryError,
  bindStrictDingTalkEntryLocal,
  classifyVerifiedSessionPayload,
  strictSelectorMismatch,
} from '../../src/auth/strict-dingtalk-entry'
import type { StrictDingTalkLocalBinding } from '../../src/auth/strict-dingtalk-entry'
import {
  commandKeyFor,
  insertConnectionLoginScope,
  parseStrictSessionContext,
  revokeForUserInScope,
} from '../../src/auth/strict-login-grant-store'
import type { StrictLoginGrantCaller } from '../../src/auth/strict-login-grant-store'
import { up as challengesUp } from '../../src/db/migrations/zzzz20261106120000_create_security_action_challenges'
import { up as flightUp } from '../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight'
import { up as receivingUp } from '../../src/db/migrations/zzzz20261117173000_create_admin_grant_receiving_pins'
import { up as actorUp } from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'
import { up as proofUp } from '../../src/db/migrations/zzzz20261118100000_admin_grant_proof_sets'
import {
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  up as strictUp,
} from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'
import { pool as nativePool } from '../../src/db/pg'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { AuthorizationInputHandlerClient, AuthorizationInputTransactionRunner } from '../../src/rbac/authorization-input-lock'
import { contextFor, requestShape, tokenFor } from '../helpers/security-action-proof-harness'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for strict-dingtalk-entry.db.test.ts')
}

const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip
const ORIGIN = 'https://directory.invalid'
const PASSWORD = 'fixture-password'
const MATERIAL = {
  appKey: 'synthetic-app-key',
  appSecret: 'synthetic-ciphertext',
  baseUrl: 'https://directory.invalid/synthetic',
  workNotificationAgentId: 'synthetic-agent',
}
const WEB_CODE = 'web-auth-code'
const CONTAINER_CODE = 'container-auth-code'
const USER_ACCESS_TOKEN = 'synthetic-user-access-token'
const APP_ACCESS_TOKEN = 'synthetic-app-access-token'
const kept: string[] = []

type SavedPoolStartup = {
  options: string | undefined
  searchPath: string
}

let savedPoolStartup: SavedPoolStartup | null = null
let fixturePool: Pool | null = null

type Rows = Array<Record<string, unknown>>

type Env = {
  schema: string
  pool: Pool
  rows(text: string, params?: unknown[]): Promise<Rows>
  count(table: string): Promise<number>
}

type Minted = {
  context: AuthenticatedSessionContext
  browser: AdminGrantBrowserContext
}

type Seeded = {
  intent: AdminGrantIntent
  minted: Minted
  actorId: string
  commandKey: string
  connectionId: string
  orgId: string
  corpId: string
  userId: string
  identityId: string
  evidenceId: string
  openId: string
  unionId: string
  subjectKey: string
}

type ProviderCall = {
  url: string
  method: string
  body: string | null
  accessTokenHeader: string | null
}

type Opened = {
  seeded: Seeded
  binding: StrictDingTalkLocalBinding
  calls: ProviderCall[]
  pool: Pool
}

type HeldSession = {
  token: string
  sid: string
}

const held: { web?: HeldSession; container?: HeldSession } = {}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error('STRICT_ENTRY_NATIVE_FIXTURE_SCHEMA_REFUSED')
  return `"${identifier}"`
}

function namesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter((item) => item.length > 0)
  throw new Error('STRICT_ENTRY_NATIVE_SEARCH_PATH_UNREADABLE')
}

function ageEnv(seconds?: string): Record<string, string | undefined> {
  if (seconds === undefined) return {}
  return { [STRICT_SESSION_MAX_AGE_ENV]: seconds }
}

function callerFrom(client: { query: Pool['query'] }): StrictLoginGrantCaller {
  return {
    async query(text, params) {
      const result = await client.query(text, params)
      return {
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: result.rowCount,
      }
    },
  }
}

async function withCaller<T>(pool: Pool, work: (caller: StrictLoginGrantCaller) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const value = await work(callerFrom(client))
    await client.query('COMMIT')
    committed = true
    return value
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function headerValue(headers: ConstructorParameters<typeof Headers>[0] | undefined, name: string): string | null {
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(name)
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name)
    return found ? String(found[1]) : null
  }
  const record = headers as Record<string, string>
  const key = Object.keys(record).find((item) => item.toLowerCase() === name)
  return key ? String(record[key]) : null
}

function providerFetch(seeded: Seeded, calls: ProviderCall[]): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input)
    const body = typeof init?.body === 'string' ? init.body : null
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body,
      accessTokenHeader: headerValue(init?.headers, 'x-acs-dingtalk-access-token'),
    })
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken') {
      return json({ accessToken: USER_ACCESS_TOKEN })
    }
    if (url === 'https://api.dingtalk.com/v1.0/contact/users/me') {
      return json({ openId: seeded.openId, unionId: seeded.unionId })
    }
    if (url === `https://oapi.dingtalk.com/gettoken?appkey=${MATERIAL.appKey}&appsecret=${MATERIAL.appSecret}`) {
      return json({ errcode: 0, access_token: APP_ACCESS_TOKEN })
    }
    if (url === `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${APP_ACCESS_TOKEN}`) {
      return json({ errcode: 0, result: { userid: 'synthetic-directory-user', unionid: seeded.unionId } })
    }
    return new Response(JSON.stringify({ errcode: 1 }), { status: 500 })
  }
}

function runFixtureTransaction(pool: Pool): AuthorizationInputTransactionRunner {
  return async <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: async (text, params) => {
            const result = await client.query(text, params)
            return {
              rows: result.rows as Array<Record<string, unknown>>,
              rowCount: result.rowCount,
            }
          },
          __rawClient: client,
        })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    } finally {
      client.release()
    }
  }
}

async function assertSearchPath(pool: Pool, schema: string): Promise<void> {
  const seen = await pool.query('SELECT pg_catalog.current_schemas(false) AS names')
  const names = namesOf(seen.rows[0]?.names)
  expect(names[0]).toBe(schema)
  expect(names).toContain('pg_catalog')
  expect(names).not.toContain('public')
}

async function waitForWatermarkSecond(watermarkMs: string): Promise<void> {
  const mark = BigInt(watermarkMs)
  const deadline = Date.now() + 2500
  while (BigInt(Math.floor(Date.now() / 1000)) * 1000n <= mark) {
    if (Date.now() >= deadline) throw new Error('STRICT_ENTRY_NATIVE_WATERMARK_WAIT_EXCEEDED')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitUntilEvidenceStale(pool: Pool, evidenceId: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const seen = await pool.query(
      `SELECT (fresh_until < pg_catalog.clock_timestamp()) AS stale
         FROM user_external_identity_evidence
        WHERE id = $1`,
      [evidenceId],
    )
    if (seen.rows[0]?.stale === true) return
    if (Date.now() >= deadline) throw new Error('STRICT_ENTRY_NATIVE_FRESHNESS_WAIT_EXCEEDED')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function inReadCommitted(db: Kysely<unknown>, work: (trx: Kysely<unknown>) => Promise<void>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
    await work(trx)
  })
}

async function rememberPoolStartup(): Promise<void> {
  if (!nativePool) throw new Error('STRICT_ENTRY_NATIVE_POOL_ABSENT')
  if (savedPoolStartup) return
  const startup = nativePool.options.options
  const client = await nativePool.connect()
  try {
    const seen = await client.query(`SELECT pg_catalog.current_setting('search_path') AS search_path`)
    const searchPath = seen.rows[0]?.search_path
    if (typeof searchPath !== 'string' || searchPath.length === 0) {
      throw new Error('STRICT_ENTRY_NATIVE_POOL_STARTUP_UNREADABLE')
    }
    savedPoolStartup = {
      options: typeof startup === 'string' ? startup : undefined,
      searchPath,
    }
  } finally {
    client.release()
  }
}

async function aimNativePool(schema: string): Promise<void> {
  if (!nativePool) throw new Error('STRICT_ENTRY_NATIVE_POOL_ABSENT')
  await rememberPoolStartup()
  const searchPath = `${schema},pg_catalog`
  nativePool.options.options = `-c search_path=${searchPath}`
  const max = nativePool.options.max ?? 10
  const heldClients = []
  try {
    while (heldClients.length < max && (nativePool.idleCount > 0 || nativePool.totalCount < max)) {
      const client = await nativePool.connect()
      heldClients.push(client)
      await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [searchPath])
    }
  } finally {
    for (const client of heldClients) client.release()
  }
  await assertSearchPath(nativePool, schema)
}

async function releaseNativePool(): Promise<void> {
  if (!nativePool || !savedPoolStartup) return
  const saved = savedPoolStartup
  savedPoolStartup = null
  if (saved.options === undefined) delete nativePool.options.options
  else nativePool.options.options = saved.options
  const max = nativePool.options.max ?? 10
  const heldClients = []
  try {
    while (heldClients.length < max && (nativePool.idleCount > 0 || nativePool.totalCount > heldClients.length)) {
      const client = await nativePool.connect()
      heldClients.push(client)
      await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [saved.searchPath])
    }
  } finally {
    for (const client of heldClients) client.release()
  }
}

async function install(pool: Pool, db: Kysely<unknown>, schema: string): Promise<void> {
  await pool.query(`
    -- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
    CREATE TABLE subject_authorization_versions (
      subject_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id text PRIMARY KEY,
      username text,
      name text,
      email text,
      mobile text,
      password_hash text,
      is_active boolean NOT NULL,
      is_admin boolean NOT NULL,
      role text,
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      activation_status text NOT NULL,
      local_password_set boolean NOT NULL,
      must_change_password boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      access_generation bigint NOT NULL,
      deleted_at timestamptz,
      purged_at timestamptz
    );
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL
    );
    CREATE TABLE roles (id text PRIMARY KEY, name text);
    CREATE TABLE user_roles (user_id text NOT NULL, role_id text NOT NULL);
    CREATE TABLE user_permissions (user_id text NOT NULL, permission_code text NOT NULL);
    CREATE TABLE role_permissions (role_id text NOT NULL, permission_code text NOT NULL);
    CREATE TABLE user_namespace_admissions (
      user_id text NOT NULL,
      namespace text NOT NULL,
      enabled boolean NOT NULL,
      source text,
      granted_by text,
      updated_by text,
      created_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE delegated_role_admin_scopes (
      admin_user_id text NOT NULL,
      namespace text NOT NULL,
      directory_department_id uuid,
      include_children boolean
    );
    CREATE TABLE delegated_role_admin_member_groups (
      admin_user_id text NOT NULL,
      namespace text NOT NULL,
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
    CREATE TABLE user_sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      issued_at timestamptz,
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz,
      revoked_at timestamptz,
      revoked_by text,
      revoke_reason text,
      ip_address text,
      user_agent text,
      created_at timestamptz,
      updated_at timestamptz
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
    CREATE TABLE kysely_migration (
      name varchar(255) PRIMARY KEY,
      timestamp varchar(255) NOT NULL
    );
  `)
  await inReadCommitted(db, async (trx) => {
    await challengesUp(trx)
    await flightUp(trx)
    await receivingUp(trx)
    await actorUp(trx)
    await proofUp(trx)
    await strictUp(trx)
  })
  const flight = await pool.query(
    `SELECT ns.nspname AS schema_name
       FROM pg_catalog.pg_class rel
       JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE rel.oid = to_regclass('security_action_session_flight')`,
  )
  expect(flight.rows).toEqual([{ schema_name: schema }])
  const acquire = await pool.query(
    `SELECT ns.nspname AS schema_name
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
      WHERE proc.proname = 'security_action_session_flight_acquire'
        AND ns.nspname = $1`,
    [schema],
  )
  expect(acquire.rows).toEqual([{ schema_name: schema }])
  await pool.query(`
    CREATE TABLE audit_logs (
      id bigserial,
      event_type varchar(100) NOT NULL,
      event_category varchar(50) NOT NULL,
      event_severity varchar(20) DEFAULT 'INFO',
      resource_type varchar(100),
      resource_id varchar(255),
      action varchar(100) NOT NULL,
      action_details jsonb,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `)
  const bounds = await pool.query(`
    SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY_MM') AS suffix,
           to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS start_date,
           to_char(date_trunc('month', CURRENT_DATE) + interval '1 month', 'YYYY-MM-DD') AS end_date
  `)
  const suffix = String(bounds.rows[0]?.suffix)
  const startDate = String(bounds.rows[0]?.start_date)
  const endDate = String(bounds.rows[0]?.end_date)
  const partition = `audit_logs_${suffix}`
  if (!/^[a-z_][a-z0-9_]*$/.test(partition) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('STRICT_ENTRY_NATIVE_AUDIT_PARTITION_REFUSED')
  }
  await pool.query(
    `CREATE TABLE ${quote(schema)}.${quote(partition)} PARTITION OF ${quote(schema)}.audit_logs FOR VALUES FROM ('${startDate}') TO ('${endDate}')`,
  )
  await pool.query(
    `INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)`,
    [STRICT_LOGIN_GRANT_MIGRATION_NAME, '2026-11-18T12:00:00.000Z'],
  )
}

async function witnesses(pool: Pool, userIds: readonly string[]): Promise<Map<string, string>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const executor: Queryable = {
      query: async (text, params) => {
        const result = await client.query(text, params)
        return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
      },
    }
    const found = new Map<string, string>()
    for (const userId of userIds) {
      const assessment = await assessSecurityActionPrivilege(executor, userId)
      if (assessment.privilegeClass !== 'standard' || assessment.reasons.length !== 0) {
        throw new Error('STRICT_ENTRY_NATIVE_TARGET_PRIVILEGE_REFUSED')
      }
      found.set(userId, assessment.witness)
    }
    await client.query('COMMIT')
    return found
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function captureResponse(): Response {
  const sent = { value: false }
  const res = {
    get headersSent() { return sent.value },
    append(_field: string, _value: string) {
      return this
    },
  }
  return res as unknown as Response
}

async function seed(env: Env): Promise<Seeded> {
  const suffix = randomBytes(4).toString('hex')
  const actorId = `a-actor-${suffix}`
  const orgId = `org-${suffix}`
  const connectionId = randomUUID()
  const corpId = `corp-${suffix}`
  const userId = `t0000-${suffix}`
  const identityId = randomUUID()
  const evidenceId = `ev-0000-${suffix}`
  const evidenceWitness = `wit-0000-${suffix}`
  const externalKey = `ext-0000-${suffix}`
  const openId = `open-${suffix}`
  const unionId = `union-${suffix}`
  const subjectKey = `${corpId}:${openId}`
  const fingerprint = adminGrantApplicationMaterialFingerprint(MATERIAL)
  const passwordHash = bcrypt.hashSync(PASSWORD, 4)
  await env.pool.query(
    `INSERT INTO users
       (id, username, name, password_hash, is_active, is_admin, role, activation_status,
        local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $1, 'fixture-prior-hash', true, true, 'admin', 'activated', true, true, 1)`,
    [actorId],
  )
  await env.pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
    [actorId, orgId],
  )
  await env.pool.query(
    `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
     VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'fixture')`,
    [actorId],
  )
  const sessionId = `sid${randomBytes(8).toString('hex')}`
  await env.pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '2 hours')`,
    [sessionId, actorId],
  )
  await env.pool.query(
    `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
     VALUES ($1::uuid, $2, 'dingtalk', 'fixture-not-a-producer', 'active', $3, $4::jsonb)`,
    [connectionId, orgId, corpId, JSON.stringify(MATERIAL)],
  )
  await env.pool.query(
    `INSERT INTO directory_integration_capabilities
       (integration_id, bound_provider, bound_org_id, login_enabled, login_bound_tenant, login_bound_app_scope, revision)
     VALUES ($1::uuid, 'dingtalk', $2, true, $3, 'synthetic-app', 4)`,
    [connectionId, orgId, corpId],
  )
  await env.pool.query(
    `INSERT INTO directory_connection_application_pins
       (connection_id, application_revision, material_fingerprint, updated_by)
     VALUES ($1::uuid, '4', $2, 'suite')`,
    [connectionId, fingerprint],
  )
  await env.pool.query(
    `INSERT INTO users
       (id, username, name, password_hash, is_active, is_admin, role, activation_status,
        local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $1, $2, true, false, 'user', 'activated', true, false, 1)`,
    [userId, passwordHash],
  )
  await env.pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
    [userId, orgId],
  )
  await env.pool.query(
    `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
     VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'fixture')`,
    [userId],
  )
  await env.pool.query(
    `INSERT INTO user_external_identities
       (id, provider, external_key, local_user_id, corp_id, provider_open_id, provider_union_id)
     VALUES ($1::uuid, 'dingtalk', $2, $3, $4, $5, $6)`,
    [identityId, externalKey, userId, corpId, openId, unionId],
  )
  await env.pool.query(
    `INSERT INTO user_external_identity_binding_pins
       (identity_id, binding_revision, provider, local_user_id, external_key, corp_id, provider_open_id, provider_union_id)
     VALUES ($1::uuid, 7, 'dingtalk', $2, $3, $4, $5, $6)`,
    [identityId, userId, externalKey, corpId, openId, unionId],
  )
  const slot = {
    corpId,
    externalKey,
    localUserId: userId,
    provider: 'dingtalk',
    providerOpenId: openId,
    providerUnionId: unionId,
  }
  await env.pool.query(
    `INSERT INTO user_external_identity_evidence
       (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
        assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
        application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
        revocation_generation, slot_snapshot, created_by)
     VALUES ($1, $2, $3::text, $3::uuid, 7, 'fixture-not-a-producer',
             'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 4, '4', $7,
             1, pg_catalog.clock_timestamp() - interval '2 days',
             pg_catalog.clock_timestamp() + interval '45 seconds',
             0, $8::jsonb, 'suite')`,
    [evidenceId, evidenceWitness, identityId, subjectKey, orgId, connectionId, fingerprint, JSON.stringify(slot)],
  )
  const privilege = await witnesses(env.pool, [userId])
  const privilegeWitness = privilege.get(userId)
  if (!privilegeWitness) throw new Error('STRICT_ENTRY_NATIVE_TARGET_PRIVILEGE_REFUSED')
  const pin: AdminGrantTargetPin = {
    userId,
    identityId,
    bindingRevision: '7',
    evidenceId,
    evidenceWitness,
    accessGeneration: '1',
    privilegeWitness,
  }
  const intent = normalizeAdminGrantIntent({
    purpose: 'admin_login_grant_enable',
    commandId: 'strict-entry-native',
    actorId,
    orgId,
    provider: 'dingtalk',
    connectionId,
    applicationRevision: '4',
    targets: [pin],
  })
  const established = await changeRequiredPasswordWithProvenance({
    session: contextFor(actorId, sessionId, orgId),
    passwordHash,
  })
  const actor = await env.rows(
    `SELECT must_change_password, local_credential_version::text AS version
       FROM users WHERE id = $1`,
    [actorId],
  )
  expect(actor[0]?.must_change_password).toBe(false)
  expect(String(actor[0]?.version).toLowerCase()).toBe(established.credentialVersion)
  const mark = await env.rows(
    `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS watermark_ms
       FROM user_session_revocations
      WHERE user_id = $1`,
    [actorId],
  )
  const watermarkMs = mark[0]?.watermark_ms
  if (typeof watermarkMs !== 'string' || !/^[0-9]+$/.test(watermarkMs)) {
    throw new Error('STRICT_ENTRY_NATIVE_WATERMARK_UNREADABLE')
  }
  await waitForWatermarkSecond(watermarkMs)
  const issuedSessionId = `sid${randomBytes(8).toString('hex')}`
  await env.pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '2 hours')`,
    [issuedSessionId, actorId],
  )
  const token = tokenFor(actorId, issuedSessionId, orgId)
  const request = requestShape(actorId, token, orgId, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  })
  const browser = await createAdminGrantBrowserContext({ publicOrigin: ORIGIN }).establish(
    request as Request,
    captureResponse(),
  )
  if (BigInt(browser.session.tokenIssuedAt) * 1000n <= BigInt(watermarkMs)) {
    throw new Error('STRICT_ENTRY_NATIVE_TOKEN_NOT_AFTER_WATERMARK')
  }
  retainAdminGrantBrowserContext(ORIGIN, browser.session, browser)
  return {
    intent,
    minted: { context: browser.session, browser },
    actorId,
    commandKey: commandKeyFor(actorId, orgId, 'strict-entry-native'),
    connectionId,
    orgId,
    corpId,
    userId,
    identityId,
    evidenceId,
    openId,
    unionId,
    subjectKey,
  }
}

async function issueAndEnable(seeded: Seeded): Promise<AdminLoginGrantCommandExecution> {
  const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
    intent: seeded.intent,
    method: 'local_password',
    password: PASSWORD,
  })
  return executeAdminLoginGrantEnable({
    publicOrigin: ORIGIN,
    context: seeded.minted.context,
    browser: seeded.minted.browser,
    intent: seeded.intent,
    proof: issued.proof,
  })
}

async function countOf(pool: Pool, statement: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query(statement, params)
  return Number(result.rows[0]?.count)
}

async function sessionText(pool: Pool, sid: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT id,
            issued_at::text AS issued_at,
            expires_at::text AS expires_at,
            last_seen_at::text AS last_seen_at,
            external_auth_context::text AS external_auth_context
       FROM user_sessions
      WHERE id = $1`,
    [sid],
  )
  const row = result.rows[0]
  if (!row) throw new Error('STRICT_ENTRY_NATIVE_SESSION_ABSENT')
  return row
}

function requirePayload(token: string): { sid: string; exp: number; userId: string; tenantId: string } {
  const payload = authService.readTokenPayload(token)
  if (!payload || payload.sid === undefined || payload.tenantId === undefined) {
    throw new Error('STRICT_ENTRY_NATIVE_TOKEN_UNREADABLE')
  }
  return { sid: payload.sid, exp: payload.exp, userId: payload.userId, tenantId: payload.tenantId }
}

let opening: Promise<Opened> | null = null

function ready(): Promise<Opened> {
  if (!opening) opening = openFixture()
  return opening
}

async function openFixture(): Promise<Opened> {
  const schema = `slgent${randomBytes(8).toString('hex')}`
  kept.push(schema)
  const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`)
  } finally {
    await admin.end()
  }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog` })
  fixturePool = pool
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const env: Env = {
    schema,
    pool,
    async rows(text, params = []) {
      const result = await pool.query(text, params)
      return result.rows as Rows
    },
    async count(table) {
      const result = await pool.query(`SELECT count(*)::int AS count FROM ${quote(table)}`)
      return Number(result.rows[0]?.count)
    },
  }
  await assertSearchPath(pool, schema)
  await install(pool, db, schema)
  await aimNativePool(schema)
  const seeded = await seed(env)
  const execution = await issueAndEnable(seeded)
  expect(execution.status).toBe('committed')
  await runFixtureTransaction(pool)(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await insertConnectionLoginScope(client, {
      connectionId: seeded.connectionId,
      commandId: 'strict-entry-scope',
    })
  })
  await waitUntilEvidenceStale(pool, seeded.evidenceId)
  const calls: ProviderCall[] = []
  const binding = await bindStrictDingTalkEntryLocal({
    fetchFn: providerFetch(seeded, calls),
    transaction: runFixtureTransaction(pool),
  })
  return { seeded, binding, calls, pool }
}

describeDb('strict dingtalk entry native', () => {
  afterAll(async () => {
    await releaseNativePool().catch(() => undefined)
    if (fixturePool) {
      const pool = fixturePool
      fixturePool = null
      await pool.end().catch(() => undefined)
    }
    if (kept.length === 0) return
    const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
    try {
      for (const schema of kept) await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`)
    } finally {
      await admin.end()
    }
  }, 30_000)

  it('refuses a missing or out-of-range absolute lifetime and inserts no xs session', async () => {
    const fixture = await ready()
    expect(fixture.binding.gates).toBe(STRICT_DINGTALK_ENTRY_GATES)
    expect(fixture.binding.gates).toEqual({
      implementationPermit: false,
      productionAvailable: false,
      b2Complete: false,
      delivered: false,
      containerAdapterProved: false,
    })
    const selector = { connectionId: fixture.seeded.connectionId }
    for (const seconds of [undefined, '299', '2592001', '300.5', '0300']) {
      const before = fixture.calls.length
      await expect(fixture.binding.signInWeb({
        code: WEB_CODE,
        selector,
        env: ageEnv(seconds),
      })).rejects.toMatchObject({
        name: 'StrictDingTalkEntryError',
        code: 'STRICT_SESSION_UNCONFIGURED',
        httpStatus: 503,
      })
      await expect(fixture.binding.signInContainer({
        code: CONTAINER_CODE,
        selector,
        env: ageEnv(seconds),
      })).rejects.toBeInstanceOf(StrictDingTalkEntryError)
      expect(fixture.calls.length).toBe(before)
    }
    expect(await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE id LIKE 'xs.%'`,
    )).toBe(0)
  }, 180_000)

  it('issues a stored-app web xs session from the database clock after fresh_until', async () => {
    const fixture = await ready()
    const { seeded, binding, calls, pool } = fixture
    const beforeCalls = calls.length
    const issued = await binding.signInWeb({
      code: WEB_CODE,
      selector: { connectionId: seeded.connectionId },
      env: ageEnv('300'),
      ipAddress: '203.0.113.8',
      userAgent: 'strict-entry-native',
    })
    expect(issued.status).toBe('issued')
    if (issued.status !== 'issued') return
    expect(issued.user.id).toBe(seeded.userId)
    expect(issued.user.role).toBe('user')
    expect(issued.user.tenantId).toBe(seeded.orgId)
    expect(issued.user.strictSessionOrgId).toBe(seeded.orgId)
    expect(issued.user.must_change_password).toBe(false)
    expect(issued.user.is_active).toBe(true)
    expect(issued.user.activation_status).toBe('activated')
    const payload = authService.readTokenPayload(issued.token)
    expect(payload).not.toBeNull()
    expect(classifyVerifiedSessionPayload(payload)).toBe('strict')
    const claims = requirePayload(issued.token)
    expect(claims.sid).toMatch(/^xs\.[0-9a-f]{32}$/)
    expect(claims.userId).toBe(seeded.userId)
    expect(claims.tenantId).toBe(seeded.orgId)
    held.web = { token: issued.token, sid: claims.sid }
    const clock = await pool.query(
      `SELECT (issued_at <= pg_catalog.clock_timestamp()) AS issued_not_future,
              (issued_at > pg_catalog.clock_timestamp() - interval '1 minute') AS issued_recent,
              (expires_at = issued_at + make_interval(secs => 300)) AS age_exact,
              (expires_at = LEAST(
                 issued_at + make_interval(secs => 300),
                 to_timestamp($2::double precision)
               )) AS least_cap,
              (expires_at < to_timestamp($2::double precision)) AS inside_token_exp
         FROM user_sessions
        WHERE id = $1`,
      [claims.sid, claims.exp],
    )
    expect(clock.rows[0]).toEqual({
      issued_not_future: true,
      issued_recent: true,
      age_exact: true,
      least_cap: true,
      inside_token_exp: true,
    })
    const pinned = await pool.query(
      `SELECT grant_row.subject_key AS grant_subject,
              evidence.subject_key AS evidence_subject,
              identity.provider_open_id,
              identity.provider_union_id,
              pin.provider_open_id AS pin_open_id,
              pin.provider_union_id AS pin_union_id,
              (evidence.fresh_until < pg_catalog.clock_timestamp()) AS evidence_past,
              (user_sessions.expires_at IS DISTINCT FROM evidence.fresh_until) AS lifetime_not_fresh_until,
              users.role AS user_role,
              users.is_active,
              users.activation_status,
              users.must_change_password,
              membership.is_active AS membership_active
         FROM user_sessions
         JOIN user_external_identity_login_grants grant_row
           ON grant_row.local_user_id = user_sessions.user_id
         JOIN user_external_identities identity ON identity.id::text = grant_row.identity_id
         JOIN user_external_identity_binding_pins pin ON pin.identity_id = identity.id
         JOIN user_external_identity_evidence evidence ON evidence.id = grant_row.evidence_id
         JOIN users ON users.id = grant_row.local_user_id
         JOIN user_orgs membership
           ON membership.user_id = grant_row.local_user_id
          AND membership.org_id = grant_row.org_id
        WHERE user_sessions.id = $1`,
      [claims.sid],
    )
    expect(pinned.rows).toEqual([{
      grant_subject: seeded.subjectKey,
      evidence_subject: seeded.subjectKey,
      provider_open_id: seeded.openId,
      provider_union_id: seeded.unionId,
      pin_open_id: seeded.openId,
      pin_union_id: seeded.unionId,
      evidence_past: true,
      lifetime_not_fresh_until: true,
      user_role: 'user',
      is_active: true,
      activation_status: 'activated',
      must_change_password: false,
      membership_active: true,
    }])
    const context = parseStrictSessionContext(
      (await pool.query(`SELECT external_auth_context FROM user_sessions WHERE id = $1`, [claims.sid])).rows[0]?.external_auth_context,
    )
    expect(context.subjectKey).toBe(seeded.subjectKey)
    expect(context.orgId).toBe(seeded.orgId)
    expect(context.provider).toBe('dingtalk')
    expect(context.assurance).toBe('self_authenticated')
    expect(context.scopeAsserted).toBe(false)
    expect(context.connectionId).toBe(seeded.connectionId)
    await withCaller(pool, async (caller) => {
      const assessment = await assessSecurityActionPrivilege({
        query: async (statement, params) => {
          const result = await caller.query(statement, params)
          return { rows: [...result.rows], rowCount: result.rowCount ?? null }
        },
      }, seeded.userId)
      expect(assessment.privilegeClass).toBe('standard')
      expect(assessment.reasons).toEqual([])
      expect(await binding.currentStrictGrantUsable(caller, { userId: seeded.userId })).toBe(true)
    })
    expect(calls.slice(beforeCalls).map((call) => call.url)).toEqual([
      'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
      'https://api.dingtalk.com/v1.0/contact/users/me',
    ])
    const tokenCall = calls[beforeCalls]
    expect(tokenCall?.method).toBe('POST')
    expect(JSON.parse(tokenCall?.body ?? '{}')).toEqual({
      clientId: MATERIAL.appKey,
      clientSecret: MATERIAL.appSecret,
      code: WEB_CODE,
      grantType: 'authorization_code',
    })
    expect(calls[beforeCalls + 1]?.accessTokenHeader).toBe(USER_ACCESS_TOKEN)
    expect(await countOf(
      pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [seeded.userId],
    )).toBe(0)
    expect(await countOf(pool, `SELECT count(*)::int AS count FROM user_external_identities`)).toBe(1)
    expect(await countOf(pool, `SELECT count(*)::int AS count FROM user_external_identity_login_grants`)).toBe(1)
    expect(await countOf(pool, `SELECT count(*)::int AS count FROM user_orgs`)).toBe(2)
  }, 60_000)

  it('issues a fresh-container xs session at the upper lifetime capped by the token exp', async () => {
    const fixture = await ready()
    const { seeded, binding, calls, pool } = fixture
    const beforeCalls = calls.length
    const issued = await binding.signInContainer({
      code: CONTAINER_CODE,
      selector: { connectionId: seeded.connectionId },
      env: ageEnv('2592000'),
      ipAddress: '203.0.113.9',
      userAgent: 'strict-entry-native',
    })
    expect(issued.status).toBe('issued')
    if (issued.status !== 'issued') return
    const payload = authService.readTokenPayload(issued.token)
    expect(classifyVerifiedSessionPayload(payload)).toBe('strict')
    const claims = requirePayload(issued.token)
    expect(claims.sid).toMatch(/^xs\.[0-9a-f]{32}$/)
    expect(claims.sid).not.toBe(held.web?.sid)
    held.container = { token: issued.token, sid: claims.sid }
    const clock = await pool.query(
      `SELECT (issued_at <= pg_catalog.clock_timestamp()) AS issued_not_future,
              (issued_at > pg_catalog.clock_timestamp() - interval '1 minute') AS issued_recent,
              (expires_at = issued_at + make_interval(secs => 2592000)) AS age_exact,
              (expires_at = to_timestamp($2::double precision)) AS exp_exact,
              (expires_at = LEAST(
                 issued_at + make_interval(secs => 2592000),
                 to_timestamp($2::double precision)
               )) AS least_cap,
              (expires_at < issued_at + make_interval(secs => 2592000)) AS inside_configured_age
         FROM user_sessions
        WHERE id = $1`,
      [claims.sid, claims.exp],
    )
    expect(clock.rows[0]).toEqual({
      issued_not_future: true,
      issued_recent: true,
      age_exact: false,
      exp_exact: true,
      least_cap: true,
      inside_configured_age: true,
    })
    const context = parseStrictSessionContext(
      (await pool.query(`SELECT external_auth_context FROM user_sessions WHERE id = $1`, [claims.sid])).rows[0]?.external_auth_context,
    )
    expect(context.subjectKey).toBe(seeded.subjectKey)
    expect(context.identityId).toBe(seeded.identityId)
    expect(context.orgId).toBe(seeded.orgId)
    const seen = calls.slice(beforeCalls)
    expect(seen.map((call) => call.url)).toEqual([
      `https://oapi.dingtalk.com/gettoken?appkey=${MATERIAL.appKey}&appsecret=${MATERIAL.appSecret}`,
      `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${APP_ACCESS_TOKEN}`,
    ])
    expect(seen.every((call) => call.url.startsWith('https://oapi.dingtalk.com/'))).toBe(true)
    expect(seen.some((call) => call.url.includes('/topapi/v2/user/get?'))).toBe(false)
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ code: CONTAINER_CODE })
    expect(await countOf(
      pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id LIKE 'xs.%'`,
      [seeded.userId],
    )).toBe(2)
    expect(await countOf(
      pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [seeded.userId],
    )).toBe(0)
  }, 60_000)

  it('refresh and same-org switch keep the session id, context, and issued_at', async () => {
    const fixture = await ready()
    const web = held.web
    if (!web) throw new Error('STRICT_ENTRY_NATIVE_WEB_SESSION_ABSENT')
    const payload = authService.readTokenPayload(web.token)
    expect(classifyVerifiedSessionPayload(payload)).toBe('strict')
    const before = await sessionText(fixture.pool, web.sid)
    expect(await withCaller(fixture.pool, (caller) => fixture.binding.verifyPersistedStrictSession(caller, payload, {}))).toBeNull()
    expect(await withCaller(fixture.pool, (caller) => fixture.binding.refreshStrictSession({
      caller,
      payload,
      env: {},
    }))).toBeNull()
    expect(await sessionText(fixture.pool, web.sid)).toEqual(before)
    const verified = await withCaller(fixture.pool, (caller) => fixture.binding.verifyPersistedStrictSession(caller, payload, ageEnv('300')))
    expect(verified?.id).toBe(fixture.seeded.userId)
    expect(verified?.strictSessionOrgId).toBe(fixture.seeded.orgId)
    const refreshed = await withCaller(fixture.pool, (caller) => fixture.binding.refreshStrictSession({
      caller,
      payload,
      env: ageEnv('300'),
      ipAddress: '203.0.113.10',
      userAgent: 'strict-entry-native-refresh',
    }))
    expect(refreshed).not.toBeNull()
    if (!refreshed) return
    const refreshedClaims = requirePayload(refreshed.token)
    expect(refreshedClaims.sid).toBe(web.sid)
    expect(refreshedClaims.tenantId).toBe(fixture.seeded.orgId)
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(refreshed.token))).toBe('strict')
    const afterRefresh = await sessionText(fixture.pool, web.sid)
    expect(afterRefresh.id).toBe(before.id)
    expect(afterRefresh.issued_at).toBe(before.issued_at)
    expect(afterRefresh.external_auth_context).toBe(before.external_auth_context)
    const switched = await withCaller(fixture.pool, (caller) => fixture.binding.switchStrictSessionOrg({
      caller,
      payload: authService.readTokenPayload(refreshed.token),
      orgId: fixture.seeded.orgId,
      env: ageEnv('300'),
      ipAddress: '203.0.113.11',
      userAgent: 'strict-entry-native-switch',
    }))
    expect(switched).not.toBeNull()
    if (!switched) return
    expect(requirePayload(switched.token).sid).toBe(web.sid)
    expect(switched.user.strictSessionOrgId).toBe(fixture.seeded.orgId)
    const afterSwitch = await sessionText(fixture.pool, web.sid)
    expect(afterSwitch.id).toBe(before.id)
    expect(afterSwitch.issued_at).toBe(before.issued_at)
    expect(afterSwitch.external_auth_context).toBe(before.external_auth_context)
    held.web = { token: switched.token, sid: web.sid }
  }, 60_000)

  it('refuses a cross-org switch and a foreign selector without writing the session', async () => {
    const fixture = await ready()
    const web = held.web
    if (!web) throw new Error('STRICT_ENTRY_NATIVE_WEB_SESSION_ABSENT')
    const payload = authService.readTokenPayload(web.token)
    const before = await sessionText(fixture.pool, web.sid)
    const nonXs = await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )
    await expect(withCaller(fixture.pool, (caller) => fixture.binding.switchStrictSessionOrg({
      caller,
      payload,
      orgId: `${fixture.seeded.orgId}-other`,
      env: ageEnv('300'),
    }))).rejects.toMatchObject({
      code: 'SESSION_ORG_NOT_MEMBER',
      httpStatus: 403,
    })
    expect(await sessionText(fixture.pool, web.sid)).toEqual(before)
    expect(await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )).toBe(nonXs)
    expect(strictSelectorMismatch({
      orgId: fixture.seeded.orgId,
      headers: { 'x-org-id': `${fixture.seeded.orgId}-other` },
    })).toBe(true)
    expect(strictSelectorMismatch({
      orgId: fixture.seeded.orgId,
      query: { tenant_id: `${fixture.seeded.orgId}-other` },
    })).toBe(true)
    expect(strictSelectorMismatch({
      orgId: fixture.seeded.orgId,
      body: { workspaceId: `${fixture.seeded.orgId}-other` },
    })).toBe(true)
    expect(strictSelectorMismatch({
      orgId: fixture.seeded.orgId,
      headers: { 'x-tenant-id': fixture.seeded.orgId },
      query: { orgId: fixture.seeded.orgId },
      body: { workspace_id: fixture.seeded.orgId },
    })).toBe(false)
    expect(await sessionText(fixture.pool, web.sid)).toEqual(before)
  }, 60_000)

  it('current witness revocation removes usability and does not open a legacy session', async () => {
    const fixture = await ready()
    const web = held.web
    if (!web) throw new Error('STRICT_ENTRY_NATIVE_WEB_SESSION_ABSENT')
    const xsBefore = await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )
    const nonXsBefore = await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )
    const client = await fixture.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE user_external_identity_evidence
            SET revocation_generation = revocation_generation + 1,
                live_identity_id = NULL
          WHERE id = $1`,
        [fixture.seeded.evidenceId],
      )
      const revoked = await revokeForUserInScope(
        callerFrom(client),
        fixture.seeded.connectionId,
        fixture.seeded.userId,
        { reason: 'admin_disable', revokedBy: fixture.seeded.actorId },
      )
      expect(revoked.grantIds).toHaveLength(1)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    const evidence = await fixture.pool.query(
      `SELECT (revoked_at IS NOT NULL) AS revoked
         FROM user_external_identity_evidence
        WHERE id = $1`,
      [fixture.seeded.evidenceId],
    )
    expect(evidence.rows[0]?.revoked).toBe(true)
    const grant = await fixture.pool.query(
      `SELECT enabled, (revoked_at IS NOT NULL) AS revoked
         FROM user_external_identity_login_grants
        WHERE local_user_id = $1`,
      [fixture.seeded.userId],
    )
    expect(grant.rows).toEqual([{ enabled: false, revoked: true }])
    const payload = authService.readTokenPayload(web.token)
    expect(await withCaller(fixture.pool, (caller) => fixture.binding.verifyPersistedStrictSession(caller, payload, ageEnv('300')))).toBeNull()
    expect(await withCaller(fixture.pool, (caller) => fixture.binding.refreshStrictSession({
      caller,
      payload,
      env: ageEnv('300'),
    }))).toBeNull()
    expect(await withCaller(fixture.pool, (caller) => fixture.binding.currentStrictGrantUsable(caller, { userId: fixture.seeded.userId }))).toBe(false)
    const callsBefore = fixture.calls.length
    await expect(fixture.binding.signInWeb({
      code: WEB_CODE,
      selector: { connectionId: fixture.seeded.connectionId },
      env: ageEnv('300'),
    })).rejects.toMatchObject({
      code: 'STRICT_LOGIN_REFUSED',
      httpStatus: 403,
    })
    expect(fixture.calls.length).toBeGreaterThan(callsBefore)
    expect(await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )).toBe(xsBefore)
    expect(await countOf(
      fixture.pool,
      `SELECT count(*)::int AS count FROM user_sessions WHERE user_id = $1 AND id NOT LIKE 'xs.%'`,
      [fixture.seeded.userId],
    )).toBe(nonXsBefore)
    expect(await countOf(fixture.pool, `SELECT count(*)::int AS count FROM user_external_identities`)).toBe(1)
    expect(await countOf(fixture.pool, `SELECT count(*)::int AS count FROM user_orgs`)).toBe(2)
  }, 60_000)
})
