/**
 * 按人查单（管理员）— the two administrator routes, against a fake pool:
 *   GET /api/approvals/admin/by-user           (list instances involving one user)
 *   GET /api/approvals/admin/directory/users   (user search including deactivated accounts)
 *
 * Both sit behind `approvals:admin`, the permission 批量转交 already uses; no new permission code.
 * The lookup is the ordinary list read with one extra filter, so the list scope conjunct is still
 * in the statement — asserted below on the captured SQL. Real-SQL behaviour (which rows each kind
 * selects) is in `tests/integration/approval-bulk-reassign.api.test.ts`.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
  query: pgState.pool.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  userHasPermission: vi.fn().mockResolvedValue(false),
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn().mockReturnValue({ size: 0 }),
}))

vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
  filterPermissionCodesByNamespaceAdmission: vi.fn().mockImplementation(
    (_userId: string, codes: string[]) => Promise.resolve(codes),
  ),
}))

const BY_USER_PATH = '/api/approvals/admin/by-user'
const ADMIN_DIRECTORY_PATH = '/api/approvals/admin/directory/users'
const PARTICIPANT_DIRECTORY_PATH = '/api/approvals/directory/users'

const APPROVAL_ADMIN = { id: 'u-approval-admin', permissions: ['approvals:admin'] }
const READER_ONLY = { id: 'u-reader', permissions: ['approvals:read', 'approvals:act'] }
const TEMPLATE_ADMIN = { id: 'u-template-admin', permissions: ['approvals:admin-templates', 'approval-templates:manage'] }

type QueryCall = [string, unknown[] | undefined]

function calls(): QueryCall[] {
  return pgState.pool.query.mock.calls as QueryCall[]
}

function countQuery(): QueryCall | undefined {
  return calls().find(([sql]) => sql.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances'))
}

function pageQuery(): QueryCall | undefined {
  return calls().find(([sql]) => sql.startsWith('SELECT * FROM approval_instances'))
}

describe('GET /api/approvals/admin/by-user', () => {
  let app: Express
  const pinned = usePinnedServer()

  beforeEach(async () => {
    vi.resetModules()
    authState.user = null
    pgState.pool.query.mockReset()
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockReset()

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    pinned.setApp(app)
  })

  it('requires authentication', async () => {
    const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-x&kind=pending`)
    expect(res.status).toBe(401)
    expect(pgState.pool.query).not.toHaveBeenCalled()
  })

  it('refuses a caller without approvals:admin (403), including a template administrator', async () => {
    for (const user of [READER_ONLY, TEMPLATE_ADMIN]) {
      authState.user = user
      const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-x&kind=involved`)
      expect(res.status).toBe(403)
    }
    expect(countQuery()).toBeUndefined()
  })

  it('answers 400 for an invalid kind before any list query runs', async () => {
    authState.user = APPROVAL_ADMIN
    const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-x&kind=all`)
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('APPROVAL_BY_USER_KIND_INVALID')
    expect(countQuery()).toBeUndefined()
  })

  it('answers 400 for a missing user id, a repeated user id, bad paging and unknown keys', async () => {
    authState.user = APPROVAL_ADMIN
    const cases: Array<[string, string]> = [
      ['kind=pending', 'APPROVAL_BY_USER_USER_REQUIRED'],
      ['userId=a&userId=b&kind=pending', 'APPROVAL_BY_USER_USER_REQUIRED'],
      ['userId=u-x&kind=pending&pageSize=101', 'APPROVAL_BY_USER_PAGING_INVALID'],
      ['userId=u-x&kind=pending&page=0', 'APPROVAL_BY_USER_PAGING_INVALID'],
      ['userId=u-x&kind=pending&assignee=u-y', 'VALIDATION_ERROR'],
    ]
    for (const [queryString, code] of cases) {
      const res = await request(pinned.url()).get(`${BY_USER_PATH}?${queryString}`)
      expect(res.status).toBe(400)
      expect(res.body?.error?.code).toBe(code)
    }
    expect(countQuery()).toBeUndefined()
  })

  it('runs the list read with the by-user filter AND the list scope, paged', async () => {
    authState.user = APPROVAL_ADMIN
    const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-target&kind=decided&page=3&pageSize=10`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: { kind: 'decided', items: [], total: 0, page: 3, pageSize: 10 },
    })

    const count = countQuery()
    expect(count).toBeDefined()
    const [countSql, countParams] = count!
    // The filter: the target user, decision actions only.
    expect(countSql).toContain(`action IN ('approve', 'reject', 'return', 'handle')`)
    expect(countParams?.[0]).toBe('u-target')
    // The scope: still appended, bound to the CALLER, never to the target.
    expect(countSql).toContain('FROM users scope_admin')
    expect(countParams).toContain('u-approval-admin')
    // No tab filter rides along: the tab seat arms are the unaliased `(assignment_type = 'user' AND
    // assignee_id = $n)` form, which only the tab block emits (the scope uses `scope_seat.`).
    expect(countSql).not.toMatch(/\(assignment_type = 'user' AND assignee_id = \$/)

    const page = pageQuery()
    expect(page).toBeDefined()
    const pageParams = page![1] ?? []
    expect(pageParams.slice(-2)).toEqual([10, 20])
  })

  it('maps every kind to its own condition', async () => {
    authState.user = APPROVAL_ADMIN
    const expectations: Array<[string, string]> = [
      ['pending', `status = 'pending'`],
      ['decided', `action IN ('approve', 'reject', 'return', 'handle')`],
      ['involved', `action NOT IN ('reassign', 'jump')`],
    ]
    for (const [kind, fragment] of expectations) {
      pgState.pool.query.mockClear()
      const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-target&kind=${kind}`)
      expect(res.status).toBe(200)
      expect(countQuery()?.[0]).toContain(fragment)
    }
  })

  it('returns the slim row shape only', async () => {
    authState.user = APPROVAL_ADMIN
    const created = new Date('2026-10-01T00:00:00.000Z')
    pgState.pool.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances')) {
        return { rows: [{ count: '1' }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT * FROM approval_instances')) {
        return {
          rows: [{
            id: 'apr-1',
            status: 'approved',
            version: 2,
            source_system: 'platform',
            external_approval_id: null,
            workflow_key: null,
            business_key: null,
            title: '采购申请',
            requester_snapshot: { id: 'u-req', name: '申请人', department: 'd-1' },
            subject_snapshot: {},
            policy_snapshot: {},
            metadata: {},
            current_step: 1,
            total_steps: 1,
            source_updated_at: null,
            last_synced_at: null,
            sync_status: 'ok',
            sync_error: null,
            template_id: 'tpl-1',
            request_no: 'AP-0001',
            form_snapshot: { amount: 100 },
            published_definition_id: null,
            current_node_key: null,
            created_at: created,
            updated_at: created,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-target&kind=involved`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        kind: 'involved',
        items: [{
          id: 'apr-1',
          requestNo: 'AP-0001',
          title: '采购申请',
          status: 'approved',
          templateId: 'tpl-1',
          requester: { id: 'u-req', name: '申请人' },
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    })
  })

  it('answers 500 (never an empty page) when the read fails', async () => {
    authState.user = APPROVAL_ADMIN
    const { Logger } = await import('../../src/core/logger')
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      pgState.pool.query.mockRejectedValue(new Error('connection reset'))
      const res = await request(pinned.url()).get(`${BY_USER_PATH}?userId=u-target&kind=pending`)
      expect(res.status).toBe(500)
      expect(res.body?.error?.code).toBe('APPROVAL_BY_USER_LOOKUP_FAILED')
      expect(JSON.stringify(res.body)).not.toContain('items')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('GET /api/approvals/admin/directory/users', () => {
  let app: Express
  const pinned = usePinnedServer()

  beforeEach(async () => {
    vi.resetModules()
    authState.user = null
    pgState.pool.query.mockReset()
    pgState.pool.query.mockResolvedValue({
      rows: [
        { id: 'u-active', name: '在职人员', email: 'a@example.test', is_active: true },
        { id: 'u-gone', name: '已离职人员', email: '', is_active: false },
      ],
      rowCount: 2,
    })
    pgState.pool.connect.mockReset()

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    pinned.setApp(app)
  })

  it('refuses a caller without approvals:admin (403)', async () => {
    authState.user = READER_ONLY
    const res = await request(pinned.url()).get(`${ADMIN_DIRECTORY_PATH}?q=x`)
    expect(res.status).toBe(403)
    expect(pgState.pool.query).not.toHaveBeenCalled()
  })

  it('includes deactivated accounts and marks every row with isActive', async () => {
    authState.user = APPROVAL_ADMIN
    const res = await request(pinned.url()).get(`${ADMIN_DIRECTORY_PATH}?q=x&limit=5`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      users: [
        { id: 'u-active', name: '在职人员', email: 'a@example.test', isActive: true },
        { id: 'u-gone', name: '已离职人员', email: '', isActive: false },
      ],
    })
    const [sql, params] = calls()[0]
    expect(sql).toContain('is_active')
    expect(sql).not.toContain('is_active = TRUE')
    expect(params).toEqual(['%x%', 5])
  })

  it('leaves the participant directory active-only with the minimal shape', async () => {
    authState.user = READER_ONLY
    const res = await request(pinned.url()).get(`${PARTICIPANT_DIRECTORY_PATH}?q=x`)
    expect(res.status).toBe(200)
    // The fake pool answers the same rows; the participant read must not surface `isActive`.
    for (const user of res.body.users as Array<Record<string, unknown>>) {
      expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name'])
    }
    const [sql] = calls()[0]
    expect(sql).toContain('is_active = TRUE')
    expect(sql).not.toContain(', is_active')
  })
})
