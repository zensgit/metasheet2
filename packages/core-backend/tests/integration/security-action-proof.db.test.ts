/**
 * One-time action proofs against real Postgres: the security_action_challenges schema, every CHECK, the
 * foreign key, the partial unique index and the transition trigger; the guarded down()/up() round trip
 * with its timeout restore; issuance and consumption bindings, every invalidation, the per-user failure
 * limit across sessions and purposes, read-committed pinning on a repeatable-read-default pool, and
 * lock order under concurrency. Real PG transactions only; no provider or network calls.
 *
 * Every purpose is made available to the service instance under test by injection; the production
 * binding is never used here. Committed fixtures are removed in afterAll.
 */
import { createHash, randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import type { Request } from 'express'
import { authService } from '../../src/auth/AuthService'
import { SECURITY_ACTION_POLICY_REVISION, SECURITY_ACTION_PURPOSE_REGISTRY, SECURITY_ACTION_PURPOSES } from '../../src/auth/external-login-assurance'
import type { SecurityActionPurpose } from '../../src/auth/external-login-assurance'
import { assessSecurityActionPrivilege } from '../../src/auth/security-action-privilege'
import {
  clientBindingDigestOf,
  computeCredentialWitness,
  createSecurityActionProofService,
  hashProofSecret,
  parseProof,
  readAuthenticatedSessionContext,
  SECURITY_ACTION_SQL,
  SecurityActionProofContractError,
  SecurityActionProofError,
} from '../../src/auth/security-action-proof'
import type {
  AuthenticatedSessionContext,
  SecurityActionAuditEvent,
  SecurityActionConsumeInput,
  SecurityActionErrorCode,
  SecurityActionTargetResolver,
  SecurityActionVerifyRequest,
} from '../../src/auth/security-action-proof'
import { revokeUserSession } from '../../src/auth/session-registry'
import { revokeUserSessions } from '../../src/auth/session-revocation'
import { down, SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE, up } from '../../src/db/migrations/zzzz20261106120000_create_security_action_challenges'
import { lockUsersForAccessGraphWrite, supersedeDeprovisionEvidenceForAccessGraphWrite } from '../../src/directory/access-graph-mutex'
import type { LockedAccessGraphUser } from '../../src/directory/access-graph-mutex'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const suite = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())

const TABLE = 'security_action_challenges'
const ORG = 'p04b-org-' + randomUUID()
const OTHER_ORG = 'p04b-org-' + randomUUID()
const CONNECTION = randomUUID()
const OTHER_CONNECTION = randomUUID()
const TARGET_IDENTITY = randomUUID()
const PASSWORD = 'correct-horse-' + randomUUID()
const WRONG = 'wrong-' + randomUUID()
const ROLLBACK = Symbol('p04b-rollback')

type Runner = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

