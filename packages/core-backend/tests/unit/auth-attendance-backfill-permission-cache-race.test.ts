/**
 * Attendance self-service backfill x RBAC permission-cache generation (platform product mode).
 *
 * Field symptom (stock-prep pilot): a stock-prep main administrator sometimes lost the view-management
 * entry on a page load, with no log line. The chain pinned here, on the REAL code:
 *
 *   1. A non-admin user with no `attendance` admission row is eligible for the self-service backfill on
 *      EVERY authenticated request: the admission filter drops the `attendance:*` codes of the default
 *      role, so `decideAttendanceSelfServiceBackfill` answers 'bootstrap' each time.
 *   2. Once the default role is held, that backfill's INSERT is an ON CONFLICT no-op. It used to call
 *      `invalidateUserPerms` anyway, so every request moved the user's permission-cache generation.
 *   3. `listUserPermissions` (rbac/service.ts) fails closed to [] when the generation moves during its read
 *      AND during its one bounded retry. Two other requests of the same user completing inside one read were
 *      enough: that request then carried only the merged attendance codes, so `stock-prep:admin` was gone and
 *      the view-management clamp predicate failed.
 *
 * Real: AuthService (verifyToken, resolveRbacProfile, the backfill), rbac/service (cache, generation,
 * invalidation), rbac/namespace-admission (filter, subject lock helper), rbac/role-assignment
 * (`assignUserRoles`), multitable/access (`resolveRequestAccess`) and the clamp predicate. Faked: the
 * database driver (an in-memory model answering the exact statements, with ON CONFLICT DO NOTHING ...
 * RETURNING semantics and a FIFO subject lock), jsonwebtoken, the session registry and revocation, and the
 * secret manager. `invalidateUserPerms` is the real function behind a pass-through spy, so the generation
 * really moves whenever it is called.
 *
 * Deterministic: no timers and no random latency. Each request runs under a name (AsyncLocalStorage), and
 * the fake driver can hold one named request's next statement of one kind until the test releases it, so
 * the interleaving is forced rather than sampled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cache-hit counts below assume the default permission-cache TTL, which rbac/service.ts reads once at
// import. Pin it so a shell override (RBAC_CACHE_TTL_MS=0 disables the cache) cannot change them.
vi.hoisted(() => {
  process.env.RBAC_CACHE_TTL_MS = '60000'
})

const jwtMocks = vi.hoisted(() => ({ verify: vi.fn(), sign: vi.fn() }))

const fakeDb = vi.hoisted(() => {
  type StatementKind =
    | 'user-row'
    | 'is-admin'
    | 'permission-codes'
    | 'legacy-permissions'
    | 'role-context'
    | 'admissions'
    | 'subject-lock'
    | 'attendance-admission'
    | 'role-insert'
  type Rows = Array<Record<string, unknown>>
  type Result = { rows: Rows; rowCount: number }
  type Hold = {
    request: string
    kind: StatementKind
    armed: boolean
    markReached: () => void
    released: Promise<void>
    reached: Promise<void>
    release: () => void
  }

  const subject = {
    userId: '',
    roles: new Set<string>(),
    admissions: new Map<string, { enabled: boolean; source: string }>(),
  }
  const rolePermissions = new Map<string, readonly string[]>()
  const statements: Array<{ request: string; kind: StatementKind }> = []
  const unknownStatements: string[] = []
  const holds: Hold[] = []
  const lockTails = new Map<string, Promise<void>>()
  let readRequest: () => string = () => 'unnamed'

  const result = (rows: Rows): Result => ({ rows, rowCount: rows.length })

  function classify(text: string): StatementKind | null {
    if (text.startsWith('SELECT pg_advisory_xact_lock(')) return 'subject-lock'
    if (text.startsWith('SELECT id, email, username') && text.endsWith('FROM users WHERE id = $1')) return 'user-row'
    if (text === 'SELECT permissions FROM users WHERE id = $1') return 'legacy-permissions'
    if (text.startsWith('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2')) return 'is-admin'
    if (text.startsWith('SELECT DISTINCT permission_code AS code FROM (')) return 'permission-codes'
    if (text.startsWith('SELECT ur.role_id, rp.permission_code FROM user_roles ur LEFT JOIN role_permissions rp')) return 'role-context'
    if (text.startsWith('SELECT namespace, enabled, source, granted_by, updated_by, created_at, updated_at FROM user_namespace_admissions WHERE user_id = $1')) {
      return 'admissions'
    }
    if (text.startsWith('SELECT enabled, source FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2')) {
      return 'attendance-admission'
    }
    if (text.startsWith('INSERT INTO user_roles (user_id, role_id)') && text.includes('ON CONFLICT DO NOTHING RETURNING user_id')) {
      return 'role-insert'
    }
    return null
  }

  function answer(kind: StatementKind, params: unknown[]): Result {
    const ownSubject = String(params[0] ?? '') === subject.userId
    switch (kind) {
      case 'subject-lock':
        return result([{ pg_advisory_xact_lock: '' }])
      case 'user-row':
        return result(ownSubject
          ? [{
            id: subject.userId,
            email: null,
            username: subject.userId,
            mobile: null,
            name: 'Synthetic stock-prep administrator',
            role: 'user',
            permissions: [],
            password_hash: 'not-a-hash',
            is_active: true,
            must_change_password: false,
            activation_status: 'activated',
            local_password_set: true,
            created_at: new Date(0),
            updated_at: new Date(0),
          }]
          : [])
      case 'legacy-permissions':
        return result(ownSubject ? [{ permissions: [] }] : [])
      case 'is-admin':
        return result(ownSubject && subject.roles.has(String(params[1])) ? [{ '?column?': 1 }] : [])
      case 'permission-codes': {
        const codes = new Set<string>()
        if (ownSubject) for (const roleId of subject.roles) for (const code of rolePermissions.get(roleId) ?? []) codes.add(code)
        return result([...codes].map((code) => ({ code })))
      }
      case 'role-context': {
        const rows: Rows = []
        if (ownSubject) {
          for (const roleId of subject.roles) {
            const codes = rolePermissions.get(roleId) ?? []
            if (codes.length === 0) rows.push({ role_id: roleId, permission_code: null })
            for (const code of codes) rows.push({ role_id: roleId, permission_code: code })
          }
        }
        return result(rows)
      }
      case 'admissions':
        return result(ownSubject
          ? [...subject.admissions.entries()].map(([namespace, row]) => ({
            namespace,
            enabled: row.enabled,
            source: row.source,
            granted_by: null,
            updated_by: null,
            created_at: null,
            updated_at: null,
          }))
          : [])
      case 'attendance-admission': {
        const row = ownSubject ? subject.admissions.get(String(params[1])) : undefined
        return result(row ? [{ enabled: row.enabled, source: row.source }] : [])
      }
      case 'role-insert': {
        // `INSERT ... SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING user_id`: only rows that
        // were actually inserted come back, and the driver's rowCount counts exactly those.
        const roleId = String(params[1])
        const userIds = Array.isArray(params[0]) ? params[0].map(String) : []
        const inserted = userIds.filter((id) => id === subject.userId && !subject.roles.has(roleId))
        if (inserted.length > 0) subject.roles.add(roleId)
        return result(inserted.map((id) => ({ user_id: id })))
      }
    }
  }

  async function run(sql: string, params: unknown[] = []): Promise<Result> {
    const text = String(sql).replace(/\s+/g, ' ').trim()
    const kind = classify(text)
    if (!kind) {
      unknownStatements.push(text.slice(0, 120))
      return result([])
    }
    const request = readRequest()
    statements.push({ request, kind })
    // The statement's answer is fixed when it starts; a held statement is a read whose reply is in flight.
    const reply = answer(kind, params)
    const hold = holds.find((candidate) => candidate.armed && candidate.request === request && candidate.kind === kind)
    if (hold) {
      hold.armed = false
      hold.markReached()
      await hold.released
    }
    return reply
  }

  /** A transaction client whose subject lock is held until the handler settles, FIFO per key, as in PostgreSQL. */
  async function transaction<T>(handler: (client: { query: typeof run }) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = []
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const reply = await run(sql, params)
        if (String(sql).includes('pg_advisory_xact_lock')) {
          const key = String(params[0])
          const previous = lockTails.get(key) ?? Promise.resolve()
          let releaseLock!: () => void
          lockTails.set(key, new Promise<void>((resolve) => { releaseLock = resolve }))
          releases.push(releaseLock)
          await previous
        }
        return reply
      },
    }
    try {
      return await handler(client)
    } finally {
      for (const releaseLock of releases) releaseLock()
    }
  }

  return {
    poolManager: { get: () => ({ query: run, transaction, getInternalPool: () => ({ query: run }) }) },
    setRequestReader(reader: () => string) {
      readRequest = reader
    },
    defineRole(roleId: string, codes: readonly string[]) {
      rolePermissions.set(roleId, codes)
    },
    seed(options: { userId: string; roles: readonly string[]; admissions: Record<string, { enabled: boolean; source: string }> }) {
      subject.userId = options.userId
      subject.roles = new Set(options.roles)
      subject.admissions = new Map(Object.entries(options.admissions))
      statements.length = 0
      unknownStatements.length = 0
      holds.length = 0
    },
    subjectId: () => subject.userId,
    heldRoles: () => [...subject.roles].sort(),
    /** Hold `request`'s NEXT statement of `kind`. `release()` lets it answer, or disarms the hold if it never came. */
    hold(request: string, kind: StatementKind) {
      let markReached!: () => void
      let release!: () => void
      const reached = new Promise<void>((resolve) => { markReached = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      const entry: Hold = { request, kind, armed: true, markReached, reached, released, release: () => {
        entry.armed = false
        release()
      } }
      holds.push(entry)
      return { reached: entry.reached, release: entry.release }
    },
    count(kind: StatementKind, request?: string) {
      return statements.filter((statement) => statement.kind === kind && (request === undefined || statement.request === request)).length
    },
    unknownStatements: () => [...unknownStatements],
  }
})

