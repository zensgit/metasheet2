import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  resetAttendanceSettingsCacheForTests: () => void
}

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS

const EMPLOYEE = { id: 'employee-1', orgId: 'org-1' }
const ADMIN = { id: 'admin-1', orgId: 'org-1' }
const STRANGER = { id: 'stranger-1', orgId: 'org-1' }

const LEGAL_ICONS = {
  makeup: 'plus',
  leave: 'briefcase',
  overtime: 'user',
  swap: 'pin',
} as const

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      this.headersSent = true
      return this
    },
  }
}

function rbacRows(sql: string, params: unknown[], grants: Map<string, string[]>) {
  const userId = String(params[0] ?? '')
  const granted = grants.get(userId) ?? []
  if (sql.includes('FROM user_roles') && sql.includes('role_id = $2')) {
    return granted.includes('role:admin') ? [{ ok: 1 }] : []
  }
  if (sql.includes('FROM user_permissions')) {
    return granted.includes(String(params[1])) ? [{ ok: 1 }] : []
  }
  if (sql.includes('JOIN role_permissions')) return []
  return null
}

async function createHarness() {
  process.env.RBAC_BYPASS = 'false'
  helpers.resetAttendanceSettingsCacheForTests()

  const routes = new Map<string, RouteHandler>()
  let stored: Record<string, unknown> | null = null
  const grants = new Map<string, string[]>([
    [EMPLOYEE.id, ['attendance:read']],
    [ADMIN.id, ['attendance:admin']],
    [STRANGER.id, []],
  ])
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      const rbac = rbacRows(text, params, grants)
      if (rbac !== null) return rbac
      if (text.includes('SELECT value FROM system_configs')) {
        return stored ? [{ value: JSON.stringify(stored) }] : []
      }
      if (text.includes('INSERT INTO system_configs')) {
        stored = JSON.parse(String(params[1]))
        return []
      }
      throw new Error(`unexpected sql: ${text}`)
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
    services: {
      attendanceW4SegmentCalculation: {
        resolveOrgSegmentCalculationPosture: async () => ({
          effectiveState: 'legacy',
          referenceSegments: false,
        }),
        createRequestOperationBoundary: ({ adapters }: { adapters: Record<string, any> }) => ({
          execute: async (input: Record<string, any>) => db.transaction(async (trx: any) => {
            const operation = {
              operationId: input.operationId ?? null,
              correlationId: input.correlationId,
              acceptedWritePosture: 'legacy_projection_only',
              referenceSegments: false,
              routeVariant: input.routeVariant ?? null,
            }
            const adapter = adapters[input.kind]
            const prepared = await adapter.prepare(trx, input.routeInput, operation)
            const result = await adapter.execute(trx, prepared, operation)
            return { kind: 'legacy', response: result.response }
          }),
        }),
      },
    },
    logger,
  })

  db.query.mockClear()
  db.transaction.mockClear()

  return { db, routes, getStored: () => stored }
}

async function invokeRoute(
  routes: Map<string, RouteHandler>,
  key: string,
  options: { body?: unknown; user?: Record<string, unknown> | null } = {},
) {
  const handler = routes.get(key)
  expect(handler, key).toBeTypeOf('function')
  const res = createResponse()
  await handler?.(
    {
      params: {},
      body: options.body ?? {},
      query: {},
      headers: {},
      user: 'user' in options ? options.user : EMPLOYEE,
      ip: '127.0.0.1',
      get: vi.fn(() => undefined),
    },
    res,
    vi.fn(),
  )
  return res
}

afterEach(async () => {
  if (originalRbacBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalRbacBypass
  helpers.resetAttendanceSettingsCacheForTests()
  await attendancePlugin.deactivate()
  vi.restoreAllMocks()
})

describe('employeeQuickActionIcons routes (P1-1 / P1-2)', () => {
  it('registers the employee GET beside admin-gated settings GET/PUT', async () => {
    const { routes } = await createHarness()
    expect(routes.has('GET /api/attendance/settings')).toBe(true)
    expect(routes.has('PUT /api/attendance/settings')).toBe(true)
    expect(routes.has('GET /api/attendance/employee-quick-action-icons')).toBe(true)
  })

  it('attendance:read employee GET returns only the persisted four icon keys', async () => {
    const { routes } = await createHarness()
    const putRes = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      user: ADMIN,
      body: { employeeQuickActionIcons: LEGAL_ICONS },
    })
    expect(putRes.statusCode).toBe(200)
    expect(
      (putRes.body as { data?: { employeeQuickActionIcons?: unknown } }).data?.employeeQuickActionIcons,
    ).toEqual(LEGAL_ICONS)

    const getRes = await invokeRoute(routes, 'GET /api/attendance/employee-quick-action-icons', {
      user: EMPLOYEE,
    })
    expect(getRes.statusCode).toBe(200)
    const payload = getRes.body as { ok: boolean; data: Record<string, unknown> }
    expect(payload).toEqual({ ok: true, data: LEGAL_ICONS })
    expect(Object.keys(payload.data).sort()).toEqual(['leave', 'makeup', 'overtime', 'swap'])
    expect(payload.data).not.toHaveProperty('ipAllowlist')
    expect(payload.data).not.toHaveProperty('geoFence')
    expect(payload.data).not.toHaveProperty('autoAbsence')
  })

  it('enforces employee-read and admin-settings permissions without RBAC bypass', async () => {
    const { routes } = await createHarness()

    const adminSettings = await invokeRoute(routes, 'GET /api/attendance/settings', { user: EMPLOYEE })
    expect(adminSettings.statusCode).toBe(403)
    expect(adminSettings.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    const forbidden = await invokeRoute(routes, 'GET /api/attendance/employee-quick-action-icons', {
      user: STRANGER,
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    const unauthenticated = await invokeRoute(routes, 'GET /api/attendance/employee-quick-action-icons', {
      user: null,
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
  })

  it('PUT illegal icon enum is 400 at the route and does not persist', async () => {
    const { db, routes, getStored } = await createHarness()
    const res = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      user: ADMIN,
      body: {
        employeeQuickActionIcons: {
          makeup: 'not-an-icon',
          leave: 'calendar',
          overtime: 'moon',
          swap: 'swap',
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(getStored()).toBeNull()
    expect(db.query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('INSERT INTO system_configs')
  })

  it('PUT extra icon key is 400 at the route and does not persist', async () => {
    const { db, routes, getStored } = await createHarness()
    const res = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      user: ADMIN,
      body: {
        employeeQuickActionIcons: {
          ...LEGAL_ICONS,
          extra: 'pin',
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(getStored()).toBeNull()
    expect(db.query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('INSERT INTO system_configs')
  })
})
