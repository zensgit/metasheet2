/**
 * Native controls for the strict credential chain. Not run by this author.
 * Not qualified. A skip is not a pass.
 *
 * Connects only when EXPECT_DB=1 and DATABASE_URL are both set. Its own pg
 * Pool is constructed inside that gate. The application pool stays mocked, so
 * collecting this file does not construct one. vitest.config.ts is unchanged.
 *
 * Fixture rows are not an issued strict grant. The rolled-back preservation
 * and compound-invalid joined rows are bounded SQL controls. The committed
 * usable-strict and sibling-preservation gate calls the published credential,
 * new-session, browser, T3 issue, and executeAdminLoginGrantEnable chain.
 * Identity and evidence rows on that gate are the labelled receiving fixture,
 * not a T2 or provider ceremony.
 *
 * Caller gates after those sixteen use the same published helpers. They are
 * unrun here. Old writer, invite, API-route, and formula-table cases are not
 * in this file.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { applyRecyclePurge, USER_TOMBSTONE_NAME } from '../../src/admin/user-recycle'
import { adminGrantApplicationMaterialFingerprint } from '../../src/auth/admin-grant-application-material'
import type { AdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import {
  CREDENTIAL_REVOCATION_FLAG,
  completeIdentityDeletion,
  finishDeprovisionCredentials,
  guardAdminLegacyGrantSwitchSet,
  noRemainingLoginMethod,
} from '../../src/auth/strict-credential-chain'
import { lockUsersForAccessGraphWrite } from '../../src/directory/access-graph-mutex'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  commandKeyFor,
  grantIdsFor,
  insertConnectionLoginScope,
  STRICT_GRANT_SESSION_REVOCATION_REASON,
  StrictLoginGrantError,
} from '../../src/auth/strict-login-grant-store'
import { up as deprovisionLedgerUp } from '../../src/db/migrations/zzzz20260724170000_directory_deprovision_ledger_and_generation'
import { up as hardenDeprovisionLedgerUp } from '../../src/db/migrations/zzzz20260728100000_harden_directory_deprovision_ledger'
import { up as deprovisionGrantRowCreatedUp } from '../../src/db/migrations/zzzz20260808090000_deprovision_effect_grant_row_created'
import { up as challengesUp } from '../../src/db/migrations/zzzz20261106120000_create_security_action_challenges'
import { up as flightUp } from '../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight'
import { up as receivingUp } from '../../src/db/migrations/zzzz20261117173000_create_admin_grant_receiving_pins'
import { up as actorUp } from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'
import { up as proofUp } from '../../src/db/migrations/zzzz20261118100000_admin_grant_proof_sets'
import {
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  up,
} from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import type { Database } from '../../src/db/types'

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn(async () => {}),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: vi.fn(),
      transaction: vi.fn(),
      getInternalPool: () => null,
    }),
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
  query: vi.fn(),
  transaction: vi.fn(),
  getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
}))

const expectDb = process.env.EXPECT_DB === '1'
const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = expectDb && dbUrl ? describe : describe.skip
const sentinel = expectDb ? it : it.skip
const kept: string[] = []
const DEPARTED = '00000000-0000-4000-8000-0000000000b2'
const FINGERPRINT = 'ab'.repeat(32)
const PUBLISHED_ORIGIN = 'https://directory.invalid'
const PUBLISHED_PASSWORD = 'fixture-password'
const PUBLISHED_MATERIAL = {
  appKey: 'synthetic-app-key',
  appSecret: 'synthetic-ciphertext',
  baseUrl: 'https://directory.invalid/synthetic',
  workNotificationAgentId: 'synthetic-agent',
}

sentinel('strict credential chain native lane requires DATABASE_URL when EXPECT_DB is set', () => {
  expect(dbUrl).toBeTruthy()
})

function quoteSchema(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('B2_NATIVE_SCHEMA_REFUSED')
  return `"${name}"`
}

function hex64(): string {
  return randomBytes(32).toString('hex')
}

function callerFor(client: PoolClient) {
  return {
    async query(text: string, params?: unknown[]) {
      const result = await client.query(text, (params ?? []) as never[])
      return { rows: result.rows, rowCount: result.rowCount }
    },
  }
}

async function createSchema(): Promise<string> {
  const schema = `b2n${randomBytes(8).toString('hex')}`
  kept.push(schema)
  const admin = new Pool({ connectionString: dbUrl, options: '-c search_path=pg_catalog' })
  try {
    await admin.query(`CREATE SCHEMA ${quoteSchema(schema)}`)
  } finally {
    await admin.end()
  }
  return schema
}

function poolFor(schema: string, max: number): Pool {
  return new Pool({
    connectionString: dbUrl,
    max,
    options: `-c search_path=${schema},pg_catalog`,
  })
}

async function installStrict(pool: Pool, schema: string): Promise<void> {
  await pool.query(`
    CREATE TABLE kysely_migration (
      name varchar(255) PRIMARY KEY,
      timestamp varchar(255) NOT NULL
    );
    CREATE TABLE directory_integrations (
      id uuid PRIMARY KEY,
      org_id text,
      provider text,
      name text,
      status text,
      corp_id text,
      config jsonb
    );
    CREATE TABLE directory_accounts (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      is_active boolean NOT NULL
    );
    CREATE TABLE directory_account_links (
      id uuid PRIMARY KEY,
      directory_account_id uuid NOT NULL,
      local_user_id text NOT NULL,
      link_status text NOT NULL
    );
    CREATE TABLE user_external_auth_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      local_user_id text NOT NULL,
      enabled boolean NOT NULL,
      granted_by text
    );
    -- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
    CREATE TABLE subject_authorization_versions (
      subject_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id text PRIMARY KEY,
      email text,
      name text,
      role text,
      permissions jsonb,
      is_active boolean,
      must_change_password boolean,
      activation_status text,
      local_password_set boolean,
      password_hash text,
      created_at timestamptz,
      updated_at timestamptz,
      access_generation bigint,
      deleted_at timestamptz,
      purged_at timestamptz
    );
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL
    );
    CREATE TABLE user_external_identities (
      id uuid PRIMARY KEY,
      provider text,
      local_user_id text,
      external_key text,
      corp_id text,
      provider_open_id text,
      provider_union_id text
    );
    CREATE TABLE user_external_identity_binding_pins (
      identity_id uuid PRIMARY KEY,
      binding_revision bigint,
      provider text,
      local_user_id text,
      external_key text,
      corp_id text,
      provider_open_id text,
      provider_union_id text
    );
    CREATE TABLE user_external_identity_evidence (
      id text PRIMARY KEY,
      evidence_witness text,
      identity_id text,
      live_identity_id uuid,
      binding_revision bigint,
      assurance text,
      subject_key text,
      app_scope text,
      org_id text,
      connection_id uuid,
      capability_revision_seen bigint,
      application_revision text,
      material_fingerprint text,
      slot_snapshot jsonb,
      revoked_at timestamptz,
      revocation_generation bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE directory_connection_application_pins (
      connection_id uuid PRIMARY KEY,
      application_revision text,
      material_fingerprint text
    );
    CREATE TABLE directory_integration_capabilities (
      integration_id uuid PRIMARY KEY,
      revision bigint,
      login_enabled boolean,
      login_bound_tenant text,
      login_bound_app_scope text,
      bound_provider text,
      bound_org_id text
    );
    CREATE TABLE security_action_challenges (
      id uuid PRIMARY KEY,
      purpose text,
      status text,
      consumed_action_ref text
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
  `)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await db.transaction().execute(async (trx) => {
    await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
    await up(trx)
  })
  await pool.query(
    'INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)',
    [STRICT_LOGIN_GRANT_MIGRATION_NAME, '2026-11-18T12:00:00.000Z'],
  )
  await pool.query(`
    ALTER TABLE user_sessions
      ADD COLUMN revoked_by text,
      ADD COLUMN revoke_reason text,
      ADD COLUMN updated_at timestamptz
  `)
}

async function waitForTokenUpdateWaiter(holder: PoolClient, holderPid: number): Promise<void> {
  const deadline = Date.now() + 2500
  for (;;) {
    // This holder transaction caches the first pg_stat_activity read. Clear it
    // before every poll so a later blocked UPDATE is visible on the same client.
    await holder.query('SELECT pg_catalog.pg_stat_clear_snapshot()')
    const seen = await holder.query(
      `SELECT activity.pid
         FROM pg_catalog.pg_stat_activity activity
        WHERE activity.pid <> pg_catalog.pg_backend_pid()
          AND activity.state = 'active'
          AND activity.wait_event_type = 'Lock'
          AND activity.query ILIKE '%UPDATE%'
          AND activity.query ILIKE '%multitable_api_tokens%'
          AND $1::int = ANY (pg_catalog.pg_blocking_pids(activity.pid))`,
      [holderPid],
    )
    if (seen.rows.length > 0) return
    if (Date.now() >= deadline) throw new Error('B2_TOKEN_UPDATE_WAITER_ABSENT')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type PublishedChain = {
  nativePool: Pool
  executeAdminLoginGrantEnable: typeof import('../../src/auth/admin-login-grant-command').executeAdminLoginGrantEnable
  createAdminGrantProofService: typeof import('../../src/auth/admin-grant-proof').createAdminGrantProofService
  retainAdminGrantBrowserContext: typeof import('../../src/auth/admin-grant-proof').retainAdminGrantBrowserContext
  changeRequiredPasswordWithProvenance: typeof import('../../src/auth/admin-grant-local-credential').changeRequiredPasswordWithProvenance
  createAdminGrantBrowserContext: typeof import('../../src/auth/admin-grant-browser-context').createAdminGrantBrowserContext
  normalizeAdminGrantIntent: typeof import('../../src/auth/admin-login-grant-intent').normalizeAdminGrantIntent
  assessSecurityActionPrivilege: typeof import('../../src/auth/security-action-privilege').assessSecurityActionPrivilege
  contextFor: typeof import('../helpers/security-action-proof-harness').contextFor
  requestShape: typeof import('../helpers/security-action-proof-harness').requestShape
  tokenFor: typeof import('../helpers/security-action-proof-harness').tokenFor
}

let publishedChain: PublishedChain | undefined

async function loadPublishedCommandChain(): Promise<PublishedChain> {
  if (publishedChain) return publishedChain
  vi.doUnmock('../../src/db/pg')
  vi.doUnmock('../../src/integration/db/connection-pool')
  vi.doUnmock('../../src/audit/audit')
  vi.resetModules()
  const database = await import('../../src/db/pg')
  if (!database.pool) throw new Error('B2_PUBLISHED_CHAIN_POOL_ABSENT')
  const command = await import('../../src/auth/admin-login-grant-command')
  const proof = await import('../../src/auth/admin-grant-proof')
  const credential = await import('../../src/auth/admin-grant-local-credential')
  const browser = await import('../../src/auth/admin-grant-browser-context')
  const intent = await import('../../src/auth/admin-login-grant-intent')
  const privilege = await import('../../src/auth/security-action-privilege')
  const harness = await import('../helpers/security-action-proof-harness')
  publishedChain = {
    nativePool: database.pool,
    executeAdminLoginGrantEnable: command.executeAdminLoginGrantEnable,
    createAdminGrantProofService: proof.createAdminGrantProofService,
    retainAdminGrantBrowserContext: proof.retainAdminGrantBrowserContext,
    changeRequiredPasswordWithProvenance: credential.changeRequiredPasswordWithProvenance,
    createAdminGrantBrowserContext: browser.createAdminGrantBrowserContext,
    normalizeAdminGrantIntent: intent.normalizeAdminGrantIntent,
    assessSecurityActionPrivilege: privilege.assessSecurityActionPrivilege,
    contextFor: harness.contextFor,
    requestShape: harness.requestShape,
    tokenFor: harness.tokenFor,
  }
  return publishedChain
}

type SavedPoolStartup = {
  options: string | undefined
  searchPath: string
}

let savedPublishedPool: SavedPoolStartup | null = null

async function aimPublishedPool(nativePool: Pool, schema: string): Promise<void> {
  if (!savedPublishedPool) {
    const startup = nativePool.options.options
    const client = await nativePool.connect()
    try {
      const seen = await client.query(`SELECT pg_catalog.current_setting('search_path') AS search_path`)
      const searchPath = seen.rows[0]?.search_path
      if (typeof searchPath !== 'string' || searchPath.length === 0) {
        throw new Error('B2_PUBLISHED_CHAIN_POOL_STARTUP_UNREADABLE')
      }
      savedPublishedPool = {
        options: typeof startup === 'string' ? startup : undefined,
        searchPath,
      }
    } finally {
      client.release()
    }
  }
  const searchPath = `${schema},pg_catalog`
  nativePool.options.options = `-c search_path=${searchPath}`
  const max = nativePool.options.max ?? 10
  const held: PoolClient[] = []
  try {
    while (held.length < max && (nativePool.idleCount > 0 || nativePool.totalCount < max)) {
      const client = await nativePool.connect()
      held.push(client)
      await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [searchPath])
    }
  } finally {
    for (const client of held) client.release()
  }
}

async function releasePublishedPool(nativePool: Pool): Promise<void> {
  if (!savedPublishedPool) return
  const saved = savedPublishedPool
  savedPublishedPool = null
  if (saved.options === undefined) delete nativePool.options.options
  else nativePool.options.options = saved.options
  const max = nativePool.options.max ?? 10
  const held: PoolClient[] = []
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

async function installPublishedParents(pool: Pool, schema: string): Promise<void> {
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
    CREATE TABLE user_external_auth_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      local_user_id text NOT NULL,
      enabled boolean NOT NULL,
      granted_by text
    );
    CREATE TABLE kysely_migration (
      name varchar(255) PRIMARY KEY,
      timestamp varchar(255) NOT NULL
    );
  `)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
    await challengesUp(trx)
    await flightUp(trx)
    await receivingUp(trx)
    await actorUp(trx)
    await proofUp(trx)
    await up(trx)
  })
  await pool.query(
    'INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)',
    [STRICT_LOGIN_GRANT_MIGRATION_NAME, '2026-11-18T12:00:00.000Z'],
  )
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
    throw new Error('B2_PUBLISHED_CHAIN_AUDIT_PARTITION_REFUSED')
  }
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
  await pool.query(
    `CREATE TABLE ${quoteSchema(schema)}.${quoteSchema(partition)} PARTITION OF ${quoteSchema(schema)}.audit_logs FOR VALUES FROM ('${startDate}') TO ('${endDate}')`,
  )
}

function capturePublishedResponse(): Response {
  const sent = { value: false }
  return {
    get headersSent() { return sent.value },
    append() { return this },
  } as unknown as Response
}

async function waitForPublishedWatermark(watermarkMs: string): Promise<void> {
  const mark = BigInt(watermarkMs)
  const deadline = Date.now() + 2500
  while (BigInt(Math.floor(Date.now() / 1000)) * 1000n <= mark) {
    if (Date.now() >= deadline) throw new Error('B2_PUBLISHED_CHAIN_WATERMARK_WAIT_EXCEEDED')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type PublishedTarget = {
  userId: string
  openId: string
}

async function issuePublishedConnection(
  published: PublishedChain,
  pool: Pool,
  input: {
    orgId: string
    connectionId: string
    corpId: string
    commandId: string
    targets: readonly PublishedTarget[]
    existingUserIds: ReadonlySet<string>
  },
): Promise<{ commandKey: string, grants: ReadonlyArray<{ userId: string, grantId: string }> }> {
  const actorId = `a-actor-${randomBytes(4).toString('hex')}`
  const fingerprint = adminGrantApplicationMaterialFingerprint(PUBLISHED_MATERIAL)
  const passwordHash = bcrypt.hashSync(PUBLISHED_PASSWORD, 4)
  await pool.query(
    `INSERT INTO users
       (id, username, name, password_hash, is_active, is_admin, role, activation_status,
        local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $1, 'fixture-prior-hash', true, true, 'admin', 'activated', true, true, 1)`,
    [actorId],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
    [actorId, input.orgId],
  )
  await pool.query(
    `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
     VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'fixture')`,
    [actorId],
  )
  const priorSessionId = `sid${randomBytes(8).toString('hex')}`
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '2 hours')`,
    [priorSessionId, actorId],
  )
  await pool.query(
    `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id, config)
     VALUES ($1::uuid, $2, 'dingtalk', 'fixture-not-a-producer', 'active', $3, $4::jsonb)`,
    [input.connectionId, input.orgId, input.corpId, JSON.stringify(PUBLISHED_MATERIAL)],
  )
  await pool.query(
    `INSERT INTO directory_integration_capabilities
       (integration_id, bound_provider, bound_org_id, login_enabled, login_bound_tenant, login_bound_app_scope, revision)
     VALUES ($1::uuid, 'dingtalk', $2, true, $3, 'synthetic-app', 4)`,
    [input.connectionId, input.orgId, input.corpId],
  )
  await pool.query(
    `INSERT INTO directory_connection_application_pins
       (connection_id, application_revision, material_fingerprint, updated_by)
     VALUES ($1::uuid, '4', $2, 'suite')`,
    [input.connectionId, fingerprint],
  )
  const pins: Array<{
    userId: string
    identityId: string
    bindingRevision: string
    evidenceId: string
    evidenceWitness: string
    accessGeneration: string
    privilegeWitness: string
  }> = []
  for (const target of input.targets) {
    const identityId = randomUUID()
    const evidenceId = `ev-${randomBytes(4).toString('hex')}`
    const evidenceWitness = `wit-${randomBytes(4).toString('hex')}`
    const externalKey = `ext-${target.userId}`
    const subjectKey = `${input.corpId}:${target.openId}`
    if (!input.existingUserIds.has(target.userId)) {
      await pool.query(
        `INSERT INTO users
           (id, username, name, password_hash, is_active, is_admin, role, activation_status,
            local_password_set, must_change_password, access_generation)
         VALUES ($1, $1, $1, $2, true, false, 'user', 'activated', true, false, 1)`,
        [target.userId, passwordHash],
      )
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [target.userId, input.orgId],
      )
      await pool.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, 'fixture')`,
        [target.userId],
      )
    }
    await pool.query(
      `INSERT INTO user_external_identities
         (id, provider, external_key, local_user_id, corp_id, provider_open_id)
       VALUES ($1::uuid, 'dingtalk', $2, $3, $4, $5)`,
      [identityId, externalKey, target.userId, input.corpId, target.openId],
    )
    await pool.query(
      `INSERT INTO user_external_identity_binding_pins
         (identity_id, binding_revision, provider, local_user_id, external_key, corp_id, provider_open_id)
       VALUES ($1::uuid, 7, 'dingtalk', $2, $3, $4, $5)`,
      [identityId, target.userId, externalKey, input.corpId, target.openId],
    )
    const slot = {
      corpId: input.corpId,
      externalKey,
      localUserId: target.userId,
      provider: 'dingtalk',
      providerOpenId: target.openId,
      providerUnionId: null,
    }
    await pool.query(
      `INSERT INTO user_external_identity_evidence
         (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
          assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
          application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
          revocation_generation, slot_snapshot, created_by)
       VALUES ($1, $2, $3::text, $3::uuid, 7, 'fixture-not-a-producer',
               'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 4, '4', $7,
               1, pg_catalog.clock_timestamp() - interval '2 days', pg_catalog.clock_timestamp() + interval '1 day',
               0, $8::jsonb, 'suite')`,
      [evidenceId, evidenceWitness, identityId, subjectKey, input.orgId, input.connectionId, fingerprint, JSON.stringify(slot)],
    )
    pins.push({
      userId: target.userId,
      identityId,
      bindingRevision: '7',
      evidenceId,
      evidenceWitness,
      accessGeneration: '1',
      privilegeWitness: '',
    })
  }
  const witnessClient = await pool.connect()
  try {
    await witnessClient.query('BEGIN')
    await witnessClient.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    for (const pin of pins) {
      const assessment = await published.assessSecurityActionPrivilege({
        query: async (text, params) => {
          const result = await witnessClient.query(text, (params ?? []) as never[])
          return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
        },
      }, pin.userId)
      if (assessment.privilegeClass !== 'standard' || assessment.reasons.length !== 0) {
        throw new Error('B2_PUBLISHED_CHAIN_TARGET_PRIVILEGE_REFUSED')
      }
      pin.privilegeWitness = assessment.witness
    }
    await witnessClient.query('COMMIT')
  } catch (error) {
    await witnessClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    witnessClient.release()
  }
  const intent: AdminGrantIntent = published.normalizeAdminGrantIntent({
    purpose: 'admin_login_grant_enable',
    commandId: input.commandId,
    actorId,
    orgId: input.orgId,
    provider: 'dingtalk',
    connectionId: input.connectionId,
    applicationRevision: '4',
    targets: pins,
  })
  const established = await published.changeRequiredPasswordWithProvenance({
    session: published.contextFor(actorId, priorSessionId, input.orgId),
    passwordHash,
  })
  const actor = await pool.query(
    `SELECT must_change_password, local_credential_version::text AS version
       FROM users WHERE id = $1`,
    [actorId],
  )
  if (actor.rows[0]?.must_change_password !== false) throw new Error('B2_PUBLISHED_CHAIN_PASSWORD_UNCHANGED')
  if (String(actor.rows[0]?.version).toLowerCase() !== established.credentialVersion) {
    throw new Error('B2_PUBLISHED_CHAIN_CREDENTIAL_VERSION_MISMATCH')
  }
  const mark = await pool.query(
    `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS watermark_ms
       FROM user_session_revocations WHERE user_id = $1`,
    [actorId],
  )
  const watermarkMs = mark.rows[0]?.watermark_ms
  if (typeof watermarkMs !== 'string' || !/^[0-9]+$/.test(watermarkMs)) {
    throw new Error('B2_PUBLISHED_CHAIN_WATERMARK_UNREADABLE')
  }
  await waitForPublishedWatermark(watermarkMs)
  const issuedSessionId = `sid${randomBytes(8).toString('hex')}`
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at)
     VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '2 hours')`,
    [issuedSessionId, actorId],
  )
  const token = published.tokenFor(actorId, issuedSessionId, input.orgId)
  const browser = await published.createAdminGrantBrowserContext({ publicOrigin: PUBLISHED_ORIGIN }).establish(
    published.requestShape(actorId, token, input.orgId, {
      headers: { authorization: `Bearer ${token}`, origin: PUBLISHED_ORIGIN },
    }) as Request,
    capturePublishedResponse(),
  )
  if (BigInt(browser.session.tokenIssuedAt) * 1000n <= BigInt(watermarkMs)) {
    throw new Error('B2_PUBLISHED_CHAIN_TOKEN_NOT_AFTER_WATERMARK')
  }
  published.retainAdminGrantBrowserContext(PUBLISHED_ORIGIN, browser.session, browser)
  const issued = await published.createAdminGrantProofService({ publicOrigin: PUBLISHED_ORIGIN }).issue(browser.session, {
    intent,
    method: 'local_password',
    password: PUBLISHED_PASSWORD,
  })
  const execution = await published.executeAdminLoginGrantEnable({
    publicOrigin: PUBLISHED_ORIGIN,
    context: browser.session,
    browser,
    intent,
    proof: issued.proof,
  })
  if (execution.status !== 'committed') throw new Error('B2_PUBLISHED_CHAIN_ENABLE_UNCOMMITTED')
  const commandKey = commandKeyFor(actorId, input.orgId, input.commandId)
  const grants = grantIdsFor(commandKey, intent.targets.map((target) => target.userId))
  return {
    commandKey,
    grants: grants.map((grant) => ({ userId: grant.userId, grantId: grant.grantId })),
  }
}

type CallerSurface = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

function restoreCredentialFlag(previous: string | undefined): void {
  if (previous === undefined) delete process.env[CREDENTIAL_REVOCATION_FLAG]
  else process.env[CREDENTIAL_REVOCATION_FLAG] = previous
}

function callerSurface(client: PoolClient): CallerSurface {
  return {
    async query(text: string, params?: unknown[]) {
      const result = await client.query(text, (params ?? []) as never[])
      return { rows: result.rows, rowCount: result.rowCount }
    },
  }
}

function recordingSurface(client: PoolClient, texts: string[]): CallerSurface {
  return {
    async query(text: string, params?: unknown[]) {
      texts.push(text)
      return callerSurface(client).query(text, params)
    },
  }
}

// Prove the revoke RETURNING row is already terminal, then drop password_hash.
// The next remaining-method read raises 42703. ROLLBACK restores both.
function failReadAfterGrantRevoke(client: PoolClient): CallerSurface {
  let armed = false
  return {
    async query(text: string, params?: unknown[]) {
      const result = await callerSurface(client).query(text, params)
      const statement = text.toLowerCase()
      if (
        !armed
        && statement.includes('update')
        && statement.includes('user_external_identity_login_grants')
        && statement.includes('revoked_run_id')
        && statement.includes('enabled')
      ) {
        const revokedId = String(result.rows[0]?.id ?? '')
        const proved = revokedId.length > 0
          ? await client.query(
            `SELECT enabled, revoked_at IS NOT NULL AS revoked
               FROM user_external_identity_login_grants
              WHERE id = $1`,
            [revokedId],
          )
          : { rows: [] }
        const row = proved.rows[0]
        if (!row || row.enabled !== false || row.revoked !== true) {
          throw new Error('B2_NATIVE_FAULT_PRECONDITION')
        }
        await client.query('ALTER TABLE users DROP COLUMN password_hash')
        armed = true
      }
      return result
    },
  }
}

// Prove the identity DELETE removed that user's rows, then drop employee_no.
// The later tombstone raises 42703. ROLLBACK restores both.
function failTombstoneAfterIdentityDelete(client: PoolClient): CallerSurface {
  let armed = false
  return {
    async query(text: string, params?: unknown[]) {
      const result = await callerSurface(client).query(text, params)
      if (!armed && /^\s*delete\s+from\s+user_external_identities\b/i.test(text)) {
        const userId = String(params?.[0] ?? '')
        const proved = userId.length > 0 && (result.rowCount ?? 0) > 0
          ? await client.query(
            `SELECT count(*)::int AS count
               FROM user_external_identities
              WHERE local_user_id = $1`,
            [userId],
          )
          : { rows: [] }
        if (proved.rows[0]?.count !== 0) throw new Error('B2_NATIVE_FAULT_PRECONDITION')
        await client.query('ALTER TABLE users DROP COLUMN employee_no')
        armed = true
      }
      return result
    },
  }
}

function strictSessionContext(input: {
  connectionId: string
  identityId: string
  grantId: string
  evidenceId: string
  orgId: string
  subjectKey: string
}): string {
  return JSON.stringify({
    v: 1,
    provider: 'dingtalk',
    assurance: 'self_authenticated',
    scopeAsserted: false,
    policyRevision: 1,
    connectionId: input.connectionId,
    identityId: input.identityId,
    grantId: input.grantId,
    evidenceId: input.evidenceId,
    orgId: input.orgId,
    subjectAppScope: 'synthetic-app',
    subjectKey: input.subjectKey,
    bindingRevision: '7',
    applicationRevision: '4',
    accessGeneration: '1',
    capRev: '4',
  })
}

type PublishedUser = {
  userId: string
  grantId: string
  identityId: string
  evidenceId: string
  openId: string
  externalKey: string
  corpId: string
  subjectKey: string
}

type PublishedPair = {
  published: PublishedChain
  pool: Pool
  schema: string
  orgId: string
  connectionId: string
  corpId: string
  userA: PublishedUser
  userB: PublishedUser
}

async function openPublishedPair(prefix: string): Promise<PublishedPair> {
  const published = await loadPublishedCommandChain()
  const schema = await createSchema()
  const pool = poolFor(schema, 10)
  try {
    const suffix = randomBytes(3).toString('hex')
    const orgId = `org-${prefix}-${suffix}`
    const connectionId = randomUUID()
    const corpId = `corp-${prefix}-${suffix}`
    const userA = `b2-${prefix}-a-${suffix}`
    const userB = `b2-${prefix}-b-${suffix}`
    const openA = `open-${prefix}-a-${suffix}`
    const openB = `open-${prefix}-b-${suffix}`
    await installPublishedParents(pool, schema)
    await aimPublishedPool(published.nativePool, schema)
    const issued = await issuePublishedConnection(published, pool, {
      orgId,
      connectionId,
      corpId,
      commandId: `${prefix}-${suffix}`,
      targets: [
        { userId: userA, openId: openA },
        { userId: userB, openId: openB },
      ],
      existingUserIds: new Set<string>(),
    })
    const loaded = await pool.query(
      `SELECT grant_row.local_user_id,
              grant_row.id AS grant_id,
              grant_row.identity_id,
              grant_row.evidence_id,
              identity.provider_open_id,
              identity.external_key,
              identity.corp_id,
              evidence.subject_key
         FROM user_external_identity_login_grants grant_row
         JOIN user_external_identities identity
           ON identity.id::text = grant_row.identity_id
         JOIN user_external_identity_evidence evidence
           ON evidence.id = grant_row.evidence_id
        WHERE grant_row.local_user_id = ANY($1::text[])`,
      [[userA, userB]],
    )
    const byUser = new Map(loaded.rows.map((row) => [String(row.local_user_id), row]))
    const userOf = (userId: string, openId: string): PublishedUser => {
      const row = byUser.get(userId)
      const grantId = issued.grants.find((grant) => grant.userId === userId)?.grantId
      if (!row || !grantId || grantId !== String(row.grant_id)) {
        throw new Error('B2_PUBLISHED_CHAIN_GRANT_ID_ABSENT')
      }
      return {
        userId,
        grantId,
        identityId: String(row.identity_id),
        evidenceId: String(row.evidence_id),
        openId,
        externalKey: String(row.external_key),
        corpId: String(row.corp_id),
        subjectKey: String(row.subject_key),
      }
    }
    return {
      published,
      pool,
      schema,
      orgId,
      connectionId,
      corpId,
      userA: userOf(userA, openA),
      userB: userOf(userB, openB),
    }
  } catch (error) {
    await releasePublishedPool(published.nativePool).catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }
}

async function installNativeCallerTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE directory_accounts (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      corp_id text,
      external_user_id text,
      union_id text,
      open_id text,
      external_key text,
      name text,
      email text,
      mobile text,
      nick text,
      job_number text,
      title text,
      avatar_url text,
      org_email text,
      raw jsonb,
      is_active boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    );
    CREATE TABLE directory_account_links (
      directory_account_id uuid PRIMARY KEY,
      local_user_id text,
      link_status text NOT NULL,
      match_strategy text,
      reviewed_by text,
      review_note text,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    );
    CREATE TABLE directory_departments (
      id uuid PRIMARY KEY,
      full_path text
    );
    CREATE TABLE directory_account_departments (
      directory_account_id uuid,
      directory_department_id uuid
    );
    CREATE TABLE user_login_aliases (
      user_id text PRIMARY KEY
    );
    CREATE TABLE multitable_api_tokens (
      id text PRIMARY KEY,
      created_by text NOT NULL,
      revoked boolean NOT NULL,
      revoked_at timestamptz
    );
    ALTER TABLE user_external_auth_grants
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp();
    CREATE UNIQUE INDEX idx_user_external_auth_grants_provider_user
      ON user_external_auth_grants (provider, local_user_id);
    ALTER TABLE user_sessions
      ADD COLUMN revoked_by text,
      ADD COLUMN revoke_reason text,
      ADD COLUMN updated_at timestamptz;
    ALTER TABLE users
      ADD COLUMN employee_no text,
      ADD COLUMN avatar_url text,
      ADD COLUMN department text,
      ADD COLUMN position text,
      ADD COLUMN hire_date date,
      ADD COLUMN cumulative_service_start_date date,
      ADD COLUMN last_login_at timestamptz,
      ADD COLUMN purged_by text,
      ADD COLUMN purge_after timestamptz;
    ALTER TABLE audit_logs
      ADD COLUMN resource_name text,
      ADD COLUMN user_id text,
      ADD COLUMN user_name text,
      ADD COLUMN user_email text,
      ADD COLUMN request_body jsonb;
  `)
}

async function installSupersedeTargets(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE directory_deprovision_effects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      local_user_id text,
      status text,
      updated_at timestamptz
    );
    ALTER TABLE directory_deprovision_events
      ADD COLUMN local_user_id text,
      ADD COLUMN status text,
      ADD COLUMN resolved_at timestamptz,
      ADD COLUMN resolved_by text,
      ADD COLUMN resolve_note text,
      ADD COLUMN updated_at timestamptz;
  `)
}

async function installCombinedDeprovisionLedger(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE user_external_identity_login_grants
      DROP CONSTRAINT user_external_identity_login_grants_event_fk
  `)
  await pool.query('DROP TABLE directory_deprovision_events')
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
    await deprovisionLedgerUp(trx)
  })
  await pool.query('ALTER TABLE directory_sync_runs ADD COLUMN integration_id uuid')
  await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx)
    await hardenDeprovisionLedgerUp(trx)
    await deprovisionGrantRowCreatedUp(trx)
  })
  await pool.query(`
    ALTER TABLE user_external_identity_login_grants
      ADD CONSTRAINT user_external_identity_login_grants_event_fk
      FOREIGN KEY (revoked_event_id) REFERENCES directory_deprovision_events (id) ON DELETE RESTRICT
  `)
}

async function insertLinkedAccount(
  pool: Pool,
  input: {
    accountId: string
    connectionId: string
    corpId: string
    userId: string
    openId: string
    externalKey: string
    active: boolean
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO directory_accounts (
       id, integration_id, provider, corp_id, open_id, external_key, name, is_active
     ) VALUES ($1::uuid, $2::uuid, 'dingtalk', $3, $4, $5, $4, $6)`,
    [input.accountId, input.connectionId, input.corpId, input.openId, input.externalKey, input.active],
  )
  await pool.query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [input.accountId, input.userId],
  )
}

async function commitConnectionScope(pool: Pool, connectionId: string, commandId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await insertConnectionLoginScope(callerFor(client), { connectionId, commandId })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedStrictOnlyLedger(pair: PublishedPair): Promise<{
  departedAccountId: string
  siblingAccountId: string
  runId: string
}> {
  const departedAccountId = randomUUID()
  const siblingAccountId = randomUUID()
  const runId = randomUUID()
  await insertLinkedAccount(pair.pool, {
    accountId: departedAccountId,
    connectionId: pair.connectionId,
    corpId: pair.corpId,
    userId: pair.userA.userId,
    openId: pair.userA.openId,
    externalKey: pair.userA.externalKey,
    active: false,
  })
  await insertLinkedAccount(pair.pool, {
    accountId: siblingAccountId,
    connectionId: pair.connectionId,
    corpId: pair.corpId,
    userId: pair.userA.userId,
    openId: `sibling-${pair.userA.openId}`,
    externalKey: `sibling-${pair.userA.externalKey}`,
    active: true,
  })
  await pair.pool.query(
    `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
     VALUES ('dingtalk', $1, false, 'fixture')`,
    [pair.userA.userId],
  )
  await pair.pool.query(
    `UPDATE users SET password_hash = 'unusable:reader' WHERE id = ANY($1::text[])`,
    [[pair.userA.userId, pair.userB.userId]],
  )
  await pair.pool.query('INSERT INTO directory_sync_runs (id) VALUES ($1::uuid)', [runId])
  await commitConnectionScope(pair.pool, pair.connectionId, `scope-${pair.userA.userId}`)
  return { departedAccountId, siblingAccountId, runId }
}

function ledgerCandidate(pair: PublishedPair, accountId: string, runId: string) {
  return {
    localUserId: pair.userA.userId,
    orgId: pair.orgId,
    integrationId: pair.connectionId,
    directoryAccountId: accountId,
    runId,
    triggeredBy: 'b2-native-actor',
    policy: 'disable_grant_only' as const,
    write: true,
    ledgerScope: {},
  }
}

async function releaseNativePair(pair: PublishedPair | undefined): Promise<void> {
  if (!pair) return
  await releasePublishedPool(pair.published.nativePool).catch(() => undefined)
  await pair.pool.end()
}

afterAll(async () => {
  if (!expectDb || !dbUrl || kept.length === 0) return
  const admin = new Pool({ connectionString: dbUrl, options: '-c search_path=pg_catalog' })
  try {
    for (const schema of kept) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
    }
  } finally {
    await admin.end()
  }
})

describeIfDatabase('strict credential chain native lifecycle', () => {
  it('bounded: empty link read parses the selected aliases and does not revoke', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE TABLE directory_integrations (
          id uuid PRIMARY KEY,
          provider text
        );
        CREATE TABLE directory_accounts (
          id uuid PRIMARY KEY,
          integration_id uuid NOT NULL,
          provider text NOT NULL
        );
        CREATE TABLE directory_account_links (
          directory_account_id uuid NOT NULL,
          local_user_id text NOT NULL,
          link_status text NOT NULL
        );
      `)
      const statements: string[] = []
      const result = await guardAdminLegacyGrantSwitchSet({
        async query(text: string, params?: unknown[]) {
          statements.push(text)
          const found = await client.query(text, (params ?? []) as never[])
          return { rows: found.rows, rowCount: found.rowCount }
        },
      }, {
        userIds: [`b2-native-${randomUUID()}`],
        actorId: 'b2-native-actor',
        enabled: false,
      })
      expect(result).toEqual({ grantIds: [] })
      expect(statements).toHaveLength(1)
      expect(statements[0]).toContain('integration.id::text AS id')
      expect(statements[0]).toContain('link.local_user_id::text AS user_id')
      expect(statements[0]).toContain('ORDER BY id, user_id')
      expect(statements[0]).not.toContain('ORDER BY integration.id')
      expect(statements[0]).not.toMatch(/revoke|FOR UPDATE|FOR SHARE/i)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('refuses a partial installation and does not treat that refusal as absence', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        );
        CREATE UNLOGGED TABLE directory_connection_login_scope (connection_id uuid);
        -- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
        CREATE TABLE subject_authorization_versions (
          subject_id text PRIMARY KEY,
          version bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE users (
          id text PRIMARY KEY,
          local_password_set boolean,
          is_active boolean,
          activation_status text,
          password_hash text,
          deleted_at timestamptz,
          purged_at timestamptz
        );
        CREATE TABLE user_external_auth_grants (
          provider text,
          local_user_id text,
          enabled boolean
        );
      `)
      await expect(noRemainingLoginMethod(callerFor(client), {
        userId: `b2-native-${randomUUID()}`,
        departedConnectionId: DEPARTED,
      })).rejects.toMatchObject({
        name: 'StrictLoginGrantError',
        code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED',
      })
      expect(StrictLoginGrantError).toBeTruthy()
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('reports no remaining method only after the installed reader returns', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    try {
      await installStrict(pool, schema)
      const client = await pool.connect()
      try {
        const remaining = await noRemainingLoginMethod(callerFor(client), {
          userId: `b2-absent-${randomUUID()}`,
          departedConnectionId: DEPARTED,
        })
        expect(remaining).toBe(true)
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  })

  it('keeps a usable local password as a remaining method before the reader', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const userId = `b2-password-${randomUUID()}`
    try {
      await installStrict(pool, schema)
      await pool.query(
        `INSERT INTO users (
           id, is_active, activation_status, local_password_set, password_hash, must_change_password
         ) VALUES ($1, true, 'activated', true, 'hash-not-unusable', false)`,
        [userId],
      )
      const statements: string[] = []
      const client = await pool.connect()
      try {
        const remaining = await noRemainingLoginMethod({
          async query(text: string, params?: unknown[]) {
            statements.push(text)
            const found = await client.query(text, (params ?? []) as never[])
            return { rows: found.rows, rowCount: found.rowCount }
          },
        }, { userId, departedConnectionId: DEPARTED })
        expect(remaining).toBe(false)
      } finally {
        client.release()
      }
      expect(statements.some((text) => text.includes('AS usable'))).toBe(true)
      expect(statements.some((text) => text.includes('current_schemas') || text.includes('kysely_migration'))).toBe(false)
    } finally {
      await pool.end()
    }
  })

  it('counts an eligible legacy grant on a non-strict sibling without locking it', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const userId = `b2-legacy-${randomUUID()}`
    const sibling = randomUUID()
    const accountId = randomUUID()
    try {
      await installStrict(pool, schema)
      await pool.query(
        `INSERT INTO directory_integrations (id, provider) VALUES ($1::uuid, 'dingtalk')`,
        [sibling],
      )
      await pool.query(
        `INSERT INTO directory_accounts (id, integration_id, provider, is_active)
         VALUES ($1::uuid, $2::uuid, 'dingtalk', true)`,
        [accountId, sibling],
      )
      await pool.query(
        `INSERT INTO directory_account_links (id, directory_account_id, local_user_id, link_status)
         VALUES ($1::uuid, $2::uuid, $3, 'linked')`,
        [randomUUID(), accountId, userId],
      )
      await pool.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
         VALUES ('dingtalk', $1, true, 'b2-native-actor')`,
        [userId],
      )
      const statements: string[] = []
      const client = await pool.connect()
      try {
        const remaining = await noRemainingLoginMethod({
          async query(text: string, params?: unknown[]) {
            statements.push(text)
            const found = await client.query(text, (params ?? []) as never[])
            return { rows: found.rows, rowCount: found.rowCount }
          },
        }, { userId, departedConnectionId: DEPARTED })
        expect(remaining).toBe(false)
      } finally {
        client.release()
      }
      const scopeRead = statements.find((text) => text.includes('LEFT JOIN'))
      expect(scopeRead).toBeTruthy()
      expect(scopeRead).not.toMatch(/FOR (?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)|LOCK TABLE/i)
    } finally {
      await pool.end()
    }
  })

  it('does not count a legacy link that exists only on the departed connection', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const userId = `b2-departed-${randomUUID()}`
    const accountId = randomUUID()
    try {
      await installStrict(pool, schema)
      await pool.query(
        `INSERT INTO directory_integrations (id, provider) VALUES ($1::uuid, 'dingtalk')`,
        [DEPARTED],
      )
      await pool.query(
        `INSERT INTO directory_accounts (id, integration_id, provider, is_active)
         VALUES ($1::uuid, $2::uuid, 'dingtalk', true)`,
        [accountId, DEPARTED],
      )
      await pool.query(
        `INSERT INTO directory_account_links (id, directory_account_id, local_user_id, link_status)
         VALUES ($1::uuid, $2::uuid, $3, 'linked')`,
        [randomUUID(), accountId, userId],
      )
      await pool.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
         VALUES ('dingtalk', $1, true, 'b2-native-actor')`,
        [userId],
      )
      const client = await pool.connect()
      try {
        await expect(noRemainingLoginMethod(callerFor(client), {
          userId,
          departedConnectionId: DEPARTED,
        })).resolves.toBe(true)
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  })

  it('finishes the plain sibling read while that integration is locked', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 2)
    const userId = `b2-lock-${randomUUID()}`
    const sibling = randomUUID()
    const accountId = randomUUID()
    let holder: PoolClient | undefined
    let reader: PoolClient | undefined
    try {
      await installStrict(pool, schema)
      await pool.query(
        `INSERT INTO directory_integrations (id, provider) VALUES ($1::uuid, 'dingtalk')`,
        [sibling],
      )
      await pool.query(
        `INSERT INTO directory_accounts (id, integration_id, provider, is_active)
         VALUES ($1::uuid, $2::uuid, 'dingtalk', true)`,
        [accountId, sibling],
      )
      await pool.query(
        `INSERT INTO directory_account_links (id, directory_account_id, local_user_id, link_status)
         VALUES ($1::uuid, $2::uuid, $3, 'linked')`,
        [randomUUID(), accountId, userId],
      )
      await pool.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
         VALUES ('dingtalk', $1, true, 'b2-native-actor')`,
        [userId],
      )
      holder = await pool.connect()
      reader = await pool.connect()
      await holder.query('BEGIN')
      await holder.query(
        'SELECT id FROM directory_integrations WHERE id = $1::uuid FOR UPDATE',
        [sibling],
      )
      await reader.query(`SET statement_timeout = '2s'`)
      await expect(noRemainingLoginMethod(callerFor(reader), {
        userId,
        departedConnectionId: DEPARTED,
      })).resolves.toBe(false)
    } finally {
      if (holder) {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      reader?.release()
      await pool.end()
    }
  })

  it('bounded compound-invalid joined row, not a single missing-scope control', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const userId = `b2-invalid-${randomUUID()}`
    const connectionId = randomUUID()
    const identityId = randomUUID()
    const evidenceId = `ev-${randomBytes(4).toString('hex')}`
    const witness = `wit-${randomBytes(4).toString('hex')}`
    const grantId = `slg.${hex64()}`
    let client: PoolClient | undefined
    try {
      await installStrict(pool, schema)
      client = await pool.connect()
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO users (
           id, is_active, activation_status, local_password_set, must_change_password, permissions, access_generation
         ) VALUES ($1, true, 'activated', false, false, '[]'::jsonb, 1)`,
        [userId],
      )
      await client.query(
        `INSERT INTO directory_integrations (id, org_id, provider, status, corp_id)
         VALUES ($1::uuid, 'org-invalid', 'dingtalk', 'active', 'corp-invalid')`,
        [connectionId],
      )
      await client.query(
        `INSERT INTO user_external_identities (
           id, provider, local_user_id, external_key, corp_id
         ) VALUES ($1::uuid, 'dingtalk', $2, 'ext-invalid', 'corp-invalid')`,
        [identityId, userId],
      )
      await client.query(
        `INSERT INTO user_external_identity_binding_pins (
           identity_id, binding_revision, provider, local_user_id, external_key, corp_id
         ) VALUES ($1::uuid, 7, 'dingtalk', $2, 'ext-invalid', 'corp-invalid')`,
        [identityId, userId],
      )
      await client.query(
        `INSERT INTO user_external_identity_evidence (
           id, evidence_witness, identity_id, live_identity_id, binding_revision, assurance,
           subject_key, app_scope, org_id, connection_id, capability_revision_seen,
           application_revision, material_fingerprint, slot_snapshot, revocation_generation
         ) VALUES (
           $1, $2, $3, $4::uuid, 7, 'self_authenticated',
           'corp-invalid:open', 'synthetic-app', 'org-invalid', $5::uuid, 4,
           '4', $6, '{}'::jsonb, 0
         )`,
        [evidenceId, witness, identityId, identityId, connectionId, FINGERPRINT],
      )
      await client.query(
        `INSERT INTO directory_connection_application_pins (connection_id, application_revision, material_fingerprint)
         VALUES ($1::uuid, '4', $2)`,
        [connectionId, FINGERPRINT],
      )
      await client.query(
        `INSERT INTO directory_integration_capabilities (
           integration_id, revision, login_enabled, login_bound_tenant, login_bound_app_scope, bound_provider, bound_org_id
         ) VALUES ($1::uuid, 4, true, 'corp-invalid', 'synthetic-app', 'dingtalk', 'org-invalid')`,
        [connectionId],
      )
      const proofId = randomUUID()
      const commandKey = hex64()
      await client.query('INSERT INTO security_action_challenges (id) VALUES ($1::uuid)', [proofId])
      await client.query(
        `INSERT INTO admin_login_grant_command_receipts (
           command_key, purpose, actor_id, org_id, command_id, intent_digest, canonical_intent,
           result, proof_id, target_count, outcome
         ) VALUES ($1, 'admin_login_grant_enable', $2, 'org-invalid', 'cmd-invalid', $3, '{}', '{"ok":true}'::jsonb, $4::uuid, 1, 'enabled')`,
        [commandKey, userId, hex64(), proofId],
      )
      await client.query(
        `INSERT INTO user_external_identity_login_grants (
           id, command_key, target_ordinal, command_id, evidence_id, evidence_witness, identity_id, live_identity_id,
           local_user_id, connection_id, binding_revision, binding_revision_text, application_revision,
           access_generation_text, org_id, privilege_witness, assurance, grant_method, enabled, granted_by, revocation_generation
         ) VALUES (
           $1, $2, 1, 'cmd-invalid', $3, $4, $5, $6::uuid,
           $7, $8::uuid, 7, '7', '4',
           '1', 'org-invalid', $9, 'self_authenticated', 'admin_explicit', true, $7, 0
         )`,
        [grantId, commandKey, evidenceId, witness, identityId, identityId, userId, connectionId, FINGERPRINT],
      )
      await expect(noRemainingLoginMethod(callerFor(client), {
        userId,
        departedConnectionId: DEPARTED,
      })).resolves.toBe(true)
      const still = await client.query(
        'SELECT enabled, revoked_at FROM user_external_identity_login_grants WHERE id = $1',
        [grantId],
      )
      expect(still.rows[0]).toMatchObject({ enabled: true, revoked_at: null })
    } finally {
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await pool.end()
    }
  })

  it('bounded uncommitted candidate selection, not a committed sibling grant', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    const userA = `b2-user-a-${randomBytes(3).toString('hex')}`
    const userB = `b2-user-b-${randomBytes(3).toString('hex')}`
    const connectionC = randomUUID()
    const connectionD = randomUUID()
    const runId = randomUUID()
    const orgId = 'org-preserve'
    let client: PoolClient | undefined
    try {
      await installStrict(pool, schema)
      client = await pool.connect()
      delete process.env[CREDENTIAL_REVOCATION_FLAG]
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO users (
           id, is_active, activation_status, local_password_set, password_hash, must_change_password
         ) VALUES ($1, true, 'activated', true, 'hash-not-unusable', false),
                  ($2, true, 'activated', true, 'hash-not-unusable', false)`,
        [userA, userB],
      )
      for (const connectionId of [connectionC, connectionD]) {
        await client.query(
          `INSERT INTO directory_integrations (id, org_id, provider, status, corp_id)
           VALUES ($1::uuid, $2, 'dingtalk', 'active', $3)`,
          [connectionId, orgId, `corp-${connectionId.slice(0, 8)}`],
        )
      }
      await client.query('INSERT INTO directory_sync_runs (id) VALUES ($1::uuid)', [runId])
      await insertConnectionLoginScope(callerFor(client), {
        connectionId: connectionC,
        commandId: `scope-${randomBytes(4).toString('hex')}`,
      })
      const inserted = async (userId: string, connectionId: string) => {
        const identityId = randomUUID()
        const evidenceId = `ev-${randomBytes(4).toString('hex')}`
        const witness = `wit-${randomBytes(4).toString('hex')}`
        const grantId = `slg.${hex64()}`
        const proofId = randomUUID()
        const commandKey = hex64()
        await client.query(
          `INSERT INTO user_external_identities (id, provider, local_user_id, external_key, corp_id)
           VALUES ($1::uuid, 'dingtalk', $2, $3, 'corp-preserve')`,
          [identityId, userId, `ext-${identityId.slice(0, 8)}`],
        )
        await client.query(
          `INSERT INTO user_external_identity_evidence (
             id, evidence_witness, identity_id, live_identity_id, binding_revision, assurance,
             subject_key, app_scope, org_id, connection_id, capability_revision_seen,
             application_revision, material_fingerprint, slot_snapshot, revocation_generation
           ) VALUES (
             $1, $2, $3, $4::uuid, 7, 'self_authenticated',
             'subject', 'synthetic-app', $5, $6::uuid, 4,
             '4', $7, '{}'::jsonb, 0
           )`,
          [evidenceId, witness, identityId, identityId, orgId, connectionId, FINGERPRINT],
        )
        await client.query('INSERT INTO security_action_challenges (id) VALUES ($1::uuid)', [proofId])
        await client.query(
          `INSERT INTO admin_login_grant_command_receipts (
             command_key, purpose, actor_id, org_id, command_id, intent_digest, canonical_intent,
             result, proof_id, target_count, outcome
           ) VALUES ($1, 'admin_login_grant_enable', 'b2-native-actor', $2, $3, $4, '{}', '{"ok":true}'::jsonb, $5::uuid, 1, 'enabled')`,
          [commandKey, orgId, `cmd-${grantId.slice(4, 12)}`, hex64(), proofId],
        )
        await client.query(
          `INSERT INTO user_external_identity_login_grants (
             id, command_key, target_ordinal, command_id, evidence_id, evidence_witness, identity_id, live_identity_id,
             local_user_id, connection_id, binding_revision, binding_revision_text, application_revision,
             access_generation_text, org_id, privilege_witness, assurance, grant_method, enabled, granted_by, revocation_generation
           ) VALUES (
             $1, $2, 1, $3, $4, $5, $6, $7::uuid,
             $8, $9::uuid, 7, '7', '4',
             '1', $10, $11, 'self_authenticated', 'admin_explicit', true, 'b2-native-actor', 0
           )`,
          [grantId, commandKey, `cmd-${grantId.slice(4, 12)}`, evidenceId, witness, identityId, identityId, userId, connectionId, orgId, FINGERPRINT],
        )
        const context = {
          v: 1,
          provider: 'dingtalk',
          assurance: 'self_authenticated',
          scopeAsserted: false,
          policyRevision: 1,
          connectionId,
          identityId,
          grantId,
          evidenceId,
          orgId,
          subjectAppScope: 'synthetic-app',
          subjectKey: 'subject',
          bindingRevision: '7',
          applicationRevision: '4',
          accessGeneration: '1',
          capRev: '4',
        }
        await client.query(
          `INSERT INTO user_sessions (id, user_id, expires_at, external_auth_context)
           VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour', $3::jsonb)`,
          [`xs.${randomUUID()}`, userId, JSON.stringify(context)],
        )
        return grantId
      }
      const grantAC = await inserted(userA, connectionC)
      const grantAD = await inserted(userA, connectionD)
      const grantBC = await inserted(userB, connectionC)
      await client.query(
        `INSERT INTO user_sessions (id, user_id, expires_at)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour'),
                ($3, $4, pg_catalog.clock_timestamp() + interval '1 hour')`,
        [`ord-${randomUUID()}`, userA, `ord-${randomUUID()}`, userB],
      )
      await client.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
         VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), 'fixture', 'fixture'),
                ($2, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), 'fixture', 'fixture')`,
        [userA, userB],
      )
      await client.query('SAVEPOINT before_revoke')
      const finished = await finishDeprovisionCredentials(callerFor(client), {
        userId: userA,
        actorId: 'b2-native-actor',
        connectionId: connectionC,
        runId,
        eventId: null,
        accountId: 'account-a',
        orgId,
        user: false,
        departAll: false,
        clear: false,
        grant: false,
      })
      expect(finished.grantIds).toEqual([grantAC])
      expect(finished.legs).toEqual({ sessions: false, tokens: false })
      const grants = await client.query(
        `SELECT id, enabled, revoked_reason, revoked_event_id::text AS revoked_event_id,
                revoked_run_id::text AS revoked_run_id, revoked_account_id
           FROM user_external_identity_login_grants
          ORDER BY id`,
      )
      const byId = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byId.get(grantAC)).toMatchObject({
        enabled: false,
        revoked_reason: 'deprovision',
        revoked_event_id: null,
        revoked_run_id: runId,
        revoked_account_id: 'account-a',
      })
      expect(byId.get(grantAD)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_run_id: null,
      })
      expect(byId.get(grantBC)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_run_id: null,
      })
      const sessions = await client.query(
        `SELECT user_id, revoked_at IS NOT NULL AS revoked,
                external_auth_context->>'grantId' AS grant_id
           FROM user_sessions
          ORDER BY id`,
      )
      const exact = sessions.rows.filter((row) => String(row.grant_id ?? '') !== '')
      expect(exact).toEqual(expect.arrayContaining([
        expect.objectContaining({ grant_id: grantAC, revoked: true }),
        expect.objectContaining({ grant_id: grantAD, revoked: false }),
        expect.objectContaining({ grant_id: grantBC, revoked: false }),
      ]))
      expect(sessions.rows.filter((row) => row.grant_id == null).every((row) => row.revoked === false)).toBe(true)
      const marks = await client.query(
        'SELECT user_id, reason FROM user_session_revocations ORDER BY user_id',
      )
      expect(marks.rows).toEqual([
        { user_id: userA, reason: STRICT_GRANT_SESSION_REVOCATION_REASON },
        { user_id: userB, reason: 'fixture' },
      ])
      expect(await client.query('SELECT count(*)::int AS count FROM directory_deprovision_events')).toMatchObject({
        rows: [{ count: 0 }],
      })
      await client.query('ROLLBACK TO SAVEPOINT before_revoke')
      const restored = await client.query(
        'SELECT enabled, revoked_at FROM user_external_identity_login_grants WHERE id = $1',
        [grantAC],
      )
      expect(restored.rows[0]).toMatchObject({ enabled: true, revoked_at: null })
    } finally {
      if (previousFlag === undefined) delete process.env[CREDENTIAL_REVOCATION_FLAG]
      else process.env[CREDENTIAL_REVOCATION_FLAG] = previousFlag
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await pool.end()
    }
  })

  it('detaches evidence without deleting the identity, and rollback restores the live pin', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const identityId = randomUUID()
    const evidenceId = `ev-${randomBytes(4).toString('hex')}`
    try {
      await installStrict(pool, schema)
      await pool.query(
        `INSERT INTO user_external_identities (id, provider, local_user_id)
         VALUES ($1::uuid, 'dingtalk', 'b2-delete-user')`,
        [identityId],
      )
      await pool.query(
        `INSERT INTO user_external_identity_evidence (
           id, identity_id, live_identity_id, revocation_generation
         ) VALUES ($1, $2, $3::uuid, 0)`,
        [evidenceId, identityId, identityId],
      )
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const removed = await completeIdentityDeletion(callerFor(client), {
          userId: 'b2-delete-user',
          identityIds: [identityId],
          actorId: 'b2-native-actor',
          reason: 'admin_unbind',
        })
        expect(removed).toEqual({ grantIds: [] })
        const open = await client.query(
          `SELECT live_identity_id::text AS live_identity_id, revocation_generation
             FROM user_external_identity_evidence WHERE id = $1`,
          [evidenceId],
        )
        expect(open.rows[0]).toMatchObject({ live_identity_id: null, revocation_generation: '1' })
        const identity = await client.query(
          'SELECT id::text AS id FROM user_external_identities WHERE id = $1::uuid',
          [identityId],
        )
        expect(identity.rows).toHaveLength(1)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
      const restored = await pool.query(
        `SELECT live_identity_id::text AS live_identity_id, revocation_generation
           FROM user_external_identity_evidence WHERE id = $1`,
        [evidenceId],
      )
      expect(restored.rows[0]).toMatchObject({
        live_identity_id: identityId,
        revocation_generation: '0',
      })
    } finally {
      await pool.end()
    }
  })

  it('returns an empty deletion when no identity id is supplied', async () => {
    const client = {
      async query() {
        throw new Error('empty identity deletion must not query')
      },
    }
    await expect(completeIdentityDeletion(client, {
      userId: 'b2-empty',
      identityIds: [],
      actorId: 'b2-native-actor',
      reason: 'admin_unbind',
    })).resolves.toEqual({ grantIds: [] })
  })

  it('does not detach on a never-installed database', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 1)
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        )
      `)
      const statements: string[] = []
      const result = await completeIdentityDeletion({
        async query(text: string, params?: unknown[]) {
          statements.push(text)
          const found = await client.query(text, (params ?? []) as never[])
          return { rows: found.rows, rowCount: found.rowCount }
        },
      }, {
        userId: 'b2-never',
        identityIds: [randomUUID()],
        actorId: 'b2-native-actor',
        reason: 'recycle_purge',
      })
      expect(result).toEqual({ grantIds: [] })
      expect(statements.some((text) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(text))).toBe(false)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('returns invalid when validation loses the unrevoked token row', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 2)
    const plain = `mst_${randomBytes(16).toString('hex')}`
    const tokenId = randomBytes(16).toString('hex')
    const userId = `b2-token-${randomBytes(3).toString('hex')}`
    let holder: PoolClient | undefined
    let pending: Promise<unknown> | undefined
    let asserted = false
    let primary: unknown
    try {
      await pool.query(`
        -- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
        CREATE TABLE subject_authorization_versions (
          subject_id text PRIMARY KEY,
          version bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE users (
          id text PRIMARY KEY,
          is_active boolean,
          role text,
          activation_status text,
          local_password_set boolean,
          deleted_at timestamptz,
          purged_at timestamptz
        );
        CREATE TABLE multitable_api_tokens (
          id text PRIMARY KEY,
          name text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          token_prefix text NOT NULL,
          scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz,
          expires_at timestamptz,
          revoked boolean NOT NULL DEFAULT false,
          revoked_at timestamptz,
          base_ids text[],
          sheet_ids text[]
        );
      `)
      await pool.query(
        `INSERT INTO users (id, is_active, role, activation_status, local_password_set)
         VALUES ($1, true, 'user', 'activated', true)`,
        [userId],
      )
      await pool.query(
        `INSERT INTO multitable_api_tokens (
           id, name, token_hash, token_prefix, scopes, created_by
         ) VALUES ($1, 'fixture', $2, $3, '[]'::jsonb, $4)`,
        [tokenId, createHash('sha256').update(plain).digest('hex'), plain.slice(0, 8), userId],
      )
      const service = new ApiTokenService(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }))
      holder = await pool.connect()
      await holder.query('BEGIN')
      const pid = await holder.query(`SELECT pg_catalog.pg_backend_pid()::int AS pid`)
      const holderPid = pid.rows[0]?.pid
      if (typeof holderPid !== 'number') throw new Error('B2_TOKEN_HOLDER_PID_UNREADABLE')
      await holder.query('SELECT id FROM multitable_api_tokens WHERE id = $1 FOR UPDATE', [tokenId])
      pending = service.validateToken(plain)
      await waitForTokenUpdateWaiter(holder, holderPid)
      await holder.query(
        `UPDATE multitable_api_tokens SET revoked = true, revoked_at = pg_catalog.clock_timestamp() WHERE id = $1`,
        [tokenId],
      )
      await holder.query('COMMIT')
      await expect(pending).resolves.toEqual({ valid: false, reason: 'Token has been revoked' })
      asserted = true
    } catch (error) {
      primary = error
    } finally {
      const raced = pending
      if (holder) {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      if (raced) {
        try {
          await raced
        } catch (error) {
          if (primary === undefined && !asserted) primary = error
        }
      }
      try {
        await pool.end()
      } catch (error) {
        if (primary === undefined) primary = error
      }
    }
    if (primary !== undefined) throw primary
  })

  it('refuses a concurrent token revoke that updates zero unrevoked rows', async () => {
    const schema = await createSchema()
    const pool = poolFor(schema, 2)
    const tokenId = randomBytes(16).toString('hex')
    const userId = `b2-revoke-${randomBytes(3).toString('hex')}`
    let holder: PoolClient | undefined
    let pending: Promise<unknown> | undefined
    let asserted = false
    let primary: unknown
    try {
      await pool.query(`
        -- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
        CREATE TABLE subject_authorization_versions (
          subject_id text PRIMARY KEY,
          version bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE users (
          id text PRIMARY KEY,
          is_active boolean,
          role text,
          activation_status text,
          local_password_set boolean
        );
        CREATE TABLE multitable_api_tokens (
          id text PRIMARY KEY,
          name text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          token_prefix text NOT NULL,
          scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          last_used_at timestamptz,
          expires_at timestamptz,
          revoked boolean NOT NULL DEFAULT false,
          revoked_at timestamptz,
          base_ids text[],
          sheet_ids text[]
        );
      `)
      await pool.query(
        `INSERT INTO users (id, is_active, role, activation_status, local_password_set)
         VALUES ($1, true, 'user', 'activated', true)`,
        [userId],
      )
      await pool.query(
        `INSERT INTO multitable_api_tokens (
           id, name, token_hash, token_prefix, scopes, created_by
         ) VALUES ($1, 'fixture', $2, 'mst_fix', '[]'::jsonb, $3)`,
        [tokenId, hex64(), userId],
      )
      const service = new ApiTokenService(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }))
      holder = await pool.connect()
      await holder.query('BEGIN')
      const pid = await holder.query(`SELECT pg_catalog.pg_backend_pid()::int AS pid`)
      const holderPid = pid.rows[0]?.pid
      if (typeof holderPid !== 'number') throw new Error('B2_TOKEN_HOLDER_PID_UNREADABLE')
      await holder.query('SELECT id FROM multitable_api_tokens WHERE id = $1 FOR UPDATE', [tokenId])
      pending = service.revokeToken(tokenId, userId)
      await waitForTokenUpdateWaiter(holder, holderPid)
      await holder.query(
        `UPDATE multitable_api_tokens SET revoked = true, revoked_at = pg_catalog.clock_timestamp() WHERE id = $1`,
        [tokenId],
      )
      await holder.query('COMMIT')
      await expect(pending).rejects.toMatchObject({
        code: 'API_TOKEN_REVOKED_CONCURRENTLY',
        statusCode: 401,
      })
      asserted = true
    } catch (error) {
      primary = error
    } finally {
      const raced = pending
      if (holder) {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      if (raced) {
        try {
          await raced
        } catch (error) {
          if (primary === undefined && !asserted) primary = error
        }
      }
      try {
        await pool.end()
      } catch (error) {
        if (primary === undefined) primary = error
      }
    }
    if (primary !== undefined) throw primary
  })

  it('counts a committed command grant only after its scope row and preserves the sibling connection', async () => {
    const published = await loadPublishedCommandChain()
    const schema = await createSchema()
    // Scratch fixture pool only. Install and seed use pool.query before the
    // reader client is checked out. The process pool used by the command is
    // aimed and released separately. This does not raise the max=1 or max=2 cases.
    const pool = poolFor(schema, 10)
    const suffix = randomBytes(3).toString('hex')
    const orgId = `org-${suffix}`
    const userA = `b2-live-a-${suffix}`
    const userB = `b2-live-b-${suffix}`
    const connectionC = randomUUID()
    const connectionD = randomUUID()
    const runId = randomUUID()
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let client: PoolClient | undefined
    try {
      await installPublishedParents(pool, schema)
      await aimPublishedPool(published.nativePool, schema)
      const departed = await issuePublishedConnection(published, pool, {
        orgId,
        connectionId: connectionC,
        corpId: `corp-c-${suffix}`,
        commandId: `live-c-${suffix}`,
        targets: [
          { userId: userA, openId: `open-a-${suffix}` },
          { userId: userB, openId: `open-b-${suffix}` },
        ],
        existingUserIds: new Set<string>(),
      })
      const sibling = await issuePublishedConnection(published, pool, {
        orgId,
        connectionId: connectionD,
        corpId: `corp-d-${suffix}`,
        commandId: `live-d-${suffix}`,
        targets: [{ userId: userA, openId: `open-ad-${suffix}` }],
        existingUserIds: new Set([userA]),
      })
      const grantAC = departed.grants.find((grant) => grant.userId === userA)?.grantId
      const grantBC = departed.grants.find((grant) => grant.userId === userB)?.grantId
      const grantAD = sibling.grants.find((grant) => grant.userId === userA)?.grantId
      if (!grantAC || !grantBC || !grantAD) throw new Error('B2_PUBLISHED_CHAIN_GRANT_ID_ABSENT')
      const stored = await pool.query(
        `SELECT id FROM user_external_identity_login_grants WHERE id = ANY($1::text[])`,
        [[grantAC, grantAD, grantBC]],
      )
      expect(stored.rows).toHaveLength(3)
      await pool.query(
        `UPDATE users SET password_hash = 'unusable:reader' WHERE id = ANY($1::text[])`,
        [[userA, userB]],
      )
      await pool.query('INSERT INTO directory_sync_runs (id) VALUES ($1::uuid)', [runId])
      client = await pool.connect()
      const eligibility = await client.query(
        `SELECT identity.provider_open_id,
                integration.config->>'appKey' AS app_key,
                membership.user_id AS member_id
           FROM user_external_identity_login_grants grant_row
           JOIN user_external_identities identity ON identity.id::text = grant_row.identity_id
           JOIN directory_integrations integration ON integration.id = grant_row.connection_id
           JOIN user_orgs membership
             ON membership.user_id = grant_row.local_user_id
            AND membership.org_id = grant_row.org_id
            AND membership.is_active = true
          WHERE grant_row.id = ANY($1::text[])`,
        [[grantAC, grantAD, grantBC]],
      )
      expect(eligibility.rows).toHaveLength(3)
      expect(eligibility.rows.every((row) => typeof row.provider_open_id === 'string' && row.provider_open_id.length > 0)).toBe(true)
      expect(eligibility.rows.every((row) => row.app_key === PUBLISHED_MATERIAL.appKey)).toBe(true)
      expect(eligibility.rows.every((row) => typeof row.member_id === 'string')).toBe(true)
      const scopeBefore = await client.query('SELECT count(*)::int AS count FROM directory_connection_login_scope')
      expect(scopeBefore.rows[0]).toMatchObject({ count: 0 })
      await expect(noRemainingLoginMethod(callerFor(client), { userId: userB })).resolves.toBe(true)
      await expect(noRemainingLoginMethod(callerFor(client), { userId: userA })).resolves.toBe(true)
      delete process.env[CREDENTIAL_REVOCATION_FLAG]
      await client.query('BEGIN')
      await insertConnectionLoginScope(callerFor(client), {
        connectionId: connectionC,
        commandId: `scope-c-${suffix}`,
      })
      await insertConnectionLoginScope(callerFor(client), {
        connectionId: connectionD,
        commandId: `scope-d-${suffix}`,
      })
      await expect(noRemainingLoginMethod(callerFor(client), { userId: userB })).resolves.toBe(false)
      await expect(noRemainingLoginMethod(callerFor(client), { userId: userA })).resolves.toBe(false)
      await expect(noRemainingLoginMethod(callerFor(client), {
        userId: userA,
        departedConnectionId: connectionC,
      })).resolves.toBe(false)
      const finished = await finishDeprovisionCredentials(callerFor(client), {
        userId: userA,
        actorId: 'b2-native-actor',
        connectionId: connectionC,
        runId,
        eventId: null,
        accountId: 'account-live',
        orgId,
        user: false,
        departAll: false,
        clear: false,
        grant: false,
      })
      expect(finished.grantIds).toEqual([grantAC])
      expect(finished.legs).toEqual({ sessions: false, tokens: false })
      const grants = await client.query(
        `SELECT id, enabled, revoked_reason, revoked_run_id::text AS revoked_run_id
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[grantAC, grantAD, grantBC]],
      )
      const byId = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byId.get(grantAC)).toMatchObject({
        enabled: false,
        revoked_reason: 'deprovision',
        revoked_run_id: runId,
      })
      expect(byId.get(grantAD)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_run_id: null,
      })
      expect(byId.get(grantBC)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_run_id: null,
      })
      await client.query('COMMIT')
    } finally {
      if (previousFlag === undefined) delete process.env[CREDENTIAL_REVOCATION_FLAG]
      else process.env[CREDENTIAL_REVOCATION_FLAG] = previousFlag
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releasePublishedPool(published.nativePool).catch(() => undefined)
      await pool.end()
    }
  })

  it('ledger: strict-only effects stay empty and the departed grant keeps run provenance', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    let client: PoolClient | undefined
    try {
      pair = await openPublishedPair('strict')
      await installNativeCallerTables(pair.pool)
      const seeded = await seedStrictOnlyLedger(pair)
      delete process.env[CREDENTIAL_REVOCATION_FLAG]
      client = await pair.pool.connect()
      await client.query('BEGIN')
      const result = await applyDirectoryDeprovisionCandidate(
        callerSurface(client),
        ledgerCandidate(pair, seeded.departedAccountId, seeded.runId),
      )
      expect(result.plan.effects).toEqual([])
      expect(result.plan.skipReason).toBe('zero_effect')
      expect(result.applied).toBe(false)
      expect(result.eventId).toBeNull()
      expect(result.skipReason).toBeNull()
      expect(result.globallyClear).toBe(false)
      expect(result.accessGeneration).toBe(1)
      expect(result.strictDeprovision).toEqual({
        eligible: true,
        applied: true,
        unrevokedGrantIds: [],
        revokedGrantIds: [pair.userA.grantId],
        provenance: { runId: seeded.runId, eventId: null },
      })
      const grants = await client.query(
        `SELECT id, enabled, revoked_reason, revoked_event_id::text AS revoked_event_id,
                revoked_run_id::text AS revoked_run_id
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      const byGrant = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byGrant.get(pair.userA.grantId)).toMatchObject({
        enabled: false,
        revoked_reason: 'deprovision',
        revoked_event_id: null,
        revoked_run_id: seeded.runId,
      })
      expect(byGrant.get(pair.userB.grantId)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_event_id: null,
        revoked_run_id: null,
      })
      const conserved = await client.query(
        `SELECT user_row.id AS user_id,
                user_row.is_active AS user_active,
                user_row.access_generation::text AS generation,
                membership.is_active AS member_active,
                watermark.reason
           FROM users user_row
           JOIN user_orgs membership
             ON membership.user_id = user_row.id
            AND membership.org_id = $2
           JOIN user_session_revocations watermark ON watermark.user_id = user_row.id
          WHERE user_row.id = ANY($1::text[])
          ORDER BY user_row.id`,
        [[pair.userA.userId, pair.userB.userId], pair.orgId],
      )
      expect(conserved.rows).toEqual([
        {
          user_id: pair.userA.userId,
          user_active: true,
          generation: '1',
          member_active: true,
          reason: 'fixture',
        },
        {
          user_id: pair.userB.userId,
          user_active: true,
          generation: '1',
          member_active: true,
          reason: 'fixture',
        },
      ].sort((left, right) => left.user_id < right.user_id ? -1 : 1))
      const legacy = await client.query(
        `SELECT enabled, granted_by
           FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [pair.userA.userId],
      )
      expect(legacy.rows).toEqual([{ enabled: false, granted_by: 'fixture' }])
      const links = await client.query(
        `SELECT account.id::text AS id, account.is_active, link.link_status, link.local_user_id
           FROM directory_accounts account
           JOIN directory_account_links link ON link.directory_account_id = account.id
          WHERE account.id = ANY($1::uuid[])`,
        [[seeded.departedAccountId, seeded.siblingAccountId]],
      )
      const byAccount = new Map(links.rows.map((row) => [String(row.id), row]))
      expect(byAccount.get(seeded.departedAccountId)).toMatchObject({
        is_active: false,
        link_status: 'linked',
        local_user_id: pair.userA.userId,
      })
      expect(byAccount.get(seeded.siblingAccountId)).toMatchObject({
        is_active: true,
        link_status: 'linked',
        local_user_id: pair.userA.userId,
      })
      const events = await client.query('SELECT count(*)::int AS count FROM directory_deprovision_events')
      expect(events.rows[0]).toMatchObject({ count: 0 })
      await client.query('COMMIT')
    } finally {
      restoreCredentialFlag(previousFlag)
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releaseNativePair(pair)
    }
  })

  it('ledger: combined legacy and membership effects bind the emitted event', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    let client: PoolClient | undefined
    try {
      pair = await openPublishedPair('combined')
      await installNativeCallerTables(pair.pool)
      await installCombinedDeprovisionLedger(pair.pool)
      const accountId = randomUUID()
      const runId = randomUUID()
      await insertLinkedAccount(pair.pool, {
        accountId,
        connectionId: pair.connectionId,
        corpId: pair.corpId,
        userId: pair.userA.userId,
        openId: pair.userA.openId,
        externalKey: pair.userA.externalKey,
        active: false,
      })
      await pair.pool.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
         VALUES ('dingtalk', $1, true, 'fixture')`,
        [pair.userA.userId],
      )
      await commitConnectionScope(pair.pool, pair.connectionId, `scope-${pair.userA.userId}`)
      // Hardened sync events reject a run whose integration_id is not the event connection.
      await pair.pool.query(
        `INSERT INTO directory_sync_runs (id, integration_id) VALUES ($1::uuid, $2::uuid)`,
        [runId, pair.connectionId],
      )
      delete process.env[CREDENTIAL_REVOCATION_FLAG]
      client = await pair.pool.connect()
      await client.query('BEGIN')
      const result = await applyDirectoryDeprovisionCandidate(
        callerSurface(client),
        ledgerCandidate(pair, accountId, runId),
      )
      expect(result.applied).toBe(true)
      expect(result.skipReason).toBeNull()
      expect(result.globallyClear).toBe(true)
      expect(result.accessGeneration).toBe(2)
      expect(typeof result.eventId).toBe('string')
      expect(result.plan.skipReason).toBeNull()
      expect(result.plan.effects).toEqual([
        {
          type: 'membership_changed',
          orgId: pair.orgId,
          beforeActive: true,
          afterActive: false,
        },
        {
          type: 'grant_changed',
          orgId: null,
          beforeActive: true,
          afterActive: false,
          provider: 'dingtalk',
        },
      ])
      expect(result.strictDeprovision).toEqual({
        eligible: true,
        applied: true,
        unrevokedGrantIds: [],
        revokedGrantIds: [pair.userA.grantId],
        provenance: { runId, eventId: result.eventId },
      })
      const event = await client.query(
        `SELECT id::text AS id, run_id::text AS run_id, local_user_id, policy,
                globally_clear, status, integration_id::text AS integration_id,
                access_generation_at_apply::text AS generation
           FROM directory_deprovision_events
          WHERE id = $1::uuid`,
        [result.eventId],
      )
      expect(event.rows).toEqual([{
        id: result.eventId,
        run_id: runId,
        local_user_id: pair.userA.userId,
        policy: 'disable_grant_only',
        globally_clear: true,
        status: 'applied',
        integration_id: pair.connectionId,
        generation: '2',
      }])
      const effects = await client.query(
        `SELECT effect_type, before_active, after_active, org_id, grant_row_created
           FROM directory_deprovision_effects
          WHERE event_id = $1::uuid
          ORDER BY effect_type`,
        [result.eventId],
      )
      expect(effects.rows).toEqual([
        {
          effect_type: 'grant_changed',
          before_active: true,
          after_active: false,
          org_id: null,
          grant_row_created: false,
        },
        {
          effect_type: 'membership_changed',
          before_active: true,
          after_active: false,
          org_id: pair.orgId,
          grant_row_created: false,
        },
      ])
      const grants = await client.query(
        `SELECT id, enabled, revoked_reason,
                revoked_event_id::text AS revoked_event_id,
                revoked_run_id::text AS revoked_run_id
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      const byGrant = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byGrant.get(pair.userA.grantId)).toMatchObject({
        enabled: false,
        revoked_reason: 'deprovision',
        revoked_event_id: result.eventId,
        revoked_run_id: runId,
      })
      expect(byGrant.get(pair.userB.grantId)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        revoked_run_id: null,
      })
      const legacy = await client.query(
        `SELECT enabled, granted_by
           FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [pair.userA.userId],
      )
      expect(legacy.rows).toEqual([{
        enabled: false,
        granted_by: 'system:directory-deprovision',
      }])
      const users = await client.query(
        `SELECT user_row.id AS user_id,
                user_row.is_active AS user_active,
                user_row.access_generation::text AS generation,
                membership.is_active AS member_active,
                watermark.reason
           FROM users user_row
           JOIN user_orgs membership
             ON membership.user_id = user_row.id
            AND membership.org_id = $2
           JOIN user_session_revocations watermark ON watermark.user_id = user_row.id
          WHERE user_row.id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId], pair.orgId],
      )
      const byUser = new Map(users.rows.map((row) => [String(row.user_id), row]))
      expect(byUser.get(pair.userA.userId)).toMatchObject({
        user_active: true,
        generation: '2',
        member_active: false,
        reason: 'fixture',
      })
      expect(byUser.get(pair.userB.userId)).toMatchObject({
        user_active: true,
        generation: '1',
        member_active: true,
        reason: 'fixture',
      })
      const run = await client.query(
        `SELECT integration_id::text AS integration_id
           FROM directory_sync_runs
          WHERE id = $1::uuid`,
        [runId],
      )
      expect(run.rows).toEqual([{ integration_id: pair.connectionId }])
      await client.query('COMMIT')
    } finally {
      restoreCredentialFlag(previousFlag)
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releaseNativePair(pair)
    }
  })

  it('ledger: remaining-method read failure after revoke rolls the whole transaction back', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    let client: PoolClient | undefined
    try {
      pair = await openPublishedPair('readfault')
      await installNativeCallerTables(pair.pool)
      const seeded = await seedStrictOnlyLedger(pair)
      // The live sibling makes CLEAR false; only the strict revoke changed anything.
      // With broad legs enabled, their decision therefore requires the remaining-method read.
      process.env[CREDENTIAL_REVOCATION_FLAG] = 'true'
      client = await pair.pool.connect()
      await client.query('BEGIN')
      let thrown: unknown
      try {
        await applyDirectoryDeprovisionCandidate(
          failReadAfterGrantRevoke(client),
          ledgerCandidate(pair, seeded.departedAccountId, seeded.runId),
        )
      } catch (error) {
        thrown = error
      }
      await client.query('ROLLBACK')
      expect(thrown).toMatchObject({ code: '42703' })
      expect(thrown instanceof Error ? thrown.message : '').toContain('password_hash')
      const column = await client.query(
        `SELECT count(*)::int AS count
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name = 'password_hash'`,
      )
      expect(column.rows[0]).toMatchObject({ count: 1 })
      const grants = await client.query(
        `SELECT id, enabled, revocation_generation::text AS generation,
                revoked_at IS NULL AS open_grant,
                revoked_event_id::text AS revoked_event_id,
                revoked_run_id::text AS revoked_run_id
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      const byGrant = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byGrant.get(pair.userA.grantId)).toMatchObject({
        enabled: true,
        generation: '0',
        open_grant: true,
        revoked_event_id: null,
        revoked_run_id: null,
      })
      expect(byGrant.get(pair.userB.grantId)).toMatchObject({
        enabled: true,
        generation: '0',
        open_grant: true,
      })
      const users = await client.query(
        `SELECT id, password_hash, is_active, access_generation::text AS generation
           FROM users
          WHERE id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      expect(users.rows).toHaveLength(2)
      expect(users.rows.every((row) => row.password_hash === 'unusable:reader' && row.is_active === true && row.generation === '1')).toBe(true)
      const membership = await client.query(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [pair.userA.userId, pair.orgId],
      )
      expect(membership.rows).toEqual([{ is_active: true }])
      const legacy = await client.query(
        `SELECT enabled, granted_by
           FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [pair.userA.userId],
      )
      expect(legacy.rows).toEqual([{ enabled: false, granted_by: 'fixture' }])
      const sibling = await client.query(
        `SELECT account.is_active, link.link_status
           FROM directory_accounts account
           JOIN directory_account_links link ON link.directory_account_id = account.id
          WHERE account.id = $1::uuid`,
        [seeded.siblingAccountId],
      )
      expect(sibling.rows).toEqual([{ is_active: true, link_status: 'linked' }])
      const events = await client.query('SELECT count(*)::int AS count FROM directory_deprovision_events')
      expect(events.rows[0]).toMatchObject({ count: 0 })
      const scope = await client.query('SELECT count(*)::int AS count FROM directory_connection_login_scope')
      expect(scope.rows[0]).toMatchObject({ count: 1 })
      const watermark = await client.query(
        `SELECT reason FROM user_session_revocations WHERE user_id = $1`,
        [pair.userA.userId],
      )
      expect(watermark.rows).toEqual([{ reason: 'fixture' }])
    } finally {
      restoreCredentialFlag(previousFlag)
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releaseNativePair(pair)
    }
  })

  it('unbind: disabled unrevoked grant detaches before identity delete and flag-on legs revoke sessions and tokens', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    try {
      pair = await openPublishedPair('unbind')
      const directory = await import('../../src/directory/directory-sync')
      await installNativeCallerTables(pair.pool)
      await installSupersedeTargets(pair.pool)
      const accountId = randomUUID()
      await insertLinkedAccount(pair.pool, {
        accountId,
        connectionId: pair.connectionId,
        corpId: pair.corpId,
        userId: pair.userA.userId,
        openId: pair.userA.openId,
        externalKey: pair.userA.externalKey,
        active: true,
      })
      const disabled = await pair.pool.query(
        `UPDATE user_external_identity_login_grants
            SET enabled = FALSE,
                disabled_by = 'b2-native-actor'
          WHERE id = $1
            AND enabled = TRUE
            AND revoked_at IS NULL
          RETURNING id, disabled_at IS NOT NULL AS disabled`,
        [pair.userA.grantId],
      )
      expect(disabled.rows).toEqual([{ id: pair.userA.grantId, disabled: true }])
      const exactA = `xs.${randomUUID()}`
      const ordinaryA = `ord-${randomUUID()}`
      const ordinaryB = `ord-${randomUUID()}`
      const tokenA = randomUUID()
      const tokenB = randomUUID()
      await pair.pool.query(
        `INSERT INTO user_sessions (id, user_id, expires_at, external_auth_context)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour', $3::jsonb)`,
        [exactA, pair.userA.userId, strictSessionContext({
          connectionId: pair.connectionId,
          identityId: pair.userA.identityId,
          grantId: pair.userA.grantId,
          evidenceId: pair.userA.evidenceId,
          orgId: pair.orgId,
          subjectKey: pair.userA.subjectKey,
        })],
      )
      await pair.pool.query(
        `INSERT INTO user_sessions (id, user_id, expires_at)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour'),
                ($3, $4, pg_catalog.clock_timestamp() + interval '1 hour')`,
        [ordinaryA, pair.userA.userId, ordinaryB, pair.userB.userId],
      )
      await pair.pool.query(
        `INSERT INTO multitable_api_tokens (id, created_by, revoked)
         VALUES ($1, $2, false), ($3, $4, false)`,
        [tokenA, pair.userA.userId, tokenB, pair.userB.userId],
      )
      process.env[CREDENTIAL_REVOCATION_FLAG] = 'true'
      const unbound = await directory.unbindDirectoryAccount(accountId, {
        adminUserId: 'b2-native-actor',
        disableDingTalkGrant: true,
      })
      expect(unbound.previousLocalUser).toEqual({
        id: pair.userA.userId,
        email: null,
        name: pair.userA.userId,
      })
      expect(unbound.account.id).toBe(accountId)
      expect(unbound.account.linkStatus).toBe('unmatched')
      expect(unbound.account.matchStrategy).toBe('manual_unbound')
      expect(unbound.account.localUser).toBeNull()
      const identities = await pair.pool.query(
        `SELECT local_user_id FROM user_external_identities WHERE local_user_id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      expect(identities.rows.map((row) => String(row.local_user_id))).toEqual([pair.userB.userId])
      const evidence = await pair.pool.query(
        `SELECT id, live_identity_id::text AS live_identity_id, revoked_at IS NOT NULL AS revoked
           FROM user_external_identity_evidence
          WHERE id = ANY($1::text[])`,
        [[pair.userA.evidenceId, pair.userB.evidenceId]],
      )
      const byEvidence = new Map(evidence.rows.map((row) => [String(row.id), row]))
      expect(byEvidence.get(pair.userA.evidenceId)).toMatchObject({
        live_identity_id: null,
        revoked: true,
      })
      expect(byEvidence.get(pair.userB.evidenceId)).toMatchObject({
        live_identity_id: pair.userB.identityId,
        revoked: false,
      })
      const grants = await pair.pool.query(
        `SELECT id, enabled, revoked_reason, disabled_by,
                disabled_at IS NOT NULL AS disabled,
                revoked_at IS NOT NULL AS revoked
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      const byGrant = new Map(grants.rows.map((row) => [String(row.id), row]))
      expect(byGrant.get(pair.userA.grantId)).toMatchObject({
        enabled: false,
        revoked_reason: 'admin_unbind',
        disabled_by: 'b2-native-actor',
        disabled: true,
        revoked: true,
      })
      expect(byGrant.get(pair.userB.grantId)).toMatchObject({
        enabled: true,
        revoked_reason: null,
        disabled: false,
        revoked: false,
      })
      const link = await pair.pool.query(
        `SELECT local_user_id, link_status, match_strategy
           FROM directory_account_links
          WHERE directory_account_id = $1::uuid`,
        [accountId],
      )
      expect(link.rows).toEqual([{
        local_user_id: null,
        link_status: 'unmatched',
        match_strategy: 'manual_unbound',
      }])
      const sessions = await pair.pool.query(
        `SELECT id, revoked_at IS NOT NULL AS revoked
           FROM user_sessions
          WHERE id = ANY($1::text[])`,
        [[exactA, ordinaryA, ordinaryB]],
      )
      const bySession = new Map(sessions.rows.map((row) => [String(row.id), row]))
      expect(bySession.get(exactA)).toMatchObject({ revoked: true })
      expect(bySession.get(ordinaryA)).toMatchObject({ revoked: true })
      expect(bySession.get(ordinaryB)).toMatchObject({ revoked: false })
      const tokens = await pair.pool.query(
        `SELECT id, revoked FROM multitable_api_tokens WHERE id = ANY($1::text[])`,
        [[tokenA, tokenB]],
      )
      const byToken = new Map(tokens.rows.map((row) => [String(row.id), row]))
      expect(byToken.get(tokenA)).toMatchObject({ revoked: true })
      expect(byToken.get(tokenB)).toMatchObject({ revoked: false })
      const graph = await pair.pool.query(
        `SELECT user_row.id AS user_id,
                user_row.access_generation::text AS generation,
                membership.is_active AS member_active,
                watermark.reason
           FROM users user_row
           JOIN user_orgs membership
             ON membership.user_id = user_row.id
            AND membership.org_id = $2
           JOIN user_session_revocations watermark ON watermark.user_id = user_row.id
          WHERE user_row.id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId], pair.orgId],
      )
      const byUser = new Map(graph.rows.map((row) => [String(row.user_id), row]))
      expect(byUser.get(pair.userA.userId)).toMatchObject({
        generation: '2',
        member_active: false,
        reason: STRICT_GRANT_SESSION_REVOCATION_REASON,
      })
      expect(byUser.get(pair.userB.userId)).toMatchObject({
        generation: '1',
        member_active: true,
        reason: 'fixture',
      })
    } finally {
      restoreCredentialFlag(previousFlag)
      await releaseNativePair(pair)
    }
  })

  it('recycle: evidence-only purge deletes the identity and a late tombstone fault restores every row', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    let client: PoolClient | undefined
    try {
      pair = await openPublishedPair('recycle')
      await installNativeCallerTables(pair.pool)
      await installSupersedeTargets(pair.pool)
      await pair.pool.query(
        `UPDATE users
            SET deleted_at = pg_catalog.clock_timestamp(),
                purged_at = NULL
          WHERE id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      const terminal = await pair.pool.query(
        `UPDATE user_external_identity_login_grants
            SET enabled = FALSE,
                revocation_generation = revocation_generation + 1,
                live_identity_id = NULL,
                revoked_at = pg_catalog.clock_timestamp(),
                revoked_reason = 'admin_unbind',
                revoked_by = 'b2-native-actor'
          WHERE local_user_id = ANY($1::text[])
            AND revoked_at IS NULL
          RETURNING id`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      expect(terminal.rows).toHaveLength(2)
      const beforeFault = await pair.pool.query(
        `SELECT evidence.live_identity_id::text AS live_identity_id,
                evidence.revoked_at IS NULL AS open_evidence,
                evidence.revocation_generation::text AS generation,
                user_row.password_hash
           FROM user_external_identity_evidence evidence
           JOIN users user_row ON user_row.id = $2
          WHERE evidence.id = $1`,
        [pair.userB.evidenceId, pair.userB.userId],
      )
      expect(beforeFault.rows[0]).toMatchObject({
        live_identity_id: pair.userB.identityId,
        open_evidence: true,
        generation: '0',
      })
      const passwordBefore = String(beforeFault.rows[0]?.password_hash ?? '')
      expect(passwordBefore.startsWith('unusable:')).toBe(false)
      client = await pair.pool.connect()
      await client.query('BEGIN')
      const purged = await applyRecyclePurge(callerSurface(client), {
        userId: pair.userA.userId,
        actorId: 'b2-native-actor',
        index: 0,
        passwordHash: 'unusable:fixture',
      })
      await client.query('COMMIT')
      expect(purged).toMatchObject({
        index: 0,
        ok: true,
        userId: pair.userA.userId,
        code: null,
      })
      await client.query('BEGIN')
      let thrown: unknown
      try {
        await applyRecyclePurge(failTombstoneAfterIdentityDelete(client), {
          userId: pair.userB.userId,
          actorId: 'b2-native-actor',
          index: 0,
          passwordHash: 'unusable:fixture',
        })
      } catch (error) {
        thrown = error
      }
      await client.query('ROLLBACK')
      expect(thrown).toMatchObject({ code: '42703' })
      expect(thrown instanceof Error ? thrown.message : '').toContain('employee_no')
      const column = await client.query(
        `SELECT count(*)::int AS count
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name = 'employee_no'`,
      )
      expect(column.rows[0]).toMatchObject({ count: 1 })
      const identities = await client.query(
        `SELECT local_user_id FROM user_external_identities WHERE local_user_id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      expect(identities.rows.map((row) => String(row.local_user_id))).toEqual([pair.userB.userId])
      const evidence = await client.query(
        `SELECT id, live_identity_id::text AS live_identity_id,
                revoked_at IS NOT NULL AS revoked,
                revocation_generation::text AS generation
           FROM user_external_identity_evidence
          WHERE id = ANY($1::text[])`,
        [[pair.userA.evidenceId, pair.userB.evidenceId]],
      )
      const byEvidence = new Map(evidence.rows.map((row) => [String(row.id), row]))
      expect(byEvidence.get(pair.userA.evidenceId)).toMatchObject({
        live_identity_id: null,
        revoked: true,
      })
      expect(byEvidence.get(pair.userB.evidenceId)).toMatchObject({
        live_identity_id: pair.userB.identityId,
        revoked: false,
        generation: '0',
      })
      const grants = await client.query(
        `SELECT id, revoked_reason, revoked_at IS NOT NULL AS revoked
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      expect(grants.rows).toHaveLength(2)
      expect(grants.rows.every((row) => row.revoked_reason === 'admin_unbind' && row.revoked === true)).toBe(true)
      const users = await client.query(
        `SELECT id, name, password_hash, is_active,
                purged_at IS NOT NULL AS purged,
                access_generation::text AS generation
           FROM users
          WHERE id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      const byUser = new Map(users.rows.map((row) => [String(row.id), row]))
      expect(byUser.get(pair.userA.userId)).toMatchObject({
        name: USER_TOMBSTONE_NAME,
        password_hash: 'unusable:fixture',
        is_active: false,
        purged: true,
        generation: '2',
      })
      expect(byUser.get(pair.userB.userId)).toMatchObject({
        password_hash: passwordBefore,
        is_active: true,
        purged: false,
        generation: '1',
      })
      expect(byUser.get(pair.userB.userId)?.name).not.toBe(USER_TOMBSTONE_NAME)
      const stillThere = await client.query(
        `SELECT count(*)::int AS count FROM users WHERE id = $1`,
        [pair.userA.userId],
      )
      expect(stillThere.rows[0]).toMatchObject({ count: 1 })
    } finally {
      restoreCredentialFlag(previousFlag)
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releaseNativePair(pair)
    }
  })

  it('bulk: locked grant switch revokes the full set before watermark and session work', async () => {
    const previousFlag = process.env[CREDENTIAL_REVOCATION_FLAG]
    let pair: PublishedPair | undefined
    let client: PoolClient | undefined
    try {
      pair = await openPublishedPair('bulk')
      await installNativeCallerTables(pair.pool)
      const accountA = randomUUID()
      const accountB = randomUUID()
      await insertLinkedAccount(pair.pool, {
        accountId: accountA,
        connectionId: pair.connectionId,
        corpId: pair.corpId,
        userId: pair.userA.userId,
        openId: pair.userA.openId,
        externalKey: pair.userA.externalKey,
        active: true,
      })
      await insertLinkedAccount(pair.pool, {
        accountId: accountB,
        connectionId: pair.connectionId,
        corpId: pair.corpId,
        userId: pair.userB.userId,
        openId: pair.userB.openId,
        externalKey: pair.userB.externalKey,
        active: true,
      })
      await commitConnectionScope(pair.pool, pair.connectionId, `scope-${pair.userA.userId}`)
      const exactA = `xs.${randomUUID()}`
      const exactB = `xs.${randomUUID()}`
      const ordinaryA = `ord-${randomUUID()}`
      const tokenA = randomUUID()
      const tokenB = randomUUID()
      const sessionFor = (user: PublishedUser): string => strictSessionContext({
        connectionId: pair!.connectionId,
        identityId: user.identityId,
        grantId: user.grantId,
        evidenceId: user.evidenceId,
        orgId: pair!.orgId,
        subjectKey: user.subjectKey,
      })
      await pair.pool.query(
        `INSERT INTO user_sessions (id, user_id, expires_at, external_auth_context)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour', $3::jsonb),
                ($4, $5, pg_catalog.clock_timestamp() + interval '1 hour', $6::jsonb)`,
        [exactA, pair.userA.userId, sessionFor(pair.userA), exactB, pair.userB.userId, sessionFor(pair.userB)],
      )
      await pair.pool.query(
        `INSERT INTO user_sessions (id, user_id, expires_at)
         VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '1 hour')`,
        [ordinaryA, pair.userA.userId],
      )
      await pair.pool.query(
        `INSERT INTO multitable_api_tokens (id, created_by, revoked)
         VALUES ($1, $2, false), ($3, $4, false)`,
        [tokenA, pair.userA.userId, tokenB, pair.userB.userId],
      )
      delete process.env[CREDENTIAL_REVOCATION_FLAG]
      const texts: string[] = []
      client = await pair.pool.connect()
      await client.query('BEGIN')
      const surface = recordingSurface(client, texts)
      await lockUsersForAccessGraphWrite(surface, [pair.userA.userId, pair.userB.userId])
      const switched = await guardAdminLegacyGrantSwitchSet(surface, {
        userIds: [pair.userA.userId, pair.userB.userId],
        actorId: 'b2-native-actor',
        enabled: false,
      })
      const userLock = (text: string): boolean =>
        /\bfrom\s+users\b/i.test(text) && /\bfor\s+update\b/i.test(text)
      const grantRevoke = (text: string): boolean =>
        /\bupdate\b/i.test(text)
        && text.includes('user_external_identity_login_grants')
        && text.includes('revoked_reason')
      const watermarkOrSession = (text: string): boolean =>
        /\bupdate\b/i.test(text)
        && (text.includes('user_session_revocations') || text.includes('user_sessions'))
      const firstRevoke = texts.findIndex(grantRevoke)
      const revokeIndexes = texts.flatMap((text, index) => grantRevoke(text) ? [index] : [])
      const firstSessionWrite = texts.findIndex(watermarkOrSession)
      expect(texts.slice(0, firstRevoke).filter(userLock).length).toBeGreaterThanOrEqual(2)
      expect(revokeIndexes).toHaveLength(2)
      expect(firstSessionWrite).toBeGreaterThan(revokeIndexes[1])
      expect(texts.some((text) => /\bupdate\b/i.test(text) && text.includes('multitable_api_tokens'))).toBe(false)
      expect([...switched.grantIds].sort()).toEqual([pair.userA.grantId, pair.userB.grantId].sort())
      const grants = await client.query(
        `SELECT id, enabled, revoked_reason, revoked_by, revoked_at IS NOT NULL AS revoked
           FROM user_external_identity_login_grants
          WHERE id = ANY($1::text[])`,
        [[pair.userA.grantId, pair.userB.grantId]],
      )
      expect(grants.rows).toHaveLength(2)
      expect(grants.rows.every((row) => row.enabled === false && row.revoked === true && row.revoked_reason === 'admin_disable' && row.revoked_by === 'b2-native-actor')).toBe(true)
      const sessions = await client.query(
        `SELECT id, revoked_at IS NOT NULL AS revoked
           FROM user_sessions
          WHERE id = ANY($1::text[])`,
        [[exactA, exactB, ordinaryA]],
      )
      const bySession = new Map(sessions.rows.map((row) => [String(row.id), row]))
      expect(bySession.get(exactA)).toMatchObject({ revoked: true })
      expect(bySession.get(exactB)).toMatchObject({ revoked: true })
      expect(bySession.get(ordinaryA)).toMatchObject({ revoked: false })
      const tokens = await client.query(
        `SELECT id, revoked FROM multitable_api_tokens WHERE id = ANY($1::text[])`,
        [[tokenA, tokenB]],
      )
      expect(tokens.rows).toHaveLength(2)
      expect(tokens.rows.every((row) => row.revoked === false)).toBe(true)
      const watermarks = await client.query(
        `SELECT user_id, reason
           FROM user_session_revocations
          WHERE user_id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId]],
      )
      expect(watermarks.rows).toHaveLength(2)
      expect(watermarks.rows.every((row) => row.reason === STRICT_GRANT_SESSION_REVOCATION_REASON)).toBe(true)
      const graph = await client.query(
        `SELECT user_row.access_generation::text AS generation, membership.is_active
           FROM users user_row
           JOIN user_orgs membership
             ON membership.user_id = user_row.id
            AND membership.org_id = $2
          WHERE user_row.id = ANY($1::text[])`,
        [[pair.userA.userId, pair.userB.userId], pair.orgId],
      )
      expect(graph.rows).toEqual([
        { generation: '1', is_active: true },
        { generation: '1', is_active: true },
      ])
      await client.query('COMMIT')
    } finally {
      restoreCredentialFlag(previousFlag)
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await releaseNativePair(pair)
    }
  })

  it('refuses legacy grant enable when the stored resolver sees an installed strict scope', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      ids.corpId = writerExitCorpId(ids.suffix)
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: true,
        mustChangePassword: false,
        passwordHash: 'writer-exit-password-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await withWriterExitOauth(ids.corpId, async () => {
        const oauth = await import('../../src/auth/dingtalk-oauth')
        await expect(oauth.__dingtalkOAuthInternalsForTests.ensureGrant(ids.userId)).rejects.toMatchObject({
          name: 'DingTalkLoginPolicyError',
          code: 'strict_connection',
          statusCode: 403,
        })
      })
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({
        activation_status: 'activated',
        is_active: true,
        access_generation: '1',
      })
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })

  it('keeps the directory bind link and membership when strict scope suppresses the legacy grant', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: true,
        mustChangePassword: false,
        passwordHash: 'writer-exit-password-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await insertWriterExitAccount(pool, ids, false)
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      const directory = await import('../../src/directory/directory-sync')
      const bound = await directory.bindDirectoryAccount(ids.accountId, {
        localUserRef: ids.userId,
        adminUserId: ids.adminUserId,
        enableDingTalkGrant: true,
      })
      expect(bound.previousLocalUser).toBeNull()
      expect(bound.account.linkStatus).toBe('linked')
      expect(bound.account.localUser?.id).toBe(ids.userId)
      const link = await pool.query(
        `SELECT local_user_id, link_status
           FROM directory_account_links
          WHERE directory_account_id = $1::uuid`,
        [ids.accountId],
      )
      expect(link.rows).toEqual([{ local_user_id: ids.userId, link_status: 'linked' }])
      const member = await pool.query(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [ids.userId, ids.orgId],
      )
      expect(member.rows).toEqual([{ is_active: true }])
      const identity = await pool.query(
        `SELECT provider, corp_id, external_key
           FROM user_external_identities
          WHERE local_user_id = $1`,
        [ids.userId],
      )
      expect(identity.rows).toEqual([{
        provider: 'dingtalk',
        corp_id: ids.corpId,
        external_key: `${ids.corpId}:${ids.openId}`,
      }])
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({ access_generation: '2' })
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })

  it('refuses SSO activation when the only directory connection is strict', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'pending_activation',
        isActive: false,
        localPasswordSet: false,
        mustChangePassword: false,
        passwordHash: 'pending-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await insertWriterExitAccount(pool, ids, true)
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      const activate = await import('../../src/auth/user-activate')
      await expect(activate.activatePendingUser({
        userId: ids.userId,
        mode: 'sso',
        adminUserId: ids.adminUserId,
        directoryAccountId: ids.accountId,
        orgId: ids.orgId,
        enableDingTalkGrant: true,
      })).rejects.toMatchObject({ code: 'ACTIVATE_STRICT_CONNECTION' })
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({
        activation_status: 'pending_activation',
        is_active: false,
        local_password_set: false,
        password_hash: 'pending-hash',
        access_generation: '1',
      })
      expect(await writerExitCount(
        pool,
        `SELECT count(*)::int AS count FROM user_orgs WHERE user_id = $1`,
        [ids.userId],
      )).toBe(0)
      expect(await writerExitCount(
        pool,
        `SELECT count(*)::int AS count FROM user_login_aliases WHERE user_id = $1`,
        [ids.userId],
      )).toBe(0)
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })

  it('activates with a temporary password and no legacy grant on an installed strict connection', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'pending_activation',
        isActive: false,
        localPasswordSet: false,
        mustChangePassword: false,
        passwordHash: 'pending-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await insertWriterExitAccount(pool, ids, true)
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      const activate = await import('../../src/auth/user-activate')
      const chain = await import('../../src/auth/strict-credential-chain')
      const activated = await activate.activatePendingUser({
        userId: ids.userId,
        mode: 'temp_password',
        adminUserId: ids.adminUserId,
        directoryAccountId: ids.accountId,
        orgId: ids.orgId,
        enableDingTalkGrant: true,
      })
      expect(activated.activationStatus).toBe('activated')
      expect(activated.isActive).toBe(true)
      expect(activated.localPasswordSet).toBe(true)
      expect(activated.membershipOrgId).toBe(ids.orgId)
      expect(typeof activated.temporaryPassword).toBe('string')
      expect((activated.temporaryPassword ?? '').length).toBeGreaterThan(0)
      expect(chain.isClosedExternalOrigin(activated.externalOrigin)).toBe(true)
      expect(activated.externalOrigin).toMatchObject({ kind: 'password' })
      const user = await writerExitUser(pool, ids.userId)
      expect(user).toMatchObject({
        activation_status: 'activated',
        is_active: true,
        local_password_set: true,
        must_change_password: true,
        access_generation: '2',
      })
      expect(String(user.password_hash).startsWith('unusable:')).toBe(false)
      expect(String(user.password_hash)).not.toBe('pending-hash')
      const member = await pool.query(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [ids.userId, ids.orgId],
      )
      expect(member.rows).toEqual([{ is_active: true }])
      const aliases = await pool.query(
        `SELECT user_id, kind, normalized_value, source
           FROM user_login_aliases
          WHERE user_id = $1
          ORDER BY kind, normalized_value`,
        [ids.userId],
      )
      expect(aliases.rows).toEqual([
        {
          user_id: ids.userId,
          kind: 'email',
          normalized_value: ids.email,
          source: 't3_activate',
        },
        {
          user_id: ids.userId,
          kind: 'username',
          normalized_value: ids.userId,
          source: 't3_activate',
        },
      ])
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })

  it('refuses self-managed DingTalk bind when the corp resolves to an installed strict scope', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      ids.corpId = writerExitCorpId(ids.suffix)
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: true,
        mustChangePassword: false,
        passwordHash: 'writer-exit-password-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await withWriterExitOauth(ids.corpId, async () => {
        const oauth = await import('../../src/auth/dingtalk-oauth')
        await expect(oauth.bindDingTalkIdentityToUser({
          localUserId: ids.userId,
          dtUser: {
            openId: ids.openId,
            unionId: ids.unionId,
            nick: 'writer-exit',
          },
          boundBy: ids.adminUserId,
          enableGrant: true,
        })).rejects.toMatchObject({
          name: 'DingTalkLoginPolicyError',
          code: 'strict_connection',
          statusCode: 403,
        })
      })
      expect(await writerExitCount(
        pool,
        `SELECT count(*)::int AS count FROM user_external_identities WHERE local_user_id = $1`,
        [ids.userId],
      )).toBe(0)
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({ access_generation: '1' })
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })

  it('refuses self-managed DingTalk unbind for strict scope and for live evidence', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      const evidenceUserId = `wx-evidence-${ids.suffix}`
      const scopeIdentityId = randomUUID()
      const evidenceIdentityId = randomUUID()
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: true,
        mustChangePassword: false,
        passwordHash: 'writer-exit-password-hash',
      })
      await insertWriterExitUser(pool, { ...ids, userId: evidenceUserId, email: `wx-evidence-${ids.suffix}@directory.invalid` }, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: true,
        mustChangePassword: false,
        passwordHash: 'writer-exit-password-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await pool.query(
        `INSERT INTO user_external_identities
           (id, provider, external_key, local_user_id, corp_id, provider_open_id, provider_union_id)
         VALUES ($1::uuid, 'dingtalk', $2, $3, $4, $5, $6)`,
        [scopeIdentityId, `ext-scope-${ids.suffix}`, ids.userId, ids.corpId, ids.openId, ids.unionId],
      )
      await pool.query(
        `INSERT INTO user_external_identities
           (id, provider, external_key, local_user_id, corp_id, provider_open_id, provider_union_id)
         VALUES ($1::uuid, 'dingtalk', $2, $3, NULL, $4, $5)`,
        [evidenceIdentityId, `ext-evidence-${ids.suffix}`, evidenceUserId, `open-evidence-${ids.suffix}`, `union-evidence-${ids.suffix}`],
      )
      await pool.query(
        `INSERT INTO user_external_identity_evidence
           (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
            assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
            application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
            revocation_generation, slot_snapshot, created_by)
         VALUES ($1, $2, $3::text, $3::uuid, 7, 'writer-exit-not-a-producer',
                 'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 4, '4', $7,
                 1, pg_catalog.clock_timestamp() - interval '2 days',
                 pg_catalog.clock_timestamp() + interval '1 day',
                 0, $8::jsonb, 'writer-exit')`,
        [
          `ev-wx-${ids.suffix}`,
          `wit-wx-${ids.suffix}`,
          evidenceIdentityId,
          `evidence:${ids.suffix}`,
          ids.orgId,
          ids.connectionId,
          FINGERPRINT,
          JSON.stringify({ provider: 'dingtalk', localUserId: evidenceUserId }),
        ],
      )
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      const oauth = await import('../../src/auth/dingtalk-oauth')
      await expect(oauth.unbindSelfManagedDingTalkIdentity({
        localUserId: ids.userId,
        actorId: ids.adminUserId,
      })).rejects.toMatchObject({
        name: 'DingTalkLoginPolicyError',
        code: 'strict_connection',
        statusCode: 403,
      })
      await expect(oauth.unbindSelfManagedDingTalkIdentity({
        localUserId: evidenceUserId,
        actorId: ids.adminUserId,
      })).rejects.toMatchObject({
        name: 'DingTalkLoginPolicyError',
        code: 'strict_connection',
        statusCode: 403,
      })
      const identities = await pool.query(
        `SELECT id::text AS id, local_user_id, corp_id
           FROM user_external_identities
          WHERE id = ANY($1::uuid[])
          ORDER BY local_user_id`,
        [[scopeIdentityId, evidenceIdentityId]],
      )
      expect(identities.rows).toEqual([
        { id: evidenceIdentityId, local_user_id: evidenceUserId, corp_id: null },
        { id: scopeIdentityId, local_user_id: ids.userId, corp_id: ids.corpId },
      ])
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({ access_generation: '1' })
      expect(await writerExitUser(pool, evidenceUserId)).toMatchObject({ access_generation: '1' })
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
      await expectWriterExitGrantsQuiet(pool, evidenceUserId)
    })
  })

  it('accepts an invite for a strict-linked user without writing a legacy grant', async () => {
    await withWriterExitLane(async (pool) => {
      const ids = writerExitIds()
      const inviteToken = `invite-${ids.suffix}`
      await insertWriterExitUser(pool, ids, {
        activationStatus: 'activated',
        isActive: true,
        localPasswordSet: false,
        mustChangePassword: true,
        passwordHash: 'prior-invite-hash',
      })
      await insertWriterExitIntegration(pool, ids)
      await insertWriterExitAccount(pool, ids, true)
      await pool.query(
        `INSERT INTO user_invites
           (user_id, email, product_mode, invited_by, invite_token, status)
         VALUES ($1, $2, 'platform', $3, $4, 'pending')`,
        [ids.userId, ids.email, ids.adminUserId, inviteToken],
      )
      await commitWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      const accept = await import('../../src/auth/invite-accept-writes')
      await accept.applyInviteAcceptanceWrites({
        inviteToken,
        userId: ids.userId,
        email: ids.email,
        passwordHash: 'writer-exit-invite-hash',
        requestedName: '',
      })
      expect(await writerExitUser(pool, ids.userId)).toMatchObject({
        activation_status: 'activated',
        is_active: true,
        local_password_set: true,
        must_change_password: false,
        password_hash: 'writer-exit-invite-hash',
        access_generation: '1',
      })
      const invite = await pool.query(
        `SELECT status, consumed_by FROM user_invites WHERE invite_token = $1`,
        [inviteToken],
      )
      expect(invite.rows).toEqual([{ status: 'accepted', consumed_by: ids.userId }])
      const link = await pool.query(
        `SELECT local_user_id, link_status
           FROM directory_account_links
          WHERE directory_account_id = $1::uuid`,
        [ids.accountId],
      )
      expect(link.rows).toEqual([{ local_user_id: ids.userId, link_status: 'linked' }])
      await expectWriterExitScope(pool, ids.connectionId, ids.scopeCommand)
      await expectWriterExitGrantsQuiet(pool, ids.userId)
    })
  })
})

// Original old-writer exits on an installed strict scope. The extra tables and
// columns are local to installWriterExitFixture. Published chain helpers stay
// as they are. Ledger, deletion, bulk, DR, and API-token fences are elsewhere.

type WriterExitIds = {
  suffix: string
  orgId: string
  connectionId: string
  corpId: string
  accountId: string
  userId: string
  adminUserId: string
  email: string
  openId: string
  unionId: string
  scopeCommand: string
}

type WriterExitUserState = {
  activationStatus: 'pending_activation' | 'activated'
  isActive: boolean
  localPasswordSet: boolean
  mustChangePassword: boolean
  passwordHash: string
}

const WRITER_EXIT_OAUTH_ENV = [
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CLIENT_SECRET',
  'DINGTALK_REDIRECT_URI',
  'DINGTALK_CORP_ID',
] as const

function writerExitSuffix(): string {
  return randomBytes(3).toString('hex')
}

function writerExitIds(): WriterExitIds {
  const suffix = writerExitSuffix()
  return {
    suffix,
    orgId: `org-wx-${suffix}`,
    connectionId: randomUUID(),
    corpId: `corp-wx-${suffix}`,
    accountId: randomUUID(),
    userId: `wx-user-${suffix}`,
    adminUserId: `wx-admin-${suffix}`,
    email: `wx-${suffix}@directory.invalid`,
    openId: `open-wx-${suffix}`,
    unionId: `union-wx-${suffix}`,
    scopeCommand: `wx-scope-${suffix}`,
  }
}

function writerExitCorpId(suffix: string): string {
  const allowed = String(process.env.DINGTALK_ALLOWED_CORP_IDS || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return allowed[0] ?? `corp-wx-${suffix}`
}

function holdWriterExitOauthEnv(corpId: string): () => void {
  const previous = new Map<string, string | undefined>()
  for (const key of WRITER_EXIT_OAUTH_ENV) previous.set(key, process.env[key])
  process.env.DINGTALK_CLIENT_ID = 'writer-exit-client'
  process.env.DINGTALK_CLIENT_SECRET = 'writer-exit-secret'
  process.env.DINGTALK_REDIRECT_URI = 'https://directory.invalid/writer-exit'
  process.env.DINGTALK_CORP_ID = corpId
  return () => {
    for (const key of WRITER_EXIT_OAUTH_ENV) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withWriterExitOauth(corpId: string, body: () => Promise<void>): Promise<void> {
  const restore = holdWriterExitOauthEnv(corpId)
  try {
    await body()
  } finally {
    restore()
  }
}

async function installWriterExitFixture(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE directory_accounts (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      corp_id text,
      external_user_id text NOT NULL,
      union_id text,
      open_id text,
      external_key text,
      name text,
      email text,
      mobile text,
      is_active boolean NOT NULL,
      updated_at timestamptz
    );
    CREATE TABLE directory_account_links (
      directory_account_id uuid NOT NULL,
      local_user_id text NOT NULL,
      link_status text NOT NULL,
      match_strategy text,
      reviewed_by text,
      review_note text,
      created_at timestamptz,
      updated_at timestamptz,
      CONSTRAINT writer_exit_directory_account_link_key UNIQUE (directory_account_id)
    );
    CREATE TABLE directory_departments (
      id uuid PRIMARY KEY,
      full_path text
    );
    CREATE TABLE directory_account_departments (
      directory_account_id uuid,
      directory_department_id uuid
    );
    CREATE TABLE directory_deprovision_effects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      local_user_id text,
      status text,
      updated_at timestamptz
    );
    CREATE TABLE user_login_aliases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL REFERENCES users (id),
      kind text NOT NULL,
      normalized_value text NOT NULL,
      source text NOT NULL DEFAULT 'writer-exit',
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      CONSTRAINT writer_exit_login_alias_value_key UNIQUE (normalized_value)
    );
    CREATE TABLE user_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      email varchar(255) NOT NULL,
      preset_id varchar(128),
      product_mode varchar(32) NOT NULL DEFAULT 'platform',
      role_id varchar(128),
      invited_by text,
      invite_token text NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending',
      accepted_at timestamptz,
      consumed_by text,
      last_sent_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    );
    ALTER TABLE user_external_identities
      ALTER COLUMN id SET DEFAULT gen_random_uuid(),
      ADD COLUMN profile jsonb,
      ADD COLUMN bound_by text,
      ADD COLUMN created_at timestamptz,
      ADD COLUMN updated_at timestamptz;
    ALTER TABLE user_external_auth_grants
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp();
    CREATE UNIQUE INDEX writer_exit_legacy_grant_user
      ON user_external_auth_grants (provider, local_user_id);
    ALTER TABLE user_orgs
      ADD COLUMN created_at timestamptz;
    ALTER TABLE user_orgs
      ADD CONSTRAINT writer_exit_user_orgs_pk PRIMARY KEY (user_id, org_id);
    ALTER TABLE directory_deprovision_events
      ADD COLUMN local_user_id text,
      ADD COLUMN status text,
      ADD COLUMN resolved_at timestamptz,
      ADD COLUMN resolved_by text,
      ADD COLUMN resolve_note text,
      ADD COLUMN updated_at timestamptz;
  `)
}

async function openWriterExitLane(): Promise<{ pool: Pool, release: () => Promise<void> }> {
  const published = await loadPublishedCommandChain()
  const schema = await createSchema()
  const pool = poolFor(schema, 4)
  try {
    await installPublishedParents(pool, schema)
    await installWriterExitFixture(pool)
    await aimPublishedPool(published.nativePool, schema)
  } catch (error) {
    await releasePublishedPool(published.nativePool).catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }
  return {
    pool,
    async release() {
      await releasePublishedPool(published.nativePool).catch(() => undefined)
      await pool.end()
    },
  }
}

async function withWriterExitLane(body: (pool: Pool) => Promise<void>): Promise<void> {
  const lane = await openWriterExitLane()
  try {
    await body(lane.pool)
  } finally {
    await lane.release()
  }
}

async function commitWriterExitScope(pool: Pool, connectionId: string, commandId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await insertConnectionLoginScope(callerFor(client), { connectionId, commandId })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function insertWriterExitIntegration(pool: Pool, ids: WriterExitIds): Promise<void> {
  await pool.query(
    `INSERT INTO directory_integrations (id, org_id, provider, name, status, corp_id)
     VALUES ($1::uuid, $2, 'dingtalk', 'writer-exit-directory', 'active', $3)`,
    [ids.connectionId, ids.orgId, ids.corpId],
  )
}

async function insertWriterExitUser(
  pool: Pool,
  ids: WriterExitIds,
  state: WriterExitUserState,
): Promise<void> {
  await pool.query(
    `INSERT INTO users
       (id, username, name, email, password_hash, is_active, is_admin, role,
        activation_status, local_password_set, must_change_password, access_generation)
     VALUES ($1, $1, $2, $3, $4, $5, false, 'user', $6, $7, $8, 1)`,
    [
      ids.userId,
      ids.userId,
      ids.email,
      state.passwordHash,
      state.isActive,
      state.activationStatus,
      state.localPasswordSet,
      state.mustChangePassword,
    ],
  )
}

async function insertWriterExitAccount(pool: Pool, ids: WriterExitIds, linked: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO directory_accounts
       (id, integration_id, provider, corp_id, external_user_id, union_id, open_id,
        external_key, name, email, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, 'dingtalk', $3, $4, $5, $6, $7, $8, $9, true,
             pg_catalog.clock_timestamp())`,
    [
      ids.accountId,
      ids.connectionId,
      ids.corpId,
      `ext-${ids.suffix}`,
      ids.unionId,
      ids.openId,
      `${ids.corpId}:${ids.openId}`,
      ids.userId,
      ids.email,
    ],
  )
  if (!linked) return
  await pool.query(
    `INSERT INTO directory_account_links
       (directory_account_id, local_user_id, link_status, match_strategy, reviewed_by, created_at, updated_at)
     VALUES ($1::uuid, $2, 'linked', 'manual_admin', $3, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())`,
    [ids.accountId, ids.userId, ids.adminUserId],
  )
}

async function writerExitCount(pool: Pool, text: string, params: readonly unknown[]): Promise<number> {
  const found = await pool.query(text, params as never[])
  const count = Number(found.rows[0]?.count)
  if (!Number.isInteger(count)) throw new Error('B2_WRITER_EXIT_COUNT_UNREADABLE')
  return count
}

async function writerExitUser(pool: Pool, userId: string): Promise<Record<string, unknown>> {
  const found = await pool.query(
    `SELECT activation_status, is_active, local_password_set, must_change_password,
            password_hash, access_generation::text AS access_generation
       FROM users
      WHERE id = $1`,
    [userId],
  )
  const row = found.rows[0]
  if (!row) throw new Error('B2_WRITER_EXIT_USER_ABSENT')
  return row
}

async function expectWriterExitScope(pool: Pool, connectionId: string, commandId: string): Promise<void> {
  const found = await pool.query(
    `SELECT command_id FROM directory_connection_login_scope WHERE connection_id = $1::uuid`,
    [connectionId],
  )
  expect(found.rows).toEqual([{ command_id: commandId }])
}

async function expectWriterExitGrantsQuiet(pool: Pool, userId: string): Promise<void> {
  expect(await writerExitCount(
    pool,
    `SELECT count(*)::int AS count FROM user_external_auth_grants WHERE local_user_id = $1`,
    [userId],
  )).toBe(0)
  expect(await writerExitCount(
    pool,
    `SELECT count(*)::int AS count FROM user_external_identity_login_grants WHERE local_user_id = $1`,
    [userId],
  )).toBe(0)
}
