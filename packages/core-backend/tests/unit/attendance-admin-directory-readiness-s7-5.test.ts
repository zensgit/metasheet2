/**
 * S7-5 / OD-S7-6: unit coverage for the attendance:admin directory-readiness seam.
 *
 * Proves:
 *  - values-free readiness query is org-anchored + requires a.is_active=true
 *  - host maxManagerChainLevels comes from MAX_MANAGER_CHAIN_LEVELS (no second constant)
 *  - canReadAttendanceDirectoryReadiness: platform admin yes; org member yes; foreign org no
 *  - route wiring: missing orgId → 400; unauthenticated → 401; non-member → 403; member → 200
 *  - 500 path returns a generic message (no raw DB error leakage)
 *
 * Mutation evidence (load-bearing):
 *  - drop the org_id filter in the EXISTS SQL → org-anchor assertion reds
 *  - drop a.is_active=true → inactive-account SQL assertion reds
 *  - drop the user_orgs membership check → foreign-org 403 reds
 *  - return account ids in the payload → values-free key assertion reds
 *  - surface err.message on 500 → generic-message assertion reds
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const queryMock = vi.fn()

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async (userId: string) => userId === 'platform-admin'),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => null),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return {
    ...actual,
    MAX_MANAGER_CHAIN_LEVELS: 10,
  }
})

const {
  attendanceAdminRouter,
  canReadAttendanceDirectoryReadiness,
  readOrgDirectoryReadiness,
} = await import('../../src/routes/attendance-admin')
const { MAX_MANAGER_CHAIN_LEVELS } = await import('../../src/services/ApprovalDirectoryOrg')
const pinned = usePinnedServer()

function makeApp(user: Record<string, unknown> | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user ?? undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

describe('readOrgDirectoryReadiness (values-free, org-anchored, active accounts)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('runs an EXISTS query scoped by org_id + linked + a.is_active=true', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ready: true }] })
    const result = await readOrgDirectoryReadiness('org-a', queryMock as never)
    expect(result).toEqual({
      hasLinkedDirectoryAccounts: true,
      maxManagerChainLevels: MAX_MANAGER_CHAIN_LEVELS,
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['org-a'])
    expect(sql).toMatch(/i\.org_id\s*=\s*\$1/)
    expect(sql).toMatch(/link_status\s*=\s*'linked'/)
    // Mutation evidence: dropping a.is_active=true reds this (runtime resolver parity).
    expect(sql).toMatch(/a\.is_active\s*=\s*true/)
    expect(sql).toMatch(/EXISTS/i)
    expect(sql).not.toMatch(/local_user_id|external_user_id|email|mobile|phone|raw/i)
    expect(Object.keys(result).sort()).toEqual(['hasLinkedDirectoryAccounts', 'maxManagerChainLevels'])
  })

  it('maps ready=false correctly (including the linked-but-inactive case at the SQL layer)', async () => {
    // The SQL predicate excludes inactive accounts; the helper just maps the EXISTS result.
    queryMock.mockResolvedValueOnce({ rows: [{ ready: false }] })
    const result = await readOrgDirectoryReadiness('org-empty', queryMock as never)
    expect(result.hasLinkedDirectoryAccounts).toBe(false)
  })
})

describe('canReadAttendanceDirectoryReadiness (auth / org isolation)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('allows a platform admin without consulting user_orgs', async () => {
    const req = { user: { id: 'platform-admin' } } as express.Request
    const allowed = await canReadAttendanceDirectoryReadiness(req, 'platform-admin', 'any-org', queryMock as never)
    expect(allowed).toBe(true)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('allows an active org member', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    const req = { user: { id: 'delegated-admin' } } as express.Request
    const allowed = await canReadAttendanceDirectoryReadiness(req, 'delegated-admin', 'org-a', queryMock as never)
    expect(allowed).toBe(true)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/user_orgs/)
    expect(params).toEqual(['delegated-admin', 'org-a'])
  })

  it('rejects a non-member of the target org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const req = { user: { id: 'foreign-admin' } } as express.Request
    const allowed = await canReadAttendanceDirectoryReadiness(req, 'foreign-admin', 'org-b', queryMock as never)
    expect(allowed).toBe(false)
  })
})

describe('GET /api/attendance-admin/directory-readiness (route)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('400 when orgId is missing', async () => {
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness')
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('ORG_ID_REQUIRED')
  })

  it('401 when unauthenticated', async () => {
    const app = makeApp(null)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness?orgId=org-a')
    expect(res.status).toBe(401)
  })

  it('403 when the caller is not a member of the org (and not platform admin)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const app = makeApp({ id: 'foreign-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness?orgId=org-b')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
  })

  it('200 with values-free payload for an org member', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ ready: false }] })
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness?orgId=org-a')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toEqual({
      hasLinkedDirectoryAccounts: false,
      maxManagerChainLevels: 10,
    })
    expect(res.body.data.accountIds).toBeUndefined()
    expect(res.body.data.users).toBeUndefined()
    expect(res.body.data.integrations).toBeUndefined()
  })

  it('500 returns a generic message — never raw DB/driver text (P3 values-free)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership ok
      .mockRejectedValueOnce(new Error('relation "directory_account_links" does not exist — SECRET_DETAIL'))
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness?orgId=org-a')
    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('DIRECTORY_READINESS_FAILED')
    expect(res.body?.error?.message).toBe('Failed to load directory readiness')
    // Mutation evidence: leaking err.message would re-introduce SECRET_DETAIL.
    expect(JSON.stringify(res.body)).not.toContain('SECRET_DETAIL')
    expect(JSON.stringify(res.body)).not.toContain('directory_account_links')
  })

  it('does not expose a platform-admin-only directory path — this is attendance-admin only', async () => {
    const app = makeApp({ id: 'platform-admin' })
    queryMock.mockResolvedValueOnce({ rows: [{ ready: true }] })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/directory-readiness?orgId=org-a')
    expect(res.status).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql] = queryMock.mock.calls[0] as [string]
    expect(sql).toMatch(/directory_account_links/)
    expect(sql).toMatch(/a\.is_active\s*=\s*true/)
  })
})
