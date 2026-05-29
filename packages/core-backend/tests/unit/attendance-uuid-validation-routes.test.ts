import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS
const originalAsyncEnabled = process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      this.headersSent = true
      return this
    },
    send(body: unknown) {
      this.body = body
      this.headersSent = true
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value
      return this
    },
  }
}

async function createHarness(rbacBypass = 'true') {
  process.env.RBAC_BYPASS = rbacBypass
  process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'

  const routes = new Map<string, RouteHandler>()
  const db = {
    query: vi.fn(async () => {
      throw new Error('db disabled in unit harness')
    }),
    transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(db)),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  await attendancePlugin.activate({
    api: {
      database: db,
      events: { emit: vi.fn() },
      http: {
        addRoute(method: string, path: string, handler: RouteHandler) {
          routes.set(`${method.toUpperCase()} ${path}`, handler)
        },
      },
    },
    logger,
  })

  db.query.mockClear()
  db.transaction.mockClear()

  return { db, logger, routes }
}

async function invokeRoute(
  routes: Map<string, RouteHandler>,
  key: string,
  options: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {},
) {
  const handler = routes.get(key)
  expect(handler, key).toBeTypeOf('function')
  const res = createResponse()
  await handler?.(
    {
      params: options.params ?? {},
      body: options.body ?? {},
      query: options.query ?? {},
      headers: {},
      user: { id: 'attendance-user-1', orgId: 'default' },
      ip: '127.0.0.1',
      get: vi.fn(() => undefined),
    },
    res,
    vi.fn(),
  )
  return res
}

afterEach(async () => {
  restoreEnv('RBAC_BYPASS', originalRbacBypass)
  restoreEnv('ATTENDANCE_IMPORT_ASYNC_ENABLED', originalAsyncEnabled)
  await attendancePlugin.deactivate()
  vi.restoreAllMocks()
})