vi.mock('jsonwebtoken', () => jwtMocks)
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: fakeDb.poolManager }))
vi.mock('../../src/auth/session-revocation', () => ({ isUserSessionRevoked: vi.fn(async () => false) }))
vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(async () => true),
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: vi.fn(() => 'unit-test-secret-abcdefghijklmnopqrstuvwxyz123456') },
}))
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, invalidateUserPerms: vi.fn(actual.invalidateUserPerms) }
})

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Request } from 'express'
import { AuthService } from '../../src/auth/AuthService'
import { resolveRequestAccess } from '../../src/multitable/access'
import { holdsStockPreparationProjectSheetViewManagement } from '../../src/multitable/stock-preparation-project-sheet-schema-clamp'
import { invalidateUserPerms } from '../../src/rbac/service'

const STOCK_PREP_ADMIN_ROLE_ID = 'stock-prep_admin'
const ATTENDANCE_DEFAULT_ROLE_ID = 'attendance_employee'
const STOCK_PREP_ADMISSION = { 'stock-prep': { enabled: true, source: 'platform_admin' } }

fakeDb.defineRole(STOCK_PREP_ADMIN_ROLE_ID, ['stock-prep:admin'])
fakeDb.defineRole(ATTENDANCE_DEFAULT_ROLE_ID, ['attendance:read', 'attendance:write'])

