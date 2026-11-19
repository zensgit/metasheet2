/**
 * D21 (slice Y5a) x #6924: the authorization-exception writers (direct grant / revoke, template
 * apply, legacy users.permissions revoke) no longer bump inline in routes/permissions.ts; they run
 * inside withAuthorizationInputTransaction, whose R5 step is the access-graph mutex. Driven here
 * through the REAL contract entry, the REAL mutex and the REAL writer with a recording connection:
 * the subject authorization version bump comes after the locks outside the admission holder's set
 * (world advisory, namespace-admission advisory) and before the users rows and every DML. The
 * operation intent's NOWAIT reaches the bump: a held version row answers the retryable busy error.
 */
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: state.transaction }) },
}))
vi.mock('../../src/db/pg', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('../../src/rbac/service', () => ({
  invalidateUserPerms: vi.fn(),
  listUserPermissions: vi.fn(async () => ['attendance:read']),
}))
vi.mock('../../src/admin/authorization-operation-fence', () => ({
  acquireAuthorizationOperationFence: async (query: (sql: string) => Promise<unknown>) => { await query('SELECT authorization_operation_fence_test') },
}))

import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'
import {
  AUTHORIZATION_INPUT_STATEMENTS,
  AuthorizationInputBusyError,
  withAuthorizationInputTransaction,
} from '../../src/rbac/authorization-input-lock'

type Recorded = { sql: string; params: unknown[] }

const BUMP = /INSERT INTO subject_authorization_versions/
const NOWAIT_PRELOCK = /FROM subject_authorization_versions[\s\S]*FOR UPDATE NOWAIT/
const USERS_LOCK = /FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/

function recordingConnection(options: { directCodes?: string[]; failNowaitPrelock?: boolean } = {}) {
  const statements: Recorded[] = []
  const query = async (raw: string, params: unknown[] = []) => {
    const sql = String(raw)
    statements.push({ sql, params })
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.readTimeouts) return { rows: [{ lock_timeout: '0', statement_timeout: '0' }] }
    if (/pg_try_advisory/.test(sql)) return { rows: [{ acquired: true }] }
    if (options.failNowaitPrelock && NOWAIT_PRELOCK.test(sql)) throw Object.assign(new Error('could not obtain lock on row'), { code: '55P03' })
    if (USERS_LOCK.test(sql)) return { rows: [{ id: params[0], name: null, email: null, username: null, mobile: null, activation_status: 'activated', role: 'user', is_active: true, access_generation: 1, deleted_at: null, purged_at: null }] }
    if (/FROM user_roles/.test(sql)) return { rows: [{ role_id: 'admin' }] }
    if (/SELECT permission_code FROM user_permissions/.test(sql)) return { rows: (options.directCodes ?? []).map((code) => ({ permission_code: code })) }
    if (/SELECT code FROM permissions/.test(sql)) return { rows: (params[0] as string[]).map((code) => ({ code })) }
    if (/^(INSERT INTO|DELETE FROM) user_permissions/.test(sql)) return { rows: [{ user_id: params[0], permission_code: params[1] }], rowCount: 1 }
    if (/UPDATE users[\s\S]*SET permissions/.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 }
    if (/pg_typeof/.test(sql)) return { rows: [{ permissions_type: 'jsonb', permissions: ['workflow:read'] }] }
    if (/to_jsonb\(permissions\)/.test(sql)) return { rows: [{ permissions: ['workflow:read'] }] }
    if (/SET access_generation/.test(sql)) return { rows: [{ access_generation: 2 }] }
    return { rows: [], rowCount: 0 }
  }
  state.transaction.mockReset()
  state.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }))
  return statements
}

function firstIndex(statements: Recorded[], pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement.sql))
}

