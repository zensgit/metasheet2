import { createRequire } from 'node:module'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const require = createRequire(import.meta.url)

// Holiday writers carry the actor into the timezone source-change wrapper. These seams
// prove the order inside that wrapper: the actor's manage authority is read before the
// source scan runs, so a scan refusal never answers an actor who may not manage the org.
// The scan itself is a trusted collaborator here; native runtime tests prove its SQL/locks.
const runtimeModule = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
const { AttendanceTimezonePolicyError } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs')
const originalRuntimeFactory = runtimeModule.createAttendanceTimezoneRuntime
const verifyTimezoneSource = vi.fn(async () => {})
const prepareTimezoneSource = vi.fn(async (_trx: unknown, input: { orgId: string }) => {
  expect(input.orgId).toBeTruthy()
  return verifyTimezoneSource
})
runtimeModule.createAttendanceTimezoneRuntime = (deps: unknown) => ({
  ...originalRuntimeFactory(deps),
  prepareSourceChange: prepareTimezoneSource,
})
delete require.cache[require.resolve('../../../../plugins/plugin-attendance/index.cjs')]
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
runtimeModule.createAttendanceTimezoneRuntime = originalRuntimeFactory

afterAll(() => {
  const key = require.resolve('../../../../plugins/plugin-attendance/index.cjs')
  if (require.cache[key]?.exports === attendancePlugin) delete require.cache[key]
})

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS
const originalAsyncEnabled = process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED
const holidayId = '00000000-0000-4000-8000-000000000501'
const actorId = 'admin-1'
const orgId = 'default'

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; this.headersSent = true; return this },
    send(body: unknown) { this.body = body; this.headersSent = true; return this },
    setHeader(name: string, value: string) { this.headers[name] = value; return this },
  }
}

// The route guard sees an attendance admin; only the in-transaction reads decide whether that
// actor is still an active manager of the organization. The unlocked read answers the early
// check before the scan; the row-locking read answers the recheck just before the write.
type HarnessOptions = {
  activeManager: boolean
  lockedMembership?: boolean
  policyLockFault?: boolean
}

function createQuery({ activeManager, lockedMembership = activeManager, policyLockFault = false }: HarnessOptions) {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql)
    if (text.includes('AS allowed') && text.includes('FROM users u JOIN user_orgs')) {
      expect(params).toEqual([actorId, orgId])
      return activeManager ? [{ allowed: true }] : []
    }
    if (text.includes('FOR SHARE OF u,uo')) {
      expect(params).toEqual([actorId, orgId])
      return lockedMembership ? [{ id: actorId }] : []
    }
    if (text.includes('pg_advisory_xact_lock')) {
      if (policyLockFault && JSON.stringify(params).includes('attendance-timezone-policy-v1')) {
        const fault = new Error('canceling statement due to statement timeout') as Error & { code: string }
        fault.code = '57014'
        throw fault
      }
      return []
    }
    if (text.includes('FROM system_configs')) return []
    // The sync route records its last run through the settings writer after the holiday transaction.
    if (text.includes('INSERT INTO system_configs')) return []
    if (text.includes('FROM user_roles') && text.includes('role_id = $2')) return [{ ok: 1 }]
    if (text.includes('FROM user_permissions')) return []
    if (text.includes('JOIN role_permissions')) return []
    if (text.includes('INSERT INTO attendance_holidays')) {
      return [{ id: holidayId, org_id: orgId, holiday_date: '2026-06-01', name: 'Scoped holiday', is_working_day: false, origin: 'manual' }]
    }
    if (text.includes('FROM attendance_holidays WHERE id = $1 AND org_id = $2 FOR UPDATE')) {
      return [{ id: holidayId, org_id: orgId, holiday_date: '2026-06-01', name: 'Scoped holiday', is_working_day: false, origin: 'manual' }]
    }
    if (text.includes('UPDATE attendance_holidays')) {
      return [{ id: holidayId, org_id: orgId, holiday_date: '2026-06-01', name: 'Renamed holiday', is_working_day: false, origin: 'manual' }]
    }
    if (text.includes('DELETE FROM attendance_holidays')) return [{ id: holidayId }]
    throw new Error(`unexpected SQL in holiday writer harness: ${text}`)
  })
}

