import { FIXED_GROUP, FIXED_SHIFT, fixedScheduleFixture, type FixtureFixedState } from './fixedScheduleEffectiveness'
export const FIXED_ORG = 'synthetic-fser-org'
export const FIXED_USER = 'synthetic-fser-self'
export const fixedSurfaceGroup = {
  id: FIXED_GROUP, orgId: FIXED_ORG, name: 'Synthetic fixed group', code: 'FSER',
  attendanceType: 'fixed_shift', timezone: 'Asia/Shanghai', ruleSetId: null,
}
export const fixedSurfaceShift = {
  id: FIXED_SHIFT, orgId: FIXED_ORG, name: 'Synthetic fixed shift',
  workStartTime: '09:00', workEndTime: '18:00', startTime: '09:00', endTime: '18:00',
  workingDays: [1, 2, 3, 4, 5],
}
export function fixedRulesClock(url: string) {
  const resolvedAt = new Date().toISOString()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(resolvedAt)).map(part => [part.type, part.value]))
  const currentLocalDate = parts.year + '-' + parts.month + '-' + parts.day
  return {
    resolvedAt,
    resolvedForDate: new URL(url, 'https://fixture.invalid').searchParams.get('asOf') ?? currentLocalDate,
    attendanceTimeContext: {
      resolvedForInstant: resolvedAt, effectiveTimezone: 'Asia/Shanghai', timezoneSource: 'system_default',
      mode: 'default_only', policyVersion: 0, referenceId: 'synthetic-fser-clock', version: 1,
      currentLocalDate, nextEffectiveBoundary: null,
    },
  }
}
export function fixedSurfaceResponse(url: string, state: FixtureFixedState, matching = false): unknown {
  const path = new URL(url, 'https://fixture.invalid').pathname
  if (path.endsWith('/fixed-schedule/effectiveness/me')) return fixedScheduleFixture(state, true, matching)
  if (path.endsWith('/fixed-schedule/effectiveness')) return fixedScheduleFixture(state)
  if (path.endsWith('/fixed-schedule/editor')) {
    const payload = fixedScheduleFixture(state).data
    return { ok: true, data: {
      groupId: FIXED_GROUP, orgId: FIXED_ORG, state: payload.state, reasonCodes: payload.reasonCodes,
      desired: payload.desired, drift: { managedSets: 'drift' in payload ? payload.drift.managedSets : [] },
      referenceEligibility: payload.desired ? { shiftId: FIXED_SHIFT, allowed: true, reasonCode: null } : null,
      shift: fixedSurfaceShift,
    } }
  }
  if (path === '/api/attendance/groups') return { ok: true, data: { items: [fixedSurfaceGroup], total: 1, scope: 'org' } }
  if (path === '/api/attendance/shifts') return { ok: true, data: { items: [fixedSurfaceShift], total: 1 } }
  if (path === '/api/attendance/shifts/' + FIXED_SHIFT) return { ok: true, data: fixedSurfaceShift }
  if (path === '/api/attendance/rules/me') return { ok: true, data: {
    ...fixedRulesClock(url), userId: FIXED_USER, orgId: FIXED_ORG,
    assignment: { attendanceGroups: [fixedSurfaceGroup], scheduleGroups: [] },
    runtimeRule: { timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
    configuredGroupRule: null, warnings: [],
  } }
  return { ok: true, data: { items: [], total: 0, summary: null } }
}
