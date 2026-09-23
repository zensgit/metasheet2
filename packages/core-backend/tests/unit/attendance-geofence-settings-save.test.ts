import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  resetAttendanceSettingsCacheForTests: () => void
}

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS
const ADMIN = { id: 'admin-1', orgId: 'org-1' }
const FENCE = { lat: 31.2, lng: 121.5, radiusMeters: 200 }

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

function rbacRows(sql: string, params: unknown[]) {
  if (sql.includes('FROM user_roles') && sql.includes('role_id = $2')) return [{ ok: 1 }]
  if (sql.includes('FROM user_permissions')) {
    return String(params[1]) === 'attendance:admin' ? [{ ok: 1 }] : []
  }
  if (sql.includes('JOIN role_permissions')) return []
  return null
}

async function createHarness(initial: Record<string, unknown> | null = null) {
  process.env.RBAC_BYPASS = 'false'
  helpers.resetAttendanceSettingsCacheForTests()
  const routes = new Map<string, RouteHandler>()
  let stored: Record<string, unknown> | null = initial
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      const rbac = rbacRows(text, params)
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
        createRequestOperationBoundary: () => ({ execute: async () => ({ kind: 'legacy', response: {} }) }),
      },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })

  return {
    routes,
    getStored: () => stored,
  }
}

async function putSettings(routes: Map<string, RouteHandler>, body: unknown) {
  const handler = routes.get('PUT /api/attendance/settings')
  expect(handler).toBeTypeOf('function')
  const res = createResponse()
  await handler?.({
    params: {},
    body,
    query: {},
    headers: {},
    user: ADMIN,
    ip: '127.0.0.1',
    get: vi.fn(() => undefined),
  }, res, vi.fn())
  return res
}

afterEach(async () => {
  if (originalRbacBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalRbacBypass
  helpers.resetAttendanceSettingsCacheForTests()
  await attendancePlugin.deactivate()
  vi.restoreAllMocks()
})

describe('attendance geofence settings save (#5965)', () => {
  it('rejects an incomplete geofence object and keeps the stored fence', async () => {
    const { routes, getStored } = await createHarness({ geoFence: FENCE, ipAllowlist: ['10.0.0.1'] })

    const res = await putSettings(routes, { geoFence: { lat: 31.2 }, ipAllowlist: ['10.0.0.2'] })

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(getStored()).toMatchObject({ geoFence: FENCE, ipAllowlist: ['10.0.0.1'] })
  })

  it('rejects a non-positive radius without replacing the stored fence', async () => {
    const { routes, getStored } = await createHarness({ geoFence: FENCE })

    const res = await putSettings(routes, { geoFence: { lat: 1, lng: 2, radiusMeters: 0 } })

    expect(res.statusCode).toBe(400)
    expect(getStored()?.geoFence).toEqual(FENCE)
  })

  it('keeps the stored fence when the payload omits geoFence', async () => {
    const { routes, getStored } = await createHarness({ geoFence: FENCE, ipAllowlist: [] })

    const res = await putSettings(routes, { ipAllowlist: ['10.0.0.8'] })

    expect(res.statusCode).toBe(200)
    expect(getStored()?.geoFence).toEqual(FENCE)
    expect(getStored()?.ipAllowlist).toEqual(['10.0.0.8'])
  })

  it('clears the fence only on an explicit null', async () => {
    const { routes, getStored } = await createHarness({ geoFence: FENCE })

    const res = await putSettings(routes, { geoFence: null })

    expect(res.statusCode).toBe(200)
    expect(getStored()?.geoFence).toBeNull()
  })
})
