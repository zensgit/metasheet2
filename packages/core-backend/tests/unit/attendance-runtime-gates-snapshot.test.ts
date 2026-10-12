import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveAttendanceNotificationDeliveryJob,
  startAttendanceScheduler,
  stopAttendanceScheduler,
} from '../../src/services/AttendanceScheduler'

// A1 「提示与实际状态」: GET /api/attendance/settings gains a read-only sibling `runtimeGates` that reports the
// ENV half of the two scheduled features' double gate (report-digest push, monthly annual-leave auto-accrual), so the
// admin UI can show 「已配置」 (saved org policy) next to 「当前是否可运行」 (server run switches).
//
// What this file pins (no database, no live server):
//   - the snapshot is computed with the SAME readers the features use (parseBoolean for the digest producer and the
//     accrual trigger; exact 'true' for the scheduler and the delivery worker), cross-checked against the real
//     production readers where they are side-effect free;
//   - it is values-free: symbolic gate ids + booleans, no env variable name, no value;
//   - it rides GET only: the PUT response and the persisted settings document are unchanged;
//   - permission is unchanged (attendance:admin), and nobody else gets the report.

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  resetAttendanceSettingsCacheForTests: () => void
  buildAttendanceRuntimeGateSnapshot: () => {
    reportDigest: { gatesOpen: boolean; closedGates: string[] }
    annualLeaveAccrualScheduled: { gatesOpen: boolean; closedGates: string[] }
  }
  isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled: () => boolean
}

const GATE_ENV = [
  'ATTENDANCE_REPORT_DIGEST_ENABLED',
  'ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED',
  'ATTENDANCE_SCHEDULER_ENABLED',
  'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED',
] as const

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS
const originalEnv: Record<string, string | undefined> = {}
for (const name of GATE_ENV) originalEnv[name] = process.env[name]

const EMPLOYEE = { id: 'employee-1', orgId: 'org-1' }
const ADMIN = { id: 'admin-1', orgId: 'org-1' }

function clearGateEnv() {
  for (const name of GATE_ENV) delete process.env[name]
}

beforeEach(() => {
  clearGateEnv()
})

