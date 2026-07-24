import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceLivePunchWorkDateForTests as {
  getPunchShiftWindow: (
    context: { rule?: Record<string, unknown> } | null,
    workDate: string,
    fallbackTimezone: string
  ) => { startAt: Date; endAt: Date; timezone: string; isOvernight: boolean } | null
  isPunchWithinShiftWindow: (
    occurredAt: Date,
    context: { rule?: Record<string, unknown> } | null,
    workDate: string,
    fallbackTimezone: string
  ) => boolean
  parseImportedPunchDateTimes: (options: Record<string, unknown>) => {
    firstInAt: Date | null
    lastOutAt: Date | null
  }
  resolvePunchWorkDateByShiftWindow: (options: Record<string, unknown>) => Promise<{
    workDate: string
    context: { rule?: Record<string, unknown> } | null
    timezone: string
  }>
}

function overnightRule(overrides: Record<string, unknown> = {}) {
  return {
    workStartTime: '22:00',
    workEndTime: '06:00',
    isOvernight: true,
    timezone: 'Asia/Shanghai',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  }
}

function dayRule(overrides: Record<string, unknown> = {}) {
  return {
    workStartTime: '09:00',
    workEndTime: '18:00',
    isOvernight: false,
    timezone: 'Asia/Shanghai',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  }
}

function morningRule(overrides: Record<string, unknown> = {}) {
  return {
    workStartTime: '06:00',
    workEndTime: '14:00',
    isOvernight: false,
    timezone: 'Asia/Shanghai',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  }
}

