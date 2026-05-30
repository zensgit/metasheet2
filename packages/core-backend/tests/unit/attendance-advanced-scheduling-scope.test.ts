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

const migrationSource = readFileSync(
  new URL('../../src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts', import.meta.url),
  'utf8',
)

function expectAdminRoute(method: string, path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`['"]${method}['"],\\s*\\n\\s*['"]${escaped}['"],\\s*\\n\\s*withPermission\\(['"]attendance:admin['"]`)
  expect(pluginSource).toMatch(pattern)
}

function expectDirectAsyncRoute(method: string, path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`['"]${method}['"],\\s*\\n\\s*['"]${escaped}['"],\\s*\\n\\s*async \\(req, res\\)`)
  expect(pluginSource).toMatch(pattern)
}

describe('attendance advanced scheduling scope foundation', () => {
  it('creates separate scheduling tables without mutating existing attendance group membership tables', () => {
    expect(migrationSource).toContain("createTable('attendance_schedule_groups')")
    expect(migrationSource).toContain("createTable('attendance_schedule_group_members')")
    expect(migrationSource).toContain("createTable('attendance_scheduler_scopes')")
    expect(migrationSource).toContain("references('attendance_groups.id')")
    expect(migrationSource).not.toContain('ALTER TABLE attendance_groups')
    expect(migrationSource).not.toContain('ALTER TABLE attendance_group_members')
    expect(migrationSource).not.toContain("dropTable('attendance_groups')")
    expect(migrationSource).not.toContain("dropTable('attendance_group_members')")
  })

  it('guards the new scheduling group and scheduler-scope routes behind attendance admin or scoped scheduler actions', () => {
    [
      ['GET', '/api/attendance/schedule-groups'],
      ['POST', '/api/attendance/schedule-groups'],
      ['GET', '/api/attendance/schedule-groups/:id'],
      ['GET', '/api/attendance/schedule-groups/:id/members'],
      ['GET', '/api/attendance/scheduler-scopes'],
      ['POST', '/api/attendance/scheduler-scopes'],
      ['PUT', '/api/attendance/scheduler-scopes/:id'],
      ['DELETE', '/api/attendance/scheduler-scopes/:id'],
    ].forEach(([method, path]) => expectAdminRoute(method, path))
    expect(pluginSource).toContain('SCHEDULER_SCOPE_FORBIDDEN')
    expectDirectAsyncRoute('POST', '/api/attendance/schedule-groups/:id/members')
    expectDirectAsyncRoute('DELETE', '/api/attendance/schedule-groups/:id/members/:memberId')
    expectDirectAsyncRoute('PUT', '/api/attendance/schedule-groups/:id')
    expectDirectAsyncRoute('DELETE', '/api/attendance/schedule-groups/:id')
    const scopedDispatchRoutes = [
      ['POST', '/api/attendance/assignments'],
      ['PUT', '/api/attendance/assignments/:id'],
      ['DELETE', '/api/attendance/assignments/:id'],
      ['POST', '/api/attendance/rotation-assignments'],
      ['PUT', '/api/attendance/rotation-assignments/:id'],
      ['DELETE', '/api/attendance/rotation-assignments/:id'],
    ]
    scopedDispatchRoutes.forEach(([method, path]) => expectDirectAsyncRoute(method, path))
    expect(pluginSource).toContain('resolveAttendanceScheduleAssignmentScopeTarget')
    expect(pluginSource).toContain('assertAttendanceScheduleAssignmentDispatchAllowed')
    expect(pluginSource).toContain('assertAttendanceScheduleGroupEditAllowed')
  })

  it('normalizes schedule groups without overloading attendance_groups semantics', () => {
    const input = helpers.normalizeAttendanceScheduleGroupInput({
      name: '  Line A Team  ',
      code: 'line-a',
      description: '  Day production line  ',
      attendanceGroupId: '11111111-1111-4111-8111-111111111111',
      parentId: null,
      departmentRef: '  factory-1  ',
      source: 'import',
      isActive: true,
    })

    expect(input).toEqual({
      name: 'Line A Team',
      code: 'line-a',
      description: 'Day production line',
      attendanceGroupId: '11111111-1111-4111-8111-111111111111',
      parentId: null,
      departmentRef: 'factory-1',
      source: 'import',
      isActive: true,
    })
    expect(() => helpers.normalizeAttendanceScheduleGroupInput({
      name: '<script>alert(1)</script>',
    })).toThrow(/unsafe characters/)
    expect(() => helpers.normalizeAttendanceScheduleGroupInput({
      name: 'Line A',
      attendanceGroupId: 'not-a-uuid',
    })).toThrow(/attendanceGroupId must be a UUID/)
  })

  it('requires date-aware membership windows to be valid and non-overlap-ready', () => {
    const input = helpers.normalizeAttendanceScheduleGroupMemberInput({
      userIds: ['u-1', 'u-2'],
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-06-30',
      role: 'lead',
      source: 'manual',
    })

    expect(input).toEqual({
      userIds: ['u-1', 'u-2'],
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-06-30',
      role: 'lead',
      source: 'manual',
    })
    expect(helpers.doAttendanceScheduleMembershipWindowsOverlap(
      { effectiveFrom: '2026-06-01', effectiveTo: '2026-06-30' },
      { effectiveFrom: '2026-06-30', effectiveTo: '2026-07-10' },
    )).toBe(true)
    expect(helpers.doAttendanceScheduleMembershipWindowsOverlap(
      { effectiveFrom: '2026-06-01', effectiveTo: '2026-06-29' },
      { effectiveFrom: '2026-06-30', effectiveTo: '2026-07-10' },
    )).toBe(false)
    expect(() => helpers.normalizeAttendanceScheduleGroupMemberInput({
      userId: 'u-1',
      effectiveFrom: '2026-07-01',
      effectiveTo: '2026-06-30',
    })).toThrow(/effectiveTo/)
  })

  it('serializes membership writes by org/group/user before overlap insert checks', () => {
    expect(helpers.buildAttendanceScheduleGroupMemberLockKey(
      'default',
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    )).toBe('default:11111111-1111-4111-8111-111111111111:user-1')
    expect(pluginSource).toContain('function acquireAttendanceScheduleGroupMemberLock')
    expect(pluginSource).toContain('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))')
    expect(pluginSource).toMatch(
      /await acquireAttendanceScheduleGroupMemberLock\(trx, orgId, groupId, userId\)[\s\S]+FROM attendance_schedule_group_members/,
    )
    expect(pluginSource).toMatch(
      /error\?\.code === '23505'[\s\S]+code: 'MEMBERSHIP_OVERLAP'/,
    )
  })

  it('normalizes explicit scheduler actions and fails closed on empty scope', () => {
    const scope = helpers.normalizeAttendanceSchedulerScopeInput({
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['view', 'edit'],
      scope: {
        scheduleGroupIds: ['sg-1'],
        userIds: ['u-1', 'u-2'],
      },
    })

    expect(scope).toEqual({
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['view', 'edit'],
      scope: {
        scheduleGroupIds: ['sg-1'],
        attendanceGroupIds: [],
        userIds: ['u-1', 'u-2'],
        departments: [],
        roles: [],
        roleTags: [],
      },
      isActive: true,
    })
    expect(helpers.attendanceSchedulerScopeMatchesTarget(scope, {
      scheduleGroupIds: ['sg-1'],
      userIds: ['u-1'],
    })).toBe(true)
    expect(helpers.attendanceSchedulerScopeMatchesTarget(scope, {
      scheduleGroupIds: ['sg-2'],
      userIds: ['u-1'],
    })).toBe(false)
    expect(helpers.attendanceSchedulerScopeMatchesTarget(scope, {
      scheduleGroupIds: ['sg-1'],
      userIds: ['u-3'],
    })).toBe(false)
    expect(() => helpers.normalizeAttendanceSchedulerScopeInput({
      subjectType: 'user',
      subjectRef: 'scheduler-1',
      actions: ['view'],
      scope: {},
    })).toThrow(/scope must include at least one target/)
  })

  it('matches scheduler scopes by actor subject, action, and target for runtime enforcement', () => {
    const scope = {
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['dispatch'],
      scope: {
        scheduleGroupIds: ['sg-1'],
        attendanceGroupIds: [],
        userIds: ['u-1'],
        departments: [],
        roles: [],
        roleTags: [],
      },
      isActive: true,
    }
    const actor = {
      userId: 'actor-1',
      roles: ['ops'],
      roleTags: ['line_scheduler'],
    }

    expect(helpers.attendanceSchedulerScopeMatchesActor(scope, actor)).toBe(true)
    expect(helpers.attendanceSchedulerScopeAllowsActorActionTarget(scope, actor, 'dispatch', {
      scheduleGroupIds: ['sg-1'],
      userIds: ['u-1'],
    })).toBe(true)
    expect(helpers.attendanceSchedulerScopeAllowsActorActionTarget(scope, actor, 'edit', {
      scheduleGroupIds: ['sg-1'],
      userIds: ['u-1'],
    })).toBe(false)
    expect(helpers.attendanceSchedulerScopeAllowsActorActionTarget(scope, actor, 'dispatch', {
      scheduleGroupIds: ['sg-2'],
      userIds: ['u-1'],
    })).toBe(false)
    expect(helpers.attendanceSchedulerScopeAllowsActorActionTarget({ ...scope, isActive: false }, actor, 'dispatch', {
      scheduleGroupIds: ['sg-1'],
      userIds: ['u-1'],
    })).toBe(false)
  })
})
