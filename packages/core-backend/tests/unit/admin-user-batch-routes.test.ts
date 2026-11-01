import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const pg = vi.hoisted(() => ({ query: vi.fn() }))
const audit = vi.hoisted(() => ({ auditLog: vi.fn(async () => undefined) }))
const alias = vi.hoisted(() => ({ claimNonEmptyLoginAliasesOrThrow: vi.fn(async () => []) }))
const roles = vi.hoisted(() => ({
  assignUserRoles: vi.fn(async () => ({ rowCount: 1, affectedUserIds: [], delegatedAdminScopeCleanup: [] })),
  unassignUserRoles: vi.fn(async () => ({ rowCount: 1, affectedUserIds: [], delegatedAdminScopeCleanup: [] })),
}))
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
vi.mock('../../src/rbac/role-assignment', () => ({
  assignUserRoles: roles.assignUserRoles,
  unassignUserRoles: roles.unassignUserRoles,
}))
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

const pinned = usePinnedServer()

describe('admin user batch routes', () => {
  beforeEach(() => {
    pinned.setApp(app())
    authState.id = 'admin-1'
    authState.role = 'admin'
    pg.query.mockReset()
    audit.auditLog.mockClear()
    alias.claimNonEmptyLoginAliasesOrThrow.mockClear()
    roles.assignUserRoles.mockReset()
    roles.unassignUserRoles.mockReset()
    roles.assignUserRoles.mockResolvedValue({ rowCount: 1, affectedUserIds: [], delegatedAdminScopeCleanup: [] })
    roles.unassignUserRoles.mockResolvedValue({ rowCount: 1, affectedUserIds: [], delegatedAdminScopeCleanup: [] })
    sessions.revokeUserSessions.mockClear()
  })

  it('creates a valid row, skips a duplicate, and audits the batch without storing the password', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM roles')) return { rows: [{ id: 'user' }] }
      if (sql.includes('FROM users WHERE lower(email)')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) return { rows: [] }
      return { rows: [] }
    })

    const response = await request(pinned.url())
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

    const response = await request(pinned.url())
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

  it('replaces a previous admin membership in the same transaction when the role changes', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('SELECT role_id FROM user_roles')) return { rows: [{ role_id: 'admin' }] }
      if (text.includes('FROM roles')) return { rows: [{ id: 'user' }] }
      if (text.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-lin',
            email: 'linlan@example.com',
            name: '林岚',
            role: 'admin',
            department: null,
            is_active: true,
          }],
        }
      }
      if (text.includes('UPDATE users')) return { rows: [] }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/update')
      .send({ items: [{ userId: 'user-lin', roleId: 'user' }] })

    expect(response.status).toBe(200)
    expect(response.body.data.successCount).toBe(1)
    expect(roles.unassignUserRoles).toHaveBeenCalledWith(expect.objectContaining({
      userIds: ['user-lin'],
      roleId: 'admin',
      scope: { kind: 'platform-admin' },
    }))
    expect(roles.assignUserRoles).toHaveBeenCalledWith(expect.objectContaining({
      userIds: ['user-lin'],
      roleId: 'user',
      scope: { kind: 'platform-admin' },
    }))
    const unassignExecutor = roles.unassignUserRoles.mock.calls[0]?.[0].executor
    const assignExecutor = roles.assignUserRoles.mock.calls[0]?.[0].executor
    expect(unassignExecutor).toBe(assignExecutor)
    expect(roles.assignUserRoles.mock.invocationCallOrder[0]).toBeLessThan(
      roles.unassignUserRoles.mock.invocationCallOrder[0],
    )
    expect(pg.query.mock.calls.some((call) => String(call[0]).includes('is_admin'))).toBe(true)
    const sqls = pg.query.mock.calls.map((call) => String(call[0]))
    const lockAt = sqls.findIndex((sql) => sql.includes('FOR UPDATE'))
    const admissionLockAt = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
    const membershipAt = sqls.findIndex((sql) => sql.includes('SELECT role_id FROM user_roles'))
    expect(admissionLockAt).toBeGreaterThanOrEqual(0)
    expect(lockAt).toBeGreaterThan(admissionLockAt)
    expect(membershipAt).toBeGreaterThan(lockAt)
  })

  it('replaces leftover memberships when users.role already matches and records the unassign witness', async () => {
    const events: string[] = []
    roles.assignUserRoles.mockImplementation(async (options: { roleId: string }) => {
      events.push(`assign:${options.roleId}`)
      return { rowCount: 1, affectedUserIds: ['user-lin'], delegatedAdminScopeCleanup: [] }
    })
    roles.unassignUserRoles.mockImplementation(async (options: { roleId: string }) => {
      events.push(`unassign:${options.roleId}`)
      return { rowCount: 1, affectedUserIds: ['user-lin'], delegatedAdminScopeCleanup: [] }
    })
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('user_namespace_admissions')) {
        events.push(`witness:${String(params?.[2] ?? '')}:${String(params?.[1] ?? '')}`)
        return { rows: [] }
      }
      if (text.includes('SELECT role_id FROM user_roles')) {
        return { rows: [{ role_id: 'attendance_employee' }, { role_id: 'user' }] }
      }
      if (text.includes('FOR UPDATE') || text.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-lin',
            email: 'linlan@example.com',
            name: '林岚',
            role: 'user',
            department: null,
            is_active: true,
            access_generation: 0,
          }],
        }
      }
      if (text.includes('FROM roles')) return { rows: [{ id: 'user' }] }
      if (text.includes('UPDATE users')) return { rows: [] }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/update')
      .send({ items: [{ userId: 'user-lin', roleId: 'user' }] })

    expect(response.status).toBe(200)
    expect(response.body.data.successCount).toBe(1)
    expect(events).toEqual([
      'assign:user',
      'unassign:attendance_employee',
      'witness:role_unassigned:attendance',
    ])
    expect(roles.assignUserRoles).toHaveBeenCalledWith(expect.objectContaining({
      userIds: ['user-lin'],
      roleId: 'user',
    }))
    expect(roles.unassignUserRoles).not.toHaveBeenCalledWith(expect.objectContaining({ roleId: 'user' }))
  })

  it('rejects self-disable before a combined profile update writes', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM users')) {
        return {
          rows: [{
            id: 'admin-1',
            email: 'admin@example.com',
            name: '管理员',
            role: 'admin',
            department: '计划部',
            is_active: true,
          }],
        }
      }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/update')
      .send({ items: [{ userId: 'admin-1', department: 'must-not-save', isActive: false }] })

    expect(response.status).toBe(200)
    expect(response.body.data.results[0].code).toBe('SELF_DISABLE_FORBIDDEN')
    expect(pg.query.mock.calls.some((call) => String(call[0]).includes('UPDATE'))).toBe(false)
    expect(roles.assignUserRoles).not.toHaveBeenCalled()
    expect(roles.unassignUserRoles).not.toHaveBeenCalled()
  })

  it('refuses a non-admin', async () => {
    authState.id = 'user-2'
    authState.role = 'user'

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/disable')
      .send({ userIds: ['user-lin'], isActive: false })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
  })

  it('disables selected users except the actor and revokes their sessions', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('access_generation =')) return { rows: [{ access_generation: 1 }] }
      if (text.includes('FROM users')) {
        return {
          rows: [
            { id: 'user-lin', email: 'linlan@example.com', name: '林岚', role: 'user', department: null, is_active: true },
            { id: 'admin-1', email: 'admin@example.com', name: '管理员', role: 'admin', department: null, is_active: true },
          ],
        }
      }
      if (text.includes('UPDATE users')) return { rows: [{ id: 'user-lin', email: 'linlan@example.com' }] }
      return { rows: [] }
    })

    const response = await request(pinned.url())
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
    const sqls = pg.query.mock.calls.map((call) => String(call[0]))
    const lockAt = sqls.findIndex((sql) => sql.includes('FOR UPDATE'))
    const effectAt = sqls.findIndex((sql) => sql.includes('directory_deprovision_effects'))
    const eventAt = sqls.findIndex((sql) => sql.includes('directory_deprovision_events'))
    const generationAt = sqls.findIndex((sql) => sql.includes('access_generation ='))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(effectAt).toBeGreaterThan(lockAt)
    expect(eventAt).toBeGreaterThan(effectAt)
    expect(generationAt).toBeGreaterThan(eventAt)
    expect(pg.query.mock.calls.find((call) => String(call[0]).includes('directory_deprovision_events'))?.[1]).toEqual([
      'user-lin',
      'admin-1',
      'superseded by administrator user-status update',
    ])
  })

  it('locks and supersedes deprovision evidence when enabling a user', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('access_generation =')) return { rows: [{ access_generation: 2 }] }
      if (text.includes('FROM users')) {
        return {
          rows: [{
            id: 'user-lin',
            email: 'linlan@example.com',
            name: '林岚',
            role: 'user',
            department: null,
            is_active: false,
          }],
        }
      }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/disable')
      .send({ userIds: ['user-lin'], isActive: true })

    expect(response.status).toBe(200)
    expect(response.body.data.successCount).toBe(1)
    const sqls = pg.query.mock.calls.map((call) => String(call[0]))
    const lockAt = sqls.findIndex((sql) => sql.includes('FOR UPDATE'))
    const generationAt = sqls.findIndex((sql) => sql.includes('access_generation ='))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(generationAt).toBeGreaterThan(lockAt)
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled()
  })

  it('moves a confirmed hard delete into the recycle bin without deleting the user row', async () => {
    pg.query.mockResolvedValue({
      rows: [{ id: 'user-lin', email: 'linlan@example.com', name: '林岚', role: 'user', department: null, is_active: true, access_generation: 1, c: 2 }],
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/batch/delete')
      .send({ userIds: ['user-lin'], mode: 'hard', confirmText: '永久删除' })

    expect(response.status).toBe(200)
    expect(response.body.data.mode).toBe('recycle')
    expect(response.body.data.successCount).toBe(1)
    expect(response.body.data.results[0].message).toBe('已移入回收站')
    const statements = pg.query.mock.calls.map((call) => String(call[0]))
    expect(statements.some((sql) => sql.includes('SET deleted_at'))).toBe(true)
    expect(statements.some((sql) => /DELETE\s+FROM\s+users/i.test(sql))).toBe(false)
    expect(sessions.revokeUserSessions).toHaveBeenCalledWith('user-lin', expect.objectContaining({ reason: 'user-recycled' }))
    expect(audit.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete',
      resourceType: 'user-batch',
      resourceId: 'recycle',
    }))
  })
})
