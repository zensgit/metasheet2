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

  it('resolves comp-time grant minutes from the versioned snapshot before falling back to total minutes', () => {
    const snapshot = helpers.buildOvertimeSegmentationSnapshot({
      workDate: '2026-10-02',
      minutes: 90,
      overtimeRule: { minMinutes: 0, roundingMinutes: 1, maxMinutesPerDay: 0 },
      effectiveCalendarItem: item({}),
    })
    const futurePolicySnapshot = {
      ...snapshot,
      compTimeGrantMinutes: 45,
    }

    expect(helpers.resolveCompTimeGrantMinutesFromOvertimeMetadata({
      minutes: 90,
      overtimeSegmentation: futurePolicySnapshot,
    })).toBe(45)
    expect(helpers.resolveCompTimeGrantMinutesFromOvertimeMetadata({ minutes: 90 })).toBe(90)
    expect(helpers.resolveCompTimeGrantMinutesFromOvertimeMetadata({
      minutes: 90,
      overtimeSegmentation: { ...futurePolicySnapshot, version: 999 },
    })).toBe(90)
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

describe('#8 NS-1 — cross-midnight split BEHIND the guard (route still rejects until NS-3)', () => {
  // §3c route-level reject proof: maybeBuildOvertimeSegmentationSnapshot calls validate with NO options, so
  // allowCrossMidnight defaults false. A one-midnight window therefore STILL rejects through NS-1/NS-2.
  it('route default (no options) STILL rejects a one-midnight window with the stable code', () => {
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-02T01:00:00.000Z',
    })).toEqual({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })

  // The actual route fn (not just the validator): with segmentation enabled, a one-midnight window throws
  // 422 OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED — proving NS-1 did NOT open the route. (No DB: input.settings
  // bypasses getSettings, and the reject throws before any calendar load.)
  it('ROUTE fn maybeBuildOvertimeSegmentationSnapshot still throws 422 for a one-midnight window (NS-1 does not lift it)', async () => {
    await expect(helpers.maybeBuildOvertimeSegmentationSnapshot(null, {
      settings: { overtimeSegmentation: { enabled: true } },
      workDate: '2026-10-01',
      userId: 'u1',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-02T01:00:00.000Z',
    })).rejects.toMatchObject({ status: 422, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })

  it('split: a one-midnight (UTC) window → per-date sub-spans with per-date minutes (§3b/§3d)', () => {
    const r = helpers.splitOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:00:00.000Z',
      endAt: '2026-10-02T01:00:00.000Z',
      timeZone: 'UTC',
    })
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(true)
    expect(r.spans.map((s: { date: string; minutes: number }) => ({ date: s.date, minutes: s.minutes }))).toEqual([
      { date: '2026-10-01', minutes: 60 },
      { date: '2026-10-02', minutes: 60 },
    ])
  })

  it('split: §3b uses the RULE LOCAL midnight, not UTC — an Asia/Shanghai window with the SAME UTC date still crosses local midnight', () => {
    // 2026-10-01 23:30 +08 → 2026-10-02 00:30 +08 = 15:30Z → 16:30Z (same UTC date 2026-10-01, crosses LOCAL midnight)
    const r = helpers.splitOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:30:00+08:00',
      endAt: '2026-10-02T00:30:00+08:00',
      timeZone: 'Asia/Shanghai',
    })
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(true)
    expect(r.spans.map((s: { date: string; minutes: number }) => ({ date: s.date, minutes: s.minutes }))).toEqual([
      { date: '2026-10-01', minutes: 30 },
      { date: '2026-10-02', minutes: 30 },
    ])
  })

  it('split: a same-local-date window is a single span (no split); re-splitting a sub-span is idempotent', () => {
    const r = helpers.splitOvertimeSegmentationWindowAtMidnight({ startAt: '2026-10-01T20:00:00.000Z', endAt: '2026-10-01T22:00:00.000Z', timeZone: 'UTC' })
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(false)
    expect(r.spans).toHaveLength(1)
    expect(r.spans[0]).toMatchObject({ date: '2026-10-01', minutes: 120 })
    const again = helpers.splitOvertimeSegmentationWindowAtMidnight({ startAt: r.spans[0].startAt, endAt: r.spans[0].endAt, timeZone: 'UTC' })
    expect(again.spans).toHaveLength(1)
    expect(again.spans[0]).toMatchObject({ date: '2026-10-01', minutes: 120 })
  })

  it('split: §3a a MULTI-midnight window is not splittable — stable reject', () => {
    expect(helpers.splitOvertimeSegmentationWindowAtMidnight({ startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-03T01:00:00.000Z', timeZone: 'UTC' }))
      .toMatchObject({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })

  it('validate with allowCrossMidnight=true accepts a one-midnight window (+spans); multi-midnight still rejects', () => {
    const one = helpers.validateOvertimeSegmentationWindow(
      { workDate: '2026-10-01', requestedInAt: '2026-10-01T23:00:00.000Z', requestedOutAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC' },
      { allowCrossMidnight: true },
    )
    expect(one.ok).toBe(true)
    expect(one.crossesMidnight).toBe(true)
    expect(one.spans).toHaveLength(2)
    expect(helpers.validateOvertimeSegmentationWindow(
      { workDate: '2026-10-01', requestedInAt: '2026-10-01T23:00:00.000Z', requestedOutAt: '2026-10-03T01:00:00.000Z', timeZone: 'UTC' },
      { allowCrossMidnight: true },
    )).toEqual({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })
})
