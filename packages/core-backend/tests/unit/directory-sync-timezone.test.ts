import { describe, expect, it } from 'vitest'
import {
  DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE,
  isDirectoryScheduleDefaultTimezone,
  isValidDirectoryScheduleTimezone,
  resolveDirectoryScheduleTimezone,
} from '../../src/directory/directory-sync-timezone'

describe('directory-sync-timezone (roadmap §7.8)', () => {
  describe('isDirectoryScheduleDefaultTimezone', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['whitespace only', '   '],
      ["'UTC'", 'UTC'],
      ["'Etc/UTC'", 'Etc/UTC'],
    ])('treats %s as the default state', (_label, value) => {
      expect(isDirectoryScheduleDefaultTimezone(value)).toBe(true)
    })

    it.each([
      ["'Asia/Shanghai'", 'Asia/Shanghai'],
      ["'America/New_York'", 'America/New_York'],
      ['an invalid IANA zone', 'Not/AZone'],
      // Non-string junk is malformed input, not "an absent field" — it must NOT be waved
      // through as "use the default" (that would make isValidDirectoryScheduleTimezone
      // below silently accept it instead of rejecting).
      ['a number', 42],
      ['an object', { tz: 'UTC' }],
    ])('does NOT treat %s as the default state', (_label, value) => {
      expect(isDirectoryScheduleDefaultTimezone(value)).toBe(false)
    })
  })

  describe('isValidDirectoryScheduleTimezone (save-time gate)', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ["'UTC'", 'UTC'],
      ["'Etc/UTC'", 'Etc/UTC'],
      ["'Asia/Shanghai'", 'Asia/Shanghai'],
      ["'America/New_York'", 'America/New_York'],
      ["'Europe/London'", 'Europe/London'],
    ])('accepts %s', (_label, value) => {
      expect(isValidDirectoryScheduleTimezone(value)).toBe(true)
    })

    it.each([
      ['a made-up zone', 'Not/AZone'],
      ['a made-up zone that looks plausible', 'Mars/OlympusMons'],
      ['a plain non-timezone string', 'not a timezone'],
      ['a number', 12345],
      ['an object', { tz: 'UTC' }],
    ])('REJECTS %s', (_label, value) => {
      expect(isValidDirectoryScheduleTimezone(value)).toBe(false)
    })
  })

  describe('resolveDirectoryScheduleTimezone (runtime resolver — never throws)', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ["'UTC'", 'UTC'],
      ["'Etc/UTC'", 'Etc/UTC'],
    ])('resolves %s to the default (UTC)', (_label, value) => {
      expect(resolveDirectoryScheduleTimezone(value)).toBe(DIRECTORY_SCHEDULE_DEFAULT_TIMEZONE)
      expect(resolveDirectoryScheduleTimezone(value)).toBe('UTC')
    })

    it('resolves a valid configured IANA zone to that exact zone', () => {
      expect(resolveDirectoryScheduleTimezone('Asia/Shanghai')).toBe('Asia/Shanghai')
    })

    it('preserves leading/trailing whitespace-trimmed form of a valid zone', () => {
      expect(resolveDirectoryScheduleTimezone('  Asia/Shanghai  ')).toBe('Asia/Shanghai')
    })

    // Q6-style runtime defense (mirrors automation-scheduler.ts's resolveCronTimeZone): a
    // persisted-junk value (e.g. a direct-DB write bypassing the save-time validator) must
    // fall back to UTC rather than being handed through to SimpleCronExpression verbatim or
    // throwing mid-scheduler-boot. The fail-closed REJECTION lives at the write boundary
    // (isValidDirectoryScheduleTimezone in admin-directory.ts), not here.
    it('falls back to UTC for a persisted-junk value instead of throwing', () => {
      expect(resolveDirectoryScheduleTimezone('Not/AZone')).toBe('UTC')
      expect(() => resolveDirectoryScheduleTimezone('Not/AZone')).not.toThrow()
    })
  })
})