function withOptions(options: string): string {
  const base = process.env.DATABASE_URL ?? ''
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}options=${encodeURIComponent(options)}`
}

let mainPool: PgPool | null = null
let rrPool: PgPool | null = null
let absentPool: PgPool | null = null
function pool(): PgPool {
  mainPool ??= new PgPool({ connectionString: process.env.DATABASE_URL, max: 8 })
  return mainPool
}
function repeatableReadPool(): PgPool {
  rrPool ??= new PgPool({ connectionString: withOptions('-c default_transaction_isolation=repeatable\\ read'), max: 8 })
  return rrPool
}
function absentSchemaPool(): PgPool {
  absentPool ??= new PgPool({ connectionString: withOptions('-c search_path=p04b_absent'), max: 2 })
  return absentPool
}

const q: Runner = async (sql, params = []) => (await pool().query(sql, params)) as { rows: Array<Record<string, unknown>> }

function executorOf(client: PoolClient): Queryable {
  return { query: async (sql, params) => client.query(sql, params) }
}

const savedEnv = new Map<string, string | undefined>()
const seededUsers: string[] = []

beforeAll(() => {
  for (const key of ['SECURITY_ACTION_PROOF_ENABLED', 'PRODUCT_MODE']) savedEnv.set(key, process.env[key])
  process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
  process.env.PRODUCT_MODE = 'plm-workbench'
})

afterAll(async () => {
  if (mainPool && seededUsers.length > 0) {
    await q(`DELETE FROM ${TABLE} WHERE user_id = ANY($1::text[])`, [seededUsers])
    await q('DELETE FROM user_sessions WHERE user_id = ANY($1::text[])', [seededUsers])
    await q('DELETE FROM user_session_revocations WHERE user_id = ANY($1::text[])', [seededUsers])
    await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [seededUsers])
    await q('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUsers])
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [seededUsers])
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [seededUsers])
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all([mainPool?.end(), rrPool?.end(), absentPool?.end()])
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type UserSeed = { localPasswordSet?: boolean; mustChange?: boolean; isActive?: boolean; isAdmin?: boolean; role?: string; legacy?: unknown; orgs?: string[] }

async function seedUser(seed: UserSeed = {}): Promise<string> {
  const id = 'p04b-' + randomUUID()
  const hash = await bcrypt.hash(PASSWORD, 4)
  await q(
    `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set, must_change_password)
     VALUES ($1, $1, $1, $1, $2, $3, $4, $5, $6::jsonb, 'activated', $7, $8)`,
    [id, hash, seed.isActive ?? true, seed.isAdmin ?? false, seed.role ?? 'user', JSON.stringify(seed.legacy ?? []), seed.localPasswordSet ?? true, seed.mustChange ?? false],
  )
  for (const org of seed.orgs ?? [ORG]) await q('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [id, org])
  seededUsers.push(id)
  return id
}

async function seedSession(userId: string, options: { expired?: boolean } = {}): Promise<string> {
  const sid = 'p04b-sid-' + randomUUID()
  await q(
    `INSERT INTO user_sessions (id, user_id, expires_at) VALUES ($1, $2, ${options.expired ? "now() - interval '1 minute'" : "now() + interval '1 hour'"})`,
    [sid, userId],
  )
  return sid
}

function tokenOf(userId: string, sid: string, org: string | null = ORG): string {
  return authService.createToken(
    { id: userId, email: null, name: userId, role: 'user', permissions: [], created_at: new Date(), updated_at: new Date(), ...(org ? { tenantId: org } : {}) },
    { sid },
  )
}

function contextOf(userId: string, sid: string, org: string | null = ORG, token = tokenOf(userId, sid, org)): AuthenticatedSessionContext {
  const req = { user: { id: userId }, ...(org ? { authenticatedTenantId: org } : {}), headers: { authorization: `Bearer ${token}` } } as unknown as Request
  const context = readAuthenticatedSessionContext(req)
  if (!context) throw new Error('context construction failed')
  return context
}

async function grantRole(userId: string, roleId: string, codes: readonly string[] = []): Promise<void> {
  await q('INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [roleId])
  await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
  for (const code of codes) {
    await q('INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [code])
    await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, code])
  }
}

async function grantDirect(userId: string, code: string): Promise<void> {
  await q('INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [code])
  await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [userId, code])
}

// ---------------------------------------------------------------------------
// Service under test
// ---------------------------------------------------------------------------

type ServiceOptions = {
  pool?: PgPool
  targetRevision?: { value: string }
  beforeCompare?: () => Promise<void>
  policyRevision?: number
  pids?: number[]
  requests?: unknown[]
}

function fakeResolver(purpose: SecurityActionPurpose, revision: { value: string }): SecurityActionTargetResolver {
  return async (_executor, request) => ({
    ok: true,
    kind: SECURITY_ACTION_PURPOSE_REGISTRY[purpose].targetKind,
    witness: createHash('sha256').update(JSON.stringify([purpose, request, revision.value])).digest('hex'),
  })
}

function runnerOf(target: PgPool, pids?: number[]) {
  return async <T>(work: (executor: Queryable) => Promise<T>): Promise<T> => {
    const client = await target.connect()
    try {
      if (pids) pids.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
      await client.query('BEGIN')
      try {
        const result = await work(executorOf(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    } finally {
      client.release()
    }
  }
}

function serviceOn(options: ServiceOptions = {}) {
  const revision = options.targetRevision ?? { value: 'r1' }
  const audits: SecurityActionAuditEvent[] = []
  const compares: number[] = []
  const resolvers = Object.fromEntries(SECURITY_ACTION_PURPOSES.map((purpose) => [purpose, fakeResolver(purpose, revision)])) as Record<SecurityActionPurpose, SecurityActionTargetResolver>
  const service = createSecurityActionProofService({
    isPurposeAvailable: () => true,
    resolvers,
    runTransaction: runnerOf(options.pool ?? pool(), options.pids),
    verifyPassword: async (password, hash) => {
      compares.push(1)
      await options.beforeCompare?.()
      return bcrypt.compare(password, hash)
    },
    recordAudit: async (event) => { audits.push(event) },
    policyRevision: options.policyRevision ?? SECURITY_ACTION_POLICY_REVISION,
  })
  return { service, audits, compares, revision }
}

function request(overrides: Partial<Record<keyof SecurityActionVerifyRequest, unknown>> = {}): SecurityActionVerifyRequest {
  const base: Record<string, unknown> = { purpose: 'external_identity_unbind', connectionId: CONNECTION, targetIdentityId: TARGET_IDENTITY, expectedBindingRevision: 2, method: 'local_password', password: PASSWORD }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key]
    else base[key] = value
  }
  return base as SecurityActionVerifyRequest
}

function bindRequest(overrides: Partial<Record<keyof SecurityActionVerifyRequest, unknown>> = {}): SecurityActionVerifyRequest {
  return request({ purpose: 'external_identity_bind', targetIdentityId: undefined, expectedBindingRevision: undefined, ...overrides })
}

async function expectRefusal(promise: Promise<unknown>, code: SecurityActionErrorCode): Promise<SecurityActionProofError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SecurityActionProofError)
    expect((error as SecurityActionProofError).code).toBe(code)
    return error as SecurityActionProofError
  }
  throw new Error(`expected ${code}`)
}

async function rowsOf(userId: string): Promise<Array<Record<string, unknown>>> {
  return (await q(`SELECT * FROM ${TABLE} WHERE user_id = $1 ORDER BY created_at`, [userId])).rows
}

async function witnessFor(purpose: SecurityActionPurpose, req: SecurityActionVerifyRequest, userId: string, revision: { value: string }): Promise<string> {
  const resolution = await fakeResolver(purpose, revision)({ query: async () => ({ rows: [], rowCount: 0 }) }, {
    userId, orgId: ORG, connectionId: req.connectionId, targetIdentityId: req.targetIdentityId ?? null,
    expectedBindingRevision: req.expectedBindingRevision === undefined ? null : String(req.expectedBindingRevision),
  })
  if (resolution.ok !== true) throw new Error('resolver refused')
  return resolution.witness
}

/** One caller transaction: BEGIN at the given isolation, lock the user, run `work`, then commit or roll back. */
async function callerTransaction<T>(userId: string, work: (client: Queryable, locked: LockedAccessGraphUser, raw: PoolClient) => Promise<T>, options: { isolation?: string; commit?: boolean; pool?: PgPool; bareBegin?: boolean; lock?: boolean } = {}): Promise<T> {
  const client = await (options.pool ?? pool()).connect()
  try {
    await client.query(options.bareBegin ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`)
    await client.query("SET LOCAL lock_timeout = '5s'")
    const executor = executorOf(client)
    let locked: LockedAccessGraphUser | undefined
    if (options.lock !== false) locked = (await lockUsersForAccessGraphWrite(executor, [userId])).get(userId)
    try {
      const result = await work(executor, locked ?? manualLockedUser(userId), client)
      await client.query(options.commit === false ? 'ROLLBACK' : 'COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    client.release()
  }
}

function manualLockedUser(id: string): LockedAccessGraphUser {
  return { id, name: null, email: null, username: null, mobile: null, activationStatus: 'activated', isActive: true, accessGeneration: 0, deletedAt: null, purgedAt: null }
}

function consumeInput(proof: string, overrides: Partial<SecurityActionConsumeInput> = {}): Omit<SecurityActionConsumeInput, 'lockedUser'> {
  return { proof, purpose: 'external_identity_unbind', connectionId: CONNECTION, target: { kind: 'identity_revision', witness: '' }, ...overrides }
}

async function issueFor(userId: string, sid: string, service: ReturnType<typeof serviceOn>, req: SecurityActionVerifyRequest = request(), org: string | null = ORG) {
  const context = contextOf(userId, sid, org)
  const issued = await service.service.issue(context, req)
  const witness = await witnessFor(req.purpose, req, userId, service.revision)
  return { context, issued, witness, kind: SECURITY_ACTION_PURPOSE_REGISTRY[req.purpose].targetKind }
}

async function consumeWith(userId: string, context: AuthenticatedSessionContext, service: ReturnType<typeof serviceOn>, input: Omit<SecurityActionConsumeInput, 'lockedUser'>, options: { commit?: boolean; isolation?: string; pool?: PgPool; bareBegin?: boolean } = {}) {
  return callerTransaction(userId, (client, locked) => service.service.consume(client, context, { ...input, lockedUser: locked }), options)
}

async function waitUntilBlocked(waiterPid: number, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = (await q(
      `SELECT query FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`,
      [waiterPid],
    )).rows
    if (rows.length === 1) return String(rows[0].query)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the backend to block')
}

