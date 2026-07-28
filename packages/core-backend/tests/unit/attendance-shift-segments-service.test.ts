/**
 * W3 / #4556 — canonical attendance shift service unit coverage.
 *
 * Mutation-sensitive legs (design lock section 7.4):
 * - first-to-last arithmetic must never replace the per-segment sum
 *   (plannedMinutes leg below fails if breaks are counted);
 * - removing one segment from the sum changes plannedMinutes;
 * - dropping the org scope from the capability flag check flips org isolation;
 * - accepting more than one midnight crossing / overlapping segments must fail.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

const shiftServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-shift-service.cjs') as {
  SEGMENT_CALCULATION_FLAG_ENV: string
  SHIFT_REFERENCE_DELETED_LABEL: string
  SHIFT_SERVICE_ERROR: Record<string, string>
  createAttendanceShiftService: (deps: Record<string, unknown>) => any
}

class FakeHttpError extends Error {
  status: number
  code: string
  details: Array<{ field: string; message: string }> | undefined

  constructor(status: number, code: string, message: string, details: Array<{ field: string; message: string }> | null = null) {
    super(message)
    this.status = status
    this.code = code
    if (Array.isArray(details) && details.length > 0) this.details = details
  }
}

function makeService() {
  return shiftServiceLib.createAttendanceShiftService({
    HttpError: FakeHttpError,
    randomUUID,
    resolveShiftTiming: () => {
      throw new Error('resolveShiftTiming must not be called in these tests')
    },
    normalizeWorkingDays: (value: unknown) => value,
    mapShiftRow: (row: Record<string, unknown>) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      timezone: row.timezone,
      workStartTime: row.work_start_time,
      workEndTime: row.work_end_time,
      isOvernight: row.is_overnight,
    }),
    DEFAULT_SHIFT: { name: 'Default', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', lateGraceMinutes: 10, earlyGraceMinutes: 10, roundingMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
    DEFAULT_ORG_ID: 'default',
  })
}

const service = makeService()
const ERR = shiftServiceLib.SHIFT_SERVICE_ERROR
const FLAG = shiftServiceLib.SEGMENT_CALCULATION_FLAG_ENV

function expectSegmentsInvalid(input: unknown, fieldFragment: string) {
  try {
    service.validateShiftSegments(input)
  } catch (error) {
    const typed = error as FakeHttpError
    expect(typed).toBeInstanceOf(FakeHttpError)
    expect(typed.status).toBe(422)
    expect(typed.code).toBe(ERR.SEGMENTS_INVALID)
    expect((typed.details ?? []).some((detail) => detail.field.includes(fieldFragment))).toBe(true)
    return
  }
  expect.unreachable(`expected validateShiftSegments to reject: ${JSON.stringify(input)}`)
}

afterEach(() => {
  delete process.env[FLAG]
})

describe('validateShiftSegments', () => {
  it('accepts a single plain segment', () => {
    const segments = service.validateShiftSegments([{ startTime: '09:00', endTime: '18:00' }])
    expect(segments).toEqual([{ segmentIndex: 0, startTime: '09:00', startDayOffset: 0, endTime: '18:00', endDayOffset: 0 }])
  })

  it('accepts 08:00-12:00 plus 13:00-17:00 (touching allowed, overlap rejected)', () => {
    const segments = service.validateShiftSegments([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '13:00', endTime: '17:00' },
    ])
    expect(segments).toHaveLength(2)
    expect(service.validateShiftSegments([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '13:00' },
    ])).toHaveLength(2)
  })

  it('accepts three dense segments and one overnight crossing as the last segment', () => {
    expect(service.validateShiftSegments([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '13:00', endTime: '17:00' },
      { startTime: '19:00', endTime: '23:00' },
    ])).toHaveLength(3)
    expect(service.validateShiftSegments([
      { startTime: '22:00', endTime: '02:00', endDayOffset: 1 },
    ])).toHaveLength(1)
  })

  it('rejects zero and four segments', () => {
    expectSegmentsInvalid([], 'segments')
    expectSegmentsInvalid([
      { startTime: '01:00', endTime: '02:00' },
      { startTime: '03:00', endTime: '04:00' },
      { startTime: '05:00', endTime: '06:00' },
      { startTime: '07:00', endTime: '08:00' },
    ], 'segments')
  })

  it('rejects non-dense segmentIndex and unknown shapes', () => {
    expectSegmentsInvalid([{ segmentIndex: 1, startTime: '08:00', endTime: '12:00' }], 'segments.0.segmentIndex')
    expectSegmentsInvalid('not-an-array', 'segments')
    expectSegmentsInvalid([null], 'segments.0')
  })

  it('rejects malformed times and non-v1 day offsets', () => {
    expectSegmentsInvalid([{ startTime: '8am', endTime: '12:00' }], 'segments.0.startTime')
    expectSegmentsInvalid([{ startTime: '25:00', endTime: '26:00' }], 'segments.0.startTime')
    expectSegmentsInvalid([{ startTime: '09:00:59', endTime: '10:00:59' }], 'segments.0.startTime')
    expectSegmentsInvalid([{ startTime: '09:00', endTime: '10:00:59' }], 'segments.0.endTime')
    expectSegmentsInvalid([{ startTime: '08:00', endTime: '12:00', startDayOffset: 1 }], 'segments.0.startDayOffset')
    expectSegmentsInvalid([{ startTime: '08:00', endTime: '12:00', endDayOffset: 2 }], 'segments.0.endDayOffset')
  })

  it('rejects zero/negative duration per segment', () => {
    expectSegmentsInvalid([{ startTime: '09:00', endTime: '09:00' }], 'segments.0.endTime')
    expectSegmentsInvalid([{ startTime: '18:00', endTime: '09:00' }], 'segments.0.endTime')
  })

  it('rejects overlapping and unordered absolute intervals', () => {
    expectSegmentsInvalid([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '11:00', endTime: '15:00' },
    ], 'segments.1.startTime')
    expectSegmentsInvalid([
      { startTime: '13:00', endTime: '17:00' },
      { startTime: '08:00', endTime: '12:00' },
    ], 'segments.1.startTime')
    // An overnight first segment pushes the next segment into the same crossing.
    expectSegmentsInvalid([
      { startTime: '22:00', endTime: '02:00', endDayOffset: 1 },
      { startTime: '03:00', endTime: '05:00', endDayOffset: 1 },
    ], 'segments')
  })

  it('rejects more than one midnight crossing and a total over 24 hours', () => {
    expectSegmentsInvalid([
      { startTime: '20:00', endTime: '23:00', endDayOffset: 1 },
      { startTime: '23:30', endTime: '01:00', endDayOffset: 1 },
    ], 'segments')
    expectSegmentsInvalid([
      { startTime: '00:00', endTime: '23:59', endDayOffset: 1 },
    ], 'segments')
  })
})

describe('deriveEnvelopeFromSegments', () => {
  it('sums per-segment minutes and never counts the break (480, not 540)', () => {
    const envelope = service.deriveEnvelopeFromSegments([
      { segmentIndex: 0, startTime: '08:00', startDayOffset: 0, endTime: '12:00', endDayOffset: 0 },
      { segmentIndex: 1, startTime: '13:00', startDayOffset: 0, endTime: '17:00', endDayOffset: 0 },
    ])
    expect(envelope).toEqual({ workStartTime: '08:00', workEndTime: '17:00', isOvernight: false, plannedMinutes: 480 })
  })

  it('dropping a segment from the sum changes plannedMinutes (mutation leg)', () => {
    const two = service.deriveEnvelopeFromSegments([
      { segmentIndex: 0, startTime: '08:00', startDayOffset: 0, endTime: '12:00', endDayOffset: 0 },
      { segmentIndex: 1, startTime: '13:00', startDayOffset: 0, endTime: '17:00', endDayOffset: 0 },
    ])
    const one = service.deriveEnvelopeFromSegments([
      { segmentIndex: 0, startTime: '08:00', startDayOffset: 0, endTime: '12:00', endDayOffset: 0 },
    ])
    expect(two.plannedMinutes - one.plannedMinutes).toBe(240)
  })

  it('marks the envelope overnight when a segment crosses midnight', () => {
    const envelope = service.deriveEnvelopeFromSegments([
      { segmentIndex: 0, startTime: '22:00', startDayOffset: 0, endTime: '02:00', endDayOffset: 1 },
    ])
    expect(envelope).toEqual({ workStartTime: '22:00', workEndTime: '02:00', isOvernight: true, plannedMinutes: 240 })
  })
})

describe('synthesizeSegmentsFromEnvelope (legacy dual-read)', () => {
  it('synthesizes segment 0 from the legacy envelope, including overnight rows', () => {
    expect(service.synthesizeSegmentsFromEnvelope({ work_start_time: '09:00:00', work_end_time: '18:00:00', is_overnight: false }))
      .toEqual([{ id: null, segmentIndex: 0, startTime: '09:00', startDayOffset: 0, endTime: '18:00', endDayOffset: 0 }])
    expect(service.synthesizeSegmentsFromEnvelope({ work_start_time: '22:00:00', work_end_time: '06:00:00', is_overnight: true }))
      .toEqual([{ id: null, segmentIndex: 0, startTime: '22:00', startDayOffset: 0, endTime: '06:00', endDayOffset: 1 }])
  })
})

describe('capability projection and org-scoped flag', () => {
  it('is OFF by default with an explicit values-safe capability block', () => {
    const capabilities = service.buildShiftCapabilities('org-a')
    expect(capabilities).toEqual({
      segmentCalculation: {
        enabled: false,
        defaultEnabled: false,
        authoritativeResults: false,
        multiSegmentAuthoring: 'preview_only',
        flag: 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
      },
    })
    expect(JSON.stringify(capabilities)).not.toContain('org-a')
  })

  it('does not let an env value claim W4 capability before the calculator exists', () => {
    process.env[FLAG] = ' org-a , org-b '
    expect(service.isSegmentCalculationEnabled('org-a')).toBe(false)
    expect(service.isSegmentCalculationEnabled('org-b')).toBe(false)
    expect(service.isSegmentCalculationEnabled('org-c')).toBe(false)
    process.env[FLAG] = '*'
    expect(service.isSegmentCalculationEnabled('org-c')).toBe(false)
    expect(service.buildShiftCapabilities('org-c').segmentCalculation).toMatchObject({
      enabled: false,
      authoritativeResults: false,
      multiSegmentAuthoring: 'preview_only',
    })
  })
})

describe('assertShiftSequenceReferenceAllowed (global lock order and legacy names)', () => {
  const LOW_ID = '11111111-1111-4111-8111-111111111111'
  const HIGH_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

  function sequenceTrx(rows: Array<{ id: string; name: string }>, segmentCounts: Record<string, number>) {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    return {
      calls,
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('FROM attendance_shifts')) return rows
        if (sql.includes('FROM attendance_shift_segments')) {
          return [{ total: segmentCounts[String(params[1])] ?? 0 }]
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }
  }

  it('locks mixed UUID/name matches in one globally ordered FOR SHARE query', async () => {
    const trx = sequenceTrx(
      [{ id: LOW_ID, name: 'Legacy' }, { id: HIGH_ID, name: 'High' }],
      { [LOW_ID]: 1, [HIGH_ID]: 1 },
    )
    await service.assertShiftSequenceReferenceAllowed(trx, {
      orgId: 'org-a',
      shiftRefs: [HIGH_ID, 'Legacy'],
      producer: 'rotation_rule_update',
    })
    expect(trx.calls[0]!.sql).toContain('ORDER BY id')
    expect(trx.calls[0]!.sql).toContain('FOR SHARE')
    expect(trx.calls.slice(1).map((call) => call.params[1])).toEqual([LOW_ID, HIGH_ID])
  })

  it('checks every ambiguous legacy-name match and rejects when any is multi-segment', async () => {
    const trx = sequenceTrx(
      [{ id: LOW_ID, name: 'Duplicate' }, { id: HIGH_ID, name: 'Duplicate' }],
      { [LOW_ID]: 1, [HIGH_ID]: 2 },
    )
    await expect(service.assertShiftSequenceReferenceAllowed(trx, {
      orgId: 'org-a',
      shiftRefs: ['Duplicate'],
      producer: 'rotation_assignment_create',
    })).rejects.toMatchObject({
      status: 422,
      code: ERR.MULTI_SEGMENT_CALCULATION_DISABLED,
    })
  })
})

describe('mapShiftWithSegments (dual-read)', () => {
  const shiftRow = {
    id: 'shift-1',
    org_id: 'org-a',
    name: 'Split',
    timezone: 'Asia/Shanghai',
    work_start_time: '08:00:00',
    work_end_time: '17:00:00',
    is_overnight: false,
  }

  it('synthesizes segment 0 for a legacy row without segment rows', () => {
    const dto = service.mapShiftWithSegments(shiftRow, [], 'org-a')
    expect(dto.calculationMode).toBe('envelope')
    expect(dto.segments).toHaveLength(1)
    expect(dto.segments[0]).toMatchObject({ id: null, segmentIndex: 0, startTime: '08:00', endTime: '17:00', endDayOffset: 0 })
    expect(dto.plannedMinutes).toBe(540)
  })

  it('prefers persisted segment rows and marks calculationMode=segments', () => {
    const dto = service.mapShiftWithSegments(shiftRow, [
      { id: 'seg-1', segment_index: 0, start_time: '08:00:00', start_day_offset: 0, end_time: '12:00:00', end_day_offset: 0 },
      { id: 'seg-2', segment_index: 1, start_time: '13:00:00', start_day_offset: 0, end_time: '17:00:00', end_day_offset: 0 },
    ], 'org-a')
    expect(dto.calculationMode).toBe('segments')
    expect(dto.segments.map((segment: { id: string }) => segment.id)).toEqual(['seg-1', 'seg-2'])
    expect(dto.plannedMinutes).toBe(480)
    // Legacy envelope fields pass through mapShiftRow unchanged (pre-existing behavior).
    expect(dto.workStartTime).toBe('08:00:00')
    expect(dto.workEndTime).toBe('17:00:00')
  })
})

describe('assertShiftReferenceAllowed (canonical assignability guard)', () => {
  const SHIFT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  function fakeTrx({ shiftRows, segmentCount }: { shiftRows: Array<Record<string, unknown>>; segmentCount: number }) {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    return {
      calls,
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('FROM attendance_shifts')) return shiftRows
        if (sql.includes('FROM attendance_shift_segments')) return [{ total: segmentCount }]
        throw new Error(`unexpected query: ${sql}`)
      },
    }
  }

  it('throws 404 when the shift does not exist in the org', async () => {
    const trx = fakeTrx({ shiftRows: [], segmentCount: 0 })
    await expect(service.assertShiftReferenceAllowed(trx, { orgId: 'org-a', shiftId: SHIFT_ID, producer: 'assignment_create' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('locks the shift row FOR SHARE (shared delete/reference lock protocol)', async () => {
    const trx = fakeTrx({ shiftRows: [{ id: SHIFT_ID }], segmentCount: 1 })
    await service.assertShiftReferenceAllowed(trx, { orgId: 'org-a', shiftId: SHIFT_ID, producer: 'assignment_create' })
    expect(trx.calls[0]!.sql).toContain('FOR SHARE')
  })

  it('keeps the segment-count read org-scoped', async () => {
    const trx = fakeTrx({ shiftRows: [{ id: SHIFT_ID }], segmentCount: 1 })
    await service.assertShiftReferenceAllowed(trx, { orgId: 'org-a', shiftId: SHIFT_ID, producer: 'assignment_create' })
    const segmentRead = trx.calls.find((call) => call.sql.includes('FROM attendance_shift_segments'))
    expect(segmentRead?.sql).toContain('org_id = $1')
    expect(segmentRead?.sql).toContain('shift_id = $2')
    expect(segmentRead?.params).toEqual(['org-a', SHIFT_ID])
  })

  it('fails closed with a typed 422 for a multi-segment shift while the flag is OFF', async () => {
    const trx = fakeTrx({ shiftRows: [{ id: SHIFT_ID }], segmentCount: 2 })
    await expect(service.assertShiftReferenceAllowed(trx, { orgId: 'org-a', shiftId: SHIFT_ID, producer: 'assignment_create' }))
      .rejects.toMatchObject({ status: 422, code: ERR.MULTI_SEGMENT_CALCULATION_DISABLED })
  })

  it('fails closed when a calculation caller cannot prove the persisted segment count', () => {
    expect(() => service.assertSegmentCalculationAllowed({
      orgId: 'org-a',
      shiftId: SHIFT_ID,
      segmentCount: null,
      producer: 'attendance calculation',
    })).toThrow(expect.objectContaining({
      status: 422,
      code: ERR.MULTI_SEGMENT_CALCULATION_DISABLED,
    }))
  })

  it('keeps multi-segment references blocked when W3 is misconfigured with the future flag', async () => {
    process.env[FLAG] = 'org-a'
    const trx = fakeTrx({ shiftRows: [{ id: SHIFT_ID }], segmentCount: 3 })
    await expect(service.assertShiftReferenceAllowed(trx, { orgId: 'org-a', shiftId: SHIFT_ID, producer: 'assignment_create' }))
      .rejects.toMatchObject({ status: 422, code: ERR.MULTI_SEGMENT_CALCULATION_DISABLED })
  })
})

describe('applyShiftReferenceLabels (historical evidence reads)', () => {
  it('redacts an unresolvable shift id and never leaks the raw UUID', () => {
    const deletedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const rows = [{ requesterShiftId: deletedId }, { requesterShiftId: 'kept' }]
    const lookup = new Map([['kept', 'Day Shift']])
    service.applyShiftReferenceLabels(rows, lookup, [{ idField: 'requesterShiftId', labelField: 'requesterShiftLabel', statusField: 'requesterShiftStatus' }])
    expect(rows[0]).toEqual({
      requesterShiftId: null,
      requesterShiftLabel: shiftServiceLib.SHIFT_REFERENCE_DELETED_LABEL,
      requesterShiftStatus: 'deleted',
    })
    expect(JSON.stringify(rows)).not.toContain(deletedId)
    expect(rows[1]).toEqual({ requesterShiftId: 'kept', requesterShiftLabel: 'Day Shift', requesterShiftStatus: 'available' })
  })
})
