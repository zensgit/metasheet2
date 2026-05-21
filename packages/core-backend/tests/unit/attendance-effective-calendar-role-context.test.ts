import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance effective calendar role context', () => {
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
})
