import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const USER = '00000000-0000-4000-8000-000000006032'
const ORG = 'synthetic-6032'
const INSTANT = '2026-09-22T16:30:00.000Z'
const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
let timezone = 'Asia/Shanghai'
let overrideTimezone: string | null = null
let groupRule = false
let published: 'shift' | 'rotation' | 'ambiguous' | 'single-day' | 'both' | 'neighbor-multi' | 'matching-multi' | null = null
const SHIFT = '00000000-0000-4000-8000-000000006035'
const RULE_SET = '00000000-0000-4000-8000-000000006034'
const errors: unknown[] = []
const db = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM attendance_rules')) return [{
      id: '00000000-0000-4000-8000-000000006033', name: 'synthetic rule',
      timezone, work_start_time: '00:00', work_end_time: '23:59',
      working_days: [0, 1, 2, 3, 4, 5, 6], is_default: true, org_id: ORG,
    }]
    if (sql.includes('FROM attendance_shift_assignments a')) return (published === 'shift' || published === 'ambiguous' || published === 'both' || (published === 'neighbor-multi' && ['2026-09-22', '2026-09-24'].includes(String(params[2]))) || published === 'matching-multi' || (published === 'single-day' && params[2] === '2026-09-22')) ? [{
      id: SHIFT, org_id: ORG, user_id: USER, shift_id: SHIFT, start_date: '2026-09-21', is_active: true,
      shift_segment_count: published === 'matching-multi' || (published === 'neighbor-multi' && params[2] === '2026-09-24') ? 2 : 0,
      shift_name: 'synthetic shift', shift_timezone: published === 'both' || (published === 'ambiguous' && params[2] !== '2026-09-22') || (published === 'neighbor-multi' && params[2] !== '2026-09-22') ? 'Asia/Shanghai' : 'America/Los_Angeles',
      shift_work_start_time: '00:00', shift_work_end_time: '23:59', shift_working_days: [0,1,2,3,4,5,6],
    }] : []
    if (sql.includes('FROM attendance_rotation_assignments a')) return (published === 'rotation' || published === 'both') ? [{
      id: SHIFT, org_id: ORG, user_id: USER, rotation_rule_id: SHIFT, start_date: '2026-09-21', is_active: true,
      rotation_name: 'synthetic rotation', rotation_timezone: 'UTC', rotation_is_active: true, rotation_shift_sequence: [SHIFT],
    }] : []
    if (sql.includes('FROM attendance_shifts s')) return (published === 'rotation' || published === 'both') ? [{
      id: SHIFT, org_id: ORG, segment_count: 0, name: 'synthetic shift', timezone: 'America/Los_Angeles',
      work_start_time: '00:00', work_end_time: '23:59', working_days: [0,1,2,3,4,5,6],
    }] : []
    if (sql.includes('FROM attendance_rule_sets')) return [{ config: { rule: { timezone: overrideTimezone } } }]
    if (sql.includes('FROM attendance_groups')) return groupRule ? [{ name: 'synthetic group', rule_set_id: RULE_SET }] : []
    if (/^\s*(SELECT|WITH)/i.test(sql)) return []
    throw new Error('unexpected synthetic database write')
  }),
  transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(db),
}

beforeAll(async () => {
  vi.stubEnv('RBAC_BYPASS', 'true')
  vi.stubEnv('ATTENDANCE_IMPORT_ASYNC_ENABLED', 'false')
  await plugin.activate({
    api: { database: db, events: { emit: async () => undefined }, http: {
      addRoute: (method: string, path: string, handler: (req: unknown, res: unknown) => Promise<void>) => {
        routes.set(`${method} ${path}`, handler)
      },
    } },
    logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
  })
})
beforeEach(() => {
  timezone = 'Asia/Shanghai'
  overrideTimezone = null
  groupRule = false
  published = null
  errors.length = 0
  db.query.mockClear()
  plugin.resetAttendanceSettingsCacheForTests()
})
afterAll(async () => {
  await plugin.deactivate()
  vi.unstubAllEnvs()
})

