/**
 * W6-1 (#4556) — the three load-bearing guarantees of
 * `GET /api/attendance/groups/:groupId/effective-policy`:
 *
 *  1. `rbacGuard('attendance', 'admin')` is what stands between an
 *     unauthenticated or under-permissioned caller and the handler. This
 *     suite proves it behaviourally (the response the mocked DB layer could
 *     only produce if the handler ran), not by reading the route's source.
 *  2. The post-guard platform-admin lookup, membership check, groupId
 *     validation, and every aggregate read share exactly one database
 *     transaction, opened once per request.
 *     Proved by asserting the shared-transaction mock is invoked once and
 *     the pool-level mock is never invoked at all.
 *  3. In the REAL application (`src/index.ts`, not this file's router-only
 *     mount), the route sits behind the global authentication gate and the
 *     attendance audit/security middleware. Mounting the router directly (as
 *     guarantees 1-2 do, to stay DB-free) cannot prove that placement — this
 *     is a separate, narrow source-text guard over `index.ts` itself. See the
 *     describe block below for the full scope statement.
 *
 * DB-free: `../../src/db/pg` is replaced with a spy transaction whose
 * client answers a small, closed set of SQL shapes for a `free_time` group
 * (which never calls the fixed-schedule effectiveness service, keeping the
 * canned SQL surface to exactly what this module itself authors). The
 * real-DB integration suite covers the `fixed_shift` path, where the
 * injected FSER service also shares the same transaction handle.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import * as ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import {
  enclosingFunctionLikeAt,
  functionLikeLabel,
  locateMarkers,
  type AssemblyMarker,
} from '../helpers/attendance-w6-index-assembly-order'

const queryMock = vi.fn()
const transactionMock = vi.fn()

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (...args: unknown[]) => transactionMock(...args),
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async (userId: string, runQuery?: Parameters<typeof actual.isAdmin>[1]) =>
      runQuery ? actual.isAdmin(userId, runQuery) : false),
    userHasPermission: vi.fn(async () => true),
  }
})

vi.mock('../../src/routes/admin-users', () => ({ ensurePlatformAdmin: vi.fn(async () => null) }))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))
vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return { ...actual, MAX_MANAGER_CHAIN_LEVELS: 10 }
})

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
const { isAdmin, userHasPermission } = await import('../../src/rbac/service')
const actualRbacService = await vi.importActual<typeof import('../../src/rbac/service')>(
  '../../src/rbac/service',
)
const pinned = usePinnedServer()

const ORG = '44444444-4444-4444-8444-444444444444'
const GROUP = '55555555-5555-4555-8555-555555555555'
const DELEGATED_USER = '66666666-6666-4666-8666-666666666666'
const ADMIN_USER = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, unknown>
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number }> }

/** Every SQL shape a `free_time`, no-rule-set, no-membership-overlap group
 * touches — the aggregate's own reads, plus the membership check when the
 * caller is not admin. Throws on anything unmatched so drift is loud. */
function respond(
  sql: string,
  memberRow: Row | null,
  platformAdminRow: Row | null = null,
): { rows: Row[]; rowCount: number } {
  const s = sql.toLowerCase()
  if (s.includes('set transaction read only')) return { rows: [], rowCount: 0 }
  if (s.includes('from user_roles')) {
    const rows = platformAdminRow ? [platformAdminRow] : []
    return { rows, rowCount: rows.length }
  }
  if (s.includes('from user_orgs uo')) {
    const rows = memberRow ? [memberRow] : []
    return { rows, rowCount: rows.length }
  }
  if (s.includes('from attendance_groups')) {
    return {
      rows: [{ id: GROUP, attendance_type: 'free_time', timezone: 'Asia/Shanghai', rule_set_id: null }],
      rowCount: 1,
    }
  }
  if (s.includes('from attendance_group_members')) return { rows: [{ cnt: 3 }], rowCount: 1 }
  if (s.includes('from attendance_group_managers')) return { rows: [{ role: 'owner', cnt: 1 }], rowCount: 1 }
  if (s.includes('from attendance_calculation_rollout_state')) return { rows: [], rowCount: 0 }
  if (s.includes('attendance_calculation_group_memberships')) return { rows: [{ cnt: 0 }], rowCount: 1 }
  if (s.includes('from attendance_rule_sets')) return { rows: [], rowCount: 0 }
  throw new Error(`unexpected SQL reached the shared transaction client: ${sql}`)
}

