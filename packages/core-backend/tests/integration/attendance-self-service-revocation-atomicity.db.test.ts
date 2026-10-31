/**
 * R2/R3: isolated-schema PostgreSQL witnesses. No migrated/customer tables are used.
 * Fails (never skip-green) without DATABASE_URL. Parent runs this on its idle test cluster.
 * AuthService and both RBAC writers are real; session/alias infrastructure and RBAC profile
 * collection are controlled here. Route-to-transaction wiring is covered by admin-users-routes.
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryResult } from 'pg'
import * as bcrypt from 'bcryptjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  permissions: [] as string[],
  invalidate: vi.fn(),
}))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ ...io, getInternalPool: () => null }) },
}))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: async () => false,
  listUserPermissions: async () => [...io.permissions],
  invalidateUserPerms: io.invalidate,
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: () => 'r2r3-isolated-test-secret-abcdefghijklmnopqrstuvwxyz' },
}))
vi.mock('../../src/auth/session-revocation', () => ({ isUserSessionRevoked: async () => false }))
vi.mock('../../src/auth/session-registry', () => ({
  isUserSessionActive: async () => true,
  createUserSession: async () => undefined,
}))
vi.mock('../../src/auth/login-alias-service', () => ({
  isAuthLoginAliasCutoverEnabled: () => false,
  assertAliasCutoverAllowed: () => undefined,
  claimNonEmptyLoginAliasesOrThrow: async () => undefined,
  findUserIdByLoginAlias: async () => null,
}))

import { AuthService, USER_ROLE_ASSIGNMENT_RETRY_LIMIT } from '../../src/auth/AuthService'
import { assignUserRoles, unassignUserRoles } from '../../src/rbac/role-assignment'
import {
  disableNamespaceAdmissionsWithoutRoles,
  filterPermissionCodesByNamespaceAdmission,
  listRoleNamespaces,
  lockNamespaceAdmissionWrites,
  setUserNamespaceAdmission,
} from '../../src/rbac/namespace-admission'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type Phase = 'before-lock' | 'after-admission' | 'after-insert' | 'after-rollback'
function pause(phase: Phase) {
  const reached = deferred()
  const release = deferred()
  return { phase, reached, release, used: false }
}

const schema = `r2r3_${randomUUID().replace(/-/g, '')}`
const userId = 'r2r3-subject'
const password = 'IsolatedPass9A'
let pool: Pool
let setupPool: Pool
let schemaCreated = false
let auth: AuthService
let passwordHash: string
let gate: ReturnType<typeof pause> | undefined
let insertAttempts = 0
let admissionReads = 0
const sqlStates: string[] = []

async function at(phase: Phase) {
  if (!gate || gate.used || gate.phase !== phase) return
  gate.used = true
  gate.reached.resolve()
  await gate.release.promise
}

async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// Same atomic composition as the two HTTP unassign paths; each statement is shipped code.
async function revoke(lockAttempt?: (pid: number) => void) {
  return transaction(async (client) => {
    if (lockAttempt) {
      const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      lockAttempt(pid.rows[0].pid)
    }
    await lockNamespaceAdmissionWrites(client, userId)
    await unassignUserRoles({
      userIds: [userId], roleId: 'attendance_employee',
      scope: { kind: 'platform-admin' }, executor: client,
    })
    return disableNamespaceAdmissionsWithoutRoles({
      userId,
      namespaces: await listRoleNamespaces('attendance_employee', client.query.bind(client)),
      revokedRoleId: 'attendance_employee',
      source: 'role_unassigned',
      actorId: 'r2r3-admin',
    }, client.query.bind(client))
  })
}

async function persistedState() {
  const membership = await pool.query(
    'SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [userId],
  )
  const admission = await pool.query(
    'SELECT enabled, source FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2',
    [userId, 'attendance'],
  )
  return { roles: membership.rows.map((row) => row.role_id), admission: admission.rows }
}

const revokedState = { roles: [], admission: [{ enabled: false, source: 'role_unassigned' }] }

function verify() {
  const token = auth.createToken({
    id: userId, email: 'subject@r2r3.invalid', role: 'user', name: 'Synthetic subject',
    permissions: [], created_at: new Date(), updated_at: new Date(),
  })
  return auth.verifyToken(token)
}

async function expectBlocked(pid: number) {
  // Positive PG wait witness: no sleep-only assumption that the second client is blocked.
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid],
    )
    if (result.rows[0].blocked) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Expected the revoke transaction to wait on the bootstrap lock')
}

describe('default attendance bootstrap/revocation atomicity (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the isolated R2/R3 DB gate')
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PRODUCT_MODE', 'platform')
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    setupPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    await setupPool.query(`CREATE SCHEMA ${schema}`)
    schemaCreated = true
    pool = new Pool({
      connectionString: process.env.DATABASE_URL, max: 4,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=4000`,
    })
    expect((await pool.query('SHOW default_transaction_isolation')).rows)
      .toEqual([{ default_transaction_isolation: 'read committed' }])
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY, email text UNIQUE, username text, mobile text, name text,
        role text DEFAULT 'user', permissions jsonb DEFAULT '[]', password_hash text,
        is_active boolean DEFAULT true, must_change_password boolean DEFAULT false,
        activation_status text DEFAULT 'activated', local_password_set boolean DEFAULT true,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_login_at timestamptz
      );
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean);
      CREATE TABLE roles (id text PRIMARY KEY);
      CREATE TABLE role_permissions (role_id text, permission_code text);
      CREATE TABLE user_roles (user_id text REFERENCES users(id), role_id text REFERENCES roles(id), PRIMARY KEY (user_id, role_id));
      CREATE TABLE user_permissions (user_id text, permission_code text, PRIMARY KEY (user_id, permission_code));
      CREATE TABLE user_namespace_admissions (
        user_id text REFERENCES users(id), namespace text, enabled boolean NOT NULL,
        source text NOT NULL, granted_by text, updated_by text,
        created_at timestamptz, updated_at timestamptz, PRIMARY KEY (user_id, namespace)
      );
      CREATE SEQUENCE busy_attempts;
      CREATE TABLE busy_control (fail_count integer NOT NULL);
      INSERT INTO busy_control VALUES (0);
      CREATE FUNCTION busy_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('${schema}.busy_attempts') <= (SELECT fail_count FROM busy_control) THEN
          RAISE EXCEPTION '${RECOVERY_AUTHORITY_BUSY_MARKER}' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER busy_insert BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION busy_insert();
      INSERT INTO roles VALUES ('attendance_employee'), ('attendance_reader');
      INSERT INTO role_permissions VALUES ('attendance_employee', 'attendance:read'),
        ('attendance_employee', 'attendance:write'), ('attendance_reader', 'attendance:read');
    `)
    io.query.mockImplementation((sql: string, params?: unknown[]) => pool.query(sql, params))
    io.transaction.mockImplementation(async (callback: (client: { query: typeof io.query }) => Promise<unknown>) => {
      try {
        return await transaction(async (client) => callback({
          query: (async (sql: string, params?: unknown[]): Promise<QueryResult> => {
            if (sql.includes('pg_advisory_xact_lock')) await at('before-lock')
            if (sql.includes('INSERT INTO user_roles')) insertAttempts++
            const result = await client.query(sql, params)
            if (sql.includes('SELECT enabled, source')) {
              admissionReads++
              await at('after-admission')
            }
            if (sql.includes('INSERT INTO user_roles')) await at('after-insert')
            return result
          }) as typeof io.query,
        }))
      } catch (error) {
        sqlStates.push(String((error as { code?: string }).code))
        await at('after-rollback') // transaction has released its PostgreSQL lock
        throw error
      }
    })
    passwordHash = await bcrypt.hash(password, 4)
    auth = new AuthService()
  })

  beforeEach(async () => {
    gate = undefined
    insertAttempts = 0
    admissionReads = 0
    sqlStates.length = 0
    io.permissions = ['workflow:read']
    io.invalidate.mockClear()
    await pool.query('TRUNCATE user_roles, user_permissions, user_namespace_admissions, users CASCADE')
    await pool.query('ALTER SEQUENCE busy_attempts RESTART WITH 1')
    await pool.query('UPDATE busy_control SET fail_count = 0')
    await pool.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, 'subject@r2r3.invalid', 'Synthetic subject', passwordHash])
  })

  afterAll(async () => {
    gate?.release.resolve()
    if (pool) await pool.end()
    if (schemaCreated) await setupPool.query(`DROP SCHEMA ${schema} CASCADE`)
    if (setupPool) await setupPool.end()
    vi.unstubAllEnvs()
  })

  it('persists an absent-row revoke through token verification and fresh password login', async () => {
    await pool.query('INSERT INTO user_roles VALUES ($1, $2)', [userId, 'attendance_employee'])
    expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })
    expect(await revoke()).toEqual(['attendance'])
    expect(await persistedState()).toEqual(revokedState)
    expect((await verify())?.permissions).toEqual(['workflow:read'])
    expect((await auth.login('subject@r2r3.invalid', password))?.user.permissions).toEqual(['workflow:read'])
    expect(await persistedState()).toEqual(revokedState)
    expect(insertAttempts).toBe(0)
  })

  it('still bootstraps never-revoked users and registers a new user with its default role', async () => {
    expect((await verify())?.permissions).toEqual(['workflow:read', 'attendance:read', 'attendance:write'])
    expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })
    const registered = await auth.register('registration@r2r3.invalid', password, 'Synthetic registration')
    expect(registered).not.toBeNull()
    const roles = await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1', [registered?.id])
    expect(roles.rows).toEqual([{ role_id: 'attendance_employee' }])
  })

  it('a steady-state user keeps the merged codes on every authentication but invalidates only on the first insert', async () => {
    const merged = ['workflow:read', 'attendance:read', 'attendance:write']
    expect((await verify())?.permissions).toEqual(merged)
    expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })
    expect(io.invalidate.mock.calls).toEqual([[userId]])
    io.invalidate.mockClear()

    // Role held, no attendance admission row: every authentication still runs the locked backfill, and its
    // ON CONFLICT insert now commits nothing, so the permission cache generation must not move.
    expect((await verify())?.permissions).toEqual(merged)
    expect((await auth.login('subject@r2r3.invalid', password))?.user.permissions).toEqual(merged)
    expect((await auth.login('subject@r2r3.invalid', password))?.user.permissions).toEqual(merged)
    expect(insertAttempts).toBe(4)
    expect(io.invalidate).not.toHaveBeenCalled()
    expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })

    // The driver contract the backfill relies on: the same boundary insert reports rowCount 0 for a held role.
    const again = await assignUserRoles({
      userIds: [userId],
      roleId: 'attendance_employee',
      scope: { kind: 'fixed', roleIds: ['attendance_employee'] },
      executor: { query: (sql, params) => pool.query(sql, params) },
    })
    expect(again).toMatchObject({ affectedUserIds: [], rowCount: 0 })
  })

  it.each([false, true])('a completed revoke wins before a pending bootstrap lock (admission existed=%s)', async (existing) => {
    if (existing) await pool.query(
      "INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1, 'attendance', true, 'seed_backfill')", [userId],
    )
    gate = pause('before-lock')
    const pending = verify()
    try {
      await gate.reached.promise
      await revoke()
      expect(await persistedState()).toEqual(revokedState)
    } finally {
      gate.release.resolve()
    }
    expect((await pending)?.permissions).toEqual(['workflow:read'])
    expect(await persistedState()).toEqual(revokedState)
    expect(insertAttempts).toBe(0)
    expect(io.invalidate).not.toHaveBeenCalled()
  })

  it.each(['after-admission', 'after-insert'] as const)('revoke waits for bootstrap at %s, then removes the committed role', async (phase) => {
    gate = pause(phase)
    const pending = verify()
    let removing: Promise<string[]> | undefined
    try {
      await gate.reached.promise
      let pid = 0
      const started = deferred()
      removing = revoke((value) => { pid = value; started.resolve() })
      await started.promise
      await expectBlocked(pid)
    } finally {
      gate.release.resolve()
      await pending
      if (removing) await removing
    }
    expect(await persistedState()).toEqual(revokedState)
    expect(insertAttempts).toBe(1)
    expect((await verify())?.permissions).toEqual(['workflow:read'])
  })

  it('an explicit admission disable also serializes against a pending bootstrap', async () => {
    gate = pause('before-lock')
    const pending = verify()
    try {
      await gate.reached.promise
      await setUserNamespaceAdmission({ userId, namespace: 'attendance', enabled: false })
    } finally {
      gate.release.resolve()
    }
    expect((await pending)?.permissions).toEqual(['workflow:read'])
    expect(await persistedState()).toEqual({ roles: [], admission: [{ enabled: false, source: 'platform_admin' }] })
    expect(insertAttempts).toBe(0)
  })

  it('re-reads the witness after an actual 40001 rollback instead of reusing eligibility', async () => {
    await pool.query('UPDATE busy_control SET fail_count = 1')
    gate = pause('after-rollback')
    const pending = verify()
    try {
      await gate.reached.promise
      expect(sqlStates).toEqual(['40001'])
      await revoke()
      expect(await persistedState()).toEqual(revokedState)
    } finally {
      gate.release.resolve()
    }
    expect((await pending)?.permissions).toEqual(['workflow:read'])
    expect(admissionReads).toBe(2)
    expect(insertAttempts).toBe(1)
    expect((await pool.query('SELECT last_value::integer AS attempts FROM busy_attempts')).rows).toEqual([{ attempts: 1 }])
    expect(await persistedState()).toEqual(revokedState)
    expect(io.invalidate).not.toHaveBeenCalled()
  })

  it('rolls back the membership DELETE if the revoke witness cannot persist', async () => {
    await pool.query('INSERT INTO user_roles VALUES ($1, $2)', [userId, 'attendance_employee'])
    await pool.query("ALTER TABLE user_namespace_admissions ADD CONSTRAINT reject_witness CHECK (source <> 'role_unassigned')")
    try {
      await expect(revoke()).rejects.toMatchObject({ code: '23514' })
      expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })
    } finally {
      await pool.query('ALTER TABLE user_namespace_admissions DROP CONSTRAINT reject_witness')
    }
  })

  it('preserves another role and its admission, direct grants and legacy values while recording opt-out', async () => {
    await pool.query('INSERT INTO user_roles VALUES ($1, $2), ($1, $3)', [userId, 'attendance_employee', 'attendance_reader'])
    await pool.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1, 'attendance', true, 'platform_admin')", [userId])
    await pool.query("INSERT INTO user_permissions VALUES ($1, 'attendance:write')", [userId])
    await pool.query(`UPDATE users SET permissions = '["attendance:read", "workflow:read"]' WHERE id = $1`, [userId])
    expect(await revoke()).toEqual([])
    expect(await persistedState()).toEqual({ roles: ['attendance_reader'], admission: [{ enabled: true, source: 'role_unassigned' }] })
    expect((await pool.query('SELECT permission_code FROM user_permissions WHERE user_id = $1', [userId])).rows)
      .toEqual([{ permission_code: 'attendance:write' }])
    expect((await pool.query('SELECT permissions FROM users WHERE id = $1', [userId])).rows)
      .toEqual([{ permissions: ['attendance:read', 'workflow:read'] }])
    const allowed = ['attendance:read', 'attendance:write', 'workflow:read']
    expect(await filterPermissionCodesByNamespaceAdmission(userId, allowed)).toEqual(allowed)
    io.permissions = allowed
    expect((await verify())?.permissions).toEqual(allowed)
    io.permissions = ['workflow:read'] // even a cold/empty profile must respect enabled=true opt-out
    expect((await verify())?.permissions).toEqual(['workflow:read'])
    expect(insertAttempts).toBe(0)
  })

  it('contains exhausted recovery conflicts and still retries a transient conflict successfully', async () => {
    await pool.query('UPDATE busy_control SET fail_count = $1', [USER_ROLE_ASSIGNMENT_RETRY_LIMIT])
    expect((await verify())?.permissions).toEqual(['workflow:read'])
    expect(sqlStates).toEqual(Array(USER_ROLE_ASSIGNMENT_RETRY_LIMIT).fill('40001'))
    expect(insertAttempts).toBe(USER_ROLE_ASSIGNMENT_RETRY_LIMIT)
    expect((await pool.query('SELECT last_value::integer AS attempts FROM busy_attempts')).rows)
      .toEqual([{ attempts: USER_ROLE_ASSIGNMENT_RETRY_LIMIT }])
    expect(await persistedState()).toEqual({ roles: [], admission: [] })
    expect(io.invalidate).not.toHaveBeenCalled()

    await pool.query('ALTER SEQUENCE busy_attempts RESTART WITH 1')
    await pool.query('UPDATE busy_control SET fail_count = 1')
    expect((await verify())?.permissions).toEqual(['workflow:read', 'attendance:read', 'attendance:write'])
    expect(await persistedState()).toEqual({ roles: ['attendance_employee'], admission: [] })
    expect(insertAttempts).toBe(USER_ROLE_ASSIGNMENT_RETRY_LIMIT + 2)
  })
})
