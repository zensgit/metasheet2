import { createRequire } from 'node:module'
import express from 'express'
import type { RequestHandler } from 'express'
import request from 'supertest'
import type { Response as HttpResponse } from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// Real plugin registration -> HTTP -> real shift service -> real hint reader.
// Only DB/host ports and the unrelated timezone source collaborator are doubles.
// The separate real-PG suite owns canonical policy and database readonly semantics.
const require = createRequire(import.meta.url)
type Row = Record<string, unknown>
type Client = { query: (sql: string, params?: unknown[]) => Promise<Row[]> }
const prepareSourceChange = vi.fn(async (_client: Client, _input: { orgId: string }) => async () => {})
const runtime = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
const originalFactory = runtime.createAttendanceTimezoneRuntime
runtime.createAttendanceTimezoneRuntime = (deps: unknown) => ({
  ...originalFactory(deps),
  prepareSourceChange,
})
const pluginPath = require.resolve('../../../../plugins/plugin-attendance/index.cjs')
delete require.cache[pluginPath]
const plugin = require(pluginPath)
runtime.createAttendanceTimezoneRuntime = originalFactory

const pinned = usePinnedServer()
const originalBypass = process.env.RBAC_BYPASS
const ORG = 'synthetic-w6-admitted'
const OTHER_ORG = 'synthetic-w6-closed'
const SHIFT = '00000000-0000-4000-8000-000000000601'
const SECOND_SHIFT = '00000000-0000-4000-8000-000000000602'
const MISSING_SHIFT = '00000000-0000-4000-8000-000000000699'
const PRIVATE = 'SYNTHETIC_PRIVATE_POSTURE_FAILURE'
const CLOSED = {
  segmentCalculation: {
    enabled: false,
    defaultEnabled: false,
    authoritativeResults: false,
    multiSegmentAuthoring: 'preview_only',
    flag: 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
  },
}
const ADMITTED = {
  segmentCalculation: { ...CLOSED.segmentCalculation, multiSegmentAuthoring: 'enabled' },
}
const SEGMENTS = [{ startTime: '09:00', endTime: '17:00' }]
const MULTI = [{ startTime: '09:00', endTime: '12:00' }, { startTime: '13:00', endTime: '17:00' }]
const PATH = '/api/attendance/shifts'

