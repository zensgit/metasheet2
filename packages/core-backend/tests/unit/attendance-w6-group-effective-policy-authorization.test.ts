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
 *  3. The client-input boundary at the top of the handler — org-identity is
 *     derived only from the authenticated principal, and any query/body
 *     `orgId` the client repeats must byte-equal it or the request is
 *     refused before any aggregate SQL runs; every OTHER query/body key is
 *     rejected outright (W6-R7). See the "client-input boundary" describe
 *     block below — DB-free, same harness as guarantees 1-2.
 *  4. In the REAL application (`src/index.ts`, not this file's router-only
 *     mount), the route sits behind the global authentication gate and the
 *     attendance audit/security middleware. Mounting the router directly (as
 *     guarantees 1-3 do, to stay DB-free) cannot prove that placement — this
 *     is a separate AST registration-site model over `index.ts` itself
 *     (`tests/helpers/attendance-w6-index-assembly-order.ts`), not a
 *     source-text guard. See the describe block below for the full scope
 *     statement, including the honest (weaker) claim for the gate subject.
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
  buildAssemblyModel,
  buildThisPartition,
  deriveSafeCensus,
  independentThisStarts,
  findThisMethodCalls,
  sitesInMethod,
  subjectState,
  textMentions,
  type AssemblyModel,
  type ThisPartition,
} from '../helpers/attendance-w6-index-assembly-order'
import { createHash } from 'node:crypto'
import { isApiPath } from '../../src/auth/api-path-policy'
import { isWhitelisted, isPublicFormAuthBypass } from '../../src/auth/jwt-middleware'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'

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
 * Guarantee 3 (see file header): the client-input boundary at the top of
 * the handler (`attendance-admin.ts:177-192` for the org-selector mismatch
 * predicate, `:1740-1761` for the query/body rejection), all BEFORE any
 * aggregate SQL runs. Prior to this describe block, ONLY the real-DB suite
 * `attendance-w6-group-effective-policy.db.test.ts` exercised these —
 * entirely behind `describeIfDatabase`, so without `DATABASE_URL` that file
 * skip-greens and these guards were verified by nothing in the no-DB unit
 * lane. Every negative here is proven discriminating by neutering the
 * corresponding production predicate and confirming the specific test below
 * reds (see PR description / commit log for that mutation round); every
 * positive control below shares the SAME successful-response harness as the
 * "post-guard..." suite above, so "it refuses" is distinguishable from
 * "it's broken" — a positive control that never became a probe result would
 * make the negatives compatible with a handler that always rejects.
 */
