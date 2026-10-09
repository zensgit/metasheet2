import { describe, expect, it } from 'vitest'
import {
  TASK_BADGE_SCOPES,
  TASK_DEFAULT_BADGE_SCOPE,
  parseBadgeScope,
  parseSettingsPatch,
  pendingScopeForBadge,
  type TaskUserSettings,
} from '../../src/tasks/task-settings'

function settings(overrides: Partial<TaskUserSettings> = {}): TaskUserSettings {
  return {
    badgeScope: 'overdue',
    dailyReminderEnabled: false,
    defaultRemindPolicy: { mode: 'default' },
    timeZone: null,
    ...overrides,
  }
}

describe('task-settings', () => {
  describe('parseBadgeScope', () => {
    it('missing -> default (overdue)', () => {
      expect(parseBadgeScope(null)).toEqual({ ok: true, scope: 'overdue' })
      expect(parseBadgeScope(undefined)).toEqual({ ok: true, scope: TASK_DEFAULT_BADGE_SCOPE })
    })

    it('every closed-set value is accepted', () => {
      for (const scope of TASK_BADGE_SCOPES) {
        expect(parseBadgeScope(scope)).toEqual({ ok: true, scope })
      }
    })

    it('unknown value -> invalid_badge_scope', () => {
      expect(parseBadgeScope('all_open')).toEqual({ ok: false, reason: 'invalid_badge_scope' })
    })

    it('non-string -> invalid_badge_scope', () => {
      expect(parseBadgeScope(42)).toEqual({ ok: false, reason: 'invalid_badge_scope' })
    })
  })

  describe('pendingScopeForBadge', () => {
    it('D5: off -> null (caller short-circuits, no query)', () => {
      expect(pendingScopeForBadge('off')).toBeNull()
    })

    it('overdue -> overdue', () => {
      expect(pendingScopeForBadge('overdue')).toBe('overdue')
    })

    it('overdue_or_today -> overdue_or_today', () => {
      expect(pendingScopeForBadge('overdue_or_today')).toBe('overdue_or_today')
    })

    it('throws for an unknown scope', () => {
      expect(() => pendingScopeForBadge('all_open' as never)).toThrow(TypeError)
    })
  })

  describe('parseSettingsPatch', () => {
    it('empty patch -> current settings unchanged', () => {
      const current = settings({ badgeScope: 'overdue_or_today', timeZone: 'Asia/Shanghai' })
      expect(parseSettingsPatch({}, current)).toEqual({ ok: true, settings: current })
    })

    it('patches badgeScope only', () => {
      const result = parseSettingsPatch({ badgeScope: 'off' }, settings())
      expect(result).toEqual({ ok: true, settings: settings({ badgeScope: 'off' }) })
    })

    it('invalid badgeScope in patch -> 422 invalid_badge_scope', () => {
      expect(parseSettingsPatch({ badgeScope: 'bogus' }, settings())).toEqual({
        ok: false,
        reason: 'invalid_badge_scope',
      })
    })

    // item 8 (independent review): `parseBadgeScope`/`parseRemindPolicy` treat a `null` VALUE as
    // "use the default" — correct when reading a ROW (a NULL column really does mean "never set"),
    // but a PATCH's only "leave alone" spelling is an ABSENT key; an explicit `null` inside a patch
    // body has no defined "reset to default" semantics and must 422, not silently reset the field.
    it('explicit null for badgeScope in a patch -> 422 invalid_badge_scope (not silently reset to default)', () => {
      const current = settings({ badgeScope: 'overdue_or_today' })
      expect(parseSettingsPatch({ badgeScope: null }, current)).toEqual({
        ok: false,
        reason: 'invalid_badge_scope',
      })
    })

    it('explicit null for defaultRemindPolicy in a patch -> 422 invalid_policy (not silently reset to default)', () => {
      const current = settings({ defaultRemindPolicy: { mode: 'none' } })
      expect(parseSettingsPatch({ defaultRemindPolicy: null }, current)).toEqual({
        ok: false,
        reason: 'invalid_policy',
      })
    })

    it('patches dailyReminderEnabled true, with a valid timeZone already set', () => {
      const current = settings({ timeZone: 'Asia/Shanghai' })
      const result = parseSettingsPatch({ dailyReminderEnabled: true }, current)
      expect(result).toEqual({
        ok: true,
        settings: settings({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' }),
      })
    })

    it('non-boolean dailyReminderEnabled -> invalid_daily_reminder_enabled', () => {
      expect(parseSettingsPatch({ dailyReminderEnabled: 'yes' }, settings())).toEqual({
        ok: false,
        reason: 'invalid_daily_reminder_enabled',
      })
    })

    it('R07: dailyReminderEnabled true with no timeZone anywhere (current nor patch) -> 422', () => {
      const result = parseSettingsPatch({ dailyReminderEnabled: true }, settings({ timeZone: null }))
      expect(result).toEqual({ ok: false, reason: 'daily_reminder_requires_time_zone' })
    })

    it('dailyReminderEnabled true AND timeZone given in the SAME patch -> ok', () => {
      const result = parseSettingsPatch({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' }, settings())
      expect(result).toEqual({
        ok: true,
        settings: settings({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' }),
      })
    })

    it('clearing timeZone to null while dailyReminderEnabled stays true (from current) -> 422', () => {
      const current = settings({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' })
      const result = parseSettingsPatch({ timeZone: null }, current)
      expect(result).toEqual({ ok: false, reason: 'daily_reminder_requires_time_zone' })
    })

    it('D7: timeZone is normalized to its CANONICAL name on write (alias collapses)', () => {
      const result = parseSettingsPatch({ timeZone: 'US/Eastern' }, settings())
      expect(result.ok).toBe(true)
      expect(result.ok && result.settings.timeZone).toBe('America/New_York')
    })

    it('invalid timeZone string -> 422 invalid_time_zone', () => {
      expect(parseSettingsPatch({ timeZone: 'Not/AZone' }, settings())).toEqual({
        ok: false,
        reason: 'invalid_time_zone',
      })
    })

    it('patches defaultRemindPolicy', () => {
      const result = parseSettingsPatch({ defaultRemindPolicy: { mode: 'none' } }, settings())
      expect(result).toEqual({ ok: true, settings: settings({ defaultRemindPolicy: { mode: 'none' } }) })
    })

    it('invalid defaultRemindPolicy -> 422 invalid_policy', () => {
      expect(parseSettingsPatch({ defaultRemindPolicy: { mode: 'weekly' } }, settings())).toEqual({
        ok: false,
        reason: 'invalid_policy',
      })
    })

    it('a rejected field short-circuits before the daily-reminder/time-zone cross-check', () => {
      // badgeScope is invalid; dailyReminderEnabled true with no zone would ALSO fail — the
      // badge_scope failure must win (first field checked).
      const result = parseSettingsPatch({ badgeScope: 'bogus', dailyReminderEnabled: true }, settings())
      expect(result).toEqual({ ok: false, reason: 'invalid_badge_scope' })
    })

    it('multi-field patch applied together', () => {
      const result = parseSettingsPatch(
        { badgeScope: 'overdue_or_today', dailyReminderEnabled: true, timeZone: 'UTC', defaultRemindPolicy: { mode: 'none' } },
        settings(),
      )
      expect(result).toEqual({
        ok: true,
        settings: {
          badgeScope: 'overdue_or_today',
          dailyReminderEnabled: true,
          defaultRemindPolicy: { mode: 'none' },
          timeZone: 'UTC',
        },
      })
    })
  })
})
