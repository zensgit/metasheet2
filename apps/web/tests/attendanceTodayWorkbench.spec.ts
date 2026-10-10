import { describe, expect, it } from 'vitest'
import {
  alignDefaultHistoryRangeToRuleToday,
  buildHeroTodayTimeline,
  canReuseAttendanceHistoryForToday,
  resolveDedicatedRequestWorkDate,
  selectTodayAttendanceRecord,
} from '../src/views/attendance/attendanceTodayWorkbench'

const TODAY = '2026-04-15'
const YESTERDAY = '2026-04-14'

const yesterdayComplete = {
  work_date: YESTERDAY,
  first_in_at: '2026-04-14T09:00:00+08:00',
  last_out_at: '2026-04-14T18:06:00+08:00',
  status: 'adjusted',
}
const yesterdayOpen = {
  work_date: YESTERDAY,
  first_in_at: '2026-04-14T09:00:00+08:00',
  last_out_at: null,
  status: 'partial',
}
const todayPartial = {
  work_date: TODAY,
  first_in_at: '2026-04-15T09:18:00+08:00',
  last_out_at: null,
  status: 'partial',
}

describe('selectTodayAttendanceRecord', () => {
  it('returns null when the range has only a historical row', () => {
    expect(selectTodayAttendanceRecord([yesterdayComplete], TODAY)).toBeNull()
    expect(selectTodayAttendanceRecord([yesterdayOpen], TODAY)).toBeNull()
    expect(selectTodayAttendanceRecord([], TODAY)).toBeNull()
    expect(selectTodayAttendanceRecord([yesterdayComplete], '')).toBeNull()
  })

  it('returns the row whose work_date is the rule-timezone today key', () => {
    expect(selectTodayAttendanceRecord([yesterdayComplete, todayPartial], TODAY)).toEqual(todayPartial)
    expect(selectTodayAttendanceRecord([todayPartial, yesterdayComplete], TODAY)).toEqual(todayPartial)
  })
})

describe('buildHeroTodayTimeline', () => {
  it('does not invent a timeline from a missing today row', () => {
    expect(buildHeroTodayTimeline(null, () => '09:00')).toBeNull()
  })

  it('keeps both punch polarities on today\'s row', () => {
    expect(buildHeroTodayTimeline(todayPartial, value => (value ? '09:18' : null))).toEqual({
      checkIn: '09:18',
      checkOut: null,
    })
  })
})

describe('resolveDedicatedRequestWorkDate', () => {
  it('uses the rule-timezone today key and never a historical work_date', () => {
    expect(resolveDedicatedRequestWorkDate(TODAY)).toBe(TODAY)
    expect(resolveDedicatedRequestWorkDate('  ')).toBe('')
    expect(resolveDedicatedRequestWorkDate(null)).toBe('')
  })
})

describe('alignDefaultHistoryRangeToRuleToday', () => {
  it('extends an untouched browser-local window so rule-timezone today is included', () => {
    expect(alignDefaultHistoryRangeToRuleToday({
      fromDate: '2026-03-16',
      toDate: '2026-04-15',
      todayKey: '2026-04-16',
      initialFromDate: '2026-03-16',
      initialToDate: '2026-04-15',
    })).toEqual({
      fromDate: '2026-03-16',
      toDate: '2026-04-16',
      changed: true,
    })
  })

  it('leaves a window that already contains today, or that the user changed', () => {
    expect(alignDefaultHistoryRangeToRuleToday({
      fromDate: '2026-03-16',
      toDate: '2026-04-15',
      todayKey: TODAY,
      initialFromDate: '2026-03-16',
      initialToDate: '2026-04-15',
    }).changed).toBe(false)

    expect(alignDefaultHistoryRangeToRuleToday({
      fromDate: '2026-04-01',
      toDate: '2026-04-10',
      todayKey: TODAY,
      initialFromDate: '2026-03-16',
      initialToDate: '2026-04-15',
    })).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-04-10',
      changed: false,
    })
  })
})


describe('canReuseAttendanceHistoryForToday', () => {
  const scope = { from: '2026-04-01', to: TODAY, page: 1, orgId: 'session-org', total: 35 }
  const reuse = (changes: Partial<typeof scope & { userId: string }>, count = 20, hasToday = false) =>
    canReuseAttendanceHistoryForToday({ ...scope, ...changes }, TODAY, 'session-org', 'self', count, hasToday)

  it('reuses an exact self today row or a complete self range, including verified absence', () => {
    expect(reuse({}, 20, true)).toBe(true)
    expect(reuse({ userId: 'self' }, 20, true)).toBe(true)
    expect(reuse({ total: 0 }, 0)).toBe(true)
    expect(reuse({ total: 2 }, 2)).toBe(true)
  })

  it('requires an extra read for historical, partial, other-user, or other-org pages', () => {
    expect(reuse({ to: YESTERDAY }, 20, true)).toBe(false)
    expect(reuse({ from: '2026-04-16' }, 20, true)).toBe(false)
    expect(reuse({ page: 2 }, 20, true)).toBe(false)
    expect(reuse({ userId: 'other' }, 20, true)).toBe(false)
    expect(reuse({ orgId: 'other-org' }, 20, true)).toBe(false)
    expect(reuse({})).toBe(false)
    expect(reuse({ total: NaN }, 0)).toBe(false)
    expect(canReuseAttendanceHistoryForToday(null, TODAY, 'session-org', 'self', 0, false)).toBe(false)
  })
})