describe('attendance live punch work_date overnight anchoring helpers', () => {
  it('builds overnight windows that cross local midnight in Asia/Shanghai', () => {
    const window = helpers.getPunchShiftWindow({ rule: overnightRule() }, '2026-07-15', 'Asia/Shanghai')
    expect(window).not.toBeNull()
    expect(window?.isOvernight).toBe(true)
    expect(window?.startAt.toISOString()).toBe('2026-07-15T14:00:00.000Z') // 22:00 CST
    expect(window?.endAt.toISOString()).toBe('2026-07-15T22:00:00.000Z') // 06:00 CST next day
  })

  it('matches staging overnight check-in/out instants inside the D window', () => {
    const context = { rule: overnightRule() }
    const checkIn = new Date('2026-07-15T14:05:00.000Z') // D 22:05 CST
    const checkOut = new Date('2026-07-15T21:55:00.000Z') // D+1 05:55 CST
    expect(helpers.isPunchWithinShiftWindow(checkIn, context, '2026-07-15', 'Asia/Shanghai')).toBe(true)
    expect(helpers.isPunchWithinShiftWindow(checkOut, context, '2026-07-15', 'Asia/Shanghai')).toBe(true)
    // Calendar date alone would put check-out on D+1; D+1 overnight starts at 22:00 and must NOT match 05:55.
    expect(helpers.isPunchWithinShiftWindow(checkOut, context, '2026-07-16', 'Asia/Shanghai')).toBe(false)
  })

  it('does not reinterpret late/early scoring grace as a work-date association window', () => {
    const context = { rule: overnightRule({ lateGraceMinutes: 30, earlyGraceMinutes: 30 }) }
    expect(
      helpers.isPunchWithinShiftWindow(new Date('2026-07-15T22:05:00.000Z'), context, '2026-07-15', 'Asia/Shanghai')
    ).toBe(false)
  })

  it('does not treat an ordinary day shift as an overnight candidate', () => {
    const currentContext = { rule: dayRule() }
    const previousContext = { rule: dayRule() }
    const noon = new Date('2026-07-14T04:00:00.000Z') // 12:00 CST
    expect(helpers.isPunchWithinShiftWindow(noon, currentContext, '2026-07-14', 'Asia/Shanghai')).toBe(true)
    expect(helpers.isPunchWithinShiftWindow(noon, previousContext, '2026-07-13', 'Asia/Shanghai')).toBe(false)
    const previousWindow = helpers.getPunchShiftWindow(previousContext, '2026-07-13', 'Asia/Shanghai')
    expect(previousWindow?.isOvernight).toBe(false)
  })

  it('has an exact boundary where previous overnight and current morning windows overlap', () => {
    const previous = { rule: overnightRule() }
    const current = { rule: morningRule() }
    const overlap = new Date('2026-07-15T22:00:00.000Z') // D+1 06:00 CST
    expect(helpers.isPunchWithinShiftWindow(overlap, previous, '2026-07-15', 'Asia/Shanghai')).toBe(true)
    expect(helpers.isPunchWithinShiftWindow(overlap, current, '2026-07-16', 'Asia/Shanghai')).toBe(true)
  })

  it('maps time-only overnight import punches onto D and D+1 consistently', () => {
    const parsed = helpers.parseImportedPunchDateTimes({
      firstInValue: '22:00',
      lastOutValue: '06:00',
      workDate: '2026-07-24',
      rule: overnightRule(),
    })
    expect(parsed.firstInAt?.toISOString()).toBe('2026-07-24T14:00:00.000Z')
    expect(parsed.lastOutAt?.toISOString()).toBe('2026-07-24T22:00:00.000Z')

    const explicitDates = helpers.parseImportedPunchDateTimes({
      firstInValue: '2026-07-24 22:00',
      lastOutValue: '2026-07-25 06:00',
      workDate: '2026-07-24',
      rule: overnightRule(),
    })
    expect(explicitDates.firstInAt?.toISOString()).toBe('2026-07-24T14:00:00.000Z')
    expect(explicitDates.lastOutAt?.toISOString()).toBe('2026-07-24T22:00:00.000Z')
  })

  it('resolvePunchWorkDateByShiftWindow re-anchors only when current misses and previous overnight matches', async () => {
    const currentContext = { rule: overnightRule() } // D+1 same overnight profile (starts 22:00) — 05:55 misses
    const previousContext = { rule: overnightRule() }
    // W2 shared resolver loads published candidates (org-scoped join). Mock both
    // candidate loaders and resolveWorkContext fallbacks.
    const nightAssignment = {
      assignment_id: 'asg-prev',
      org_id: 'default',
      user_id: 'u1',
      shift_id: 'sh-overnight',
      slot_index: 0,
      start_date: '2026-07-15',
      end_date: '2026-07-16',
      is_active: true,
      publish_status: 'published',
      assignment_kind: 'regular',
      shift_name: 'Night',
      shift_timezone: 'Asia/Shanghai',
      shift_work_start_time: '22:00',
      shift_work_end_time: '06:00',
      shift_is_overnight: true,
      shift_segment_count: 1,
    }
    const fakeDb = {
      query: async (sql: string, params?: unknown[]) => {
        const text = String(sql)
        if (text.includes('FROM attendance_shifts s') && text.includes('s.id = $1 AND s.org_id = $2')) {
          if (params?.[0] === 'sh-overnight' && params?.[1] === 'default') {
            return [{
              id: 'sh-overnight',
              org_id: 'default',
              name: 'Night',
              timezone: 'Asia/Shanghai',
              work_start_time: '22:00',
              work_end_time: '06:00',
              is_overnight: true,
              late_grace_minutes: 10,
              early_grace_minutes: 10,
              rounding_minutes: 5,
              working_days: [1, 2, 3, 4, 5],
              segment_count: 1,
            }]
          }
          return []
        }
        if (text.includes('FROM attendance_shift_assignments') && text.includes('JOIN attendance_shifts')) {
          // Candidate loader returns the overnight assignment covering both dates.
          return [nightAssignment]
        }
        if (text.includes('attendance_shift_assignments')) {
          // resolveWorkContext LIMIT 1 path
          const workDate = String(params?.[2] ?? '')
          if (workDate === '2026-07-15' || workDate === '2026-07-16') {
            return [{
              id: 'asg-prev',
              org_id: 'default',
              user_id: 'u1',
              shift_id: 'sh-overnight',
              slot_index: 0,
              start_date: '2026-07-15',
              end_date: null,
              is_active: true,
              publish_status: 'published',
              shift_name: 'Night',
              shift_timezone: 'Asia/Shanghai',
              shift_work_start_time: '22:00',
              shift_work_end_time: '06:00',
              shift_is_overnight: true,
              shift_late_grace_minutes: 10,
              shift_early_grace_minutes: 10,
              shift_rounding_minutes: 5,
              shift_working_days: [1, 2, 3, 4, 5],
              shift_segment_count: 1,
            }]
          }
          return []
        }
        if (text.includes('attendance_holidays')) return []
        if (text.includes('attendance_rotation')) return []
        if (text.includes('attendance_records')) return []
        if (text.includes('attendance_requests')) return []
        if (text.includes('system_configs') || text.includes('attendance.settings')) return []
        return []
      },
    }

    const checkOut = new Date('2026-07-15T21:55:00.000Z') // calendar D+1 05:55 CST
    const resolved = await helpers.resolvePunchWorkDateByShiftWindow({
      db: fakeDb,
      orgId: 'default',
      userId: 'u1',
      occurredAt: checkOut,
      workDate: '2026-07-16',
      context: currentContext,
      defaultRule: dayRule({ timezone: 'Asia/Shanghai' }),
      timezone: 'Asia/Shanghai',
    })
    expect(resolved.workDate).toBe('2026-07-15')
    expect(resolved.context).toBeTruthy()
    expect(resolved.timezone).toBe('Asia/Shanghai')

    // Current already matches → no previous-day steal.
    const sameDayCheckIn = new Date('2026-07-15T14:05:00.000Z')
    const stays = await helpers.resolvePunchWorkDateByShiftWindow({
      db: fakeDb,
      orgId: 'default',
      userId: 'u1',
      occurredAt: sameDayCheckIn,
      workDate: '2026-07-15',
      context: previousContext,
      defaultRule: dayRule({ timezone: 'Asia/Shanghai' }),
      timezone: 'Asia/Shanghai',
    })
    expect(stays.workDate).toBe('2026-07-15')
  })

  it('negative control: without overnight previous assignment, post-midnight punch keeps calendar date', async () => {
    const currentContext = { rule: dayRule({ workStartTime: '09:00', workEndTime: '18:00' }) }
    const fakeDb = {
      query: async (sql: string) => {
        if (String(sql).includes('attendance_shift_assignments')) return []
        if (String(sql).includes('attendance_holidays')) return []
        if (String(sql).includes('attendance_rotation')) return []
        if (String(sql).includes('attendance_records')) return []
        if (String(sql).includes('attendance_requests')) return []
        return []
      },
    }
    const earlyMorning = new Date('2026-07-15T21:55:00.000Z') // 05:55 CST on calendar 2026-07-16
    const resolved = await helpers.resolvePunchWorkDateByShiftWindow({
      db: fakeDb,
      orgId: 'default',
      userId: 'u1',
      occurredAt: earlyMorning,
      workDate: '2026-07-16',
      context: currentContext,
      defaultRule: dayRule({ timezone: 'Asia/Shanghai' }),
      timezone: 'Asia/Shanghai',
    })
    expect(resolved.workDate).toBe('2026-07-16')
  })

  it('rejects malformed cross-org candidates instead of falling back to the calendar date', async () => {
    const fakeDb = {
      query: async (sql: string) => {
        const text = String(sql)
        if (text.includes('FROM attendance_shift_assignments') && text.includes('JOIN attendance_shifts')) {
          return [{
            assignment_id: 'asg-foreign',
            org_id: 'foreign-org',
            user_id: 'u1',
            shift_id: 'sh-foreign',
            slot_index: 0,
            start_date: '2026-07-16',
            end_date: null,
            is_active: true,
            publish_status: 'published',
            assignment_kind: 'regular',
            shift_name: 'Foreign',
            shift_timezone: 'Asia/Shanghai',
            shift_work_start_time: '09:00',
            shift_work_end_time: '18:00',
            shift_is_overnight: false,
          }]
        }
        if (text.includes('attendance_rotation')) return []
        if (text.includes('attendance_records')) return []
        if (text.includes('attendance_requests')) return []
        if (text.includes('system_configs') || text.includes('attendance.settings')) return []
        return []
      },
    }

    await expect(
      helpers.resolvePunchWorkDateByShiftWindow({
        db: fakeDb,
        orgId: 'default',
        userId: 'u1',
        occurredAt: new Date('2026-07-16T02:00:00.000Z'),
        workDate: '2026-07-16',
        context: { rule: dayRule() },
        defaultRule: dayRule(),
        timezone: 'Asia/Shanghai',
      })
    ).rejects.toMatchObject({
      status: 422,
      code: 'WORK_DATE_ATTRIBUTION_UNRESOLVED',
    })
  })
})
