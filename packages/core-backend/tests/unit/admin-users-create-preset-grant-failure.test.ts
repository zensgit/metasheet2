/**
 * #6185 — POST /api/admin/users with an access preset whose grant the database refuses.
 *
 * On the demo server (a build from before #6172) choosing the platform read-only preset made the
 * page show the database's own foreign-key text: the preset listed a permission code the
 * `permissions` catalogue did not contain, `user_permissions.permission_code` refused it (SQLSTATE
 * 23503), and the route answered with the driver message. The preset is fixed separately (see
 * access-presets-permission-catalogue.guard.test.ts); this file pins what the route does whenever a
 * statement inside its write transaction fails:
 *   - the answer is the router's fixed 500 (#6163 / #6172): `USER_CREATE_FAILED`, the fixed sentence
 *     and the request's correlation id, and nothing of the database error;
 *   - the transaction is rolled back, so no `users` row (and no grant row) is left behind, and no
 *     create audit row is written for a user that does not exist.
 *
 * The REAL router runs behind the REAL correlation-id middleware on a pinned server
 * (usePinnedServer + request(pinned.url()), never request(app) — #4154), and the REAL
 * ConnectionPool `query()` / `transaction()` code runs: only the pg pool inside the main
 * ConnectionPool is replaced by an in-memory fake (the connection-pool-transaction-depth.test.ts
 * pattern) whose client keeps BEGIN / COMMIT / ROLLBACK semantics: writes inside a transaction are
 * staged and become visible only on COMMIT, writes outside one are visible at once. The fake
 * enforces the `user_permissions.permission_code` foreign key against its own catalogue.
 *
 * A POSITIVE CONTROL runs the same request against a fake whose catalogue holds every code of the
 * preset: 200, COMMIT, the user row and the grant rows are there. Without it the rollback
 * assertions would also pass against a fake that never stores anything.
 *
 * Values-free fixtures: invented ids and names; the database text is the shape of a PostgreSQL
 * foreign-key message plus a literal marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import pg from 'pg'
import { usePinnedServer } from '../utils/pinned-server'

const ADMIN_ID = 'admin-6185-probe'
const PRESET_ID = 'platform-viewer'
const MARKER = 'MK6185'
const FK_MESSAGE = `插入或更新表 "user_permissions" 违反外键约束 "user_permissions_permission_code_fkey" ${MARKER}`
const FK_DETAIL = `Key (permission_code)=(${MARKER}:code) is not present in table "permissions".`
const FIXED_SENTENCE = 'Failed to create user'
/** Fragments that must not reach the response: any of them alone is an echo. */
const ECHO_FRAGMENTS = [MARKER, 'user_permissions', 'permission_code_fkey', '违反外键约束', 'is not present', '23503', 'XX000']

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: ADMIN_ID, role: 'admin' } as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => true),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))

vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed-probe-password') }))

// The alias claim has its own load-bearing suites (login-alias-writers*.test.ts); here it is a no-op
// so the only statements inside the transaction are the ones this file is about.
vi.mock('../../src/auth/login-alias-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/login-alias-service')>()
  return { ...actual, claimNonEmptyLoginAliasesOrThrow: vi.fn(async () => []) }
})

vi.mock('../../src/attendance/w4c0-identity', () => ({
  acquireAttendanceCalculationRolloutLock: vi.fn(),
  parseCanonicalAttendanceRolloutOrgKeyV1: vi.fn((value: unknown) => value),
  resolveSegmentCalculationPosture: vi.fn(),
}))

import { correlationIdMiddleware } from '../../src/middleware/correlation'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getAccessPreset } from '../../src/auth/access-presets'
import { adminUsersRouter } from '../../src/routes/admin-users'

// ── in-memory pg pool with transaction semantics ──────────────────────────────────────────────

interface Tables {
  users: string[]
  userPermissions: Array<[string, string]>
}

