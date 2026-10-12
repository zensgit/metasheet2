import { describe, expect, it } from 'vitest'
import type { TaskRole } from '../../src/tasks/task-access'
import type { TaskDeletionNodes } from '../../src/tasks/task-deletion'
import {
  TASK_RECURRENCE_COUNT_MAX,
  TASK_RECURRENCE_FREQS,
  TASK_RECURRENCE_INTERVAL_MAX,
  TaskRecurrenceSeriesCorruptError,
  applyClearRecurrence,
  applySetRecurrence,
  isWithinRecurrenceEnd,
  nextOccurrenceDueDate,
  parseRecurrenceRule,
  planSeriesDelete,
  planSpawn,
  shouldSpawnOnFlip,
  type TaskOccurrenceSource,
  type TaskRecurrenceRule,
  type TaskSeriesMember,
} from '../../src/tasks/task-recurrence'

const NOW = new Date('2026-10-07T08:00:00.000Z')
const DAILY: TaskRecurrenceRule = { freq: 'daily', interval: 1 }

function invalidField(raw: unknown): string | null {
  const result = parseRecurrenceRule(raw)
  return result.ok ? null : (result as { field: string }).field
}

describe('task-recurrence', () => {
  describe('constants (RULED(2026-10-09): [S14]; ASSUMPTION(task-e): [D18])', () => {
    it('freq closed set, interval and count ceilings', () => {
      expect(TASK_RECURRENCE_FREQS).toEqual(['daily', 'weekly', 'monthly', 'yearly'])
      expect(TASK_RECURRENCE_INTERVAL_MAX).toBe(365)
      expect(TASK_RECURRENCE_COUNT_MAX).toBe(365)
    })
  })

  describe('parseRecurrenceRule', () => {
    it('accepts one minimal rule per freq', () => {
      expect(parseRecurrenceRule({ freq: 'daily', interval: 1 })).toEqual({ ok: true, rule: { freq: 'daily', interval: 1 } })
      expect(parseRecurrenceRule({ freq: 'weekly', interval: 1, byWeekday: [1] })).toEqual({
        ok: true,
        rule: { freq: 'weekly', interval: 1, byWeekday: [1] },
      })
      expect(parseRecurrenceRule({ freq: 'monthly', interval: 1 })).toEqual({ ok: true, rule: { freq: 'monthly', interval: 1 } })
      expect(parseRecurrenceRule({ freq: 'yearly', interval: 1 })).toEqual({ ok: true, rule: { freq: 'yearly', interval: 1 } })
    })
    it('canonicalizes: byWeekday deduplicated and ascending, fixed key order', () => {
      const result = parseRecurrenceRule({ end: { count: 3 }, byWeekday: [5, 1, 5, 3], interval: 2, freq: 'weekly' })
      expect(result).toEqual({ ok: true, rule: { freq: 'weekly', interval: 2, byWeekday: [1, 3, 5], end: { count: 3 } } })
      expect(Object.keys((result as { rule: object }).rule)).toEqual(['freq', 'interval', 'byWeekday', 'end'])
    })
    it('accepts the boundary values', () => {
      expect(parseRecurrenceRule({ freq: 'daily', interval: 365 }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'daily', interval: 1, end: { count: 365 } }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'daily', interval: 1, end: { count: 1 } }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'monthly', interval: 1, byMonthDay: 31 }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'monthly', interval: 1, byMonthDay: 1 }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'monthly', interval: 1, byMonthDay: 'last' }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'weekly', interval: 1, byWeekday: [0, 6] }).ok).toBe(true)
      expect(parseRecurrenceRule({ freq: 'daily', interval: 1, end: { until: '2026-12-31' } }).ok).toBe(true)
    })
    it('the failure carries only the key name (reason invalid_recurrence)', () => {
      expect(parseRecurrenceRule({ freq: 'hourly', interval: 1 })).toEqual({ ok: false, reason: 'invalid_recurrence', field: 'freq' })
    })
    it.each([
      ['not an object', null, 'rule'],
      ['an array', [], 'rule'],
      ['a string', 'x', 'rule'],
      ['an unknown key', { freq: 'daily', interval: 1, at: '09:00' }, 'rule'],
      ['missing freq', { interval: 1 }, 'freq'],
      ['unknown freq', { freq: 'workdays', interval: 1 }, 'freq'],
      ['missing interval', { freq: 'daily' }, 'interval'],
      ['interval 0', { freq: 'daily', interval: 0 }, 'interval'],
      ['interval 366', { freq: 'daily', interval: 366 }, 'interval'],
      ['fractional interval', { freq: 'daily', interval: 1.5 }, 'interval'],
      ['string interval', { freq: 'daily', interval: '1' }, 'interval'],
      ['weekly without byWeekday', { freq: 'weekly', interval: 1 }, 'byWeekday'],
      ['weekly with empty byWeekday', { freq: 'weekly', interval: 1, byWeekday: [] }, 'byWeekday'],
      ['weekday 7', { freq: 'weekly', interval: 1, byWeekday: [7] }, 'byWeekday'],
      ['weekday -1', { freq: 'weekly', interval: 1, byWeekday: [-1] }, 'byWeekday'],
      ['string weekday', { freq: 'weekly', interval: 1, byWeekday: ['1'] }, 'byWeekday'],
      ['byWeekday on daily', { freq: 'daily', interval: 1, byWeekday: [1] }, 'byWeekday'],
      ['byMonthDay 0', { freq: 'monthly', interval: 1, byMonthDay: 0 }, 'byMonthDay'],
      ['byMonthDay 32', { freq: 'monthly', interval: 1, byMonthDay: 32 }, 'byMonthDay'],
      ['byMonthDay first', { freq: 'monthly', interval: 1, byMonthDay: 'first' }, 'byMonthDay'],
      ['byMonthDay on weekly', { freq: 'weekly', interval: 1, byWeekday: [1], byMonthDay: 3 }, 'byMonthDay'],
      ['byMonthDay on yearly', { freq: 'yearly', interval: 1, byMonthDay: 3 }, 'byMonthDay'],
      ['end null (own choice: omit the key instead)', { freq: 'daily', interval: 1, end: null }, 'end'],
      ['end empty', { freq: 'daily', interval: 1, end: {} }, 'end'],
      ['end with both keys', { freq: 'daily', interval: 1, end: { until: '2026-12-31', count: 3 } }, 'end'],
      ['end with an unknown key', { freq: 'daily', interval: 1, end: { after: 3 } }, 'end'],
      ['until not a real date', { freq: 'daily', interval: 1, end: { until: '2026-02-30' } }, 'until'],
      ['until not canonical', { freq: 'daily', interval: 1, end: { until: '2026-2-3' } }, 'until'],
      ['count 0', { freq: 'daily', interval: 1, end: { count: 0 } }, 'count'],
      ['count 366', { freq: 'daily', interval: 1, end: { count: 366 } }, 'count'],
      ['fractional count', { freq: 'daily', interval: 1, end: { count: 2.5 } }, 'count'],
    ])('%s ⇒ field %s', (_label, raw, field) => {
      expect(invalidField(raw)).toBe(field)
    })
  })

  describe('nextOccurrenceDueDate', () => {
    describe('daily', () => {
      it('steps interval days from the current instance', () => {
        expect(nextOccurrenceDueDate(DAILY, '2026-10-07', '2026-01-01')).toBe('2026-10-08')
        expect(nextOccurrenceDueDate({ freq: 'daily', interval: 3 }, '2026-12-30', '2026-01-01')).toBe('2027-01-02')
      })
    })
    describe('weekly', () => {
      const MWF: TaskRecurrenceRule = { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] }
      it('interval 1: the next matching weekday strictly after the current one', () => {
        expect(nextOccurrenceDueDate(MWF, '2026-10-07', '2026-10-05')).toBe('2026-10-09') // Wed → Fri
        expect(nextOccurrenceDueDate(MWF, '2026-10-09', '2026-10-05')).toBe('2026-10-12') // Fri → Mon
        expect(nextOccurrenceDueDate({ freq: 'weekly', interval: 1, byWeekday: [0] }, '2026-10-07', '2026-10-04')).toBe('2026-10-11')
      })
      it('a single weekday every two weeks', () => {
        expect(nextOccurrenceDueDate({ freq: 'weekly', interval: 2, byWeekday: [3] }, '2026-10-07', '2026-10-07')).toBe('2026-10-21')
      })
      it('a current date moved off the pattern steps to the next matching weekday', () => {
        expect(nextOccurrenceDueDate({ freq: 'weekly', interval: 1, byWeekday: [1] }, '2026-10-07', '2026-10-05')).toBe('2026-10-12')
      })
      // ASSUMPTION(task-e, own choice): weeks start on Monday. With Sunday-start weeks the first answer would be 2026-10-25.
      it('interval 2 with Sunday in the set: Sunday closes the Monday-start week', () => {
        const rule: TaskRecurrenceRule = { freq: 'weekly', interval: 2, byWeekday: [0, 1] }
        expect(nextOccurrenceDueDate(rule, '2026-10-12', '2026-10-12')).toBe('2026-10-18') // Mon → Sun, same week
        expect(nextOccurrenceDueDate(rule, '2026-10-18', '2026-10-12')).toBe('2026-10-26') // Sun → Mon two weeks on
      })
    })
    describe('monthly', () => {
      const MONTHLY: TaskRecurrenceRule = { freq: 'monthly', interval: 1 }
      it('the anchor day is clamped to short months and comes back afterwards (01-31 → 02-28 → 03-31)', () => {
        expect(nextOccurrenceDueDate(MONTHLY, '2026-01-31', '2026-01-31')).toBe('2026-02-28')
        expect(nextOccurrenceDueDate(MONTHLY, '2026-02-28', '2026-01-31')).toBe('2026-03-31')
        expect(nextOccurrenceDueDate(MONTHLY, '2026-03-31', '2026-01-31')).toBe('2026-04-30')
        expect(nextOccurrenceDueDate(MONTHLY, '2026-04-30', '2026-01-31')).toBe('2026-05-31')
      })
      it('February of a leap year gets the 29th', () => {
        expect(nextOccurrenceDueDate(MONTHLY, '2028-01-31', '2026-01-31')).toBe('2028-02-29')
      })
      it('an explicit byMonthDay wins over the anchor day', () => {
        expect(nextOccurrenceDueDate({ freq: 'monthly', interval: 1, byMonthDay: 15 }, '2026-01-31', '2026-01-31')).toBe('2026-02-15')
        expect(nextOccurrenceDueDate({ freq: 'monthly', interval: 1, byMonthDay: 31 }, '2026-02-28', '2026-02-10')).toBe('2026-03-31')
      })
      it("'last' is always the month end", () => {
        const rule: TaskRecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: 'last' }
        expect(nextOccurrenceDueDate(rule, '2026-01-31', '2026-01-05')).toBe('2026-02-28')
        expect(nextOccurrenceDueDate(rule, '2026-02-28', '2026-01-05')).toBe('2026-03-31')
      })
      it('interval steps cross the year boundary', () => {
        expect(nextOccurrenceDueDate({ freq: 'monthly', interval: 2 }, '2026-11-30', '2026-01-30')).toBe('2027-01-30')
        expect(nextOccurrenceDueDate({ freq: 'monthly', interval: 12 }, '2026-10-07', '2026-10-07')).toBe('2027-10-07')
      })
    })
    describe('yearly', () => {
      const YEARLY: TaskRecurrenceRule = { freq: 'yearly', interval: 1 }
      it('a Feb 29 anchor lands on Feb 28 in common years and on Feb 29 again in the next leap year', () => {
        expect(nextOccurrenceDueDate(YEARLY, '2028-02-29', '2028-02-29')).toBe('2029-02-28')
        expect(nextOccurrenceDueDate(YEARLY, '2029-02-28', '2028-02-29')).toBe('2030-02-28')
        expect(nextOccurrenceDueDate(YEARLY, '2031-02-28', '2028-02-29')).toBe('2032-02-29')
      })
      it('month and day come from the anchor, the year steps from the current instance', () => {
        expect(nextOccurrenceDueDate(YEARLY, '2026-03-01', '2026-02-10')).toBe('2027-02-10')
        expect(nextOccurrenceDueDate({ freq: 'yearly', interval: 2 }, '2026-10-07', '2026-10-07')).toBe('2028-10-07')
      })
    })
    it('is always strictly later than the current instance', () => {
      const rules: TaskRecurrenceRule[] = [
        DAILY,
        { freq: 'weekly', interval: 1, byWeekday: [0, 1, 2, 3, 4, 5, 6] },
        { freq: 'weekly', interval: 3, byWeekday: [2] },
        { freq: 'monthly', interval: 1, byMonthDay: 1 },
        { freq: 'monthly', interval: 1, byMonthDay: 'last' },
        { freq: 'yearly', interval: 1 },
      ]
      for (const rule of rules) {
        for (const current of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) {
          expect(nextOccurrenceDueDate(rule, current, '2026-01-31') > current, `${JSON.stringify(rule)} ${current}`).toBe(true)
        }
      }
    })
    it('a result past 9999-12-31 is a RangeError', () => {
      expect(() => nextOccurrenceDueDate(DAILY, '9999-12-31', '9999-12-31')).toThrow(RangeError)
      expect(() => nextOccurrenceDueDate({ freq: 'monthly', interval: 1 }, '9999-12-01', '9999-12-01')).toThrow(RangeError)
      expect(() => nextOccurrenceDueDate({ freq: 'yearly', interval: 1 }, '9999-01-01', '9999-01-01')).toThrow(RangeError)
    })
    it('an invalid rule is a TypeError, a bad date a RangeError', () => {
      expect(() => nextOccurrenceDueDate({ freq: 'weekly', interval: 1 } as TaskRecurrenceRule, '2026-10-07', '2026-10-07')).toThrow(TypeError)
      expect(() => nextOccurrenceDueDate(DAILY, '2026-02-30', '2026-10-07')).toThrow(RangeError)
      expect(() => nextOccurrenceDueDate(DAILY, '2026-10-07', 'x')).toThrow(RangeError)
      expect(() => nextOccurrenceDueDate(DAILY, 7 as never, '2026-10-07')).toThrow(TypeError)
    })
  })

  describe('isWithinRecurrenceEnd (ASSUMPTION(task-e, own choice): until inclusive, count includes the first)', () => {
    it('no end ⇒ always inside', () => {
      expect(isWithinRecurrenceEnd(DAILY, '9999-01-01', 100000)).toBe(true)
    })
    it('until is inclusive', () => {
      const rule: TaskRecurrenceRule = { freq: 'daily', interval: 1, end: { until: '2026-10-10' } }
      expect(isWithinRecurrenceEnd(rule, '2026-10-10', 9)).toBe(true)
      expect(isWithinRecurrenceEnd(rule, '2026-10-11', 9)).toBe(false)
    })
    it('count is the total number of occurrences', () => {
      const rule: TaskRecurrenceRule = { freq: 'daily', interval: 1, end: { count: 3 } }
      expect(isWithinRecurrenceEnd(rule, '2026-10-09', 3)).toBe(true)
      expect(isWithinRecurrenceEnd(rule, '2026-10-10', 4)).toBe(false)
    })
    it('rejects a non-positive or fractional position', () => {
      expect(() => isWithinRecurrenceEnd(DAILY, '2026-10-07', 0)).toThrow(TypeError)
      expect(() => isWithinRecurrenceEnd(DAILY, '2026-10-07', 1.5)).toThrow(TypeError)
    })
  })

  describe('shouldSpawnOnFlip (RULED(2026-10-09): [S15]; ASSUMPTION(task-e): [D3])', () => {
    const base = { wasDone: false, done: true, recurrence: DAILY, alreadySpawned: false }
    it('an open → done flip of a recurring task that has not spawned yet ⇒ spawn', () => {
      expect(shouldSpawnOnFlip(base)).toBe(true)
    })
    it('no flip, a reopen, no rule, or an earlier spawn ⇒ no spawn', () => {
      expect(shouldSpawnOnFlip({ ...base, wasDone: true })).toBe(false) // already done: repeat complete
      expect(shouldSpawnOnFlip({ ...base, done: false })).toBe(false) // still open (all-mode partial)
      expect(shouldSpawnOnFlip({ ...base, wasDone: true, done: false })).toBe(false) // reopen
      expect(shouldSpawnOnFlip({ ...base, recurrence: null })).toBe(false)
      expect(shouldSpawnOnFlip({ ...base, alreadySpawned: true })).toBe(false) // reopen then complete again
    })
    it('a stored rule that no longer parses is corrupt data: TypeError', () => {
      expect(() => shouldSpawnOnFlip({ ...base, recurrence: { freq: 'weekly', interval: 1 } as TaskRecurrenceRule })).toThrow(TypeError)
    })
    it('the flags must be real booleans', () => {
      expect(() => shouldSpawnOnFlip({ ...base, done: 'true' as never })).toThrow(TypeError)
      expect(() => shouldSpawnOnFlip({ ...base, alreadySpawned: 0 as never })).toThrow(TypeError)
    })
  })

  describe('planSpawn (RULED(2026-10-09): [S16])', () => {
    function source(overrides: Partial<TaskOccurrenceSource> = {}): TaskOccurrenceSource {
      return {
        id: 'tsk_s1',
        title: 'Weekly report',
        description: 'send it',
        completionMode: 'all',
        timeZone: 'Asia/Shanghai',
        dueDate: '2026-10-07',
        dueTime: '09:00',
        startDate: '2026-10-05',
        startTime: '08:00',
        remindAt: new Date('2026-10-07T00:30:00.000Z'), // due_at 01:00Z − 30 min
        isMilestone: true,
        parentId: 'tsk_parent',
        depth: 1,
        createdBy: 'creator',
        recurrence: DAILY,
        seriesId: null,
        assigneeIds: ['a1', 'a2', 'a1'],
        followerIds: ['f1'],
        listIds: ['tlst_1', 'tlst_2'],
        fieldValues: [{ fieldId: 'tfld_1', value: 'opt_x' }],
        ...overrides,
      }
    }
    const spawn = (overrides: Partial<TaskOccurrenceSource> = {}, extra: Partial<{ anchorDueDate: string; occurrenceNumber: number; newTaskId: string }> = {}) =>
      planSpawn({
        source: source(overrides),
        anchorDueDate: '2026-10-07',
        occurrenceNumber: 1,
        newTaskId: 'tsk_s2',
        actorId: 'completer',
        now: NOW,
        ...extra,
      })

    it('builds the next occurrence: stepped dates, carried fields, fresh assignee rows, two events', () => {
      expect(spawn()).toEqual({
        ok: true,
        task: {
          id: 'tsk_s2',
          title: 'Weekly report',
          description: 'send it',
          status: 'open',
          completionMode: 'all',
          timeZone: 'Asia/Shanghai',
          dueDate: '2026-10-08',
          dueTime: '09:00',
          dueAt: new Date('2026-10-08T01:00:00.000Z'),
          startDate: '2026-10-06',
          startTime: '08:00',
          isMilestone: true,
          parentId: 'tsk_parent',
          depth: 1,
          createdBy: 'creator',
          recurrence: DAILY,
          seriesId: 'tsk_s1',
          previousOccurrenceId: 'tsk_s1',
        },
        assignees: [
          { userId: 'a1', completedAt: null, assignedBy: 'creator' },
          { userId: 'a2', completedAt: null, assignedBy: 'creator' },
        ],
        followerIds: ['f1'],
        listIds: ['tlst_1', 'tlst_2'],
        fieldValues: [{ fieldId: 'tfld_1', value: 'opt_x' }],
        reminder: { kind: 'shifted', remindAt: new Date('2026-10-08T00:30:00.000Z') },
        events: [
          { taskId: 'tsk_s1', type: 'recurrence_spawned', userId: 'completer', occurredAt: NOW, payload: { spawnedTaskId: 'tsk_s2' } },
          { taskId: 'tsk_s2', type: 'created', userId: 'completer', occurredAt: NOW, payload: {} },
        ],
      })
    })
    it('a later occurrence keeps the series id of the first one', () => {
      const result = spawn({ id: 'tsk_s5', seriesId: 'tsk_s1' }, { newTaskId: 'tsk_s6' })
      expect(result.ok && result.task.seriesId).toBe('tsk_s1')
      expect(result.ok && result.task.previousOccurrenceId).toBe('tsk_s5')
    })
    it('an all-day task gets due_at at 23:59:59.999 in its own time zone', () => {
      const result = spawn({ dueTime: null, startTime: null, remindAt: null })
      expect(result.ok && result.task.dueAt).toEqual(new Date('2026-10-08T15:59:59.999Z'))
    })
    it('keeps the local time of day across a daylight-saving change (due_at recomputed in the task zone)', () => {
      const result = spawn({
        timeZone: 'America/New_York',
        dueDate: '2026-03-07',
        dueTime: '09:00',
        startDate: null,
        startTime: null,
        remindAt: new Date('2026-03-07T13:30:00.000Z'), // 14:00Z − 30 min
      }, { anchorDueDate: '2026-03-07' })
      expect(result.ok && result.task.dueAt).toEqual(new Date('2026-03-08T13:00:00.000Z'))
      expect(result.ok && result.reminder).toEqual({ kind: 'shifted', remindAt: new Date('2026-03-08T12:30:00.000Z') })
    })
    it('without a source reminder: the original creator’s default policy applies', () => {
      const result = spawn({ remindAt: null })
      expect(result.ok && result.reminder).toEqual({ kind: 'default_policy', policyUserId: 'creator' })
    })
    it('the start date moves by the same number of civil days as the due date (monthly clamp)', () => {
      const result = spawn(
        { recurrence: { freq: 'monthly', interval: 1 }, dueDate: '2026-01-31', startDate: '2026-01-29', dueTime: null, startTime: null, remindAt: null },
        { anchorDueDate: '2026-01-31' },
      )
      expect(result.ok && result.task.dueDate).toBe('2026-02-28')
      expect(result.ok && result.task.startDate).toBe('2026-02-26')
    })
    it('no_due_date when the due date was cleared after the rule was set', () => {
      expect(spawn({ dueDate: null, dueTime: null, startDate: null, startTime: null, remindAt: null })).toEqual({ ok: false, reason: 'no_due_date' })
    })
    it('series_ended past until (until itself still spawns)', () => {
      expect(spawn({ recurrence: { freq: 'daily', interval: 1, end: { until: '2026-10-07' } } })).toEqual({ ok: false, reason: 'series_ended' })
      expect(spawn({ recurrence: { freq: 'daily', interval: 1, end: { until: '2026-10-08' } } }).ok).toBe(true)
    })
    it('series_ended once count occurrences exist', () => {
      const rule: TaskRecurrenceRule = { freq: 'daily', interval: 1, end: { count: 3 } }
      expect(spawn({ recurrence: rule }, { occurrenceNumber: 2 }).ok).toBe(true)
      expect(spawn({ recurrence: rule }, { occurrenceNumber: 3 })).toEqual({ ok: false, reason: 'series_ended' })
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => spawn({}, { newTaskId: 'tsk_s1' })).toThrow(TypeError) // same id as the source
      expect(() => spawn({}, { newTaskId: 'tsk__x' })).toThrow(TypeError)
      expect(() => spawn({}, { occurrenceNumber: 0 })).toThrow(TypeError)
      expect(() => spawn({ completionMode: 'some' as never })).toThrow(TypeError)
      expect(() => spawn({ depth: 5 })).toThrow(TypeError)
      expect(() => spawn({ assigneeIds: [''] })).toThrow(TypeError)
      expect(() => spawn({ recurrence: { freq: 'daily' } as TaskRecurrenceRule })).toThrow(TypeError)
      expect(() => planSpawn('x' as never)).toThrow(TypeError)
    })
  })

  describe('applySetRecurrence', () => {
    const base = { taskId: 'tsk_1', current: null, dueDate: '2026-10-07', actorId: 'u1', now: NOW }
    it('sets a rule and emits recurrence_set', () => {
      expect(applySetRecurrence({ ...base, next: { freq: 'daily', interval: 2 } })).toEqual({
        ok: true,
        recurrence: { freq: 'daily', interval: 2 },
        noop: false,
        events: [{ taskId: 'tsk_1', type: 'recurrence_set', userId: 'u1', occurredAt: NOW, payload: {} }],
      })
    })
    it('due_required without a due date', () => {
      expect(applySetRecurrence({ ...base, dueDate: null, next: DAILY })).toEqual({ ok: false, reason: 'due_required' })
    })
    it('invalid_recurrence names the failing key; checked before the due date', () => {
      expect(applySetRecurrence({ ...base, next: { freq: 'daily', interval: 0 } })).toEqual({
        ok: false,
        reason: 'invalid_recurrence',
        field: 'interval',
      })
      expect(applySetRecurrence({ ...base, dueDate: null, next: { freq: 'daily' } })).toEqual({
        ok: false,
        reason: 'invalid_recurrence',
        field: 'interval',
      })
    })
    it('an equal rule (after canonicalization) is a no-op with no event', () => {
      const current: TaskRecurrenceRule = { freq: 'weekly', interval: 1, byWeekday: [1, 3] }
      expect(applySetRecurrence({ ...base, current, next: { byWeekday: [3, 1, 3], freq: 'weekly', interval: 1 } })).toEqual({
        ok: true,
        recurrence: current,
        noop: true,
        events: [],
      })
    })
    it('a changed rule replaces the old one', () => {
      expect(applySetRecurrence({ ...base, current: DAILY, next: { freq: 'daily', interval: 1, end: { count: 5 } } })).toEqual({
        ok: true,
        recurrence: { freq: 'daily', interval: 1, end: { count: 5 } },
        noop: false,
        events: [{ taskId: 'tsk_1', type: 'recurrence_set', userId: 'u1', occurredAt: NOW, payload: {} }],
      })
      expect(applySetRecurrence({ ...base, current: { freq: 'weekly', interval: 1, byWeekday: [1] }, next: { freq: 'monthly', interval: 1 } })).toEqual({
        ok: true,
        recurrence: { freq: 'monthly', interval: 1 },
        noop: false,
        events: [{ taskId: 'tsk_1', type: 'recurrence_set', userId: 'u1', occurredAt: NOW, payload: {} }],
      })
    })
    it('a corrupt stored rule is a TypeError', () => {
      expect(() => applySetRecurrence({ ...base, current: { freq: 'x' } as never, next: DAILY })).toThrow(TypeError)
    })
  })

  describe('applyClearRecurrence (RULED(2026-10-09): [S17])', () => {
    const base = { taskId: 'tsk_1', current: DAILY, isLatestOpenOccurrence: true, actorId: 'u1', now: NOW }
    it('clears the rule on the latest open occurrence', () => {
      expect(applyClearRecurrence(base)).toEqual({
        ok: true,
        recurrence: null,
        noop: false,
        events: [{ taskId: 'tsk_1', type: 'recurrence_cleared', userId: 'u1', occurredAt: NOW, payload: {} }],
      })
    })
    it('an earlier occurrence answers not_current_occurrence', () => {
      expect(applyClearRecurrence({ ...base, isLatestOpenOccurrence: false })).toEqual({ ok: false, reason: 'not_current_occurrence' })
    })
    it('no rule is a no-op, wherever the task sits', () => {
      expect(applyClearRecurrence({ ...base, current: null, isLatestOpenOccurrence: false })).toEqual({
        ok: true,
        recurrence: null,
        noop: true,
        events: [],
      })
    })
  })

  describe('planSeriesDelete (RULED(2026-10-09): [S17])', () => {
    const CREATOR: TaskRole[] = ['creator']
    function member(id: string, previousOccurrenceId: string | null, overrides: Partial<TaskSeriesMember> = {}): TaskSeriesMember {
      return { id, previousOccurrenceId, status: 'done', deleted: false, hasRecurrence: true, actorRoles: CREATOR, ...overrides }
    }
    /** s1 (done) → s2 (done) → s3 (open). */
    const SERIES = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1'), member('tsk_s3', 'tsk_s2', { status: 'open' })]
    const NODES: TaskDeletionNodes = new Map([
      ['tsk_s1', { parentId: null }],
      ['tsk_s2', { parentId: null }],
      ['tsk_s3', { parentId: null }],
    ])
    const plan = (targetId: string, members = SERIES, nodes = NODES) => planSeriesDelete({ targetId, members, nodes, actorId: 'creator', now: NOW })

    it('deleting the latest open occurrence clears the rule of the one before it', () => {
      expect(plan('tsk_s3')).toEqual({
        ok: true,
        deleteIds: ['tsk_s3'],
        clearRecurrenceIds: ['tsk_s2'],
        events: [
          { taskId: 'tsk_s3', type: 'deleted', userId: 'creator', occurredAt: NOW, payload: {} },
          { taskId: 'tsk_s2', type: 'recurrence_cleared', userId: 'creator', occurredAt: NOW, payload: {} },
        ],
      })
    })
    it('deleting a middle occurrence also deletes the later open one; completed earlier ones stay', () => {
      const result = plan('tsk_s2')
      expect(result.ok && result.deleteIds).toEqual(['tsk_s2', 'tsk_s3'])
      expect(result.ok && result.clearRecurrenceIds).toEqual(['tsk_s1'])
    })
    it('a later COMPLETED occurrence is not deleted and becomes the one whose rule is cleared', () => {
      const result = plan('tsk_s1')
      expect(result.ok && result.deleteIds).toEqual(['tsk_s1', 'tsk_s3'])
      expect(result.ok && result.clearRecurrenceIds).toEqual(['tsk_s2'])
    })
    it('"later" follows the chain, not the order of the input array', () => {
      const shuffled = [SERIES[2], SERIES[0], SERIES[1]]
      expect(plan('tsk_s2', shuffled)).toEqual(plan('tsk_s2'))
    })
    it('already-deleted members keep the chain intact and are skipped', () => {
      const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1', { deleted: true }), member('tsk_s3', 'tsk_s2', { status: 'open' })]
      const nodes: TaskDeletionNodes = new Map([['tsk_s1', { parentId: null }], ['tsk_s3', { parentId: null }]])
      const result = plan('tsk_s3', members, nodes)
      expect(result.ok && result.deleteIds).toEqual(['tsk_s3'])
      expect(result.ok && result.clearRecurrenceIds).toEqual(['tsk_s1'])
    })
    it('an already-deleted occurrence AFTER the target is skipped, not deleted again', () => {
      // s2 (the latest open occurrence) was deleted first, then s1 is deleted: s2 is no longer in the node map.
      const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1', { status: 'open', deleted: true })]
      const nodes: TaskDeletionNodes = new Map([['tsk_s1', { parentId: null }]])
      expect(plan('tsk_s1', members, nodes)).toEqual({
        ok: true,
        deleteIds: ['tsk_s1'],
        clearRecurrenceIds: [],
        events: [{ taskId: 'tsk_s1', type: 'deleted', userId: 'creator', occurredAt: NOW, payload: {} }],
      })
    })
    it('no rule left to clear when the latest survivor has none', () => {
      const members = [member('tsk_s1', null, { hasRecurrence: false }), member('tsk_s2', 'tsk_s1', { status: 'open' })]
      const result = plan('tsk_s2', members)
      expect(result.ok && result.clearRecurrenceIds).toEqual([])
    })
    it('not_found for a target outside the series or already deleted', () => {
      expect(plan('tsk_other')).toEqual({ ok: false, reason: 'not_found', taskId: 'tsk_other' })
      const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1', { deleted: true })]
      expect(plan('tsk_s2', members)).toEqual({ ok: false, reason: 'not_found', taskId: 'tsk_s2' })
    })
    it('A4: a later open occurrence with an undeleted subtask refuses the whole plan', () => {
      const nodes: TaskDeletionNodes = new Map([...NODES, ['tsk_child', { parentId: 'tsk_s3' }]])
      expect(plan('tsk_s2', SERIES, nodes)).toEqual({ ok: false, reason: 'has_children', taskId: 'tsk_s3' })
    })
    it('only the creator may delete: a member the actor cannot delete refuses the plan', () => {
      const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1'), member('tsk_s3', 'tsk_s2', { status: 'open', actorRoles: ['assignee'] })]
      expect(plan('tsk_s2', members)).toEqual({ ok: false, reason: 'forbidden', taskId: 'tsk_s3' })
    })
    describe('a broken chain is TaskRecurrenceSeriesCorruptError', () => {
      it('two heads', () => {
        expect(() => plan('tsk_s1', [member('tsk_s1', null), member('tsk_s2', null)])).toThrow(TaskRecurrenceSeriesCorruptError)
      })
      it('a fork (two members share a predecessor)', () => {
        const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s1'), member('tsk_s3', 'tsk_s1')]
        expect(() => plan('tsk_s1', members)).toThrow(TaskRecurrenceSeriesCorruptError)
      })
      it('a member that is its own predecessor', () => {
        const members = [member('tsk_s1', null), member('tsk_s2', 'tsk_s2')]
        expect(() => plan('tsk_s1', members)).toThrow(TaskRecurrenceSeriesCorruptError)
      })
      it('a duplicate id', () => {
        expect(() => plan('tsk_s1', [member('tsk_s1', null), member('tsk_s1', null)])).toThrow(TaskRecurrenceSeriesCorruptError)
      })
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => plan('tsk_s1', [])).toThrow(TypeError)
      expect(() => plan('tsk_s1', SERIES, {} as never)).toThrow(TypeError)
      expect(() => plan('tsk_s1', [member('tsk_s1', null, { status: 'closed' as never })])).toThrow(TypeError)
    })
  })
})
