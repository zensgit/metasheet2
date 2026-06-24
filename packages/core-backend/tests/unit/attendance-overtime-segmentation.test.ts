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

  it('NS-3: accepts a one-local-midnight window (lifted); same-day stays single-span; reversed still invalid', () => {
    // same-day → ok, single span, not crossing midnight
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T20:00:00.000Z',
      requestedOutAt: '2026-10-01T22:00:00.000Z',
    })).toMatchObject({ ok: true, crossesMidnight: false })
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T08:00:00.000Z',
      requestedOutAt: '2026-10-01T10:00:00.000Z',
    })).toMatchObject({ ok: true, crossesMidnight: false })
    // one local midnight → NOW ACCEPTED with per-date spans (pre-NS-3 was OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED)
    const cross = helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-02T01:00:00.000Z',
    })
    expect(cross.ok).toBe(true)
    expect(cross.crossesMidnight).toBe(true)
    expect(cross.spans).toHaveLength(2)
    // reversed → still the stable invalid code
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-01T22:00:00.000Z',
    })).toEqual({ ok: false, code: 'OVERTIME_INVALID_TIME_WINDOW' })
    // §P1 workDate anchoring: a window whose first local date is NOT workDate (here both ends land on D+1
    // while workDate=D) is REJECTED — it must not be silently snapshotted onto workDate.
    expect(helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-02T09:00:00.000Z',
      requestedOutAt: '2026-10-02T11:00:00.000Z',
    })).toEqual({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })
})