function assertBumpOrder(statements: Recorded[], dml: RegExp) {
  const world = statements.findIndex((statement) => statement.sql === AUTHORIZATION_INPUT_STATEMENTS.worldShared || /pg_(try_)?advisory_xact_lock(_shared)?\(20261106, 1\)/.test(statement.sql))
  const admissions = statements
    .map((statement, index) => (statement.sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission ? index : -1))
    .filter((index) => index >= 0)
  const bumps = statements.map((statement, index) => (BUMP.test(statement.sql) ? index : -1)).filter((index) => index >= 0)
  const firstUsers = firstIndex(statements, USERS_LOCK)
  const firstDml = firstIndex(statements, dml)
  expect(world).toBeGreaterThanOrEqual(0)
  expect(admissions.length).toBeGreaterThan(0)
  expect(bumps).toHaveLength(1)
  // Both users (target and actor witness) are bumped in ONE sorted statement.
  expect(statements[bumps[0]].params).toEqual([['admin-1', 'user-1']])
  expect(bumps[0]).toBeGreaterThan(world)
  expect(bumps[0]).toBeGreaterThan(Math.max(...admissions))
  expect(firstUsers).toBe(bumps[0] + 1)
  expect(firstDml).toBeGreaterThan(firstUsers)
  // No NOWAIT pre-lock outside the operation intent.
  expect(firstIndex(statements, NOWAIT_PRELOCK)).toBe(-1)
}

describe('D21 x #6924 — the exception writers bump through the contract mutex', () => {
  it('direct grant: world → admission advisory → ONE sorted subject bump → users FOR UPDATE → user_permissions INSERT', async () => {
    const statements = recordingConnection()
    const result = await writeLegacyAuthorizationException({ actorId: 'admin-1', userId: 'user-1', action: { kind: 'direct.grant', code: 'attendance:read' } })
    expect(result.changed).toBe(true)
    assertBumpOrder(statements, /^INSERT INTO user_permissions/)
  })

  it('direct revoke: the same order before the user_permissions DELETE', async () => {
    const statements = recordingConnection({ directCodes: ['attendance:read'] })
    const result = await writeLegacyAuthorizationException({ actorId: 'admin-1', userId: 'user-1', action: { kind: 'direct.revoke', code: 'attendance:read' } })
    expect(result.changed).toBe(true)
    assertBumpOrder(statements, /^DELETE FROM user_permissions/)
  })

  it('template apply: the same order before the first templated INSERT', async () => {
    const statements = recordingConnection()
    const result = await writeLegacyAuthorizationException({ actorId: 'admin-1', userId: 'user-1', action: { kind: 'template.apply', templateId: 'attendance-employee', codes: ['attendance:read', 'attendance:write'] } })
    expect(result.changed).toBe(true)
    assertBumpOrder(statements, /^INSERT INTO user_permissions/)
  })

  it('legacy revoke: the same order before the users.permissions UPDATE', async () => {
    const statements = recordingConnection()
    const result = await writeLegacyAuthorizationException({ actorId: 'admin-1', userId: 'user-1', action: { kind: 'legacy.revoke', code: 'workflow:read' } })
    expect(result.changed).toBe(true)
    assertBumpOrder(statements, /UPDATE users[\s\S]*SET permissions/)
  })

  it('operation intent: the NOWAIT reaches the subject version rows — a held row is the retryable busy error, before any users row', async () => {
    const statements = recordingConnection({ failNowaitPrelock: true })
    const work = vi.fn()
    const attempt = withAuthorizationInputTransaction({
      intent: 'AUTHORIZATION_OPERATION',
      operation: { actorId: 'admin-1', clientOperationId: '00000000-0000-4000-8000-000000000001' },
      userIds: ['admin-1', 'user-1'],
      admissionUserIds: ['admin-1', 'user-1'],
    }, work, { transaction: state.transaction as never })
    await expect(attempt).rejects.toBeInstanceOf(AuthorizationInputBusyError)
    await expect(attempt).rejects.toMatchObject({ busyReason: 'lock_timeout' })
    expect(work).not.toHaveBeenCalled()
    const prelock = firstIndex(statements, NOWAIT_PRELOCK)
    expect(prelock).toBeGreaterThan(firstIndex(statements, /authorization_operation_fence_test/))
    expect(statements[prelock].params).toEqual([['admin-1', 'user-1']])
    expect(firstIndex(statements, BUMP)).toBe(-1)
    expect(firstIndex(statements, USERS_LOCK)).toBe(-1)
  })
})