afterEach(async () => {
  for (const name of GATE_ENV) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  if (originalRbacBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalRbacBypass
  stopAttendanceScheduler()
  helpers.resetAttendanceSettingsCacheForTests()
  await attendancePlugin.deactivate()
  vi.restoreAllMocks()
})

describe('buildAttendanceRuntimeGateSnapshot', () => {
  it('defaults both features to closed, naming every gate that is off (the env defaults are all OFF)', () => {
    const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
    expect(snapshot).toEqual({
      reportDigest: { gatesOpen: false, closedGates: ['digestProducer', 'scheduler', 'deliveryWorker'] },
      annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: ['accrualTrigger', 'scheduler'] },
    })
  })

  it('opens a feature only when EVERY one of its gates is open', () => {
    process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = 'true'
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    let snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
    expect(snapshot.reportDigest).toEqual({ gatesOpen: false, closedGates: ['deliveryWorker'] })
    process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
    expect(snapshot.reportDigest).toEqual({ gatesOpen: true, closedGates: [] })
    // the accrual trigger gate is still closed, so the accrual feature is not open just because the scheduler is
    expect(snapshot.annualLeaveAccrualScheduled).toEqual({ gatesOpen: false, closedGates: ['accrualTrigger'] })
    process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = 'true'
    expect(helpers.buildAttendanceRuntimeGateSnapshot().annualLeaveAccrualScheduled).toEqual({ gatesOpen: true, closedGates: [] })
  })

  it('reader parity: the digest producer and the accrual trigger accept parseBoolean spellings (true / 1 / yes, any case)', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', ' Yes ']) {
      process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = value
      process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = value
      const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
      expect(snapshot.reportDigest.closedGates, value).not.toContain('digestProducer')
      expect(snapshot.annualLeaveAccrualScheduled.closedGates, value).not.toContain('accrualTrigger')
      // and it agrees with the production reader for the accrual trigger
      expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled(), value).toBe(true)
    }
    for (const value of ['false', '0', 'no', '', 'enabled', 'on']) {
      process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = value
      process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = value
      const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
      expect(snapshot.reportDigest.closedGates, value).toContain('digestProducer')
      expect(snapshot.annualLeaveAccrualScheduled.closedGates, value).toContain('accrualTrigger')
      expect(helpers.isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled(), value).toBe(false)
    }
  })

  it("reader parity: the scheduler and the delivery worker open ONLY on the exact string 'true' - and the real readers agree", () => {
    for (const value of ['1', 'TRUE', 'yes', ' true', 'true ', '']) {
      process.env.ATTENDANCE_SCHEDULER_ENABLED = value
      process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = value
      const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
      expect(snapshot.reportDigest.closedGates, JSON.stringify(value)).toEqual(expect.arrayContaining(['scheduler', 'deliveryWorker']))
      expect(snapshot.annualLeaveAccrualScheduled.closedGates, JSON.stringify(value)).toContain('scheduler')
      // production readers (side-effect free on the closed side): AttendanceScheduler.ts:311 and :400
      expect(startAttendanceScheduler({ jobs: [] }), JSON.stringify(value)).toBeNull()
      expect(resolveAttendanceNotificationDeliveryJob(), JSON.stringify(value)).toBeNull()
    }
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
    expect(snapshot.reportDigest.closedGates).toEqual(['digestProducer'])
    expect(snapshot.annualLeaveAccrualScheduled.closedGates).toEqual(['accrualTrigger'])
    expect(resolveAttendanceNotificationDeliveryJob()?.name).toBe('attendance-notification-delivery')
  })

  it('is values-free: symbolic ids and booleans only - no env variable name, no value, nothing org- or channel-specific', () => {
    process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = 'true'
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    const text = JSON.stringify(helpers.buildAttendanceRuntimeGateSnapshot())
    expect(text).not.toContain('ATTENDANCE_')
    expect(text).not.toMatch(/_ENABLED/)
    const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
    for (const entry of [snapshot.reportDigest, snapshot.annualLeaveAccrualScheduled]) {
      expect(Object.keys(entry).sort()).toEqual(['closedGates', 'gatesOpen'])
      expect(typeof entry.gatesOpen).toBe('boolean')
      expect(entry.closedGates.every((id) => typeof id === 'string' && /^[a-zA-Z]+$/.test(id))).toBe(true)
    }
  })

  it('gatesOpen and closedGates are always consistent (open iff nothing is closed)', () => {
    const values = [undefined, 'true', 'false']
    for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
      const set = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      set('ATTENDANCE_REPORT_DIGEST_ENABLED', a)
      set('ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED', b)
      set('ATTENDANCE_SCHEDULER_ENABLED', c)
      set('ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED', d)
      const snapshot = helpers.buildAttendanceRuntimeGateSnapshot()
      for (const entry of [snapshot.reportDigest, snapshot.annualLeaveAccrualScheduled]) {
        expect(entry.gatesOpen).toBe(entry.closedGates.length === 0)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------

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
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

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
        resolveOrgSegmentCalculationPosture: async () => ({ effectiveState: 'legacy', referenceSegments: false }),
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
  return { routes, getStored: () => stored }
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
      get: vi.fn(() => undefined),
    },
    res,
    vi.fn(),
  )
  return res
}

