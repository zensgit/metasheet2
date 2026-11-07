import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const { createAttendanceTimezoneRuntime } = createRequire(import.meta.url)(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs',
)
const orgId = 'segment-unit-org', userId = 'segment-unit-user', workDate = '2026-10-27'
const occurredAt = new Date(workDate + 'T14:00:00.000Z')
const boundaryWorkDates = ['2026-10-24', '2026-10-25', '2026-10-26', workDate, '2026-10-28']
const negativeValues = [false, undefined, null, 'true', 1] as const
const policySql = 'SELECT enabled, version FROM attendance_timezone_policies WHERE org_id = $1'
const defaultSql = 'SELECT id, timezone, timezone_version FROM attendance_rules WHERE org_id = $1 AND is_default = true'
const runtimeDefaultSql = 'SELECT * FROM attendance_rules WHERE org_id=$1 AND is_default=true'
const repairSql = "SELECT c.* FROM attendance_timezone_context_companions c JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id WHERE c.org_id=$1 AND c.user_id=$2 AND r.visibility_state='active' AND c.frame_snapshot->'identity'->>'source'='legacy_repair' AND r.last_out_at IS NULL AND c.attribution_start_at <= $3 AND $3 <= CASE WHEN $4='check_in' THEN c.absolute_end_at ELSE c.attribution_end_at END"

class RuntimeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

function fixture(hint: unknown, referenceSegments?: unknown) {
  const defaultRow = { id: 'default-rule', org_id: orgId, is_default: true, timezone: 'UTC',
    timezone_version: 1, work_start_time: '08:00', work_end_time: '17:00', is_overnight: false }
  const rule = { id: defaultRow.id, timezone: defaultRow.timezone, workStartTime: defaultRow.work_start_time,
    workEndTime: defaultRow.work_end_time, isOvernight: false, workingDays: [0, 1, 2, 3, 4, 5, 6] }
  const query = vi.fn(async (sql: string, _values: readonly unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === repairSql || normalized === policySql) return []
    if (normalized === defaultSql || normalized === runtimeDefaultSql) return [defaultRow]
    throw new Error('UNEXPECTED_RUNTIME_UNIT_SQL')
  })
  const trx = { query }
  const mayResolveSegmentSelectionPosture = vi.fn((_org: string) => hint)
  const resolveSegmentSelectionPosture = vi.fn(async (_trx: unknown, _org: string) => ({ referenceSegments }))
  const readCalculationDefinition = vi.fn(), loadShiftById = vi.fn(), loadCalendarOverrides = vi.fn()
  const resolveRuleContext = vi.fn(), acquireRuntimeLocks = vi.fn(async () => undefined)
  const loadPublishedCandidates = vi.fn(async () => [
    { orgId, userId, workDate, source: 'shift', shiftId: 'split', assignmentId: 'assignment-split',
      segmentIndex: null, workStartTime: '08:00', workEndTime: '17:00', isOvernight: false },
    { orgId, userId, workDate, source: 'shift', shiftId: 'narrow', assignmentId: 'assignment-narrow',
      segmentIndex: null, workStartTime: '13:00', workEndTime: '15:00', isOvernight: false },
  ])
  const runtime = createAttendanceTimezoneRuntime({
    HttpError: RuntimeError, mayResolveSegmentSelectionPosture, resolveSegmentSelectionPosture,
    readCalculationDefinition, loadShiftById, loadCalendarOverrides, resolveRuleContext,
    acquireRuntimeLocks, loadPublishedCandidates,
    loadAttributionTail: async () => 0, loadApprovedOvertime: async () => [],
    mapRuleRow: (row: typeof defaultRow) => { expect(row).toEqual(defaultRow); return rule },
    resolveLocalWallTime: resolveAttendanceLocalWallTimeV1,
    validateIanaTimezone: validateAttendanceIanaTimezoneV1,
    addDaysToDateKey: (date: string, days: number) => {
      if (date !== workDate || ![-3, -2, -1, 0, 1].includes(days)) throw new Error('UNEXPECTED_DATE_INPUT')
      return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
    },
    toWorkDate: (date: Date, timezone: string) => {
      if (timezone !== 'UTC' || date.getTime() !== occurredAt.getTime()) throw new Error('UNEXPECTED_ZONE_DATE_INPUT')
      return date.toISOString().slice(0, 10)
    },
    normalizeTimeString: (time: string) => {
      if (!['08:00', '17:00', '13:00', '15:00'].includes(time)) throw new Error('UNEXPECTED_TIME_INPUT')
      return time
    },
    resolveOvernightFlag: (flag: boolean) => {
      if (flag !== false) throw new Error('UNEXPECTED_OVERNIGHT_INPUT')
      return false
    },
  })
  return { runtime, trx, query, mayResolveSegmentSelectionPosture, resolveSegmentSelectionPosture,
    readCalculationDefinition, loadShiftById, loadCalendarOverrides, resolveRuleContext,
    acquireRuntimeLocks, loadPublishedCandidates }
}