async function invokePreview(input: Record<string, unknown>) {
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  const handler = routes.get('POST /api/attendance/import/preview')
  expect(handler).toBeTypeOf('function')
  await handler!({
    user: { id: USER, orgId: ORG }, headers: {}, query: {}, params: {},
    body: { userId: USER, ...input },
  }, response)
  return response
}

async function preview(input: Record<string, unknown>, count = 1) {
  const response = await invokePreview(input)
  expect({ status: response.statusCode, errors, body: response.body }, JSON.stringify(response.body)).toMatchObject({
    status: 200, errors: [], body: { ok: true },
  })
  const body = response.body as { data: { items: Array<Record<string, unknown>> } }
  expect(body.data.items).toHaveLength(count)
  return body.data.items
}

describe('#6032 production preview date and punch parsing', () => {
  it('control: preserves date-only rows and naive rule-zone wall clocks', async () => {
    const [row] = await preview({ rows: [{ workDate: '2026-09-23', fields: { firstInAt: '2026-09-23 00:30:00' } }] })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
  })

  it('A: derives an entries occurredAt day in the rule IANA zone', async () => {
    const [row] = await preview({ entries: [{ userId: USER, occurredAt: INSTANT, field: 'firstInAt' }] })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
  })

  it('A: derives DingTalk column ISO dates in the rule IANA zone', async () => {
    const [row] = await preview({ columns: [{ id: 'in', alias: 'firstInAt' }], data: {
      userId: USER, column_vals: [{ column_vo: { id: 'in' }, column_vals: [{ date: INSTANT, value: INSTANT }] }],
    } })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
  })

  for (const digits of [10, 13]) {
    it(`B: derives JSON ${digits}-digit epoch workDate in the rule IANA zone`, async () => {
      const epoch = String(Date.parse(INSTANT) / (digits === 10 ? 1000 : 1))
      const [row] = await preview({ rows: [{ workDate: epoch, fields: { firstInAt: '00:30' } }] })
      expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
    })
  }

  for (const value of [INSTANT, '2026-09-23T00:30:00+08:00', '2026-09-22T09:30:00-07:00']) {
    it(`C: preserves the absolute punch instant of ${value}`, async () => {
      const [row] = await preview({ rows: [{ workDate: '2026-09-23', fields: { firstInAt: value } }] })
      expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
    })
  }
})

