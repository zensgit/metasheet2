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

function extractDirectAsyncRoute(method: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `['"]${method}['"],\\s*\\n\\s*['"]${escaped}['"],\\s*\\n\\s*async \\(req, res\\) => \\{[\\s\\S]*?\\n    \\)`,
  )
  const match = pluginSource.match(pattern)
  expect(match, `missing ${method} ${path} async handler`).toBeTruthy()
  return match![0]
}

/** O3: preview is fullAdmin or in-group owner/sub_owner; 403-before-404 before group probe / preview SQL. */
function expectGroupOwnerPreviewRoute(method: string, path: string) {
  const handler = extractDirectAsyncRoute(method, path)
  expect(handler).toContain('resolveAttendanceFixedScheduleRouteActorContext')
  expect(handler).toContain("canManageAttendanceGroup(orgId, actorAccess.userId, groupId, 'fixed_schedule_preview')")
  expect(handler.indexOf('canManageAttendanceGroup')).toBeGreaterThan(-1)
  expect(handler.indexOf('canManageAttendanceGroup')).toBeLessThan(handler.indexOf('assertAttendanceGroupInActorOrg'))
  expect(handler.indexOf('canManageAttendanceGroup')).toBeLessThan(handler.indexOf('buildAttendanceGroupFixedSchedulePreview'))
}