describe('#8 NS-1 — cross-midnight split BEHIND the guard (route still rejects until NS-3)', () => {
  // #8 NS-3 lifted the reject: the validator (which the route calls) now ACCEPTS a one-local-midnight window
  // with per-date spans. reversed / multi-midnight keep the stable reject (asserted in the split tests below);
  // the snapshot-level accept + reject are proven in the real-DB matrix (attendance-plugin.test.ts).
  it('NS-3: the validator default ACCEPTS a one-midnight window with per-date spans (reject lifted)', () => {
    const r = helpers.validateOvertimeSegmentationWindow({
      workDate: '2026-10-01',
      requestedInAt: '2026-10-01T23:00:00.000Z',
      requestedOutAt: '2026-10-02T01:00:00.000Z',
    })
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(true)
    expect(r.spans).toHaveLength(2)
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

  it('§3b consistency: allowCrossMidnight splits a Z-string window that crosses LOCAL midnight even though both ends share one UTC date', () => {
    // 15:30Z / 16:30Z both UTC-slice to 2026-10-01, but in Asia/Shanghai they are 23:30 (10-01) → 00:30 (10-02).
    // The validator must DELEGATE to the tz-aware split (not silently return same-day) — this is the input shape
    // that masks a UTC/literal-only gate.
    const r = helpers.validateOvertimeSegmentationWindow(
      { workDate: '2026-10-01', requestedInAt: '2026-10-01T15:30:00.000Z', requestedOutAt: '2026-10-01T16:30:00.000Z', timeZone: 'Asia/Shanghai' },
      { allowCrossMidnight: true },
    )
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(true)
    expect(r.spans.map((s: { date: string; minutes: number }) => ({ date: s.date, minutes: s.minutes }))).toEqual([
      { date: '2026-10-01', minutes: 30 },
      { date: '2026-10-02', minutes: 30 },
    ])
  })
})

describe('#8 NS-2 — adversarial matrix pinning NS-1 split + per-own-date bucketing (route reject UNCHANGED)', () => {
  const allWorkday = () => ({ isWorkingDay: true })
  const byDate = (map: Record<string, { isWorkingDay?: boolean; isHoliday?: boolean }>) => (d: string) => map[d] ?? {}

  it('same-day window: single span, bucketed by its own date (no split)', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T20:00:00.000Z', endAt: '2026-10-01T22:00:00.000Z', timeZone: 'UTC', classifyDate: allWorkday,
    })
    expect(r.ok).toBe(true)
    expect(r.crossesMidnight).toBe(false)
    expect(r.perDate).toEqual([{ date: '2026-10-01', minutes: 120, kind: 'workday' }])
    expect(r.buckets).toEqual({ workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 })
  })

  it('23:00→01:00 across two WORKDAYS splits 1h/1h into the workday bucket by date', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC', classifyDate: allWorkday,
    })
    expect(r.perDate).toEqual([
      { date: '2026-10-01', minutes: 60, kind: 'workday' },
      { date: '2026-10-02', minutes: 60, kind: 'workday' },
    ])
    expect(r.buckets).toEqual({ workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 })
  })

  it('restday-after-midnight buckets correctly: D workday, D+1 restday → 60 workday + 60 restday (no bleed)', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC',
      classifyDate: byDate({ '2026-10-01': { isWorkingDay: true }, '2026-10-02': { isWorkingDay: false } }),
    })
    expect(r.perDate).toEqual([
      { date: '2026-10-01', minutes: 60, kind: 'workday' },
      { date: '2026-10-02', minutes: 60, kind: 'restday' },
    ])
    expect(r.buckets).toEqual({ workdayMinutes: 60, restdayMinutes: 60, holidayMinutes: 0 })
  })

  it('holiday-after-midnight (a TRUE holiday, not a makeup workday) buckets to the holiday bucket', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC',
      classifyDate: byDate({ '2026-10-01': { isWorkingDay: true }, '2026-10-02': { isWorkingDay: false, isHoliday: true } }),
    })
    expect(r.buckets).toEqual({ workdayMinutes: 60, restdayMinutes: 0, holidayMinutes: 60 })
  })

  it('makeup-workday precedence (调休): isWorkingDay WINS over a holiday layer — matches resolveOvertimeDayTypeFromEffectiveCalendarItem', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC',
      // D+1 = a holiday date designated a makeup workday → both flags → canonical day-type is WORKDAY, not holiday.
      classifyDate: byDate({ '2026-10-01': { isWorkingDay: true }, '2026-10-02': { isWorkingDay: true, isHoliday: true } }),
    })
    expect(r.buckets).toEqual({ workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 })
  })

  it('§3b local-midnight bucketing: a Shanghai Z-string window buckets per LOCAL date', () => {
    const r = helpers.bucketOvertimeSegmentationWindowAtMidnight({
      startAt: '2026-10-01T15:30:00.000Z', endAt: '2026-10-01T16:30:00.000Z', timeZone: 'Asia/Shanghai',
      classifyDate: byDate({ '2026-10-01': { isWorkingDay: true }, '2026-10-02': { isWorkingDay: false } }),
    })
    expect(r.perDate).toEqual([
      { date: '2026-10-01', minutes: 30, kind: 'workday' },
      { date: '2026-10-02', minutes: 30, kind: 'restday' },
    ])
    expect(r.buckets).toEqual({ workdayMinutes: 30, restdayMinutes: 30, holidayMinutes: 0 })
  })

  it('reversed and multi-midnight windows keep the stable reject (no buckets)', () => {
    expect(helpers.bucketOvertimeSegmentationWindowAtMidnight({ startAt: '2026-10-02T01:00:00.000Z', endAt: '2026-10-01T23:00:00.000Z', timeZone: 'UTC', classifyDate: allWorkday }))
      .toMatchObject({ ok: false, code: 'OVERTIME_INVALID_TIME_WINDOW' })
    expect(helpers.bucketOvertimeSegmentationWindowAtMidnight({ startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-03T01:00:00.000Z', timeZone: 'UTC', classifyDate: allWorkday }))
      .toMatchObject({ ok: false, code: 'OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED' })
  })

  it('idempotent: re-bucketing the same window yields byte-identical buckets, total == window minutes (no boundary double-count)', () => {
    const args = { startAt: '2026-10-01T23:00:00.000Z', endAt: '2026-10-02T01:00:00.000Z', timeZone: 'UTC', classifyDate: byDate({ '2026-10-01': { isWorkingDay: true }, '2026-10-02': { isWorkingDay: false } }) }
    const a = helpers.bucketOvertimeSegmentationWindowAtMidnight(args)
    const b = helpers.bucketOvertimeSegmentationWindowAtMidnight(args)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.buckets.workdayMinutes + a.buckets.restdayMinutes + a.buckets.holidayMinutes).toBe(120)
  })
})