async function expectFailure(f: ReturnType<typeof fixture>, status = 409, code = 'ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS') {
  const failure = await f.runtime.prepareLivePunch(f.trx, { orgId, userId, occurredAt, eventType: 'check_in' }).then(
    () => { throw new Error('EXPECTED_RUNTIME_REJECTION') },
    (error: unknown) => {
      if (!(error instanceof RuntimeError)) throw error
      return { status: error.status, code: error.code, message: error.message }
    },
  )
  expect(failure).toEqual({ status, code, message: code })
  expect(f.mayResolveSegmentSelectionPosture.mock.calls).toEqual([[orgId]])
  expect(f.acquireRuntimeLocks).toHaveBeenCalledTimes(1)
  expect(f.acquireRuntimeLocks).toHaveBeenCalledWith(f.trx, { orgId, userId, mode: 'shared' })
  expect(f.loadPublishedCandidates).toHaveBeenCalledTimes(1)
  expect(f.loadPublishedCandidates).toHaveBeenCalledWith(f.trx, {
    orgId, userId, workDates: boundaryWorkDates, lockScheduleFacts: true, strictSources: true,
  })
  expect(f.query.mock.calls.map(([sql, values]) => [sql.replace(/\s+/g, ' ').trim(), values])).toEqual([
    [repairSql, [orgId, userId, occurredAt, 'check_in']],
    ...Array.from({ length: 5 }, () => [[policySql, [orgId]], [defaultSql, [orgId]]]).flat(),
    [runtimeDefaultSql, [orgId]],
  ])
  for (const read of [f.readCalculationDefinition, f.loadShiftById, f.loadCalendarOverrides, f.resolveRuleContext]) {
    expect(read).toHaveBeenCalledTimes(0)
  }
}

// Mock callback/SQL dispatch evidence only; native PostgreSQL coverage is separate.
describe('attendance segment selection runtime OFF/admission callback guard', () => {
  it.each(negativeValues)('OFF hint %s never calls the strict posture resolver and retains W2 ambiguity', async value => {
    const f = fixture(value)
    await expectFailure(f)
    expect(f.resolveSegmentSelectionPosture).toHaveBeenCalledTimes(0)
  })

  it.each(negativeValues)('true hint with referenceSegments %s reads posture once but admits no segment sources', async value => {
    const f = fixture(true, value)
    await expectFailure(f)
    expect(f.resolveSegmentSelectionPosture.mock.calls).toEqual([[f.trx, orgId]])
    expect(f.resolveSegmentSelectionPosture.mock.calls[0][0]).toBe(f.trx)
  })

  it('true hint with a private resolver failure returns fixed source-unavailable 503 without definition reads', async () => {
    const f = fixture(true)
    f.resolveSegmentSelectionPosture.mockRejectedValueOnce(new Error('PRIVATE_POSTURE_SENTINEL'))
    await expectFailure(f, 503, 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE')
    expect(f.resolveSegmentSelectionPosture.mock.calls).toEqual([[f.trx, orgId]])
    expect(f.resolveSegmentSelectionPosture.mock.calls[0][0]).toBe(f.trx)
  })
})
