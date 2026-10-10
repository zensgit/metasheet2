import { describe, expect, it } from 'vitest'
import {
  needsDefaultRemindPolicy,
  parseExpectedVersion,
  parseRemindAtInput,
  planTaskDates,
  planTaskPatch,
  resolveCreateRemindAt,
  TASK_DESCRIPTION_MAX_CODEPOINTS,
  TASK_EMPTY_DATE_FIELDS,
  type TaskDateFields,
  type TaskEditableState,
} from '../../src/tasks/task-edit'

/**
 * M4 PR-3a S4 (design task-m4-pr3a-backend-design-20260930.md §5.1–§5.3, §10.6, §10.8).
 * RULED(2026-10-07): [R03] field rules for create and PATCH. ASSUMPTION(task-m4): [own-06] [own-07]
 * [own-08] [own-18] [own-29] [own-30] [own-31] [own-38] are the values pinned below.
 */

const SHANGHAI = 'Asia/Shanghai'

const DATED: TaskDateFields = {
  dueDate: '2026-09-30',
  dueTime: '10:00:00',
  startDate: null,
  startTime: null,
  timeZone: SHANGHAI,
}

function state(overrides: Partial<TaskEditableState> = {}): TaskEditableState {
  return {
    title: '备料复核',
    description: null,
    dueDate: null,
    dueTime: null,
    startDate: null,
    startTime: null,
    timeZone: null,
    dueAt: null,
    remindAt: null,
    ...overrides,
  }
}

const DATED_STATE = state({ ...DATED, dueAt: new Date('2026-09-30T02:00:00.000Z'), remindAt: new Date('2026-09-30T01:30:00.000Z') })

describe('parseExpectedVersion', () => {
  it('accepts a positive safe integer number', () => {
    expect(parseExpectedVersion(1)).toEqual({ ok: true, version: 1 })
    expect(parseExpectedVersion(42)).toEqual({ ok: true, version: 42 })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
    ['numeric string', '1'],
    ['NaN', Number.NaN],
    ['unsafe integer', 2 ** 53],
    ['boolean', true],
    ['array', [1]],
    ['object', { version: 1 }],
  ])('%s is invalid_version', (_label, raw) => {
    expect(parseExpectedVersion(raw)).toEqual({ ok: false, reason: 'invalid_version' })
  })
})

