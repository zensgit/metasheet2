import { describe, expect, it } from 'vitest'
import {
  TASK_DAILY_DIGEST_TIME_OF_DAY,
  TASK_REMINDER_FLOOR_EVENT_TYPES,
  TASK_REMINDER_SCAN_BATCH,
  TASK_REMINDER_SCAN_CURSOR_START,
  TASK_REMINDER_SCAN_ORDER_BY,
  TASK_REMINDER_SCAN_WINDOW_MS,
  buildTaskDailyDigestCondition,
  buildTaskDailyDigestSourceKey,
  buildTaskEventSourceKey,
  buildTaskListEventSourceKey,
  buildTaskReminderScanCondition,
  buildTaskReminderSourceKey,
  computeDailyDigestSendAt,
  computeDefaultRemindAt,
  isDailyDigestDue,
  isInDailyDigest,
  isReminderSkippedByTaskState,
  isTaskReminderDue,
  parseRemindPolicy,
  resolveDailyDigestOccurrence,
  shouldEnqueueReminder,
  type TaskDailyDigestShape,
} from '../../src/tasks/task-reminders'
import { computeDueAt } from '../../src/tasks/task-dates'
import { TASK_SCHEDULER_INTERVAL_MAX_MS } from '../../src/services/task-notification-flags'

