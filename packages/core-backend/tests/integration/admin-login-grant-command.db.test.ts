/**
 * Native command chain. This author does not run it.
 * Without EXPECT_DB=1 the suite is skipped. A skip is not a pass.
 * EXPECT_DB=1 without DATABASE_URL throws.
 * Fixture SQL is labeled fixture and is not a proof insert.
 * Identity and evidence rows are a named command boundary, not T2 provider or ceremony output.
 * issue() is called. A thrown proof error fails the case.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { adminGrantApplicationMaterialFingerprint } from '../../src/auth/admin-grant-application-material'
import { createAdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import type { AdminGrantBrowserContext } from '../../src/auth/admin-grant-browser-context'
import { encodeAdminGrantIntent, normalizeAdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import type { AdminGrantIntent, AdminGrantTargetPin } from '../../src/auth/admin-login-grant-intent'
import {
  executeAdminLoginGrantEnable,
  readAdminLoginGrantCommandReceipt,
} from '../../src/auth/admin-login-grant-command'
import type {
  AdminLoginGrantCommandExecution,
  AdminLoginGrantCommandReadInput,
} from '../../src/auth/admin-login-grant-command'
import {
  AdminGrantActorInputError,
  changeRequiredPasswordWithProvenance,
} from '../../src/auth/admin-grant-local-credential'
import { createAdminGrantProofService, retainAdminGrantBrowserContext } from '../../src/auth/admin-grant-proof'
import { parseAdminGrantProof } from '../../src/auth/admin-grant-proof-storage'
import { insertConsumedGrantBundle } from '../../src/auth/strict-login-grant-bundle'
import type { AuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import { assessSecurityActionPrivilege } from '../../src/auth/security-action-privilege'
import {
  commandKeyFor,
  grantIdsFor,
  revokeForUserInScope,
  StrictLoginGrantError,
} from '../../src/auth/strict-login-grant-store'
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
import { withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import { revalidatePrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import { contextFor, requestShape, tokenFor } from '../helpers/security-action-proof-harness'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for admin-login-grant-command.db.test.ts')
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
const kept: string[] = []

type SavedPoolStartup = {
  options: string | undefined
  searchPath: string
}

let savedPoolStartup: SavedPoolStartup | null = null

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
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_FIXTURE_SCHEMA_REFUSED')
  return `"${identifier}"`
}

function namesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter((item) => item.length > 0)
  throw new Error('ADMIN_LOGIN_GRANT_COMMAND_SEARCH_PATH_UNREADABLE')
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
    if (Date.now() >= deadline) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_WATERMARK_WAIT_EXCEEDED')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function inReadCommitted(db: Kysely<unknown>, work: (trx: Kysely<unknown>) => Promise<void>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
    await work(trx)
  })
}

async function rememberPoolStartup(): Promise<void> {
  if (!nativePool) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_NATIVE_POOL_ABSENT')
  if (savedPoolStartup) return
  const startup = nativePool.options.options
  const client = await nativePool.connect()
  try {
    const seen = await client.query(`SELECT pg_catalog.current_setting('search_path') AS search_path`)
    const searchPath = seen.rows[0]?.search_path
    if (typeof searchPath !== 'string' || searchPath.length === 0) {
      throw new Error('ADMIN_LOGIN_GRANT_COMMAND_POOL_STARTUP_UNREADABLE')
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
  if (!nativePool) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_NATIVE_POOL_ABSENT')
  await rememberPoolStartup()
  const searchPath = `${schema},pg_catalog`
  nativePool.options.options = `-c search_path=${searchPath}`
  const max = nativePool.options.max ?? 10
  const held = []
  try {
    while (held.length < max && (nativePool.idleCount > 0 || nativePool.totalCount < max)) {
      const client = await nativePool.connect()
      held.push(client)
      await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [searchPath])
    }
  } finally {
    for (const client of held) client.release()
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
  const held = []
  try {
    while (held.length < max && (nativePool.idleCount > 0 || nativePool.totalCount > held.length)) {
      const client = await nativePool.connect()
      held.push(client)
      await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [saved.searchPath])
    }
  } finally {
    for (const client of held) client.release()
  }
}

async function install(pool: Pool, db: Kysely<unknown>, schema: string): Promise<void> {
  await pool.query(`
    -- fixture parents for the native command chain. Not a proof insert.
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
      revoked_at timestamptz,
      expires_at timestamptz NOT NULL
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
    -- fixture caller audit. Not the shared audit migration and not a proof insert.
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
    throw new Error('ADMIN_LOGIN_GRANT_COMMAND_AUDIT_PARTITION_REFUSED')
  }
  await pool.query(
    `CREATE TABLE ${quote(schema)}.${quote(partition)} PARTITION OF ${quote(schema)}.audit_logs FOR VALUES FROM ('${startDate}') TO ('${endDate}')`,
  )
  await pool.query(
    `INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)`,
    [STRICT_LOGIN_GRANT_MIGRATION_NAME, '2026-11-18T12:00:00.000Z'],
  )
  await pool.query(`
    CREATE TABLE fixture_write_order (
      id bigserial PRIMARY KEY,
      relation text NOT NULL
    );
    CREATE FUNCTION fixture_note_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      INSERT INTO fixture_write_order (relation) VALUES (TG_TABLE_NAME);
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER fixture_note_receipt
      AFTER INSERT ON admin_login_grant_command_receipts
      FOR EACH ROW EXECUTE FUNCTION fixture_note_write();
    CREATE TRIGGER fixture_note_grant
      AFTER INSERT ON user_external_identity_login_grants
      FOR EACH ROW EXECUTE FUNCTION fixture_note_write();
    CREATE TRIGGER fixture_note_audit
      AFTER INSERT ON ${quote(partition)}
      FOR EACH ROW EXECUTE FUNCTION fixture_note_write();
  `)
}

async function withSchema(fn: (env: Env) => Promise<void>): Promise<void> {
  const schema = `slgcmd${randomBytes(8).toString('hex')}`
  kept.push(schema)
  const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`)
  } finally {
    await admin.end()
  }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog` })
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
  try {
    await assertSearchPath(pool, schema)
    await install(pool, db, schema)
    await aimNativePool(schema)
    await fn(env)
  } finally {
    await pool.end()
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
        throw new Error('ADMIN_LOGIN_GRANT_COMMAND_TARGET_PRIVILEGE_REFUSED')
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

async function seed(env: Env, targetCount: number, commandId: string): Promise<Seeded> {
  const suffix = randomBytes(4).toString('hex')
  const actorId = `a-actor-${suffix}`
  const orgId = `org-${suffix}`
  const connectionId = randomUUID()
  const corpId = `corp-${suffix}`
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
  const pins: AdminGrantTargetPin[] = []
  for (let index = 0; index < targetCount; index += 1) {
    const userId = `t${String(index).padStart(4, '0')}-${suffix}`
    const identityId = randomUUID()
    const evidenceId = `ev-${String(index).padStart(4, '0')}-${suffix}`
    const evidenceWitness = `wit-${String(index).padStart(4, '0')}-${suffix}`
    const externalKey = `ext-${String(index).padStart(4, '0')}-${suffix}`
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
      `INSERT INTO user_external_identities (id, provider, external_key, local_user_id, corp_id)
       VALUES ($1::uuid, 'dingtalk', $2, $3, $4)`,
      [identityId, externalKey, userId, corpId],
    )
    await env.pool.query(
      `INSERT INTO user_external_identity_binding_pins
         (identity_id, binding_revision, provider, local_user_id, external_key, corp_id)
       VALUES ($1::uuid, 7, 'dingtalk', $2, $3, $4)`,
      [identityId, userId, externalKey, corpId],
    )
    const slot = {
      corpId,
      externalKey,
      localUserId: userId,
      provider: 'dingtalk',
      providerOpenId: null,
      providerUnionId: null,
    }
    await env.pool.query(
      `INSERT INTO user_external_identity_evidence
         (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
          assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
          application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
          revocation_generation, slot_snapshot, created_by)
       VALUES ($1, $2, $3::text, $3::uuid, 7, 'fixture-not-a-producer',
               'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 4, '4', $7,
               1, pg_catalog.clock_timestamp() - interval '2 days', pg_catalog.clock_timestamp() + interval '1 day',
               0, $8::jsonb, 'suite')`,
      [evidenceId, evidenceWitness, identityId, externalKey, orgId, connectionId, fingerprint, JSON.stringify(slot)],
    )
    pins.push({
      userId,
      identityId,
      bindingRevision: '7',
      evidenceId,
      evidenceWitness,
      accessGeneration: '1',
      privilegeWitness: '',
    })
  }
  const privilege = await witnesses(env.pool, pins.map((pin) => pin.userId))
  const targets = pins.map((pin) => {
    const privilegeWitness = privilege.get(pin.userId)
    if (!privilegeWitness) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_TARGET_PRIVILEGE_REFUSED')
    return { ...pin, privilegeWitness }
  })
  const intent = normalizeAdminGrantIntent({
    purpose: 'admin_login_grant_enable',
    commandId,
    actorId,
    orgId,
    provider: 'dingtalk',
    connectionId,
    applicationRevision: '4',
    targets,
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
  const establishment = await env.rows(
    `SELECT id::text AS id, kind
       FROM user_local_credential_establishments
      WHERE user_id = $1`,
    [actorId],
  )
  expect(establishment.map((row) => ({
    id: String(row.id).toLowerCase(),
    kind: row.kind,
  }))).toEqual([{ id: established.establishmentId, kind: 'self_password_change' }])
  const mark = await env.rows(
    `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS watermark_ms
       FROM user_session_revocations
      WHERE user_id = $1`,
    [actorId],
  )
  const watermarkMs = mark[0]?.watermark_ms
  if (typeof watermarkMs !== 'string' || !/^[0-9]+$/.test(watermarkMs)) {
    throw new Error('ADMIN_LOGIN_GRANT_COMMAND_WATERMARK_UNREADABLE')
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
    throw new Error('ADMIN_LOGIN_GRANT_COMMAND_TOKEN_NOT_AFTER_WATERMARK')
  }
  retainAdminGrantBrowserContext(ORIGIN, browser.session, browser)
  return {
    intent,
    minted: { context: browser.session, browser },
    actorId,
    commandKey: commandKeyFor(actorId, orgId, commandId),
  }
}

function enableInput(seeded: Seeded, proof: string) {
  return {
    publicOrigin: ORIGIN,
    context: seeded.minted.context,
    browser: seeded.minted.browser,
    intent: seeded.intent,
    proof,
  }
}

function readInput(seeded: Seeded): AdminLoginGrantCommandReadInput {
  return {
    publicOrigin: ORIGIN,
    context: seeded.minted.context,
    browser: seeded.minted.browser,
    intent: seeded.intent,
  }
}

async function issueAndEnable(seeded: Seeded): Promise<AdminLoginGrantCommandExecution> {
  const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
    intent: seeded.intent,
    method: 'local_password',
    password: PASSWORD,
  })
  return executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
}

async function dropAuditPartitions(env: Env): Promise<void> {
  const found = await env.rows(
    `SELECT child.relname AS name
       FROM pg_catalog.pg_inherits inherit
       JOIN pg_catalog.pg_class parent ON parent.oid = inherit.inhparent
       JOIN pg_catalog.pg_class child ON child.oid = inherit.inhrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent.relnamespace
      WHERE namespace.nspname = $1 AND parent.relname = 'audit_logs'`,
    [env.schema],
  )
  for (const row of found) {
    await env.pool.query(`DROP TABLE ${quote(String(row.name))}`)
  }
}

function occupied(error: unknown): boolean {
  return error instanceof StrictLoginGrantError && error.code === 'STRICT_LOGIN_GRANT_GRANT_OCCUPIED'
}

async function notedWrites(env: Env): Promise<number> {
  const seen = await env.rows(
    `SELECT last_value::text AS last_value, is_called
       FROM ${quote(env.schema)}.${quote('fixture_write_order_id_seq')}`,
  )
  if (seen[0]?.is_called !== true) return 0
  return Number(seen[0]?.last_value)
}

async function expectIssuedProof(env: Env, proof: string, expiresAt: string): Promise<void> {
  const parsed = parseAdminGrantProof(proof)
  expect(parsed).not.toBeNull()
  if (!parsed) return
  const rows = await env.rows(
    `SELECT status,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
            consumed_at,
            consumed_action_ref
       FROM security_action_challenges
      WHERE id = $1::uuid`,
    [parsed.id],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe('issued')
  expect(rows[0]?.consumed_at ?? null).toBeNull()
  expect(rows[0]?.consumed_action_ref ?? null).toBeNull()
  expect(rows[0]?.expires_at).toBe(expiresAt)
}

async function proofExpiryText(env: Env, proof: string): Promise<string> {
  const parsed = parseAdminGrantProof(proof)
  if (!parsed) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_PROOF_FIXTURE_REFUSED')
  const rows = await env.rows(
    `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
       FROM security_action_challenges WHERE id = $1::uuid`,
    [parsed.id],
  )
  const expiresAt = rows[0]?.expires_at
  if (typeof expiresAt !== 'string' || !/\.\d{6}Z$/.test(expiresAt)) {
    throw new Error('ADMIN_LOGIN_GRANT_COMMAND_EXPIRY_FIXTURE_REFUSED')
  }
  return expiresAt
}

async function loseNextBundleCommitAck(
  env: Env,
  mode: 'withhold-ack' | 'record-rejection' = 'withhold-ack',
): Promise<{
  restore: () => void
  observedBeforeFault: () => boolean
  witness: () => { receipts: Rows, grants: Rows, audits: Rows } | null
  sqlAfter: () => readonly string[]
  commitRejection: () => { code: string, message: string } | null
}> {
  if (!nativePool) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_NATIVE_POOL_ABSENT')
  const pool = nativePool
  const connectOwn = Object.getOwnPropertyDescriptor(pool, 'connect')
  const savedConnect = pool.connect
  type ConnectCallback = Parameters<Pool['connect']>[0]
  const connectCallback = savedConnect as unknown as (this: Pool, callback: ConnectCallback) => void
  const connectPromise = savedConnect as unknown as (this: Pool) => Promise<PoolClient>
  const seen = new WeakSet<PoolClient>()
  const touched: Array<{
    client: PoolClient
    queryOwn: PropertyDescriptor | undefined
    query: PoolClient['query']
  }> = []
  const progress = new WeakMap<PoolClient, { receipt: boolean, grant: boolean, audit: boolean }>()
  const after: string[] = []
  let closed = false
  let withheld = false
  let observed = false
  let seenWitness: { receipts: Rows, grants: Rows, audits: Rows } | null = null
  let seenRejection: { code: string, message: string } | null = null
  const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
    return ''
  }
  const insertsInto = (sql: string, table: string): boolean => (
    new RegExp(`INSERT\\s+INTO\\s+"[^"]+"\\."${table}"`, 'i').test(sql)
    || new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i').test(sql)
  )
  const observeClient = (client: PoolClient): PoolClient => {
    if (seen.has(client)) return client
    seen.add(client)
    const queryOwn = Object.getOwnPropertyDescriptor(client, 'query')
    const savedQuery = client.query
    touched.push({ client, queryOwn, query: savedQuery })
    const callQuery = savedQuery as unknown as (this: PoolClient, ...args: readonly unknown[]) => unknown
    const run = function (this: PoolClient, ...queryArgs: unknown[]): unknown {
      if (closed) return callQuery.apply(client, queryArgs)
      const sql = textOf(queryArgs[0])
      if (withheld) after.push(sql)
      const callbackIndex = queryArgs.findIndex((arg) => typeof arg === 'function')
      if (callbackIndex >= 0) return callQuery.apply(client, queryArgs)
      let pending: unknown
      try {
        pending = callQuery.apply(client, queryArgs)
      } catch (error) {
        throw error
      }
      if (!pending || typeof (pending as { then?: unknown }).then !== 'function') return pending
      return (pending as Promise<unknown>).then(async (result) => {
        if (closed || withheld) return result
        const state = progress.get(client) ?? { receipt: false, grant: false, audit: false }
        if (insertsInto(sql, 'admin_login_grant_command_receipts')) state.receipt = true
        if (insertsInto(sql, 'user_external_identity_login_grants')) state.grant = true
        if (insertsInto(sql, 'audit_logs')) state.audit = true
        progress.set(client, state)
        if (!(state.receipt && state.grant && state.audit && /^\s*COMMIT\b/i.test(sql))) return result
        if (mode === 'record-rejection') return result
        const receipts = await env.rows(
          `SELECT command_key, target_count::int AS target_count
             FROM admin_login_grant_command_receipts`,
        )
        const grants = await env.rows(
          `SELECT id, target_ordinal, local_user_id
             FROM user_external_identity_login_grants
            ORDER BY target_ordinal`,
        )
        const audits = await env.rows(
          `SELECT action, action_details->>'commandKey' AS command_key
             FROM audit_logs
            WHERE action = 'admin_login_grant_enable'`,
        )
        seenWitness = { receipts, grants, audits }
        observed = true
        withheld = true
        throw new Error('ADMIN_LOGIN_GRANT_COMMAND_COMMIT_ACK_WITHHELD')
      }, (error: unknown) => {
        if (!closed && mode === 'record-rejection' && seenRejection === null) {
          const state = progress.get(client) ?? { receipt: false, grant: false, audit: false }
          if (state.receipt && state.grant && state.audit && /^\s*COMMIT\b/i.test(sql)) {
            const record = error && typeof error === 'object'
              ? error as { code?: unknown, message?: unknown }
              : {}
            seenRejection = {
              code: typeof record.code === 'string' ? record.code : '',
              message: typeof record.message === 'string' ? record.message : '',
            }
          }
        }
        throw error
      })
    }
    client.query = run as PoolClient['query']
    return client
  }
  function forwardConnect(callback: ConnectCallback): void
  function forwardConnect(): Promise<PoolClient>
  function forwardConnect(callback?: ConnectCallback): Promise<PoolClient> | void {
    if (callback) {
      connectCallback.call(pool, callback)
      return
    }
    return connectPromise.call(pool).then((client) => observeClient(client))
  }
  pool.connect = forwardConnect
  return {
    restore: () => {
      closed = true
      for (const entry of touched) {
        if (entry.queryOwn) Object.defineProperty(entry.client, 'query', entry.queryOwn)
        else Reflect.deleteProperty(entry.client, 'query')
        if (entry.client.query !== entry.query) entry.client.query = entry.query
      }
      touched.length = 0
      if (connectOwn) Object.defineProperty(pool, 'connect', connectOwn)
      else Reflect.deleteProperty(pool, 'connect')
      if (pool.connect !== savedConnect) pool.connect = savedConnect
    },
    observedBeforeFault: () => observed,
    witness: () => seenWitness,
    sqlAfter: () => after,
    commitRejection: () => seenRejection,
  }
}

describeDb('admin login grant command native chain', () => {
  afterAll(async () => {
    if (kept.length === 0) return
    await releaseNativePool().catch(() => undefined)
    const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
    try {
      for (const schema of kept) await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('commits a multi-target receipt, then grants, then the caller audit', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 2, 'command-two')
      const execution = await issueAndEnable(seeded)
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      const userIds = seeded.intent.targets.map((target) => target.userId)
      expect(execution.receipt).toMatchObject({
        commandKey: seeded.commandKey,
        commandId: 'command-two',
        actorId: seeded.actorId,
        targetCount: 2,
        canonicalIntent: encodeAdminGrantIntent(seeded.intent),
        grants: grantIdsFor(seeded.commandKey, userIds).map((grant) => ({
          grantId: grant.grantId,
          ordinal: grant.ordinal,
          userId: grant.userId,
        })),
      })
      const order = await env.rows('SELECT relation FROM fixture_write_order ORDER BY id')
      const names = order.map((row) => String(row.relation))
      expect(names[0]).toBe('admin_login_grant_command_receipts')
      expect(names.slice(1, -1)).toEqual(['user_external_identity_login_grants', 'user_external_identity_login_grants'])
      expect(names[names.length - 1]?.startsWith('audit_logs')).toBe(true)
      const audit = await env.rows(
        `SELECT action, action_details->>'commandKey' AS command_key, (action_details->>'targetCount')::int AS target_count
           FROM audit_logs
          WHERE action = 'admin_login_grant_enable'`,
      )
      expect(audit).toEqual([{ action: 'admin_login_grant_enable', command_key: seeded.commandKey, target_count: 2 }])
      const again = await readAdminLoginGrantCommandReceipt(readInput(seeded))
      expect(again).toMatchObject({ status: 'committed', receipt: { commandKey: seeded.commandKey, targetCount: 2 } })
      expect(await env.count('admin_login_grant_command_receipts')).toBe(1)
      expect(await env.count('user_external_identity_login_grants')).toBe(2)
    })
  })

  it('rolls back the receipt, proof consume, grants, and audit when the audit partition is absent', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 2, 'command-rollback')
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const parsed = parseAdminGrantProof(issued.proof)
      if (!parsed) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_PROOF_FIXTURE_REFUSED')
      const beforeProof = await env.rows(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
           FROM security_action_challenges WHERE id = $1::uuid`,
        [parsed.id],
      )
      const originalExpiry = beforeProof[0]?.expires_at
      if (typeof originalExpiry !== 'string') throw new Error('ADMIN_LOGIN_GRANT_COMMAND_EXPIRY_FIXTURE_REFUSED')
      expect(originalExpiry).toMatch(/\.\d{6}Z$/)
      await dropAuditPartitions(env)
      const noted = await notedWrites(env)
      let fault: { code?: string, message?: string } | undefined
      try {
        await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
      } catch (error) {
        fault = error as { code?: string, message?: string }
      }
      expect(fault?.code).toBe('23514')
      expect(fault?.message ?? '').toContain('audit_logs')
      expect(fault?.message ?? '').toContain('partition')
      expect(await notedWrites(env) - noted).toBe(3)
      expect(await env.count('fixture_write_order')).toBe(0)
      expect(await env.count('admin_login_grant_command_receipts')).toBe(0)
      expect(await env.count('user_external_identity_login_grants')).toBe(0)
      expect(await env.count('audit_logs')).toBe(0)
      await expectIssuedProof(env, issued.proof, originalExpiry)
    })
  })

  it('enables 101 targets through the command', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 101, 'command-101')
      expect(seeded.intent.targets).toHaveLength(101)
      const execution = await issueAndEnable(seeded)
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      expect(execution.receipt.targetCount).toBe(101)
      expect(execution.receipt.grants).toHaveLength(101)
      expect(await env.count('user_external_identity_login_grants')).toBe(101)
    })
  })

  it('enables a canonical intent larger than 256KiB', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 1, `c${'m'.repeat(300000)}`)
      const canonical = encodeAdminGrantIntent(seeded.intent)
      expect(Buffer.byteLength(canonical, 'utf8')).toBeGreaterThan(262144)
      const execution = await issueAndEnable(seeded)
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      expect(execution.receipt.canonicalIntent).toBe(canonical)
      expect(Buffer.byteLength(execution.receipt.canonicalIntent, 'utf8')).toBeGreaterThan(262144)
      expect(execution.receipt.targetCount).toBe(1)
    })
  })

  it('keeps one receipt when two enables race the same proof', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 1, 'command-race')
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const input = enableInput(seeded, issued.proof)
      const settled = await Promise.allSettled([
        executeAdminLoginGrantEnable(input),
        executeAdminLoginGrantEnable(input),
      ])
      expect(await env.count('admin_login_grant_command_receipts')).toBe(1)
      expect(await env.count('user_external_identity_login_grants')).toBe(1)
      const read = await readAdminLoginGrantCommandReceipt(readInput(seeded))
      expect(read.status).toBe('committed')
      const accepted = settled.filter((item) => {
        if (item.status === 'rejected') return occupied(item.reason)
        return item.value.status === 'committed' || item.value.status === 'uncertain'
      })
      expect(accepted).toHaveLength(2)
      expect(settled.some((item) => item.status === 'fulfilled' && item.value.status === 'committed')).toBe(true)
    })
  })

  it('refuses a consumed author mismatch before writes and commits the equal author', async () => {
    await withSchema(async (env) => {
      const mismatched = await seed(env, 1, 'command-mismatch')
      const service = createAdminGrantProofService({ publicOrigin: ORIGIN })
      const issued = await service.issue(mismatched.minted.context, {
        intent: mismatched.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const prepared = await service.prepareConsume(mismatched.minted.context, {
        intent: mismatched.intent,
        proof: issued.proof,
      })
      await expect(withAuthorizationInputTransaction(prepared.privilegePlan.lockPlan, async (tx) => {
        await revalidatePrivilegeRolePlan(tx, prepared.privilegePlan)
        const consumed = await service.consumeOnTx(tx, mismatched.minted.context, prepared)
        await insertConsumedGrantBundle(tx, {
          publicOrigin: ORIGIN,
          context: mismatched.minted.context,
          consumed,
          intent: mismatched.intent,
          grantedBy: 'other-author',
        })
      })).rejects.toMatchObject({ name: 'StrictLoginGrantError', code: 'STRICT_LOGIN_GRANT_INPUT_REFUSED' })
      expect(await env.count('admin_login_grant_command_receipts')).toBe(0)
      expect(await env.count('user_external_identity_login_grants')).toBe(0)
      const equal = await seed(env, 1, 'command-equal')
      const execution = await issueAndEnable(equal)
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      expect(execution.receipt.actorId).toBe(equal.actorId)
      await expect(env.pool.query(
        `UPDATE user_external_identity_login_grants SET granted_by = granted_by || '-x' WHERE command_key = $1`,
        [equal.commandKey],
      )).rejects.toMatchObject({ code: '55000' })
      const stored = await env.rows(
        `SELECT granted_by FROM user_external_identity_login_grants WHERE command_key = $1`,
        [equal.commandKey],
      )
      expect(stored).toEqual([{ granted_by: equal.actorId }])
    })
  })
  it('rolls back when a later grant fails after the receipt and the first grant', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 2, 'command-nth')
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const originalExpiry = await proofExpiryText(env, issued.proof)
      await env.pool.query(`
        CREATE FUNCTION fixture_fail_nth_grant() RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        DECLARE
          seen bigint;
        BEGIN
          SELECT count(*) INTO seen FROM user_external_identity_login_grants;
          IF seen >= 1 THEN
            RAISE EXCEPTION 'fixture nth grant refused' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $fn$;
        CREATE TRIGGER fixture_fail_nth_grant
          BEFORE INSERT ON user_external_identity_login_grants
          FOR EACH ROW EXECUTE FUNCTION fixture_fail_nth_grant();
      `)
      const noted = await notedWrites(env)
      let fault: { code?: string, message?: string } | undefined
      try {
        await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
      } catch (error) {
        fault = error as { code?: string, message?: string }
      }
      expect(fault?.code).toBe('P0001')
      expect(fault?.message ?? '').toContain('fixture nth grant refused')
      expect(await notedWrites(env) - noted).toBe(2)
      expect(await env.count('fixture_write_order')).toBe(0)
      expect(await env.count('admin_login_grant_command_receipts')).toBe(0)
      expect(await env.count('user_external_identity_login_grants')).toBe(0)
      expect(await env.count('audit_logs')).toBe(0)
      await expectIssuedProof(env, issued.proof, originalExpiry)
    })
  })

  it('rolls the live bundle back when the deferred completeness check fails at commit', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 1, 'command-deferred')
      const target = seeded.intent.targets[0]
      if (!target) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_TARGET_PRIVILEGE_REFUSED')
      const spareIdentityId = randomUUID()
      const spareEvidenceId = `ev-spare-${randomBytes(4).toString('hex')}`
      await env.pool.query(
        `INSERT INTO user_external_identities (id, provider, external_key, local_user_id, corp_id)
         SELECT $1::uuid, provider, external_key || '-spare', local_user_id || '-spare', corp_id
           FROM user_external_identities
          WHERE id = $2::uuid`,
        [spareIdentityId, target.identityId],
      )
      await env.pool.query(
        `INSERT INTO user_external_identity_evidence (
           id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
           assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
           application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
           revocation_generation, slot_snapshot, created_by
         )
         SELECT $1, evidence_witness || '-spare', $2::text, $2::uuid, binding_revision, producer_id,
                assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
                application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
                0, slot_snapshot, created_by
           FROM user_external_identity_evidence
          WHERE id = $3`,
        [spareEvidenceId, spareIdentityId, target.evidenceId],
      )
      await env.pool.query('CREATE TABLE fixture_spare_evidence (evidence_id text PRIMARY KEY)')
      await env.pool.query(
        'INSERT INTO fixture_spare_evidence (evidence_id) VALUES ($1)',
        [spareEvidenceId],
      )
      await env.pool.query(`
        CREATE FUNCTION fixture_mismatch_grant() RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          IF NEW.target_ordinal IS DISTINCT FROM 1 THEN
            RETURN NEW;
          END IF;
          IF pg_catalog.current_setting('fixture.mismatch_grant', true) = '1' THEN
            RETURN NEW;
          END IF;
          PERFORM pg_catalog.set_config('fixture.mismatch_grant', '1', true);
          INSERT INTO user_external_identity_login_grants (
            id, command_key, target_ordinal, command_id, evidence_id, evidence_witness,
            identity_id, live_identity_id, local_user_id, connection_id, binding_revision,
            binding_revision_text, application_revision, access_generation_text, org_id,
            subject_key, app_scope, material_fingerprint, capability_revision_seen,
            privilege_witness, assurance, grant_method, enabled, granted_by,
            revocation_generation, created_at
          )
          SELECT 'slg.' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.id || ':spare', 'UTF8')), 'hex'),
                 NEW.command_key,
                 2,
                 NEW.command_id,
                 spare.id,
                 spare.evidence_witness,
                 spare.identity_id,
                 spare.live_identity_id,
                 spare_identity.local_user_id,
                 NEW.connection_id,
                 spare.binding_revision,
                 spare.binding_revision::text,
                 NEW.application_revision,
                 NEW.access_generation_text,
                 NEW.org_id,
                 spare.subject_key,
                 spare.app_scope,
                 spare.material_fingerprint,
                 spare.capability_revision_seen::text,
                 NEW.privilege_witness,
                 'self_authenticated',
                 'admin_explicit',
                 TRUE,
                 NEW.granted_by,
                 0,
                 pg_catalog.clock_timestamp()
            FROM fixture_spare_evidence marker
            JOIN user_external_identity_evidence spare ON spare.id = marker.evidence_id
            JOIN user_external_identities spare_identity ON spare_identity.id = spare.live_identity_id;
          RETURN NEW;
        END;
        $fn$;
        CREATE TRIGGER fixture_mismatch_grant
          AFTER INSERT ON user_external_identity_login_grants
          FOR EACH ROW EXECUTE FUNCTION fixture_mismatch_grant();
      `)
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const originalExpiry = await proofExpiryText(env, issued.proof)
      const noted = await notedWrites(env)
      const gate = await loseNextBundleCommitAck(env, 'record-rejection')
      try {
        const execution = await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
        expect(execution.status).toBe('uncertain')
        if (execution.status !== 'uncertain') return
        expect(execution.commandKey).toBe(seeded.commandKey)
        expect(gate.commitRejection()).toEqual({
          code: '23514',
          message: 'strict login grant bundle refused',
        })
        expect(await notedWrites(env) - noted).toBe(4)
        expect(await env.count('fixture_write_order')).toBe(0)
        expect(await env.count('admin_login_grant_command_receipts')).toBe(0)
        expect(await env.count('user_external_identity_login_grants')).toBe(0)
        expect(await env.count('audit_logs')).toBe(0)
        await expectIssuedProof(env, issued.proof, originalExpiry)
      } finally {
        gate.restore()
      }
    })
  })

  it('reads the committed receipt after the proof expires and the target user is deleted', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 1, 'command-history')
      await env.pool.query(
        `UPDATE user_sessions
            SET expires_at = pg_catalog.clock_timestamp() + interval '20 seconds'
          WHERE id = $1`,
        [seeded.minted.context.sessionId],
      )
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const originalExpiry = await proofExpiryText(env, issued.proof)
      const parsed = parseAdminGrantProof(issued.proof)
      if (!parsed) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_PROOF_FIXTURE_REFUSED')
      const bounded = await env.rows(
        `SELECT expires_at > pg_catalog.clock_timestamp() AS live,
                expires_at <= pg_catalog.clock_timestamp() + interval '40 seconds' AS bounded
           FROM security_action_challenges
          WHERE id = $1::uuid`,
        [parsed.id],
      )
      expect(bounded).toEqual([{ live: true, bounded: true }])
      const execution = await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      const consumed = await env.rows(
        `SELECT status,
                to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                consumed_action_ref
           FROM security_action_challenges
          WHERE id = $1::uuid`,
        [execution.receipt.proofId],
      )
      expect(consumed).toEqual([{
        status: 'consumed',
        expires_at: originalExpiry,
        consumed_action_ref: `agc:${seeded.commandKey}`,
      }])
      const issuedSessionId = `sid${randomBytes(8).toString('hex')}`
      await env.pool.query(
        `INSERT INTO user_sessions (id, user_id, expires_at)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '2 hours')`,
        [issuedSessionId, seeded.actorId],
      )
      const token = tokenFor(seeded.actorId, issuedSessionId, seeded.intent.orgId)
      const request = requestShape(seeded.actorId, token, seeded.intent.orgId, {
        headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      })
      const browser = await createAdminGrantBrowserContext({ publicOrigin: ORIGIN }).establish(
        request as Request,
        captureResponse(),
      )
      retainAdminGrantBrowserContext(ORIGIN, browser.session, browser)
      const replayInput = {
        publicOrigin: ORIGIN,
        context: browser.session,
        browser,
        intent: seeded.intent,
      }
      const replay = await readAdminLoginGrantCommandReceipt(replayInput)
      expect(replay).toMatchObject({
        status: 'committed',
        receipt: {
          commandKey: seeded.commandKey,
          canonicalIntent: execution.receipt.canonicalIntent,
          targetCount: 1,
        },
      })
      const target = seeded.intent.targets[0]
      if (!target) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_TARGET_PRIVILEGE_REFUSED')
      await env.pool.query(
        `UPDATE user_external_identity_evidence
            SET revocation_generation = revocation_generation + 1,
                live_identity_id = NULL
          WHERE id = $1`,
        [target.evidenceId],
      )
      const evidence = await env.rows(
        `SELECT revoked_at IS NOT NULL AS revoked, live_identity_id
           FROM user_external_identity_evidence
          WHERE id = $1`,
        [target.evidenceId],
      )
      expect(evidence).toEqual([{ revoked: true, live_identity_id: null }])
      const client = await env.pool.connect()
      try {
        await client.query('BEGIN')
        const revoked = await revokeForUserInScope(client, seeded.intent.connectionId, target.userId, {
          reason: 'admin_disable',
          revokedBy: seeded.actorId,
        })
        expect(revoked.grantIds).toHaveLength(1)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      await expect(env.pool.query(
        `UPDATE security_action_challenges
            SET expires_at = expires_at - interval '1 second'
          WHERE id = $1::uuid`,
        [execution.receipt.proofId],
      )).rejects.toMatchObject({ code: '55000' })
      const still = await env.rows(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
           FROM security_action_challenges
          WHERE id = $1::uuid`,
        [execution.receipt.proofId],
      )
      expect(still[0]?.expires_at).toBe(originalExpiry)
      const expiryDeadline = Date.now() + 30000
      let proofExpired = false
      while (!proofExpired) {
        const clock = await env.rows(
          `SELECT pg_catalog.clock_timestamp() > expires_at AS expired
             FROM security_action_challenges
            WHERE id = $1::uuid`,
          [execution.receipt.proofId],
        )
        proofExpired = clock[0]?.expired === true
        if (proofExpired) break
        if (Date.now() >= expiryDeadline) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_EXPIRY_WAIT_EXCEEDED')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const expiredText = await env.rows(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
           FROM security_action_challenges
          WHERE id = $1::uuid`,
        [execution.receipt.proofId],
      )
      expect(expiredText[0]?.expires_at).toBe(originalExpiry)
      await env.pool.query('DELETE FROM user_orgs WHERE user_id = $1', [target.userId])
      const removed = await env.pool.query('DELETE FROM users WHERE id = $1', [target.userId])
      expect(removed.rowCount).toBe(1)
      expect(await env.rows('SELECT id FROM users WHERE id = $1', [target.userId])).toEqual([])
      const afterTerminal = await readAdminLoginGrantCommandReceipt(replayInput)
      expect(afterTerminal).toMatchObject({
        status: 'committed',
        receipt: { commandKey: seeded.commandKey, canonicalIntent: execution.receipt.canonicalIntent },
      })
      const changed = normalizeAdminGrantIntent({
        ...seeded.intent,
        targets: [{ ...target, userId: `${target.userId}-other` }],
      })
      await expect(readAdminLoginGrantCommandReceipt({
        ...replayInput,
        intent: changed,
      })).rejects.toMatchObject({
        name: 'AdminLoginGrantCommandError',
        code: 'ADMIN_LOGIN_GRANT_COMMAND_CONFLICT',
      })
      await expect(readAdminLoginGrantCommandReceipt({
        ...replayInput,
        context: seeded.minted.context,
      })).rejects.toMatchObject({
        name: 'AdminLoginGrantCommandError',
        code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
      })
      await env.pool.query(
        `UPDATE user_sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE id = $1`,
        [issuedSessionId],
      )
      await expect(readAdminLoginGrantCommandReceipt(replayInput)).rejects.toMatchObject({
        name: 'AdminGrantActorInputError',
        code: 'ADMIN_GRANT_BROWSER_SESSION_STALE',
      })
      expect(await env.count('admin_login_grant_command_receipts')).toBe(1)
      expect(await env.count('user_external_identity_login_grants')).toBe(1)
    })
  })

  it('keeps one consumed proof, an immutable receipt, and the historical grant set', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 2, 'command-one-use')
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const originalExpiry = await proofExpiryText(env, issued.proof)
      const execution = await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
      expect(execution.status).toBe('committed')
      if (execution.status !== 'committed') return
      await expect(createAdminGrantProofService({ publicOrigin: ORIGIN }).prepareConsume(
        seeded.minted.context,
        { intent: seeded.intent, proof: issued.proof },
      )).rejects.toMatchObject({ name: 'AdminGrantProofError', code: 'ADMIN_GRANT_PROOF_INVALID' })
      const userIds = seeded.intent.targets.map((target) => target.userId)
      const expected = grantIdsFor(seeded.commandKey, userIds)
      const stored = await env.rows(
        `SELECT id, target_ordinal, local_user_id
           FROM user_external_identity_login_grants
          WHERE command_key = $1
          ORDER BY target_ordinal`,
        [seeded.commandKey],
      )
      expect(stored).toEqual(expected.map((grant) => ({
        id: grant.grantId,
        target_ordinal: grant.ordinal,
        local_user_id: grant.userId,
      })))
      const consumed = await env.rows(
        `SELECT status,
                to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                consumed_at IS NOT NULL AS consumed,
                consumed_action_ref
           FROM security_action_challenges
          WHERE id = $1::uuid`,
        [execution.receipt.proofId],
      )
      expect(consumed).toEqual([{
        status: 'consumed',
        expires_at: originalExpiry,
        consumed: true,
        consumed_action_ref: `agc:${seeded.commandKey}`,
      }])
      expect(String(consumed[0]?.consumed_action_ref)).toHaveLength(68)
      await expect(env.pool.query(
        `UPDATE admin_login_grant_command_receipts SET outcome = outcome WHERE command_key = $1`,
        [seeded.commandKey],
      )).rejects.toMatchObject({ code: '55000' })
      await expect(env.pool.query(
        `DELETE FROM user_external_identity_login_grants WHERE command_key = $1`,
        [seeded.commandKey],
      )).rejects.toMatchObject({ code: '55000' })
      const client = await env.pool.connect()
      try {
        await client.query('BEGIN')
        for (const target of seeded.intent.targets) {
          const revoked = await revokeForUserInScope(client, seeded.intent.connectionId, target.userId, {
            reason: 'admin_disable',
            revokedBy: seeded.actorId,
          })
          expect(revoked.grantIds).toHaveLength(1)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      const grants = await env.rows(
        `SELECT enabled, revoked_reason IS NOT NULL AS revoked
           FROM user_external_identity_login_grants
          WHERE command_key = $1
          ORDER BY target_ordinal`,
        [seeded.commandKey],
      )
      expect(grants).toEqual([
        { enabled: false, revoked: true },
        { enabled: false, revoked: true },
      ])
      const read = await readAdminLoginGrantCommandReceipt(readInput(seeded))
      expect(read).toMatchObject({
        status: 'committed',
        receipt: { commandKey: seeded.commandKey, targetCount: 2 },
      })
      const again = normalizeAdminGrantIntent({
        ...seeded.intent,
        commandId: 'command-one-use-next',
      })
      await expect(executeAdminLoginGrantEnable({
        publicOrigin: ORIGIN,
        context: seeded.minted.context,
        browser: seeded.minted.browser,
        intent: again,
        proof: issued.proof,
      })).rejects.toMatchObject({ name: 'AdminGrantProofError', code: 'ADMIN_GRANT_PROOF_INVALID' })
      expect(await env.count('admin_login_grant_command_receipts')).toBe(1)
      expect(await env.count('user_external_identity_login_grants')).toBe(2)
    })
  })

  it('withholds one bundle commit acknowledgment after the durable receipt, grants, and audit', async () => {
    await withSchema(async (env) => {
      const seeded = await seed(env, 1, 'command-unknown-ack')
      const issued = await createAdminGrantProofService({ publicOrigin: ORIGIN }).issue(seeded.minted.context, {
        intent: seeded.intent,
        method: 'local_password',
        password: PASSWORD,
      })
      const gate = await loseNextBundleCommitAck(env)
      try {
        const execution = await executeAdminLoginGrantEnable(enableInput(seeded, issued.proof))
        expect(execution.status).toBe('committed')
        if (execution.status !== 'committed') return
        expect(gate.observedBeforeFault()).toBe(true)
        const witness = gate.witness()
        if (!witness) throw new Error('ADMIN_LOGIN_GRANT_COMMAND_COMMIT_NOT_DURABLE')
        const userIds = seeded.intent.targets.map((target) => target.userId)
        expect(witness.receipts).toEqual([{ command_key: seeded.commandKey, target_count: 1 }])
        expect(witness.grants).toEqual(grantIdsFor(seeded.commandKey, userIds).map((grant) => ({
          id: grant.grantId,
          target_ordinal: grant.ordinal,
          local_user_id: grant.userId,
        })))
        expect(witness.audits).toEqual([{
          action: 'admin_login_grant_enable',
          command_key: seeded.commandKey,
        }])
        expect(execution.receipt).toMatchObject({
          commandKey: seeded.commandKey,
          targetCount: 1,
          canonicalIntent: encodeAdminGrantIntent(seeded.intent),
        })
        const followed = gate.sqlAfter().join('\n')
        expect(followed).toContain('admin_login_grant_command_receipts')
        expect(followed).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"(?:admin_login_grant_command_receipts|user_external_identity_login_grants|security_action_challenges|audit_logs)"|(?:admin_login_grant_command_receipts|user_external_identity_login_grants|security_action_challenges|audit_logs)\b)/i)
        expect(followed).not.toMatch(/password_hash|bcrypt|dingtalk\.com/i)
        expect(await env.count('admin_login_grant_command_receipts')).toBe(1)
        expect(await env.count('user_external_identity_login_grants')).toBe(1)
        expect(await env.count('audit_logs')).toBe(1)
      } finally {
        gate.restore()
      }
    })
  })

})
