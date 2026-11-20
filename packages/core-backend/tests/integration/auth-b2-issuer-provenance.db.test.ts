/**
 * Ordinary final issuer and required-password provenance on PostgreSQL.
 * The completed DingTalk exchange result is the only substituted output.
 * Scope SQL, session SQL, and signing stay on the mounted router.
 * This file does not claim complete B2, provider acceptance, or strict-login acceptance.
 */
import { randomUUID } from 'node:crypto'
import { Pool as PgPool, type PoolClient, type QueryResult } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SCHEMA_RE = /^b2iss_[0-9a-f]{32}$/
const REPEATABLE_READ = 'repeatable read'
const READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const STRICT_CONNECTION_ERROR = 'DingTalk login is not eligible for this source'
const OLD_PASSWORD = 'Old-issuer-1'
const NEW_PASSWORD = 'New-issuer-9'
const SCOPE_COMMAND = 'issuer-scope-1'
const WAIT_MS = 3000
const BLOCK_MS = 5000
const providerFetch = vi.fn(async () => { throw new Error('FINAL_ISSUER_NETWORK_FORBIDDEN') })
const ENV_KEYS = [
  'REDIS_URL',
  'REDIS_HOST',
  'DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CORP_ID',
  'DINGTALK_CLIENT_SECRET',
  'DINGTALK_REDIRECT_URI',
] as const

type RecordedTransaction = {
  started: string[]
  completed: string[]
  pid: number | null
  outcome: 'open' | 'commit' | 'rollback'
}

const state = vi.hoisted(() => {
  const schema = `b2iss_${globalThis.crypto.randomUUID().replace(/-/g, '')}`
  if (!/^b2iss_[0-9a-f]{32}$/.test(schema)) throw new Error('B2_ISSUER_SCHEMA_INVALID')
  return {
    schema,
    fixtureDatabaseUrl: undefined as string | undefined,
    service: undefined as unknown,
    sql: [] as string[],
    started: [] as string[],
    pids: [] as number[],
    transactionPids: [] as number[],
    commits: 0,
    rollbacks: 0,
    transactions: [] as RecordedTransaction[],
    maxSeen: 0,
    maxWaiting: 0,
    issuerHold: null as null | {
      gate: Promise<void>
      entered: boolean
      release: () => void
    },
  }
})

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  return {
    ...actual,
    poolManager: {
      get: () => {
        if (!(state.fixtureDatabaseUrl && state.schema === 'public') && !/^b2iss_[0-9a-f]{32}$/.test(state.schema)) throw new Error('B2_ISSUER_SCHEMA_REQUIRED')
        // Startup isolation is the discriminator. The product transaction stays plain BEGIN.
        const service = (state.service ??= new actual.ConnectionPool({
          connectionString: state.fixtureDatabaseUrl ?? process.env.DATABASE_URL,
          max: 1,
          name: 'b2-issuer',
          application_name: 'b2_issuer_app',
          options: `-c search_path=${state.schema},pg_catalog -c default_transaction_isolation=repeatable\\ read`,
        })) as InstanceType<typeof actual.ConnectionPool>
        return {
          getInternalPool: () => service.getInternalPool(),
          query: service.query.bind(service),
          transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }) => Promise<Result>) => {
            const record: RecordedTransaction = {
              started: [],
              completed: [],
              pid: null,
              outcome: 'open',
            }
            state.transactions.push(record)
            try {
              const result = await service.transaction(async (client) => {
                let pid: number | undefined
                const internal = service.getInternalPool()
                state.maxSeen = Math.max(state.maxSeen, internal.totalCount)
                state.maxWaiting = Math.max(state.maxWaiting, internal.waitingCount)
                return work({
                  query: async (sql, params) => {
                    const text = typeof sql === 'string' ? sql : ''
                    // Completed text is recorded after the server returns, so an in-flight share stays out of sql.
                    state.started.push(text)
                    record.started.push(text)
                    const queryResult = await client.query(sql, params)
                    if (pid === undefined) {
                      // This connection stays on the product's first statement. The pid read follows that statement and stays out of the product trace.
                      pid = await readBackendPid(
                        async (statement, statementParams) => client.query(statement, statementParams),
                        'B2_ISSUER_PID_UNAVAILABLE',
                      )
                      record.pid = pid
                      state.transactionPids.push(pid)
                    }
                    state.sql.push(text)
                    record.completed.push(text)
                    state.pids.push(pid)
                    state.maxSeen = Math.max(state.maxSeen, internal.totalCount)
                    state.maxWaiting = Math.max(state.maxWaiting, internal.waitingCount)
                    const hold = state.issuerHold
                    if (hold && text.includes('INSERT INTO user_sessions')) {
                      hold.entered = true
                      await hold.gate
                    }
                    return queryResult
                  },
                })
              })
              record.outcome = 'commit'
              state.commits += 1
              return result
            } catch (error) {
              record.outcome = 'rollback'
              state.rollbacks += 1
              throw error
            }
          },
        }
      },
    },
  }
})

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}))

if (process.env.EXPECT_DB !== '1') {
  throw new Error('EXPECT_DB=1 is required for auth-b2-issuer-provenance.db.test.ts')
}
if (!process.env.DATABASE_URL) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for auth-b2-issuer-provenance.db.test.ts')
}

import express from 'express'
import request from 'supertest'
import * as bcrypt from 'bcryptjs'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { ATTENDANCE_SELF_SERVICE_NAMESPACE } from '../../src/auth/attendanceSelfServiceBackfill'
import { authService } from '../../src/auth/AuthService'
import {
  classifyAdminGrantActorInputSchema,
} from '../../src/auth/admin-grant-local-credential'
import * as dingtalk from '../../src/auth/dingtalk-oauth'
import { checkEmptyDingTalkScope, resolveDingTalkLoginSource } from '../../src/auth/dingtalk-login-source'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { readAuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import { createUserSession } from '../../src/auth/session-registry'
import { closedDingTalkOrigin } from '../../src/auth/strict-credential-chain'
import {
  insertConnectionLoginScope,
  readStrictLoginInstallation,
} from '../../src/auth/strict-login-grant-store'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { quoteAdminGrantActorInputIdent } from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'
import { up as actorUp } from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'
import {
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  down as strictDown,
  up as strictUp,
} from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'
import { poolManager } from '../../src/integration/db/connection-pool'
import { authRouter } from '../../src/routes/auth'

const savedEnv = new Map<string, string | undefined>()
const createdSchemas: string[] = []
let witness: PgPool | undefined
let originalFetch: typeof globalThis.fetch | undefined

const exchangeTarget: {
  userId: string
  email: string
  name: string
  connectionId: string
  origin: 'dingtalk' | 'null'
} = {
  userId: '',
  email: '',
  name: '',
  connectionId: '',
  origin: 'dingtalk',
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  const path = (req.originalUrl || req.path || '').split('?')[0]
  if (req.method === 'POST' && (path === '/api/auth/password/change' || path === '/api/auth/session-context')) {
    return jwtAuthMiddleware(req, res, next)
  }
  return next()
})
app.post('/api/auth/session-context', (req, res) => {
  const context = readAuthenticatedSessionContext(req)
  if (!context) {
    return res.status(401).json({ success: false, error: 'Invalid token' })
  }
  return res.json({
    success: true,
    data: {
      userId: context.userId,
      sessionId: context.sessionId,
      tokenIssuedAt: context.tokenIssuedAt,
    },
  })
})
app.use('/api/auth', authRouter)

