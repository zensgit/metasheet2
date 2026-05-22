import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

const pluginSource = readFileSync(
  new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
  'utf8',
)

describe('attendance advanced scheduling read-only workbench', () => {
  it('summarizes schedule groups, assignments, scheduler scopes, and diagnostics without writes', () => {
    const workbench = helpers.buildAttendanceAdvancedSchedulingWorkbench({
      from: '2026-06-01',
      to: '2026-06-30',
      scheduleGroups: [
        { id: 'group-a', name: 'Line A', code: 'line-a', source: 'manual', isActive: true },
        { id: 'group-empty', name: 'Empty group', code: 'empty', source: 'manual', isActive: true },
      ],
      scheduleGroupMembers: [
        { id: 'm-1', scheduleGroupId: 'group-a', userId: 'user-1', effectiveFrom: '2026-06-01', effectiveTo: null },
        { id: 'm-2', scheduleGroupId: 'group-a', userId: 'user-2', effectiveFrom: '2026-06-01', effectiveTo: null },
        { id: 'm-3', scheduleGroupId: 'group-b', userId: 'user-2', effectiveFrom: '2026-06-01', effectiveTo: null },
      ],
      schedulerScopes: [
        {
          id: 'scope-1',
          subjectType: 'role_tag',
          subjectRef: 'scheduler',
          actions: ['view'],
          scope: { scheduleGroupIds: ['group-missing'], userIds: [], attendanceGroupIds: [], departments: [], roles: [], roleTags: [] },
          isActive: true,
        },
      ],
      shifts: [{ id: 'shift-a', name: 'Day' }],
      rotationRules: [{ id: 'rot-a', name: 'Two shift', shiftSequence: ['shift-a'] }],
      shiftAssignments: [
        { assignment: { id: 'sa-1', userId: 'user-1', shiftId: 'shift-a', startDate: '2026-06-01', endDate: null, isActive: true }, shift: { id: 'shift-a', name: 'Day' } },
        { assignment: { id: 'sa-2', userId: 'user-3', shiftId: 'shift-a', startDate: '2026-06-01', endDate: null, isActive: true }, shift: { id: 'shift-a', name: 'Day' } },
      ],
      rotationAssignments: [
        { assignment: { id: 'ra-1', userId: 'user-1', rotationRuleId: 'rot-a', startDate: '2026-06-01', endDate: null, isActive: true }, rotation: { id: 'rot-a', name: 'Two shift' } },
      ],
    })

    expect(workbench.metadata).toEqual({
      readOnly: true,
      source: 'attendance_advanced_scheduling_workbench',
    })
    expect(workbench.summary).toMatchObject({
      scheduleGroups: 2,
      scheduleGroupMembers: 3,
      schedulerScopes: 1,
      shifts: 1,
      rotationRules: 1,
      shiftAssignments: 2,
      rotationAssignments: 1,
      assignedUsers: 2,
      groupsWithoutMembers: 1,
      assignmentUsersWithoutScheduleGroup: 1,
      usersWithMultipleScheduleGroups: 1,
      usersWithBothAssignmentKinds: 1,
    })
    expect(workbench.scheduleGroups.items.find((group: any) => group.id === 'group-a')).toMatchObject({
      memberCount: 2,
      assignedUserCount: 1,
      shiftAssignmentCount: 1,
      rotationAssignmentCount: 1,
    })
    expect(workbench.diagnostics.map((item: any) => item.code)).toEqual([
      'schedule_group_without_members',
      'assignment_without_schedule_group',
      'user_multiple_schedule_groups',
      'user_mixed_assignment_kinds',
      'scheduler_scope_unknown_schedule_group',
    ])
  })

  it('registers a read-only attendance-admin GET route and no sibling write route', () => {
    expect(pluginSource).toMatch(
      /'GET',\s*\n\s*'\/api\/attendance\/advanced-scheduling\/workbench',\s*\n\s*withPermission\('attendance:admin'/,
    )
    expect(pluginSource).not.toContain("'POST',\n      '/api/attendance/advanced-scheduling/workbench'")
    expect(pluginSource).not.toContain("'PUT',\n      '/api/attendance/advanced-scheduling/workbench'")
    expect(pluginSource).not.toContain("'DELETE',\n      '/api/attendance/advanced-scheduling/workbench'")
  })
})