const db = {
  committed: { users: [], userPermissions: [] } as Tables,
  catalogue: new Set<string>(),
  failOn: null as null | { statement: RegExp; error: unknown },
  /** First line of every statement, in order, across the pool and its clients. */
  statements: [] as string[],
}

function emptyResult(rows: unknown[] = []) {
  return { command: '', rowCount: rows.length, oid: 0, rows, fields: [] }
}

function databaseError(message: string, fields: Record<string, string>): Error {
  // The class the pg driver throws, so the route sees the same constructor and fields.
  const error = new pg.DatabaseError(message, message.length, 'error')
  Object.assign(error, { severity: 'ERROR' }, fields)
  return error
}

function foreignKeyViolation(): Error {
  return databaseError(FK_MESSAGE, {
    code: '23503',
    detail: FK_DETAIL,
    schema: 'public',
    table: 'user_permissions',
    constraint: 'user_permissions_permission_code_fkey',
  })
}

function readStatement(config: unknown, values?: unknown[]): { text: string; values: unknown[] } {
  if (typeof config === 'string') return { text: config, values: values ?? [] }
  const object = config as { text: string; values?: unknown[] }
  return { text: object.text, values: object.values ?? [] }
}

function execute(text: string, values: unknown[], target: Tables) {
  db.statements.push(text.trim().split('\n')[0].trim())
  if (db.failOn && db.failOn.statement.test(text)) throw db.failOn.error
  if (/^\s*INSERT INTO users\b/.test(text)) {
    target.users.push(String(values[0]))
    return emptyResult()
  }
  if (/^\s*INSERT INTO user_permissions\b/.test(text)) {
    const [userId, ...codes] = values.map(String)
    if (codes.some((code) => !db.catalogue.has(code))) throw foreignKeyViolation()
    target.userPermissions.push(...codes.map((code): [string, string] => [userId, code]))
    return emptyResult()
  }
  if (/\bFROM users\s+WHERE id = \$1/.test(text)) {
    const userId = String(values[0])
    if (!db.committed.users.includes(userId)) return emptyResult()
    return emptyResult([{
      id: userId,
      email: null,
      username: 'probe6185',
      name: 'Probe User',
      mobile: null,
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      role: 'user',
      is_active: true,
      is_admin: false,
      activationStatus: 'activated',
      localPasswordSet: true,
      last_login_at: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    }])
  }
  return emptyResult()
}

function fakeClient() {
  let staged: Tables | null = null
  return {
    async query(config: unknown, values?: unknown[]) {
      const statement = readStatement(config, values)
      const keyword = statement.text.trim().toUpperCase()
      if (keyword === 'BEGIN') {
        db.statements.push('BEGIN')
        staged = { users: [], userPermissions: [] }
        return emptyResult()
      }
      if (keyword === 'COMMIT') {
        db.statements.push('COMMIT')
        if (staged) {
          db.committed.users.push(...staged.users)
          db.committed.userPermissions.push(...staged.userPermissions)
        }
        staged = null
        return emptyResult()
      }
      if (keyword === 'ROLLBACK') {
        db.statements.push('ROLLBACK')
        staged = null
        return emptyResult()
      }
      return execute(statement.text, statement.values, staged ?? db.committed)
    },
    release: vi.fn(),
  }
}

const fakePool = {
  query: async (config: unknown, values?: unknown[]) => {
    const statement = readStatement(config, values)
    return execute(statement.text, statement.values, db.committed)
  },
  connect: async () => fakeClient(),
}

// ── app ───────────────────────────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use(correlationIdMiddleware)
  app.use(express.json())
  app.use(adminUsersRouter())
  return app
}

const pinned = usePinnedServer()
const mainPool = poolManager.get()
let originalInternalPool: unknown

function presetCodes(): string[] {
  const preset = getAccessPreset(PRESET_ID)
  if (!preset) throw new Error(`preset ${PRESET_ID} is missing`)
  expect(preset.permissions.length).toBeGreaterThan(0)
  return [...preset.permissions]
}