describe('task-reminders', () => {
  describe('parseRemindPolicy', () => {
    it('missing (null/undefined) -> default', () => {
      expect(parseRemindPolicy(null)).toEqual({ ok: true, policy: { mode: 'default' } })
      expect(parseRemindPolicy(undefined)).toEqual({ ok: true, policy: { mode: 'default' } })
    })

    it('{"mode":"default"} -> ok', () => {
      expect(parseRemindPolicy({ mode: 'default' })).toEqual({ ok: true, policy: { mode: 'default' } })
    })

    it('{"mode":"none"} -> ok', () => {
      expect(parseRemindPolicy({ mode: 'none' })).toEqual({ ok: true, policy: { mode: 'none' } })
    })

    it('unknown mode -> invalid_policy', () => {
      expect(parseRemindPolicy({ mode: 'weekly' })).toEqual({ ok: false, reason: 'invalid_policy' })
    })

    it('non-object -> invalid_policy', () => {
      expect(parseRemindPolicy('default')).toEqual({ ok: false, reason: 'invalid_policy' })
      expect(parseRemindPolicy(42)).toEqual({ ok: false, reason: 'invalid_policy' })
    })

    it('array -> invalid_policy', () => {
      expect(parseRemindPolicy(['default'])).toEqual({ ok: false, reason: 'invalid_policy' })
    })

    it('extra keys beyond mode -> invalid_policy (strict closed shape)', () => {
      expect(parseRemindPolicy({ mode: 'default', extra: 1 })).toEqual({ ok: false, reason: 'invalid_policy' })
    })

    it('missing mode key -> invalid_policy', () => {
      expect(parseRemindPolicy({})).toEqual({ ok: false, reason: 'invalid_policy' })
    })
  })

  describe('computeDefaultRemindAt', () => {
    it('policy.mode "none" -> null even with a due date present', () => {
      const result = computeDefaultRemindAt({
        dueDate: '2026-09-30',
        dueTime: '10:00',
        dueAt: new Date('2026-09-30T10:00:00.000Z'),
        timeZone: 'UTC',
        policy: { mode: 'none' },
      })
      expect(result).toBeNull()
    })

    it('no due date at all -> null', () => {
      const result = computeDefaultRemindAt({
        dueDate: null,
        dueTime: null,
        dueAt: null,
        timeZone: 'UTC',
        policy: { mode: 'default' },
      })
      expect(result).toBeNull()
    })

    it('scheduled: due_at - 30min', () => {
      const dueAt = new Date('2026-09-30T10:00:00.000Z')
      const result = computeDefaultRemindAt({
        dueDate: '2026-09-30',
        dueTime: '10:00',
        dueAt,
        timeZone: 'UTC',
        policy: { mode: 'default' },
      })
      expect(result?.toISOString()).toBe('2026-09-30T09:30:00.000Z')
    })

    it('boundary: scheduled due_time 00:10 rolls the reminder back to the PREVIOUS calendar day', () => {
      const dueAt = new Date('2026-09-30T00:10:00.000Z')
      const result = computeDefaultRemindAt({
        dueDate: '2026-09-30',
        dueTime: '00:10',
        dueAt,
        timeZone: 'UTC',
        policy: { mode: 'default' },
      })
      expect(result?.toISOString()).toBe('2026-09-29T23:40:00.000Z')
    })

    it('scheduled with dueTime given but no computed dueAt -> throws (caller contract violation)', () => {
      expect(() =>
        computeDefaultRemindAt({
          dueDate: '2026-09-30',
          dueTime: '10:00',
          dueAt: null,
          timeZone: 'UTC',
          policy: { mode: 'default' },
        }),
      ).toThrow(TypeError)
    })

    it('all-day: 18:00 local in tasks.time_zone via computeDateReminderOccurrence', () => {
      const result = computeDefaultRemindAt({
        dueDate: '2026-09-30',
        dueTime: null,
        dueAt: null,
        timeZone: 'Asia/Shanghai',
        policy: { mode: 'default' },
      })
      // Asia/Shanghai is UTC+8 year-round (no DST) -> 18:00 local = 10:00 UTC.
      expect(result?.toISOString()).toBe('2026-09-30T10:00:00.000Z')
    })

    it('all-day: dueDate null -> null', () => {
      const result = computeDefaultRemindAt({
        dueDate: null,
        dueTime: null,
        dueAt: null,
        timeZone: 'Asia/Shanghai',
        policy: { mode: 'default' },
      })
      expect(result).toBeNull()
    })

    it('all-day: invalid IANA time zone THROWS (never silently degrades to UTC)', () => {
      expect(() =>
        computeDefaultRemindAt({
          dueDate: '2026-09-30',
          dueTime: null,
          dueAt: null,
          timeZone: 'Not/AZone',
          policy: { mode: 'default' },
        }),
      ).toThrow(RangeError)
    })

    // Confirmed bug (independent review): `computeDateReminderOccurrence`'s own date parser is
    // `new Date(String(dateValue))` — the platform's LENIENT parser, not a strict YYYY-MM-DD one.
    // `new Date('2026-02-30')` silently rolls over to 2026-03-02 instead of erroring;
    // `new Date('2026-3-8')` (not zero-padded) silently parses instead of being rejected as
    // malformed. Both would make computeDefaultRemindAt return a WRONG reminder instant instead of
    // throwing — this is what `assertValidCalendarDateString` (mirroring task-dates.ts's private
    // `parseIsoDate`) now catches BEFORE either string ever reaches computeDateReminderOccurrence.
    it('all-day: a syntactically-invalid dueDate ("2026-3-8", not zero-padded) THROWS RangeError', () => {
      expect(() =>
        computeDefaultRemindAt({
          dueDate: '2026-3-8',
          dueTime: null,
          dueAt: null,
          timeZone: 'UTC',
          policy: { mode: 'default' },
        }),
      ).toThrow(RangeError)
    })

    it('all-day: a syntactically-valid but NONEXISTENT calendar date ("2026-02-30") THROWS RangeError, never silently rolls over', () => {
      expect(() =>
        computeDefaultRemindAt({
          dueDate: '2026-02-30',
          dueTime: null,
          dueAt: null,
          timeZone: 'UTC',
          policy: { mode: 'default' },
        }),
      ).toThrow(RangeError)
    })

    describe('DST dates — America/New_York (all-day branch, offsetDays: 0)', () => {
      it('spring-forward day (2026-03-08): 18:00 local is already EDT (UTC-4) -> 22:00 UTC', () => {
        const result = computeDefaultRemindAt({
          dueDate: '2026-03-08',
          dueTime: null,
          dueAt: null,
          timeZone: 'America/New_York',
          policy: { mode: 'default' },
        })
        expect(result?.toISOString()).toBe('2026-03-08T22:00:00.000Z')
      })

      it('fall-back day (2026-11-01): 18:00 local is already EST (UTC-5) -> 23:00 UTC', () => {
        const result = computeDefaultRemindAt({
          dueDate: '2026-11-01',
          dueTime: null,
          dueAt: null,
          timeZone: 'America/New_York',
          policy: { mode: 'default' },
        })
        expect(result?.toISOString()).toBe('2026-11-01T23:00:00.000Z')
      })
    })
  })

  describe('shouldEnqueueReminder', () => {
    it('remindAt strictly after writtenAt -> true', () => {
      expect(shouldEnqueueReminder(new Date('2026-09-30T10:01:00Z'), new Date('2026-09-30T10:00:00Z'))).toBe(true)
    })

    it('boundary: remindAt === writtenAt -> false (not enqueued)', () => {
      expect(shouldEnqueueReminder(new Date('2026-09-30T10:00:00Z'), new Date('2026-09-30T10:00:00Z'))).toBe(false)
    })

    it('remindAt before writtenAt -> false', () => {
      expect(shouldEnqueueReminder(new Date('2026-09-30T09:59:00Z'), new Date('2026-09-30T10:00:00Z'))).toBe(false)
    })
  })

  describe('isTaskReminderDue — R06 scan window', () => {
    const now = new Date('2026-09-30T12:00:00.000Z')
    const floor = new Date('2026-09-30T00:00:00.000Z')

    it('due now, within window, at/after floor -> true', () => {
      expect(isTaskReminderDue(new Date('2026-09-30T11:00:00.000Z'), now, floor)).toBe(true)
    })

    it('boundary: remindAt === now -> true (remind_at <= now is inclusive)', () => {
      expect(isTaskReminderDue(now, now, floor)).toBe(true)
    })

    it('remindAt in the future -> false', () => {
      expect(isTaskReminderDue(new Date('2026-09-30T12:00:00.001Z'), now, floor)).toBe(false)
    })

    it('boundary: remindAt exactly at the scan-window edge (now - W) -> false (window is exclusive there)', () => {
      const edge = new Date(now.getTime() - TASK_REMINDER_SCAN_WINDOW_MS)
      expect(isTaskReminderDue(edge, now, floor)).toBe(false)
    })

    it('boundary: remindAt just inside the scan window (now - W + 1ms) -> true', () => {
      const justInside = new Date(now.getTime() - TASK_REMINDER_SCAN_WINDOW_MS + 1)
      expect(isTaskReminderDue(justInside, now, floor)).toBe(true)
    })

    // The window guard (2h) rejects anything more than 2h before `now`, so a case meant to isolate
    // the FLOOR guard alone must use a `floor` close enough to `now` that the window guard would
    // NOT already reject it on its own — otherwise the test passes for the wrong reason (this
    // module's own earlier version of this test did exactly that: floor 12h before now, so the
    // window guard silently did the rejecting instead of the floor guard being exercised at all).
    it('boundary: ONLY the floor guard fails — remindAt is 1ms before a floor that itself is well within the scan window', () => {
      const nearFloor = new Date(now.getTime() - 60 * 60 * 1000) // now - 1h: inside the 2h window
      const justBeforeNearFloor = new Date(nearFloor.getTime() - 1) // floor - 1ms
      // Sanity: justBeforeNearFloor is NOT rejected by the window guard on its own (only ~1h1ms
      // before `now`, inside the 2h window) and is NOT in the future — the floor guard is the only
      // one that can produce `false` here.
      expect(now.getTime() - justBeforeNearFloor.getTime()).toBeLessThan(TASK_REMINDER_SCAN_WINDOW_MS)
      expect(justBeforeNearFloor.getTime()).toBeLessThan(now.getTime())
      expect(isTaskReminderDue(justBeforeNearFloor, now, nearFloor)).toBe(false)
    })

    it('boundary: remindAt exactly at the floor -> true (floor <= remind_at is inclusive)', () => {
      expect(isTaskReminderDue(floor, new Date(floor.getTime() + 1000), floor)).toBe(true)
    })

    it('R06: TASK_REMINDER_SCAN_WINDOW_MS is pinned to 2 hours (ASSUMPTION(task-d): [R06])', () => {
      expect(TASK_REMINDER_SCAN_WINDOW_MS).toBe(2 * 60 * 60 * 1000)
    })

    it('absolute-time case: remindAt exactly 2h30m before now -> false (well outside the 2h window)', () => {
      const twoHoursThirtyBefore = new Date(now.getTime() - 2.5 * 60 * 60 * 1000)
      expect(isTaskReminderDue(twoHoursThirtyBefore, now, floor)).toBe(false)
    })
  })

  describe('isReminderSkippedByTaskState', () => {
    const REMIND_AT = new Date('2026-09-30T10:00:00.000Z')

    it('open, not deleted, remind_at matches the delivery -> not skipped', () => {
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: null, remindAt: REMIND_AT }, REMIND_AT),
      ).toBe(false)
    })

    it('done -> skipped', () => {
      expect(
        isReminderSkippedByTaskState({ status: 'done', deletedAt: null, remindAt: REMIND_AT }, REMIND_AT),
      ).toBe(true)
    })

    it('soft-deleted -> skipped, even if status open', () => {
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: new Date(), remindAt: REMIND_AT }, REMIND_AT),
      ).toBe(true)
    })

    it('done AND deleted -> skipped', () => {
      expect(
        isReminderSkippedByTaskState({ status: 'done', deletedAt: new Date(), remindAt: REMIND_AT }, REMIND_AT),
      ).toBe(true)
    })

    // R06 third skip condition (relayed by independent review; see the ASSUMPTION note on the
    // function itself — pack wording not re-checked against the original ruling text).
    it('R06 third skip condition: task remind_at differs from the delivery remind_at -> skipped', () => {
      const taskRemindAt = new Date('2026-09-30T11:00:00.000Z')
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: null, remindAt: taskRemindAt }, REMIND_AT),
      ).toBe(true)
    })

    it('R06 third skip condition: task remind_at is null (policy/date cleared since enqueue) -> skipped', () => {
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: null, remindAt: null }, REMIND_AT),
      ).toBe(true)
    })

    it('remind_at comparison is BY VALUE (getTime), not by reference — two Date objects for the same instant match', () => {
      const same = new Date(REMIND_AT.getTime())
      expect(same).not.toBe(REMIND_AT) // different object identity, same instant
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: null, remindAt: same }, REMIND_AT),
      ).toBe(false)
    })

    it('a 1ms remind_at drift is enough to skip (no fuzzy tolerance)', () => {
      const driftedByOneMs = new Date(REMIND_AT.getTime() + 1)
      expect(
        isReminderSkippedByTaskState({ status: 'open', deletedAt: null, remindAt: driftedByOneMs }, REMIND_AT),
      ).toBe(true)
    })
  })

  describe('source_key builders — all four families', () => {
    it('family 1: buildTaskReminderSourceKey', () => {
      const key = buildTaskReminderSourceKey({
        taskId: 'tsk_1',
        remindAt: new Date('2026-09-30T10:00:00.000Z'),
        userId: 'u1',
        channel: 'in_app',
      })
      expect(key).toBe('task_reminder:tsk_1:2026-09-30T10:00:00.000Z:recipient:u1:channel:in_app')
    })

    it('family 2: buildTaskDailyDigestSourceKey', () => {
      const key = buildTaskDailyDigestSourceKey({ date: '2026-09-30', userId: 'u1', channel: 'in_app' })
      expect(key).toBe('task_daily:2026-09-30:recipient:u1:channel:in_app')
    })

    it('family 3: buildTaskEventSourceKey', () => {
      const key = buildTaskEventSourceKey({ taskId: 'tsk_1', eventId: 'tev_1', userId: 'u1', channel: 'in_app' })
      expect(key).toBe('task_event:tsk_1:tev_1:recipient:u1:channel:in_app')
    })

    it('family 4: buildTaskListEventSourceKey', () => {
      const key = buildTaskListEventSourceKey({ listId: 'tlst_1', eventId: 'tlev_1', userId: 'u1', channel: 'in_app' })
      expect(key).toBe('task_list_event:tlst_1:tlev_1:recipient:u1:channel:in_app')
    })

    it('every builder throws on an empty required string', () => {
      expect(() =>
        buildTaskReminderSourceKey({ taskId: '', remindAt: new Date(), userId: 'u1', channel: 'c' }),
      ).toThrow(TypeError)
      expect(() => buildTaskDailyDigestSourceKey({ date: '', userId: 'u1', channel: 'c' })).toThrow(TypeError)
      expect(() =>
        buildTaskEventSourceKey({ taskId: 't', eventId: '', userId: 'u1', channel: 'c' }),
      ).toThrow(TypeError)
      expect(() =>
        buildTaskListEventSourceKey({ listId: 'l', eventId: 'e', userId: '', channel: 'c' }),
      ).toThrow(TypeError)
    })
  })

  describe('isInDailyDigest', () => {
    const NOW = new Date('2026-09-15T12:00:00.000Z')
    const TZ = 'UTC'

    function digestTask(overrides: Partial<TaskDailyDigestShape>): TaskDailyDigestShape {
      return {
        status: 'open',
        completedByViewer: false,
        dueAt: null,
        dueDate: null,
        dueTime: null,
        timeZone: 'UTC',
        ...overrides,
      }
    }

    it('status done -> false, even if overdue', () => {
      const task = digestTask({ status: 'done', dueDate: '2026-01-01' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(false)
    })

    it('completedByViewer -> false', () => {
      const task = digestTask({ completedByViewer: true, dueDate: '2026-01-01' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(false)
    })

    it('no due date at all -> false', () => {
      expect(isInDailyDigest(digestTask({}), NOW, TZ)).toBe(false)
    })

    it('all-day: overdue (dueDate before today) -> true', () => {
      const task = digestTask({ dueDate: '2026-09-14' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('all-day: due today -> true', () => {
      const task = digestTask({ dueDate: '2026-09-15' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('all-day: due tomorrow -> true', () => {
      const task = digestTask({ dueDate: '2026-09-16' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('all-day: due day after tomorrow -> false', () => {
      const task = digestTask({ dueDate: '2026-09-17' })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(false)
    })

    it('scheduled: overdue (dueAt before now) -> true', () => {
      const task = digestTask({ dueTime: '09:00', dueAt: new Date('2026-09-15T09:00:00.000Z') })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('scheduled: due within the next two civil days -> true', () => {
      const task = digestTask({ dueTime: '09:00', dueAt: new Date('2026-09-16T23:00:00.000Z') })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('boundary: scheduled due exactly at the start of the day after tomorrow -> false (strict <)', () => {
      const task = digestTask({ dueTime: '00:00', dueAt: new Date('2026-09-17T00:00:00.000Z') })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(false)
    })

    it('boundary: scheduled due 1ms before the start of the day after tomorrow -> true', () => {
      const task = digestTask({ dueTime: '23:59', dueAt: new Date('2026-09-16T23:59:59.999Z') })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(true)
    })

    it('scheduled with dueTime set but no dueAt -> false (defensive)', () => {
      const task = digestTask({ dueTime: '09:00', dueAt: null })
      expect(isInDailyDigest(task, NOW, TZ)).toBe(false)
    })

    it('today/tomorrow is evaluated in the VIEWER time zone, not UTC', () => {
      // 2026-09-15T12:00:00Z is 2026-09-15T20:00 in Asia/Shanghai (UTC+8) -> "today" there is still
      // 09-15, "tomorrow" 09-16 — a task due 09-17 must be OUT of the digest in Shanghai even though
      // it would be "tomorrow" for a viewer several hours further west.
      const task = digestTask({ dueDate: '2026-09-17' })
      expect(isInDailyDigest(task, NOW, 'Asia/Shanghai')).toBe(false)
      const dueTomorrowInShanghai = digestTask({ dueDate: '2026-09-16' })
      expect(isInDailyDigest(dueTomorrowInShanghai, NOW, 'Asia/Shanghai')).toBe(true)
    })

    describe('discriminating viewer-time-zone cases (independent review, item 4)', () => {
      // NOW = 2026-09-15T20:00Z. In UTC, "today" is 09-15 and "tomorrow" is 09-16 (day-after-
      // tomorrow starts 09-17). In Asia/Shanghai (UTC+8, local = 2026-09-16T04:00), "today" is
      // already 09-16 and "tomorrow" is 09-17 — the SAME calendar date reads as "day after
      // tomorrow" (excluded) under UTC and "tomorrow" (included) under Shanghai.
      const DISC_NOW = new Date('2026-09-15T20:00:00.000Z')

      it('all-day due 2026-09-17: true for Asia/Shanghai, false for UTC (same instant, different viewer tz)', () => {
        const task = digestTask({ dueDate: '2026-09-17' })
        expect(isInDailyDigest(task, DISC_NOW, 'Asia/Shanghai')).toBe(true)
        expect(isInDailyDigest(task, DISC_NOW, 'UTC')).toBe(false)
      })

      it('scheduled: a dueAt that falls between UTC\'s and the recipient\'s day-after-tomorrow start', () => {
        // UTC's day-after-tomorrow starts 2026-09-17T00:00:00Z; Shanghai's (day-after-tomorrow in
        // Shanghai local, converted to UTC) starts 2026-09-17T16:00:00Z. A dueAt in between —
        // 2026-09-17T10:00:00Z — is EXCLUDED for a UTC recipient but INCLUDED for a Shanghai one.
        const dueAt = new Date('2026-09-17T10:00:00.000Z')
        const task = digestTask({ dueTime: '18:00', dueAt })
        expect(isInDailyDigest(task, DISC_NOW, 'UTC')).toBe(false)
        expect(isInDailyDigest(task, DISC_NOW, 'Asia/Shanghai')).toBe(true)
      })

      it('task.timeZone and the recipient (viewerTz) time zone DISAGREE — only viewerTz may affect the outcome', () => {
        // task.timeZone='Asia/Tokyo' (UTC+9) disagrees with viewerTz='UTC'. At DISC_NOW, Tokyo local
        // is already 2026-09-16 (tomorrow would read as 09-17 in Tokyo), but the recipient's own
        // viewerTz is UTC, where 09-17 is the DAY AFTER tomorrow — this must read `false`. A
        // function that accidentally consulted `task.timeZone` instead of (or in addition to)
        // `viewerTz` for this boundary would wrongly return `true` here (mutation-checked below).
        const task = digestTask({ dueDate: '2026-09-17', timeZone: 'Asia/Tokyo' })
        expect(isInDailyDigest(task, DISC_NOW, 'UTC')).toBe(false)
      })
    })
  })

  describe('isInDailyDigest: all-day rows carry a real dueAt', () => {
    // Real all-day rows store dueAt = 23:59:59.999 of dueDate in the TASK's zone (computeDueAt).
    // The all-day branch must compare civil dates in the viewer's zone and ignore that instant.
    const task: TaskDailyDigestShape = {
      status: 'open',
      completedByViewer: false,
      dueDate: '2026-09-17',
      dueTime: null,
      timeZone: 'America/Los_Angeles',
      dueAt: computeDueAt({ dueDate: '2026-09-17', timeZone: 'America/Los_Angeles' }),
    }

    it('LA task due 09-17, Shanghai viewer at 09-16 20:00 local -> due tomorrow -> true', () => {
      // dueAt = 2026-09-18T06:59:59.999Z, which is after the Shanghai day-after-tomorrow boundary
      // (2026-09-17T16:00Z); an implementation that branched on dueAt would wrongly say false.
      expect(task.dueAt?.toISOString()).toBe('2026-09-18T06:59:59.999Z')
      expect(isInDailyDigest(task, new Date('2026-09-16T12:00:00.000Z'), 'Asia/Shanghai')).toBe(true)
    })

    it('same row, Shanghai viewer two days earlier -> false', () => {
      expect(isInDailyDigest(task, new Date('2026-09-14T12:00:00.000Z'), 'Asia/Shanghai')).toBe(false)
    })
  })

  describe('buildTaskDailyDigestCondition', () => {
    it('derives from the assigned arm, binds $1/$2/$3, and never writes its own role arm', () => {
      const result = buildTaskDailyDigestCondition({ actorParam: 'user-1', orgParam: 'org-1', viewerTzParam: 'Asia/Shanghai' })
      expect(result.params).toEqual(['user-1', 'org-1', 'Asia/Shanghai'])
      expect(result.sql).toContain('EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)')
      expect(result.sql).not.toContain('task_followers')
      expect(result.sql).not.toContain('created_by')
      expect(result.sql).toContain("tasks.status = 'open'")
      expect(result.sql).toContain('$3')
    })

    // Full-text SQL pin (same style as task-access.test.ts's `buildTaskPendingCondition` pins) —
    // freezes the exact NOT EXISTS clause and the +1/+2 date-offset arithmetic for BOTH branches, so
    // a future edit that silently changes either offset, drops the `completed_at IS NOT NULL`
    // clause, or swaps `<`/`<=` is caught character-for-character, not just by substring `toContain`
    // checks (item 5, independent review; mutation-checked below).
    it('full-text SQL pin: the exact NOT EXISTS clause and the all-day (+1) / scheduled (+2) date offsets', () => {
      const { sql, params } = buildTaskDailyDigestCondition({
        actorParam: 'u1',
        orgParam: 'org1',
        viewerTzParam: 'Asia/Shanghai',
      })
      expect(sql).toBe(
        "(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)) AND tasks.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id AND ta_done.user_id = $1 AND ta_done.completed_at IS NOT NULL) AND ((tasks.due_time IS NOT NULL AND tasks.due_at < (((now() AT TIME ZONE $3)::date + 2)::timestamp AT TIME ZONE $3)) OR (tasks.due_time IS NULL AND tasks.due_date <= ((now() AT TIME ZONE $3)::date + 1)))",
      )
      expect(params).toEqual(['u1', 'org1', 'Asia/Shanghai'])
    })
  })
})

// ── PR-3b S1 additions (design §6.2 / §6.3) ─────────────────────────────────────────────────────

describe('task-reminders — scheduler scan pieces (PR-3b S1)', () => {
  const now = new Date('2026-10-07T12:00:00.000Z')

  describe('constants', () => {
    it('TASK_REMINDER_SCAN_BATCH is 500 (ASSUMPTION(task-m4): [own-3b-08])', () => {
      expect(TASK_REMINDER_SCAN_BATCH).toBe(500)
    })

    it('TASK_REMINDER_FLOOR_EVENT_TYPES is exactly created + remind_changed ([R06])', () => {
      expect(TASK_REMINDER_FLOOR_EVENT_TYPES).toEqual(['created', 'remind_changed'])
    })

    it('the scheduler interval ceiling is half the scan window W (W ≥ 2 × interval, design §6.2)', () => {
      expect(TASK_SCHEDULER_INTERVAL_MAX_MS).toBe(TASK_REMINDER_SCAN_WINDOW_MS / 2)
      expect(TASK_REMINDER_SCAN_WINDOW_MS).toBe(7_200_000)
    })

    it('the first-page cursor is (-infinity, "") ([own-3b-15]) and is frozen', () => {
      expect(TASK_REMINDER_SCAN_CURSOR_START).toEqual({ afterAtParam: '-infinity', afterIdParam: '' })
      expect(Object.isFrozen(TASK_REMINDER_SCAN_CURSOR_START)).toBe(true)
    })

    it('the ORDER BY paired with the keyset condition is remind_at, id ascending', () => {
      expect(TASK_REMINDER_SCAN_ORDER_BY).toBe('tasks.remind_at ASC, tasks.id ASC')
    })
  })

  describe('buildTaskReminderScanCondition', () => {
    it('full-text SQL pin: window upper/lower bound, open + live, keyset cursor; params $1..$4 in order', () => {
      const { sql, params } = buildTaskReminderScanCondition({
        nowParam: now,
        windowMsParam: TASK_REMINDER_SCAN_WINDOW_MS,
        ...TASK_REMINDER_SCAN_CURSOR_START,
      })
      expect(sql).toBe(
        'tasks.remind_at IS NOT NULL AND tasks.remind_at <= $1::timestamptz ' +
          "AND tasks.remind_at > ($1::timestamptz - ($2::int * interval '1 millisecond')) " +
          "AND tasks.status = 'open' AND tasks.deleted_at IS NULL " +
          'AND (tasks.remind_at, tasks.id) > ($3::timestamptz, $4::text)',
      )
      expect(params).toEqual([now, 7_200_000, '-infinity', ''])
    })

    it('a later page passes the previous page\'s last (remind_at, id) as $3/$4', () => {
      const afterAt = new Date('2026-10-07T11:30:00.000Z')
      const { sql, params } = buildTaskReminderScanCondition({
        nowParam: now,
        windowMsParam: 7_200_000,
        afterAtParam: afterAt,
        afterIdParam: 'tsk_0000000000000000000001',
      })
      expect(params).toEqual([now, 7_200_000, afterAt, 'tsk_0000000000000000000001'])
      expect(sql).toContain('(tasks.remind_at, tasks.id) > ($3::timestamptz, $4::text)')
    })

    it('is a cross-org scan: no org clause, no $5 (the page LIMIT is the caller\'s)', () => {
      const { sql } = buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, ...TASK_REMINDER_SCAN_CURSOR_START })
      expect(sql).not.toContain('org_id')
      expect(sql).not.toContain('$5')
      expect(sql).not.toContain('LIMIT')
    })

    it('both window bounds are present: inclusive upper (<= now), exclusive lower (> now − W)', () => {
      const { sql } = buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, ...TASK_REMINDER_SCAN_CURSOR_START })
      expect(sql).toContain('tasks.remind_at <= $1::timestamptz')
      expect(sql).toContain("tasks.remind_at > ($1::timestamptz - ($2::int * interval '1 millisecond'))")
      expect(sql).toContain("tasks.status = 'open' AND tasks.deleted_at IS NULL")
    })

    it('rejects a non-object input (the gate-20 probe shape) with TypeError', () => {
      expect(() => buildTaskReminderScanCondition('x' as never)).toThrow(TypeError)
      expect(() => buildTaskReminderScanCondition(null as never)).toThrow(TypeError)
    })

    it('rejects a non-Date / invalid now', () => {
      expect(() =>
        buildTaskReminderScanCondition({ nowParam: '2026-10-07T12:00:00Z' as never, windowMsParam: 1000, ...TASK_REMINDER_SCAN_CURSOR_START }),
      ).toThrow(TypeError)
      expect(() =>
        buildTaskReminderScanCondition({ nowParam: new Date(NaN), windowMsParam: 1000, ...TASK_REMINDER_SCAN_CURSOR_START }),
      ).toThrow(TypeError)
    })

    it('rejects a window that is not a positive int4 (0, negative, fraction, 2^31, text)', () => {
      for (const bad of [0, -1, 1.5, 2_147_483_648, Number.NaN, 'x']) {
        expect(() =>
          buildTaskReminderScanCondition({ nowParam: now, windowMsParam: bad as never, ...TASK_REMINDER_SCAN_CURSOR_START }),
        ).toThrow(TypeError)
      }
      expect(() =>
        buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 2_147_483_647, ...TASK_REMINDER_SCAN_CURSOR_START }),
      ).not.toThrow()
    })

    it('a cursor given as the database text of remind_at (microseconds kept) is passed through verbatim', () => {
      for (const afterAtParam of [
        '2026-10-07 11:30:00.123456+00',
        '2026-10-07 19:30:00.123456+08',
        '2026-10-07 06:00:00+05:30',
        '2026-10-07 11:30:00+00',
        '2026-10-07T11:30:00.123Z',
      ]) {
        const { params } = buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, afterAtParam, afterIdParam: 'tsk_1' })
        expect(params).toEqual([now, 1000, afterAtParam, 'tsk_1'])
      }
    })

    it('rejects a cursor that is not -infinity, a valid Date or a timestamptz text, or a non-string id', () => {
      for (const afterAtParam of ['yesterday', 'now', 'infinity', '', ' ', '2026-10-07', '2026-10-07 11:30', '2026-10-07 11:30:00', 'x', 7]) {
        expect(
          () => buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, afterAtParam: afterAtParam as never, afterIdParam: '' }),
          String(afterAtParam),
        ).toThrow(TypeError)
      }
      expect(() =>
        buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, afterAtParam: new Date(NaN), afterIdParam: '' }),
      ).toThrow(TypeError)
      expect(() =>
        buildTaskReminderScanCondition({ nowParam: now, windowMsParam: 1000, afterAtParam: '-infinity', afterIdParam: 7 as never }),
      ).toThrow(TypeError)
    })
  })

  describe('computeDailyDigestSendAt (R07: 09:00 local)', () => {
    it('TASK_DAILY_DIGEST_TIME_OF_DAY is 09:00', () => {
      expect(TASK_DAILY_DIGEST_TIME_OF_DAY).toBe('09:00')
    })

    it('three zones on one date: Asia/Shanghai, UTC, America/New_York (EDT)', () => {
      expect(computeDailyDigestSendAt('2026-10-07', 'Asia/Shanghai').toISOString()).toBe('2026-10-07T01:00:00.000Z')
      expect(computeDailyDigestSendAt('2026-10-07', 'UTC').toISOString()).toBe('2026-10-07T09:00:00.000Z')
      expect(computeDailyDigestSendAt('2026-10-07', 'America/New_York').toISOString()).toBe('2026-10-07T13:00:00.000Z')
    })

    it('a UTC+14 zone: local 09:00 is the previous UTC day', () => {
      expect(computeDailyDigestSendAt('2026-10-07', 'Pacific/Kiritimati').toISOString()).toBe('2026-10-06T19:00:00.000Z')
    })

    it('DST: America/New_York on the fall-back day is EST (UTC−5); Europe/London on the spring-forward day is BST (UTC+1)', () => {
      expect(computeDailyDigestSendAt('2026-11-01', 'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z')
      expect(computeDailyDigestSendAt('2026-03-29', 'Europe/London').toISOString()).toBe('2026-03-29T08:00:00.000Z')
    })

    it('rejects a value that is not a YYYY-MM-DD string (TypeError, incl. the gate-20 probe) and a nonexistent date (RangeError)', () => {
      expect(() => computeDailyDigestSendAt(20261007 as never, 'UTC')).toThrow(TypeError)
      expect(() => computeDailyDigestSendAt('x', 'x')).toThrow(TypeError)
      expect(() => computeDailyDigestSendAt('x', 'UTC')).toThrow(TypeError)
      expect(() => computeDailyDigestSendAt('2026-3-8', 'UTC')).toThrow(TypeError)
      expect(() => computeDailyDigestSendAt('2026-02-30', 'UTC')).toThrow(RangeError)
      expect(() => computeDailyDigestSendAt('2026-02-30', 'UTC')).toThrow('computeDailyDigestSendAt: "2026-02-30" is not a real calendar date')
    })

    it('the shared calendar check keeps computeDefaultRemindAt\'s own messages and classes (task D unchanged)', () => {
      const allDay = { dueTime: null, dueAt: null, timeZone: 'UTC', policy: { mode: 'default' as const } }
      expect(() => computeDefaultRemindAt({ ...allDay, dueDate: '2026-3-8' })).toThrow(
        new RangeError('computeDefaultRemindAt: dueDate must be YYYY-MM-DD, got "2026-3-8"'),
      )
      expect(() => computeDefaultRemindAt({ ...allDay, dueDate: '2026-02-30' })).toThrow(
        new RangeError('computeDefaultRemindAt: "2026-02-30" is not a real calendar date'),
      )
      expect(() => computeDefaultRemindAt({ ...allDay, dueDate: 20261007 as never })).toThrow(RangeError)
    })

    it('rejects an invalid IANA zone (never degrades to UTC)', () => {
      expect(() => computeDailyDigestSendAt('2026-10-07', 'Not/AZone')).toThrow(RangeError)
      expect(() => computeDailyDigestSendAt('2026-10-07', '')).toThrow(RangeError)
      expect(() => computeDailyDigestSendAt('2026-10-07', 'x')).toThrow(RangeError)
    })
  })

  describe('isDailyDigestDue / resolveDailyDigestOccurrence (sendAt ≤ now < sendAt + W; [own-3b-02])', () => {
    const sendAt = new Date('2026-10-07T01:00:00.000Z') // 09:00 Asia/Shanghai

    it('sendAt − 1ms -> false', () => {
      expect(isDailyDigestDue(new Date(sendAt.getTime() - 1), 'Asia/Shanghai')).toBe(false)
    })

    it('sendAt -> true', () => {
      expect(isDailyDigestDue(sendAt, 'Asia/Shanghai')).toBe(true)
    })

    it('sendAt + W − 1ms -> true', () => {
      expect(isDailyDigestDue(new Date(sendAt.getTime() + TASK_REMINDER_SCAN_WINDOW_MS - 1), 'Asia/Shanghai')).toBe(true)
    })

    it('sendAt + W -> false (no catch-up later in the day)', () => {
      expect(isDailyDigestDue(new Date(sendAt.getTime() + TASK_REMINDER_SCAN_WINDOW_MS), 'Asia/Shanghai')).toBe(false)
      expect(isDailyDigestDue(new Date('2026-10-07T07:00:00.000Z'), 'Asia/Shanghai')).toBe(false) // 15:00 local
    })

    it('resolveDailyDigestOccurrence exposes localDate, sendAt and due', () => {
      const occ = resolveDailyDigestOccurrence(new Date('2026-10-07T01:30:00.000Z'), 'Asia/Shanghai')
      expect(occ.localDate).toBe('2026-10-07')
      expect(occ.sendAt.toISOString()).toBe('2026-10-07T01:00:00.000Z')
      expect(occ.due).toBe(true)
    })

    it('two recipients in different zones at one instant: only the one at 09:xx local is due, each with its own local date', () => {
      const at = new Date('2026-10-06T19:30:00.000Z') // 09:30 Pacific/Kiritimati (Oct 7), 03:30 Asia/Shanghai (Oct 7)
      const kiritimati = resolveDailyDigestOccurrence(at, 'Pacific/Kiritimati')
      const shanghai = resolveDailyDigestOccurrence(at, 'Asia/Shanghai')
      expect(kiritimati).toMatchObject({ localDate: '2026-10-07', due: true })
      expect(kiritimati.sendAt.toISOString()).toBe('2026-10-06T19:00:00.000Z')
      expect(shanghai).toMatchObject({ localDate: '2026-10-07', due: false })
    })

    it('the local date rolls with now: just before local midnight is not due, the next morning is', () => {
      expect(isDailyDigestDue(new Date('2026-10-07T15:59:59.999Z'), 'Asia/Shanghai')).toBe(false) // 23:59:59 Oct 7
      expect(isDailyDigestDue(new Date('2026-10-08T01:00:00.000Z'), 'Asia/Shanghai')).toBe(true) // 09:00 Oct 8
    })

    it('rejects a non-Date now (TypeError) and an invalid zone (RangeError)', () => {
      expect(() => isDailyDigestDue('x' as never, 'UTC')).toThrow(TypeError)
      expect(() => isDailyDigestDue(new Date(NaN), 'UTC')).toThrow(TypeError)
      expect(() => isDailyDigestDue(sendAt, 'Not/AZone')).toThrow(RangeError)
      expect(() => resolveDailyDigestOccurrence(sendAt, 'x')).toThrow(RangeError)
    })
  })
})