function installSharedTransaction(memberRow: Row | null, platformAdminRow: Row | null = null): { calls: string[] } {
  const calls: string[] = []
  transactionMock.mockImplementation(async (handler: (client: Client) => Promise<unknown>) => {
    const client: Client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        return respond(sql, memberRow, platformAdminRow)
      }),
    }
    return handler(client)
  })
  return { calls }
}

function makeApp(user: Record<string, unknown> | undefined) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

beforeEach(() => {
  queryMock.mockReset()
  transactionMock.mockReset()
  vi.mocked(isAdmin).mockReset().mockImplementation(
    async (userId, runQuery) => (runQuery ? actualRbacService.isAdmin(userId, runQuery) : false),
  )
  vi.mocked(userHasPermission).mockReset().mockResolvedValue(true)
})

describe('rbacGuard is what refuses an unauthenticated caller', () => {
  it('a request with no authenticated principal is refused before the handler runs', async () => {
    pinned.setApp(makeApp(undefined))
    // The query param is the discriminator: rbacGuard denies BEFORE the
    // handler's own body ever runs, so if this ever became a 400
    // QUERY_NOT_ACCEPTED (the handler's own first check) instead of a 401,
    // rbacGuard has stopped running on this route.
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy?x=1`)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('a request with an authenticated principal but no attendance:admin permission is refused', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(userHasPermission).mockResolvedValue(false)
    pinned.setApp(makeApp({ id: DELEGATED_USER }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Insufficient permissions' })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(userHasPermission).toHaveBeenCalledWith(DELEGATED_USER, 'attendance:admin')
  })
})

describe('post-guard platform-admin, membership, validation, and aggregate reads share ONE transaction', () => {
  it('a platform-admin caller short-circuits the membership statement, but the aggregate reads still run — one transaction, zero pool queries', async () => {
    const { calls } = installSharedTransaction(null)
    pinned.setApp(makeApp({ id: ADMIN_USER, role: 'admin', orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(200)
    expect(res.body.data.groupId).toBe(GROUP)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(queryMock).not.toHaveBeenCalled()
    expect(calls.some((sql) => sql.toLowerCase().includes('from user_roles'))).toBe(false)
    // No `user_orgs` statement: the admin claim short-circuits it.
    expect(calls.some((sql) => sql.toLowerCase().includes('from user_orgs'))).toBe(false)
    // But the aggregate's own reads did run, on the same handle.
    expect(calls.some((sql) => sql.toLowerCase().includes('from attendance_groups'))).toBe(true)
  })

  it('a DB-backed platform admin without a legacy role is recognized on the shared handle and skips membership', async () => {
    const { calls } = installSharedTransaction(null, { '?column?': 1 })
    pinned.setApp(makeApp({ id: ADMIN_USER, orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(200)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(queryMock).not.toHaveBeenCalled()
    expect(calls.filter((sql) => sql.toLowerCase().includes('from user_roles'))).toHaveLength(1)
    expect(calls.some((sql) => sql.toLowerCase().includes('from user_orgs'))).toBe(false)
    expect(calls.some((sql) => sql.toLowerCase().includes('from attendance_groups'))).toBe(true)
  })

  it('a delegated (non-admin) caller executes exactly one membership statement, then the aggregate reads — all on the same handle', async () => {
    const { calls } = installSharedTransaction({ '?column?': 1 })
    pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(200)
    expect(res.body.data.groupId).toBe(GROUP)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(queryMock).not.toHaveBeenCalled()
    const adminRoleIndex = calls.findIndex((sql) => sql.toLowerCase().includes('from user_roles'))
    const membershipCalls = calls.filter((sql) => sql.toLowerCase().includes('from user_orgs'))
    expect(membershipCalls.length).toBe(1)
    expect(calls.some((sql) => sql.toLowerCase().includes('from attendance_groups'))).toBe(true)
    // The membership statement ran BEFORE any aggregate read, on the one
    // handle both share.
    const membershipIndex = calls.findIndex((sql) => sql.toLowerCase().includes('from user_orgs'))
    const groupIndex = calls.findIndex((sql) => sql.toLowerCase().includes('from attendance_groups'))
    expect(adminRoleIndex).toBeGreaterThanOrEqual(0)
    expect(membershipIndex).toBeGreaterThan(adminRoleIndex)
    expect(membershipIndex).toBeGreaterThanOrEqual(0)
    expect(groupIndex).toBeGreaterThan(membershipIndex)
  })

  it('a delegated caller who is not an active member of the org is refused by the membership statement itself', async () => {
    installSharedTransaction(null)
    pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * Guarantee 3 (see file header): in the REAL application assembly, this
 * route sits behind the global authentication gate and the attendance
 * audit/security middleware. The suites above mount `attendanceAdminRouter()`
 * directly on a bare Express app — necessary to stay DB-free, but it proves
 * only `rbacGuard` and the shared transaction. It cannot see `src/index.ts`,
 * where the real app registers the global gate, then the audit/security
 * middleware, and only after that the attendance routers.
 *
 * Scope, stated narrowly: this is a source-text guard over `index.ts`, over
 * four markers named as exact needles. It proves registration ORDER and
 * MULTIPLICITY (each marker occurs exactly once, and the three upstream
 * markers precede the route registration) and that all four calls are made
 * from the SAME method (so a marker relocated into a different method that
 * runs at a different time, or not at all on some path, cannot satisfy it by
 * merely appearing earlier in the file's text). It is not a runtime proof —
 * `MetaSheetServer` is too heavy to construct in a unit test (full plugin
 * loader, DB pool, etc.); `multitable-w11-bridge-wiring.guard.test.ts` is the
 * house's existing precedent for this exact shape.
 */
describe('the real app assembly (index.ts) registers this route behind the global gate and the attendance audit/security middleware', () => {
  const indexPath = join(__dirname, '../../src/index.ts')
  const indexText = readFileSync(indexPath, 'utf8')
  const indexSource = ts.createSourceFile(indexPath, indexText, ts.ScriptTarget.ES2022, true)

  const MARKERS: readonly AssemblyMarker[] = [
    { label: 'global authentication gate', needle: 'if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)' },
    { label: 'attendance audit middleware', needle: 'this.app.use(attendanceAuditMiddleware())' },
    { label: 'attendance security middleware', needle: 'this.app.use(attendanceSecurityMiddleware())' },
    { label: 'aggregate route registration', needle: 'this.app.use(attendanceAdminRouter())' },
  ]

  const locations = locateMarkers(indexText, MARKERS)
  const [gate, audit, security, route] = locations

  it('non-vacuity: every marker is present exactly once', () => {
    expect(locations.map((loc) => ({ label: loc.label, occurrences: loc.occurrences }))).toEqual(
      MARKERS.map((marker) => ({ label: marker.label, occurrences: 1 })),
    )
  })

  it('the global gate precedes the route registration', () => {
    expect(gate.index).toBeGreaterThanOrEqual(0)
    expect(route.index).toBeGreaterThan(gate.index)
  })

  it('the attendance audit middleware precedes the route registration', () => {
    expect(audit.index).toBeGreaterThanOrEqual(0)
    expect(route.index).toBeGreaterThan(audit.index)
  })

  it('the attendance security middleware precedes the route registration', () => {
    expect(security.index).toBeGreaterThanOrEqual(0)
    expect(route.index).toBeGreaterThan(security.index)
  })

  it('all four markers are registered from the SAME method — the real assembly block, not merely the same file', () => {
    const enclosing = locations.map((loc) => enclosingFunctionLikeAt(indexSource, loc.index))
    expect(enclosing.every((node) => node !== null)).toBe(true)
    expect(enclosing.every((node) => node === enclosing[0])).toBe(true)
    expect(functionLikeLabel(enclosing[0] as ts.Node)).toBe('setupMiddleware')
  })
})