describe('parseRemindAtInput', () => {
  it('absent stays absent and null stays null', () => {
    expect(parseRemindAtInput(undefined)).toEqual({ ok: true, remindAt: undefined })
    expect(parseRemindAtInput(null)).toEqual({ ok: true, remindAt: null })
  })

  it.each([
    ['2026-09-30T10:00Z', '2026-09-30T10:00:00.000Z'],
    ['2026-09-30T10:00:05Z', '2026-09-30T10:00:05.000Z'],
    ['2026-09-30T10:00:05.5Z', '2026-09-30T10:00:05.500Z'],
    ['2026-09-30T10:00:05.123Z', '2026-09-30T10:00:05.123Z'],
    ['2026-09-30T18:00:00+08:00', '2026-09-30T10:00:00.000Z'],
    ['2026-09-30T00:10:00-05:30', '2026-09-30T05:40:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ])('%s is the instant %s', (raw, iso) => {
    const parsed = parseRemindAtInput(raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect((parsed.remindAt as Date).toISOString()).toBe(iso)
  })

  it.each([
    ['empty string', ''],
    ['date only', '2026-09-30'],
    ['no zone', '2026-09-30T10:00:00'],
    ['lowercase t', '2026-09-30t10:00:00Z'],
    ['lowercase z', '2026-09-30T10:00:00z'],
    ['space separator', '2026-09-30 10:00:00Z'],
    ['offset without colon', '2026-09-30T10:00:00+0800'],
    ['hour-only offset', '2026-09-30T10:00:00+08'],
    ['not a real date', '2026-02-30T10:00:00Z'],
    ['month 13', '2026-13-01T10:00:00Z'],
    ['hour 24', '2026-09-30T24:00:00Z'],
    ['minute 60', '2026-09-30T10:60:00Z'],
    ['second 60', '2026-09-30T10:00:60Z'],
    ['offset hour 24', '2026-09-30T10:00:00+24:00'],
    ['offset minute 60', '2026-09-30T10:00:00+08:60'],
    ['four fraction digits', '2026-09-30T10:00:00.1234Z'],
    ['year 0000', '0000-01-01T00:00:00Z'],
    ['instant past year 9999', '9999-12-31T23:59:59-01:00'],
    ['trailing text', '2026-09-30T10:00:00Z '],
    ['U+0000 inside', '2026-09-30T10:00:00Z\u0000'],
    ['number', 1790000000000],
    ['boolean', true],
    ['array', ['2026-09-30T10:00:00Z']],
    ['object', {}],
  ])('%s is invalid_remind_at', (_label, raw) => {
    expect(parseRemindAtInput(raw)).toEqual({ ok: false, reason: 'invalid_remind_at' })
  })
})

describe('planTaskDates type gate (design §5.1 step 1)', () => {
  const gate: Array<[string, Record<string, unknown>]> = [
    ["dueTime ''", { dueDate: '2026-09-30', dueTime: '', timeZone: SHANGHAI }],
    ['dueTime 0', { dueDate: '2026-09-30', dueTime: 0, timeZone: SHANGHAI }],
    ['dueTime false', { dueDate: '2026-09-30', dueTime: false, timeZone: SHANGHAI }],
    ["startTime ''", { startDate: '2026-09-30', startTime: '', timeZone: SHANGHAI }],
    ['startTime 0', { startDate: '2026-09-30', startTime: 0, timeZone: SHANGHAI }],
    ['startTime false', { startDate: '2026-09-30', startTime: false, timeZone: SHANGHAI }],
    ["dueDate ['2026-09-30']", { dueDate: ['2026-09-30'], timeZone: SHANGHAI }],
    ['dueDate 20260930', { dueDate: 20260930, timeZone: SHANGHAI }],
    ['dueDate {}', { dueDate: {}, timeZone: SHANGHAI }],
    ["dueDate ''", { dueDate: '', timeZone: SHANGHAI }],
    ['dueDate true', { dueDate: true, timeZone: SHANGHAI }],
    ["startDate ['2026-09-30']", { startDate: ['2026-09-30'], timeZone: SHANGHAI }],
    ['startDate 20260930', { startDate: 20260930, timeZone: SHANGHAI }],
    ['startDate {}', { startDate: {}, timeZone: SHANGHAI }],
  ]

  it.each(gate)('%s on an empty task returns invalid_date and does not throw', (_label, input) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, input)).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it.each(gate)('%s on a dated task returns invalid_date and does not throw', (_label, input) => {
    expect(planTaskDates(DATED, input)).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it.each([
    ['number', 8],
    ['boolean', true],
    ['array', [SHANGHAI]],
    ['object', {}],
  ])('timeZone %s returns invalid_time_zone and does not throw', (_label, timeZone) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone })).toEqual({ ok: false, reason: 'invalid_time_zone' })
    expect(planTaskDates(DATED, { timeZone })).toEqual({ ok: false, reason: 'invalid_time_zone' })
  })

  it('the type gate runs before the value checks: a bad time type wins over a bad zone', () => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', dueTime: 0, timeZone: 'Not/AZone' }))
      .toEqual({ ok: false, reason: 'invalid_date' })
  })
})

