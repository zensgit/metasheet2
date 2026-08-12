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
 *     is a separate AST registration-site model over `index.ts` itself
 *     (`tests/helpers/attendance-w6-index-assembly-order.ts`), not a
 *     source-text guard. See the describe block below for the full scope
 *     statement, including the honest (weaker) claim for the gate subject.
 *  4. The client-input boundary at the top of the handler — org-identity is
 *     derived only from the authenticated principal, and any query/body
 *     `orgId` the client repeats must byte-equal it or the request is
 *     refused before any aggregate SQL runs; every OTHER query/body key is
 *     rejected outright (W6-R7). See the "client-input boundary" describe
 *     block below — DB-free, same harness as guarantees 1-2.
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
  findThisMethodCalls,
  sitesInMethod,
  subjectState,
  textMentions,
  type AssemblyModel,
} from '../helpers/attendance-w6-index-assembly-order'
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
 * Guarantee 3 (see file header): in the REAL application assembly, this
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
})