type ActorKind = 'absent' | 'ready' | 'partial' | 'ready-failure'

type Prepared = {
  schema: string
  userId: string
  email: string
  connectionId: string
  token: string | null
  witness: PgPool
}

function resetTrace(): void {
  state.sql = []
  state.started = []
  state.pids = []
  state.transactionPids = []
  state.commits = 0
  state.rollbacks = 0
  state.transactions = []
  state.maxSeen = 0
  state.maxWaiting = 0
}

async function readBackendPid(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: ReadonlyArray<unknown> }>,
  unavailable: string,
): Promise<number> {
  const confirmed = await query('SELECT pg_catalog.pg_backend_pid()::text AS pid')
  const row = confirmed.rows[0]
  const raw = typeof row === 'object' && row !== null && 'pid' in row ? row.pid : undefined
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) throw new Error(unavailable)
  const pid = Number(raw)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(unavailable)
  return pid
}

function armIssuerSessionHold(): { release: () => void } {
  let resolveGate = () => {}
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  const hold = {
    gate,
    entered: false,
    release: () => resolveGate(),
  }
  state.issuerHold = hold
  return hold
}

function startupOptions(schema: string): string {
  if (!(state.fixtureDatabaseUrl && schema === 'public') && !SCHEMA_RE.test(schema)) throw new Error('B2_ISSUER_SCHEMA_INVALID')
  return `-c search_path=${schema},pg_catalog -c default_transaction_isolation=repeatable\\ read`
}

function ident(schema: string, relation?: string): string {
  const quoted = quoteAdminGrantActorInputIdent(schema)
  if (!relation) return quoted
  return `${quoted}.${quoteAdminGrantActorInputIdent(relation)}`
}

function queryable(executor: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> }): Queryable {
  return {
    async query(sql, params) {
      const result = await executor.query(sql, params)
      return {
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: result.rowCount ?? null,
      }
    },
  }
}

async function endAppService(): Promise<void> {
  const service = state.service as { stopMetricsCollection?: () => void; getInternalPool: () => PgPool } | undefined
  state.service = undefined
  if (!service) return
  service.stopMetricsCollection?.()
  await service.getInternalPool().end()
}

async function useAppSchema(schema: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error('B2_ISSUER_SCHEMA_INVALID')
  const admin = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: 'b2_issuer_admin',
  })
  try {
    await admin.query(`CREATE SCHEMA ${ident(schema)}`)
  } finally {
    await admin.end()
  }
  createdSchemas.push(schema)
  await endAppService()
  state.schema = schema
  resetTrace()
}

async function installShells(pool: PgPool, schema: string): Promise<void> {
  const users = ident(schema, 'users')
  const sessions = ident(schema, 'user_sessions')
  const revocations = ident(schema, 'user_session_revocations')
  await pool.query(`CREATE TABLE ${users} (
    id text PRIMARY KEY,
    email text,
    username text,
    mobile text,
    name text,
    role text,
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    password_hash text,
    access_generation bigint NOT NULL DEFAULT 0,
    is_active boolean NOT NULL,
    must_change_password boolean NOT NULL,
    activation_status text,
    local_password_set boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
  )`)
  const admissions = ident(schema, 'user_namespace_admissions')
  await pool.query(`CREATE TABLE ${admissions} (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    user_id text NOT NULL REFERENCES ${users} (id) ON DELETE CASCADE,
    namespace text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    source text NOT NULL DEFAULT 'platform_admin',
    granted_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
  )`)
  await pool.query(`CREATE INDEX idx_user_namespace_admissions_user_id ON ${admissions} (user_id)`)
  await pool.query(`CREATE INDEX idx_user_namespace_admissions_namespace ON ${admissions} (namespace)`)
  await pool.query(`CREATE UNIQUE INDEX idx_user_namespace_admissions_user_namespace ON ${admissions} (user_id, namespace)`)
  await pool.query(`CREATE TABLE ${sessions} (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
  )`)
  await pool.query(`CREATE TABLE ${revocations} (
    user_id text PRIMARY KEY,
    revoked_after timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    updated_by text,
    reason text
  )`)
  await pool.query(`CREATE TABLE ${ident(schema, 'directory_integrations')} (
    id uuid PRIMARY KEY, name text NOT NULL, org_id text NOT NULL, provider text NOT NULL, status text NOT NULL,
    corp_id text NOT NULL, config jsonb NOT NULL
  )`)
  await pool.query(`CREATE TABLE ${ident(schema, 'user_external_identities')} (
    id uuid PRIMARY KEY, provider text NOT NULL, external_key text NOT NULL, provider_open_id text,
    provider_union_id text, corp_id text, local_user_id text NOT NULL, profile jsonb NOT NULL DEFAULT '{}'
  )`)
  await pool.query(`CREATE TABLE ${ident(schema, 'user_external_identity_evidence')} (id text PRIMARY KEY)`)
  await pool.query(`CREATE TABLE ${ident(schema, 'security_action_challenges')} (
    id uuid PRIMARY KEY,
    purpose text,
    status text,
    consumed_action_ref text
  )`)
  await pool.query(`CREATE TABLE ${ident(schema, 'directory_deprovision_events')} (id uuid PRIMARY KEY)`)
  await pool.query(`CREATE TABLE ${ident(schema, 'directory_sync_runs')} (id uuid PRIMARY KEY)`)
}

async function installActor(pool: PgPool): Promise<void> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
    await actorUp(trx)
  })
}

async function installStrict(pool: PgPool, schema: string): Promise<void> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () => ({
        [STRICT_LOGIN_GRANT_MIGRATION_NAME]: { up: strictUp, down: strictDown },
      }),
    },
    migrationTableSchema: schema,
  })
  const outcome = await migrator.migrateToLatest()
  if (outcome.error) throw outcome.error
  const installed = outcome.results?.some((result) => (
    result.migrationName === STRICT_LOGIN_GRANT_MIGRATION_NAME && result.status === 'Success'
  ))
  if (!installed) throw new Error('B2_ISSUER_T4_MIGRATOR_FAILED')
  const installation = await readStrictLoginInstallation(queryable(pool))
  if (installation.installation !== 'installed') throw new Error('B2_ISSUER_T4_NOT_INSTALLED')
}

