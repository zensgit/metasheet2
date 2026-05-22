import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance effective calendar role context', () => {
  it('resolves effective-calendar preview rows from draft overrides without loading saved settings', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('system_configs')) {
        throw new Error('saved settings should not be loaded for draft preview')
      }
      if (sql.includes('FROM attendance_rules')) return []
      if (sql.includes('FROM attendance_holidays')) return []
      return []
    })

    const result = await helpers.resolveEffectiveCalendar({ query }, {
      orgId: 'default',
      from: '2026-10-06',
      to: '2026-10-06',
      orgOnly: true,
      calendarPolicyOverrides: [
        {
          date: '2026-10-06',
          effective: { isWorkingDay: false, source: 'org', label: 'Draft rest day' },
        },
      ],
    })

    expect(result).toMatchObject({
      mode: 'orgOnly',
      from: '2026-10-06',
      to: '2026-10-06',
      items: [
        {
          date: '2026-10-06',
          effective: {
            isWorkingDay: false,
            source: 'org',
            label: 'Draft rest day',
          },
        },
      ],
    })
    expect(result.items[0]?.layers.some((layer: any) => layer.kind === 'calendar_policy')).toBe(true)
  })

  it('loads role aliases from users.role and assigned RBAC roles for single-user matching', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT name, role FROM users')) {
        return [{ name: 'Lin Mei', role: 'platform_lead' }]
      }
      if (sql.includes('attendance_group_members')) return []
      if (sql.includes('FROM user_roles ur')) {
        return [
          { role_id: 'attendance_admin', role_name: 'Attendance Admin' },
          { role_id: 'night_shift_lead', role_name: 'Night Shift Lead' },
        ]
      }
      return []
    })

    const context = await helpers.loadAttendanceScopeContextForUser({ query }, 'default', 'user-1')

    expect(context).toMatchObject({
      userId: 'user-1',
      userName: 'Lin Mei',
      role: 'platform_lead',
      roles: ['platform_lead', 'attendance_admin', 'Attendance Admin', 'night_shift_lead', 'Night Shift Lead'],
      roleTags: ['platform_lead', 'attendance_admin', 'Attendance Admin', 'night_shift_lead', 'Night Shift Lead'],
    })
    expect(helpers.matchScopeFilters({ roles: ['night shift lead'] }, context)).toBe(true)
    expect(helpers.matchScopeFilters({ roleTags: ['attendance_admin'] }, context)).toBe(true)
    expect(helpers.matchScopeFilters({ roles: ['finance'] }, context)).toBe(false)
    expect(helpers.matchScopeFilters({ roleTags: ['finance'] }, context)).toBe(false)
  })

  it('batch-loads the same role aliases for prefetch calendar matching', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name, role FROM users')) {
        return [
          { id: 'user-1', name: 'Lin Mei', role: 'platform_lead' },
          { id: 'user-2', name: 'Wang Lei', role: 'operator' },
        ]
      }
      if (sql.includes('attendance_group_members')) {
        return [{ user_id: 'user-2', name: 'Day Shift', code: 'day_shift' }]
      }
      if (sql.includes('FROM user_roles ur')) {
        return [
          { user_id: 'user-1', role_id: 'night_shift_lead', role_name: 'Night Shift Lead' },
          { user_id: 'user-2', role_id: 'attendance_employee', role_name: 'Attendance Employee' },
        ]
      }
      return []
    })

    const contexts = await helpers.loadAttendanceScopeContextMapForUsers({ query }, 'default', ['user-1', 'user-2'])
    const user1 = contexts.get('user-1')
    const user2 = contexts.get('user-2')

    expect(user1?.roles).toEqual(['platform_lead', 'night_shift_lead', 'Night Shift Lead'])
    expect(user1?.roleTags).toEqual(['platform_lead', 'night_shift_lead', 'Night Shift Lead'])
    expect(user2?.attendanceGroups).toEqual(['Day Shift', 'day_shift'])
    expect(user2?.roles).toEqual(['operator', 'attendance_employee', 'Attendance Employee'])
    expect(helpers.matchScopeFilters({ roles: ['attendance employee'] }, user2)).toBe(true)
    expect(helpers.matchScopeFilters({ roleTags: ['operator'] }, user2)).toBe(true)
  })

  it('uses a group rule-set rule as groupId effective-calendar base profile', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM attendance_rules')) {
        return [
          {
            id: 'default-rule',
            name: 'Default rule',
            timezone: 'UTC',
            work_start_time: '09:00',
            work_end_time: '18:00',
            late_grace_minutes: 10,
            early_grace_minutes: 10,
            rounding_minutes: 5,
            working_days: [1, 2, 3, 4, 5],
            is_default: true,
            org_id: 'default',
          },
        ]
      }
      if (sql.includes('FROM attendance_holidays')) return []
      if (sql.includes('FROM attendance_groups')) {
        return [
          {
            id: 'group-1',
            name: 'Weekend Ops',
            code: 'weekend_ops',
            timezone: 'Asia/Tokyo',
            rule_set_id: 'rule-set-1',
          },
        ]
      }
      if (sql.includes('FROM attendance_rule_sets')) {
        return [
          {
            config: {
              rule: {
                timezone: 'Asia/Shanghai',
                workingDays: [6],
              },
            },
          },
        ]
      }
      return []
    })

    const result = await helpers.resolveEffectiveCalendar({ query }, {
      orgId: 'default',
      from: '2026-10-10',
      to: '2026-10-10',
      groupId: 'group-1',
      calendarPolicyOverrides: [],
    })

    expect(result.timezone).toBe('Asia/Shanghai')
    expect(result.items[0]).toMatchObject({
      date: '2026-10-10',
      base: {
        isWorkingDay: true,
        source: 'rule',
      },
      effective: {
        isWorkingDay: true,
        source: 'rule',
      },
    })
    expect(result.items[0]?.layers).toEqual([
      {
        kind: 'base_rule',
        source: 'rule',
        isWorkingDay: true,
      },
    ])
    expect(query).toHaveBeenCalledWith(
      'SELECT config FROM attendance_rule_sets WHERE id = $1 AND org_id = $2',
      ['rule-set-1', 'default'],
    )
  })

  it('keeps groupId mode on the default rule when the group has no rule set', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM attendance_rules')) {
        return [
          {
            id: 'default-rule',
            name: 'Default rule',
            timezone: 'UTC',
            work_start_time: '09:00',
            work_end_time: '18:00',
            late_grace_minutes: 10,
            early_grace_minutes: 10,
            rounding_minutes: 5,
            working_days: [1, 2, 3, 4, 5],
            is_default: true,
            org_id: 'default',
          },
        ]
      }
      if (sql.includes('FROM attendance_holidays')) return []
      if (sql.includes('FROM attendance_groups')) {
        return [
          {
            id: 'group-2',
            name: 'Weekday Ops',
            code: 'weekday_ops',
            timezone: 'Asia/Tokyo',
            rule_set_id: null,
          },
        ]
      }
      if (sql.includes('FROM attendance_rule_sets')) {
        throw new Error('rule-set lookup should not run without group rule_set_id')
      }
      return []
    })

    const result = await helpers.resolveEffectiveCalendar({ query }, {
      orgId: 'default',
      from: '2026-10-10',
      to: '2026-10-10',
      groupId: 'group-2',
      calendarPolicyOverrides: [],
    })

    expect(result.timezone).toBe('UTC')
    expect(result.items[0]?.base).toMatchObject({
      isWorkingDay: false,
      source: 'rule',
    })
    expect(result.items[0]?.effective).toMatchObject({
      isWorkingDay: false,
      source: 'rule',
    })
  })

  it('falls back to the pre-rule-set group lookup when rule_set_id schema is missing', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM attendance_rules')) {
        return [
          {
            id: 'default-rule',
            name: 'Default rule',
            timezone: 'UTC',
            work_start_time: '09:00',
            work_end_time: '18:00',
            late_grace_minutes: 10,
            early_grace_minutes: 10,
            rounding_minutes: 5,
            working_days: [1, 2, 3, 4, 5],
            is_default: true,
            org_id: 'default',
          },
        ]
      }
      if (sql.includes('FROM attendance_holidays')) return []
      if (sql.includes('FROM attendance_groups') && sql.includes('rule_set_id')) {
        const error = new Error('column "rule_set_id" does not exist') as Error & { code?: string }
        error.code = '42703'
        throw error
      }
      if (sql.includes('FROM attendance_groups')) {
        return [
          {
            id: 'group-legacy',
            name: 'Legacy Ops',
            code: 'legacy_ops',
            timezone: 'Asia/Tokyo',
          },
        ]
      }
      if (sql.includes('FROM attendance_rule_sets')) {
        throw new Error('rule-set lookup should not run after schema fallback')
      }
      return []
    })

    const result = await helpers.resolveEffectiveCalendar({ query }, {
      orgId: 'default',
      from: '2026-10-10',
      to: '2026-10-10',
      groupId: 'legacy_ops',
      calendarPolicyOverrides: [],
    })

    expect(result.timezone).toBe('UTC')
    expect(result.items[0]?.base).toMatchObject({
      isWorkingDay: false,
      source: 'rule',
    })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, name, code, timezone, rule_set_id'),
      ['default', 'legacy_ops'],
    )
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('rule_set_id'),
      ['default', 'legacy_ops'],
    )
  })
})
