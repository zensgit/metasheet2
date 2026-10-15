import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const state = vi.hoisted(() => ({
  user: { id: 'admin-1', role: 'admin' } as Record<string, unknown> | null,
  isAdmin: vi.fn(async () => false),
  query: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = state.user
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => state.query(...args),
  transaction: vi.fn(),
  pool: null,
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: (...args: unknown[]) => state.isAdmin(...args),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
}))

// admin-users.ts imports audit at load. The real module constructs the message bus.
// This read route never writes an audit event; the mock only keeps that graph out of the process.
vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn(),
}))

import { adminRoleMembersRouter } from '../../src/routes/admin-role-members'

const pinned = usePinnedServer()

function snapshot(partial: { role_exists?: boolean; total?: number; items?: unknown } = {}) {
  return {
    rows: [{
      role_exists: true,
      total: 0,
      items: [],
      ...partial,
    }],
  }
}

function membersOf(...names: Array<{ id: string; displayName: string; email?: string }>) {
  return names
}

beforeEach(() => {
  state.user = { id: 'admin-1', role: 'admin' }
  state.isAdmin.mockReset()
  state.isAdmin.mockResolvedValue(false)
  state.query.mockReset()
  state.query.mockResolvedValue(snapshot())
  const app = express()
  app.use(adminRoleMembersRouter())
  pinned.setApp(app)
})

function getMembers(roleId = 'attendance_admin', query?: Record<string, string | number>) {
  const call = request(pinned.url()).get(`/api/admin/roles/${encodeURIComponent(roleId)}/members`)
  return query ? call.query(query) : call
}

describe('GET /api/admin/roles/:roleId/members', () => {
  it('refuses missing, ordinary, roles:read, delegated, and permissions-array wildcard callers before any query', async () => {
    state.user = null
    expect((await getMembers()).status).toBe(401)

    state.user = { id: 'user-1', role: 'user', roles: ['user'], perms: [] }
    expect((await getMembers()).status).toBe(403)

    state.user = { id: 'reader-1', role: 'user', perms: ['roles:read'] }
    expect((await getMembers()).status).toBe(403)

    state.user = {
      id: 'delegate-1',
      role: 'user',
      roles: ['plugin_elearning_admin'],
      perms: ['roles:read', 'elearning:admin'],
    }
    expect((await getMembers()).status).toBe(403)

    state.user = { id: 'perm-star', role: 'user', permissions: ['*:*'], perms: [] }
    const widened = await getMembers()
    expect(widened.status).toBe(403)
    expect(widened.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(state.query).not.toHaveBeenCalled()
  })

  it('serves a legacy platform claim and a live administrator, including members from two organizations', async () => {
    const roster = membersOf(
      { id: 'org-a-user', displayName: '甲', email: 'a@example.test' },
      { id: 'org-b-user', displayName: '乙', email: 'b@example.test' },
      { id: 'inactive-user', displayName: '停用账号' },
    )
    state.query.mockResolvedValue(snapshot({ total: 3, items: roster }))

    state.user = { id: 'legacy-admin', role: 'admin', perms: [] }
    const legacy = await getMembers()
    expect(legacy.status).toBe(200)
    expect(state.isAdmin).not.toHaveBeenCalled()

    state.isAdmin.mockClear()
    state.query.mockClear()
    state.user = { id: 'rbac-admin', role: 'user', perms: ['roles:read'] }
    state.isAdmin.mockResolvedValue(true)
    const live = await getMembers('attendance_admin ', { page: '2', pageSize: '1000' })
    expect(live.status).toBe(200)
    expect(live.body).toEqual({
      ok: true,
      data: {
        items: [
          { id: 'org-a-user', displayName: '甲' },
          { id: 'org-b-user', displayName: '乙' },
          { id: 'inactive-user', displayName: '停用账号' },
        ],
        page: 2,
        pageSize: 100,
        total: 3,
      },
    })
    expect(JSON.stringify(live.body)).not.toContain('example.test')
    expect(state.isAdmin).toHaveBeenCalledTimes(1)
    expect(state.query).toHaveBeenCalledTimes(1)
    const [sql, params] = state.query.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['attendance_admin ', 100, 100])
    expect(sql).toContain('user_roles')
    expect(sql).toContain('LIMIT $2 OFFSET $3')
    expect(sql).not.toContain('INSERT')
    expect(sql).not.toContain('UPDATE')
    expect(sql).not.toContain('DELETE')
    for (const token of ['org_id', 'user_orgs', 'is_active', 'activation_status', 'password', 'email', 'mobile']) {
      expect(sql.toLowerCase()).not.toContain(token)
    }
  })

  it('keeps the real total for an empty role and for an out-of-range page', async () => {
    state.user = { id: 'star-admin', role: 'user', perms: ['*:*'] }
    state.query.mockResolvedValue(snapshot({ total: 0, items: [] }))
    const empty = await getMembers()
    expect(empty.status).toBe(200)
    expect(empty.body.data).toEqual({ items: [], page: 1, pageSize: 20, total: 0 })
    expect(state.query.mock.calls[0][1]).toEqual(['attendance_admin', 20, 0])

    state.query.mockResolvedValue(snapshot({ total: 25, items: [] }))
    const outOfRange = await getMembers('attendance_admin', { page: 3, pageSize: 20 })
    expect(outOfRange.status).toBe(200)
    expect(outOfRange.body.data).toEqual({ items: [], page: 3, pageSize: 20, total: 25 })
    expect(state.query.mock.calls[1][1]).toEqual(['attendance_admin', 20, 40])

    const invalidPage = await getMembers('attendance_admin', { page: 'foo', pageSize: 0 })
    expect(invalidPage.status).toBe(200)
    expect(state.query.mock.calls[2][1]).toEqual(['attendance_admin', 1, 0])
  })

  it('returns 404 for a missing role and 503 when the snapshot cannot be read', async () => {
    state.query.mockResolvedValue(snapshot({ role_exists: false, total: 0, items: [] }))
    const missing = await getMembers('missing-role')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ ok: false, error: { code: 'ROLE_NOT_FOUND', message: 'Role not found' } })
    expect(missing.body.data).toBeUndefined()

    state.query.mockRejectedValue(new Error('connection refused'))
    const broken = await getMembers()
    expect(broken.status).toBe(503)
    expect(broken.body.ok).toBe(false)
    expect(broken.body.error.code).toBe('ROLE_MEMBERS_UNAVAILABLE')
    expect(broken.body.data).toBeUndefined()

    state.query.mockResolvedValue({ rows: [] })
    const noRow = await getMembers()
    expect(noRow.status).toBe(503)
    expect(noRow.body.data).toBeUndefined()

    state.query.mockResolvedValue(snapshot({ total: 0, items: [{ id: 'u1', displayName: '甲' }] }))
    const inconsistent = await getMembers()
    expect(inconsistent.status).toBe(503)

    state.user = { id: 'rbac-admin', role: 'user' }
    state.isAdmin.mockRejectedValue(new Error('user_roles unavailable'))
    state.query.mockClear()
    const guardDown = await getMembers()
    expect(guardDown.status).toBe(503)
    expect(state.query).not.toHaveBeenCalled()
  })
})