async function commitScope(pool: PgPool, connectionId: string, commandId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await insertConnectionLoginScope(queryable(client), { connectionId, commandId })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// An installed database series permits exercising the identical behavioral suite from frozen snapshots.
// Each case uses an empty, dedicated clone. Historical migrations run only in the original CI fixture path.
let fixtureNumber = 0
async function selectFixtureDatabase(installed: boolean): Promise<string | null> {
  await endAppService()
  state.fixtureDatabaseUrl = undefined
  const prefix = process.env.B2_ISSUER_FIXTURE_DATABASE_PREFIX
  if (!prefix || !installed) return null
  if (!/^b2iss_[a-z0-9_]{1,32}$/.test(prefix)) throw new Error('B2_ISSUER_FIXTURE_PREFIX_INVALID')
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = '/' + prefix + '_' + (++fixtureNumber)
  state.fixtureDatabaseUrl = url.href
  state.schema = 'public'
  resetTrace()
  return 'public'
}

async function prepare(input: {
  actor: ActorKind
  strict: boolean
  integration: boolean
  scope: boolean
  mustChange: boolean
  session: boolean
  origin?: 'dingtalk' | 'null'
}): Promise<Prepared> {
  const installed = await selectFixtureDatabase(input.strict || input.actor !== 'absent')
  const schema = installed ?? `b2iss_${randomUUID().replace(/-/g, '')}`
  if (!installed) await useAppSchema(schema)
  const next = new PgPool({
    connectionString: state.fixtureDatabaseUrl ?? process.env.DATABASE_URL,
    max: 4,
    application_name: 'b2_issuer_witness',
    options: startupOptions(schema),
  })
  witness = next
  if (installed) {
    const expectedDatabase = new URL(state.fixtureDatabaseUrl!).pathname.slice(1)
    const clean = await next.query('SELECT current_database() AS name, NOT EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM directory_integrations) AND NOT EXISTS (SELECT 1 FROM directory_connection_login_scope) AS empty')
    if (clean.rows[0]?.name !== expectedDatabase || clean.rows[0]?.empty !== true) throw new Error('B2_ISSUER_FIXTURE_NOT_EMPTY')
    const snapshot = await readStrictLoginInstallation(queryable(next))
    if (snapshot.installation !== 'installed') throw new Error('B2_ISSUER_SNAPSHOT_NOT_INSTALLED')
  } else {
    await installShells(next, schema)
  }
  const userId = `issuer-${randomUUID()}`
  const email = `issuer-${userId.slice(-12)}@b2.example`
  const connectionId = randomUUID()
  const passwordHash = await bcrypt.hash(OLD_PASSWORD, 10)
  await next.query(
    `INSERT INTO ${ident(schema, 'users')} (
      id, email, username, mobile, name, role, permissions, password_hash,
      access_generation, is_active, must_change_password, activation_status, local_password_set
    ) VALUES (
      $1, $2, NULL, NULL, 'Issuer', 'user', $3::jsonb, $4,
      0, true, $5, 'activated', true
    )`,
    [userId, email, '[]', passwordHash, input.mustChange],
  )
  await next.query(
    `INSERT INTO ${ident(schema, 'user_namespace_admissions')} (
      user_id, namespace, enabled, source
    ) VALUES ($1, $2, false, 'platform_admin')`,
    [userId, ATTENDANCE_SELF_SERVICE_NAMESPACE],
  )
  if (input.integration) {
    await next.query(
      `INSERT INTO ${ident(schema, 'directory_integrations')} (id,name,org_id,provider,status,corp_id,config)
       VALUES ($1::uuid,'Fixture','default','dingtalk','active','fixture-corp',$2::jsonb)`,
      [connectionId, JSON.stringify({ appKey: input.origin === 'null' ? 'other-fixture-app' : 'b2-issuer-client' })],
    )
  }
  if (input.actor !== 'absent') {
    if (!installed) await installActor(next)
    const actorState = await classifyAdminGrantActorInputSchema(queryable(next))
    if (actorState !== 'ready') throw new Error('B2_ISSUER_ACTOR_NOT_READY')
    if (input.actor === 'partial') {
      await next.query(`DROP TRIGGER admin_grant_local_credential_establishment_guard ON ${ident(schema, 'user_local_credential_establishments')}`)
      const partial = await classifyAdminGrantActorInputSchema(queryable(next))
      if (partial !== 'partial') throw new Error('B2_ISSUER_ACTOR_NOT_PARTIAL')
    }
    if (input.actor === 'ready-failure') {
      await next.query(`ALTER TABLE ${ident(schema, 'user_local_credential_establishments')} RENAME COLUMN kind TO kind_held`)
      const ready = await classifyAdminGrantActorInputSchema(queryable(next))
      if (ready !== 'ready') throw new Error('B2_ISSUER_ACTOR_FAILURE_NOT_READY')
    }
  }
  if (input.strict && !installed) await installStrict(next, schema)
  if (input.scope) await commitScope(next, connectionId, SCOPE_COMMAND)
  exchangeTarget.userId = userId
  exchangeTarget.email = email
  exchangeTarget.name = 'Issuer'
  exchangeTarget.connectionId = connectionId
  exchangeTarget.origin = input.origin ?? 'dingtalk'
  let token: string | null = null
  if (input.session) {
    const sessionId = randomUUID()
    const minted = authService.createToken({
      id: userId,
      email,
      name: 'Issuer',
      role: 'user',
      permissions: [],
      created_at: new Date(),
      updated_at: new Date(),
    }, { sid: sessionId, externalAuth: false })
    const payload = authService.readTokenPayload(minted)
    if (!payload?.exp) throw new Error('B2_ISSUER_SESSION_TOKEN_UNSIGNED')
    const stored = await createUserSession(userId, {
      sessionId,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      ipAddress: null,
      userAgent: null,
    })
    if (!stored || stored.id !== sessionId) throw new Error('B2_ISSUER_SESSION_NOT_STORED')
    token = minted
  }
  resetTrace()
  return { schema, userId, email, connectionId, token, witness: next }
}

async function countRows(pool: PgPool, schema: string, relation: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${ident(schema, relation)}`)
  return Number(result.rows[0]?.count ?? 0)
}

async function callback(stateToken: string) {
  return request(app)
    .post('/api/auth/dingtalk/callback')
    .send({ code: 'final-issuer-code', state: stateToken })
}

function mentionsUsers(sqlText: string): boolean {
  return /\b(?:from|into|update|join)\s+users\b/i.test(sqlText)
}

function assertIssuerOrder(): void {
  const setAt = state.sql.findIndex((sqlText) => sqlText === READ_COMMITTED)
  const userAt = state.sql.findIndex((sqlText) => sqlText.includes('FROM users') && sqlText.includes('FOR SHARE'))
  const integrationAt = state.sql.findIndex((sqlText) => sqlText.includes('directory_integrations') && sqlText.includes('FOR SHARE'))
  expect(setAt).toBe(0)
  expect(userAt).toBeGreaterThan(setAt)
  expect(integrationAt).toBeGreaterThan(userAt)
  expect(new Set(state.pids).size).toBe(1)
  expect(state.transactionPids).toEqual([state.pids[0]])
  expect(state.sql.some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
  expect(state.started.some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
  expect(state.maxSeen).toBeLessThanOrEqual(1)
  expect(state.maxWaiting).toBe(0)
}

const ADMISSION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
const ADMISSION_READ_SQL = 'SELECT enabled, source FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2 LIMIT 1'

function compactSql(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim()
}

function requireRecordedPid(pid: number | null, code: string): number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(code)
  return pid
}

async function assertPasswordChangeBoundary(
  env: Prepared,
  provenance: 'none' | 'commit' | 'rollback',
): Promise<void> {
  const records = state.transactions
  expect(records).toHaveLength(provenance === 'none' ? 2 : 3)
  for (const record of records.slice(0, 2)) {
    expect(record.outcome).toBe('commit')
    expect(requireRecordedPid(record.pid, 'B2_ISSUER_ADMISSION_PID_UNAVAILABLE')).toBeGreaterThan(0)
    expect(record.started.map(compactSql)).toEqual([ADMISSION_LOCK_SQL, ADMISSION_READ_SQL])
    expect(record.completed.map(compactSql)).toEqual([ADMISSION_LOCK_SQL, ADMISSION_READ_SQL])
    const traced = [...record.started, ...record.completed]
    expect(traced.some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
    expect(traced.some((sqlText) => /INSERT|user_roles|user_permissions|password_hash/i.test(sqlText))).toBe(false)
  }
  expect([...state.started, ...state.sql].some((sqlText) => sqlText.includes('directory_integrations'))).toBe(false)
  if (provenance === 'none') {
    expect(state.commits).toBe(2)
    expect(state.rollbacks).toBe(0)
  } else {
    const own = records[2]
    if (!own) throw new Error('B2_ISSUER_PROVENANCE_TRANSACTION_MISSING')
    expect(own.started[0]).toBe(READ_COMMITTED)
    expect(own.completed[0]).toBe(READ_COMMITTED)
    expect(requireRecordedPid(own.pid, 'B2_ISSUER_PROVENANCE_PID_UNAVAILABLE')).toBeGreaterThan(0)
    expect([...own.started, ...own.completed].some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
    expect(own.outcome).toBe(provenance)
    expect(state.commits).toBe(provenance === 'commit' ? 3 : 2)
    expect(state.rollbacks).toBe(provenance === 'rollback' ? 1 : 0)
  }
  const admission = await env.witness.query(
    `SELECT namespace, enabled, source
       FROM ${ident(env.schema, 'user_namespace_admissions')}
      WHERE user_id = $1`,
    [env.userId],
  )
  expect(admission.rows).toEqual([{
    namespace: ATTENDANCE_SELF_SERVICE_NAMESPACE,
    enabled: false,
    source: 'platform_admin',
  }])
}

async function assertPlainBegin(): Promise<void> {
  resetTrace()
  const pool = poolManager.get()
  await pool.transaction(async (client) => {
    const shown = await client.query('SHOW transaction_isolation')
    expect(shown.rows[0]?.transaction_isolation).toBe(REPEATABLE_READ)
  })
  const defaults = await pool.query('SHOW default_transaction_isolation')
  expect(defaults.rows[0]?.default_transaction_isolation).toBe(REPEATABLE_READ)
  expect(state.commits).toBe(1)
  expect(state.rollbacks).toBe(0)
  expect(state.sql.some((sqlText) => sqlText.includes('SET TRANSACTION ISOLATION LEVEL'))).toBe(false)
  resetTrace()
}

async function waitForIntegrationShare(pool: PgPool, holderPid: number): Promise<number> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < BLOCK_MS) {
    const found = await pool.query(
      `SELECT waiter.pid
         FROM pg_stat_activity waiter
        WHERE waiter.application_name = 'b2_issuer_app'
          AND $1::int = ANY (pg_catalog.pg_blocking_pids(waiter.pid))
          AND waiter.query ILIKE '%directory_integrations%'
          AND waiter.query ILIKE '%FOR SHARE%'`,
      [holderPid],
    )
    if (found.rowCount === 1) return Number(found.rows[0]?.pid)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FINAL_ISSUER_INTEGRATION_WAIT_NOT_OBSERVED')
}

async function waitForIssuerSessionHold(): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < BLOCK_MS) {
    if (state.issuerHold?.entered) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FINAL_ISSUER_SESSION_HOLD_NOT_OBSERVED')
}

async function waitForScopeWriterBlock(pool: PgPool, writerPid: number, issuerPid: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < BLOCK_MS) {
    const found = await pool.query(
      `SELECT waiter.pid
         FROM pg_stat_activity waiter
        WHERE waiter.pid = $1
          AND $2::int = ANY (pg_catalog.pg_blocking_pids(waiter.pid))
          AND waiter.query ILIKE '%directory_integrations%'
          AND waiter.query ILIKE '%FOR UPDATE%'`,
      [writerPid, issuerPid],
    )
    if (found.rowCount === 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FINAL_ISSUER_SCOPE_WRITER_BLOCK_NOT_OBSERVED')
}

async function waitUntilMintedIatClearsWatermark(pool: PgPool, schema: string, userId: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < BLOCK_MS) {
    const found = await pool.query(
      `SELECT (floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint
               > extract(epoch FROM revoked_after)) AS clears
         FROM ${ident(schema, 'user_session_revocations')}
        WHERE user_id = $1`,
      [userId],
    )
    if (found.rows[0]?.clears === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('B2_ISSUER_WATERMARK_SECOND_NOT_CLEARED')
}

async function raceResponse(
  pending: Promise<{ status: number; body: Record<string, unknown> }>,
  code: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const outcome = await Promise.race([
    pending.then((response) => ({ kind: 'response' as const, response })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), WAIT_MS)
    }),
  ])
  if (outcome.kind !== 'response') throw new Error(code)
  return outcome.response
}

describe('ordinary final issuer and required password provenance', () => {
  beforeAll(async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = providerFetch
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    delete process.env.REDIS_URL
    delete process.env.REDIS_HOST
    process.env.DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE = 'false'
    delete process.env.DINGTALK_CORP_ID
    process.env.DINGTALK_CLIENT_ID = 'b2-issuer-client'
    process.env.DINGTALK_CLIENT_SECRET = 'b2-issuer-secret'
    process.env.DINGTALK_REDIRECT_URI = 'https://issuer.example/callback'
    await dingtalk.__resetDingTalkOAuthStateStoreForTests()
    vi.spyOn(dingtalk, 'exchangeCodeForUser').mockImplementation(async () => {
      if (state.transactions.some(tx => tx.outcome === 'open')) {
        throw new Error('FINAL_ISSUER_EXCHANGE_UNDER_LOCK')
      }
      // The read-only source transaction has already committed. Trace the final issuer separately.
      resetTrace()
      return {
        dingtalkUser: { unionId: 'issuer-union', nick: 'Issuer', openId: 'issuer-open' },
        localUserId: exchangeTarget.userId,
        sessionGeneration: 0,
        localUserEmail: exchangeTarget.email,
        localUserName: exchangeTarget.name,
        localUserRole: 'user',
        isNewUser: false,
        externalOrigin: exchangeTarget.origin === 'null' ? null : closedDingTalkOrigin(exchangeTarget.connectionId),
      }
    })
    vi.spyOn(dingtalk, 'exchangeCodeForDingTalkProfile').mockImplementation(async () => {
      throw new Error('FINAL_ISSUER_PROFILE_EXCHANGE_FORBIDDEN')
    })
    vi.spyOn(dingtalk, 'exchangeEnterpriseAuthCodeForUser').mockImplementation(async () => {
      throw new Error('FINAL_ISSUER_ENTERPRISE_EXCHANGE_FORBIDDEN')
    })
  })

  beforeEach(() => {
    providerFetch.mockClear()
    vi.mocked(dingtalk.exchangeCodeForUser).mockClear()
    state.issuerHold?.release()
    state.issuerHold = null
    resetTrace()
  })

  afterEach(async () => {
    const current = witness
    witness = undefined
    if (current) await current.end()
    await dingtalk.__resetDingTalkOAuthStateStoreForTests()
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await endAppService()
    if (originalFetch) globalThis.fetch = originalFetch
    else delete (globalThis as { fetch?: typeof fetch }).fetch
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const admin = new PgPool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      application_name: 'b2_issuer_admin',
    })
    try {
      for (const schema of createdSchemas) {
        if (!SCHEMA_RE.test(schema)) continue
        await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`)
      }
    } finally {
      await admin.end()
    }
  })

  it('final issuer commits the ordinary session on the caller client when the connection has no scope', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: true,
      integration: true,
      scope: false,
      mustChange: false,
      session: false,
    })
    await assertPlainBegin()
    const stateToken = await dingtalk.generateState()
    const response = await callback(stateToken)
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data.mode).toBe('login')
    expect(typeof response.body.data.token).toBe('string')
    expect(dingtalk.exchangeCodeForUser).toHaveBeenCalledTimes(1)
    assertIssuerOrder()
    const insertAt = state.sql.findIndex((sqlText) => sqlText.includes('INSERT INTO user_sessions'))
    const integrationAt = state.sql.findIndex((sqlText) => sqlText.includes('directory_integrations') && sqlText.includes('FOR SHARE'))
    expect(insertAt).toBeGreaterThan(integrationAt)
    expect(state.commits).toBe(1)
    expect(state.rollbacks).toBe(0)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(1)
    expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(0)
    const payload = authService.readTokenPayload(response.body.data.token)
    const stored = await env.witness.query(`SELECT id FROM ${ident(env.schema, 'user_sessions')}`)
    expect(payload?.sid).toBe(stored.rows[0]?.id)
    expect(payload && !('xa' in payload)).toBe(true)
    expect(poolManager.get().getInternalPool().totalCount).toBeLessThanOrEqual(1)
    expect(poolManager.get().getInternalPool().waitingCount).toBe(0)
  }, 60_000)

  it('final issuer rejects with no session after the scope cutover is already committed', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: true,
      integration: true,
      scope: true,
      mustChange: false,
      session: false,
    })
    const stateToken = await dingtalk.generateState()
    const response = await callback(stateToken)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      success: false,
      error: STRICT_CONNECTION_ERROR,
      code: 'strict_connection',
    })
    expect(dingtalk.exchangeCodeForUser).not.toHaveBeenCalled()
    expect(state.sql.some(sqlText => sqlText.includes('directory_connection_login_scope'))).toBe(true)
    expect(state.sql.some(sqlText => sqlText.includes('INSERT INTO user_sessions'))).toBe(false)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
    expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(1)
  }, 60_000)

  it('final issuer read-committed waiter sees the scope committed while it waits and leaves no session', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: true,
      integration: true,
      scope: false,
      mustChange: false,
      session: false,
    })
    const stateToken = await dingtalk.generateState()
    // Complete the initial lookup before the writer locks the connection; this witness concerns final issuance.
    let enteredExchange!: () => void
    let finishExchange!: () => void
    const entered = new Promise<void>(resolve => { enteredExchange = resolve })
    const finish = new Promise<void>(resolve => { finishExchange = resolve })
    const exchange = vi.mocked(dingtalk.exchangeCodeForUser)
    const reply = exchange.getMockImplementation()!
    exchange.mockImplementationOnce(async (...args) => {
      enteredExchange()
      await finish
      return reply(...args)
    })
    const client = await env.witness.connect()
    const writerSql: string[] = []
    const record = (sqlText: string, params?: unknown[]) => {
      writerSql.push(sqlText)
      return client.query(sqlText, params)
    }
    let pending: ReturnType<typeof callback> | undefined
    let response: Awaited<ReturnType<typeof callback>> | undefined
    let committed = false
    let primary: unknown
    try {
      const holderPid = await readBackendPid(
        async (sql, params) => client.query(sql, params),
        'B2_ISSUER_HOLDER_PID_UNAVAILABLE',
      )
      pending = callback(stateToken)
      await Promise.race([entered, pending.then(() => { throw new Error('B2_ISSUER_EXCHANGE_NOT_ENTERED') })])
      await record('BEGIN')
      const shown = await record('SHOW transaction_isolation')
      expect(shown.rows[0]?.transaction_isolation).toBe(REPEATABLE_READ)
      await record(
        'SELECT id FROM directory_integrations WHERE id = $1::uuid FOR UPDATE',
        [env.connectionId],
      )
      finishExchange()
      const waiterPid = await waitForIntegrationShare(env.witness, holderPid)
      expect(waiterPid).toBe(state.transactionPids[0])
      expect(state.sql[0]).toBe(READ_COMMITTED)
      expect(state.sql.some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
      expect(state.started.some((sqlText) => sqlText.includes('pg_backend_pid'))).toBe(false)
      expect(state.sql.some((sqlText) => sqlText.includes('FROM users') && sqlText.includes('FOR SHARE'))).toBe(true)
      expect(state.sql.some((sqlText) => sqlText.includes('directory_integrations'))).toBe(false)
      expect(state.started.some((sqlText) => sqlText.includes('directory_integrations') && sqlText.includes('FOR SHARE'))).toBe(true)
      expect(poolManager.get().getInternalPool().totalCount).toBeLessThanOrEqual(1)
      expect(poolManager.get().getInternalPool().waitingCount).toBe(0)
      await insertConnectionLoginScope(queryable({
        query: (sqlText, params) => record(sqlText, params),
      }), { connectionId: env.connectionId, commandId: SCOPE_COMMAND })
      await record('COMMIT')
      committed = true
    } catch (error) {
      primary = error
    } finally {
      finishExchange()
      if (!committed) await client.query('ROLLBACK').catch(() => undefined)
      client.release()
      if (pending) {
        try {
          response = await pending
        } catch (error) {
          if (!primary) primary = error
        }
      }
    }
    if (primary) throw primary
    expect(writerSql.some((sqlText) => mentionsUsers(sqlText))).toBe(false)
    expect(response?.status).toBe(403)
    expect(response?.body).toEqual({
      success: false,
      error: STRICT_CONNECTION_ERROR,
      code: 'strict_connection',
    })
    expect(dingtalk.exchangeCodeForUser).toHaveBeenCalledTimes(1)
    expect(state.sql[0]).toBe(READ_COMMITTED)
    expect(state.sql.some((sqlText) => sqlText.includes('directory_connection_login_scope'))).toBe(true)
    expect(state.sql.some((sqlText) => sqlText.includes('INSERT INTO user_sessions'))).toBe(false)
    expect(state.commits).toBe(0)
    expect(state.rollbacks).toBe(1)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
    expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(1)
  }, 60_000)

  it('final issuer leaves the session uncommitted while the scope writer blocks on its integration share', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: true,
      integration: true,
      scope: false,
      mustChange: false,
      session: false,
    })
    await assertPlainBegin()
    const stateToken = await dingtalk.generateState()
    const hold = armIssuerSessionHold()
    const writerSql: string[] = []
    let writerClient: PoolClient | undefined
    let pending: Promise<Awaited<ReturnType<typeof callback>>> | undefined
    let response: Awaited<ReturnType<typeof callback>> | undefined
    let writer: Promise<void> | undefined
    let writerCommitted = false
    let escaped = false
    let primary: unknown
    try {
      const connected = await env.witness.connect()
      writerClient = connected
      const writerPid = await readBackendPid(
        async (sql, params) => connected.query(sql, params),
        'B2_ISSUER_HOLDER_PID_UNAVAILABLE',
      )
      pending = callback(stateToken).then((value) => {
        escaped = true
        return value
      })
      await waitForIssuerSessionHold()
      expect(state.commits).toBe(0)
      expect(state.sql.some((sqlText) => sqlText.includes('directory_integrations') && sqlText.includes('FOR SHARE'))).toBe(true)
      expect(state.sql.some((sqlText) => sqlText.includes('INSERT INTO user_sessions'))).toBe(true)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
      expect(escaped).toBe(false)
      const issuerPid = state.transactionPids[0]
      if (!Number.isSafeInteger(issuerPid) || issuerPid <= 0) throw new Error('B2_ISSUER_PID_UNAVAILABLE')
      writer = (async () => {
        await connected.query('BEGIN')
        await insertConnectionLoginScope(queryable({
          query: async (sqlText, params) => {
            writerSql.push(sqlText)
            return connected.query(sqlText, params)
          },
        }), { connectionId: env.connectionId, commandId: SCOPE_COMMAND })
        await connected.query('COMMIT')
        writerCommitted = true
      })()
      await waitForScopeWriterBlock(env.witness, writerPid, issuerPid)
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      expect(escaped).toBe(false)
      expect(state.commits).toBe(0)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
      expect(poolManager.get().getInternalPool().totalCount).toBeLessThanOrEqual(1)
      expect(poolManager.get().getInternalPool().waitingCount).toBe(0)
      hold.release()
      response = await pending
      expect(state.commits).toBe(1)
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.mode).toBe('login')
      expect(typeof response.body.data.token).toBe('string')
      expect(escaped).toBe(true)
      expect(dingtalk.exchangeCodeForUser).toHaveBeenCalledTimes(1)
      assertIssuerOrder()
      const insertAt = state.sql.findIndex((sqlText) => sqlText.includes('INSERT INTO user_sessions'))
      const integrationAt = state.sql.findIndex((sqlText) => sqlText.includes('directory_integrations') && sqlText.includes('FOR SHARE'))
      expect(insertAt).toBeGreaterThan(integrationAt)
      expect(state.rollbacks).toBe(0)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(1)
      const payload = authService.readTokenPayload(response.body.data.token)
      const stored = await env.witness.query(`SELECT id FROM ${ident(env.schema, 'user_sessions')}`)
      expect(payload?.sid).toBe(stored.rows[0]?.id)
      expect(payload && !('xa' in payload)).toBe(true)
      await writer
      expect(writerCommitted).toBe(true)
      expect(writerSql.some((sqlText) => mentionsUsers(sqlText))).toBe(false)
      expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(1)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(1)
    } catch (error) {
      primary = error
    } finally {
      state.issuerHold?.release()
      state.issuerHold = null
      if (pending) {
        try {
          response = response ?? await pending
        } catch (error) {
          if (!primary) primary = error
        }
      }
      if (writer) {
        try {
          await writer
        } catch (error) {
          if (!primary) primary = error
        }
      }
      if (writerClient && !writerCommitted) await writerClient.query('ROLLBACK').catch(() => undefined)
      writerClient?.release()
    }
    if (primary) throw primary
    expect(response?.status).toBe(200)
  }, 60_000)

  it('rejects an integration removed after the initial lookup and before final issuance', async () => {
    const env = await prepare({ actor: 'absent', strict: true, integration: true, scope: false, mustChange: false, session: false })
    const exchange = vi.mocked(dingtalk.exchangeCodeForUser)
    const reply = exchange.getMockImplementation()!
    exchange.mockImplementationOnce(async (...args) => {
      await env.witness.query(`DELETE FROM ${ident(env.schema, 'directory_integrations')} WHERE id=$1`, [env.connectionId])
      return reply(...args)
    })
    const response = await callback(await dingtalk.generateState())
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ success: false, error: STRICT_CONNECTION_ERROR, code: 'strict_connection' })
    expect(state.sql.some(stmt => stmt.includes('directory_integrations') && stmt.includes('FOR SHARE'))).toBe(true)
    expect(state.sql.some(stmt => stmt.includes('INSERT INTO user_sessions'))).toBe(false)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
  }, 60_000)

  it('rejects an explicit missing integration without exchanging a code or issuing a session', async () => {
    const env = await prepare({ actor: 'absent', strict: true, integration: false, scope: false, mustChange: false, session: false })
    const response = await request(app).post('/api/auth/dingtalk/callback').send({
      code: 'fixture', state: await dingtalk.generateState(), connectionId: env.connectionId,
    })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ success: false, error: STRICT_CONNECTION_ERROR, code: 'strict_connection' })
    expect(dingtalk.exchangeCodeForUser).not.toHaveBeenCalled()
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
  }, 60_000)

  it('requires a verified ordinary source beside a committed scope', async () => {
    const env = await prepare({ actor: 'absent', strict: true, integration: true, scope: true,
      mustChange: false, session: false, origin: 'null' })
    await env.witness.query(`INSERT INTO ${ident(env.schema, 'user_external_identities')}
      (id,provider,external_key,provider_union_id,provider_open_id,local_user_id)
      VALUES ($1,'dingtalk','issuer-union','issuer-union','issuer-open',$2)`, [randomUUID(), env.userId])
    const identitySnapshot = () => env.witness.query(`SELECT to_jsonb(i) AS identity FROM ${ident(env.schema, 'user_external_identities')} i WHERE local_user_id=$1`, [env.userId])
    const original = (await identitySnapshot()).rows
    // Use the normal exchange entry point. Source admission is required before any provider request.
    const { exchangeCodeForUser } = await vi.importActual<typeof dingtalk>('../../src/auth/dingtalk-oauth')
    const previousExchange = vi.mocked(dingtalk.exchangeCodeForUser).getMockImplementation()
    vi.mocked(dingtalk.exchangeCodeForUser).mockImplementation(exchangeCodeForUser)
    const response = await callback(await dingtalk.generateState()).finally(() => {
      if (previousExchange) vi.mocked(dingtalk.exchangeCodeForUser).mockImplementation(previousExchange)
    })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ success: false, error: STRICT_CONNECTION_ERROR, code: 'strict_connection' })
    expect(dingtalk.exchangeCodeForUser).not.toHaveBeenCalled()
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
    expect(providerFetch).not.toHaveBeenCalled()
    expect((await identitySnapshot()).rows).toEqual(original)
    expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(1)
  }, 60_000)

  it('password origin stays on the ordinary session path beside a committed scope', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: true,
      integration: true,
      scope: true,
      mustChange: true,
      session: true,
    })
    if (!env.token) throw new Error('B2_ISSUER_PASSWORD_SESSION_MISSING')
    const absent = await classifyAdminGrantActorInputSchema(queryable(env.witness))
    expect(absent).toBe('absent')
    const client = await env.witness.connect()
    let pending: ReturnType<typeof request> | undefined
    try {
      const holderPid = await readBackendPid(
        async (sql, params) => client.query(sql, params),
        'B2_ISSUER_HOLDER_PID_UNAVAILABLE',
      )
      await client.query('BEGIN')
      await client.query(
        'SELECT id FROM directory_integrations WHERE id = $1::uuid FOR UPDATE',
        [env.connectionId],
      )
      pending = request(app)
        .post('/api/auth/password/change')
        .set('Authorization', `Bearer ${env.token}`)
        .send({ password: NEW_PASSWORD })
      const response = await raceResponse(pending, 'PASSWORD_ORIGIN_WAITED_ON_INTEGRATION')
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(typeof (response.body.data as { token?: unknown }).token).toBe('string')
      await assertPasswordChangeBoundary(env, 'none')
      const held = await env.witness.query(
        `SELECT 1 AS held
           FROM pg_locks lk
           JOIN pg_class rel ON rel.oid = lk.relation
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE lk.pid = $1
            AND lk.granted
            AND rel.relname = 'directory_integrations'
            AND ns.nspname = $2`,
        [holderPid, env.schema],
      )
      expect(held.rowCount).toBeGreaterThan(0)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(2)
      const user = await env.witness.query(
        `SELECT must_change_password, local_password_set, password_hash
           FROM ${ident(env.schema, 'users')} WHERE id = $1`,
        [env.userId],
      )
      expect(user.rows[0]?.must_change_password).toBe(false)
      expect(user.rows[0]?.local_password_set).toBe(true)
      expect(await bcrypt.compare(NEW_PASSWORD, String(user.rows[0]?.password_hash))).toBe(true)
      const revocation = await env.witness.query(
        `SELECT reason FROM ${ident(env.schema, 'user_session_revocations')} WHERE user_id = $1`,
        [env.userId],
      )
      expect(revocation.rows[0]?.reason).toBe('password-change-required-cleared')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
      if (pending) await Promise.resolve(pending).catch(() => undefined)
    }
    expect(dingtalk.exchangeCodeForUser).not.toHaveBeenCalled()
  }, 60_000)

  it('required password change records version, establishment, and a later watermark, then accepts the new password', async () => {
    const env = await prepare({
      actor: 'ready',
      strict: false,
      integration: false,
      scope: false,
      mustChange: true,
      session: true,
    })
    if (!env.token) throw new Error('B2_ISSUER_PASSWORD_SESSION_MISSING')
    const ready = await classifyAdminGrantActorInputSchema(queryable(env.witness))
    expect(ready).toBe('ready')
    const changed = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${env.token}`)
      .send({ password: NEW_PASSWORD })
    expect(changed.status).toBe(200)
    expect(changed.body.success).toBe(true)
    await assertPasswordChangeBoundary(env, 'commit')
    const issued = authService.readTokenPayload(changed.body.data.token)
    expect(issued && !('xa' in issued)).toBe(true)
    const sessions = await env.witness.query(`SELECT id FROM ${ident(env.schema, 'user_sessions')}`)
    expect(sessions.rows.map((row) => row.id)).toContain(issued?.sid)
    expect(sessions.rows).toHaveLength(2)
    const user = await env.witness.query(
      `SELECT local_credential_version::text AS version, must_change_password, password_hash
         FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    expect(String(user.rows[0]?.version)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(user.rows[0]?.must_change_password).toBe(false)
    expect(await bcrypt.compare(NEW_PASSWORD, String(user.rows[0]?.password_hash))).toBe(true)
    const prior = authService.readTokenPayload(env.token)
    if (typeof prior?.sid !== 'string' || prior.sid.length === 0) {
      throw new Error('B2_ISSUER_PRIOR_SESSION_MISSING')
    }
    const established = await env.witness.query(
      `SELECT e.kind,
              e.credential_version::text AS version,
              e.user_id,
              e.source_session_id,
              (r.revoked_after >= e.established_at) AS watermark_covers_establishment,
              r.reason,
              r.updated_by
         FROM ${ident(env.schema, 'user_local_credential_establishments')} e
         JOIN ${ident(env.schema, 'user_session_revocations')} r
           ON r.user_id = e.user_id
        WHERE e.user_id = $1`,
      [env.userId],
    )
    expect(established.rows).toHaveLength(1)
    expect(established.rows[0]).toMatchObject({
      kind: 'self_password_change',
      version: user.rows[0]?.version,
      user_id: env.userId,
      source_session_id: prior.sid,
      watermark_covers_establishment: true,
      reason: 'password-change-required-cleared',
      updated_by: env.userId,
    })
    await waitUntilMintedIatClearsWatermark(env.witness, env.schema, env.userId)
    const denied = await request(app).post('/api/auth/login').send({ email: env.email, password: OLD_PASSWORD })
    expect(denied.status).toBe(401)
    const allowed = await request(app).post('/api/auth/login').send({ email: env.email, password: NEW_PASSWORD })
    expect(allowed.status).toBe(200)
    expect(typeof allowed.body.data.token).toBe('string')
    const loginPayload = authService.readTokenPayload(allowed.body.data.token)
    const context = await request(app)
      .post('/api/auth/session-context')
      .set('Authorization', `Bearer ${allowed.body.data.token}`)
      .send({})
    expect(context.status).toBe(200)
    expect(context.body.data).toMatchObject({
      userId: env.userId,
      sessionId: loginPayload?.sid,
      tokenIssuedAt: loginPayload?.iat,
    })
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(3)
  }, 60_000)

  it('required password change keeps the pre-provenance update when actor tables are absent', async () => {
    const env = await prepare({
      actor: 'absent',
      strict: false,
      integration: false,
      scope: false,
      mustChange: true,
      session: true,
    })
    if (!env.token) throw new Error('B2_ISSUER_PASSWORD_SESSION_MISSING')
    expect(await classifyAdminGrantActorInputSchema(queryable(env.witness))).toBe('absent')
    const changed = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${env.token}`)
      .send({ password: NEW_PASSWORD })
    expect(changed.status).toBe(200)
    await assertPasswordChangeBoundary(env, 'none')
    const user = await env.witness.query(
      `SELECT must_change_password, local_password_set, password_hash
         FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    expect(user.rows[0]?.must_change_password).toBe(false)
    expect(user.rows[0]?.local_password_set).toBe(true)
    expect(await bcrypt.compare(NEW_PASSWORD, String(user.rows[0]?.password_hash))).toBe(true)
    const revocation = await env.witness.query(
      `SELECT reason FROM ${ident(env.schema, 'user_session_revocations')} WHERE user_id = $1`,
      [env.userId],
    )
    expect(revocation.rows[0]?.reason).toBe('password-change-required-cleared')
    const relation = await env.witness.query(
      'SELECT to_regclass($1) AS name',
      [`${env.schema}.user_local_credential_establishments`],
    )
    expect(relation.rows[0]?.name).toBeNull()
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(2)
    const denied = await request(app).post('/api/auth/login').send({ email: env.email, password: OLD_PASSWORD })
    expect(denied.status).toBe(401)
    const allowed = await request(app).post('/api/auth/login').send({ email: env.email, password: NEW_PASSWORD })
    expect(allowed.status).toBe(200)
    expect(typeof allowed.body.data.token).toBe('string')
  }, 60_000)

  it('required password change refuses a partial actor installation before it writes credentials', async () => {
    const env = await prepare({
      actor: 'partial',
      strict: false,
      integration: false,
      scope: false,
      mustChange: true,
      session: true,
    })
    if (!env.token) throw new Error('B2_ISSUER_PASSWORD_SESSION_MISSING')
    expect(await classifyAdminGrantActorInputSchema(queryable(env.witness))).toBe('partial')
    const before = await env.witness.query(
      `SELECT password_hash, must_change_password FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    const response = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${env.token}`)
      .send({ password: NEW_PASSWORD })
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      success: false,
      error: 'Password change is unavailable',
    })
    await assertPasswordChangeBoundary(env, 'none')
    const after = await env.witness.query(
      `SELECT password_hash, must_change_password FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    expect(after.rows[0]?.password_hash).toBe(before.rows[0]?.password_hash)
    expect(after.rows[0]?.must_change_password).toBe(true)
    expect(await bcrypt.compare(OLD_PASSWORD, String(after.rows[0]?.password_hash))).toBe(true)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(1)
    expect(await countRows(env.witness, env.schema, 'user_local_credential_establishments')).toBe(0)
  }, 60_000)

  it('required password change does not fall back when the ready helper fails', async () => {
    const env = await prepare({
      actor: 'ready-failure',
      strict: false,
      integration: false,
      scope: false,
      mustChange: true,
      session: true,
    })
    if (!env.token) throw new Error('B2_ISSUER_PASSWORD_SESSION_MISSING')
    expect(await classifyAdminGrantActorInputSchema(queryable(env.witness))).toBe('ready')
    const before = await env.witness.query(
      `SELECT password_hash, must_change_password, local_password_set,
              local_credential_version::text AS local_credential_version
         FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    const response = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${env.token}`)
      .send({ password: NEW_PASSWORD })
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      success: false,
      error: 'Password change is unavailable',
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    await assertPasswordChangeBoundary(env, 'rollback')
    const provenance = state.transactions[2]
    expect(provenance?.started.some((sqlText) => sqlText.includes('INSERT INTO') && sqlText.includes('user_local_credential_establishments'))).toBe(true)
    expect(state.started.some((sqlText) => sqlText.includes('INSERT INTO') && sqlText.includes('user_local_credential_establishments'))).toBe(true)
    const after = await env.witness.query(
      `SELECT password_hash, must_change_password, local_password_set,
              local_credential_version::text AS local_credential_version
         FROM ${ident(env.schema, 'users')} WHERE id = $1`,
      [env.userId],
    )
    expect(after.rows[0]?.password_hash).toBe(before.rows[0]?.password_hash)
    expect(after.rows[0]?.must_change_password).toBe(true)
    expect(after.rows[0]?.local_password_set).toBe(before.rows[0]?.local_password_set)
    expect(after.rows[0]?.local_credential_version ?? null).toBe(before.rows[0]?.local_credential_version ?? null)
    expect(await bcrypt.compare(OLD_PASSWORD, String(after.rows[0]?.password_hash))).toBe(true)
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(1)
    expect(await countRows(env.witness, env.schema, 'user_local_credential_establishments')).toBe(0)
    expect(await countRows(env.witness, env.schema, 'user_session_revocations')).toBe(0)
  }, 60_000)

  it('serializes an unattributed login with the first scope, including rollback and lock timeout', async () => {
    const env = await prepare({ actor: 'absent', strict: true, integration: true, scope: false,
      mustChange: false, session: false, origin: 'null' })
    const login = await env.witness.connect()
    const cutover = await env.witness.connect()
    const loginPid = await readBackendPid((sql, params) => login.query(sql, params), 'LOGIN_PID_REQUIRED')
    const cutoverPid = await readBackendPid((sql, params) => cutover.query(sql, params), 'SCOPE_PID_REQUIRED')
    const begin = async (client: PoolClient) => {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await client.query("SET LOCAL lock_timeout = '4s'")
    }
    const insert = () => insertConnectionLoginScope(queryable(cutover), { connectionId: env.connectionId, commandId: SCOPE_COMMAND })
    const read = () => checkEmptyDingTalkScope(queryable(login))
    const waitForBlock = async (waiter: number, holder: number) => {
      const deadline = Date.now() + WAIT_MS
      do {
        const found = await env.witness.query('SELECT $1::int = ANY(pg_catalog.pg_blocking_pids($2)) AS held', [holder, waiter])
        if (found.rows[0]?.held) return
        await new Promise(resolve => setTimeout(resolve, 15))
      } while (Date.now() < deadline)
      throw new Error('SCOPE_LOCK_WAIT_MISSING')
    }
    try {
      await begin(login)
      await read()
      await begin(cutover)
      const inserting = insert().then(() => 'inserted', () => 'failed')
      await waitForBlock(cutoverPid, loginPid)
      await login.query('COMMIT')
      expect(await inserting).toBe('inserted')
      await cutover.query('ROLLBACK')

      // Each wait is observed by an independent PostgreSQL backend before the holder is released.
      for (const outcome of ['rollback', 'timeout', 'commit'] as const) {
        await begin(cutover)
        await insert()
        await begin(login)
        if (outcome === 'timeout') await login.query("SET LOCAL lock_timeout = '100ms'")
        const reading = read().then(() => 'allowed', (error: unknown) => error)
        if (outcome === 'timeout') {
          expect(await reading).toMatchObject({ statusCode: 503, code: 'grant_state_unavailable' })
          await login.query('ROLLBACK')
          await cutover.query('ROLLBACK')
          continue
        }
        await waitForBlock(loginPid, cutoverPid)
        await cutover.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK')
        if (outcome === 'commit') expect(await reading).toMatchObject({ statusCode: 403, code: 'strict_connection' })
        else expect(await reading).toBe('allowed')
        await login.query('ROLLBACK')
      }
      expect(await countRows(env.witness, env.schema, 'directory_connection_login_scope')).toBe(1)
      expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
    } finally {
      await Promise.all([login.query('ROLLBACK'), cutover.query('ROLLBACK')])
      login.release()
      cutover.release()
    }
  }, 60_000)

  it('uses the configured exchange application and validates every supplied selector', async () => {
    const env = await prepare({ actor: 'absent', strict: true, integration: true, scope: false,
      mustChange: false, session: false })
    const config = { DINGTALK_CLIENT_ID: '  ', DINGTALK_APP_KEY: ' b2-issuer-client ' }
    const { connectionId } = env
    const corpId = 'fixture-corp'
    const source = await resolveDingTalkLoginSource({ connectionId, corpId }, config)
    expect(source).toEqual({ connectionId, corpId, orgId: 'default', appKey: 'b2-issuer-client',
      configuredCorp: null, explicit: true, strict: false })
    for (const selector of [
      { connectionId: null }, { connectionId: 123 }, { connectionId: 'invalid' },
      { corpId: '' }, { corpId: ' ' }, { corpId: 'other-corp', connectionId },
      { corpId, connectionId: randomUUID() },
    ]) {
      await expect(async () => resolveDingTalkLoginSource(selector, config)).rejects.toMatchObject({
        statusCode: 403, code: 'strict_connection',
      })
    }
    expect(await countRows(env.witness, env.schema, 'user_sessions')).toBe(0)
  }, 60_000)
})
