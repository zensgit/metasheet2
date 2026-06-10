import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeSegmentationForTests

const item = (partial: Record<string, unknown>) => ({
  date: '2026-10-01',
  base: { source: 'rule', isWorkingDay: true },
  effective: { source: 'rule', isWorkingDay: true },
  layers: [],
  ...partial,
})

const holidayItem = (partial: Record<string, unknown> = {}) => item({
  base: { source: 'national', isWorkingDay: false, name: 'National Day', dayIndex: 1, holidayId: 'holiday-1' },
  effective: { source: 'national', isWorkingDay: false, label: 'National Day' },
  layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day', refId: 'holiday-1' }],
  ...partial,
})

describe('attendance overtime segmentation O1 helper', () => {
  it('classifies workday, restday, holiday, makeup workday, and calendarPolicy overrides from effective-calendar truth', () => {
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(item({})).dayType).toBe('workday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(item({
      base: { source: 'rule', isWorkingDay: false },
      effective: { source: 'rule', isWorkingDay: false },
      layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: false }],
    })).dayType).toBe('restday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(holidayItem()).dayType).toBe('holiday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(holidayItem({
      effective: { source: 'national', isWorkingDay: true, label: 'Makeup workday' },
      layers: [{ kind: 'holiday', source: 'national', isWorkingDay: true, label: 'Makeup workday', refId: 'holiday-2' }],
    })).dayType).toBe('workday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(item({
      effective: { source: 'org', isWorkingDay: false, label: 'Company rest override', policyId: 'policy-rest' },
      layers: [
        { kind: 'base_rule', source: 'rule', isWorkingDay: true },
        { kind: 'calendar_policy', source: 'org', isWorkingDay: false, label: 'Company rest override', refId: 'policy-rest' },
      ],
    })).dayType).toBe('restday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(holidayItem({
      effective: { source: 'user', isWorkingDay: true, label: 'User work override', policyId: 'policy-work' },
      layers: [
        { kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day', refId: 'holiday-1' },
        { kind: 'calendar_policy', source: 'user', isWorkingDay: true, label: 'User work override', refId: 'policy-work' },
      ],
    })).dayType).toBe('workday')
    expect(helpers.resolveOvertimeDayTypeFromEffectiveCalendarItem(item({
      base: { source: 'rule', isWorkingDay: false },
      effective: { source: 'rule', isWorkingDay: false },
      layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: false }],
    })).dayType).toBe('restday')
  })

  it('builds a versioned snapshot with one v1 bucket and rule-normalized total minutes', () => {
    const snapshot = helpers.buildOvertimeSegmentationSnapshot({
      workDate: '2026-10-01',
      minutes: 47,
      overtimeRule: { minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 120 },
      effectiveCalendarItem: holidayItem(),
    })

    expect(snapshot).toEqual({
      version: helpers.OVERTIME_SEGMENTATION_VERSION,
      engine: helpers.OVERTIME_SEGMENTATION_ENGINE,
      workDate: '2026-10-01',
      dayType: 'holiday',
      calendar: {
        effectiveIsWorkingDay: false,
        effectiveSource: 'national',
        effectiveLabel: 'National Day',
        policyId: null,
        holidayName: 'National Day',
        holidayDayIndex: 1,
        holidaySource: 'national',
        holidayRefId: 'holiday-1',
      },
      segments: {
        workdayMinutes: 0,
        restdayMinutes: 0,
        holidayMinutes: 60,
      },
      totalMinutes: 60,
      compTimeGrantMinutes: 60,
    })
  })

  it('caps normalized overtime minutes and keeps comp-time grant equal to the v1 total', () => {
    const snapshot = helpers.buildOvertimeSegmentationSnapshot({
      workDate: '2026-10-02',
      minutes: 145,
      overtimeRule: { minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 120 },
      effectiveCalendarItem: item({}),
    })

    expect(snapshot.dayType).toBe('workday')
    expect(snapshot.totalMinutes).toBe(120)
    expect(snapshot.compTimeGrantMinutes).toBe(120)
    expect(snapshot.segments).toEqual({
      workdayMinutes: 120,
      restdayMinutes: 0,
      holidayMinutes: 0,
    })
  })

  it('rejects cross-midnight overtime windows with the stable v1 code', () => {
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T20:00:00.000Z',
      requestedOutAt: '2026-10-01T22:00:00.000Z',
    })).toEqual({ ok: true })
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T00:30:00+08:00',
      requestedOutAt: '2026-10-01T02:00:00+08:00',
    })).toEqual({ ok: true })
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-02T01:00:00.000Z',
    })).toEqual({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-01T22:00:00.000Z',
    })).toEqual({ ok: false, code: 'OVERTIME_INVALID_TIME_WINDOW' })
  })
})