async function makeHarness() {
  process.env.RBAC_BYPASS = 'true'
  prepareSourceChange.mockReset()
  const trace: string[] = []
  const statements: Array<{ sql: string; params: unknown[]; client: Client }> = []
  const transactions: Array<{ client: Client; readonly: boolean; closed: boolean }> = []
  let active = false
  let hint: boolean | 'throw' = false
  let blockerCount = 0
  let segmentCount = 1
  const shifts = new Map<string, Row>()
  const segmentRows = new Map<string, Row[]>()
  for (const orgId of [ORG, OTHER_ORG]) {
    for (const id of [SHIFT, SECOND_SHIFT]) {
      shifts.set(`${orgId}:${id}`, {
        id, org_id: orgId, name: 'Synthetic shift', timezone: 'UTC',
        work_start_time: '09:00', work_end_time: '17:00', is_overnight: false,
        late_grace_minutes: 10, early_grace_minutes: 10, rounding_minutes: 5,
        working_days: [1, 2, 3, 4, 5], flex_mode: 'strict',
      })
    }
  }
  async function query(client: Client, sql: string, params: unknown[] = []): Promise<Row[]> {
    if (!active) return [] // Plugin activation preloads are outside the request trace.
    const state = transactions.find(entry => entry.client === client)
    expect(state?.closed ?? false).toBe(false)
    statements.push({ sql, params, client })
    if (sql === 'SET TRANSACTION READ ONLY') {
      expect(state).toBeDefined()
      state!.readonly = true
      trace.push('readonly')
      return []
    }
    if (/^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)) {
      expect(state).toBeDefined()
      expect(state!.readonly).toBe(false)
      trace.push('dml')
    }
    if (sql.includes('FROM system_configs') || sql.includes('pg_advisory_xact_lock')) return []
    if (sql.includes('COUNT(*)')) {
      if (sql.includes('FROM attendance_shift_segments')) return [{ total: segmentCount }]
      if (sql.includes('FROM attendance_shift_assignments')) return [{ total: blockerCount }]
      if (sql.includes('FROM attendance_shifts')) return [{ total: 2 }]
      if (['attendance_group_fixed_schedule_configs', 'attendance_rotation_rules',
        'attendance_shift_swap_requests', 'attendance_schedule_dispatch_requests'].some(table => sql.includes(table))) {
        return [{ total: 0 }]
      }
    }
    if (sql.includes('INSERT INTO attendance_shift_segments')) {
      const key = `${params[1]}:${params[2]}`
      const rows = segmentRows.get(key) ?? []
      rows.push({ id: params[0], shift_id: params[2], segment_index: params[3],
        start_time: params[4], start_day_offset: params[5], end_time: params[6], end_day_offset: params[7] })
      segmentRows.set(key, rows)
      return []
    }
    if (sql.includes('FROM attendance_shift_segments')) {
      return (params[1] as string[]).flatMap(id => segmentRows.get(`${params[0]}:${id}`) ?? [])
    }
    if (sql.includes('INSERT INTO attendance_shifts') || sql.includes('UPDATE attendance_shifts')) {
      const [id, orgId, name, timezone, start, end, overnight, late, early, rounding, days,
        flexMode, required, before, after, coreStart, coreEnd] = params
      const row = { id, org_id: orgId, name, timezone, work_start_time: start, work_end_time: end,
        is_overnight: overnight, late_grace_minutes: late, early_grace_minutes: early,
        rounding_minutes: rounding, working_days: JSON.parse(String(days)), flex_mode: flexMode,
        flex_required_minutes: required, flex_arrival_window_before_minutes: before,
        flex_arrival_window_after_minutes: after, flex_core_start_time: coreStart, flex_core_end_time: coreEnd }
      shifts.set(`${orgId}:${id}`, row)
      return [row]
    }
    if (sql.includes('FROM attendance_shifts')) {
      if (sql.includes('WHERE id = $1 AND org_id = $2')) {
        const row = shifts.get(`${params[1]}:${params[0]}`)
        return row ? [row] : []
      }
      return [SHIFT, SECOND_SHIFT].map(id => shifts.get(`${params[0]}:${id}`)!)
    }
    throw new Error('Unexpected synthetic SQL')
  }
  const db: Client & { transaction: (run: (client: Client) => Promise<unknown>) => Promise<unknown> } = {
    query: (sql, params) => query(db, sql, params),
    async transaction(run) {
      const client: Client = { query: (sql, params) => query(client, sql, params) }
      const state = { client, readonly: false, closed: false }
      transactions.push(state)
      trace.push('begin')
      try {
        const value = await run(client)
        trace.push(state.readonly ? 'read:commit' : 'write:commit')
        return value
      } catch (error) {
        trace.push(state.readonly ? 'read:rollback' : 'write:rollback')
        throw error
      } finally {
        state.closed = true
        trace.push('release')
      }
    },
  }
  prepareSourceChange.mockImplementation(async (client, input) => {
    expect(input.orgId).toBe(ORG)
    expect(transactions.find(entry => entry.client === client)).toMatchObject({ readonly: false, closed: false })
    trace.push('writer:prepare')
    return async () => { trace.push('writer:verify') }
  })
  const readPort = vi.fn(async (client: Client, orgId: string) => {
    expect(transactions.find(entry => entry.client === client)).toMatchObject({ readonly: true, closed: false })
    trace.push('hint')
    if (hint === 'throw') throw new Error(PRIVATE)
    return { referenceSegments: hint && orgId === ORG, effectiveState: PRIVATE, memberIds: [PRIVATE] }
  })
  const writePort = vi.fn(async (client: Client, orgId: string) => {
    expect(orgId).toBe(ORG)
    expect(transactions.find(entry => entry.client === client)).toMatchObject({ readonly: false, closed: false })
    trace.push('writer:policy')
    return { referenceSegments: false, effectiveState: 'legacy' }
  })
  const port: Record<string, unknown> = {
    resolveTimezoneSegmentReferencePosture: readPort,
    resolveOrgSegmentCalculationPosture: writePort,
  }
  const emit = vi.fn()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 'synthetic-w6-admin', orgId: req.headers['x-test-actor-org'] ?? ORG,
    }
    next()
  })
  await plugin.activate({
    api: { database: db, events: { emit }, http: {
      addRoute(method: string, path: string, handler: RequestHandler) {
        if (!/^\/api\/attendance\/(shifts|assignments)(\/|$)/.test(path)) return
        app[method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](path,
          (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) })
      },
    } },
    services: { attendanceW4SegmentCalculation: port }, logger,
  })
  plugin.resetAttendanceSettingsCacheForTests?.()
  emit.mockClear()
  Object.values(logger).forEach(log => log.mockClear())
  trace.length = 0
  transactions.length = 0
  active = true
  pinned.setApp(app)
  return { trace, statements, transactions, readPort, writePort, emit, logger, port,
    setHint(value: typeof hint) { hint = value },
    setBlockers(value: number) { blockerCount = value },
    setSegmentCount(value: number) { segmentCount = value },
    resetTrace() { trace.length = 0; statements.length = 0; transactions.length = 0; readPort.mockClear(); emit.mockClear() },
  }
}

