import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  resetAttendanceSettingsCacheForTests: () => void
}

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
}

async function createHarness() {
  process.env.RBAC_BYPASS = 'true'
  helpers.resetAttendanceSettingsCacheForTests()

  const routes = new Map<string, RouteHandler>()
  let stored: Record<string, unknown> | null = null
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes('SELECT value FROM system_configs')) {
        return stored ? [{ value: JSON.stringify(stored) }] : []
      }
      if (String(sql).includes('INSERT INTO system_configs')) {
        stored = JSON.parse(String(params[1]))
        return []
      }
      throw new Error(`unexpected sql: ${sql}`)
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
      user: 'user' in options ? options.user : { id: 'employee-1', orgId: 'org-1' },
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
  it('PUT illegal icon enum is 400 at the route and does not persist', async () => {
    const { db, routes, getStored } = await createHarness()
    const res = await invokeRoute(routes, 'PUT /api/attendance/settings', {
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
    expect(db.query).not.toHaveBeenCalled()
  })

  it('admin PUT legal keys then employee GET returns only those four icon keys', async () => {
    const { routes } = await createHarness()
    const saved = {
      makeup: 'plus',
      leave: 'briefcase',
      overtime: 'user',
      swap: 'pin',
    }

    const putRes = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      body: { employeeQuickActionIcons: saved },
    })
    expect(putRes.statusCode).toBe(200)
    expect((putRes.body as { data?: { employeeQuickActionIcons?: unknown } }).data?.employeeQuickActionIcons).toEqual(saved)

    const getRes = await invokeRoute(routes, 'GET /api/attendance/employee-quick-action-icons')
    expect(getRes.statusCode).toBe(200)
    const payload = getRes.body as { ok: boolean; data: Record<string, unknown> }
    expect(payload.ok).toBe(true)
    expect(payload.data).toEqual(saved)
    expect(Object.keys(payload.data).sort()).toEqual(['leave', 'makeup', 'overtime', 'swap'])
    expect(payload.data).not.toHaveProperty('ipAllowlist')
    expect(payload.data).not.toHaveProperty('geoFence')
    expect(payload.data).not.toHaveProperty('autoAbsence')
  })

  it('employee icon GET stays registered beside admin-gated settings GET', async () => {
    const { routes } = await createHarness()
    expect(routes.has('GET /api/attendance/settings')).toBe(true)
    expect(routes.has('PUT /api/attendance/settings')).toBe(true)
    expect(routes.has('GET /api/attendance/employee-quick-action-icons')).toBe(true)
  })
})
