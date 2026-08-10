/**
 * W6-1 (#4556) — the two load-bearing guarantees of
 * `GET /api/attendance/groups/:groupId/effective-policy`:
 *
 *  1. `rbacGuard('attendance', 'admin')` is what stands between an
 *     unauthenticated or under-permissioned caller and the handler. This
 *     suite proves it behaviourally (the response the mocked DB layer could
 *     only produce if the handler ran), not by reading the route's source.
 *  2. The membership check, the groupId validation, and every aggregate
 *     read share exactly one database transaction, opened once per request.
 *     Proved by asserting the shared-transaction mock is invoked once and
 *     the pool-level mock is never invoked at all.
 *
 * DB-free: `../../src/db/pg` is replaced with a spy transaction whose
 * client answers a small, closed set of SQL shapes for a `free_time` group
 * (which never calls the fixed-schedule effectiveness service, keeping the
 * canned SQL surface to exactly what this module itself authors). The
 * real-DB integration suite covers the `fixed_shift` path, where the
 * injected FSER service also shares the same transaction handle.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

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
    isAdmin: vi.fn(async () => false),
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
function respond(sql: string, memberRow: Row | null): { rows: Row[]; rowCount: number } {
  const s = sql.toLowerCase()
  if (s.includes('set transaction read only')) return { rows: [], rowCount: 0 }
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

function installSharedTransaction(memberRow: Row | null): { calls: string[] } {
  const calls: string[] = []
  transactionMock.mockImplementation(async (handler: (client: Client) => Promise<unknown>) => {
    const client: Client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        return respond(sql, memberRow)
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
  vi.mocked(isAdmin).mockReset().mockResolvedValue(false)
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

describe('the membership check, the groupId validation, and the aggregate reads share ONE transaction', () => {
  it('a platform-admin caller short-circuits the membership statement, but the aggregate reads still run — one transaction, zero pool queries', async () => {
    const { calls } = installSharedTransaction(null)
    pinned.setApp(makeApp({ id: ADMIN_USER, role: 'admin', orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(200)
    expect(res.body.data.groupId).toBe(GROUP)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(queryMock).not.toHaveBeenCalled()
    // No `user_orgs` statement: the admin claim short-circuits it.
    expect(calls.some((sql) => sql.toLowerCase().includes('from user_orgs'))).toBe(false)
    // But the aggregate's own reads did run, on the same handle.
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
    const membershipCalls = calls.filter((sql) => sql.toLowerCase().includes('from user_orgs'))
    expect(membershipCalls.length).toBe(1)
    expect(calls.some((sql) => sql.toLowerCase().includes('from attendance_groups'))).toBe(true)
    // The membership statement ran BEFORE any aggregate read, on the one
    // handle both share.
    const membershipIndex = calls.findIndex((sql) => sql.toLowerCase().includes('from user_orgs'))
    const groupIndex = calls.findIndex((sql) => sql.toLowerCase().includes('from attendance_groups'))
    expect(membershipIndex).toBeGreaterThanOrEqual(0)
    expect(groupIndex).toBeGreaterThan(membershipIndex)
  })

  it('a delegated caller who is not an active member of the org is refused by the membership statement itself', async () => {
    installSharedTransaction(null)
    pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
    const res = await request(pinned.url()).get(`/api/attendance/groups/${GROUP}/effective-policy`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Org membership required for effective-policy', details: undefined } })
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})