describe('attendance UUID route validation', () => {
  it('returns attendance group member counts on list and lookup routes', async () => {
    const { db, routes } = await createHarness()
    const groupId = '00000000-0000-4000-8000-000000000101'
    const groupRow = {
      id: groupId,
      org_id: 'default',
      name: 'Ops Team',
      code: 'ops-team',
      timezone: 'UTC',
      rule_set_id: null,
      description: 'unit-test',
      attendance_type: 'fixed_shift',
      member_count: 3,
      created_at: '2026-05-29T20:00:00.000Z',
      updated_at: '2026-05-29T20:00:00.000Z',
    }

    db.query
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([groupRow])

    const listRes = await invokeRoute(routes, 'GET /api/attendance/groups')

    expect(listRes.statusCode).toBe(200)
    expect(listRes.body).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: groupId,
            memberCount: 3,
            member_count: 3,
          },
        ],
        total: 1,
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_group_members'),
      ['default', 50, 0],
    )

    db.query.mockClear()
    db.query.mockResolvedValueOnce([{ ...groupRow, member_count: 4 }])

    const lookupRes = await invokeRoute(routes, 'GET /api/attendance/groups/:id', {
      params: { id: groupId },
    })

    expect(lookupRes.statusCode).toBe(200)
    expect(lookupRes.body).toMatchObject({
      ok: true,
      data: {
        id: groupId,
        memberCount: 4,
        member_count: 4,
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_group_members'),
      [groupId, 'default'],
    )
  })

  it('persists attendance group type on create and rejects type changes on update', async () => {
    const { db, routes } = await createHarness()
    const groupId = '00000000-0000-4000-8000-000000000101'
    const createdAt = '2026-05-29T20:00:00.000Z'
    const groupRow = {
      id: groupId,
      org_id: 'default',
      name: 'Ops Team',
      code: 'ops-team',
      timezone: 'UTC',
      rule_set_id: null,
      description: 'unit-test',
      attendance_type: 'scheduled_shift',
      created_at: createdAt,
      updated_at: createdAt,
    }

    db.query.mockResolvedValueOnce([groupRow])

    const createRes = await invokeRoute(routes, 'POST /api/attendance/groups', {
      body: {
        name: 'Ops Team',
        code: 'ops-team',
        timezone: 'UTC',
        attendanceType: 'scheduled-shift',
        description: 'unit-test',
      },
    })

    expect(createRes.statusCode).toBe(200)
    expect(createRes.body).toMatchObject({
      ok: true,
      data: {
        id: groupId,
        attendanceType: 'scheduled_shift',
        attendance_type: 'scheduled_shift',
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_type'),
      expect.arrayContaining(['scheduled_shift']),
    )

    db.query.mockClear()
    db.query.mockResolvedValueOnce([
      {
        ...groupRow,
        attendance_type: 'fixed_shift',
      },
    ])

    const updateRes = await invokeRoute(routes, 'PUT /api/attendance/groups/:id', {
      params: { id: groupId },
      body: {
        name: 'Ops Team',
        code: 'ops-team',
        timezone: 'UTC',
        attendanceType: 'free_time',
        description: 'unit-test',
      },
    })

    expect(updateRes.statusCode).toBe(409)
    expect(updateRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'ATTENDANCE_GROUP_TYPE_LOCKED',
      },
    })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM attendance_groups'),
      [groupId, 'default'],
    )
  })

  it('manages attendance group owners separately from attendance members', async () => {
    const { db, routes } = await createHarness()
    const groupId = '00000000-0000-4000-8000-000000000101'
    const managerId = '00000000-0000-4000-8000-000000000201'
    const createdAt = '2026-05-29T22:00:00.000Z'
    const managerRow = {
      id: managerId,
      org_id: 'default',
      group_id: groupId,
      user_id: 'owner-user-1',
      role: 'owner',
      created_by: 'attendance-user-1',
      created_at: createdAt,
      updated_at: createdAt,
    }

    db.query
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([managerRow])

    const listRes = await invokeRoute(routes, 'GET /api/attendance/groups/:id/managers', {
      params: { id: groupId },
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.body).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: managerId,
            groupId,
            userId: 'owner-user-1',
            role: 'owner',
            createdBy: 'attendance-user-1',
          },
        ],
        total: 1,
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_group_managers'),
      ['default', groupId, 50, 0],
    )
    expect(db.query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('attendance_group_members')

    db.query.mockClear()
    db.query.mockResolvedValueOnce([{ ...managerRow, role: 'sub_owner' }])

    const createRes = await invokeRoute(routes, 'POST /api/attendance/groups/:id/managers', {
      params: { id: groupId },
      body: {
        userId: 'owner-user-1',
        role: 'sub-owner',
      },
    })

    expect(createRes.statusCode).toBe(200)
    expect(createRes.body).toMatchObject({
      ok: true,
      data: {
        id: managerId,
        groupId,
        userId: 'owner-user-1',
        role: 'sub_owner',
        createdBy: 'attendance-user-1',
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_group_managers'),
      ['default', groupId, 'owner-user-1', 'sub_owner', 'attendance-user-1'],
    )

    db.query.mockClear()
    db.query.mockResolvedValueOnce([{ id: managerId }])

    const deleteRes = await invokeRoute(routes, 'DELETE /api/attendance/groups/:id/managers/:managerId', {
      params: { id: groupId, managerId },
    })

    expect(deleteRes.statusCode).toBe(200)
    expect(deleteRes.body).toMatchObject({
      ok: true,
      data: {
        id: managerId,
      },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('attendance_group_managers'),
      [managerId, 'default', groupId],
    )
  })

  it('rejects invalid attendance group manager roles before writing', async () => {
    const { db, routes } = await createHarness()
    const groupId = '00000000-0000-4000-8000-000000000101'

    const res = await invokeRoute(routes, 'POST /api/attendance/groups/:id/managers', {
      params: { id: groupId },
      body: {
        userId: 'owner-user-1',
        role: 'manager',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'role must be owner or sub_owner',
      },
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects malformed route UUID params before hitting the database', async () => {
    const { db, routes } = await createHarness()
    const cases = [
      { key: 'GET /api/attendance/requests/:id' },
      { key: 'PUT /api/attendance/requests/:id' },
      { key: 'POST /api/attendance/requests/:id/approve' },
      { key: 'POST /api/attendance/requests/:id/reject' },
      { key: 'POST /api/attendance/requests/:id/cancel' },
      { key: 'DELETE /api/attendance/requests/:id' },
      { key: 'PUT /api/attendance/integrations/:id' },
      { key: 'DELETE /api/attendance/integrations/:id' },
      { key: 'GET /api/attendance/integrations/:id/runs' },
      { key: 'POST /api/attendance/integrations/:id/sync' },
      { key: 'GET /api/attendance/import/batches/:id' },
      { key: 'GET /api/attendance/import/batches/:id/items' },
      { key: 'GET /api/attendance/import/batches/:id/export.csv' },
      { key: 'POST /api/attendance/import/rollback/:id' },
      { key: 'DELETE /api/attendance/payroll-cycles/:id' },
      { key: 'GET /api/attendance/payroll-cycles/:id/summary' },
      { key: 'GET /api/attendance/payroll-cycles/:id/summary/export' },
      { key: 'GET /api/attendance/payroll-cycles/:id/export' },
      { key: 'GET /api/attendance/groups/:id/managers' },
      {
        key: 'POST /api/attendance/groups/:id/managers',
        body: {
          userId: 'owner-user-1',
          role: 'owner',
        },
      },
      {
        key: 'DELETE /api/attendance/groups/:id/managers/:managerId',
        params: {
          id: 'not-a-uuid',
          managerId: '00000000-0000-4000-8000-000000000201',
        },
      },
      {
        key: 'POST /api/attendance/groups/:id/fixed-schedule/preview',
        body: {
          shiftId: '00000000-0000-4000-8000-000000000001',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      {
        key: 'POST /api/attendance/groups/:id/fixed-schedule/apply',
        body: {
          shiftId: '00000000-0000-4000-8000-000000000001',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      {
        key: 'POST /api/attendance/groups/:id/fixed-schedule/rebuild',
        body: {
          shiftId: '00000000-0000-4000-8000-000000000001',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      {
        key: 'POST /api/attendance/groups/:id/fixed-schedule/clear',
        body: {
          shiftId: '00000000-0000-4000-8000-000000000001',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      { key: 'GET /api/attendance/holidays/:id' },
      { key: 'PUT /api/attendance/holidays/:id' },
      { key: 'DELETE /api/attendance/holidays/:id' },
    ]

    for (const testCase of cases) {
      const res = await invokeRoute(routes, testCase.key, { params: { id: 'not-a-uuid' }, body: 'body' in testCase ? testCase.body : undefined })
      expect(res.statusCode, testCase.key).toBe(400)
      expect(res.body, testCase.key).toMatchObject({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'id must be a UUID',
        },
      })
    }

    expect(db.query).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('rejects malformed attendance group manager ids before hitting the database', async () => {
    const { db, routes } = await createHarness()
    const groupId = '00000000-0000-4000-8000-000000000101'

    const res = await invokeRoute(routes, 'DELETE /api/attendance/groups/:id/managers/:managerId', {
      params: {
        id: groupId,
        managerId: 'not-a-uuid',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'managerId must be a UUID',
      },
    })
    expect(db.query).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('rejects malformed attendance request reference UUIDs as validation errors', async () => {
    const { db, routes } = await createHarness()
    const workDate = '2026-05-26'
    const cases = [
      {
        field: 'leaveTypeId',
        body: {
          workDate,
          requestType: 'leave',
          leaveTypeId: 'not-a-uuid',
          minutes: 60,
        },
      },
      {
        field: 'overtimeRuleId',
        body: {
          workDate,
          requestType: 'overtime',
          overtimeRuleId: 'not-a-uuid',
          minutes: 60,
        },
      },
      {
        field: 'approvalFlowId',
        body: {
          workDate,
          requestType: 'time_correction',
          requestedInAt: '2026-05-26T09:00:00.000Z',
          approvalFlowId: 'not-a-uuid',
        },
      },
    ]

    for (const testCase of cases) {
      const res = await invokeRoute(routes, 'POST /api/attendance/requests', { body: testCase.body })
      expect(res.statusCode, testCase.field).toBe(400)
      expect(res.body, testCase.field).toMatchObject({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `${testCase.field} must be a UUID`,
          details: [{ field: testCase.field, message: 'Must be a UUID' }],
        },
      })
    }

    expect(db.query).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('does not relabel handler failures as permission check failures', async () => {
    const { db, routes } = await createHarness('false')
    const dbFailure = new Error('request lookup failed')

    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM user_roles') && params?.[1] === 'admin') return []
      if (sql.includes('FROM user_permissions') && params?.[1] === 'attendance:write') return [{ ok: 1 }]
      if (sql.includes('FROM attendance_leave_types')) throw dbFailure
      return []
    })

    const handler = routes.get('POST /api/attendance/requests')
    expect(handler).toBeTypeOf('function')
    const res = createResponse()

    await expect(handler?.(
      {
        params: {},
        body: {
          workDate: '2026-05-26',
          requestType: 'leave',
          leaveTypeId: '00000000-0000-4000-8000-000000000000',
          minutes: 60,
        },
        query: {},
        headers: {},
        user: { id: 'attendance-user-1', orgId: 'default' },
        ip: '127.0.0.1',
        get: vi.fn(() => undefined),
      },
      res,
      vi.fn(),
    )).rejects.toThrow('request lookup failed')
    expect((res.body as { error?: { message?: string } } | undefined)?.error?.message).not.toBe('Permission check failed')
  })
})
