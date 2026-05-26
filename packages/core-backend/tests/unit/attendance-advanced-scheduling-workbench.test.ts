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
      truncation: {
        assignmentLimit: 500,
        shiftAssignments: false,
        rotationAssignments: false,
        truncated: false,
      },
      sampling: {
        assignmentLimit: 500,
        sampled: false,
        shiftAssignments: {
          visible: 2,
          total: 2,
          truncated: false,
        },
        rotationAssignments: {
          visible: 1,
          total: 1,
          truncated: false,
        },
      },
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

  it('uses aggregate assignment counts while keeping capped detail rows as a sample', () => {
    const shiftAssignments = Array.from({ length: 500 }, (_, index) => ({
      assignment: {
        id: `sa-${index}`,
        userId: `user-${index}`,
        shiftId: 'shift-a',
        startDate: '2026-06-01',
        endDate: null,
        isActive: true,
      },
      shift: { id: 'shift-a', name: 'Day' },
    }))

    const workbench = helpers.buildAttendanceAdvancedSchedulingWorkbench({
      from: '2026-06-01',
      to: '2026-06-30',
      scheduleGroups: [],
      shiftAssignments,
      assignmentAggregates: {
        shiftAssignments: 650,
        rotationAssignments: 3,
        assignedUsers: 640,
        assignmentUsersWithoutScheduleGroup: 639,
        usersWithBothAssignmentKinds: 2,
      },
      assignmentLimit: 500,
      shiftAssignmentsTruncated: true,
      rotationAssignmentsTruncated: false,
    })

    expect(workbench.summary).toMatchObject({
      shiftAssignments: 650,
      rotationAssignments: 3,
      assignedUsers: 640,
      assignmentUsersWithoutScheduleGroup: 639,
      usersWithBothAssignmentKinds: 2,
    })
    expect(workbench.assignments.shiftItems).toHaveLength(500)
    expect(workbench.diagnostics.find((item: any) => item.code === 'assignment_without_schedule_group')).toMatchObject({
      count: 639,
    })
    expect(workbench.metadata.truncation).toEqual({
      assignmentLimit: 500,
      shiftAssignments: true,
      rotationAssignments: false,
      truncated: true,
    })
    expect(workbench.metadata.sampling).toEqual({
      assignmentLimit: 500,
      sampled: true,
      shiftAssignments: {
        visible: 500,
        total: 650,
        truncated: true,
      },
      rotationAssignments: {
        visible: 0,
        total: 3,
        truncated: false,
      },
    })
  })

  it('uses aggregate group coverage counts when detail samples are capped', () => {
    const workbench = helpers.buildAttendanceAdvancedSchedulingWorkbench({
      scheduleGroups: [{ id: 'group-a', name: 'Line A', code: 'line-a', source: 'manual', isActive: true }],
      scheduleGroupMembers: [
        { id: 'm-1', scheduleGroupId: 'group-a', userId: 'user-1', effectiveFrom: '2026-06-01', effectiveTo: null },
      ],
      shiftAssignments: [],
      scheduleGroupAssignmentAggregates: [
        {
          scheduleGroupId: 'group-a',
          assignedUserCount: 25,
          shiftAssignmentCount: 31,
          rotationAssignmentCount: 7,
        },
      ],
    })

    expect(workbench.scheduleGroups.items[0]).toMatchObject({
      memberCount: 1,
      assignedUserCount: 25,
      shiftAssignmentCount: 31,
      rotationAssignmentCount: 7,
    })
  })

  it('registers a read-only attendance-admin GET route and no sibling write route', () => {
    expect(pluginSource).toMatch(
      /'GET',\s*\n\s*'\/api\/attendance\/advanced-scheduling\/workbench',\s*\n\s*withPermission\('attendance:admin'/,
    )
    expect(pluginSource).not.toContain("'POST',\n      '/api/attendance/advanced-scheduling/workbench'")
    expect(pluginSource).not.toContain("'PUT',\n      '/api/attendance/advanced-scheduling/workbench'")
    expect(pluginSource).not.toContain("'DELETE',\n      '/api/attendance/advanced-scheduling/workbench'")
    expect(pluginSource).toContain('LIMIT ${ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT + 1}')
    expect(pluginSource).toContain('visibleShiftAssignmentRows = shiftAssignmentRows.slice(0, ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT)')
    expect(pluginSource).toContain('visibleRotationAssignmentRows = rotationAssignmentRows.slice(0, ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT)')
    expect(pluginSource).toContain('assignmentAggregateRows')
    expect(pluginSource).toContain('scheduleGroupAssignmentAggregateRows')
  })

  describe('rule_set preview-divergence diagnostic (read-only)', () => {
    const baseInput = (overrides: Record<string, unknown> = {}) => ({
      from: '2026-06-01',
      to: '2026-06-30',
      scheduleGroups: [
        { id: 'sg-1', name: 'Group 1', source: 'manual', isActive: true, attendanceGroupId: 'ag-rule' },
        { id: 'sg-2', name: 'Group 2', source: 'manual', isActive: true, attendanceGroupId: 'ag-plain' },
      ],
      scheduleGroupMembers: [
        { id: 'm-1', scheduleGroupId: 'sg-1', userId: 'u-1', effectiveFrom: '2026-06-01', effectiveTo: null },
        { id: 'm-2', scheduleGroupId: 'sg-2', userId: 'u-2', effectiveFrom: '2026-06-01', effectiveTo: null },
      ],
      ...overrides,
    })

    it('positive: flags schedule groups whose attendance group carries a rule_set override', () => {
      const wb = helpers.buildAttendanceAdvancedSchedulingWorkbench(
        baseInput({ ruleSetAttendanceGroupIds: ['ag-rule'] }),
      )
      const diag = wb.diagnostics.find((d: any) => d.code === 'schedule_group_rule_set_preview_divergence')
      expect(diag).toMatchObject({ severity: 'info', count: 1, scheduleGroupIds: ['sg-1'] })
      expect(diag.message).toContain('by design')
    })

    it('negative: no diagnostic when the linked attendance group has no rule_set', () => {
      // sg-1/sg-2 both link to attendance groups, but neither id is in the rule_set set.
      const wb = helpers.buildAttendanceAdvancedSchedulingWorkbench(
        baseInput({ ruleSetAttendanceGroupIds: ['ag-unrelated'] }),
      )
      expect(wb.diagnostics.find((d: any) => d.code === 'schedule_group_rule_set_preview_divergence')).toBeUndefined()
    })

    it('absent input / no attendanceGroupId: diagnostic does not fire (backward compatible)', () => {
      // No ruleSetAttendanceGroupIds passed at all.
      const wbNoInput = helpers.buildAttendanceAdvancedSchedulingWorkbench(baseInput())
      expect(wbNoInput.diagnostics.find((d: any) => d.code === 'schedule_group_rule_set_preview_divergence')).toBeUndefined()
      // Group without attendanceGroupId is skipped even if some other id is in the set.
      const wbNoLink = helpers.buildAttendanceAdvancedSchedulingWorkbench({
        from: '2026-06-01',
        to: '2026-06-30',
        scheduleGroups: [{ id: 'sg-x', name: 'No link', source: 'manual', isActive: true }],
        ruleSetAttendanceGroupIds: ['ag-rule'],
      })
      expect(wbNoLink.diagnostics.find((d: any) => d.code === 'schedule_group_rule_set_preview_divergence')).toBeUndefined()
    })

    it('source guard: the new query is a SELECT and the workbench route region is read-only', () => {
      expect(pluginSource).toMatch(/SELECT id FROM attendance_groups WHERE org_id = \$1 AND rule_set_id IS NOT NULL/)
      expect(pluginSource).toContain('ruleSetAttendanceGroupRows')
      // Scope the write-guard to the workbench GET handler region only (the file legitimately
      // writes attendance_groups elsewhere via group sync). The handler must be SELECT-only.
      const start = pluginSource.indexOf("'/api/attendance/advanced-scheduling/workbench'")
      expect(start).toBeGreaterThan(-1)
      const nextRoute = pluginSource.indexOf('context.api.http.addRoute(', start + 1)
      const handler = pluginSource.slice(start, nextRoute > start ? nextRoute : start + 12000)
      expect(handler).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i)
    })
  })
})
