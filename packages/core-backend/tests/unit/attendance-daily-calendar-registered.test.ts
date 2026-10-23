import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const require = createRequire(import.meta.url)
const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const orgId = 'daily-registered-org'
const actorId = 'daily-registered-admin'
function response() {
  return { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.body = value; this.headersSent = true; return this },
  }
}
interface SyntheticDb {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  transaction(work: (trx: SyntheticDb) => Promise<unknown>): Promise<unknown>
}
type Handler = (req: Record<string, unknown>, res: ReturnType<typeof response>, next: () => void) => Promise<void>
async function flushPlans() { for (let index = 0; index < 20; index += 1) await Promise.resolve() }
function rule(timezone: string, targetOrg = orgId) {
  return { id: targetOrg === orgId ? 'daily-default' : targetOrg + '-default', org_id: targetOrg, timezone, timezone_version: 1, is_default: true,
    name: 'daily synthetic', work_start_time: '09:00', work_end_time: '18:00', working_days: [1, 2, 3, 4, 5],
    late_grace_minutes: 10, early_grace_minutes: 10, severe_late_threshold_minutes: 30,
    absence_late_threshold_minutes: 60, rounding_minutes: 5,
  }
}
async function fixture(defaults: Record<string, unknown>[] = [rule('Asia/Shanghai')], runAt = '00:15', instant = '2026-09-22T15:30:00Z', lookbackDays = 1) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(instant))
  vi.stubEnv('RBAC_BYPASS', 'false')
  plugin.resetAttendanceSettingsCacheForTests()
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const clear = vi.spyOn(globalThis, 'clearTimeout')
  let stored: Record<string, unknown> = { autoAbsence: { enabled: true, runAt, lookbackDays } }
  const state = { defaults, failCommit: false, onDefaultRead: async (_org: string) => {} }
  const routes = new Map<string, Handler>()
  const boundary = { resolvesScheduledTimezone: true, executeScheduledRun: vi.fn(async (_input: Record<string, unknown>): Promise<{ kind: string; rows: unknown[]; targetCount: number }> => { throw new Error('UNEXPECTED_BUSINESS_EXECUTION') }) }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const db: SyntheticDb = {
    query: vi.fn(async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
      if (sql.includes('SELECT value FROM system_configs')) return [{ value: JSON.stringify(stored) }]
      if (sql.includes('INSERT INTO system_configs')) { stored = JSON.parse(String(params[1])); return [] }
      if (sql.includes('SELECT DISTINCT org_id FROM attendance_rules')) return [...new Set([orgId, ...state.defaults.map(row => String(row.org_id))])].map(org_id => ({ org_id }))
      if (sql.includes('SELECT * FROM attendance_rules WHERE org_id = $1 AND is_default = true')) {
        expect(params).toHaveLength(1)
        await state.onDefaultRead(String(params[0]))
        return state.defaults.filter(row => row.org_id === params[0] && row.is_default !== false)
      }
      if (sql.includes('SELECT id FROM attendance_rules')) return state.defaults.map(row => ({ id: row.id }))
      if (sql.includes('UPDATE attendance_rules SET is_default')) return []
      if (sql.includes('INSERT INTO attendance_rules')) {
        const inserted = { ...rule(String(params[3]), String(params[1])), id: params[0] }
        state.defaults = [...state.defaults.filter(row => row.org_id !== params[1]), inserted]
        return [inserted]
      }
      if (sql.includes('AS allowed') && sql.includes('FROM users u JOIN user_orgs')) return [{ allowed: true }]
      if (sql.includes('SELECT u.id FROM users u JOIN user_orgs')) return [{ id: actorId }]
      if (sql.includes('FROM user_roles') || sql.includes('FROM user_permissions') || sql.includes('JOIN role_permissions')) return [{ ok: 1 }]
      if (sql.includes('pg_advisory')) return []
      if (sql.includes('SELECT uo.user_id FROM user_orgs uo JOIN users')) return []
      if (sql.includes('FROM attendance_business_trip_arrangements')) return []
      if (sql.includes('FROM attendance_timezone_policies')) return []
      if (/^\s*(CREATE|ALTER)/.test(sql)) return []
      throw new Error('DAILY_CALENDAR_REGISTERED_UNEXPECTED_SQL')
    }),
    transaction: async (work: (trx: SyntheticDb) => Promise<unknown>) => {
      const saved = JSON.stringify(stored), savedDefaults = JSON.stringify(state.defaults)
      try {
        const result = await work(db)
        if (state.failCommit) throw new Error('SYNTHETIC_COMMIT_FAILED')
        return result
      } catch (error) {
        stored = JSON.parse(saved); state.defaults = JSON.parse(savedDefaults); throw error
      }
    },
  }
  await plugin.activate({
    api: { database: db, events: { emit: vi.fn() }, http: { addRoute: (method: string, path: string, handler: Handler) => { routes.set(`${method} ${path}`, handler) } } },
    logger,
    services: { attendanceW4SegmentCalculation: {
      validateIanaTimezone: validateAttendanceIanaTimezoneV1,
      resolveLocalWallTime: resolveAttendanceLocalWallTimeV1,
      applyMergePolicyPure: vi.fn(), computeOuterSourceDefinitionFingerprintV1: vi.fn(), issueAttendanceFrozenContextV1: vi.fn(),
      createLiveScheduledBoundary: () => boundary,
      resolveOrgSegmentCalculationPosture: async () => ({ effectiveState: 'legacy', referenceSegments: false }),
      createRequestOperationBoundary: () => ({ execute: async () => { throw new Error('UNEXPECTED_REQUEST_EXECUTION') } }),
    } },
  })
  await flushPlans()
  async function put(path: string, body: Record<string, unknown>, targetOrg = orgId) {
    const handler = routes.get(`PUT ${path}`)
    expect(handler).toBeTypeOf('function')
    const res = response()
    await handler!({ body, params: {}, query: {}, headers: {}, user: { id: actorId, orgId: targetOrg }, get: () => undefined }, res, () => {})
    await flushPlans()
    return res
  }
  function timer(delay: number) {
    const index = timeout.mock.calls.findIndex(call => call[1] === delay)
    expect(index).toBeGreaterThanOrEqual(0)
    return timeout.mock.results[index].value
  }
  return { state, timeout, clear, timer, put, boundary, logger, getStored: () => stored }
}
afterEach(async () => {
  await plugin.deactivate()
  plugin.resetAttendanceSettingsCacheForTests()
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs()
})