describe('#6032 calendar compatibility and coalescing', () => {
  it('uses the explicit rule-set zone ahead of the org and payload timezone', async () => {
    overrideTimezone = ' America/Los_Angeles '
    const [row] = await preview({ ruleSetId: RULE_SET, timezone: 'Pacific/Auckland', rows: [{
      workDate: '2026-09-23T00:30:00Z', fields: { firstInAt: '2026-09-23T00:30:00Z' },
    }] })
    expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T00:30:00.000Z' })
  })

  it('uses the row group rule-set override consistently for day and punch', async () => {
    overrideTimezone = 'America/Los_Angeles'
    groupRule = true
    const [row] = await preview({ rows: [{ workDate: '2026-09-23T00:30:00Z', fields: {
      attendanceGroup: 'synthetic group', firstInAt: '17:30',
    } }] })
    expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T00:30:00.000Z' })
  })

  it('keeps explicit calendar dates even when occurredAt is on another local day', async () => {
    const [row] = await preview({ entries: [{ workDate: '2026-09-22', occurredAt: INSTANT, field: 'firstInAt' }] })
    expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: INSTANT })
  })

  it('coalesces entries across a UTC midnight, keeps first values, and separates local days', async () => {
    const rows = await preview({ entries: [
      { occurredAt: INSTANT, field: 'firstInAt' },
      { occurredAt: '2026-09-23T02:30:00Z', field: 'lastOutAt' },
      { occurredAt: '2026-09-23T03:30:00Z', field: 'firstInAt' },
      { occurredAt: '2026-09-23T16:30:00Z', field: 'firstInAt' },
    ] }, 2)
    expect(rows.map(({ workDate, firstInAt, lastOutAt }) => ({ workDate, firstInAt, lastOutAt }))).toEqual([
      { workDate: '2026-09-23', firstInAt: INSTANT, lastOutAt: '2026-09-23T02:30:00.000Z' },
      { workDate: '2026-09-24', firstInAt: '2026-09-23T16:30:00.000Z', lastOutAt: null },
    ])
  })

  it('coalesces DingTalk columns after local-day normalization', async () => {
    const [row] = await preview({ columns: [{ id: 'in', alias: 'firstInAt' }, { id: 'out', alias: 'lastOutAt' }], data: {
      userId: USER, column_vals: [
        { column_vo: { id: 'in' }, column_vals: [{ date: INSTANT, value: INSTANT }] },
        { column_vo: { id: 'out' }, column_vals: [{ date: '2026-09-23T02:30:00Z', value: '2026-09-23T02:30:00Z' }] },
      ],
    } })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT, lastOutAt: '2026-09-23T02:30:00.000Z' })
  })

  it('preserves JSON duplicate detection after epoch normalization', async () => {
    const rows = await preview({ rows: [
      { workDate: String(Date.parse(INSTANT)), fields: { firstInAt: '00:30' } },
      { workDate: '2026-09-23', fields: { firstInAt: '00:30' } },
    ] }, 2)
    expect(rows[0]).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
    expect(rows[1]).toMatchObject({ workDate: '2026-09-23', status: 'invalid', firstInAt: null,
      warnings: ['Duplicate row for same user/workDate (skipped during commit).'],
    })
  })

  it('uses the org rule ahead of a conflicting payload timezone', async () => {
    const [row] = await preview({ timezone: 'America/Los_Angeles', entries: [{ occurredAt: INSTANT, field: 'firstInAt' }] })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
  })

  it('keeps date-only DingTalk columns and time-only punches on their calendar day', async () => {
    const [row] = await preview({ columns: [{ id: 'in', alias: 'firstInAt' }], data: {
      column_vals: [{ column_vo: { id: 'in' }, column_vals: [{ date: '2026-09-23', value: '00:30' }] }],
    } })
    expect(row).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT })
  })

  it('preserves absolute milliseconds and compact numeric offsets', async () => {
    const [row] = await preview({ rows: [{ workDate: '2026-09-23', fields: { firstInAt: '2026-09-22T22:00:00.123+0530' } }] })
    expect(row).toMatchObject({ firstInAt: '2026-09-22T16:30:00.123Z' })
  })
})

describe('#6032 multi-punch and DST compatibility', () => {
  it('keeps distinct DST-fold instants even when their local clocks match', async () => {
    timezone = 'America/New_York'
    const [row] = await preview({ rows: [{ workDate: '2026-11-01', fields: {
      firstInAt: '2026-11-01T01:30:00-04:00', lastOutAt: '2026-11-01T01:30:00-05:00',
    } }] })
    expect(row).toMatchObject({ firstInAt: '2026-11-01T05:30:00.000Z', lastOutAt: '2026-11-01T06:30:00.000Z' })
  })

  it('preserves absolute offsets in the second and third punch pairs through the production metadata builder', () => {
    const build = plugin.__attendanceReportFieldCatalogForTests.buildAttendanceImportMultiPunchMeta
    const meta = build({
      workDate: '2026-09-23', rule: { timezone: 'Asia/Shanghai' },
      valueFor: (key: string) => /^(?:clockIn|clockOut)[23]$/.test(key) ? '2026-09-22T09:30:00.123-07:00' : undefined,
    })
    for (const key of ['clockIn2', 'clockOut2', 'clockIn3', 'clockOut3']) {
      expect(meta[key]).toBe('2026-09-22T16:30:00.123Z')
    }
  })

  it('retains time-only overnight rollover in the production metadata builder', () => {
    const meta = plugin.__attendanceReportFieldCatalogForTests.buildAttendanceImportMultiPunchMeta({
      workDate: '2026-09-23', rule: { timezone: 'Asia/Shanghai', workStartTime: '22:00', workEndTime: '06:00', isOvernight: true },
      valueFor: (key: string) => key === 'clockIn2' ? '22:00' : key === 'clockOut2' ? '06:00' : undefined,
    })
    expect({ clockIn2: meta.clockIn2, clockOut2: meta.clockOut2 }).toEqual({
      clockIn2: '2026-09-23T14:00:00.000Z', clockOut2: '2026-09-23T22:00:00.000Z',
    })
  })
})