describe('planTaskDates values', () => {
  it('an all-day date is due at the local 23:59:59.999 of the task zone', () => {
    const plan = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone: SHANGHAI })
    expect(plan).toEqual({
      ok: true,
      next: { dueDate: '2026-09-30', dueTime: null, startDate: null, startTime: null, timeZone: SHANGHAI },
      dueAt: new Date('2026-09-30T15:59:59.999Z'),
      touchedDates: true,
    })
  })

  it('a scheduled date is due at that wall time; HH:MM is stored as HH:MM:SS', () => {
    const plan = planTaskDates(TASK_EMPTY_DATE_FIELDS, {
      dueDate: '2026-09-30', dueTime: '10:00', startDate: '2026-09-29', startTime: '08:30:15', timeZone: SHANGHAI,
    })
    expect(plan).toEqual({
      ok: true,
      next: { dueDate: '2026-09-30', dueTime: '10:00:00', startDate: '2026-09-29', startTime: '08:30:15', timeZone: SHANGHAI },
      dueAt: new Date('2026-09-30T02:00:00.000Z'),
      touchedDates: true,
    })
  })

  // ASSUMPTION(task-m4): [own-38] the floor is `computeDueAt`'s calendar probe: due dates from
  // 0100-01-01 on. No time zone moves such a date's instant below year 0099, so the instant check
  // has only a top bound; these cells pin the floor it relies on.
  it.each([
    ['0001-01-01 all day in UTC', { dueDate: '0001-01-01', timeZone: 'UTC' }],
    ['0099-12-31 all day in UTC', { dueDate: '0099-12-31', timeZone: 'UTC' }],
    ['0099-12-31 23:59 in Asia/Tokyo', { dueDate: '0099-12-31', dueTime: '23:59', timeZone: 'Asia/Tokyo' }],
  ])('a due date before 0100-01-01 is invalid_date: %s', (_label, input) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, input)).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('0100-01-01 is accepted; east of UTC its instant falls in year 0099, the lowest a due instant gets', () => {
    const utc = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '0100-01-01', timeZone: 'UTC' })
    expect(utc.ok && utc.dueAt).toEqual(new Date(Date.UTC(100, 0, 1, 23, 59, 59, 999)))
    const tokyo = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '0100-01-01', dueTime: '00:00', timeZone: 'Asia/Tokyo' })
    expect(tokyo.ok).toBe(true)
    expect(tokyo.ok && tokyo.dueAt?.getUTCFullYear()).toBe(99)
  })

  // ASSUMPTION(task-m4): [own-38] the derived due instant does not pass the end of year 9999.
  it.each([
    ['9999-12-31 all day in America/New_York', { dueDate: '9999-12-31', timeZone: 'America/New_York' }],
    ['9999-12-31 23:00 in America/Los_Angeles', { dueDate: '9999-12-31', dueTime: '23:00', timeZone: 'America/Los_Angeles' }],
    ['9999-12-31 22:00 in Etc/GMT+3', { dueDate: '9999-12-31', dueTime: '22:00', timeZone: 'Etc/GMT+3' }],
  ])('a due date whose instant falls after year 9999 is invalid_date: %s', (_label, input) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, input)).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('the same last date whose instant stays in year 9999 is accepted (east of UTC, or early enough west of it)', () => {
    const tokyo = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '9999-12-31', timeZone: 'Asia/Tokyo' })
    expect(tokyo.ok && tokyo.dueAt).toEqual(new Date('9999-12-31T14:59:59.999Z'))
    const morning = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '9999-12-31', dueTime: '10:00', timeZone: 'America/New_York' })
    expect(morning.ok && morning.dueAt).toEqual(new Date('9999-12-31T15:00:00.000Z'))
    const lastMs = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '9999-12-31', timeZone: 'UTC' })
    expect(lastMs.ok && lastMs.dueAt).toEqual(new Date('9999-12-31T23:59:59.999Z'))
  })

  it('a zone change that moves a stored last-date instant past year 9999 is invalid_date', () => {
    const stored: TaskDateFields = { dueDate: '9999-12-31', dueTime: null, startDate: null, startTime: null, timeZone: 'Asia/Tokyo' }
    expect(planTaskDates(stored, { timeZone: 'America/New_York' })).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('no keys on an empty task is an empty plan', () => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, {})).toEqual({
      ok: true, next: { ...TASK_EMPTY_DATE_FIELDS }, dueAt: null, touchedDates: false,
    })
  })

  it.each([
    ['2026-02-30', { dueDate: '2026-02-30', timeZone: SHANGHAI }],
    ['2026-9-30', { dueDate: '2026-9-30', timeZone: SHANGHAI }],
    ['a date with U+0000', { dueDate: '2026-09-30\u0000', timeZone: SHANGHAI }],
    ['start 2026-13-01', { startDate: '2026-13-01', timeZone: SHANGHAI }],
    ['25:00', { dueDate: '2026-09-30', dueTime: '25:00', timeZone: SHANGHAI }],
    ['10:60', { dueDate: '2026-09-30', dueTime: '10:60', timeZone: SHANGHAI }],
    ['1:00', { dueDate: '2026-09-30', dueTime: '1:00', timeZone: SHANGHAI }],
    ['start time 08:00:61', { startDate: '2026-09-30', startTime: '08:00:61', timeZone: SHANGHAI }],
    ['a due time without a due date', { dueTime: '10:00', timeZone: SHANGHAI }],
    ['a start time without a start date', { startTime: '10:00', timeZone: SHANGHAI }],
    ['a due time beside a start date only', { startDate: '2026-09-30', dueTime: '10:00', timeZone: SHANGHAI }],
  ])('%s is invalid_date', (_label, input) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, input)).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it.each([
    ['Not/AZone', 'Not/AZone'],
    ['an offset', '+08:00'],
    ['Z', 'Z'],
    ['whitespace only', '   '],
    ['a zone with U+0000', 'Asia/Shanghai\u0000'],
    ['a lone surrogate', '\uD800'],
  ])('timeZone %s is invalid_time_zone', (_label, timeZone) => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone })).toEqual({ ok: false, reason: 'invalid_time_zone' })
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { timeZone })).toEqual({ ok: false, reason: 'invalid_time_zone' })
  })

  it('a case variant is accepted and stored under the canonical name', () => {
    const plan = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone: 'asia/shanghai' })
    expect(plan.ok && plan.next.timeZone).toBe(SHANGHAI)
  })

  it('a date with no zone anywhere is time_zone_required', () => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30' })).toEqual({ ok: false, reason: 'time_zone_required' })
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { startDate: '2026-09-30', timeZone: null })).toEqual({ ok: false, reason: 'time_zone_required' })
  })

  it("the empty string zone is read as no zone ([own-29])", () => {
    expect(planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone: '' })).toEqual({ ok: false, reason: 'time_zone_required' })
    expect(planTaskDates(DATED, { timeZone: '' })).toEqual({ ok: false, reason: 'time_zone_required' })
    expect(planTaskDates({ ...TASK_EMPTY_DATE_FIELDS, timeZone: SHANGHAI }, { timeZone: '' })).toEqual({
      ok: true, next: { ...TASK_EMPTY_DATE_FIELDS }, dueAt: null, touchedDates: false,
    })
  })

  it('touching any date key on a zoned task without timeZone in the same input is time_zone_required', () => {
    for (const input of [
      { dueDate: '2026-10-01' },
      { dueTime: '11:00' },
      { dueTime: null },
      { startDate: '2026-09-29' },
      { dueDate: '2026-09-30' },
      { dueDate: '2026-10-01', timeZone: null },
    ]) {
      expect(planTaskDates(DATED, input), JSON.stringify(input)).toEqual({ ok: false, reason: 'time_zone_required' })
    }
  })

  it('the same edits with timeZone in the input are accepted', () => {
    const plan = planTaskDates(DATED, { dueDate: '2026-10-01', timeZone: SHANGHAI })
    expect(plan).toEqual({
      ok: true,
      next: { ...DATED, dueDate: '2026-10-01' },
      dueAt: new Date('2026-10-01T02:00:00.000Z'),
      touchedDates: true,
    })
  })

  it('a zone-only input re-anchors the stored wall time', () => {
    const plan = planTaskDates(DATED, { timeZone: 'UTC' })
    expect(plan).toEqual({
      ok: true,
      next: { ...DATED, timeZone: 'UTC' },
      dueAt: new Date('2026-09-30T10:00:00.000Z'),
      touchedDates: false,
    })
  })

  it('removing the zone from a dated task is time_zone_required', () => {
    expect(planTaskDates(DATED, { timeZone: null })).toEqual({ ok: false, reason: 'time_zone_required' })
  })

  it('clearing a date never clears its time: dueDate null with a stored dueTime is invalid_date', () => {
    expect(planTaskDates(DATED, { dueDate: null })).toEqual({ ok: false, reason: 'invalid_date' })
    expect(planTaskDates(DATED, { dueDate: null, timeZone: SHANGHAI })).toEqual({ ok: false, reason: 'invalid_date' })
    const started: TaskDateFields = { ...TASK_EMPTY_DATE_FIELDS, startDate: '2026-09-30', startTime: '08:00:00', timeZone: SHANGHAI }
    expect(planTaskDates(started, { startDate: null })).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('clearing the date and its time together needs no zone once no date is left, and keeps the stored zone', () => {
    expect(planTaskDates(DATED, { dueDate: null, dueTime: null })).toEqual({
      ok: true,
      next: { ...TASK_EMPTY_DATE_FIELDS, timeZone: SHANGHAI },
      dueAt: null,
      touchedDates: true,
    })
    expect(planTaskDates(DATED, { dueDate: null, dueTime: null, timeZone: null })).toEqual({
      ok: true, next: { ...TASK_EMPTY_DATE_FIELDS }, dueAt: null, touchedDates: true,
    })
  })

  it('clearing only the time turns a scheduled task into an all-day one', () => {
    const plan = planTaskDates(DATED, { dueTime: null, timeZone: SHANGHAI })
    expect(plan).toEqual({
      ok: true,
      next: { ...DATED, dueTime: null },
      dueAt: new Date('2026-09-30T15:59:59.999Z'),
      touchedDates: true,
    })
  })

  it('there is no start-before-due rule', () => {
    const plan = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', startDate: '2026-10-05', timeZone: SHANGHAI })
    expect(plan.ok).toBe(true)
  })

  it('a stored zone the platform rejects is a reason, not a throw', () => {
    expect(planTaskDates({ ...DATED, timeZone: 'Not/AZone' }, {})).toEqual({ ok: false, reason: 'invalid_time_zone' })
  })
})

