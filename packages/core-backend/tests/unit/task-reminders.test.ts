import { describe, expect, it } from 'vitest'
import {
  TASK_REMINDER_SCAN_WINDOW_MS,
  buildTaskDailyDigestCondition,
  buildTaskDailyDigestSourceKey,
  buildTaskEventSourceKey,
  buildTaskListEventSourceKey,
  buildTaskReminderSourceKey,
  computeDefaultRemindAt,
  isInDailyDigest,
  isReminderSkippedByTaskState,
  isTaskReminderDue,
  parseRemindPolicy,
  shouldEnqueueReminder,
  type TaskDailyDigestShape,
} from '../../src/tasks/task-reminders'

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

    it('remindAt before the floor -> false, even though within the scan window', () => {
      const beforeFloor = new Date(floor.getTime() - 1)
      // beforeFloor is only ~1ms before floor, well within the 2h window relative to `now`.
      expect(isTaskReminderDue(beforeFloor, now, floor)).toBe(false)
    })

    it('boundary: remindAt exactly at the floor -> true (floor <= remind_at is inclusive)', () => {
      expect(isTaskReminderDue(floor, new Date(floor.getTime() + 1000), floor)).toBe(true)
    })
  })

  describe('isReminderSkippedByTaskState', () => {
    it('open, not deleted -> not skipped', () => {
      expect(isReminderSkippedByTaskState({ status: 'open', deletedAt: null })).toBe(false)
    })

    it('done -> skipped', () => {
      expect(isReminderSkippedByTaskState({ status: 'done', deletedAt: null })).toBe(true)
    })

    it('soft-deleted -> skipped, even if status open', () => {
      expect(isReminderSkippedByTaskState({ status: 'open', deletedAt: new Date() })).toBe(true)
    })

    it('done AND deleted -> skipped', () => {
      expect(isReminderSkippedByTaskState({ status: 'done', deletedAt: new Date() })).toBe(true)
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
  })
})
