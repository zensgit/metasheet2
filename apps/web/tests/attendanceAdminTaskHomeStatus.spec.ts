import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_ADMIN_TASK_HOME_STATUS_VALUES,
  DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS,
  attendanceAdminTaskHomeStatusLabel,
  deriveAdminTaskHomeGroupStatus,
  derivePeopleGroupsTaskHomeStatus,
  resolveAttendanceAdminTaskHomeStatus,
} from '../src/views/attendance/attendanceAdminTaskHomeStatus'
import type { AttendanceSetupReadinessStepResult } from '../src/views/attendance/attendanceSetupReadiness'

const tr = (en: string) => en

function gatingSteps(
  statuses: Partial<Record<string, AttendanceSetupReadinessStepResult['status']>>,
): AttendanceSetupReadinessStepResult[] {
  const ids = [
    'attendance-admin-user-access',
    'attendance-admin-groups',
    'attendance-admin-shifts',
    'attendance-admin-approval-flows',
  ] as const
  return ids.map((stepId) => ({
    stepId,
    status: statuses[stepId] ?? 'ready',
    reason: 'ready',
    scope: 'org',
  }))
}

describe('attendanceAdminTaskHomeStatus', () => {
  it('keeps the charter closed set and fail-closed default away from ok', () => {
    expect([...ATTENDANCE_ADMIN_TASK_HOME_STATUS_VALUES]).toEqual([
      'not_configured',
      'needs_attention',
      'ok',
      'failed',
      'unknown',
    ])
    // Mutation target: mapping the default / unknown resolver to `ok` must turn this red.
    expect(DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS).toBe('unknown')
    expect(DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS).not.toBe('ok')
    expect(resolveAttendanceAdminTaskHomeStatus(undefined)).toBe('unknown')
    expect(resolveAttendanceAdminTaskHomeStatus(null)).toBe('unknown')
    expect(resolveAttendanceAdminTaskHomeStatus('ready')).toBe('unknown')
    expect(resolveAttendanceAdminTaskHomeStatus('success')).toBe('unknown')
    expect(resolveAttendanceAdminTaskHomeStatus('')).toBe('unknown')
    expect(resolveAttendanceAdminTaskHomeStatus('ok')).toBe('ok')
  })

  it('renders four-state labels and never labels unknown as OK', () => {
    expect(attendanceAdminTaskHomeStatusLabel('not_configured', tr)).toBe('Not configured')
    expect(attendanceAdminTaskHomeStatusLabel('needs_attention', tr)).toBe('Needs attention')
    expect(attendanceAdminTaskHomeStatusLabel('ok', tr)).toBe('OK')
    expect(attendanceAdminTaskHomeStatusLabel('failed', tr)).toBe('Failed')
    expect(attendanceAdminTaskHomeStatusLabel('unknown', tr)).toBe('Unknown')
    expect(attendanceAdminTaskHomeStatusLabel('unknown', tr)).not.toBe('OK')
  })

  it('derives people-groups from setup-readiness with positive evidence required for ok', () => {
    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'idle',
      readiness: null,
      steps: [],
    })).toBe('unknown')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loading',
      readiness: null,
      steps: [],
    })).toBe('unknown')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'error',
      readiness: null,
      steps: [],
    })).toBe('failed')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'forbidden' },
      steps: [],
    })).toBe('failed')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'db_not_ready' },
      steps: [],
    })).toBe('failed')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'ok', data: {} as never },
      steps: [],
    })).toBe('unknown')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'ok', data: {} as never },
      steps: gatingSteps({ 'attendance-admin-groups': 'missing' }),
    })).toBe('not_configured')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'ok', data: {} as never },
      steps: gatingSteps({ 'attendance-admin-approval-flows': 'unknown' }),
    })).toBe('needs_attention')

    expect(derivePeopleGroupsTaskHomeStatus({
      loadState: 'loaded',
      readiness: { kind: 'ok', data: {} as never },
      steps: gatingSteps({}),
    })).toBe('ok')
  })

  it('keeps groups without a reliable aggregate at unknown (no fake all-clear)', () => {
    const readyPeople = {
      loadState: 'loaded' as const,
      readiness: { kind: 'ok' as const, data: {} as never },
      steps: gatingSteps({}),
    }
    expect(deriveAdminTaskHomeGroupStatus('people-groups', readyPeople)).toBe('ok')
    expect(deriveAdminTaskHomeGroupStatus('daily-operations', readyPeople)).toBe('unknown')
    expect(deriveAdminTaskHomeGroupStatus('work-time-policies', readyPeople)).toBe('unknown')
    expect(deriveAdminTaskHomeGroupStatus('reporting-payroll', readyPeople)).toBe('unknown')
  })
})
