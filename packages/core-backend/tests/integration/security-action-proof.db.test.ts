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
const ORG = 'sa-proof-org-' + randomUUID()
const OTHER_ORG = 'sa-proof-org-' + randomUUID()
const CONNECTION = randomUUID()
const OTHER_CONNECTION = randomUUID()
const TARGET_IDENTITY = randomUUID()
const PASSWORD = 'correct-horse-' + randomUUID()
const WRONG = 'wrong-' + randomUUID()
const ROLLBACK = Symbol('sa-proof-rollback')

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
  absentPool ??= new PgPool({ connectionString: withOptions('-c search_path=sa_proof_absent'), max: 2 })
  return absentPool
}

const q: Runner = async (sql, params = []) => (await pool().query(sql, params)) as { rows: Array<Record<string, unknown>> }

function executorOf(client: PoolClient): Queryable {
  return { query: async (sql, params) => client.query(sql, params) }
}

const savedEnv = new Map<string, string | undefined>()
const seededUsers: string[] = []
// Only rows this suite inserted itself are recorded (RETURNING on a conflict-tolerant insert), so
// pre-existing roles and permission codes are left in place by afterAll.
const seededRoles: string[] = []
const seededPermissionCodes: string[] = []
const seededRolePermissions: Array<[string, string]> = []

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
  if (mainPool) {
    for (const [roleId, code] of seededRolePermissions) await q('DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [roleId, code])
    if (seededRoles.length > 0) await q('DELETE FROM roles WHERE id = ANY($1::text[])', [seededRoles])
    if (seededPermissionCodes.length > 0) await q('DELETE FROM permissions WHERE code = ANY($1::text[])', [seededPermissionCodes])
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
  const id = 'sa-proof-' + randomUUID()
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
  const sid = 'sa-proof-sid-' + randomUUID()
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

async function ensurePermissionCode(code: string): Promise<void> {
  const inserted = (await q('INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING RETURNING code', [code])).rows
  if (inserted.length === 1) seededPermissionCodes.push(code)
}

/** Adds `code` to a role this suite created. */
async function grantRoleCode(roleId: string, code: string): Promise<void> {
  await ensurePermissionCode(code)
  const inserted = (await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING role_id', [roleId, code])).rows
  if (inserted.length === 1) seededRolePermissions.push([roleId, code])
}

async function grantRole(userId: string, roleId: string, codes: readonly string[] = []): Promise<void> {
  const inserted = (await q('INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING RETURNING id', [roleId])).rows
  if (inserted.length === 1) seededRoles.push(roleId)
  await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
  for (const code of codes) await grantRoleCode(roleId, code)
}

async function grantDirect(userId: string, code: string): Promise<void> {
  await ensurePermissionCode(code)
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
  return { id, name: null, email: null, username: null, mobile: null, role: 'user', activationStatus: 'activated', isActive: true, accessGeneration: 0, deletedAt: null, purgedAt: null }
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

/** An explicit NULL expiry; an issued row without an `expires_at` override otherwise gets now() + 300 s. */
const NULL_EXPIRY = Symbol('null-expiry')

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
  // Placeholders are numbered from the bound values only, so an expression written inline leaves no
  // unreferenced parameter behind (an unreferenced `$n` cannot be typed and the statement would be refused).
  const params: unknown[] = []
  const values = keys.map((key) => {
    if (key === 'expires_at' && expiresExpression) return expiresExpression
    params.push(key === 'expires_at' && row.expires_at === NULL_EXPIRY ? null : row[key])
    return `$${params.length}`
  })
  await run(`INSERT INTO ${TABLE} (${keys.join(', ')}) VALUES (${values.join(', ')})`, params)
  return String(row.id)
}

/** A lifetime that ended 100 s ago and spans exactly 300 s, computed from a single clock reading. */
function expiredLifetime(): { created_at: Date; expires_at: Date } {
  const now = Date.now()
  return { created_at: new Date(now - 400_000), expires_at: new Date(now - 100_000) }
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

/** Every row of the given users as its full JSON image, in id order. */
async function imageOf(run: Runner, userIds: string[]): Promise<string[]> {
  return (await run(`SELECT to_jsonb(t)::text AS image FROM ${TABLE} t WHERE user_id = ANY($1::text[]) ORDER BY id`, [userIds])).rows.map((row) => String(row.image))
}

async function rowImage(run: Runner, id: string): Promise<Record<string, unknown>> {
  const rows = (await run(`SELECT to_jsonb(t) AS image FROM ${TABLE} t WHERE id = $1`, [id])).rows
  expect(rows).toHaveLength(1)
  return rows[0].image as Record<string, unknown>
}

/** The columns the trigger lets a transition change. */
const TRANSITION_COLUMNS = ['status', 'consumed_at', 'consumed_action_ref', 'superseded_at'] as const

function withoutTransitionColumns(image: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(image).filter(([key]) => !(TRANSITION_COLUMNS as readonly string[]).includes(key)))
}

type PgFailure = { code?: string; constraint?: string; table?: string; message?: string; where?: string }

let savepoints = 0

/**
 * Runs `statement` under its own savepoint, so its failure does not abort the transaction, expects it
 * to be refused, and then re-reads every row of `userIds` in the same transaction: the refusal must
 * leave each of them, every column included, exactly as before (for a refused insert: no new row).
 */
async function refusedUnchanged(run: Runner, userIds: string[], statement: () => Promise<unknown>): Promise<PgFailure> {
  const before = await imageOf(run, userIds)
  const savepoint = `sa_proof_negative_${++savepoints}`
  await run(`SAVEPOINT ${savepoint}`)
  let failure: unknown = null
  try {
    await statement()
  } catch (error) {
    failure = error
  }
  await run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await run(`RELEASE SAVEPOINT ${savepoint}`)
  expect(failure, 'the statement must be refused').not.toBeNull()
  expect(await imageOf(run, userIds)).toEqual(before)
  return failure as PgFailure
}

/** Refused by the named CHECK constraint of the table, and by nothing else. */
async function expectCheckRefusal(run: Runner, userIds: string[], constraint: string, statement: () => Promise<unknown>): Promise<void> {
  const failure = await refusedUnchanged(run, userIds, statement)
  expect({ code: failure.code, constraint: failure.constraint, table: failure.table }).toEqual({ code: '23514', constraint, table: TABLE })
}

/** Refused by the transition trigger with the given message, and by no constraint. */
async function expectTriggerRefusal(run: Runner, userIds: string[], message: string, statement: () => Promise<unknown>): Promise<void> {
  const failure = await refusedUnchanged(run, userIds, statement)
  expect({ code: failure.code, message: failure.message, constraint: failure.constraint }).toEqual({ code: '55000', message, constraint: undefined })
  expect(failure.where).toContain('guard_security_action_challenge_transition')
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

suite('migration', () => {
  it('creates the expected columns, constraints, indexes, validated foreign key and row trigger', async () => {
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
    expect(current.constraints.map((c) => c.name).sort()).toEqual([
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
    expect(current.indexes.map((i) => i.name).sort()).toEqual(['idx_security_action_user_created', 'security_action_challenges_pkey', 'uq_security_action_live_proof'])
    const fk = (await q(`SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'security_action_challenges_user_fk'`)).rows[0]
    expect(fk).toEqual({ convalidated: true, confdeltype: 'a' })
    const trigger = (await q(`SELECT tgenabled, tgtype FROM pg_trigger WHERE tgname = 'security_action_challenge_transition' AND tgrelid = $1::regclass`, [`public.${TABLE}`])).rows[0]
    expect(trigger.tgenabled).toBe('O')
    // BEFORE (2) | INSERT (4) | UPDATE (16) | ROW (1)
    expect(Number(trigger.tgtype)).toBe(23)
  })

  // Every negative below runs under its own savepoint, so the refused statement does not abort the
  // case, and re-reads every row of the users involved afterwards: a refusal leaves each column as it
  // was. Each CHECK case passes the transition trigger (an INSERT as issued or failed and not dated in
  // the future; an UPDATE from issued to consumed or superseded touching only the transition columns)
  // and breaks exactly one CHECK, so the refusal must name that CHECK. Each trigger case satisfies
  // every CHECK, the index and the foreign key, so only the trigger can refuse it.

  const T0 = new Date('2020-01-01T00:00:00Z')
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
  const FAILED: RowSeed = { status: 'failed', failure_code: 'credential_rejected', proof_hash: null, assurance: null }

  const INSERT_CHECK_CASES: ReadonlyArray<[label: string, constraint: string, row: RowSeed]> = [
    ['purpose outside the closed set', 'purpose_chk', { purpose: 'other' }],
    ['target kind outside the closed set', 'target_kind_chk', { target_kind: 'other', target_identity_id: null, expected_binding_revision: null }],
    ['identity target without the identity', 'identity_target_chk', { target_identity_id: null }],
    ['identity target without the binding revision', 'identity_target_chk', { expected_binding_revision: null }],
    ['empty slot with an identity', 'empty_slot_chk', { target_kind: 'empty_slot', expected_binding_revision: null }],
    ['empty slot with a binding revision', 'empty_slot_chk', { target_kind: 'empty_slot', target_identity_id: null }],
    ['negative binding revision', 'binding_revision_chk', { expected_binding_revision: -1 }],
    ['method outside the closed set', 'method_chk', { method: 'other' }],
    ['local password with a method connection', 'method_connection_chk', { method_connection_id: randomUUID() }],
    ['external reauthentication without a method connection', 'method_connection_chk', { method: 'external_reauth' }],
    ['privilege class outside the closed set', 'privilege_class_chk', { privilege_class: 'other' }],
    ['policy revision zero', 'policy_revision_chk', { policy_revision: 0 }],
    ['target witness that is not lowercase hex', 'witness_chk', { target_witness: 'z'.repeat(64) }],
    ['credential witness in uppercase', 'witness_chk', { credential_witness: 'A'.repeat(64) }],
    ['privilege witness one character short', 'witness_chk', { privilege_witness: 'a'.repeat(63) }],
    ['proof hash in uppercase', 'proof_hash_chk', { proof_hash: 'B'.repeat(64) }],
    ['client binding digest that is not hex', 'client_binding_chk', { client_binding_digest: 'g'.repeat(64) }],
    ['failed row with a proof hash', 'failed_shape_chk', { ...FAILED, proof_hash: 'b'.repeat(64) }],
    ['failed row with an expiry', 'failed_shape_chk', { ...FAILED, created_at: T0, expires_at: at(60) }],
    ['failed row with an assurance', 'failed_shape_chk', { ...FAILED, assurance: 'local_password' }],
    ['failed row with a client binding digest', 'failed_shape_chk', { ...FAILED, client_binding_digest: 'a'.repeat(64) }],
    ['failed row with a failure code outside the closed set', 'failed_shape_chk', { ...FAILED, failure_code: 'other' }],
    ['failed row without a failure code', 'failed_shape_chk', { ...FAILED, failure_code: null }],
    ['issued row without a proof hash', 'proof_shape_chk', { proof_hash: null }],
    ['issued row without an expiry', 'proof_shape_chk', { expires_at: NULL_EXPIRY }],
    ['issued row with a failure code', 'proof_shape_chk', { failure_code: 'credential_rejected' }],
    ['issued row without an assurance', 'proof_shape_chk', { assurance: null }],
    ['issued row with an assurance outside the closed set', 'proof_shape_chk', { assurance: 'other' }],
    ['issued row with a consumption time', 'consumed_chk', { consumed_at: new Date() }],
    ['issued row with a supersession time', 'superseded_chk', { superseded_at: new Date() }],
    ['issued row with an action reference', 'action_ref_status_chk', { consumed_action_ref: 'ref-1' }],
    ['lifetime of 301 seconds', 'ttl_chk', { created_at: T0, expires_at: at(301) }],
    ['lifetime of zero seconds', 'ttl_chk', { created_at: T0, expires_at: T0 }],
    ['expiry before creation', 'ttl_chk', { created_at: T0, expires_at: at(-1) }],
  ]

  it.each(INSERT_CHECK_CASES)('refuses an insert with %s by %s alone (23514), leaving no row', async (_label, constraint, row) => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      await expectCheckRefusal(run, [userId], `security_action_challenges_${constraint}`, () => insertRow(run, userId, row))
      expect(await imageOf(run, [userId])).toEqual([])
    })
  })

  // Transition-time CHECKs: the trigger admits each of these updates, the CHECK refuses it.
  const UPDATE_CHECK_CASES: ReadonlyArray<[label: string, constraint: string, set: string]> = [
    ['consumed without a consumption time', 'consumed_chk', "status = 'consumed'"],
    ['superseded with a consumption time', 'consumed_chk', "status = 'superseded', superseded_at = now(), consumed_at = now()"],
    ['superseded without a supersession time', 'superseded_chk', "status = 'superseded'"],
    ['consumed with a supersession time', 'superseded_chk', "status = 'consumed', consumed_at = now(), superseded_at = now()"],
    ['consumed with an action reference containing a space', 'action_ref_chk', "status = 'consumed', consumed_at = now(), consumed_action_ref = 'has space'"],
    ['consumed with an empty action reference', 'action_ref_chk', "status = 'consumed', consumed_at = now(), consumed_action_ref = ''"],
    ['consumed with an action reference of 129 characters', 'action_ref_chk', `status = 'consumed', consumed_at = now(), consumed_action_ref = '${'r'.repeat(129)}'`],
    ['consumed with a non-ASCII action reference', 'action_ref_chk', "status = 'consumed', consumed_at = now(), consumed_action_ref = 'réf'"],
    ['superseded with an action reference', 'action_ref_status_chk', "status = 'superseded', superseded_at = now(), consumed_action_ref = 'ref-1'"],
  ]

  it.each(UPDATE_CHECK_CASES)('refuses an update of an issued row to %s by %s alone (23514), leaving the row as it was', async (_label, constraint, set) => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const id = await insertRow(run, userId)
      await expectCheckRefusal(run, [userId], `security_action_challenges_${constraint}`, () => run(`UPDATE ${TABLE} SET ${set} WHERE id = $1`, [id]))
      expect((await run(`SELECT status FROM ${TABLE} WHERE id = $1`, [id])).rows).toEqual([{ status: 'issued' }])
    })
  })

  // The trigger admits only issued, failed, consumed and superseded, so a status outside the closed
  // set never reaches the CHECK while the trigger is enabled. The CHECK is proved on its own with the
  // trigger disabled inside a savepoint, and the trigger is enabled again afterwards.
  it('refuses a status outside the closed set by status_chk alone (23514) when the trigger is not there to refuse it first', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const id = await insertRow(run, userId)
      await run('SAVEPOINT sa_trigger_off')
      await run(`ALTER TABLE ${TABLE} DISABLE TRIGGER security_action_challenge_transition`)
      await expectCheckRefusal(run, [userId], 'security_action_challenges_status_chk', () => insertRow(run, userId, { status: 'other' }))
      await expectCheckRefusal(run, [userId], 'security_action_challenges_status_chk', () => run(`UPDATE ${TABLE} SET status = 'other' WHERE id = $1`, [id]))
      await run('ROLLBACK TO SAVEPOINT sa_trigger_off')
      await run('RELEASE SAVEPOINT sa_trigger_off')
      expect((await run(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'security_action_challenge_transition' AND tgrelid = $1::regclass`, [`public.${TABLE}`])).rows).toEqual([{ tgenabled: 'O' }])
      expect((await run(`SELECT status FROM ${TABLE} WHERE id = $1`, [id])).rows).toEqual([{ status: 'issued' }])
    })
  })

  it('admits the legal rows and boundaries: issued, failed, both target kinds, both methods, binding revision 0, a lifetime of exactly 300 seconds', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const issued = await insertRow(run, userId)
      expect((await run(
        `SELECT status, extract(epoch FROM expires_at - created_at)::int AS ttl, failure_code, consumed_at, consumed_action_ref, superseded_at, proof_hash, assurance
           FROM ${TABLE} WHERE id = $1`, [issued],
      )).rows).toEqual([{ status: 'issued', ttl: 300, failure_code: null, consumed_at: null, consumed_action_ref: null, superseded_at: null, proof_hash: 'b'.repeat(64), assurance: 'local_password' }])
      const failed = await insertRow(run, userId, FAILED)
      expect((await run(
        `SELECT status, failure_code, proof_hash, expires_at, assurance, client_binding_digest, consumed_at, superseded_at FROM ${TABLE} WHERE id = $1`, [failed],
      )).rows).toEqual([{ status: 'failed', failure_code: 'credential_rejected', proof_hash: null, expires_at: null, assurance: null, client_binding_digest: null, consumed_at: null, superseded_at: null }])
      const accepted: RowSeed[] = [
        { ...FAILED, failure_code: 'reauth_subject_mismatch' },
        { purpose: 'external_identity_bind', target_kind: 'empty_slot', target_identity_id: null, expected_binding_revision: null },
        { method: 'external_reauth', method_connection_id: randomUUID(), assurance: 'external_platform_asserted' },
        { expected_binding_revision: 0 },
        { created_at: T0, expires_at: at(300) },
        { created_at: T0, expires_at: at(1) },
        { client_binding_digest: 'a'.repeat(64), privilege_class: 'high' },
      ]
      for (const row of accepted) await insertRow(run, userId, row)
      expect(await imageOf(run, [userId])).toHaveLength(2 + accepted.length)
    })
  })

  it('consumes an issued row: only status, consumption time and action reference change, a reference of 128 printable characters is accepted', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const id = await insertRow(run, userId)
      const before = await rowImage(run, id)
      const ref = '!' + '~'.repeat(126) + 'z'
      await run(`UPDATE ${TABLE} SET status = 'consumed', consumed_at = now(), consumed_action_ref = $2 WHERE id = $1`, [id, ref])
      const after = await rowImage(run, id)
      expect(withoutTransitionColumns(after)).toEqual(withoutTransitionColumns(before))
      expect([after.status, after.consumed_action_ref, after.superseded_at, after.consumed_at === null]).toEqual(['consumed', ref, null, false])
    })
  })

  it('supersedes an issued row: only status and supersession time change', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const id = await insertRow(run, userId)
      const before = await rowImage(run, id)
      await run(`UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [id])
      const after = await rowImage(run, id)
      expect(withoutTransitionColumns(after)).toEqual(withoutTransitionColumns(before))
      expect([after.status, after.consumed_at, after.consumed_action_ref, after.superseded_at === null]).toEqual(['superseded', null, null, false])
    })
  })

  it('refuses an insert in any state but issued or failed, and one dated in the future, by the trigger (55000), leaving no row', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const future = (await run("SELECT now() + interval '60 seconds' AS created, now() + interval '360 seconds' AS expires")).rows[0]
      const rows: RowSeed[] = [
        { status: 'consumed', consumed_at: new Date() },
        { status: 'consumed', consumed_at: new Date(), consumed_action_ref: 'ref-1' },
        { status: 'superseded', superseded_at: new Date() },
        { created_at: future.created, expires_at: future.expires },
        { ...FAILED, created_at: future.created },
      ]
      for (const row of rows) await expectTriggerRefusal(run, [userId], 'security action challenge state refused', () => insertRow(run, userId, row))
      expect(await imageOf(run, [userId])).toEqual([])
    })
  })

  it('refuses by the trigger (55000) every update that is not issued->consumed or issued->superseded, leaving the row as it was', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const issued = await insertRow(run, userId)
      const failed = await insertRow(run, userId, FAILED)
      const consumed = await insertRow(run, userId)
      await run(`UPDATE ${TABLE} SET status = 'consumed', consumed_at = now(), consumed_action_ref = 'ref-1' WHERE id = $1`, [consumed])
      const superseded = await insertRow(run, userId)
      await run(`UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [superseded])
      const proofShape = `failure_code = NULL, proof_hash = '${'b'.repeat(64)}', assurance = 'local_password', expires_at = created_at + interval '300 seconds'`
      const refused: ReadonlyArray<[id: string, set: string]> = [
        [issued, "status = 'issued'"],
        [issued, "status = 'failed', failure_code = 'credential_rejected', proof_hash = NULL, assurance = NULL, expires_at = NULL"],
        [failed, "failure_code = 'reauth_subject_mismatch'"],
        [failed, `status = 'issued', ${proofShape}`],
        [failed, `status = 'consumed', consumed_at = now(), ${proofShape}`],
        [failed, `status = 'superseded', superseded_at = now(), ${proofShape}`],
        [consumed, "consumed_action_ref = 'ref-2'"],
        [consumed, "status = 'issued', consumed_at = NULL, consumed_action_ref = NULL"],
        [consumed, "status = 'superseded', consumed_at = NULL, consumed_action_ref = NULL, superseded_at = now()"],
        [superseded, "status = 'issued', superseded_at = NULL"],
        [superseded, "status = 'consumed', superseded_at = NULL, consumed_at = now()"],
      ]
      for (const [id, set] of refused) {
        await expectTriggerRefusal(run, [userId], 'security action challenge transition refused', () => run(`UPDATE ${TABLE} SET ${set} WHERE id = $1`, [id]))
      }
      expect((await run(`SELECT id::text AS id, status FROM ${TABLE} WHERE user_id = $1 ORDER BY status`, [userId])).rows).toEqual([
        { id: consumed, status: 'consumed' }, { id: failed, status: 'failed' }, { id: issued, status: 'issued' }, { id: superseded, status: 'superseded' },
      ])
    })
  })

  it('refuses by the trigger (55000) a consumption or supersession that changes any other column, leaving the rows as they were', async () => {
    const userId = await seedUser()
    const otherUser = await seedUser()
    await withRollback(async (run) => {
      const id = await insertRow(run, userId)
      const changes: ReadonlyArray<[column: string, expression: string, value?: unknown]> = [
        ['id', '$2::uuid', randomUUID()], ['user_id', '$2', otherUser], ['session_id', '$2', 'sid-' + randomUUID()], ['org_id', '$2', OTHER_ORG],
        ['purpose', '$2', 'login_grant_disable'], ['connection_id', '$2::uuid', OTHER_CONNECTION], ['target_identity_id', '$2::uuid', randomUUID()],
        ['expected_binding_revision', '$2::bigint', 2], ['target_witness', '$2', 'e'.repeat(64)], ['assurance', '$2', 'external_platform_asserted'],
        ['proof_hash', '$2', 'f'.repeat(64)], ['client_binding_digest', '$2', 'a'.repeat(64)], ['policy_revision', '$2::int', 2],
        ['access_generation', '$2::bigint', 1], ['credential_witness', '$2', 'e'.repeat(64)], ['privilege_witness', '$2', 'e'.repeat(64)],
        ['privilege_class', '$2', 'high'], ['created_at', "created_at + interval '1 second'"], ['expires_at', "expires_at - interval '1 second'"],
      ]
      for (const transition of ["status = 'consumed', consumed_at = now()", "status = 'superseded', superseded_at = now()"]) {
        for (const [column, expression, value] of changes) {
          const params = value === undefined ? [id] : [id, value]
          await expectTriggerRefusal(run, [userId, otherUser], 'security action challenge transition refused', () => run(`UPDATE ${TABLE} SET ${transition}, ${column} = ${expression} WHERE id = $1`, params))
        }
      }
      expect((await run(`SELECT status FROM ${TABLE} WHERE id = $1`, [id])).rows).toEqual([{ status: 'issued' }])
      expect(await imageOf(run, [otherUser])).toEqual([])
    })
  })

  it('does not guard deletion: the trigger covers inserts and updates only', async () => {
    const userId = await seedUser()
    await withRollback(async (run) => {
      const issued = await insertRow(run, userId)
      const failed = await insertRow(run, userId, FAILED)
      await run(`DELETE FROM ${TABLE} WHERE id = ANY($1::uuid[])`, [[issued, failed]])
      expect(await imageOf(run, [userId])).toEqual([])
    })
  })

  it('refuses a row for a user that does not exist by the foreign key (23503), leaving no row, and admits one for a user that does', async () => {
    const userId = await seedUser()
    const absent = 'sa-proof-absent-' + randomUUID()
    await withRollback(async (run) => {
      const failure = await refusedUnchanged(run, [absent, userId], () => insertRow(run, absent))
      expect({ code: failure.code, constraint: failure.constraint, table: failure.table }).toEqual({ code: '23503', constraint: 'security_action_challenges_user_fk', table: TABLE })
      expect(await imageOf(run, [absent, userId])).toEqual([])
      await insertRow(run, userId)
      expect(await imageOf(run, [userId])).toHaveLength(1)
    })
  })

  it('allows at most one issued row per user, session and purpose (23505 by the partial unique index), and admits another once the first is superseded or consumed', async () => {
    const userId = await seedUser()
    const otherUser = await seedUser()
    await withRollback(async (run) => {
      const sid = 'sid-' + randomUUID()
      const first = await insertRow(run, userId, { session_id: sid })
      const duplicate = await refusedUnchanged(run, [userId, otherUser], () => insertRow(run, userId, { session_id: sid }))
      expect({ code: duplicate.code, constraint: duplicate.constraint, table: duplicate.table }).toEqual({ code: '23505', constraint: 'uq_security_action_live_proof', table: TABLE })
      // The key is the user, the session and the purpose; failed rows are outside the index.
      await insertRow(run, userId, { session_id: sid, ...FAILED })
      await insertRow(run, userId, { session_id: sid, purpose: 'login_grant_disable' })
      await insertRow(run, userId, { session_id: 'sid-' + randomUUID() })
      await insertRow(run, otherUser, { session_id: sid })
      await run(`UPDATE ${TABLE} SET status = 'superseded', superseded_at = now() WHERE id = $1`, [first])
      const second = await insertRow(run, userId, { session_id: sid })
      const again = await refusedUnchanged(run, [userId, otherUser], () => insertRow(run, userId, { session_id: sid }))
      expect([again.code, again.constraint]).toEqual(['23505', 'uq_security_action_live_proof'])
      await run(`UPDATE ${TABLE} SET status = 'consumed', consumed_at = now() WHERE id = $1`, [second])
      await insertRow(run, userId, { session_id: sid })
      expect((await run(
        `SELECT status, count(*)::int AS n FROM ${TABLE} WHERE user_id = $1 AND session_id = $2 AND purpose = 'external_identity_unbind' GROUP BY status ORDER BY status`, [userId, sid],
      )).rows).toEqual([{ status: 'consumed', n: 1 }, { status: 'failed', n: 1 }, { status: 'issued', n: 1 }, { status: 'superseded', n: 1 }])
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
      const expired = await insertRow(run, userId, { session_id: sid, ...expiredLifetime() })
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
    const id = await insertRow(q, userId, { session_id: sid, proof_hash: hashProofSecret(secret), ...expiredLifetime() })
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

  it('refuses with STALE after a role held at issuance gained a code, the user\'s own rows untouched', async () => {
    const userId = await seedUser()
    const role = 'sa-proof-role-' + randomUUID()
    await grantRole(userId, role)
    const sid = await seedSession(userId)
    const service = serviceOn()
    const { context, issued, witness } = await issueFor(userId, sid, service)
    await grantRoleCode(role, 'tasks:read')
    await expectRefusal(consumeWith(userId, context, service, consumeInput(issued.proof, { target: { kind: 'identity_revision', witness } })), 'SECURITY_ACTION_PROOF_STALE')
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
    // The watermark is copied from the row inside the database, so it equals created_at to the microsecond.
    await q(
      `INSERT INTO user_session_revocations (user_id, revoked_after)
       SELECT user_id, created_at FROM ${TABLE} WHERE user_id = $1 AND status = 'issued'
       ON CONFLICT (user_id) DO UPDATE SET revoked_after = EXCLUDED.revoked_after`,
      [other],
    )
    expect((await q(`SELECT (r.revoked_after = c.created_at) AS same FROM user_session_revocations r JOIN ${TABLE} c ON c.user_id = r.user_id WHERE r.user_id = $1 AND c.status = 'issued'`, [other])).rows[0].same).toBe(true)
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
