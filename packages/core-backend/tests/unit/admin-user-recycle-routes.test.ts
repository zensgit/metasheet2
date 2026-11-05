import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const pg = vi.hoisted(() => ({ query: vi.fn() }))
const audit = vi.hoisted(() => ({ auditLog: vi.fn(async () => undefined) }))
const sessions = vi.hoisted(() => ({ revokeUserSessions: vi.fn(async () => null) }))
const rbac = vi.hoisted(() => ({ isAdmin: vi.fn(async () => false) }))
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
vi.mock('../../src/auth/session-revocation', () => ({ revokeUserSessions: sessions.revokeUserSessions }))
vi.mock('../../src/rbac/service', () => ({ isAdmin: rbac.isAdmin, invalidateUserPerms: vi.fn() }))
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }))

import { registerAdminUserRecycleRoutes } from '../../src/routes/admin-user-recycle'

function app() {
  const server = express()
  server.use(express.json())
  const router = express.Router()
  registerAdminUserRecycleRoutes(router)
  server.use(router)
  return server
}

const pinned = usePinnedServer()

describe('admin user recycle routes', () => {
  beforeEach(() => {
    pinned.setApp(app())
    authState.id = 'admin-1'
    authState.role = 'admin'
    pg.query.mockReset()
    audit.auditLog.mockClear()
    sessions.revokeUserSessions.mockClear()
  })

  it('rejects a non-admin', async () => {
    authState.id = 'user-2'
    authState.role = 'user'
    const response = await request(pinned.url()).get('/api/admin/users/recycle')
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
  })

  it('lists the recycle bin for a platform admin', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-lin',
          email: 'lin@example.com',
          name: '林岚',
          department: '装配',
          deleted_at: '2026-10-01T00:00:00.000Z',
          deleted_by: 'admin-1',
          purge_after: '2026-10-31T00:00:00.000Z',
          active_before_delete: true,
        }],
      })

    const response = await request(pinned.url()).get('/api/admin/users/recycle')
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(1)
    expect(response.body.data.retentionDays).toBe(30)
    expect(response.body.data.items[0]).toMatchObject({ id: 'user-lin', name: '林岚', deletedBy: 'admin-1' })
    expect(String(pg.query.mock.calls[0][0])).toContain('purged_at IS NULL')
  })

  it('restores per item and audits the batch', async () => {
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (String(sql).includes('FOR UPDATE')) {
        if (params?.[0] !== 'user-lin') return { rows: [] }
        return { rows: [{ id: 'user-lin', email: 'lin@example.com', deleted_at: '2026-10-01T00:00:00.000Z', purged_at: null }] }
      }
      if (String(sql).includes('SET is_active = COALESCE')) {
        return { rows: [{ id: 'user-lin', email: 'lin@example.com' }] }
      }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/recycle/restore')
      .send({ userIds: ['user-lin', 'missing'] })

    expect(response.status).toBe(200)
    expect(response.body.data.results.map((row: { code: string | null }) => row.code)).toEqual([null, 'USER_NOT_FOUND'])
    expect(audit.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restore',
      resourceType: 'user-batch',
      resourceId: 'recycle-restore',
    }))
  })

  it('requires the purge phrase and anonymizes without deleting the user row', async () => {
    const mismatch = await request(pinned.url())
      .post('/api/admin/users/recycle/purge')
      .send({ userIds: ['user-lin'], confirmText: '删除' })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.code).toBe('CONFIRM_TEXT_MISMATCH')

    pg.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (String(sql).includes('FOR UPDATE')) {
        return { rows: [{ id: 'user-lin', email: 'lin@example.com', deleted_at: '2026-10-01T00:00:00.000Z', purged_at: null }] }
      }
      if (String(sql).includes('SET email = NULL')) return { rows: [{ id: 'user-lin' }] }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/recycle/purge')
      .send({ userIds: ['user-lin'], confirmText: '立即清除' })

    expect(response.status).toBe(200)
    expect(response.body.data.results[0]).toMatchObject({ ok: true, email: null })
    const statements = pg.query.mock.calls.map((call) => String(call[0]))
    expect(statements.some((sql) => sql.includes('DELETE FROM user_login_aliases'))).toBe(true)
    expect(statements.some((sql) => /DELETE\s+FROM\s+users\b/i.test(sql))).toBe(false)
    expect(audit.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'recycle-purge',
      meta: expect.objectContaining({ outcome: 'purged' }),
    }))
  })

  it('rescrubs only an already purged account and does not rewrite the user row', async () => {
    const mismatch = await request(pinned.url())
      .post('/api/admin/users/recycle/rescrub')
      .send({ userIds: ['user-lin'], confirmText: '立即清除' })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.code).toBe('CONFIRM_TEXT_MISMATCH')

    const seen: string[] = []
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      seen.push(text)
      if (text.includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (text.includes('FOR UPDATE') && text.includes('FROM users')) {
        return { rows: [{ id: 'user-lin', email: null, username: null, mobile: null, deleted_at: '2026-10-01T00:00:00.000Z', purged_at: '2026-11-01T00:00:00.000Z' }] }
      }
      if (text.includes('to_regclass')) return { rows: [{ rel: String(params?.[0] ?? '') }] }
      if (text.includes("'rescrub'")) return { rows: [{ id: 1 }], rowCount: 1 }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/recycle/rescrub')
      .send({ userIds: ['user-lin'], confirmText: '重新清理' })

    expect(response.status).toBe(200)
    expect(response.body.data.results[0]).toMatchObject({ ok: true, userId: 'user-lin', email: null, code: null })
    expect(seen.some((sql) => sql.includes('SET email = NULL'))).toBe(false)
    expect(seen.some((sql) => /UPDATE\s+users\b/i.test(sql))).toBe(false)
    expect(seen.some((sql) => sql.includes('UPDATE directory_accounts'))).toBe(false)
    expect(seen.some((sql) => sql.includes('directory_account_links'))).toBe(false)
    expect(seen.some((sql) => sql.includes('user_login_alias_collision_report'))).toBe(false)
    expect(seen.some((sql) => sql.includes("'rescrub'"))).toBe(true)
    const batchAudit = audit.auditLog.mock.calls.map((call) => call[0] as { resourceId?: string; meta?: Record<string, unknown> })
      .find((entry) => entry.resourceId === 'recycle-rescrub')
    expect(batchAudit?.meta).toMatchObject({ outcome: 'rescrubbed', successCount: 1 })
    expect(JSON.stringify(batchAudit?.meta)).not.toMatch(/example\.|accountLabel|@/)
  })

  it('rejects rescrub of an active account and of one still in the recycle bin', async () => {
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (String(sql).includes('FOR UPDATE')) {
        const id = params?.[0]
        if (id === 'user-live') {
          return { rows: [{ id, email: 'live@example.com', deleted_at: null, purged_at: null }] }
        }
        if (id === 'user-bin') {
          return { rows: [{ id, email: 'bin@example.com', deleted_at: '2026-10-01T00:00:00.000Z', purged_at: null }] }
        }
        return { rows: [] }
      }
      if (String(sql).includes("'rescrub'")) return { rows: [{ id: 1 }], rowCount: 1 }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/recycle/rescrub')
      .send({ userIds: ['user-live', 'user-bin'], confirmText: 'Rescrub now' })

    expect(response.status).toBe(200)
    expect(response.body.data.results.map((row: { code: string }) => row.code)).toEqual(['NOT_PURGED', 'NOT_PURGED'])
    expect(response.body.data.successCount).toBe(0)
  })

  it('does not store an unmatched email as an audit resource id', async () => {
    const email = 'not-a-user@example.test'
    const receiptParams: unknown[][] = []
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (text.includes('FOR UPDATE') && text.includes('FROM users')) return { rows: [] }
      if (text.includes("'rescrub'")) {
        receiptParams.push(params ?? [])
        return { rows: [{ id: 1 }], rowCount: 1 }
      }
      return { rows: [] }
    })

    const response = await request(pinned.url())
      .post('/api/admin/users/recycle/rescrub')
      .send({ userIds: [email], confirmText: '重新清理' })

    expect(response.status).toBe(200)
    expect(response.body.data.results[0].code).toBe('USER_NOT_FOUND')
    expect(receiptParams).toEqual([[null, 'USER_NOT_FOUND', 0]])
    const batchAudit = audit.auditLog.mock.calls.map((call) => call[0] as { resourceId?: string; meta?: Record<string, unknown> })
      .find((entry) => entry.resourceId === 'recycle-rescrub')
    expect(JSON.stringify(batchAudit)).not.toContain(email)
    expect(JSON.stringify(receiptParams)).not.toContain(email)
  })
})