describe('create-time remind_at (lock §4.4 default)', () => {
  const timed = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', dueTime: '10:00', timeZone: SHANGHAI })
  const allDay = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', timeZone: SHANGHAI })
  const early = planTaskDates(TASK_EMPTY_DATE_FIELDS, { dueDate: '2026-09-30', dueTime: '00:10', timeZone: SHANGHAI })
  if (!timed.ok || !allDay.ok || !early.ok) throw new Error('fixture plans must be valid')

  it('the policy is read only when remindAt is absent and there is a due date', () => {
    expect(needsDefaultRemindPolicy({ remindAt: undefined, dueDate: '2026-09-30' })).toBe(true)
    expect(needsDefaultRemindPolicy({ remindAt: undefined, dueDate: null })).toBe(false)
    expect(needsDefaultRemindPolicy({ remindAt: null, dueDate: '2026-09-30' })).toBe(false)
    expect(needsDefaultRemindPolicy({ remindAt: new Date(0), dueDate: '2026-09-30' })).toBe(false)
  })

  it('scheduled: due_at minus thirty minutes', () => {
    expect(resolveCreateRemindAt({ remindAt: undefined, dates: timed.next, dueAt: timed.dueAt, policy: { mode: 'default' } }))
      .toEqual(new Date('2026-09-30T01:30:00.000Z'))
  })

  it('all-day: 18:00 in the task zone', () => {
    expect(resolveCreateRemindAt({ remindAt: undefined, dates: allDay.next, dueAt: allDay.dueAt, policy: { mode: 'default' } }))
      .toEqual(new Date('2026-09-30T10:00:00.000Z'))
  })

  it('00:10 due: the reminder lands on the previous local day', () => {
    expect(resolveCreateRemindAt({ remindAt: undefined, dates: early.next, dueAt: early.dueAt, policy: { mode: 'default' } }))
      .toEqual(new Date('2026-09-29T15:40:00.000Z'))
  })

  it('policy none: null', () => {
    expect(resolveCreateRemindAt({ remindAt: undefined, dates: timed.next, dueAt: timed.dueAt, policy: { mode: 'none' } })).toBeNull()
  })

  it('an explicit value wins and never needs the policy', () => {
    const instant = new Date('2020-01-01T00:00:00.000Z')
    expect(resolveCreateRemindAt({ remindAt: null, dates: timed.next, dueAt: timed.dueAt, policy: null })).toBeNull()
    expect(resolveCreateRemindAt({ remindAt: instant, dates: timed.next, dueAt: timed.dueAt, policy: null })).toBe(instant)
    expect(resolveCreateRemindAt({ remindAt: instant, dates: { ...TASK_EMPTY_DATE_FIELDS }, dueAt: null, policy: null })).toBe(instant)
  })

  it('no due date and no remindAt: null without a policy', () => {
    expect(resolveCreateRemindAt({ remindAt: undefined, dates: { ...TASK_EMPTY_DATE_FIELDS }, dueAt: null, policy: null })).toBeNull()
  })

  it('a default reminder without the policy is a caller error', () => {
    expect(() => resolveCreateRemindAt({ remindAt: undefined, dates: timed.next, dueAt: timed.dueAt, policy: null })).toThrow(TypeError)
  })
})

