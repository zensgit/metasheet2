import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import type { Request, Response, Router } from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  client: undefined as PoolClient | undefined,
  actorId: '',
  statements: [] as Array<{ sql: string; params?: unknown[] }>,
}))
vi.mock('../../src/db/pg', () => ({
  query: io.query,
  transaction: io.transaction,
  pool: { query: io.query },
}))
vi.mock('../../src/integration/db/connection-pool', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/integration/db/connection-pool')>(),
  poolManager: { get: () => ({
    query: io.query,
    transaction: io.transaction,
    getInternalPool: () => ({ connect: async () => { throw new Error('UNEXPECTED_TEMPLATE_QUERY_OUTSIDE_SEAM') } }),
  }) },
}))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async (userId: string) => userId === io.actorId),
  listUserPermissions: vi.fn(async () => [] as string[]),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(async () => false),
}))
vi.mock('../../src/services/AttendanceScheduler', () => ({
  getSharedAttendanceScheduler: vi.fn(() => null),
}))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

import { ATTENDANCE_ROLE_TEMPLATES, attendanceAdminRouter } from '../../src/routes/attendance-admin'

const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (attendance template runtime)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const templateRoleIds = ['attendance_admin', 'attendance_approver', 'attendance_employee', 'attendance_importer']
const templateMappings = [
  ['attendance_admin', 'attendance:admin'],
  ['attendance_admin', 'attendance:approve'],
  ['attendance_admin', 'attendance:import'],
  ['attendance_admin', 'attendance:read'],
  ['attendance_admin', 'attendance:write'],
  ['attendance_approver', 'attendance:approve'],
  ['attendance_approver', 'attendance:read'],
  ['attendance_employee', 'attendance:read'],
  ['attendance_employee', 'attendance:write'],
  ['attendance_importer', 'attendance:import'],
  ['attendance_importer', 'attendance:read'],
]

async function readSeeds(client: PoolClient) {
  return {
    roles: (await client.query('SELECT * FROM roles ORDER BY id')).rows,
    permissions: (await client.query('SELECT * FROM permissions ORDER BY code')).rows,
    mappings: (await client.query('SELECT * FROM role_permissions ORDER BY role_id, permission_code')).rows,
  }
}

function mockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  return response as Response & { body: unknown; statusCode: number }
}

function invokeHandler(router: Router, method: 'get' | 'post', routePath: string, request: Partial<Request>, response: Response) {
  const layer = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (error?: unknown) => void) => unknown }> } }>
  }).stack.find(entry => entry.route?.path === routePath && entry.route.methods[method])
  if (!layer?.route) throw new Error('Expected registered attendance handler')
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const req = { method: method.toUpperCase(), headers: {}, query: {}, params: {}, body: {}, user: { id: io.actorId }, ...request } as unknown as Request
  return Promise.resolve(handler(req, response, error => { if (error) throw error }))
}