const requestName = new AsyncLocalStorage<string>()
fakeDb.setRequestReader(() => requestName.getStore() ?? 'unnamed')

/** One authenticated request of a page load: token verification, then the multitable access resolution. */
function pageRequest(service: AuthService, name: string) {
  return requestName.run(name, async () => {
    const user = await service.verifyToken(`${name}-token`)
    const access = await resolveRequestAccess({ user } as unknown as Request)
    return {
      permissions: [...access.permissions].sort(),
      keepsViewManagement: holdsStockPreparationProjectSheetViewManagement(access.permissions),
    }
  })
}

function invalidationsOf(userId: string): number {
  return vi.mocked(invalidateUserPerms).mock.calls.filter(([id]) => id === userId).length
}

const STEADY_STATE_PERMISSIONS = ['attendance:read', 'attendance:write', 'stock-prep:admin']

describe('attendance self-service backfill x permission-cache generation (real AuthService + RBAC)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PRODUCT_MODE', 'platform')
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    jwtMocks.verify.mockImplementation(() => ({ userId: fakeDb.subjectId(), email: '', role: 'user', iat: 0, exp: 0 }))
    vi.mocked(invalidateUserPerms).mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('a request whose permission read straddles two other requests of the same user keeps stock-prep:admin (default role already held)', async () => {
    fakeDb.seed({
      userId: 'u-race-straddle',
      roles: [STOCK_PREP_ADMIN_ROLE_ID, ATTENDANCE_DEFAULT_ROLE_ID],
      admissions: STOCK_PREP_ADMISSION,
    })
    const service = new AuthService()

    // 1. The victim's permission read is in flight.
    const firstRead = fakeDb.hold('victim', 'permission-codes')
    const victim = pageRequest(service, 'victim')
    await firstRead.reached

    // 2. Another request of the same user runs to completion inside that read.
    const second = await pageRequest(service, 'second')

    // 3. The victim's read answers. Before the fix the generation had moved, so listUserPermissions made its
    //    one bounded retry; hold that retry read too, if it is issued.
    const retryRead = fakeDb.hold('victim', 'permission-codes')
    firstRead.release()
    const victimRetried = await Promise.race([retryRead.reached.then(() => true), victim.then(() => false)])

    // 4. A third request runs to completion inside the retry (if any), then everything answers.
    const third = await pageRequest(service, 'third')
    retryRead.release()
    const outcome = await victim

    expect(outcome.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    expect(outcome.keepsViewManagement).toBe(true)
    expect(second.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    expect(third.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    // Steady state: every request still runs the backfill (the locked no-op re-insert), and none of them
    // invalidates, so the victim's read is never retried and the third request is a cache hit.
    expect(fakeDb.count('role-insert')).toBe(3)
    expect(invalidationsOf('u-race-straddle')).toBe(0)
    expect(victimRetried).toBe(false)
    expect(fakeDb.count('permission-codes')).toBe(2)
    expect(fakeDb.heldRoles()).toEqual([ATTENDANCE_DEFAULT_ROLE_ID, STOCK_PREP_ADMIN_ROLE_ID])
    expect(fakeDb.unknownStatements()).toEqual([])
  })

  it('steady state: sequential requests re-insert as a no-op, never invalidate, and read permissions once', async () => {
    fakeDb.seed({
      userId: 'u-steady-sequential',
      roles: [STOCK_PREP_ADMIN_ROLE_ID, ATTENDANCE_DEFAULT_ROLE_ID],
      admissions: STOCK_PREP_ADMISSION,
    })
    const service = new AuthService()

    for (let index = 0; index < 5; index += 1) {
      const outcome = await pageRequest(service, `sequential-${index}`)
      expect(outcome.permissions).toEqual(STEADY_STATE_PERMISSIONS)
      expect(outcome.keepsViewManagement).toBe(true)
    }

    expect(fakeDb.count('role-insert')).toBe(5)
    expect(invalidationsOf('u-steady-sequential')).toBe(0)
    expect(fakeDb.count('permission-codes')).toBe(1)
    expect(fakeDb.unknownStatements()).toEqual([])
  })

  it('first-ever bootstrap inserts the default role, invalidates once and merges; the next request is a no-op', async () => {
    fakeDb.seed({
      userId: 'u-first-bootstrap',
      roles: [STOCK_PREP_ADMIN_ROLE_ID],
      admissions: STOCK_PREP_ADMISSION,
    })
    const service = new AuthService()

    const first = await pageRequest(service, 'first')
    expect(first.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    expect(fakeDb.heldRoles()).toEqual([ATTENDANCE_DEFAULT_ROLE_ID, STOCK_PREP_ADMIN_ROLE_ID])
    expect(invalidationsOf('u-first-bootstrap')).toBe(1)

    const next = await pageRequest(service, 'next')
    expect(next.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    expect(fakeDb.count('role-insert')).toBe(2)
    expect(invalidationsOf('u-first-bootstrap')).toBe(1)
    expect(fakeDb.unknownStatements()).toEqual([])
  })

  it.each([
    ['role_unassigned witness', 'u-skip-role-unassigned', { enabled: false, source: 'role_unassigned' }],
    ['disabled admission', 'u-skip-disabled-admission', { enabled: false, source: 'platform_admin' }],
  ])('a %s still skips: no insert, no invalidation, no attendance codes', async (_label, userId, attendance) => {
    fakeDb.seed({
      userId,
      roles: [STOCK_PREP_ADMIN_ROLE_ID],
      admissions: { ...STOCK_PREP_ADMISSION, attendance },
    })
    const service = new AuthService()

    const outcome = await pageRequest(service, 'revoked')

    expect(outcome.permissions).toEqual(['stock-prep:admin'])
    expect(fakeDb.count('attendance-admission')).toBe(1)
    expect(fakeDb.count('role-insert')).toBe(0)
    expect(fakeDb.heldRoles()).toEqual([STOCK_PREP_ADMIN_ROLE_ID])
    expect(invalidationsOf(userId)).toBe(0)
    expect(fakeDb.unknownStatements()).toEqual([])
  })

  it('an enabled attendance admission still skips: its codes pass the filter, so no backfill transaction runs', async () => {
    fakeDb.seed({
      userId: 'u-enabled-skip',
      roles: [STOCK_PREP_ADMIN_ROLE_ID, ATTENDANCE_DEFAULT_ROLE_ID],
      admissions: { ...STOCK_PREP_ADMISSION, attendance: { enabled: true, source: 'platform_admin' } },
    })
    const service = new AuthService()

    const outcome = await pageRequest(service, 'enabled')

    expect(outcome.permissions).toEqual(STEADY_STATE_PERMISSIONS)
    expect(fakeDb.count('subject-lock')).toBe(0)
    expect(fakeDb.count('attendance-admission')).toBe(0)
    expect(fakeDb.count('role-insert')).toBe(0)
    expect(invalidationsOf('u-enabled-skip')).toBe(0)
    expect(fakeDb.unknownStatements()).toEqual([])
  })
})
