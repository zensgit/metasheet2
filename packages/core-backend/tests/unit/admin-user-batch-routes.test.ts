import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pg = vi.hoisted(() => ({ query: vi.fn() }))
const audit = vi.hoisted(() => ({ auditLog: vi.fn(async () => undefined) }))
const alias = vi.hoisted(() => ({ claimNonEmptyLoginAliasesOrThrow: vi.fn(async () => []) }))
const roles = vi.hoisted(() => ({ assignUserRoles: vi.fn(async () => ({ rowCount: 1, affectedUserIds: [], delegatedAdminScopeCleanup: [] })) }))
const sessions = vi.hoisted(() => ({ revokeUserSessions: vi.fn(async () => null) }))
const rbac = vi.hoisted(() => ({
  isAdmin: vi.fn(async () => false),
  invalidateUserPerms: vi.fn(),
}))
const authState = vi.hoisted(() => ({ id: 'admin-1', role: 'admin' }))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: authState.id, role: authState.role }
    next()
  },
}))
vi.mock('../../src/db/pg', () => ({
  query: pg.query,
  transaction: async (handler: (client: { query: typeof pg.query }) => Promise<unknown>) => handler({ query: pg.query }),
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: audit.auditLog }))
vi.mock('../../src/auth/login-alias-service', () => ({
  claimNonEmptyLoginAliasesOrThrow: alias.claimNonEmptyLoginAliasesOrThrow,
}))
vi.mock('../../src/rbac/role-assignment', () => ({ assignUserRoles: roles.assignUserRoles }))
vi.mock('../../src/auth/session-revocation', () => ({ revokeUserSessions: sessions.revokeUserSessions }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbac.isAdmin,
  invalidateUserPerms: rbac.invalidateUserPerms,
}))
vi.mock('bcryptjs', () => ({
  hash: vi.fn(async () => 'hashed'),
}))

import { registerAdminUserBatchRoutes } from '../../src/routes/admin-user-batch'

function app() {
  const server = express()
  server.use(express.json())
  const router = express.Router()
  registerAdminUserBatchRoutes(router)
  server.use(router)
  return server
}

describe('admin user batch routes', () => {
  beforeEach(() => {
    authState.id = 'admin-1'
    authState.role = 'admin'
    pg.query.mockReset()
    audit.auditLog.mockClear()
    alias.claimNonEmptyLoginAliasesOrThrow.mockClear()
    roles.assignUserRoles.mockClear()
    sessions.revokeUserSessions.mockClear()
  })

  it('creates a valid row, skips a duplicate, and audits the batch without storing the password', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM roles')) return { rows: [{ id: 'user' }] }
      if (sql.includes('FROM users WHERE lower(email)')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) return { rows: [] }
      return { rows: [] }
    })

    const response = await request(app())
      .post('/api/admin/users/batch/create')
      .send({
        items: [
          { email: 'new@example.com', name: '新同事', roleId: 'user', department: '计划部' },
          { email: 'bad', name: '坏' },
        ],
      })

    expect(response.status).toBe(200)
    expect(response.body.data.successCount).toBe(1)
    expect(response.body.data.failureCount).toBe(1)
    const failed = response.body.data.results.find((item: { ok: boolean }) => !item.ok)
    const created = response.body.data.results.find((item: { ok: boolean }) => item.ok)
    expect(failed.code).toBe('INVALID_EMAIL')
    expect(created.temporaryPassword).toMatch(/^Tmp-/)
    expect(roles.assignUserRoles).toHaveBeenCalledTimes(1)
    const batchAudit = audit.auditLog.mock.calls.find((call) => call[0]?.resourceType === 'user-batch')
    expect(batchAudit?.[0]).toMatchObject({ action: 'create', resourceId: 'create' })
    expect(JSON.stringify(batchAudit?.[0])).not.toContain('Tmp-')
  })

  it('returns a dry-run diff and does not write', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-lin',
            email: 'linlan@example.com',
            name: '林岚',
            role: 'user',
            department: '装配车间',
            is_active: true,
          }],
        }
      }
      if (sql.includes('FROM roles')) return { rows: [{ id: 'user' }] }
      throw new Error(`unexpected sql ${sql}`)
    })

    const response = await request(app())
      .post('/api/admin/users/batch/update')
      .send({
        dryRun: true,
        items: [{ userId: 'user-lin', department: '质量部' }],
      })

    expect(response.status).toBe(200)
    expect(response.body.data.dryRun).toBe(true)
    expect(response.body.data.results[0].changes).toEqual([
      { field: 'department', before: '装配车间', after: '质量部' },
    ])
    expect(pg.query.mock.calls.some((call) => String(call[0]).includes('UPDATE users'))).toBe(false)
    expect(audit.auditLog).not.toHaveBeenCalled()
  })

  it('refuses a non-admin', async () => {
    authState.id = 'user-2'
    authState.role = 'user'

    const response = await request(app())
      .post('/api/admin/users/batch/disable')
      .send({ userIds: ['user-lin'], isActive: false })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
  })

  it('disables selected users except the actor and revokes their sessions', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return {
          rows: [
            { id: 'user-lin', email: 'linlan@example.com', name: '林岚', role: 'user', department: null, is_active: true },
            { id: 'admin-1', email: 'admin@example.com', name: '管理员', role: 'admin', department: null, is_active: true },
          ],
        }
      }
      if (sql.includes('UPDATE users')) return { rows: [{ id: 'user-lin', email: 'linlan@example.com' }] }
      return { rows: [] }
    })

    const response = await request(app())
      .post('/api/admin/users/batch/disable')
      .send({ userIds: ['user-lin', 'admin-1'], isActive: false })

    expect(response.status).toBe(200)
    expect(response.body.data.successCount).toBe(1)
    expect(response.body.data.results.map((item: { code: string | null }) => item.code)).toEqual([
      null,
      'SELF_DISABLE_FORBIDDEN',
    ])
    expect(sessions.revokeUserSessions).toHaveBeenCalledWith('user-lin', expect.objectContaining({ reason: 'user-disabled' }))
    expect(audit.auditLog.mock.calls.some((call) => call[0]?.resourceId === 'disable')).toBe(true)
  })

  it('audits a refused hard delete after the typed confirmation', async () => {
    pg.query.mockResolvedValue({
      rows: [{ id: 'user-lin', email: 'linlan@example.com', name: '林岚', role: 'user', department: null, is_active: true }],
    })

    const response = await request(app())
      .post('/api/admin/users/batch/delete')
      .send({ userIds: ['user-lin'], mode: 'hard', confirmText: '永久删除' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('HARD_DELETE_UNSUPPORTED')
    expect(audit.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete',
      resourceId: 'hard-delete',
      meta: expect.objectContaining({ outcome: 'refused', code: 'HARD_DELETE_UNSUPPORTED' }),
    }))
    expect(pg.query.mock.calls.some((call) => String(call[0]).includes('DELETE FROM'))).toBe(false)
  })
})