afterEach(async () => {
  await plugin.deactivate()
  if (originalBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalBypass
})
afterAll(() => {
  if (require.cache[pluginPath]?.exports === plugin) delete require.cache[pluginPath]
})

const paths = ['list', 'detail', 'create', 'update'] as const
type Path = typeof paths[number]
function send(path: Path, body?: Record<string, unknown>) {
  const http = request(pinned.url())
  if (path === 'list') return http.get(PATH)
  if (path === 'detail') return http.get(`${PATH}/${SHIFT}`)
  if (path === 'create') return http.post(PATH).send(body ?? { name: 'Synthetic shift', segments: SEGMENTS })
  return http.put(`${PATH}/${SHIFT}`).send(body ?? { lateGraceMinutes: 11 })
}
function capabilities(response: HttpResponse, path: Path) {
  const data = path === 'list' ? response.body.data.items : [response.body.data]
  return data.map((row: { capabilities: unknown }) => row.capabilities)
}
function bytes(response: HttpResponse, path: Path) {
  return path === 'create' ? normalizeIds(response.text) : response.text
}
function normalizeIds(value: string) {
  // Creates legitimately allocate new shift/segment IDs; everything else is exact.
  return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, '<uuid>')
}

describe('W6 reference-authoring hint through registered plugin HTTP routes', () => {
  it.each(paths)('%s changes only the authoring enum and keeps unavailable hints byte-closed', async (path) => {
    const h = await makeHarness()
    const closed = await send(path)
    expect(closed.status).toBe(path === 'create' ? 201 : 200)
    expect(capabilities(closed, path)).toEqual(path === 'list' ? [CLOSED, CLOSED] : [CLOSED])
    const closedWrites = normalizeIds(JSON.stringify(h.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))
      .map(({ sql, params }) => ({ sql, params }))))
    h.resetTrace()
    h.setHint(true)
    const admitted = await send(path)
    expect(admitted.status).toBe(closed.status)
    expect(capabilities(admitted, path)).toEqual(path === 'list' ? [ADMITTED, ADMITTED] : [ADMITTED])
    expect(bytes(admitted, path).replaceAll('"multiSegmentAuthoring":"enabled"', '"multiSegmentAuthoring":"preview_only"'))
      .toBe(bytes(closed, path))
    expect(h.readPort).toHaveBeenCalledTimes(1)
    expect(h.readPort.mock.calls[0][1]).toBe(ORG)
    expect(admitted.text).not.toContain(PRIVATE)
    expect(normalizeIds(JSON.stringify(h.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))
      .map(({ sql, params }) => ({ sql, params }))))).toBe(closedWrites)
    if (path === 'create' || path === 'update') {
      expect(h.trace).toEqual(['begin', 'readonly', 'hint', 'read:commit', 'release',
        'begin', 'writer:prepare', ...Array(path === 'create' ? 2 : 1).fill('dml'),
        'writer:verify', 'write:commit', 'release'])
      expect(h.emit.mock.calls).toEqual([[`attendance.shift.${path === 'create' ? 'created' : 'updated'}`,
        { orgId: ORG, shiftId: admitted.body.data.id }]])
    } else {
      expect(h.trace).toEqual(['begin', 'readonly', 'hint', 'read:commit', 'release'])
      expect(h.emit).not.toHaveBeenCalled()
    }
    h.resetTrace()
    h.setHint('throw')
    const unavailable = await send(path)
    expect(unavailable.status).toBe(closed.status)
    expect(bytes(unavailable, path)).toBe(bytes(closed, path))
    expect(h.trace.slice(0, 5)).toEqual(['begin', 'readonly', 'hint', 'read:rollback', 'release'])
    expect(h.transactions.every(tx => tx.closed)).toBe(true)
    expect(unavailable.text).not.toContain(PRIVATE)
    expect(h.logger.error).not.toHaveBeenCalled()
    delete h.port.resolveTimezoneSegmentReferencePosture
    h.resetTrace()
    const missingPort = await send(path)
    expect(missingPort.status).toBe(closed.status)
    expect(bytes(missingPort, path)).toBe(bytes(closed, path))
    expect(h.readPort).not.toHaveBeenCalled()
    expect(h.trace).not.toContain('readonly')
    expect(h.writePort).not.toHaveBeenCalled()
  })

  it('reads once per nonempty page on every request and never caches admission across orgs', async () => {
    const h = await makeHarness()
    h.setHint(true)
    for (const orgId of [ORG, OTHER_ORG, ORG]) {
      const response = await request(pinned.url()).get(PATH).set('x-test-actor-org', orgId)
      expect(response.status).toBe(200)
      expect(capabilities(response, 'list')).toEqual(orgId === ORG ? [ADMITTED, ADMITTED] : [CLOSED, CLOSED])
      expect(response.body.data.items.map((row: { orgId: string }) => row.orgId)).toEqual([orgId, orgId])
    }
    expect(h.readPort.mock.calls.map(([, orgId]) => orgId)).toEqual([ORG, OTHER_ORG, ORG])
    expect(new Set(h.readPort.mock.calls.map(([client]) => client)).size).toBe(3)
  })

  it.each(['list', 'detail'] as const)('%s ignores client-provided capability hints', async (path) => {
    const h = await makeHarness()
    const response = await send(path).query({ referenceSegments: 'true', multiSegmentAuthoring: 'enabled' })
    expect(response.status).toBe(200)
    expect(capabilities(response, path)).toEqual(path === 'list' ? [CLOSED, CLOSED] : [CLOSED])
    expect(h.readPort.mock.calls.map(([, orgId]) => orgId)).toEqual([ORG])
  })

  it('keeps not-found detail and actor-org rejection ahead of the hint', async () => {
    const h = await makeHarness()
    h.setHint(true)
    const missing = await request(pinned.url()).get(`${PATH}/${MISSING_SHIFT}`)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
    const rejected = await request(pinned.url()).get(PATH).query({ orgId: OTHER_ORG })
    expect(rejected.status).toBe(404)
    expect(rejected.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    expect(h.readPort).not.toHaveBeenCalled()
    expect(h.transactions).toEqual([])
  })

  it.each(['query', 'header', 'body'] as const)('detail rejects a foreign %s org selector before any shift SQL or the hint', async (selector) => {
    const h = await makeHarness()
    h.setHint(true)
    let req = request(pinned.url()).get(`${PATH}/${SHIFT}`)
    if (selector === 'query') req = req.query({ orgId: OTHER_ORG })
    if (selector === 'header') req = req.set('x-org-id', OTHER_ORG)
    if (selector === 'body') req = req.send({ orgId: OTHER_ORG })
    const response = await req
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    expect(h.statements.filter(({ sql }) => /attendance_shift|^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(sql))).toEqual([])
    expect(h.readPort).not.toHaveBeenCalled()
    expect(h.transactions).toEqual([])
    expect(h.emit).not.toHaveBeenCalled()
  })

  it.each(['create', 'update'] as const)('%s retains pre-transaction ambiguity rejection without a hint', async (path) => {
    const h = await makeHarness()
    const response = await send(path, { name: 'Synthetic shift', segments: SEGMENTS, workStartTime: '09:00' })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_SHIFT_SEGMENT_MODE_AMBIGUOUS',
      message: 'Provide either segments or legacy start/end fields, not both',
      details: [{ field: 'segments', message: 'Cannot combine segments with workStartTime/workEndTime/isOvernight' }],
    } })
    expect(h.trace).toEqual([])
    expect(h.emit).not.toHaveBeenCalled()
  })

  it('cannot use an admitted display hint to bypass locked-row conversion blockers', async () => {
    const h = await makeHarness()
    h.setHint(true)
    h.setBlockers(1)
    const response = await send('update', { segments: MULTI })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_SHIFT_SEGMENT_CONVERSION_BLOCKED',
      message: 'Shift has durable references and cannot be converted from one segment to multiple segments while segment calculation is disabled',
      details: [{ field: 'shift_assignments', message: 'shift_assignments: 1' }],
    } })
    expect(h.trace).toEqual(['begin', 'readonly', 'hint', 'read:commit', 'release',
      'begin', 'writer:prepare', 'write:rollback', 'release'])
    expect(h.statements.some(({ sql }) => sql.includes('FOR UPDATE'))).toBe(true)
    expect(h.emit).not.toHaveBeenCalled()
  })

  it.each(['create', 'update'] as const)('%s still obeys the independent source guard after a hint failure', async (path) => {
    const h = await makeHarness()
    h.setHint('throw')
    prepareSourceChange.mockRejectedValueOnce(new Error(PRIVATE))
    const response = await send(path)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE', message: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',
    } })
    expect(h.trace).toEqual(['begin', 'readonly', 'hint', 'read:rollback', 'release',
      'begin', 'write:rollback', 'release'])
    expect(h.emit).not.toHaveBeenCalled()
  })

  it('resolves reference-writer policy again on its own write client after an admitted HTTP read', async () => {
    const h = await makeHarness()
    h.setHint(true)
    const detail = await send('detail')
    expect(capabilities(detail, 'detail')).toEqual([ADMITTED])
    const readClient = h.readPort.mock.calls[0][0]
    h.resetTrace()
    h.setSegmentCount(2)
    const response = await request(pinned.url()).post('/api/attendance/assignments').send({
      userId: 'synthetic-w6-member', shiftId: SHIFT, startDate: '2026-10-25',
      referenceSegments: true, capabilities: ADMITTED,
    })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
      message: 'Shift has 2 segments; authoritative segment calculation is disabled for this org, so assignment_create cannot use a multi-segment shift',
    } })
    expect(h.writePort).toHaveBeenCalledTimes(1)
    expect(h.writePort.mock.calls[0][0]).not.toBe(readClient)
    expect(h.trace).toEqual(['begin', 'writer:prepare', 'writer:policy', 'write:rollback', 'release'])
    expect(h.readPort).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalled()
  })
})