/** Apply/rebuild/clear/config stay scheduler-scope; must not inherit the O3 group-owner write set. */
function expectSchedulerScopedFixedScheduleWriteRoute(method: string, path: string, assertFn: string) {
  const handler = extractDirectAsyncRoute(method, path)
  expect(handler).toContain('resolveAttendanceFixedScheduleRouteActorContext')
  expect(handler).toContain(assertFn)
  expect(handler).not.toContain('canManageAttendanceGroup')
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
      ['POST', '/api/attendance/schedule-groups'],
      ['GET', '/api/attendance/scheduler-scopes'],
      ['POST', '/api/attendance/scheduler-scopes'],
      ['PUT', '/api/attendance/scheduler-scopes/:id'],
      ['DELETE', '/api/attendance/scheduler-scopes/:id'],
    ].forEach(([method, path]) => expectAdminRoute(method, path))
    expect(pluginSource).toContain('SCHEDULER_SCOPE_FORBIDDEN')
    expectGroupOwnerPreviewRoute('POST', '/api/attendance/groups/:id/fixed-schedule/preview')
    expectDirectAsyncRoute('POST', '/api/attendance/groups/:id/fixed-schedule/apply')
    expectDirectAsyncRoute('POST', '/api/attendance/groups/:id/fixed-schedule/rebuild')
    expectDirectAsyncRoute('POST', '/api/attendance/groups/:id/fixed-schedule/clear')
    expectSchedulerScopedFixedScheduleWriteRoute(
      'POST',
      '/api/attendance/groups/:id/fixed-schedule/apply',
      'assertAttendanceGroupFixedScheduleDispatchAllowed',
    )
    expectSchedulerScopedFixedScheduleWriteRoute(
      'POST',
      '/api/attendance/groups/:id/fixed-schedule/rebuild',
      'assertAttendanceGroupFixedScheduleRebuildAllowed',
    )
    expectSchedulerScopedFixedScheduleWriteRoute(
      'POST',
      '/api/attendance/groups/:id/fixed-schedule/clear',
      'assertAttendanceGroupFixedScheduleClearAllowed',
    )
    expectSchedulerScopedFixedScheduleWriteRoute(
      'PUT',
      '/api/attendance/groups/:groupId/fixed-schedule/config',
      'assertAttendanceGroupFixedScheduleDispatchAllowed',
    )
    expectDirectAsyncRoute('POST', '/api/attendance/requests/:id/approve')
    expectDirectAsyncRoute('POST', '/api/attendance/requests/:id/reject')
    expectDirectAsyncRoute('GET', '/api/attendance/schedule-groups')
    expectDirectAsyncRoute('GET', '/api/attendance/schedule-groups/:id')
    expectDirectAsyncRoute('GET', '/api/attendance/schedule-groups/:id/members')
    expectDirectAsyncRoute('POST', '/api/attendance/schedule-groups/:id/members')
    expectDirectAsyncRoute('DELETE', '/api/attendance/schedule-groups/:id/members/:memberId')
    expectDirectAsyncRoute('PUT', '/api/attendance/schedule-groups/:id')
    expectDirectAsyncRoute('DELETE', '/api/attendance/schedule-groups/:id')
    const scopedSchedulerRoutes = [
      ['GET', '/api/attendance/assignments'],
      ['POST', '/api/attendance/assignments'],
      ['PUT', '/api/attendance/assignments/:id'],
      ['DELETE', '/api/attendance/assignments/:id'],
      ['GET', '/api/attendance/rotation-assignments'],
      ['POST', '/api/attendance/rotation-assignments'],
      ['PUT', '/api/attendance/rotation-assignments/:id'],
      ['DELETE', '/api/attendance/rotation-assignments/:id'],
    ]
    scopedSchedulerRoutes.forEach(([method, path]) => expectDirectAsyncRoute(method, path))
    const assignmentWriteRoutes = scopedSchedulerRoutes.filter(([method]) => method !== 'GET')
    for (const [method, path] of assignmentWriteRoutes) {
      const needle = `'${method}',\n      '${path}'`
      const start = pluginSource.indexOf(needle)
      expect(start, needle).toBeGreaterThan(-1)
      const next = pluginSource.indexOf('context.api.http.addRoute(', start + needle.length)
      const body = pluginSource.slice(start, next === -1 ? undefined : next)
      expect(body).toContain('assertAttendanceScheduleAssignmentDispatchAllowed')
    }
    expect(pluginSource).toContain('resolveAttendanceScheduleAssignmentDispatchMemberships')
    expect(pluginSource).toContain('assertAttendanceScheduleAssignmentDispatchAllowed')
    expect(pluginSource).not.toContain('resolveAttendanceScheduleAssignmentScopeTarget')
    const dispatchGuard = pluginSource.match(
      /async function assertAttendanceScheduleAssignmentDispatchAllowed\([\s\S]*?\n    async function canEditAttendanceScheduleGroup/,
    )?.[0] ?? ''
    expect(dispatchGuard).toContain('attendanceScheduleAssignmentDispatchScopeAllowsMembership')
    expect(dispatchGuard).not.toContain('assertAttendanceSchedulerScopeAllowed')
    expect(pluginSource).toMatch(
      /function attendanceScheduleAssignmentDispatchScopeAllowsMembership[\s\S]*?attendanceSchedulerScopeAllowsActorActionFactsImpl/,
    )
    expect(pluginSource).toMatch(
      /function attendanceSchedulerScopeAllowsActorActionFacts\(scopeRow, actorContext, action, facts\) \{\n      return attendanceSchedulerScopeAllowsActorActionFactsImpl\(scopeRow, actorContext, action, facts\)/,
    )
    expect(pluginSource).toContain('assertAttendanceScheduleGroupEditAllowed')
    expect(pluginSource).toContain('assertAttendanceGroupFixedScheduleDispatchAllowed')
    expect(pluginSource).toContain('assertAttendanceGroupFixedScheduleRebuildAllowed')
    expect(pluginSource).toContain('assertAttendanceGroupFixedScheduleClearAllowed')
    expect(pluginSource).toContain('resolveRequestDecisionActorAccess')
    expect(pluginSource).toContain('assertAttendanceRecordExportAllowed')
    expect(pluginSource).toContain('assertAttendanceImportPrepareAllowed')
    expect(pluginSource).toContain('assertAttendanceImportPreviewAllowed')
    expect(pluginSource).toContain('assertAttendanceImportCommitAllowed')
    expect(pluginSource).toContain('resolveAttendanceRequestApprovalScopeFacts')
    expect(pluginSource).toContain('resolveAttendanceUserSchedulerScopeFacts')
    expect(pluginSource).toContain('buildAttendanceAssignmentViewSql')
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
    expect(helpers.ATTENDANCE_SCHEDULER_SCOPE_ACTIONS.has('remind')).toBe(true)
    expect(pluginSource).toContain("const ATTENDANCE_SCHEDULER_SCOPE_ACTION_VALUES = ['view', 'edit', 'import', 'export', 'clear', 'approve', 'dispatch', 'remind']")
    expect(pluginSource).toContain('z.enum(ATTENDANCE_SCHEDULER_SCOPE_ACTION_VALUES)')

    const scope = helpers.normalizeAttendanceSchedulerScopeInput({
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['view', 'edit', 'remind'],
      scope: {
        scheduleGroupIds: ['sg-1'],
        userIds: ['u-1', 'u-2'],
      },
    })

    expect(scope).toEqual({
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['view', 'edit', 'remind'],
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
    expect(() => helpers.normalizeAttendanceSchedulerScopeInput({
      subjectType: 'user',
      subjectRef: 'scheduler-1',
      actions: ['notify'],
      scope: { userIds: ['u-1'] },
    })).toThrow(/actions must contain valid scheduler actions/)
  })

  it('matches scheduler scopes by actor subject, action, and target for runtime enforcement', () => {
    const scope = {
      subjectType: 'role_tag',
      subjectRef: 'line_scheduler',
      actions: ['dispatch', 'remind'],
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
    expect(helpers.attendanceSchedulerScopeAllowsActorActionTarget(scope, actor, 'remind', {
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

  it('authorizes assignment dispatch from one in-scope membership instead of full group coverage', () => {
    const actor = {
      userId: 'scheduler-1',
      roles: [],
      roleTags: [],
    }
    const scope = {
      subjectType: 'user',
      subjectRef: 'scheduler-1',
      actions: ['dispatch', 'view', 'export'],
      isActive: true,
      scope: {
        scheduleGroupIds: ['sg-a'],
        attendanceGroupIds: [],
        userIds: [],
        departments: [],
        roles: ['ops'],
        roleTags: ['line_scheduler'],
      },
    }

    expect(helpers.attendanceSchedulerScopeMatchesTarget(scope, {
      scheduleGroupIds: ['sg-a', 'sg-b'],
      userIds: ['worker-1'],
    })).toBe(false)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership(scope, actor, 'worker-1', {
      schedule_group_id: 'sg-a',
      attendance_group_id: null,
      department_ref: 'dept-a',
    })).toBe(true)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership(scope, actor, 'worker-1', {
      schedule_group_id: 'sg-b',
      attendance_group_id: null,
      department_ref: 'dept-b',
    })).toBe(false)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership({
      ...scope,
      scope: {
        ...scope.scope,
        scheduleGroupIds: [],
        userIds: ['worker-1'],
      },
    }, actor, 'worker-1', {
      schedule_group_id: 'sg-b',
    })).toBe(true)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership({
      ...scope,
      scope: {
        ...scope.scope,
        scheduleGroupIds: [],
        userIds: ['worker-1'],
      },
    }, actor, 'worker-2', {
      schedule_group_id: 'sg-b',
    })).toBe(false)
    const splitDimensionScope = {
      ...scope,
      scope: {
        ...scope.scope,
        departments: ['dept-b'],
      },
    }
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership(splitDimensionScope, actor, 'worker-1', {
      schedule_group_id: 'sg-a',
      department_ref: 'dept-a',
    })).toBe(false)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership(splitDimensionScope, actor, 'worker-1', {
      schedule_group_id: 'sg-b',
      department_ref: 'dept-b',
    })).toBe(false)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership(splitDimensionScope, actor, 'worker-1', {
      schedule_group_id: 'sg-a',
      department_ref: 'dept-b',
    })).toBe(true)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership({
      ...scope,
      scope: {
        scheduleGroupIds: [],
        attendanceGroupIds: [],
        userIds: [],
        departments: [],
        roles: ['ops'],
        roleTags: [],
      },
    }, actor, 'worker-1', {
      schedule_group_id: 'sg-a',
    })).toBe(false)
    expect(helpers.attendanceScheduleAssignmentDispatchScopeAllowsMembership({
      ...scope,
      actions: ['view'],
    }, actor, 'worker-1', {
      schedule_group_id: 'sg-a',
    })).toBe(false)
  })
})