async function createHarness(options: boolean | HarnessOptions) {
  process.env.RBAC_BYPASS = 'false'
  process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'
  const routes = new Map<string, RouteHandler>()
  const db = {
    __w4CanonicalTrx: true as const,
    query: createQuery(typeof options === 'boolean' ? { activeManager: options } : options),
    transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(db)),
  }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const unreachable = (name: string) => vi.fn(async () => { throw new Error(`${name} must not be reached in the holiday writer harness`) })
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
      approvalCancelRoundEntry: {
        canReadDocument: unreachable('cancel-round entry port'),
        readRoundSummary: unreachable('cancel-round entry port'),
        launch: unreachable('cancel-round entry port'),
        decide: unreachable('cancel-round entry port'),
        withdraw: unreachable('cancel-round entry port'),
        listSeatedPendingRounds: unreachable('cancel-round entry port'),
      },
      attendanceW4SegmentCalculation: {
        validateIanaTimezone: validateAttendanceIanaTimezoneV1,
        deriveApprovalInstanceOrgIdForAttendanceSubjectV1: async ({ requestNamedOrgId }: { requestNamedOrgId: string | null }) =>
          requestNamedOrgId === null || requestNamedOrgId === orgId
            ? { ok: true, orgId }
            : { ok: false, reason: 'selector_not_permitted' },
        resolveOrgSegmentCalculationPosture: async () => ({ effectiveState: 'legacy', referenceSegments: false }),
        createRequestOperationBoundary: () => ({ execute: unreachable('request operation boundary') }),
      },
    },
    logger,
  })
  attendancePlugin.resetAttendanceSettingsCacheForTests?.()
  db.query.mockClear()
  db.transaction.mockClear()
  return { db, routes, logger }
}

async function invokeRoute(routes: Map<string, RouteHandler>, key: string, body?: unknown) {
  const handler = routes.get(key)
  expect(handler, key).toBeTypeOf('function')
  const res = createResponse()
  await handler?.(
    {
      params: { id: holidayId },
      body: body ?? {},
      query: {},
      headers: {},
      user: { id: actorId, orgId },
      get: vi.fn(() => undefined),
    },
    res,
    vi.fn(),
  )
  return res
}

const writers = [
  { key: 'POST /api/attendance/holidays', body: { date: '2026-06-01', name: 'Scoped holiday' }, okStatus: 201 },
  { key: 'PUT /api/attendance/holidays/:id', body: { name: 'Renamed holiday' }, okStatus: 200 },
  { key: 'DELETE /api/attendance/holidays/:id', body: undefined, okStatus: 200 },
  { key: 'POST /api/attendance/holidays/sync', body: { years: [2028] }, okStatus: 200 },
]

function scanRefusal() {
  return new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_WALL_AMBIGUOUS', 422)
}