function createUser() {
  return request(pinned.url())
    .post('/api/admin/users')
    .send({ name: 'Probe User', username: 'probe6185', password: 'WelcomePass9A', presetId: PRESET_ID })
}

beforeEach(() => {
  db.committed = { users: [], userPermissions: [] }
  db.catalogue = new Set()
  db.failOn = null
  db.statements = []
  auditMocks.auditLog.mockReset()
  originalInternalPool = (mainPool as unknown as { pool: unknown }).pool
  Object.defineProperty(mainPool, 'pool', { configurable: true, writable: true, value: fakePool })
  pinned.setApp(buildApp())
})

afterEach(() => {
  Object.defineProperty(mainPool, 'pool', { configurable: true, writable: true, value: originalInternalPool })
})

function expectFixedFailure(response: request.Response) {
  const correlationId = response.headers['x-correlation-id']
  expect(typeof correlationId).toBe('string')
  expect(correlationId.length).toBeGreaterThan(0)
  expect(response.status, response.text).toBe(500)
  expect(response.body).toEqual({
    ok: false,
    error: { code: 'USER_CREATE_FAILED', message: FIXED_SENTENCE, correlationId },
  })
  for (const fragment of ECHO_FRAGMENTS) {
    expect(response.text).not.toContain(fragment)
    expect(JSON.stringify(response.headers)).not.toContain(fragment)
  }
}

function expectNothingLeftBehind() {
  expect(db.statements).toContain('BEGIN')
  expect(db.statements).toContain('ROLLBACK')
  expect(db.statements).not.toContain('COMMIT')
  expect(db.committed.users).toEqual([])
  expect(db.committed.userPermissions).toEqual([])
  expect(auditMocks.auditLog).not.toHaveBeenCalled()
}

describe('POST /api/admin/users — a refused preset grant (#6185)', () => {
  it('POSITIVE CONTROL — every preset code registered: 200, COMMIT, user row and grant rows stored', async () => {
    const codes = presetCodes()
    db.catalogue = new Set(codes)

    const response = await createUser()

    expect(response.status, response.text).toBe(200)
    expect(db.statements).toContain('COMMIT')
    expect(db.statements).not.toContain('ROLLBACK')
    expect(db.committed.users).toHaveLength(1)
    const [userId] = db.committed.users
    expect(response.body.data.user.id).toBe(userId)
    expect(db.committed.userPermissions).toEqual(codes.map((code) => [userId, code]))
  })

  it('foreign-key violation on user_permissions (SQLSTATE 23503): fixed 500 with correlation id, no database text, nothing left behind', async () => {
    const codes = presetCodes()
    // A database whose catalogue lacks one of the preset's codes — the #6185 shape.
    db.catalogue = new Set(codes.slice(1))

    const response = await createUser()

    expectFixedFailure(response)
    // The refusal really came from the grant insert, after the users insert ran in the same transaction.
    const usersInsert = db.statements.indexOf('INSERT INTO users (')
    const grantInsert = db.statements.indexOf('INSERT INTO user_permissions (user_id, permission_code)')
    expect(usersInsert).toBeGreaterThan(db.statements.indexOf('BEGIN'))
    expect(grantInsert).toBeGreaterThan(usersInsert)
    expect(db.statements.indexOf('ROLLBACK')).toBeGreaterThan(grantInsert)
    expectNothingLeftBehind()
  })

  it('any other database error inside the transaction gets the same answer and the same rollback', async () => {
    db.catalogue = new Set(presetCodes())
    db.failOn = {
      statement: /^\s*INSERT INTO user_permissions\b/,
      error: databaseError(`internal error ${MARKER}`, { code: 'XX000', detail: `${MARKER} detail` }),
    }

    const response = await createUser()

    expectFixedFailure(response)
    expect(db.statements).toContain('INSERT INTO users (')
    expectNothingLeftBehind()
  })
})