async function waitUntilBlockedCount(pids: number[], expected: number, timeoutMs = 4_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < deadline) {
    count = Number((await q(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state = 'active' AND wait_event_type = 'Lock'`,
      [pids],
    )).rows[0].n)
    if (count >= expected) return count
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return count
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

type Column = { name: string; type: string; nullable: string; def: string | null }

async function columns(run: Runner): Promise<Column[]> {
  return (await run(
    `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS def
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [TABLE],
  )).rows as Column[]
}

async function constraints(run: Runner): Promise<Array<{ name: string; def: string }>> {
  return (await run(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
    [`public.${TABLE}`],
  )).rows as Array<{ name: string; def: string }>
}

async function indexes(run: Runner): Promise<Array<{ name: string; def: string }>> {
  return (await run(`SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [TABLE])).rows as Array<{ name: string; def: string }>
}

async function catalog(run: Runner) {
  return { columns: await columns(run), constraints: await constraints(run), indexes: await indexes(run) }
}

type RowSeed = Partial<Record<string, unknown>>

async function insertRow(run: Runner, userId: string, overrides: RowSeed = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: randomUUID(), user_id: userId, session_id: 'sid-' + randomUUID(), org_id: ORG, purpose: 'external_identity_unbind', connection_id: CONNECTION,
    target_kind: 'identity_revision', target_identity_id: TARGET_IDENTITY, expected_binding_revision: 1, target_witness: 'a'.repeat(64), method: 'local_password',
    method_connection_id: null, assurance: 'local_password', status: 'issued', failure_code: null, proof_hash: 'b'.repeat(64), client_binding_digest: null,
    policy_revision: 1, access_generation: 0, credential_witness: 'c'.repeat(64), privilege_witness: 'd'.repeat(64), privilege_class: 'standard',
    expires_at: null, consumed_at: null, consumed_action_ref: null, superseded_at: null, created_at: null,
    ...overrides,
  }
  const keys = Object.keys(row).filter((key) => !(key === 'created_at' && row.created_at === null))
  const expiresExpression = row.expires_at === null && row.status !== 'failed' ? "now() + interval '300 seconds'" : null
  const values = keys.map((key, index) => (key === 'expires_at' && expiresExpression ? expiresExpression : `$${index + 1}`))
  await run(`INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${values.join(', ')})`, keys.map((key) => (key === 'expires_at' && expiresExpression ? null : row[key])))
  return String(row.id)
}

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

async function withRollback<T>(fn: (run: Runner, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    const run: Runner = async (sql, params) => client.query(sql, params) as Promise<{ rows: Array<Record<string, unknown>> }>
    return await fn(run, client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }
}

/** A savepoint so one failing statement does not abort the rolled-back case. */
async function failing(run: Runner, sql: string, params: unknown[]): Promise<unknown> {
  await run('SAVEPOINT p04b')
  try {
    return await run(sql, params)
  } finally {
    await run('ROLLBACK TO SAVEPOINT p04b')
  }
}

/** An insert expected to be refused with `code`, run under a savepoint. */
async function refusedInsert(run: Runner, userId: string, overrides: RowSeed, code: string): Promise<void> {
  await run('SAVEPOINT p04b_insert')
  try {
    await expectSqlState(insertRow(run, userId, overrides), code)
  } finally {
    await run('ROLLBACK TO SAVEPOINT p04b_insert')
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

suite('migration', () => {
  it('creates the reviewed columns, constraints, indexes, validated foreign key and row trigger', async () => {
    const current = await catalog(q)
    expect(current.columns.map((c) => [c.name, c.type, c.nullable, c.def])).toEqual([
      ['id', 'uuid', 'NO', null], ['user_id', 'text', 'NO', null], ['session_id', 'text', 'NO', null], ['org_id', 'text', 'YES', null],
      ['purpose', 'text', 'NO', null], ['connection_id', 'uuid', 'YES', null], ['target_kind', 'text', 'NO', null], ['target_identity_id', 'uuid', 'YES', null],
      ['expected_binding_revision', 'bigint', 'YES', null], ['target_witness', 'text', 'NO', null], ['method', 'text', 'NO', null], ['method_connection_id', 'uuid', 'YES', null],
      ['assurance', 'text', 'YES', null], ['status', 'text', 'NO', null], ['failure_code', 'text', 'YES', null], ['proof_hash', 'text', 'YES', null],
      ['client_binding_digest', 'text', 'YES', null], ['policy_revision', 'integer', 'NO', null], ['access_generation', 'bigint', 'NO', null],
      ['credential_witness', 'text', 'NO', null], ['privilege_witness', 'text', 'NO', null], ['privilege_class', 'text', 'NO', null],
      ['created_at', 'timestamp with time zone', 'NO', 'now()'], ['expires_at', 'timestamp with time zone', 'YES', null],
      ['consumed_at', 'timestamp with time zone', 'YES', null], ['consumed_action_ref', 'text', 'YES', null], ['superseded_at', 'timestamp with time zone', 'YES', null],
    ])
    expect(current.constraints.map((c) => c.name)).toEqual([
      'security_action_challenges_action_ref_chk', 'security_action_challenges_action_ref_status_chk', 'security_action_challenges_binding_revision_chk',
      'security_action_challenges_client_binding_chk', 'security_action_challenges_consumed_chk', 'security_action_challenges_empty_slot_chk',
      'security_action_challenges_failed_shape_chk', 'security_action_challenges_identity_target_chk', 'security_action_challenges_method_chk',
      'security_action_challenges_method_connection_chk', 'security_action_challenges_pkey', 'security_action_challenges_policy_revision_chk',
      'security_action_challenges_privilege_class_chk', 'security_action_challenges_proof_hash_chk', 'security_action_challenges_proof_shape_chk',
      'security_action_challenges_purpose_chk', 'security_action_challenges_status_chk', 'security_action_challenges_superseded_chk',
      'security_action_challenges_target_kind_chk', 'security_action_challenges_ttl_chk', 'security_action_challenges_user_fk', 'security_action_challenges_witness_chk',
    ])
    expect(current.constraints.find((c) => c.name === 'security_action_challenges_user_fk')?.def).toBe('FOREIGN KEY (user_id) REFERENCES users(id)')
    expect(current.indexes.find((i) => i.name === 'uq_security_action_live_proof')?.def).toContain("WHERE (status = 'issued'::text)")
    expect(current.indexes.map((i) => i.name)).toEqual(['idx_security_action_user_created', 'security_action_challenges_pkey', 'uq_security_action_live_proof'])
    const fk = (await q(`SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'security_action_challenges_user_fk'`)).rows[0]
    expect(fk).toEqual({ convalidated: true, confdeltype: 'a' })
    const trigger = (await q(`SELECT tgenabled, tgtype FROM pg_trigger WHERE tgname = 'security_action_challenge_transition' AND tgrelid = $1::regclass`, [`public.${TABLE}`])).rows[0]
    expect(trigger.tgenabled).toBe('O')
    // BEFORE (2) | INSERT (4) | UPDATE (16) | ROW (1)
    expect(Number(trigger.tgtype)).toBe(23)
  })

  it('refuses every shape outside the reviewed CHECKs with 23514', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const violations: RowSeed[] = [
        { purpose: 'other' }, { target_kind: 'other' },
        { target_kind: 'identity_revision', target_identity_id: null }, { target_kind: 'identity_revision', expected_binding_revision: null },
        { target_kind: 'empty_slot' }, { expected_binding_revision: -1 },
        { method: 'other' }, { method: 'local_password', method_connection_id: randomUUID() }, { method: 'external_reauth', assurance: 'external_platform_asserted' },
        { status: 'other' }, { privilege_class: 'other' }, { policy_revision: 0 },
        { target_witness: 'zz' }, { credential_witness: 'Z'.repeat(64) }, { privilege_witness: 'z'.repeat(63) },
        { proof_hash: 'zz' }, { client_binding_digest: 'Z'.repeat(64) }, { consumed_action_ref: 'has space' },
        { status: 'failed', failure_code: 'credential_rejected', proof_hash: 'b'.repeat(64) },
        { status: 'failed', failure_code: 'other' }, { status: 'failed', failure_code: 'credential_rejected', client_binding_digest: 'a'.repeat(64) },
        { proof_hash: null }, { assurance: null }, { assurance: 'other' }, { failure_code: 'credential_rejected' },
        { consumed_action_ref: 'ref' }, { status: 'issued', consumed_at: new Date() },
      ]
      for (const violation of violations) await refusedInsert(run, userId, violation, '23514')
      await expect(insertRow(run, userId)).resolves.toBeTruthy()
      await expect(insertRow(run, userId, { purpose: 'external_identity_bind', target_kind: 'empty_slot', target_identity_id: null, expected_binding_revision: null })).resolves.toBeTruthy()
      await expect(insertRow(run, userId, { status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null, expires_at: null })).resolves.toBeTruthy()
    })
  })

  it('refuses a row for a user that does not exist with 23503', async () => {
    await withRollback(async (run) => {
      await expectSqlState(insertRow(run, 'p04b-absent-' + randomUUID()), '23503')
    })
  })

  it('allows at most one issued row per user, session and purpose, while failed and superseded rows share the key', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const sid = 'sid-' + randomUUID()
      await insertRow(run, userId, { session_id: sid })
      await refusedInsert(run, userId, { session_id: sid }, '23505')
      await expect(insertRow(run, userId, { session_id: sid, status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null })).resolves.toBeTruthy()
      const third = await insertRow(run, userId, { session_id: 'sid-' + randomUUID() })
      await run(`UPDATE ${TABLE} SET session_id = session_id WHERE false`)
      await failing(run, `UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [third]).catch(() => undefined)
      await run(`UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [third])
      await expect(insertRow(run, userId, { session_id: sid })).rejects.toMatchObject({ code: '23505' })
    })
  })

  it('admits rows only as issued or failed and not dated in the future, allows only issued->consumed and issued->superseded, and never any other column change', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      await refusedInsert(run, userId, { status: 'consumed', consumed_at: new Date() }, '55000')
      await refusedInsert(run, userId, { status: 'superseded', superseded_at: new Date() }, '55000')
      await refusedInsert(run, userId, { created_at: new Date(Date.now() + 60_000) }, '55000')
      const issued = await insertRow(run, userId)
      const failed = await insertRow(run, userId, { status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null })
      await expectSqlState(failing(run, `UPDATE ${TABLE} SET target_witness = $2 WHERE id = $1`, [issued, 'e'.repeat(64)]), '55000')
      await expectSqlState(failing(run, `UPDATE ${TABLE} SET status = 'consumed', consumed_at = now(), target_witness = $2 WHERE id = $1`, [issued, 'e'.repeat(64)]), '55000')
      await expectSqlState(failing(run, `UPDATE ${TABLE} SET status = 'issued', failure_code = NULL, proof_hash = $2, assurance = 'local_password', expires_at = now() + interval '1 second' WHERE id = $1`, [failed, 'b'.repeat(64)]), '55000')
      await run(`UPDATE ${TABLE} SET status = 'consumed', consumed_at = now(), consumed_action_ref = 'ref' WHERE id = $1`, [issued])
      await expectSqlState(failing(run, `UPDATE ${TABLE} SET status = 'issued', consumed_at = NULL, consumed_action_ref = NULL WHERE id = $1`, [issued]), '55000')
      const second = await insertRow(run, userId)
      await run(`UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [second])
      await run(`DELETE FROM ${TABLE} WHERE id = ANY($1::uuid[])`, [[issued, second, failed]])
      expect((await run(`SELECT count(*)::int AS n FROM ${TABLE} WHERE user_id = $1`, [userId])).rows[0].n).toBe(0)
    })
  })

  it('caps the lifetime at 300 seconds after creation', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      await expect(insertRow(run, userId, { created_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-01T00:05:00Z') })).resolves.toBeTruthy()
      await refusedInsert(run, userId, { created_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-01T00:05:01Z') }, '23514')
      await refusedInsert(run, userId, { created_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-01T00:00:00Z') }, '23514')
    })
  })

  it('round-trips down() and up() inside one rolled-back transaction and restores the timeouts it read', async () => {
    const userId = await seedUser()
    const sentinel = await insertRow(q, userId, { status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null })
    const oidBefore = String((await q(`SELECT 'public.${TABLE}'::regclass::oid::text AS oid`)).rows[0].oid)
    const before = await catalog(q)
    const kpool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 1 })
    const kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kpool }) })
    let reachedEnd = false
    try {
      await kdb.transaction().execute(async (trx) => {
        const run: Runner = async (text, params = []) => ({ rows: (await trx.executeQuery(CompiledQuery.raw(text, params))).rows as Array<Record<string, unknown>> })
        await run("SELECT set_config('lock_timeout', '7s', true), set_config('statement_timeout', '42s', true)")
        const read = async () => (await run("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s")).rows[0]
        expect(await read()).toEqual({ l: '7s', s: '42s' })
        await run(`DELETE FROM ${TABLE}`)
        await down(trx)
        expect((await run(`SELECT to_regclass('public.${TABLE}')::text AS r`)).rows[0].r).toBeNull()
        expect((await run(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'guard_security_action_challenge_transition'`)).rows[0].n).toBe(0)
        expect(await read()).toEqual({ l: '7s', s: '42s' })
        await up(trx)
        const after = await catalog(run)
        expect(after).toEqual(before)
        expect(await read()).toEqual({ l: '7s', s: '42s' })
        reachedEnd = true
        throw ROLLBACK
      })
    } catch (error) {
      if (error !== ROLLBACK) throw error
    } finally {
      await kdb.destroy()
    }
    expect(reachedEnd).toBe(true)
    expect(String((await q(`SELECT 'public.${TABLE}'::regclass::oid::text AS oid`)).rows[0].oid)).toBe(oidBefore)
    expect((await q(`SELECT count(*)::int AS n FROM ${TABLE} WHERE id = $1::uuid`, [sentinel])).rows[0].n).toBe(1)
  })

  it('refuses down() while the table holds a row and leaves the table in place', async () => {
    const userId = await seedUser()
    const kpool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 1 })
    const kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kpool }) })
    let refused: unknown = null
    try {
      await kdb.transaction().execute(async (trx) => {
        const run: Runner = async (text, params = []) => ({ rows: (await trx.executeQuery(CompiledQuery.raw(text, params))).rows as Array<Record<string, unknown>> })
        await insertRow(run, userId)
        try {
          await down(trx)
        } catch (error) {
          refused = error
        }
        expect((await run(`SELECT to_regclass('public.${TABLE}')::text AS r`)).rows[0].r).toBe(TABLE)
        throw ROLLBACK
      })
    } catch (error) {
      if (error !== ROLLBACK) throw error
    } finally {
      await kdb.destroy()
    }
    expect(refused).toMatchObject({ code: SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE })
  })

  it('consumes only a live issued row through the atomic update: a consumed or expired row updates nothing without a trigger error', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const sid = 'sid-' + randomUUID()
      const consumed = await insertRow(run, userId, { session_id: sid })
      await run(`UPDATE ${TABLE} SET status = 'consumed', consumed_at = now() WHERE id = $1`, [consumed])
      expect((await run(SECURITY_ACTION_SQL.consume, [consumed, userId, sid, 'external_identity_unbind', null])).rows).toEqual([])
      const expired = await insertRow(run, userId, { session_id: sid, created_at: new Date(Date.now() - 400_000), expires_at: new Date(Date.now() - 100_000) })
      expect((await run(SECURITY_ACTION_SQL.consume, [expired, userId, sid, 'external_identity_unbind', null])).rows).toEqual([])
      const live = await insertRow(run, userId, { session_id: 'sid-' + randomUUID() })
      const row = (await run(`SELECT session_id FROM ${TABLE} WHERE id = $1`, [live])).rows[0]
      expect((await run(SECURITY_ACTION_SQL.consume, [live, userId, row.session_id, 'external_identity_unbind', 'ref-1'])).rows).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

suite('issuance', () => {
  it('issues one proof bound to the user, session, organization, target and witnesses, storing only the hash', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { issued, witness } = await issueFor(userId, sid, service)
    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    const secret = parseProof(issued.proof)!.secret
    expect(row.status).toBe('issued')
    expect(row.session_id).toBe(sid)
    expect(row.org_id).toBe(ORG)
    expect(row.connection_id).toBe(CONNECTION)
    expect(row.target_identity_id).toBe(TARGET_IDENTITY)
    expect(String(row.expected_binding_revision)).toBe('2')
    expect(row.target_witness).toBe(witness)
    expect(row.proof_hash).toBe(hashProofSecret(secret))
    expect(Number(row.policy_revision)).toBe(SECURITY_ACTION_POLICY_REVISION)
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
    const lifetime = (await q(`SELECT extract(epoch FROM (expires_at - created_at))::int AS s FROM ${TABLE} WHERE id = $1::uuid`, [row.id])).rows[0].s
    expect(Number(lifetime)).toBe(300)
    expect(new Date(issued.expiresAt).getTime()).toBe((row.expires_at as Date).getTime())
    const account = (await q(SECURITY_ACTION_SQL.account, [userId])).rows[0]
    expect(row.credential_witness).toBe(computeCredentialWitness({
      passwordHash: String(account.password_hash), localPasswordSet: account.local_password_set as boolean, mustChangePassword: account.must_change_password as boolean,
      activationStatus: String(account.activation_status), isActive: account.is_active as boolean, role: account.role as string, deletedAt: null, purgedAt: null, accessGeneration: String(account.access_generation),
    }))
    await withRollback(async (_run, client) => {
      const assessed = await assessSecurityActionPrivilege(executorOf(client), userId)
      expect(row.privilege_witness).toBe(assessed.witness)
      expect(row.privilege_class).toBe(assessed.privilegeClass)
    })
    expect(service.audits.map((a) => a.meta.result)).toEqual(['issued'])
  })

  it('records a rejected credential as a failed row, with or without a client binding digest, and refuses with a next step', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), request({ password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    expect(refusal.details).toEqual({ nextStep: 'admin_assisted_local_credential' })
    await expectRefusal(service.service.issue(contextOf(userId, sid), request({ password: WRONG, clientBindingDigest: 'e'.repeat(64) })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    const rows = await rowsOf(userId)
    expect(rows.map((r) => [r.status, r.failure_code, r.proof_hash, r.expires_at, r.assurance, r.client_binding_digest])).toEqual([
      ['failed', 'credential_rejected', null, null, null, null], ['failed', 'credential_rejected', null, null, null, null],
    ])
  })

  it('refuses with 429 before comparing the password once five failures were recorded, and allows again once they age out', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    for (let attempt = 0; attempt < 5; attempt += 1) await expectRefusal(service.service.issue(contextOf(userId, sid), request({ password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    expect((await rowsOf(userId)).filter((r) => r.status === 'failed')).toHaveLength(5)
    const compares = service.compares.length
    const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), request()), 'SECURITY_ACTION_RATE_LIMITED')
    expect(refusal.details?.nextStep).toBe('admin_assisted_local_credential')
    expect(refusal.details?.retryAfter).toBeGreaterThan(0)
    expect(refusal.details?.retryAfter).toBeLessThanOrEqual(900)
    expect(service.compares).toHaveLength(compares)
    expect(await rowsOf(userId)).toHaveLength(5)
    const aged = await seedUser()
    const agedSid = await seedSession(aged)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await insertRow(q, aged, { status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null, created_at: new Date(Date.now() - 16 * 60_000) })
    }
    await expect(service.service.issue(contextOf(aged, agedSid), request())).resolves.toMatchObject({ ttlSeconds: 300 })
  })

  it('counts failures per user across sessions and purposes: three on one session and two on another block a third session before any comparison', async () => {
    const userId = await seedUser()
    const [a, b, c] = [await seedSession(userId), await seedSession(userId), await seedSession(userId)]
    const service = serviceOn()
    for (let attempt = 0; attempt < 3; attempt += 1) await expectRefusal(service.service.issue(contextOf(userId, a), request({ password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    for (let attempt = 0; attempt < 2; attempt += 1) await expectRefusal(service.service.issue(contextOf(userId, b), request({ purpose: 'login_grant_disable', password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    const compares = service.compares.length
    await expectRefusal(service.service.issue(contextOf(userId, c), bindRequest()), 'SECURITY_ACTION_RATE_LIMITED')
    expect(service.compares).toHaveLength(compares)
    expect(await rowsOf(userId)).toHaveLength(5)
  })

  it.each([
    ['no local password is set on an otherwise active account', { localPasswordSet: false }],
    ['a password change is required', { mustChange: true }],
  ] satisfies Array<[string, UserSeed]>)('refuses with 403 METHOD_UNAVAILABLE and a next step, writing nothing and comparing nothing, when %s', async (_label, seed) => {
    const userId = await seedUser({ ...seed, isActive: true })
    const sid = await seedSession(userId)
    const service = serviceOn()
    const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), request()), 'SECURITY_ACTION_METHOD_UNAVAILABLE')
    expect(refusal.status).toBe(403)
    expect(refusal.details).toEqual({ nextStep: 'admin_assisted_local_credential' })
    expect(service.compares).toEqual([])
    expect(await rowsOf(userId)).toEqual([])
  })

  it('refuses with 401 for a revoked or expired session, and for a token issued at or before the revocation watermark', async () => {
    const userId = await seedUser()
    const service = serviceOn()
    const revoked = await seedSession(userId)
    await revokeUserSession(revoked, { revokedBy: userId, reason: 'test' })
    await expectRefusal(service.service.issue(contextOf(userId, revoked), request()), 'SECURITY_ACTION_SESSION_REQUIRED')
    const expired = await seedSession(userId, { expired: true })
    await expectRefusal(service.service.issue(contextOf(userId, expired), request()), 'SECURITY_ACTION_SESSION_REQUIRED')
    const live = await seedSession(userId)
    const context = contextOf(userId, live)
    const upsert = `INSERT INTO user_session_revocations (user_id, revoked_after) VALUES ($1, to_timestamp($2)) ON CONFLICT (user_id) DO UPDATE SET revoked_after = EXCLUDED.revoked_after`
    await q(upsert, [userId, context.tokenIssuedAt + 0.5])
    await expectRefusal(service.service.issue(context, request()), 'SECURITY_ACTION_SESSION_REQUIRED')
    await q(upsert, [userId, context.tokenIssuedAt])
    await expectRefusal(service.service.issue(context, request()), 'SECURITY_ACTION_SESSION_REQUIRED')
    expect(service.compares).toEqual([])
    await q(upsert, [userId, context.tokenIssuedAt - 0.001])
    await expect(service.service.issue(context, request())).resolves.toMatchObject({ ttlSeconds: 300 })
  })

  it.each([
    ['the platform admin flag', { isAdmin: true }, null],
    ['the admin role column', { role: 'admin' }, null],
    ['the admin role', {}, async (id: string) => grantRole(id, 'admin')],
    ['a sensitive authority code', {}, async (id: string) => grantDirect(id, 'users:write')],
    ['an admin-level code', {}, async (id: string) => grantDirect(id, '*:*')],
  ] satisfies Array<[string, UserSeed, null | ((id: string) => Promise<void>)]>)('refuses self-service bind and grant enable for a user high by %s, before any comparison, and allows unbind and disable', async (_label, seed, grant) => {
    const userId = await seedUser(seed)
    await grant?.(userId)
    const sid = await seedSession(userId)
    const service = serviceOn()
    for (const req of [bindRequest(), request({ purpose: 'login_grant_enable' })]) {
      const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), req), 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED')
      expect(refusal.status).toBe(403)
    }
    expect(service.compares).toEqual([])
    expect(await rowsOf(userId)).toEqual([])
    for (const purpose of ['external_identity_unbind', 'login_grant_disable'] as const) {
      await expect(service.service.issue(contextOf(userId, sid), request({ purpose }))).resolves.toMatchObject({ purpose })
    }
    expect((await rowsOf(userId)).map((r) => r.privilege_class)).toEqual(['high', 'high'])
  })

  it('refuses with 409 when the membership of the authenticated organization is inactive', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    await q('UPDATE user_orgs SET is_active = false WHERE user_id = $1', [userId])
    const service = serviceOn()
    const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), request()), 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED')
    expect(refusal.status).toBe(409)
    expect(service.compares).toEqual([])
  })

  it('supersedes the earlier proof of the same session and purpose, leaves another session and another connection alone', async () => {
    const userId = await seedUser()
    const a = await seedSession(userId)
    const b = await seedSession(userId)
    const service = serviceOn()
    const first = await issueFor(userId, a, service)
    const other = await issueFor(userId, b, service)
    const second = await issueFor(userId, a, service, request({ connectionId: OTHER_CONNECTION }))
    const rows = await rowsOf(userId)
    const byHash = (proof: string) => rows.find((r) => r.proof_hash === hashProofSecret(parseProof(proof)!.secret))!
    expect(byHash(first.issued.proof).status).toBe('superseded')
    expect(byHash(first.issued.proof).superseded_at).toBeTruthy()
    expect(byHash(other.issued.proof).status).toBe('issued')
    expect(byHash(second.issued.proof).status).toBe('issued')
  })

  it('counts a rejected credential from the first read even when the access generation advanced before the second read', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn({
      beforeCompare: async () => { await q('UPDATE users SET access_generation = access_generation + 1 WHERE id = $1', [userId]) },
    })
    await expectRefusal(service.service.issue(contextOf(userId, sid), request({ password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(String(rows[0].access_generation)).toBe('0')
  })

  it.each([
    ['the access generation advanced', async (id: string) => { await q('UPDATE users SET access_generation = access_generation + 1 WHERE id = $1', [id]) }, 'SECURITY_ACTION_STATE_CHANGED'],
    ['the password hash changed', async (id: string) => { await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash('other-' + randomUUID(), 4)]) }, 'SECURITY_ACTION_STATE_CHANGED'],
    ['the admin role was granted', async (id: string) => { await grantRole(id, 'admin') }, 'SECURITY_ACTION_STATE_CHANGED'],
    ['the session was revoked', async (id: string, sid: string) => { await revokeUserSession(sid, { revokedBy: id, reason: 'test' }) }, 'SECURITY_ACTION_SESSION_REQUIRED'],
  ] satisfies Array<[string, (id: string, sid: string) => Promise<void>, SecurityActionErrorCode]>)('refuses with %s when %s between the two reads and writes no proof', async (_label, drift, code) => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn({ beforeCompare: () => drift(userId, sid) })
    await expectRefusal(service.service.issue(contextOf(userId, sid), request()), code)
    expect((await rowsOf(userId)).filter((r) => r.status === 'issued')).toEqual([])
  })

  it('refuses with STATE_CHANGED when the target witness changed between the two reads', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const revision = { value: 'r1' }
    const service = serviceOn({ targetRevision: revision, beforeCompare: async () => { revision.value = 'r2' } })
    await expectRefusal(service.service.issue(contextOf(userId, sid), request()), 'SECURITY_ACTION_STATE_CHANGED')
    expect(await rowsOf(userId)).toEqual([])
  })

  it('issues on a pool whose default isolation is repeatable read, because both transactions pin read committed', async () => {
    expect((await repeatableReadPool().query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe('repeatable read')
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn({ pool: repeatableReadPool() })
    await expect(service.service.issue(contextOf(userId, sid), request())).resolves.toMatchObject({ ttlSeconds: 300 })
  })

  it('refuses with 503 and writes nothing when the relations are not visible on the connection', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn({ pool: absentSchemaPool() })
    const refusal = await expectRefusal(service.service.issue(contextOf(userId, sid), request()), 'SECURITY_ACTION_UNAVAILABLE')
    expect(refusal.status).toBe(503)
    expect(await rowsOf(userId)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

suite('consumption', () => {
  it('consumes once inside the caller transaction and refuses the proof afterwards', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const verified = await consumeWith(userId, context, service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness }, actionRef: 'unbind:1' }))
    expect(verified).toMatchObject({ proofId: parseProof(issued.proof)!.id, method: 'local_password', assurance: 'local_password', privilegeClass: 'standard', purpose: 'external_identity_unbind', connectionId: CONNECTION })
    const row = (await rowsOf(userId))[0]
    expect(row.status).toBe('consumed')
    expect(row.consumed_action_ref).toBe('unbind:1')
    expect(verified.verifiedAt).toBe((row.created_at as Date).toISOString())
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } })), 'SECURITY_ACTION_PROOF_ALREADY_USED')
  })

  it('refuses an expired proof', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const secret = 'E'.repeat(43)
    const id = await insertRow(q, userId, { session_id: sid, proof_hash: hashProofSecret(secret), created_at: new Date(Date.now() - 400_000), expires_at: new Date(Date.now() - 100_000) })
    const context = contextOf(userId, sid)
    await expectRefusal(consumeWith(userId, context, service, consumeInput(`sap1.${id}.${secret}`, { target: { kind: 'identity_revision', witness: 'a'.repeat(64) } })), 'SECURITY_ACTION_PROOF_EXPIRED')
  })

  it('refuses another user\'s proof, a forged secret, an unknown id and a failed row as invalid', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const ownerSid = await seedSession(owner)
    const otherSid = await seedSession(other)
    const service = serviceOn()
    const { issued, witness } = await issueFor(owner, ownerSid, service)
    const target = { kind: 'identity_revision' as const, witness }
    await expectRefusal(consumeWith(other, contextOf(other, otherSid), service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_INVALID')
    const { id } = parseProof(issued.proof)!
    await expectRefusal(consumeWith(owner, contextOf(owner, ownerSid), service, consumeInput(`sap1.${id}.${'F'.repeat(43)}`, { target })), 'SECURITY_ACTION_PROOF_INVALID')
    await expectRefusal(consumeWith(owner, contextOf(owner, ownerSid), service, consumeInput(`sap1.${randomUUID()}.${'F'.repeat(43)}`, { target })), 'SECURITY_ACTION_PROOF_INVALID')
    await expectRefusal(service.service.issue(contextOf(owner, ownerSid), request({ password: WRONG })), 'SECURITY_ACTION_CREDENTIAL_REJECTED')
    const failedId = String((await rowsOf(owner)).find((r) => r.status === 'failed')!.id)
    await expectRefusal(consumeWith(owner, contextOf(owner, ownerSid), service, consumeInput(`sap1.${failedId}.${'F'.repeat(43)}`, { target })), 'SECURITY_ACTION_PROOF_INVALID')
  })

  it('refuses a proof presented from another session of the same user', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { issued, witness } = await issueFor(userId, sid, service)
    const newer = await seedSession(userId)
    await expectRefusal(consumeWith(userId, contextOf(userId, newer), service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } })), 'SECURITY_ACTION_PROOF_SESSION_MISMATCH')
  })

  it('refuses a proof whose purpose, connection, organization or target witness differs from the action', async () => {
    const userId = await seedUser({ orgs: [ORG, OTHER_ORG] })
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const target = { kind: 'identity_revision' as const, witness }
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { purpose: 'login_grant_disable', target })), 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH')
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { connectionId: OTHER_CONNECTION, target })), 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH')
    await expectRefusal(consumeWith(userId, contextOf(userId, sid, OTHER_ORG), service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH')
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness: 'f'.repeat(64) } })), 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH')
    expect((await rowsOf(userId))[0].status).toBe('issued')
  })

  it('requires the client binding it was issued with', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service, request({ clientBindingDigest: clientBindingDigestOf('browser-binding') }))
    const target = { kind: 'identity_revision' as const, witness }
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_INVALID')
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target, clientBinding: 'other' })), 'SECURITY_ACTION_PROOF_INVALID')
    await expect(consumeWith(userId, context, service, consumeInput(issued.proof, { target, clientBinding: 'browser-binding' }))).resolves.toBeTruthy()
  })

  it.each([
    ['the access generation advanced', async (id: string) => { await callerTransaction(id, (client) => supersedeDeprovisionEvidenceForAccessGraphWrite(client, { userIds: [id], actorId: id, reason: 'test' })) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the password hash changed', async (id: string) => { await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash('other-' + randomUUID(), 4)]) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the admin role was granted (unbind)', async (id: string) => { await grantRole(id, 'admin') }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a wildcard direct permission was granted', async (id: string) => { await grantDirect(id, '*:*') }, 'SECURITY_ACTION_PROOF_STALE'],
    ['a held role gained a code', async (id: string) => { const role = 'p04b-role-' + randomUUID(); await grantRole(id, role); await q('INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', ['tasks:read']); await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [role, 'tasks:read']) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the admin flag was set', async (id: string) => { await q('UPDATE users SET is_admin = true WHERE id = $1', [id]) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the role column became admin', async (id: string) => { await q("UPDATE users SET role = 'admin' WHERE id = $1", [id]) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the session was revoked', async (id: string, sid: string) => { await revokeUserSession(sid, { revokedBy: id, reason: 'test' }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['every session was revoked', async (id: string) => { await revokeUserSessions(id, { updatedBy: id, reason: 'test' }) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the account was deactivated', async (id: string) => { await q('UPDATE users SET is_active = false WHERE id = $1', [id]) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the account was moved to the recycle bin', async (id: string) => { await q('UPDATE users SET deleted_at = now() WHERE id = $1', [id]) }, 'SECURITY_ACTION_PROOF_STALE'],
    ['the membership was deactivated', async (id: string) => { await q('UPDATE user_orgs SET is_active = false WHERE user_id = $1', [id]) }, 'SECURITY_ACTION_PROOF_STALE'],
  ] satisfies Array<[string, (id: string, sid: string) => Promise<void>, SecurityActionErrorCode]>)('refuses with %s after %s', async (_label, change, code) => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    await change(userId, sid)
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } })), code)
    expect((await rowsOf(userId))[0].status).toBe('issued')
  })

  it('refuses a bind proof with HIGH once the user became high, and refuses with STALE under another policy revision or after reissue, or when the watermark equals the creation time', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const bind = await issueFor(userId, sid, service, bindRequest())
    await grantRole(userId, 'admin')
    await expectRefusal(consumeWith(userId, bind.context, service, consumeInput(bind.issued.proof, { purpose: 'external_identity_bind', target: { kind: 'empty_slot', witness: bind.witness } })), 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED')
    const other = await seedUser()
    const otherSid = await seedSession(other)
    const { context, issued, witness } = await issueFor(other, otherSid, service)
    const target = { kind: 'identity_revision' as const, witness }
    const otherRevision = serviceOn({ policyRevision: SECURITY_ACTION_POLICY_REVISION + 1 })
    await expectRefusal(consumeWith(other, context, otherRevision, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_STALE')
    const createdAt = (await q(`SELECT created_at FROM ${TABLE} WHERE user_id = $1 AND status = 'issued'`, [other])).rows[0].created_at
    await q('INSERT INTO user_session_revocations (user_id, revoked_after) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET revoked_after = EXCLUDED.revoked_after', [other, createdAt])
    await expectRefusal(consumeWith(other, context, service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_STALE')
    await q('DELETE FROM user_session_revocations WHERE user_id = $1', [other])
    const reissued = await issueFor(other, otherSid, service)
    await expectRefusal(consumeWith(other, context, service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_ALREADY_USED')
    await expect(consumeWith(other, reissued.context, service, consumeInput(reissued.issued.proof, { target: { kind: 'identity_revision', witness: reissued.witness } }))).resolves.toBeTruthy()
  })

  it('does not count a token refresh as a verification: the same session keeps its proof and a new session does not', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { issued, witness } = await issueFor(userId, sid, service)
    const before = (await rowsOf(userId)).length
    const refreshed = await authService.refreshToken(tokenOf(userId, sid))
    expect(refreshed).toBeTruthy()
    expect((await rowsOf(userId)).length).toBe(before)
    const sameSession = contextOf(userId, sid, ORG, refreshed!)
    expect(sameSession.sessionId).toBe(sid)
    const target = { kind: 'identity_revision' as const, witness }
    const newer = await seedSession(userId)
    await expectRefusal(consumeWith(userId, contextOf(userId, newer), service, consumeInput(issued.proof, { target })), 'SECURITY_ACTION_PROOF_SESSION_MISMATCH')
    await expect(consumeWith(userId, sameSession, service, consumeInput(issued.proof, { target }))).resolves.toBeTruthy()
  })

  it('refuses a caller transaction that is not read committed before taking any lock', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const target = { kind: 'identity_revision' as const, witness }
    const variants: Array<{ isolation?: string; pool?: PgPool; bareBegin?: boolean }> = [{ isolation: 'REPEATABLE READ' }, { pool: repeatableReadPool(), bareBegin: true }]
    for (const options of variants) {
      const client = await (options.pool ?? pool()).connect()
      try {
        const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await client.query(options.bareBegin ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${options.isolation}`)
        const attempt = service.service.consume(executorOf(client), context, { ...consumeInput(issued.proof, { target }), lockedUser: manualLockedUser(userId) })
        await expect(attempt).rejects.toBeInstanceOf(SecurityActionProofContractError)
        await expect(attempt).rejects.toMatchObject({ code: 'SECURITY_ACTION_TRANSACTION_REQUIRED' })
        const locks = (await q(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype IN ('relation', 'tuple', 'transactionid') AND relation IN ('users'::regclass, $2::regclass)`, [pid, `public.${TABLE}`])).rows[0].n
        expect(Number(locks)).toBe(0)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
    expect((await rowsOf(userId))[0].status).toBe('issued')
    await expect(consumeWith(userId, context, service, consumeInput(issued.proof, { target }))).resolves.toBeTruthy()
  })

  it('takes the user row itself: a caller holding no lock waits behind another holder and touches no proof row meanwhile', async () => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const holder = await pool().connect()
    const caller = await pool().connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId])
      const callerPid = Number((await caller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await caller.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const pending = service.service.consume(executorOf(caller), context, { ...consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } }), lockedUser: manualLockedUser(userId) })
      const blockedOn = await waitUntilBlocked(callerPid)
      expect(blockedOn).toContain('FOR UPDATE')
      expect(blockedOn).toContain('FROM users')
      const proofLocks = (await q(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND granted AND relation = $2::regclass`, [callerPid, `public.${TABLE}`])).rows[0].n
      expect(Number(proofLocks)).toBe(0)
      await holder.query('ROLLBACK')
      await expect(pending).resolves.toMatchObject({ purpose: 'external_identity_unbind' })
      await caller.query('COMMIT')
    } finally {
      holder.release()
      caller.release()
    }
    expect((await rowsOf(userId))[0].status).toBe('consumed')
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

suite('concurrency', () => {
  it.each([true, false])('serializes two consumers on the user row; after the first commits (%s) the second sees a used proof or, after a rollback, consumes', async (commitFirst) => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const target = { kind: 'identity_revision' as const, witness }
    const a = await pool().connect()
    const b = await pool().connect()
    try {
      await a.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const lockedA = (await lockUsersForAccessGraphWrite(executorOf(a), [userId])).get(userId)!
      await service.service.consume(executorOf(a), context, { ...consumeInput(issued.proof, { target }), lockedUser: lockedA })
      const pidB = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await b.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const pendingB = (async () => {
        const lockedB = (await lockUsersForAccessGraphWrite(executorOf(b), [userId])).get(userId)!
        return service.service.consume(executorOf(b), context, { ...consumeInput(issued.proof, { target }), lockedUser: lockedB })
      })()
      await waitUntilBlocked(pidB)
      await a.query(commitFirst ? 'COMMIT' : 'ROLLBACK')
      if (commitFirst) await expect(pendingB).rejects.toMatchObject({ code: 'SECURITY_ACTION_PROOF_ALREADY_USED' })
      else await expect(pendingB).resolves.toBeTruthy()
      await b.query('COMMIT')
    } finally {
      a.release()
      b.release()
    }
    expect((await rowsOf(userId)).filter((r) => r.status === 'consumed')).toHaveLength(1)
  })

  it.each([['read committed', () => pool()], ['repeatable read default', () => repeatableReadPool()]])('issues exactly one live proof when two issuances race on a %s pool', async (_label, target) => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = serviceOn({ pool: target(), beforeCompare: async () => { arrived += 1; if (arrived === 2) release(); await gate } })
    const context = contextOf(userId, sid)
    const results = await Promise.allSettled([service.service.issue(context, request()), service.service.issue(context, request())])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const rows = await rowsOf(userId)
    expect(rows.map((r) => r.status).sort()).toEqual(['issued', 'superseded'])
  })

  it.each([
    ['read committed, one session', () => pool(), 1],
    ['repeatable read default, one session', () => repeatableReadPool(), 1],
    ['read committed, three sessions', () => pool(), 3],
  ])('records exactly five failures and refuses the sixth when six wrong passwords queue behind the user row (%s)', async (_label, target, sessionCount) => {
    const userId = await seedUser()
    const sids: string[] = []
    for (let index = 0; index < sessionCount; index += 1) sids.push(await seedSession(userId))
    const pids: number[] = []
    const service = serviceOn({ pool: target(), pids })
    const holder = await pool().connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId])
      const attempts = Array.from({ length: 6 }, (_, index) => service.service.issue(contextOf(userId, sids[index % sessionCount]), request({ password: WRONG })).then(() => 'issued', (error: SecurityActionProofError) => error.code))
      // T1 of every attempt completes without a lock; each T2 then waits on the advisory lock or the user row.
      await waitUntilBlockedCount(pids, 1)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await holder.query('ROLLBACK')
      const outcomes = (await Promise.all(attempts)).sort()
      expect(outcomes).toEqual(['SECURITY_ACTION_CREDENTIAL_REJECTED', 'SECURITY_ACTION_CREDENTIAL_REJECTED', 'SECURITY_ACTION_CREDENTIAL_REJECTED', 'SECURITY_ACTION_CREDENTIAL_REJECTED', 'SECURITY_ACTION_CREDENTIAL_REJECTED', 'SECURITY_ACTION_RATE_LIMITED'])
    } finally {
      holder.release()
    }
    expect((await rowsOf(userId)).filter((r) => r.status === 'failed')).toHaveLength(5)
  })

  it.each([true, false])('an issuance for the same key waits on the user row, not on the proof row, while a consumer holds both (consumer commits: %s)', async (commitConsumer) => {
    const userId = await seedUser()
    const sid = await seedSession(userId)
    const pids: number[] = []
    const service = serviceOn({ pids })
    const { context, issued, witness } = await issueFor(userId, sid, service)
    const consumer = await pool().connect()
    try {
      await consumer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const locked = (await lockUsersForAccessGraphWrite(executorOf(consumer), [userId])).get(userId)!
      await service.service.consume(executorOf(consumer), context, { ...consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } }), lockedUser: locked })
      pids.length = 0
      const pendingIssue = service.service.issue(context, request())
      await waitUntilBlockedCount(pids, 1, 8_000)
      const waiting = (await q(`SELECT query FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'`, [pids])).rows
      expect(waiting).toHaveLength(1)
      expect(String(waiting[0].query).replace(/\s+/g, ' ')).toBe(SECURITY_ACTION_SQL.userKeyShare)
      await consumer.query(commitConsumer ? 'COMMIT' : 'ROLLBACK')
      await expect(pendingIssue).resolves.toMatchObject({ ttlSeconds: 300 })
    } finally {
      consumer.release()
    }
    const rows = await rowsOf(userId)
    const original = rows.find((r) => r.proof_hash === hashProofSecret(parseProof(issued.proof)!.secret))!
    expect(original.status).toBe(commitConsumer ? 'consumed' : 'superseded')
    expect(rows.filter((r) => r.status === 'issued')).toHaveLength(1)
  })
})