describe('#6032 published shift and rotation timezone', () => {
  for (const source of ['shift', 'rotation'] as const) {
    it(`${source}: control proves naive punches already use the published shift timezone`, async () => {
      published = source
      const [row] = await preview({ rows: [{ workDate: '2026-09-22', fields: { firstInAt: '19:30' } }] })
      expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T02:30:00.000Z' })
    })
    it(`${source}: instant work dates must use the same published timezone as punch parsing`, async () => {
      published = source
      const [row] = await preview({ entries: [{ occurredAt: '2026-09-23T02:30:00Z', field: 'firstInAt' }] })
      expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T02:30:00.000Z' })
    })
  }
})


describe('#6032 adjacent calendar source boundaries', () => {
  it('uses the one published local date ahead of an unscheduled rule-calendar alternative', async () => {
    published = 'single-day'
    const [row] = await preview({ entries: [{ occurredAt: '2026-09-23T02:30:00Z', field: 'firstInAt' }] })
    expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T02:30:00.000Z' })
  })
  it('refuses two viable published calendar dates with a fixed 422 response', async () => {
    published = 'ambiguous'
    const response = await invokePreview({ entries: [{ occurredAt: '2026-09-23T02:30:00Z', field: 'firstInAt' }] })
    expect(response.statusCode).toBe(422)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'IMPORT_CALENDAR_DATE_UNRESOLVED', message: 'Import calendar date could not be resolved uniquely',
    } })
    expect(errors).toEqual([])
  })
})


describe('#6032 calendar selection without calculation admission', () => {
  const instant = '2026-09-23T02:30:00.000Z'
  it('keeps rotation timezone ahead of a conflicting published assignment', async () => {
    published = 'both'
    const [row] = await preview({ entries: [{ occurredAt: instant, field: 'firstInAt' }] })
    expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: instant })
  })
  for (const kind of ['JSON10', 'JSON13', 'entries']) {
    const payload = () => kind === 'entries'
      ? { entries: [{ occurredAt: instant, field: 'firstInAt' }] }
      : { rows: [{ workDate: String(Date.parse(instant) / (kind === 'JSON10' ? 1000 : 1)), fields: { firstInAt: instant } }] }
    it(`${kind}: ignores the calculation gate on a nonmatching neighboring calendar`, async () => {
      published = 'neighbor-multi'
      const [row] = await preview(payload())
      expect(row).toMatchObject({ workDate: '2026-09-22', firstInAt: instant })
    })
    it(`${kind}: retains the exact calculation gate for the selected multi-segment shift`, async () => {
      published = 'matching-multi'
      const response = await invokePreview(payload())
      expect({ status: response.statusCode, body: response.body }).toEqual({ status: 422, body: { ok: false, error: {
        code: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
        message: 'Shift has 2 segments; authoritative segment calculation is disabled for this org, so attendance calculation cannot use a multi-segment shift',
        details: [{ field: 'shiftId', message: 'Multi-segment shift is authoring preview-only while segment calculation is disabled' }],
      } } })
      expect(errors).toEqual([])
    })
  }
})