describe('the client-input boundary: org-selector mismatch and query/body rejection, before any aggregate SQL', () => {
  const OTHER_ORG = '88888888-8888-4888-8888-888888888888'
  const PATH = `/api/attendance/groups/${GROUP}/effective-policy`

  describe('org-selector mismatch — negatives (403, zero DB calls)', () => {
    it('a query orgId that does not byte-equal the authenticated org is refused', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(`${PATH}?orgId=${OTHER_ORG}`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('a body orgId that does not byte-equal the authenticated org is refused', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).send({ orgId: OTHER_ORG })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an x-org-id header that does not byte-equal the authenticated org is refused', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).set('x-org-id', OTHER_ORG)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('a present-but-EMPTY x-org-id header is treated as a mismatch, not as absent (documented fail-closed edge case)', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).set('x-org-id', '')
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })
  })

  describe('org-selector mismatch — positive controls (matching value is accepted, request proceeds to 200)', () => {
    it('a query orgId that byte-equals the authenticated org is accepted (same successful path as the no-selector case)', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(`${PATH}?orgId=${ORG}`)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('a body orgId that byte-equals the authenticated org is accepted', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).send({ orgId: ORG })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('state-selecting QUERY parameters — negative (400 QUERY_NOT_ACCEPTED, zero DB calls)', () => {
    it('any query key other than orgId is rejected before aggregate SQL', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(`${PATH}?groupId=other`)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: 'QUERY_NOT_ACCEPTED', message: 'This endpoint accepts no state-selecting query parameters', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an extra query key alongside a matching orgId is still rejected — orgId is an assertion, not an allowlist opener', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(`${PATH}?orgId=${ORG}&state=active`)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: 'QUERY_NOT_ACCEPTED', message: 'This endpoint accepts no state-selecting query parameters', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })
  })

  describe('state-bearing BODY — negatives (400 BODY_NOT_ACCEPTED, two distinct branches, zero DB calls)', () => {
    it('a non-object body (array) is rejected — "no state-bearing request body"', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).set('Content-Type', 'application/json').send('[1,2,3]')
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: 'BODY_NOT_ACCEPTED', message: 'This endpoint accepts no state-bearing request body', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an object body with a field other than orgId is rejected — "no state-bearing request body fields"', async () => {
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).send({ note: 'x' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: 'BODY_NOT_ACCEPTED', message: 'This endpoint accepts no state-bearing request body fields', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })
  })

  describe('empty body — positive control (explicitly accepted, not merely untested)', () => {
    it('an explicit empty JSON object body ({}) is accepted, proceeding to 200', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeApp({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH).send({})
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * Guarantee 3 continued (F1b follow-up): `getAuthenticatedAttendanceGroupEffectivePolicyOrgId`
 * (`attendance-admin.ts` ~L157) derives the org identity through FIVE
 * distinct sources, tried in order, before this route ever reaches the
 * "which value did the CLIENT repeat" check proven above:
 *
 *   L1 `user.orgId`            (string)
 *   L2 `user.workspaceId`      (string) — only reached when `orgId` is
 *                              strictly null/undefined (`??`, not "falsy")
 *   L3 `user.orgId`            (finite number, coerced via `String(...)`)
 *   L4 `user.workspaceId`      (finite number) — same `??` gate as L2
 *   L5 `req.authenticatedTenantId` (string) — the terminal fallback, only
 *                              reached when neither L1-L4 produced a claim
 *   L6 (terminal) — nothing usable anywhere → `null` → 403
 *
 * Before this describe block, ONLY the `orgId`-string leg (L1) was ever
 * exercised anywhere in this repository — DB-free or DB-backed; grepping
 * both `.db.test.ts` suites for this route turns up zero references to
 * `workspaceId` or `authenticatedTenantId`. So L2-L5 were unverified by
 * anything on a green board, DB-gated or not. Every negative here is proven
 * discriminating by neutering the corresponding production branch and
 * confirming the paired positive-control test below reds (see PR
 * description / commit log for that mutation round).
 */
describe('org-identity derivation: each source (leg) is independently DB-free unit-tested (F1b)', () => {
  const NUMERIC_ORG = 424242
  const WORKSPACE_ORG = '99999999-9999-4999-8999-999999999999'
  const TENANT_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const UNUSED_WORKSPACE_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const PATH = `/api/attendance/groups/${GROUP}/effective-policy`

  /** Like `makeApp`, plus an optional direct `req.authenticatedTenantId` —
   *  the field the real `jwtAuthMiddleware` populates from the JWT's
   *  `tenantId` claim (`auth/jwt-middleware.ts` ~L101). This suite mounts
   *  the router directly (DB-free), so it sets the field the same way it
   *  already sets `req.user`, rather than running the real JWT middleware. */
  function makeAppWithIdentity(user: Record<string, unknown> | undefined, authenticatedTenantId?: string) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: unknown }).user = user
      if (authenticatedTenantId !== undefined) {
        ;(req as express.Request & { authenticatedTenantId?: string }).authenticatedTenantId = authenticatedTenantId
      }
      next()
    })
    app.use(attendanceAdminRouter())
    return app
  }

  describe('positive controls — each source, ALONE, derives a usable org identity and the request reaches 200', () => {
    it('L1: user.orgId (string)', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, orgId: ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('L2: user.workspaceId (string) — no orgId key at all', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, workspaceId: WORKSPACE_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('L3: user.orgId (finite number), coerced to its decimal string form', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, orgId: NUMERIC_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('L4: user.workspaceId (finite number) — no orgId key at all', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, workspaceId: NUMERIC_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('L5: req.authenticatedTenantId — terminal fallback, reached only when neither orgId nor workspaceId is present', async () => {
      installSharedTransaction({ '?column?': 1 })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER }, TENANT_ORG))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      expect(transactionMock).toHaveBeenCalledTimes(1)
    })

    it('precedence: user.orgId wins over user.workspaceId when both are present — proven DIFFERENTIALLY by reading the actual org VALUE the membership SQL received, not merely by which response code came back (a same-shape 200 does not by itself say which org drove it)', async () => {
      // A dedicated capture, not `installSharedTransaction`: that shared
      // helper's `respond()` switches on SQL TEXT only, so it would return
      // the SAME canned membership row regardless of which org VALUE
      // reached `$2` — a 200 alone cannot distinguish "orgId won" from
      // "workspaceId won". This reads the actual parameter.
      const orgParams: unknown[] = []
      transactionMock.mockImplementation(async (handler: (client: Client) => Promise<unknown>) => {
        const client: Client = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            if (sql.toLowerCase().includes('from user_orgs uo')) orgParams.push(params?.[1])
            return respond(sql, { '?column?': 1 }, null)
          }),
        }
        return handler(client)
      })
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, orgId: ORG, workspaceId: UNUSED_WORKSPACE_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.groupId).toBe(GROUP)
      // The discriminator: the membership query's org parameter is `ORG`
      // (from `orgId`), never `UNUSED_WORKSPACE_ORG` (from `workspaceId`).
      expect(orgParams).toEqual([ORG])
    })
  })

  describe('negatives — no usable identity anywhere is refused before any DB call', () => {
    it('L6 (terminal): no orgId, no workspaceId, no authenticatedTenantId anywhere on the request', async () => {
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('documented edge: a present-but-EMPTY user.orgId does NOT fall through to workspaceId — `??` only triggers on null/undefined, not on an empty string — so this falls all the way to authenticatedTenantId (also absent here) and refuses', async () => {
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, orgId: '', workspaceId: WORKSPACE_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('an orgId of an unsupported type (boolean) is not derivable and does not fall through to workspaceId either (same `??` non-nullish reasoning)', async () => {
      pinned.setApp(makeAppWithIdentity({ id: DELEGATED_USER, orgId: true, workspaceId: WORKSPACE_ORG }))
      const res = await request(pinned.url()).get(PATH)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found', details: undefined } })
      expect(transactionMock).not.toHaveBeenCalled()
    })
  })
})

/**
 * Guarantee 4 (see file header): in the REAL application assembly, this
 * route sits behind the global authentication gate and the attendance
 * audit/security middleware. The suites above mount `attendanceAdminRouter()`
 * directly on a bare Express app — necessary to stay DB-free, but it proves
 * only `rbacGuard` and the shared transaction. It cannot see `src/index.ts`,
 * where the real app registers the global gate, then the audit/security
 * middleware, and only after that the attendance routers.
 *
 * WHAT THIS PROVES, stated exactly (over `tests/helpers/attendance-w6-index
 * -assembly-order.ts`'s AST registration-site model, never over raw text —
 * see that module's docblock for the two bugs a prior text-offset version
 * of this guard had):
 *
 *  - `attendanceAuditMiddleware`, `attendanceSecurityMiddleware`, and
 *    `attendanceAdminRouter` are each registered by exactly ONE
 *    unconditional `this.app.use(...)` call, all inside `setupMiddleware`,
 *    and all three occur (in `setupMiddleware`'s own, sequentially-executed
 *    statement order) after the one unconditional `this.app.use(...)` call
 *    whose callback body calls `jwtAuthMiddleware`.
 *  - The GATE subject's claim is WEAKER than the other three, and is only
 *    ever stated that way: the other three are bare `this.app.use(S())`;
 *    the gate is an anonymous arrow (`index.ts:1350`) whose body calls
 *    `jwtAuthMiddleware` (`:1361`) only after three early returns
 *    (`isWhitelisted` `:1351`, `isPublicFormAuthBypass` `:1352`,
 *    `isOapiAllowlistRequest` `:1357`). This guard proves the ARROW is
 *    registered unconditionally, exactly once, ahead of every subject site —
 *    never that any given request reaches `jwtAuthMiddleware`. The "A7"
 *    block below shrinks that gap with FIVE EXECUTED calls to the real
 *    predicates on this route's real path, but the composition (registered
 *    first AND this path routes into the gate) is argued, not executed as
 *    one proof — only booting `MetaSheetServer` would execute it, and that
 *    is out of reach for a unit test (full plugin loader, DB pool).
 *  - Beyond `setupMiddleware`: nothing can call an instance method on
 *    `MetaSheetServer` before its constructor has returned, and the
 *    constructor calls `setupMiddleware()` — unconditionally, as its own
 *    12th (of 15) statement — before doing anything else that could reach
 *    `this.app` (asserted below: zero `this.app.<verb>` sites anywhere in
 *    the constructor). So every OTHER place `this.app` is ever registered
 *    on (`installGlobalErrorHandler`, `start`, and the plugin runtime's
 *    computed `this.app[verb](...)` dispatch reachable through
 *    `createCoreAPI`/`registerPluginRoute`) is necessarily dispatched after
 *    `setupMiddleware` has already run to completion — EXCEPT the twelve
 *    pinned pre-gate sites (they run inside `setupMiddleware`, before the
 *    gate, by design) and whatever `installMetrics(this.app)` (`:1329`,
 *    also pre-gate) itself registers, which this guard cannot see (residual
 *    — it is pinned only as an opaque escape, below).
 *
 * NOT proven, named rather than implied:
 *  - Nothing about `installMetrics`'s or `APIGateway`'s own internals (both
 *    are pinned, opaque escapes — R2).
 *  - Nothing about `attendanceAdminRouter`'s own sub-router internals
 *    (bypassing `rbacGuard` inside it would be invisible here — R3; that is
 *    `attendance-w6-call-path-closure.ts`'s domain).
 *  - Subject membership is name-based (an identifier occurring in a site's
 *    argument subtree), not symbol-resolved — a same-named import re-pointed
 *    at a different module would satisfy every assertion here (R4). The
 *    import-specifier pin below closes the cheap half of that gap.
 *  - No request is ever issued and `MetaSheetServer` is never constructed
 *    (R6) — this proves assembly order, a necessary but not sufficient
 *    condition for the route being protected.
 */
describe('the real app assembly (index.ts) registers this route behind the global gate and the attendance audit/security middleware', () => {
  const indexPath = join(__dirname, '../../src/index.ts')
  const indexText = readFileSync(indexPath, 'utf8')
  const indexSource = ts.createSourceFile(indexPath, indexText, ts.ScriptTarget.ES2022, true)
  const model: AssemblyModel = buildAssemblyModel(indexSource)
  const inSetup = sitesInMethod(model, 'setupMiddleware')

  const SUBJECTS = [
    'jwtAuthMiddleware',
    'attendanceAuditMiddleware',
    'attendanceSecurityMiddleware',
    'attendanceAdminRouter',
  ] as const

  describe('A1 — per-subject state: exactly one unconditional site, in setupMiddleware', () => {
    it.each(SUBJECTS)('%s', (subject) => {
      const { state, sites } = subjectState(model, subject)
      expect(state).toBe('UNCONDITIONAL_SITE')
      expect(sites).toHaveLength(1)
      expect(sites[0].enclosingMethod).toBe('setupMiddleware')
    })

    it('non-vacuity diagnostic: each subject also appears in the raw file text (guards against a subject name typo silently reading NO_SITE forever)', () => {
      for (const subject of SUBJECTS) {
        expect(textMentions(indexText, subject)).toBeGreaterThan(0)
      }
    })
  })

  it('A2 — the set of methods holding ANY this.app.<verb> registration site is exactly this frozen set', () => {
    const byMethod = new Set(model.sites.map((s) => s.enclosingMethod))
    expect([...byMethod].sort()).toEqual(['installGlobalErrorHandler', 'setupMiddleware', 'start'])
  })

  it('A3 — ordering: the gate, audit, and security sites all precede the route site, in setupMiddleware\'s own sequential order', () => {
    const ordinalOf = (subject: string) => {
      const site = subjectState(model, subject).sites[0]
      return inSetup.findIndex((s) => s.start === site.start)
    }
    const gate = ordinalOf('jwtAuthMiddleware')
    const audit = ordinalOf('attendanceAuditMiddleware')
    const security = ordinalOf('attendanceSecurityMiddleware')
    const route = ordinalOf('attendanceAdminRouter')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(route).toBeGreaterThan(gate)
    expect(route).toBeGreaterThan(audit)
    expect(route).toBeGreaterThan(security)
  })

  // A4/A5 deliberately do NOT pin `line`: a benign one-line edit anywhere
  // ABOVE one of these sites (a comment, a blank line, an unrelated
  // registration lower in the file) would shift every subsequent line
  // number and spuriously red a pin that has not actually changed in
  // content or order. Position is already fully captured by ARRAY ORDER
  // (these are the source-ordered `sites`/`escapes` lists) — pinning the
  // numeric line on top of that buys no extra sensitivity to a real
  // change and only buys fragility to an unrelated one. (Caught live: an
  // early mutation of this guard pinned `line` here, and inserting an
  // unrelated pre-gate site shifted eleven OTHER lines' numbers along with
  // it, reding five assertions for what should have been one.)
  it('A4 — app-object census: every OTHER read of this.app (assignment, computed dispatch, or escape) is exactly this frozen 6-entry list', () => {
    expect(model.escapes.map((e) => ({ kind: e.kind, enclosingMethod: e.enclosingMethod, signature: e.signature }))).toEqual([
      { kind: 'ASSIGN', enclosingMethod: 'constructor', signature: '= express()' },
      { kind: 'ESCAPE', enclosingMethod: 'constructor', signature: 'createServer(...) arg0' },
      { kind: 'COMPUTED_REGISTRATION', enclosingMethod: 'createCoreAPI', signature: '[methodLower](...)' },
      { kind: 'COMPUTED_REGISTRATION', enclosingMethod: 'registerPluginRoute', signature: "[methodLower as 'get' | 'post' | 'put' | 'delete' | 'patch'](...)" },
      { kind: 'ESCAPE', enclosingMethod: 'setupMiddleware', signature: 'installMetrics(...) arg0' },
      { kind: 'ESCAPE', enclosingMethod: 'start', signature: 'new APIGateway(...) arg0' },
    ])
  })

  it('A5 — pre-gate prefix: the 12 sites that run before the gate, inside setupMiddleware, are exactly this frozen list (the pre-authentication surface)', () => {
    const gateOrdinal = inSetup.findIndex((s) => s.start === subjectState(model, 'jwtAuthMiddleware').sites[0].start)
    const prefix = inSetup.slice(0, gateOrdinal).map((s) => ({ verb: s.verb, unconditional: s.unconditional, args: s.argProjection }))
    expect(prefix).toEqual([
      { verb: 'use', unconditional: true, args: ['correlationIdMiddleware'] },
      { verb: 'use', unconditional: true, args: ['cors()'] },
      { verb: 'use', unconditional: true, args: ['"/api"', '<inline>'] },
      { verb: 'use', unconditional: true, args: ['<inline>'] },
      { verb: 'use', unconditional: true, args: ['"/api/attendance/import"', '<inline>'] },
      { verb: 'use', unconditional: true, args: ['"/api/attendance/import"', 'express.json()'] },
      { verb: 'use', unconditional: true, args: ['"/api/multitable/automation/webhooks"', 'automationWebhookJsonParser'] },
      { verb: 'post', unconditional: false, args: ['"/api/approval/attachments/refs"', 'approvalAttachmentRefsJsonParser'] },
      { verb: 'use', unconditional: true, args: ['express.json()'] },
      { verb: 'use', unconditional: true, args: ['express.urlencoded()'] },
      { verb: 'use', unconditional: true, args: ['requestMetricsMiddleware'] },
      { verb: 'use', unconditional: true, args: ['<inline>'] },
    ])
  })

  it('positive control (real code, no mutation): the approval-attachments pre-gate parser is the live CONDITIONAL witness — its own IfStatement guard is isApprovalAttachmentsEnabled(), proving the CONDITIONAL_SITE branch of the classifier actually discriminates on production source, not merely on a synthetic fixture', () => {
    const site = inSetup.find((s) => s.argProjection.includes('approvalAttachmentRefsJsonParser'))
    expect(site).toBeDefined()
    expect(site!.unconditional).toBe(false)
    expect(site!.blockingAncestorKind).toBe('IfStatement')
  })

  describe('the constructor: setupMiddleware() itself is invoked once, unconditionally, before anything else touches this.app', () => {
    it('setupMiddleware() has exactly one call site: an unconditional statement of the constructor', () => {
      const calls = findThisMethodCalls(indexSource, 'setupMiddleware')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ enclosingMethod: 'constructor', unconditional: true })
    })

    it('zero this.app.<verb> registration sites exist anywhere in the constructor', () => {
      expect(sitesInMethod(model, 'constructor')).toEqual([])
    })
  })

  it('import-specifier pin: each subject is imported from the module this guard assumes, so a same-named identifier re-pointed at a different module is caught here rather than silently satisfying A1 (R4 mitigation)', () => {
    expect(indexText).toContain("import { jwtAuthMiddleware, optionalJwtAuthMiddleware, isPublicFormAuthBypass, isWhitelisted } from './auth/jwt-middleware'")
    expect(indexText).toContain("import { attendanceAuditMiddleware, attendanceSecurityMiddleware } from './middleware/attendance-production'")
    expect(indexText).toContain("import { attendanceAdminRouter } from './routes/attendance-admin'")
  })

  describe('A7 — the gate subject, behavioural shrink: which real predicate decides this exact route (real functions, real path, no fabricated request)', () => {
    const PATH = `/api/attendance/groups/${GROUP}/effective-policy`

    it('isApiPath: this path is API traffic (so the gate\'s final `if` branch is reachable at all)', () => {
      expect(isApiPath(PATH)).toBe(true)
    })

    it('isWhitelisted: this path is NOT a declared gate exception (so the gate does not return early before reaching jwtAuthMiddleware)', () => {
      expect(isWhitelisted(PATH)).toBe(false)
    })

    it('isPublicFormAuthBypass: a GET with no publicToken on this path is not the public-form bypass', () => {
      expect(isPublicFormAuthBypass({ path: PATH, method: 'GET', query: {}, body: undefined })).toBe(false)
    })

    it('isOapiAllowlistRequest: this path is not on the OAPI read/write allowlist (mst_ token or not), so an API-token bearer does not skip the gate here either', () => {
      expect(isOapiAllowlistRequest('GET', PATH, undefined)).toBe(false)
      expect(isOapiAllowlistRequest('GET', PATH, 'Bearer mst_x')).toBe(false)
    })
  })

  /**
   * The classifier's own positive control (replaces the house precedent's
   * "verified non-vacuous manually during PR development" docblock claim,
   * which has no CI standing): drives `buildAssemblyModel` over small inline
   * source STRINGS — never `index.ts` — and asserts the state each fixture
   * must produce. This is what "prove it closes the fail-open evasions" was
   * verified against live, mutating `index.ts` itself (see PR description /
   * commit log for that one-time proof); these fixtures make the same
   * shapes a permanent regression, independent of `index.ts`'s own drift.
   */
  describe('classifier state-space coverage (inline fixtures, not index.ts)', () => {
    const wrap = (body: string) => `class C {\n  m() {\n${body}\n  }\n}\n`
    const stateOf = (src: string, subject = 'S') => {
      const f = ts.createSourceFile('fixture.ts', wrap(src), ts.ScriptTarget.ES2022, true)
      return subjectState(buildAssemblyModel(f), subject).state
    }

    it('NO_SITE: absent entirely', () => {
      expect(stateOf('    this.app.use(other())')).toBe('NO_SITE')
    })

    it('NO_SITE: present only inside a comment (the bug this guard replaces)', () => {
      expect(stateOf('    // this.app.use(S())')).toBe('NO_SITE')
    })

    it('UNCONDITIONAL_SITE: bare statement', () => {
      expect(stateOf('    this.app.use(S())')).toBe('UNCONDITIONAL_SITE')
    })

    it('UNCONDITIONAL_SITE: path-prefixed mount still names S in its arguments', () => {
      expect(stateOf("    this.app.use('/x', S())")).toBe('UNCONDITIONAL_SITE')
    })

    it('UNCONDITIONAL_SITE: wrapped mount still names S in its arguments', () => {
      expect(stateOf("    this.app.use('/x', wrap(S()))")).toBe('UNCONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: if (false)', () => {
      expect(stateOf('    if (false) { this.app.use(S()) }')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: never-true env condition', () => {
      expect(stateOf("    if (process.env.NEVER_SET === '1') { this.app.use(S()) }")).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: short-circuit && — the exact shape a "nearest enclosing statement" predicate gets wrong', () => {
      expect(stateOf('    cond && this.app.use(S())')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: short-circuit ||', () => {
      expect(stateOf('    cond || this.app.use(S())')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: nullish ??', () => {
      expect(stateOf('    cond ?? this.app.use(S())')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: ternary', () => {
      expect(stateOf('    cond ? this.app.use(S()) : null')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: deferred inside a callback (setImmediate)', () => {
      expect(stateOf('    setImmediate(() => { this.app.use(S()) })')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: inside a try block', () => {
      expect(stateOf('    try { this.app.use(S()) } catch (e) {}')).toBe('CONDITIONAL_SITE')
    })

    it('CONDITIONAL_SITE: inside a loop', () => {
      expect(stateOf('    for (const x of xs) { this.app.use(S()) }')).toBe('CONDITIONAL_SITE')
    })

    it('MULTIPLE_SITES: a second, earlier, differently-shaped mount — the existential-vs-universal bug this guard replaces', () => {
      expect(stateOf("    this.app.use('/', S())\n    this.app.use(S())")).toBe('MULTIPLE_SITES')
    })

    it('MULTIPLE_SITES: aliased mount via a local const still names S at its OWN declaration site, so two sites both reach it once the alias is itself used a second time', () => {
      // Documents the module's own residual (R5 in the design notes): a
      // hoisted local (`const r = S(); this.app.use(r)`) does NOT reach S
      // by this module's name-based argument search — `r` is what appears
      // in the second call's arguments, not `S`. That specific evasion is
      // NOT caught by subjectState; it would only be caught by a change to
      // the pre-gate/full-site census (A4/A5 above) if it altered site
      // shape or count. Recorded here as a fixture proving what the state
      // machine does NOT claim, not as something it defends against.
      expect(stateOf('    const r = S()\n    this.app.use(r)')).toBe('NO_SITE')
    })
  })

  /**
   * The ESCAPE collector's own permanent regression coverage (P2 follow-up
   * to the gate on this PR): a prior independent review found the module
   * docblock's completeness claim ("every OTHER read of `this.app` ... is
   * separately collected") FALSE by construction for two shapes that
   * produced neither a site nor an escape — invisible to A4 entirely, not
   * merely mis-classified. `buildAssemblyModel` is now extended to close
   * both (see the module docblock's own updated claim and residual list).
   * These fixtures pin the closed shapes as a permanent regression,
   * independent of whether any such shape ever appears in `index.ts` itself
   * — the live A4 mutation proof for this exact round is recorded in the PR
   * description / commit log, not here; a snapshot pin against `index.ts`
   * alone stops testing an evasion shape the day no such shape exists in
   * production source.
   */
  describe('escape-collector state-space coverage (inline fixtures, not index.ts)', () => {
    const wrap = (body: string) => `class C {\n  m() {\n${body}\n  }\n}\n`
    const escapesOf = (src: string) => {
      const f = ts.createSourceFile('fixture.ts', wrap(src), ts.ScriptTarget.ES2022, true)
      return buildAssemblyModel(f).escapes.map((e) => ({ kind: e.kind, signature: e.signature }))
    }

    it('bare alias initializer: const a = this.app — was the exact shape the gate named as invisible; already caught pre-fix (regression pin)', () => {
      expect(escapesOf("    const a = this.app\n    a.use('/', S())")).toEqual([
        { kind: 'ESCAPE', signature: '<VariableDeclaration>' },
      ])
    })

    it("this['app'] read via string-literal bracket notation — the SAME property, was totally invisible (zero sites, zero escapes) before this fix", () => {
      expect(escapesOf("    const a = this['app']\n    a.use('/', S())")).toEqual([
        { kind: 'ESCAPE', signature: '<VariableDeclaration>' },
      ])
    })

    it("this['app'].use(...) dispatched directly through bracket notation, no intermediate alias — also was totally invisible before this fix", () => {
      expect(escapesOf("    this['app'].use('/', S())")).toEqual([
        { kind: 'ESCAPE', signature: '<PropertyAccessExpression>' },
      ])
    })

    it('destructuring by name: const { app } = this', () => {
      expect(escapesOf('    const { app } = this\n    app.use(S())')).toEqual([
        { kind: 'ESCAPE', signature: '{ app } = this' },
      ])
    })

    it('destructuring by rename: const { app: a } = this', () => {
      expect(escapesOf('    const { app: a } = this\n    a.use(S())')).toEqual([
        { kind: 'ESCAPE', signature: '{ app: a } = this' },
      ])
    })

    it('destructuring via a rest element: const { ...rest } = this — rest captures every own property NOT otherwise named in the pattern, app included', () => {
      expect(escapesOf('    const { ...rest } = this\n    rest.app.use(S())')).toEqual([
        { kind: 'ESCAPE', signature: '{ ...rest } = this' },
      ])
    })

    it('NEGATIVE — discriminator: a literal bracket index naming a DIFFERENT property produces ZERO entries, proving the predicate matches the string "app", not every bracket access on `this`', () => {
      expect(escapesOf("    const a = this['foo']\n    a.use('/', S())")).toEqual([])
    })

    it('a non-literal bracket index on `this` is not collected by the ESCAPE layer — round 4 reclassifies it as UNKNOWN (see the four-bucket partition block), so it is no longer a silent residual', () => {
      // The model's escape collector is deliberately this.app-only; the fail-closed
      // layer is buildThisPartition's UNKNOWN bucket, proved below.
      expect(escapesOf('    const a = this[key]\n    a.use(S())')).toEqual([])
    })

    it('NEGATIVE — discriminator: destructuring an unrelated property off `this` produces ZERO entries', () => {
      expect(escapesOf('    const { foo } = this\n    foo.use(S())')).toEqual([])
    })

    it('POSITIVE CONTROL: ordinary this.app.use(...) still produces zero escapes (the site collector, not the escape collector, is what should see it)', () => {
      expect(escapesOf("    this.app.use('/', S())")).toEqual([])
    })
  })

  /**
   * Receiver-wrapper normalization (P2, third round): an INDEPENDENT gate
   * found that `isThisAppPropertyAccess`/`isThisAppElementAccess` gated the
   * receiver on `node.expression.kind === ts.SyntaxKind.ThisKeyword`
   * DIRECTLY, no unwrap — so a `this` receiver wrapped in a single no-op
   * node evaded BOTH collectors entirely: `this!.app.use(...)`,
   * `(this).app.use(...)`, `(this as any).app.use(...)`, and
   * `this!['app'].use(...)` were each `{sites: 0, escapes: 0}` — invisible
   * to A4 (escape census) AND A5 (pre-gate prefix) alike, live-verified
   * against real `index.ts` (see PR description / commit log for that
   * round's mutation proof: a `(this as any).app.use(...)` pre-gate insert,
   * properly ASI-guarded with a leading `;` so it does not merge into the
   * PRECEDING statement — this codebase's own no-semicolon style makes that
   * leading `;` load-bearing, not decorative, for any inserted statement
   * that starts with `(`).
   *
   * `unwrapNoOpWrappers` closes this: a CLOSED, finite set of wrapper kinds
   * (`ParenthesizedExpression`, `NonNullExpression`, `AsExpression`,
   * `TypeAssertionExpression`, `SatisfiesExpression`) is stripped from the
   * RECEIVER before the `ThisKeyword` check, to a fixed point so composed
   * wrappers unwrap fully. Applied in three places sharing one predicate
   * (`hasUnwrappedThisReceiver`): `isThisAppPropertyAccess`,
   * `isThisAppElementAccess`, and the destructure initializer check in
   * `collectThisDestructuringEscapes` — plus `findThisMethodCalls`, which
   * had the IDENTICAL unwrapped check for `this.<methodName>()` and would
   * otherwise let a wrapped ADDITIONAL `this!.setupMiddleware()` stay
   * invisible while "exactly one call site" kept asserting true.
   *
   * What promotes to a SITE vs. stays ESCAPE-only is unchanged by this fix:
   * wrapping the RECEIVER (the `this` inside a `.app` read) is a site, same
   * as bare `this.app`; wrapping the WHOLE `this.app` VALUE, AFTER the
   * property read (`(this.app).use(...)`, `this.app!.use(...)`), is a
   * structurally different position — `callee.expression` there is the
   * wrapper node itself, not a `this.app` `PropertyAccessExpression` — and
   * stays escape-only, exactly as an unwrapped bare-alias read
   * (`const a = this.app`) already did. That split is asserted explicitly
   * below, not merely left untested.
   */
  describe('receiver-wrapper normalization: this!, (this), this as X, <X>this, this satisfies X (P2, inline fixtures, not index.ts)', () => {
    const wrap = (body: string) => `class C {\n  m() {\n${body}\n  }\n}\n`
    const modelOf = (src: string) => {
      const f = ts.createSourceFile('fixture.ts', wrap(src), ts.ScriptTarget.ES2022, true)
      return buildAssemblyModel(f)
    }
    const stateOf = (src: string, subject = 'S') => subjectState(modelOf(src), subject).state
    const escapesOf = (src: string) => modelOf(src).escapes.map((e) => ({ kind: e.kind, signature: e.signature }))

    describe('SITE: each wrapper form, alone, is UNCONDITIONAL_SITE — same as bare this.app', () => {
      it.each([
        ['this!.app.use(S())', 'NonNullExpression'],
        ['(this).app.use(S())', 'ParenthesizedExpression'],
        ['(this as any).app.use(S())', 'AsExpression'],
        ['(this as SomeServer).app.use(S())', 'AsExpression (non-any type)'],
        ['(<any>this).app.use(S())', 'TypeAssertionExpression'],
        ['(this satisfies SomeServer).app.use(S())', 'SatisfiesExpression'],
      ] as const)('%s (%s)', (src, _kind) => {
        expect(stateOf(`    ${src}`)).toBe('UNCONDITIONAL_SITE')
      })

      it('composed wrappers unwrap to a fixed point: ((this as any)!).app.use(S())', () => {
        expect(stateOf('    ((this as any)!).app.use(S())')).toBe('UNCONDITIONAL_SITE')
      })
    })

    describe('ESCAPE: string-literal bracket notation through a wrapped receiver — same signatures as the unwrapped form (F1b precedent)', () => {
      it("this!['app'] via an alias initializer", () => {
        expect(escapesOf("    const a = this!['app']\n    a.use('/', S())")).toEqual([
          { kind: 'ESCAPE', signature: '<VariableDeclaration>' },
        ])
      })

      it("this!['app'].use(...) dispatched directly, no intermediate alias", () => {
        expect(escapesOf("    this!['app'].use('/', S())")).toEqual([
          { kind: 'ESCAPE', signature: '<PropertyAccessExpression>' },
        ])
      })

      it("(this as any)['app'] via an alias initializer", () => {
        expect(escapesOf("    const a = (this as any)['app']\n    a.use('/', S())")).toEqual([
          { kind: 'ESCAPE', signature: '<VariableDeclaration>' },
        ])
      })
    })

    describe('ESCAPE: destructuring a wrapped `this` — same signatures as the unwrapped form (the wrapper does not appear in the signature, only the binding shape does)', () => {
      it('const { app } = this!', () => {
        expect(escapesOf('    const { app } = this!\n    app.use(S())')).toEqual([
          { kind: 'ESCAPE', signature: '{ app } = this' },
        ])
      })

      it('const { app } = (this as any)', () => {
        expect(escapesOf('    const { app } = (this as any)\n    app.use(S())')).toEqual([
          { kind: 'ESCAPE', signature: '{ app } = this' },
        ])
      })

      it('const { app: a } = this! (rename form)', () => {
        expect(escapesOf('    const { app: a } = this!\n    a.use(S())')).toEqual([
          { kind: 'ESCAPE', signature: '{ app: a } = this' },
        ])
      })
    })

    it('ESCAPE: alias of a wrapped this.app — const a = (this as any).app; a.use(...) — the exact P2 shape named as invisible before this fix', () => {
      expect(escapesOf("    const a = (this as any).app\n    a.use('/', S())")).toEqual([
        { kind: 'ESCAPE', signature: '<VariableDeclaration>' },
      ])
    })

    describe('NEGATIVE — discriminator: a wrapped receiver reading a DIFFERENT property is collected as NEITHER a site NOR an escape', () => {
      it('(this as any).foo.use(S()) — property-access form', () => {
        const m = modelOf("    (this as any).foo.use('/', S())")
        expect(m.sites).toEqual([])
        expect(m.escapes).toEqual([])
      })

      it("this!['foo'].use(S()) — bracket-notation form", () => {
        const m = modelOf("    this!['foo'].use('/', S())")
        expect(m.sites).toEqual([])
        expect(m.escapes).toEqual([])
      })

      it('const a = this!.foo — destructure-adjacent alias form', () => {
        const m = modelOf("    const a = this!.foo\n    a.use('/', S())")
        expect(m.sites).toEqual([])
        expect(m.escapes).toEqual([])
      })
    })

    describe('documented split: wrapping the WHOLE this.app VALUE (after the property read) is a different position — stays ESCAPE-only, never promoted to a site', () => {
      it('(this.app).use(S()) — the wrapper is around the property-access result, not the this receiver', () => {
        expect(escapesOf("    (this.app).use('/', S())")).toEqual([
          { kind: 'ESCAPE', signature: '<ParenthesizedExpression>' },
        ])
      })

      it('this.app!.use(S()) — non-null on the whole this.app value', () => {
        expect(escapesOf("    this.app!.use('/', S())")).toEqual([
          { kind: 'ESCAPE', signature: '<NonNullExpression>' },
        ])
      })
    })

    describe('findThisMethodCalls: the SAME wrapper-blindness bug, same fix, over this.<methodName>() rather than this.app', () => {
      const methodCallsOf = (src: string, methodName: string) => {
        const f = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.ES2022, true)
        return findThisMethodCalls(f, methodName)
      }

      it('this!.setupMiddleware() is found, unconditional, in its enclosing named method', () => {
        const src = 'class C {\n  constructor() {\n    this!.setupMiddleware()\n  }\n}\n'
        const calls = methodCallsOf(src, 'setupMiddleware')
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ enclosingMethod: 'constructor', unconditional: true })
      })

      it('(this as any).setupMiddleware() is found too', () => {
        const src = 'class C {\n  constructor() {\n    ;(this as any).setupMiddleware()\n  }\n}\n'
        const calls = methodCallsOf(src, 'setupMiddleware')
        expect(calls).toHaveLength(1)
      })

      it('NEGATIVE — a wrapped receiver calling a DIFFERENT method name is not collected', () => {
        const src = 'class C {\n  constructor() {\n    this!.otherMethod()\n  }\n}\n'
        expect(methodCallsOf(src, 'setupMiddleware')).toEqual([])
      })

      it('regression: an ADDITIONAL wrapped call site is counted, not silently missed — "exactly one call site" would wrongly stay true without this fix', () => {
        const src = 'class C {\n  constructor() {\n    this.setupMiddleware()\n    this!.setupMiddleware()\n  }\n}\n'
        expect(methodCallsOf(src, 'setupMiddleware')).toHaveLength(2)
      })
    })
  })

/**
 * Round 4 — the FOUR-BUCKET partition, fail-closed by an UNKNOWN census.
 *
 * Rounds 1-3 enumerated wrapper/alias shapes and never converged; the owner
 * ruled the convergent design is a COMPLEMENT: partition every `this` in the
 * assembly scope (setupMiddleware + constructor) into {SITE, ESCAPE, SAFE,
 * UNKNOWN} and assert UNKNOWN empty, so a shape nobody enumerated lands in
 * UNKNOWN by default and reds. SAFE is a FROZEN OCCURRENCE census (count + a
 * sha256 over the sorted keys). Each key is enclosing-symbol + ANCESTOR-KIND
 * path (no child ordinals, no line/column) + shape + a per-base-key occurrence
 * ordinal — so a duplicate / re-context of a safe access mints a new key and
 * reds, while an unrelated insertion (even in the SAME method) moves nothing
 * (P2-b). T itself is EVERY `this` textually in scope: a `this` whose binding is
 * rebound by a non-arrow function on the path to the method is forced UNKNOWN,
 * not dropped (P2-a).
 *
 * A count identity |T| = |SITE|+|ESCAPE|+|SAFE|+|UNKNOWN| ALONE is insufficient
 * (miss-one + double-another keeps the count equal), so the partition is proven
 * at SET level: coverage against an INDEPENDENT un-pruned ThisKeyword walk (not
 * the builder's own `part.all` — P2-c) AND multiplicity-1 (each node once).
 */
describe('round 4 — four-bucket this-partition, UNKNOWN census fail-closed', () => {
  const SCOPE = new Set(['setupMiddleware', 'constructor'])
  const FROZEN_SAFE_COUNT = 46
  const FROZEN_SAFE_HASH = '4d74175f6d2a3d8ff0147be6d441c68274a130f9db82a01c7f0c78cb396e907b'
  // Frozen census as a LITERAL (owner + gate P2): deriving it live from the
  // same source it partitions makes UNKNOWN-empty vacuous (a novel this-use is
  // auto-added to SAFE). With the literal, a novel this-use lands in UNKNOWN.
  const FROZEN_SAFE_KEYS = new Set<string>([
      "constructor//Block>ExpressionStatement>BinaryExpression>NewExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>Block>ExpressionStatement>AwaitExpression>CallExpression>PropertyAccessExpression//.handleAfterSalesApprovalDecisionCallback//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>NewExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>Block>ExpressionStatement>AwaitExpression>CallExpression>PropertyAccessExpression//.handleAfterSalesApprovalDecisionCallback//#1",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.afterSalesApprovalBridgeService//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.eventBus//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.host//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.httpServer//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.injector//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.logger//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.port//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.portLocked//#0",
      "constructor//Block>ExpressionStatement>BinaryExpression>PropertyAccessExpression//.snapshotService//#0",
      "constructor//Block>ExpressionStatement>CallExpression>PropertyAccessExpression//.initializeCache//#0",
      "constructor//Block>ExpressionStatement>CallExpression>PropertyAccessExpression//.registerInternalPluginApis//#0",
      "constructor//Block>ExpressionStatement>CallExpression>PropertyAccessExpression//.setupMiddleware//#0",
      "constructor//Block>ExpressionStatement>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.injector//#0",
      "constructor//Block>FirstStatement>VariableDeclarationList>VariableDeclaration>CallExpression>PropertyAccessExpression//.createCoreAPI//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>ArrowFunction>Block>ExpressionStatement>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.logger//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>ArrowFunction>Block>TryStatement>Block>FirstStatement>VariableDeclarationList>VariableDeclaration>BinaryExpression>CallExpression>PropertyAccessExpression>ParenthesizedExpression>AsExpression>AsExpression>PropertyAccessExpression//.pluginLoader//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>ArrowFunction>Block>TryStatement>Block>FirstStatement>VariableDeclarationList>VariableDeclaration>CallExpression>ArrowFunction>Block>FirstStatement>VariableDeclarationList>VariableDeclaration>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.pluginStatus//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>ArrowFunction>Block>TryStatement>Block>FirstStatement>VariableDeclarationList>VariableDeclaration>CallExpression>PropertyAccessExpression>CallExpression>CallExpression>PropertyAccessExpression>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.pluginLoader//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ArrowFunction>PropertyAccessExpression//.automationService//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>BinaryExpression>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.yjsBridgeMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>BinaryExpression>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.yjsSocketMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>BinaryExpression>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.yjsSyncMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>PrefixUnaryExpression>PrefixUnaryExpression>ParenthesizedExpression>BinaryExpression>BinaryExpression>PropertyAccessExpression//.yjsBridgeMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>PrefixUnaryExpression>PrefixUnaryExpression>ParenthesizedExpression>BinaryExpression>BinaryExpression>PropertyAccessExpression//.yjsSyncMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>ArrowFunction>ParenthesizedExpression>ObjectLiteralExpression>PropertyAssignment>PrefixUnaryExpression>PrefixUnaryExpression>ParenthesizedExpression>BinaryExpression>PropertyAccessExpression//.yjsSocketMetricsSource//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>CallExpression//bare//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>CallExpression//bare//#1",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.activatePluginByName//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.deactivatePluginByName//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.afterSalesApprovalBridgeService//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.injector//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.injector//#1",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.pluginLoader//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.pluginLoader//#1",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.pluginStatus//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.pluginStatus//#1",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression//.snapshotService//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>PropertyAccessExpression//.injector//#0",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>PropertyAccessExpression//.injector//#1",
      "setupMiddleware//Block>ExpressionStatement>CallExpression>CallExpression>PropertyAccessExpression//.injector//#2",
      "setupMiddleware//Block>FirstStatement>VariableDeclarationList>VariableDeclaration>ArrowFunction>Block>TryStatement>Block>ExpressionStatement>CallExpression>ObjectLiteralExpression>PropertyAssignment>PropertyAccessExpression>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.pluginLoader//#0",
      "setupMiddleware//Block>FirstStatement>VariableDeclarationList>VariableDeclaration>ArrowFunction>Block>TryStatement>Block>TryStatement>Block>ExpressionStatement>BinaryExpression>CallExpression>PropertyAccessExpression>ParenthesizedExpression>AsExpression>AsExpression>PropertyAccessExpression//.pluginLoader//#0",
      "setupMiddleware//Block>IfStatement>Block>IfStatement>Block>ExpressionStatement>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.logger//#0",
      "setupMiddleware//Block>IfStatement>Block>IfStatement>Block>ExpressionStatement>CallExpression>PropertyAccessExpression>PropertyAccessExpression//.logger//#1",
    ])


  // assert coverage + multiplicity-1 + disjointness, returning the safe-census
  // hash. When `expectedStarts` is given (from an INDEPENDENT un-pruned walker,
  // NOT from this same partition), also assert the partition's node set equals
  // it member-by-member — so a pruning bug in the builder cannot hide behind a
  // self-consistent-but-incomplete `part.all` (P2-c).
  const assertValidPartition = (part: ThisPartition, expectedStarts?: readonly number[]): string => {
    const starts = part.all.map((o) => o.start)
    // multiplicity-1: no ThisKeyword appears in two buckets / twice
    expect(new Set(starts).size).toBe(part.all.length)
    // coverage as identity sets: buckets partition `all`
    expect(part.site.length + part.escape.length + part.safe.length + part.unknown.length).toBe(part.all.length)
    const union = [...part.site, ...part.escape, ...part.safe, ...part.unknown].map((o) => o.start).sort((a, b) => a - b)
    expect(union).toEqual([...starts].sort((a, b) => a - b))
    if (expectedStarts) {
      // reference-independent completeness: T from the un-pruned walker
      expect([...starts].sort((a, b) => a - b)).toEqual([...expectedStarts].sort((a, b) => a - b))
    }
    return createHash('sha256').update(part.safe.map((o) => o.key).sort().join('\n')).digest('hex')
  }

  describe('real src/index.ts', () => {
    const indexPath = join(__dirname, '..', '..', 'src', 'index.ts')
    const indexText = readFileSync(indexPath, 'utf8')
    const source = ts.createSourceFile(indexPath, indexText, ts.ScriptTarget.ES2022, true)
    const part = buildThisPartition(source, FROZEN_SAFE_KEYS, SCOPE)
    // sanity: the frozen literal is exactly what a one-shot derivation yields today
    expect(new Set(deriveSafeCensus(source, SCOPE))).toEqual(FROZEN_SAFE_KEYS)

    it('UNKNOWN is EMPTY — every this-use in the assembly scope is provably classified', () => {
      expect(part.unknown).toEqual([])
    })

    it('the partition is valid at SET level (coverage + multiplicity-1 + disjoint) AND covers the INDEPENDENT walk (not merely a self-proof)', () => {
      // expectedStarts comes from a separate un-pruned ThisKeyword walk (P2-c):
      // if buildThisPartition pruned any node, part.all would be missing it and
      // this comparison — unlike the old buckets-vs-part.all self-proof — reds.
      assertValidPartition(part, independentThisStarts(source, SCOPE))
    })

    it('every SAFE occurrence is a member of the FROZEN literal census (occurrence-level, count 46, sha256 pin) — a novel this-use is NOT auto-admitted', () => {
      expect(part.safe.length).toBe(FROZEN_SAFE_COUNT)
      for (const o of part.safe) expect(FROZEN_SAFE_KEYS.has(o.key)).toBe(true)
      const hash = createHash('sha256').update(part.safe.map((o) => o.key).sort().join('\n')).digest('hex')
      expect(hash).toBe(FROZEN_SAFE_HASH)
    })

    it('UNKNOWN-empty is LOAD-BEARING against the literal census: a novel app-reaching this-use reds UNKNOWN itself, not only the count/hash pin', () => {
      // inject a bare-this app read that is NOT in the frozen literal
      const marker = 'private setupMiddleware(): void {'
      expect(indexText).toContain(marker) // guard against a silent no-op mutation
      const mutated = indexText.replace(
        marker,
        marker + "\n    Reflect.get(this, 'app').use('/__round4_probe__', () => {})",
      )
      const msrc = ts.createSourceFile('mut.ts', mutated, ts.ScriptTarget.ES2022, true)
      const mpart = buildThisPartition(msrc, FROZEN_SAFE_KEYS, SCOPE)
      // the novel bare-this app read (and the keys it shifts) are NOT in the frozen
      // literal -> UNKNOWN reds ON ITS OWN, not only the count/hash sibling pin.
      expect(mpart.unknown.length).toBeGreaterThan(0)
      expect(mpart.unknown.some((o) => o.shape === 'bare')).toBe(true)
    })

    it('P2-a LOAD-BEARING: a `this` inside an ordinary nested function ENTERS T (not pruned) and reds UNKNOWN — the reference set is not narrowed', () => {
      // Owner counterexample: pre-fix `inScope` EXCLUDED this `this` from T, so
      // rawThis=1 / partitionTotal=0 / UNKNOWN=0 (incomplete-but-self-consistent).
      // Post-fix: it is in T (a descendant of setupMiddleware), its `this` is
      // rebound by the ordinary function -> UNKNOWN. Reds on pre-fix code.
      const marker = 'private setupMiddleware(): void {'
      expect(indexText).toContain(marker)
      const mutated = indexText.replace(
        marker,
        marker + "\n    function __p2aNested() { return this.app.use('/__p2a__', () => {}) }",
      )
      const msrc = ts.createSourceFile('mut.ts', mutated, ts.ScriptTarget.ES2022, true)
      const mIndep = independentThisStarts(msrc, SCOPE)
      const mpart = buildThisPartition(msrc, FROZEN_SAFE_KEYS, SCOPE)
      // the injected `this` is in the INDEPENDENT walk (T grew by exactly one)
      expect(mIndep.length).toBe(independentThisStarts(source, SCOPE).length + 1)
      // and the partition COVERS T (pre-fix, total stayed 124 -> this reds)
      expect(mpart.total).toBe(mIndep.length)
      // and it is bucketed UNKNOWN as a rebound `this` (never SITE/SAFE)
      expect(mpart.unknown.some((o) => o.shape === 'rebound-this')).toBe(true)
    })

    it('P2-b LOAD-BEARING NEGATIVE: an unrelated `const` inserted in the SAME setupMiddleware moves NO key — SAFE census is byte-identical, no false-red', () => {
      // Pre-fix the child-index key shifted (`//1.0`->`//1.1`) so downstream SAFE
      // accesses fell out of the frozen literal -> SAFE<46 / UNKNOWN>0 false-red.
      // Post-fix the kind-path key is ordinal-free, so nothing moves.
      const marker = 'private setupMiddleware(): void {'
      expect(indexText).toContain(marker)
      const mutated = indexText.replace(marker, marker + '\n    const __p2bUnrelated = 1; void __p2bUnrelated;')
      const msrc = ts.createSourceFile('mut.ts', mutated, ts.ScriptTarget.ES2022, true)
      // the safe-eligible census is unchanged (same 46 keys)
      expect(new Set(deriveSafeCensus(msrc, SCOPE))).toEqual(FROZEN_SAFE_KEYS)
      const mpart = buildThisPartition(msrc, FROZEN_SAFE_KEYS, SCOPE)
      expect(mpart.safe.length).toBe(FROZEN_SAFE_COUNT)
      expect(mpart.unknown).toEqual([])
    })
  })

  // fixtures: wrap a body in setupMiddleware so enclosingNamedFunction resolves to it.
  const wrapSetup = (body: string): string => `class C {\n  setupMiddleware() {\n${body}\n  }\n}\n`
  const partitionOf = (body: string, frozen: ReadonlySet<string> = new Set<string>()): ThisPartition => {
    const f = ts.createSourceFile('fixture.ts', wrapSetup(body), ts.ScriptTarget.ES2022, true)
    return buildThisPartition(f, frozen, SCOPE)
  }
  const bucketsByShape = (body: string): Record<string, string> => {
    const p = partitionOf(body)
    const m: Record<string, string> = {}
    for (const o of p.all) m[o.shape] = o.bucket
    return m
  }

  describe('convergence — an unenumerated `this` shape lands in UNKNOWN, not through', () => {
    it('this[computed] -> UNKNOWN', () => {
      expect(bucketsByShape("    this[key].use('/', S())")['[computed]']).toBe('UNKNOWN')
    })
    it('({app} = this) assignment-form destructure -> UNKNOWN (declaration form stays ESCAPE)', () => {
      const p = partitionOf('    let app\n    ;({ app } = this)\n    app.use(S())')
      expect(p.unknown.some((o) => o.shape === 'bare')).toBe(true)
    })
    it('Reflect.get(this, "app") — bare this into a call -> UNKNOWN', () => {
      const p = partitionOf("    Reflect.get(this, 'app').use('/', S())")
      expect(p.unknown.some((o) => o.shape === 'bare')).toBe(true)
    })
    it('this.newAlias — a this.<name> not in the frozen census -> UNKNOWN (SAFE is occurrence-level, not a name rule)', () => {
      expect(bucketsByShape('    this.newAlias.doThing()')['.newAlias']).toBe('UNKNOWN')
    })
  })

  describe('SAFE is occurrence-level with fixed multiplicity', () => {
    it('a single this.injector read, when frozen, is SAFE; a COPY of it (a new occurrence key) is UNKNOWN', () => {
      const single = '    this.injector.get(X)'
      const frozen = new Set(deriveSafeCensus(ts.createSourceFile('f.ts', wrapSetup(single), ts.ScriptTarget.ES2022, true), SCOPE))
      // original alone: SAFE
      expect(partitionOf(single, frozen).safe.length).toBe(1)
      expect(partitionOf(single, frozen).unknown.length).toBe(0)
      // add a second, identical access -> a new AST-path key -> UNKNOWN (census drift)
      const copied = partitionOf('    this.injector.get(X)\n    this.injector.get(X)', frozen)
      expect(copied.safe.length).toBe(1)
      expect(copied.unknown.length).toBe(1)
    })
  })

  describe('the context key is ORDINAL-independent (an unrelated insertion — even in the SAME method — does not false-red; a structural re-context DOES red, by design)', () => {
    it('inserting a statement in ANOTHER method does not change any assembly-scope key', () => {
      const before = deriveSafeCensus(ts.createSourceFile('a.ts', 'class C {\n  setupMiddleware() {\n    this.injector.get(X)\n  }\n  other() { const z = 1 }\n}\n', ts.ScriptTarget.ES2022, true), SCOPE)
      const after = deriveSafeCensus(ts.createSourceFile('b.ts', 'class C {\n  setupMiddleware() {\n    this.injector.get(X)\n  }\n  other() { const z = 1; const w = 2; const v = 3 }\n}\n', ts.ScriptTarget.ES2022, true), SCOPE)
      expect(after).toEqual(before)
    })
    it('P2-b: inserting an UNRELATED statement BEFORE a safe access in the SAME method does not move its key (kind-path, not child-ordinal)', () => {
      const before = deriveSafeCensus(ts.createSourceFile('a.ts', 'class C {\n  setupMiddleware() {\n    this.injector.get(X)\n  }\n}\n', ts.ScriptTarget.ES2022, true), SCOPE)
      const after = deriveSafeCensus(ts.createSourceFile('b.ts', 'class C {\n  setupMiddleware() {\n    const z = 1; void z\n    this.injector.get(X)\n  }\n}\n', ts.ScriptTarget.ES2022, true), SCOPE)
      expect(after).toEqual(before)
    })
    it('P2-b: a genuine RE-CONTEXT (nesting a frozen safe access under a new construct) DOES red — the kind-path changes', () => {
      const flat = '    this.injector.get(X)'
      const frozen = new Set(deriveSafeCensus(ts.createSourceFile('f.ts', wrapSetup(flat), ts.ScriptTarget.ES2022, true), SCOPE))
      // same access, now nested under `if (cond) { ... }` -> kind-path gains
      // IfStatement>Block -> the frozen key no longer matches -> UNKNOWN.
      const nested = partitionOf('    if (cond) {\n      this.injector.get(X)\n    }', frozen)
      expect(nested.safe.length).toBe(0)
      expect(nested.unknown.length).toBe(1)
    })
  })

  describe('the set-level partition proof is load-bearing (a count identity alone is not)', () => {
    it('assertValidPartition throws on a miss-one + double-another partition that KEEPS the count equal', () => {
      const p = partitionOf('    this.injector.get(X)\n    this.logger.info(Y)')
      // hand-build a broken partition: drop one occurrence, duplicate another — count unchanged
      const broken: ThisPartition = {
        total: p.total,
        all: [p.all[0], p.all[0]], // node 0 twice, node 1 missing — |all| still 2
        site: [], escape: [], safe: [p.all[0], p.all[0]], unknown: [],
      }
      expect(() => assertValidPartition(broken)).toThrow()
    })
  })
})

})
