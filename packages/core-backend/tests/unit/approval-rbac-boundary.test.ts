/**
 * Approval RBAC boundary verification tests
 *
 * Adds automated RBAC boundary coverage for approval routes using the real
 * rbacGuard middleware with mocked RBAC service dependencies.
 *
 * This reduces uncertainty around BL1-BL4 permission boundaries, but does not
 * replace the real-environment validation tracked in issue #830.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted state – shared across all mocks
// ---------------------------------------------------------------------------
const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helper users
// ---------------------------------------------------------------------------
function readOnlyUser() {
  return { id: 'u-readonly', name: 'Reader', permissions: ['approvals:read'] }
}

function writerUser() {
  return { id: 'u-writer', name: 'Writer', permissions: ['approvals:read', 'approvals:write'] }
}

function actorUser() {
  return { id: 'u-actor', name: 'Actor', permissions: ['approvals:read', 'approvals:act'] }
}

function templateManager() {
  return { id: 'u-mgr', name: 'Manager', permissions: ['approvals:read', 'approval-templates:manage'] }
}

function adminUser() {
  return { id: 'u-admin', name: 'Admin', role: 'admin', permissions: [] }
}

function noPermsUser() {
  return { id: 'u-none', name: 'NoPerm', permissions: [] }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Approval RBAC boundary verification', () => {
  let app: Express

  beforeEach(async () => {
    vi.resetModules()

    // Reset auth – no user by default (forces 401 unless overridden)
    authState.user = null

    // Reset pg mocks – return empty results everywhere
    pgState.pool.query.mockReset()
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
  })

  // =========================================================================
  // BL1: No token → 401
  // =========================================================================
  describe('BL1: No token → 401', () => {
    it('GET /api/approval-templates without auth → 401', async () => {
      const res = await request(app).get('/api/approval-templates')
      expect(res.status).toBe(401)
    })

    it('POST /api/approval-templates without auth → 401', async () => {
      const res = await request(app)
        .post('/api/approval-templates')
        .send({ name: 'test', key: 'test-key' })
      expect(res.status).toBe(401)
    })

    it('GET /api/approvals without auth → 401', async () => {
      const res = await request(app).get('/api/approvals')
      expect(res.status).toBe(401)
    })

    it('GET /api/approvals/:id without auth → 401', async () => {
      const res = await request(app).get('/api/approvals/apr-1')
      expect(res.status).toBe(401)
    })

    it('POST /api/approvals without auth → 401', async () => {
      const res = await request(app)
        .post('/api/approvals')
        .send({ templateId: 'tpl-1', formData: {} })
      expect(res.status).toBe(401)
    })

    it('POST /api/approvals/:id/actions without auth → 401', async () => {
      const res = await request(app)
        .post('/api/approvals/apr-1/actions')
        .send({ action: 'approve', version: 0 })
      expect(res.status).toBe(401)
    })
  })

  // =========================================================================
  // BL2: No manage permission → 403 on template mutations
  // =========================================================================
  describe('BL2: No manage permission → 403 on template mutations', () => {
    beforeEach(() => {
      authState.user = readOnlyUser()
    })

    it('POST /api/approval-templates with only approvals:read → 403', async () => {
      const res = await request(app)
        .post('/api/approval-templates')
        .send({ name: 'test', key: 'test-key' })
      expect(res.status).toBe(403)
    })

    it('PATCH /api/approval-templates/:id with only approvals:read → 403', async () => {
      const res = await request(app)
        .patch('/api/approval-templates/tpl-1')
        .send({ name: 'updated' })
      expect(res.status).toBe(403)
    })

    it('POST /api/approval-templates/:id/publish with only approvals:read → 403', async () => {
      const res = await request(app)
        .post('/api/approval-templates/tpl-1/publish')
        .send({})
      expect(res.status).toBe(403)
    })

    it('GET /api/approval-templates with approval-templates:manage → 200', async () => {
      authState.user = templateManager()
      const res = await request(app).get('/api/approval-templates')
      expect(res.status).toBe(200)
    })
  })

  // =========================================================================
  // BL3: No write permission → 403 on create approval
  // =========================================================================
  describe('BL3: No write permission → 403 on create approval', () => {
    beforeEach(() => {
      authState.user = readOnlyUser()
    })

    it('POST /api/approvals with only approvals:read → 403', async () => {
      const res = await request(app)
        .post('/api/approvals')
        .send({ templateId: 'tpl-1', formData: {} })
      expect(res.status).toBe(403)
    })

    it('GET /api/approvals with approvals:read → 200', async () => {
      const res = await request(app).get('/api/approvals')
      expect(res.status).toBe(200)
    })

    it('GET /api/approvals/:id with approvals:read reaches the handler', async () => {
      const res = await request(app).get('/api/approvals/apr-1')
      expect(res.status).toBe(404)
    })

    it('GET /api/approvals/:id with approvals:read returns approval detail when present', async () => {
      const now = new Date('2026-04-11T00:00:00.000Z')

      pgState.pool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM approval_instances WHERE id = $1')) {
          return {
            rows: [{
              id: 'apr-1',
              status: 'pending',
              version: 0,
              source_system: 'platform',
              external_approval_id: null,
              workflow_key: 'expense-approval',
              business_key: 'expense:apr-1',
              title: 'Travel reimbursement',
              requester_snapshot: { id: 'u-requester', name: 'Requester' },
              subject_snapshot: { expenseId: 'exp-1' },
              policy_snapshot: {},
              metadata: {},
              current_step: 1,
              total_steps: 2,
              source_updated_at: null,
              last_synced_at: null,
              sync_status: 'ok',
              sync_error: null,
              template_id: 'tpl-1',
              template_version_id: 'tplv-1',
              published_definition_id: 'pub-1',
              request_no: 'REQ-1',
              form_snapshot: { amount: 128 },
              current_node_key: 'manager-review',
              created_at: now,
              updated_at: now,
            }],
            rowCount: 1,
          }
        }

        if (sql.includes('SELECT * FROM approval_assignments')) {
          return {
            rows: [{
              id: 'asg-1',
              instance_id: 'apr-1',
              assignment_type: 'user',
              assignee_id: 'u-readonly',
              source_step: 1,
              node_key: 'manager-review',
              is_active: true,
              metadata: {},
              created_at: now,
              updated_at: now,
            }],
            rowCount: 1,
          }
        }

        return { rows: [], rowCount: 0 }
      })

      const res = await request(app).get('/api/approvals/apr-1')

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        id: 'apr-1',
        status: 'pending',
        workflowKey: 'expense-approval',
        assignments: [{
          id: 'asg-1',
          assigneeId: 'u-readonly',
          type: 'user',
        }],
      })
    })
  })

  // =========================================================================
  // Action boundary: No act permission → 403 on actions
  // =========================================================================
  describe('BL5: No act permission → 403 on actions', () => {
    beforeEach(() => {
      authState.user = readOnlyUser()
    })

    it('POST /api/approvals/:id/actions with only approvals:read → 403', async () => {
      const res = await request(app)
        .post('/api/approvals/apr-1/actions')
        .send({ action: 'approve', version: 0 })
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // Permission matrix integration
  // =========================================================================
  describe('Permission matrix integration', () => {
    it('user with no approval permissions gets 403 on all endpoints', async () => {
      authState.user = noPermsUser()

      const results = await Promise.all([
        request(app).get('/api/approval-templates'),
        request(app).post('/api/approval-templates').send({ name: 'x', key: 'x' }),
        request(app).get('/api/approvals'),
        request(app).get('/api/approvals/a'),
        request(app).post('/api/approvals').send({ templateId: 't', formData: {} }),
        request(app).post('/api/approvals/a/actions').send({ action: 'approve', version: 0 }),
      ])

      for (const res of results) {
        expect(res.status).toBe(403)
      }
    })

    it('user with approvals:read can GET list but not POST', async () => {
      authState.user = readOnlyUser()

      const getRes = await request(app).get('/api/approvals')
      expect(getRes.status).toBe(200)

      const detailRes = await request(app).get('/api/approvals/apr-1')
      expect(detailRes.status).toBe(404)

      const postRes = await request(app)
        .post('/api/approvals')
        .send({ templateId: 'tpl-1', formData: {} })
      expect(postRes.status).toBe(403)
    })

    it('user with approvals:read + approvals:write can create but not act', async () => {
      authState.user = writerUser()

      // Can read
      const getRes = await request(app).get('/api/approvals')
      expect(getRes.status).toBe(200)

      // Can create (will hit handler logic, not blocked by RBAC)
      const postRes = await request(app)
        .post('/api/approvals')
        .send({ templateId: 'tpl-1', formData: {} })
      // The handler may return 4xx/5xx due to missing template data,
      // but the point is it's NOT 403 — RBAC allowed it through.
      expect(postRes.status).not.toBe(403)
      expect(postRes.status).not.toBe(401)

      // Cannot act
      const actRes = await request(app)
        .post('/api/approvals/apr-1/actions')
        .send({ action: 'approve', version: 0 })
      expect(actRes.status).toBe(403)
    })

    it('user with approvals:read + approvals:act can act but not create', async () => {
      authState.user = actorUser()

      // Can read
      const getRes = await request(app).get('/api/approvals')
      expect(getRes.status).toBe(200)

      // Cannot create
      const postRes = await request(app)
        .post('/api/approvals')
        .send({ templateId: 'tpl-1', formData: {} })
      expect(postRes.status).toBe(403)

      // Can act (will hit handler logic, not blocked by RBAC)
      const actRes = await request(app)
        .post('/api/approvals/apr-1/actions')
        .send({ action: 'approve', version: 0 })
      // The handler may return 4xx/5xx due to missing data,
      // but the point is it's NOT 403 — RBAC allowed it through.
      expect(actRes.status).not.toBe(403)
      expect(actRes.status).not.toBe(401)
    })

    it('admin user bypasses all permission checks', async () => {
      authState.user = adminUser()

      const results = await Promise.all([
        request(app).get('/api/approval-templates'),
        request(app).get('/api/approvals'),
        request(app).get('/api/approvals/pending'),
      ])

      for (const res of results) {
        expect(res.status).not.toBe(401)
        expect(res.status).not.toBe(403)
      }
    })
  })
})