describe('#8 NS-3 — buildCrossMidnightOvertimeSegmentationSnapshot (rule-once, partition, per-own-date bucket)', () => {
  const item = (isWorkingDay: boolean, holiday = false) => ({
    effective: { isWorkingDay },
    layers: holiday ? [{ kind: 'holiday', isWorkingDay: false, label: 'Holiday' }] : [],
  })
  const itemsByDate = (map: Record<string, ReturnType<typeof item>>) => new Map(Object.entries(map))
  const splitOf = (startAt: string, endAt: string, tz = 'UTC') =>
    helpers.splitOvertimeSegmentationWindowAtMidnight({ startAt, endAt, timeZone: tz }).spans

  it('partitions the RULE-NORMALIZED total by window weights, last date remainder, per-own-date bucket', () => {
    const spans = splitOf('2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z') // 60/60
    const snap = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 120, overtimeRule: null, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(false) }),
    })
    expect(snap.crossesMidnight).toBe(true)
    expect(snap.totalMinutes).toBe(120)
    expect(snap.segments).toEqual({ workdayMinutes: 60, restdayMinutes: 60, holidayMinutes: 0 })
    expect(snap.perDate.map((p: { date: string; dayType: string; minutes: number }) => ({ date: p.date, dayType: p.dayType, minutes: p.minutes }))).toEqual([
      { date: '2026-10-01', dayType: 'workday', minutes: 60 },
      { date: '2026-10-02', dayType: 'restday', minutes: 60 },
    ])
  })

  it('applies the overtime rule ONCE to the aggregate then partitions (no per-sub-span double rounding)', () => {
    // rule rounds UP to 60; raw 90 → normalized 120; partition by 60/60 weights → 60/60 (not 60→60 + 30→60).
    const spans = splitOf('2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z')
    const snap = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 90, overtimeRule: { roundingMinutes: 60 }, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(true) }),
    })
    expect(snap.totalMinutes).toBe(120)
    expect(snap.segments.workdayMinutes).toBe(120)
    expect(snap.perDate[0].minutes + snap.perDate[1].minutes).toBe(120) // conservation
  })

  it('odd total: last date absorbs the remainder so Σ === total exactly (replay-deterministic)', () => {
    const spans = splitOf('2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z') // 60/60 weights
    const snap = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 121, overtimeRule: null, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(true) }),
    })
    expect(snap.perDate[0].minutes).toBe(60) // floor(121*60/120)
    expect(snap.perDate[1].minutes).toBe(61) // remainder
    expect(snap.totalMinutes).toBe(121)
    // idempotent: identical re-run
    const snap2 = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 121, overtimeRule: null, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(true) }),
    })
    expect(JSON.stringify(snap)).toBe(JSON.stringify(snap2))
  })

  it('holiday-after-midnight buckets to holiday; makeup-workday (both flags) buckets to workday', () => {
    const spans = splitOf('2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z')
    const holiday = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 120, overtimeRule: null, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(false, true) }),
    })
    expect(holiday.segments).toEqual({ workdayMinutes: 60, restdayMinutes: 0, holidayMinutes: 60 })
    const makeup = helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
      workDate: '2026-10-01', minutes: 120, overtimeRule: null, spans,
      itemsByDate: itemsByDate({ '2026-10-01': item(true), '2026-10-02': item(true, true) }),
    })
    expect(makeup.segments).toEqual({ workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 })
  })

  it('fails closed (OVERTIME_SEGMENTATION_UNRESOLVED, 422) if a spanned date has no calendar item', () => {
    const spans = splitOf('2026-10-01T23:00:00.000Z', '2026-10-02T01:00:00.000Z')
    let thrown: { status?: number; code?: string } | undefined
    try {
      helpers.buildCrossMidnightOvertimeSegmentationSnapshot({
        workDate: '2026-10-01', minutes: 120, overtimeRule: null, spans,
        itemsByDate: itemsByDate({ '2026-10-01': item(true) }), // D+1 missing → must NOT silently bucket as restday
      })
    } catch (e) {
      thrown = e as { status?: number; code?: string }
    }
    expect(thrown?.status).toBe(422)
    expect(thrown?.code).toBe('OVERTIME_SEGMENTATION_UNRESOLVED')
  })
})