describeIfDatabase('attendance template runtime handlers (real PostgreSQL, rollback isolated)', () => {
  let pool: PgPool

  beforeAll(() => {
    pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 1 })
    io.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (!io.client) throw new Error('Attendance test query outside its case transaction')
      io.statements.push({ sql, params })
      return io.client.query(sql, params)
    })
    io.transaction.mockImplementation(async (handler: (client: { query: typeof io.query }) => Promise<unknown>) => {
      const client = io.client
      if (!client) throw new Error('Attendance test transaction outside its case')
      await client.query('SAVEPOINT attendance_template_route')
      try {
        const result = await handler({ query: io.query })
        await client.query('RELEASE SAVEPOINT attendance_template_route')
        return result
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT attendance_template_route')
        await client.query('RELEASE SAVEPOINT attendance_template_route')
        throw error
      }
    })
  })

  afterAll(async () => {
    if (pool) await pool.end()
  })

  async function inCase(work: (client: PoolClient, targets: string[], seeds: Awaited<ReturnType<typeof readSeeds>>) => Promise<void>) {
    const client = await pool.connect()
    const actorId = randomUUID()
    const targets = [randomUUID(), randomUUID()].sort().reverse()
    const fixtureIds = [actorId, ...targets]
    let baseline: Awaited<ReturnType<typeof readSeeds>> | undefined
    try {
      baseline = await readSeeds(client)
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query("SET LOCAL lock_timeout = '3s'")
      expect(baseline.roles.filter(row => templateRoleIds.includes(row.id)).map(row => row.id)).toEqual(templateRoleIds)
      expect(baseline.permissions.filter(row => String(row.code).startsWith('attendance:')).map(row => row.code))
        .toEqual(['attendance:admin', 'attendance:approve', 'attendance:import', 'attendance:read', 'attendance:write'])
      expect(baseline.mappings.filter(row => templateRoleIds.includes(row.role_id)).map(row => [row.role_id, row.permission_code]))
        .toEqual(templateMappings)
      expect(baseline.roles.filter(row => row.id === 'admin').map(row => row.id)).toEqual(['admin'])
      for (const userId of fixtureIds) {
        await client.query(
          `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
           VALUES ($1, $2, $3, 'Synthetic template fixture', 'synthetic-unused', true, $4, $5, '[]'::jsonb, 'activated', false)`,
          [userId, `p1bt-${userId}`, `p1bt-${userId}@example.invalid`, userId === actorId, userId === actorId ? 'admin' : 'user'],
        )
      }
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [actorId, 'admin'])
      const removed = await client.query(
        'DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2 RETURNING role_id, permission_code',
        ['attendance_employee', 'attendance:write'],
      )
      expect(removed.rows).toEqual([{ role_id: 'attendance_employee', permission_code: 'attendance:write' }])
      expect((await client.query('SELECT role_id, permission_code FROM role_permissions WHERE role_id = $1 AND permission_code = $2', ['attendance_employee', 'attendance:write'])).rows).toEqual([])
      io.actorId = actorId
      io.client = client
      io.statements = []
      io.query.mockClear()
      io.transaction.mockClear()
      await work(client, targets, baseline)
      expect((await client.query('SELECT role_id, permission_code FROM role_permissions WHERE role_id = $1 AND permission_code = $2', ['attendance_employee', 'attendance:write'])).rows).toEqual([])
      expect(await readSeeds(client)).toEqual({
        ...baseline,
        mappings: baseline.mappings.filter(row => !(row.role_id === 'attendance_employee' && row.permission_code === 'attendance:write')),
      })
      expect(io.statements.filter(({ sql }) => /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:permissions|role_permissions)\b/i.test(sql))).toEqual([])
    } finally {
      io.client = undefined
      io.actorId = ''
      try {
        await client.query('ROLLBACK')
        if (baseline) expect(await readSeeds(client)).toEqual(baseline)
        expect((await client.query('SELECT id FROM users WHERE id = ANY($1::text[])', [fixtureIds])).rows).toEqual([])
        expect((await client.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[])', [fixtureIds])).rows).toEqual([])
      } finally {
        client.release()
      }
    }
  }

  it('all four global role handlers preserve missing custom-parent compatibility with a declared parent lock', async () => {
    await inCase(async (client, targets) => {
      const roleId = `attendance_compat_${randomUUID().replaceAll('-', '')}`
      expect((await client.query('SELECT id FROM roles WHERE id = $1', [roleId])).rows).toEqual([])
      const fullProfile = (await client.query(
        'SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at FROM users WHERE id = $1',
        [targets[0]],
      )).rows[0]
      const profiles = (await client.query(
        'SELECT id, email, name, employee_no AS "employeeNo", department, is_active FROM users WHERE id = ANY($1::text[])',
        [targets],
      )).rows
      const orderedProfiles = targets.map(userId => profiles.find(profile => profile.id === userId))
      const parentSequences: string[][] = []
      for (const [action, batch] of [['assign', false], ['assign', true], ['unassign', false], ['unassign', true]] as const) {
        const start = io.statements.length
        const response = mockResponse()
        await invokeHandler(attendanceAdminRouter(), 'post', batch
          ? `/api/attendance-admin/users/batch/roles/${action}`
          : `/api/attendance-admin/users/:userId/roles/${action}`, {
          params: batch ? {} : { userId: targets[0] },
          body: { roleId, scope: 'global', ...(batch ? { userIds: targets } : {}) },
        }, response)
        expect(response.statusCode).toBe(200)
        expect(response.body).toEqual({
          ok: true,
          data: batch ? {
            roleId, requested: 2, eligible: 2, updated: 1,
            affectedUserIds: [targets[1]], affectedUserIdsTruncated: false,
            unchangedUserIds: [targets[0]], unchangedUserIdsTruncated: false,
            missingUserIds: [], inactiveUserIds: [], items: orderedProfiles,
          } : { user: fullProfile, roles: action === 'assign' ? [roleId] : [], permissions: [], isAdmin: false },
          meta: undefined,
        })
        expect((await client.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[]) AND role_id = $2 ORDER BY user_id', [targets, roleId])).rows)
          .toEqual((action === 'assign' ? batch ? [...targets].sort() : [targets[0]] : batch ? [] : [targets[1]])
            .map(user_id => ({ user_id, role_id: roleId })))
        parentSequences.push(io.statements.slice(start)
          .filter(({ sql }) => /FROM roles .*FOR SHARE/.test(sql.replace(/\s+/g, ' ')))
          .map(({ params }) => String(params?.[0])))
      }
      expect((await client.query('SELECT id FROM roles WHERE id = $1', [roleId])).rows).toEqual([])
      expect(parentSequences).toEqual([
        [...templateRoleIds, roleId].sort(), [...templateRoleIds, roleId].sort(), [roleId], [roleId],
      ])
    })
  })

  it('GET succeeds without SQL and leaves the deleted mapping absent', async () => {
    await inCase(async (client) => {
      const response = mockResponse()
      await invokeHandler(attendanceAdminRouter(), 'get', '/api/attendance-admin/role-templates', {}, response)
      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual({ ok: true, data: { templates: Object.values(ATTENDANCE_ROLE_TEMPLATES) }, meta: undefined })
      expect((await client.query('SELECT role_id, permission_code FROM role_permissions WHERE role_id = $1 AND permission_code = $2', ['attendance_employee', 'attendance:write'])).rows).toEqual([])
      expect(io.statements).toEqual([])
      expect(io.transaction).not.toHaveBeenCalled()
    })
  })

  it('single assign persists the exact membership without restoring the deleted mapping', async () => {
    await inCase(async (client, targets) => {
      const userId = targets[0]
      const profile = await client.query(
        `SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at FROM users WHERE id = $1`,
        [userId],
      )
      const response = mockResponse()
      await invokeHandler(attendanceAdminRouter(), 'post', '/api/attendance-admin/users/:userId/roles/assign', {
        params: { userId }, body: { template: 'employee', scope: 'global' },
      }, response)
      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual({ ok: true, data: { user: profile.rows[0], roles: ['attendance_employee'], permissions: [], isAdmin: false }, meta: undefined })
      expect((await client.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[]) ORDER BY user_id, role_id', [targets])).rows)
        .toEqual([{ user_id: userId, role_id: 'attendance_employee' }])
      expect(io.transaction).toHaveBeenCalledTimes(1)
    })
  })

  it('batch assign persists two distinct memberships without restoring the deleted mapping', async () => {
    await inCase(async (client, targets) => {
      expect(new Set(targets).size).toBe(2)
      const items = await client.query(
        `SELECT id, email, name, employee_no AS "employeeNo", department, is_active FROM users WHERE id = ANY($1::text[])`,
        [targets],
      )
      const response = mockResponse()
      await invokeHandler(attendanceAdminRouter(), 'post', '/api/attendance-admin/users/batch/roles/assign', {
        body: { userIds: targets, template: 'employee', scope: 'global' },
      }, response)
      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual({
        ok: true,
        data: {
          roleId: 'attendance_employee', requested: 2, eligible: 2, updated: 2,
          affectedUserIds: targets, affectedUserIdsTruncated: false,
          unchangedUserIds: [], unchangedUserIdsTruncated: false, missingUserIds: [], inactiveUserIds: [],
          items: targets.map(userId => items.rows.find(row => row.id === userId)),
        },
        meta: undefined,
      })
      expect((await client.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[]) ORDER BY user_id, role_id', [targets])).rows)
        .toEqual([...targets].sort().map(userId => ({ user_id: userId, role_id: 'attendance_employee' })))
      expect(io.transaction).toHaveBeenCalledTimes(1)
    })
  })
})