describe('planTaskPatch', () => {
  it('an empty patch is a no-op with no events', () => {
    expect(planTaskPatch(DATED_STATE, {})).toEqual({ ok: true, next: DATED_STATE, changed: false, events: [] })
  })

  it('a patch that repeats the stored values is a no-op', () => {
    const plan = planTaskPatch(DATED_STATE, {
      title: '  备料复核 ',
      description: null,
      dueDate: '2026-09-30',
      dueTime: '10:00',
      timeZone: 'asia/shanghai',
      remindAt: '2026-09-30T09:30:00+08:00',
    })
    expect(plan).toEqual({ ok: true, next: DATED_STATE, changed: false, events: [] })
  })

  it('title: normalized; null, blank, non-string, U+0000 and a lone surrogate are invalid_title', () => {
    const plan = planTaskPatch(state(), { title: '  é  ' })
    expect(plan.ok && plan.next.title).toBe('é')
    expect(plan.ok && plan.events).toEqual(['title_changed'])
    for (const title of [null, '', '   ', 5, ['a'], {}, 'a\u0000b', 'a\uD800b']) {
      expect(planTaskPatch(state(), { title }), JSON.stringify(title)).toEqual({ ok: false, reason: 'invalid_title' })
    }
  })

  it("description: stored as sent; '' and null clear it", () => {
    const set = planTaskPatch(state(), { description: '  第一行\n第二行  ' })
    expect(set.ok && set.next.description).toBe('  第一行\n第二行  ')
    expect(set.ok && set.events).toEqual(['description_changed'])
    const withText = state({ description: '旧' })
    for (const description of ['', null]) {
      const cleared = planTaskPatch(withText, { description })
      expect(cleared.ok && cleared.next.description).toBeNull()
      expect(cleared.ok && cleared.events).toEqual(['description_changed'])
    }
    expect(planTaskPatch(state(), { description: '' })).toEqual({ ok: true, next: state(), changed: false, events: [] })
  })

  // S4-T2 / S4-T3: an absent key keeps the stored column.
  it('a title-only patch keeps every other stored field, the stored description included', () => {
    const full = state({
      ...DATED,
      startDate: '2026-09-29',
      startTime: '08:30:00',
      description: '旧',
      dueAt: new Date('2026-09-30T02:00:00.000Z'),
      remindAt: new Date('2026-09-29T12:00:00.000Z'),
    })
    const plan = planTaskPatch(full, { title: '新' })
    expect(plan).toEqual({ ok: true, next: { ...full, title: '新' }, changed: true, events: ['title_changed'] })
  })

  it('a description-only patch keeps the stored dates, zone and reminder', () => {
    const full = state({ ...DATED, startDate: '2026-09-29', startTime: '08:30:00', dueAt: DATED_STATE.dueAt, remindAt: DATED_STATE.remindAt })
    const plan = planTaskPatch(full, { description: '说明' })
    expect(plan).toEqual({ ok: true, next: { ...full, description: '说明' }, changed: true, events: ['description_changed'] })
  })

  it('description: the bound is counted in code points', () => {
    const atLimit = '😀'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS)
    expect(atLimit.length).toBe(TASK_DESCRIPTION_MAX_CODEPOINTS * 2)
    expect(planTaskPatch(state(), { description: atLimit }).ok).toBe(true)
    expect(planTaskPatch(state(), { description: `${atLimit}a` })).toEqual({ ok: false, reason: 'invalid_description' })
    expect(planTaskPatch(state(), { description: 'a'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS + 1) })).toEqual({ ok: false, reason: 'invalid_description' })
  })

  it.each([
    ['number', 5],
    ['boolean', false],
    ['array', ['a']],
    ['object', {}],
    ['U+0000', 'a\u0000b'],
    ['lone high surrogate', 'a\uD83Db'],
    ['lone low surrogate', '\uDE00'],
  ])('description %s is invalid_description', (_label, description) => {
    expect(planTaskPatch(state(), { description })).toEqual({ ok: false, reason: 'invalid_description' })
  })

  it('checks run in the order title, description, dates, remindAt', () => {
    const all = { title: null, description: 5, dueDate: 0, remindAt: 'x' }
    expect(planTaskPatch(state(), all)).toEqual({ ok: false, reason: 'invalid_title' })
    expect(planTaskPatch(state(), { ...all, title: 'a' })).toEqual({ ok: false, reason: 'invalid_description' })
    expect(planTaskPatch(state(), { ...all, title: 'a', description: 'b' })).toEqual({ ok: false, reason: 'invalid_date' })
    expect(planTaskPatch(state(), { title: 'a', description: 'b', remindAt: 'x' })).toEqual({ ok: false, reason: 'invalid_remind_at' })
  })

  it('three fields in one patch: one event per changed surface, in a fixed order', () => {
    const plan = planTaskPatch(state(), {
      title: '新标题',
      description: '说明',
      dueDate: '2026-09-30',
      startDate: '2026-09-29',
      timeZone: SHANGHAI,
      remindAt: '2026-09-30T10:00:00Z',
    })
    expect(plan.ok && plan.changed).toBe(true)
    expect(plan.ok && plan.events).toEqual(['title_changed', 'description_changed', 'due_changed', 'start_changed', 'remind_changed'])
    expect(plan.ok && plan.next.dueAt).toEqual(new Date('2026-09-30T15:59:59.999Z'))
  })

  it('moving the due date without remindAt leaves the reminder where it was ([own-06])', () => {
    const plan = planTaskPatch(DATED_STATE, { dueDate: '2026-10-08', timeZone: SHANGHAI })
    expect(plan.ok && plan.next.remindAt).toEqual(DATED_STATE.remindAt)
    expect(plan.ok && plan.next.dueAt).toEqual(new Date('2026-10-08T02:00:00.000Z'))
    expect(plan.ok && plan.events).toEqual(['due_changed'])
  })

  it('clearing the due date does not clear the reminder either', () => {
    const plan = planTaskPatch(DATED_STATE, { dueDate: null, dueTime: null })
    expect(plan.ok && plan.next.remindAt).toEqual(DATED_STATE.remindAt)
    expect(plan.ok && plan.next.dueAt).toBeNull()
    expect(plan.ok && plan.events).toEqual(['due_changed'])
  })

  it('remindAt: null clears, an instant sets, the same instant is not a change', () => {
    const cleared = planTaskPatch(DATED_STATE, { remindAt: null })
    expect(cleared.ok && cleared.next.remindAt).toBeNull()
    expect(cleared.ok && cleared.events).toEqual(['remind_changed'])
    const set = planTaskPatch(DATED_STATE, { remindAt: '2026-09-29T00:00:00Z' })
    expect(set.ok && set.next.remindAt).toEqual(new Date('2026-09-29T00:00:00.000Z'))
    expect(set.ok && set.events).toEqual(['remind_changed'])
    const same = planTaskPatch(DATED_STATE, { remindAt: '2026-09-30T01:30:00.000Z' })
    expect(same.ok && same.changed).toBe(false)
    const noDates = planTaskPatch(state(), { remindAt: '2026-09-29T00:00:00Z' })
    expect(noDates.ok && noDates.events).toEqual(['remind_changed'])
  })

  it('a zone-only patch on a dated task recomputes due_at and writes due_changed (and start_changed when it has a start date)', () => {
    const due = planTaskPatch(DATED_STATE, { timeZone: 'UTC' })
    expect(due.ok && due.next.dueAt).toEqual(new Date('2026-09-30T10:00:00.000Z'))
    expect(due.ok && due.events).toEqual(['due_changed'])
    const both = planTaskPatch({ ...DATED_STATE, startDate: '2026-09-29' }, { timeZone: 'UTC' })
    expect(both.ok && both.events).toEqual(['due_changed', 'start_changed'])
    const startOnly = planTaskPatch(state({ startDate: '2026-09-29', timeZone: SHANGHAI }), { timeZone: 'UTC' })
    expect(startOnly.ok && startOnly.events).toEqual(['start_changed'])
  })

  it('a zone-only patch on a task with no dates is a change with no event ([own-18])', () => {
    const plan = planTaskPatch(state(), { timeZone: SHANGHAI })
    expect(plan).toEqual({ ok: true, next: state({ timeZone: SHANGHAI }), changed: true, events: [] })
  })

  it('date reasons pass through unchanged', () => {
    expect(planTaskPatch(DATED_STATE, { dueDate: '2026-10-01' })).toEqual({ ok: false, reason: 'time_zone_required' })
    expect(planTaskPatch(DATED_STATE, { timeZone: 'Not/AZone' })).toEqual({ ok: false, reason: 'invalid_time_zone' })
    expect(planTaskPatch(DATED_STATE, { dueTime: '' })).toEqual({ ok: false, reason: 'invalid_date' })
  })
})