describe('holiday writers check manage authority before the timezone source scan', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    prepareTimezoneSource.mockReset()
    prepareTimezoneSource.mockImplementation(async (_trx: unknown, input: { orgId: string }) => {
      expect(input.orgId).toBeTruthy()
      return verifyTimezoneSource
    })
    verifyTimezoneSource.mockClear()
    restoreEnv('RBAC_BYPASS', originalRbacBypass)
    restoreEnv('ATTENDANCE_IMPORT_ASYNC_ENABLED', originalAsyncEnabled)
  })

  for (const writer of writers) {
    it(`${writer.key}: an actor who is no longer an active manager gets 403 even when the scan would refuse`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [] }) })))
      const { db, routes } = await createHarness(false)
      prepareTimezoneSource.mockRejectedValue(scanRefusal())
      const res = await invokeRoute(routes, writer.key, writer.body)
      expect(res.statusCode, JSON.stringify(res.body)).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_TIMEZONE_FORBIDDEN', message: 'ATTENDANCE_TIMEZONE_FORBIDDEN' } })
      expect(prepareTimezoneSource).not.toHaveBeenCalled()
      const sql = db.query.mock.calls.map(([text]) => String(text))
      expect(sql.some(text => /INSERT INTO attendance_holidays|UPDATE attendance_holidays|DELETE FROM attendance_holidays|INSERT INTO system_configs/.test(text))).toBe(false)
      // The authority read must follow the organization policy prefix so a membership change
      // committed by an earlier holder of that prefix is visible to it.
      const lockIndex = sql.findIndex(text => text.includes('pg_advisory_xact_lock'))
      const allowedIndex = sql.findIndex(text => text.includes('AS allowed'))
      expect(lockIndex).toBeGreaterThanOrEqual(0)
      expect(allowedIndex).toBeGreaterThan(lockIndex)
    })

    it(`${writer.key}: an active manager still receives the scan refusal`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [] }) })))
      const { db, routes } = await createHarness(true)
      prepareTimezoneSource.mockRejectedValue(scanRefusal())
      const res = await invokeRoute(routes, writer.key, writer.body)
      expect(res.statusCode, JSON.stringify(res.body)).toBe(422)
      expect(res.body).toMatchObject({ ok: false, error: { code: 'ATTENDANCE_TIMEZONE_WALL_AMBIGUOUS' } })
      expect(prepareTimezoneSource).toHaveBeenCalledTimes(1)
      const sql = db.query.mock.calls.map(([text]) => String(text))
      expect(sql.some(text => /INSERT INTO attendance_holidays|UPDATE attendance_holidays|DELETE FROM attendance_holidays/.test(text))).toBe(false)
    })

    it(`${writer.key}: an active manager with a passing scan writes and verifies`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [] }) })))
      const { routes } = await createHarness(true)
      const res = await invokeRoute(routes, writer.key, writer.body)
      expect(res.statusCode, JSON.stringify(res.body)).toBe(writer.okStatus)
      expect(res.body).toMatchObject({ ok: true })
      expect(prepareTimezoneSource).toHaveBeenCalledTimes(1)
      expect(verifyTimezoneSource).toHaveBeenCalledTimes(1)
    })

    it(`${writer.key}: authority lost after the early read is caught by the locked recheck before the write`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [] }) })))
      const { db, routes } = await createHarness({ activeManager: true, lockedMembership: false })
      const res = await invokeRoute(routes, writer.key, writer.body)
      expect(res.statusCode, JSON.stringify(res.body)).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_TIMEZONE_FORBIDDEN', message: 'ATTENDANCE_TIMEZONE_FORBIDDEN' } })
      expect(prepareTimezoneSource).toHaveBeenCalledTimes(1)
      expect(verifyTimezoneSource).not.toHaveBeenCalled()
      const sql = db.query.mock.calls.map(([text]) => String(text))
      expect(sql.some(text => /INSERT INTO attendance_holidays|UPDATE attendance_holidays|DELETE FROM attendance_holidays|INSERT INTO system_configs/.test(text))).toBe(false)
    })

    it(`${writer.key}: a fault while waiting for the organization policy prefix answers 503 source unavailable`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ days: [] }) })))
      const { db, routes } = await createHarness({ activeManager: true, policyLockFault: true })
      const res = await invokeRoute(routes, writer.key, writer.body)
      expect(res.statusCode, JSON.stringify(res.body)).toBe(503)
      expect(res.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE', message: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE' } })
      expect(prepareTimezoneSource).not.toHaveBeenCalled()
      const sql = db.query.mock.calls.map(([text]) => String(text))
      expect(sql.some(text => /INSERT INTO attendance_holidays|UPDATE attendance_holidays|DELETE FROM attendance_holidays/.test(text))).toBe(false)
      // The sync route must not record a failed run for a fault that is answered as a mapped refusal.
      expect(sql.some(text => text.includes('INSERT INTO system_configs'))).toBe(false)
    })
  }
})