describe('real activated attendance daily planner and registered write routes', () => {
  it('ORG_SCOPED_REARM_B_DUE_REFRESH: A commit preserves B due callback and yesterday', async () => {
    const sibling = 'daily-registered-b'
    const h = await fixture([rule('Asia/Shanghai'), rule('UTC', sibling)], '00:15', '2026-09-23T00:14:00Z')
    const aTimer = h.timer(16 * 3600000 + 60000)
    const bTimer = h.timer(60000)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    h.state.onDefaultRead = async org => { if (org === sibling) { entered(); await blocked } }
    h.boundary.executeScheduledRun.mockImplementation(async () => ({ kind: 'w4', rows: [], targetCount: 0 }))
    vi.setSystemTime(new Date('2026-09-23T00:15:00Z'))
    const bIndex = h.timeout.mock.results.findIndex(result => result.value === bTimer)
    const due = (h.timeout.mock.calls[bIndex][0] as () => Promise<void>)()
    try {
      await started
      const res = await h.put('/api/attendance/rules/default', { timezone: 'Pacific/Kiritimati' })
      expect(res.statusCode).toBe(200)
      expect(h.clear).toHaveBeenCalledWith(aTimer)
      release(); await due
      expect(h.boundary.executeScheduledRun.mock.calls).toEqual([[{
        orgId: sibling, workDate: '2026-09-22', targetUserIds: [], reviewTargets: [],
        initiator: 'cron', legacyDedupHit: false, adminActorId: null,
      }]])
      expect(h.clear).not.toHaveBeenCalledWith(bTimer)
      expect(h.timeout.mock.calls.filter(call => call[1] === 86400000)).toHaveLength(1)
    } finally { release(); await due }
  })
  it.each([false, true])('REGISTERED_LOOKBACK: changing active org itself=%s invalidates only its continuation', async sameOrg => {
    const sibling = sameOrg ? 'daily-registered-loop-self' : 'daily-registered-loop-sibling'
    const h = await fixture([rule('Asia/Shanghai'), rule('UTC', sibling)], '00:15', '2026-09-23T00:14:00Z', 3)
    const aTimer = h.timer(16 * 3600000 + 60000), bTimer = h.timer(60000)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let first = true
    h.boundary.executeScheduledRun.mockImplementation(async () => {
      if (first) { first = false; entered(); await gate }
      return { kind: 'w4', rows: [], targetCount: 0 }
    })
    vi.setSystemTime(new Date('2026-09-23T00:15:00Z'))
    const index = h.timeout.mock.results.findIndex(result => result.value === bTimer)
    const due = (h.timeout.mock.calls[index][0] as () => Promise<void>)()
    try {
      await started
      const res = await h.put('/api/attendance/rules/default', { timezone: 'Pacific/Kiritimati' }, sameOrg ? sibling : orgId)
      expect(res.statusCode).toBe(200)
      release(); await due
      expect(h.boundary.executeScheduledRun.mock.calls.map(([input]) => [input.orgId, input.workDate])).toEqual(
        (sameOrg ? ['2026-09-22'] : ['2026-09-22', '2026-09-21', '2026-09-20']).map(date => [sibling, date]),
      )
      if (sameOrg) expect(h.clear).not.toHaveBeenCalledWith(aTimer)
      else expect(h.clear).toHaveBeenCalledWith(aTimer)
    } finally { release(); await due }
  })
  it.each(['settings', 'stop'])('GLOBAL_INVALIDATION: %s invalidates an old sibling pending refresh', async action => {
    const sibling = 'daily-registered-global-b'
    const h = await fixture([rule('Asia/Shanghai'), rule('UTC', sibling)], '00:15', '2026-09-23T00:14:00Z')
    const aTimer = h.timer(16 * 3600000 + 60000), bTimer = h.timer(60000)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let held = false
    h.state.onDefaultRead = async org => { if (org === sibling && !held) { held = true; entered(); await gate } }
    h.boundary.executeScheduledRun.mockResolvedValue({ kind: 'w4', rows: [], targetCount: 0 })
    vi.setSystemTime(new Date('2026-09-23T00:15:00Z'))
    const index = h.timeout.mock.results.findIndex(result => result.value === bTimer)
    const due = (h.timeout.mock.calls[index][0] as () => Promise<void>)()
    try {
      await started
      if (action === 'settings') {
        const res = await h.put('/api/attendance/settings', { autoAbsence: { runAt: '01:15' } })
        expect(res.statusCode).toBe(200)
      } else await plugin.deactivate()
      expect(h.clear).toHaveBeenCalledWith(aTimer)
      release(); await due; await flushPlans()
      expect(h.boundary.executeScheduledRun).not.toHaveBeenCalled()
      const count = h.timeout.mock.calls.length
      await flushPlans()
      expect(h.timeout).toHaveBeenCalledTimes(count)
      if (action === 'settings') h.timer(3600000)
    } finally { release(); await due }
  })
  it('activation arms the actual org-IANA planner and successful settings save replans it', async () => {
    const h = await fixture()
    const old = h.timer(45 * 60000)
    const res = await h.put('/api/attendance/settings', { autoAbsence: { runAt: '01:15' } })
    expect(res.statusCode).toBe(200)
    expect(h.clear).toHaveBeenCalledWith(old)
    h.timer(105 * 60000)
    expect(h.boundary.executeScheduledRun).not.toHaveBeenCalled()
  })
  it.each(['validation', 'commit'])('failed settings %s leaves the original schedule and saved state intact', async failure => {
    const h = await fixture()
    const old = h.timer(45 * 60000)
    const before = h.timeout.mock.calls.length
    const stored = JSON.stringify(h.getStored())
    h.state.failCommit = failure === 'commit'
    const res = await h.put('/api/attendance/settings', { autoAbsence: failure === 'validation' ? { lookbackDays: 0 } : { runAt: '01:15' } })
    expect(res.statusCode).toBe(failure === 'validation' ? 400 : 500)
    expect(h.clear).not.toHaveBeenCalledWith(old)
    expect(h.timeout).toHaveBeenCalledTimes(before)
    expect(JSON.stringify(h.getStored())).toBe(stored)
    expect(h.boundary.executeScheduledRun).not.toHaveBeenCalled()
  })
  it('successful default-rule commit replans using its new IANA', async () => {
    const h = await fixture()
    const old = h.timer(45 * 60000)
    const res = await h.put('/api/attendance/rules/default', { timezone: 'UTC' })
    expect(res.statusCode).toBe(200)
    expect(h.clear).toHaveBeenCalledWith(old)
    h.timer(8 * 3600000 + 45 * 60000)
  })
  it('rolled-back default-rule write preserves the previous timer', async () => {
    const h = await fixture()
    const old = h.timer(45 * 60000), count = h.timeout.mock.calls.length
    h.state.failCommit = true
    const res = await h.put('/api/attendance/rules/default', { timezone: 'UTC' })
    expect(res.statusCode).toBe(500)
    expect(h.clear).not.toHaveBeenCalledWith(old)
    expect(h.timeout).toHaveBeenCalledTimes(count)
    expect(h.state.defaults).toEqual([rule('Asia/Shanghai')])
  })
  it.each([{ rows: [] }, { rows: [rule('UTC'), rule('UTC')] }, { rows: [rule('Invalid/Zone')] }])('missing, conflicting and invalid defaults arm retry only', async ({ rows }) => {
    const h = await fixture(rows)
    expect(h.timeout.mock.calls.map(call => call[1])).toEqual([60000])
    expect(h.logger.warn.mock.calls).toEqual([['Attendance daily calendar skipped', { code: 'DAILY_CALENDAR_PLAN_FAILED' }]])
    expect(h.boundary.executeScheduledRun).not.toHaveBeenCalled()
  })
  it.each([
    ['2026-03-08T08:00:00Z', '02:30', '2026-03-09T09:30:00Z', 'DAILY_CALENDAR_GAP_SKIPPED'],
    ['2026-11-01T07:00:00Z', '01:30', '2026-11-02T09:30:00Z', 'DAILY_CALENDAR_FOLD_SKIPPED'],
  ])('the activated planner skips a non-unique wall occurrence', async (now, runAt, expected, code) => {
    const h = await fixture([rule('America/Los_Angeles')], runAt, now)
    h.timer(Date.parse(expected) - Date.parse(now))
    expect(h.logger.warn.mock.calls).toEqual([['Attendance daily calendar skipped', { code }]])
    expect(h.boundary.executeScheduledRun).not.toHaveBeenCalled()
  })
})