describe('GET /api/attendance/settings carries `runtimeGates`; PUT and the persisted document do not', () => {
  it('GET returns the gate report beside `data`, never inside it', async () => {
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    const { routes } = await createHarness()
    const res = await invokeRoute(routes, 'GET /api/attendance/settings', { user: ADMIN })
    expect(res.statusCode).toBe(200)
    const body = res.body as { ok: boolean; data: Record<string, unknown>; runtimeGates?: unknown }
    expect(body.ok).toBe(true)
    expect(body.data).toBeTruthy()
    expect(body.data).not.toHaveProperty('runtimeGates')
    expect(body.runtimeGates).toEqual({
      reportDigest: { gatesOpen: false, closedGates: ['digestProducer', 'deliveryWorker'] },
      annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: ['accrualTrigger'] },
    })
    expect(Object.keys(body).sort()).toEqual(['data', 'ok', 'runtimeGates'])
  })

  it('the report is read at request time (env changes between two GETs show up; nothing is cached or persisted)', async () => {
    const { routes } = await createHarness()
    const first = await invokeRoute(routes, 'GET /api/attendance/settings', { user: ADMIN })
    expect((first.body as any).runtimeGates.annualLeaveAccrualScheduled.closedGates).toEqual(['accrualTrigger', 'scheduler'])
    process.env.ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED = 'true'
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    const second = await invokeRoute(routes, 'GET /api/attendance/settings', { user: ADMIN })
    expect((second.body as any).runtimeGates.annualLeaveAccrualScheduled).toEqual({ gatesOpen: true, closedGates: [] })
  })

  it('PUT stays exactly what it was: `{ ok, data }` with NO gate report, and nothing about gates is persisted', async () => {
    const { routes, getStored } = await createHarness()
    const res = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      user: ADMIN,
      body: { annualLeavePolicy: { scheduledTrigger: { enabled: true } } },
    })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual(['data', 'ok'])
    expect(res.body).not.toHaveProperty('runtimeGates')
    expect(JSON.stringify(getStored())).not.toContain('runtimeGates')
    expect(JSON.stringify(getStored())).not.toContain('gatesOpen')
  })

  it('a client cannot smuggle a gate report into the persisted settings document through PUT (unknown top-level keys are dropped)', async () => {
    const { routes, getStored } = await createHarness()
    const res = await invokeRoute(routes, 'PUT /api/attendance/settings', {
      user: ADMIN,
      body: { runtimeGates: { reportDigest: { gatesOpen: true, closedGates: [] } } },
    })
    // the existing schema strips unknown top-level keys (200, nothing from the client survives); either way the
    // document that gets persisted and the `data` echoed back never carry a gate report
    expect([200, 400]).toContain(res.statusCode)
    expect(JSON.stringify(getStored() ?? {})).not.toContain('runtimeGates')
    expect(JSON.stringify(getStored() ?? {})).not.toContain('gatesOpen')
    expect(JSON.stringify((res.body as { data?: unknown }).data ?? {})).not.toContain('runtimeGates')
    expect(res.body).not.toHaveProperty('runtimeGates')
  })

  it('permission is unchanged: an attendance:read employee gets 403 and no gate report', async () => {
    const { routes } = await createHarness()
    const res = await invokeRoute(routes, 'GET /api/attendance/settings', { user: EMPLOYEE })
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(JSON.stringify(res.body)).not.toContain('runtimeGates')
  })

  it('no new route is registered for this report (it rides the existing admin GET)', async () => {
    const { routes } = await createHarness()
    expect([...routes.keys()].filter((key) => /runtime|gate/i.test(key))).toEqual([])
  })
})

describe('OpenAPI documents the runtimeGates sibling (gate r1 P3-3)', () => {
  // The generated contract (packages/openapi/dist, rebuilt from the sources in CI) must keep describing exactly what
  // the snapshot builder returns, as an OPTIONAL sibling of `data` on the GET only.
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const doc = JSON.parse(readFileSync(`${repoRoot}packages/openapi/dist/openapi.json`, 'utf8')) as any
  const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` })

  it('GET /api/attendance/settings lists runtimeGates as an optional sibling of data; PUT does not mention it', () => {
    const settings = doc.paths['/api/attendance/settings']
    const getSchema = settings.get.responses['200'].content['application/json'].schema
    expect(getSchema.properties.runtimeGates).toEqual(schemaRef('AttendanceRuntimeGates'))
    expect(getSchema.required ?? []).not.toContain('runtimeGates') // older servers omit it
    expect(JSON.stringify(settings.put)).not.toContain('runtimeGates')
  })

  it('the documented shape is exactly the shape buildAttendanceRuntimeGateSnapshot returns', () => {
    const gates = doc.components.schemas.AttendanceRuntimeGates
    const entry = doc.components.schemas.AttendanceRuntimeGateEntry
    const snapshot = helpers.buildAttendanceRuntimeGateSnapshot() as Record<string, Record<string, unknown>>
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(gates.properties).sort())
    expect([...gates.required].sort()).toEqual(Object.keys(gates.properties).sort())
    for (const feature of Object.keys(gates.properties)) {
      expect(gates.properties[feature]).toEqual(schemaRef('AttendanceRuntimeGateEntry'))
      expect(Object.keys(snapshot[feature]).sort()).toEqual(Object.keys(entry.properties).sort())
    }
    expect([...entry.required].sort()).toEqual(['closedGates', 'gatesOpen'])
    expect(entry.properties.gatesOpen.type).toBe('boolean')
    // ids stay an open string list: a newer server may add gate ids, and the client degrades unknown ones
    expect(entry.properties.closedGates).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(entry.properties.closedGates.items.enum).toBeUndefined()
  })
})