describe('parallel organization timers and the unchanged production W4 handoff', () => {
  it('reversed completion cannot suppress another org/date or bypass W4 on a legacy-key hit', async () => {
    const { createDailyCalendarScheduler } = require('../../../../plugins/plugin-attendance/lib/attendance-daily-calendar.cjs')
    const execute = plugin.__attendanceWorkDateResolverForTests.runAutoAbsenceForOrgDate
    const orgs = ['daily-interleave-a', 'daily-interleave-b']
    let instant = Date.parse('2026-09-23T00:14:00Z')
    const callbacks: Array<() => Promise<void>> = []
    const completions: string[] = []
    let releaseA!: () => void
    const blockedA = new Promise<void>(resolve => { releaseA = resolve })
    let firstA = true
    const boundary = {
      resolvesScheduledTimezone: true,
      executeScheduledRun: vi.fn(async (input: {orgId: string}) => {
        if (input.orgId === orgs[0] && firstA) { firstA = false; await blockedA }
        completions.push(input.orgId)
        return { kind: 'w4', rows: [], targetCount: 0 }
      }),
    }
    const emit = vi.fn()
    const db = { query: vi.fn(async () => { throw new Error('SCHEDULER_MUST_USE_W4') }) }
    const run = (orgId: string) => execute(db, {orgId,workDate:'2026-09-22',w4Boundary:boundary,initiator:'cron',emit})
    const scheduler = createDailyCalendarScheduler({
      strictTime: {validateIanaTimezone:validateAttendanceIanaTimezoneV1,resolveLocalWallTime:resolveAttendanceLocalWallTimeV1},
      warn: vi.fn(), now: () => instant,
      loadPlans: async () => orgs.map(orgId => ({orgId})),
      refreshPlan: async (plan: {orgId: string}) => ({...plan,timeZone:'UTC',runAt:'00:15'}),
      runPlan: (plan: {orgId: string}) => run(plan.orgId),
      setTimer: (callback: () => Promise<void>) => { callbacks.push(callback); return callbacks.length }, clearTimer: vi.fn(),
    })
    try {
      await scheduler.start()
      expect(callbacks).toHaveLength(2)
      instant = Date.parse('2026-09-23T00:15:00Z')
      const pendingA = callbacks[0]()
      await flushPlans()
      await callbacks[1]()
      expect(completions).toEqual([orgs[1]])
      releaseA(); await pendingA
      expect(completions).toEqual([orgs[1],orgs[0]])
      // The single global key is only an optimization: A hits it, B misses it.
      // Both must still enter W4; durable idempotency belongs to that boundary.
      await run(orgs[0]); await run(orgs[1])
      expect(boundary.executeScheduledRun.mock.calls.map(([input]) => input)).toEqual([
        {orgId:orgs[0],workDate:'2026-09-22',targetUserIds:[],reviewTargets:[],initiator:'cron',legacyDedupHit:false,adminActorId:null},
        {orgId:orgs[1],workDate:'2026-09-22',targetUserIds:[],reviewTargets:[],initiator:'cron',legacyDedupHit:false,adminActorId:null},
        {orgId:orgs[0],workDate:'2026-09-22',targetUserIds:[],reviewTargets:[],initiator:'cron',legacyDedupHit:true,adminActorId:null},
        {orgId:orgs[1],workDate:'2026-09-22',targetUserIds:[],reviewTargets:[],initiator:'cron',legacyDedupHit:false,adminActorId:null},
      ])
      expect(db.query).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
    } finally { releaseA(); scheduler.stop() }
  })
})
