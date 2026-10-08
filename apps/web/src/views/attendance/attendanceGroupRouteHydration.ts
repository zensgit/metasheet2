import {
  resolveAttendanceGroupRouteStage,
  resolveAttendanceGroupRouteTarget,
  type AttendanceGroupRouteStep,
  type AttendanceGroupRouteSurface,
} from '../../router/attendanceGroupContextRoute'

export type AttendanceGroupRouteWorkflowStage = 'basics' | 'people' | 'schedule' | 'policies'

export type AttendanceGroupRouteHydration<T extends { id: string }> = {
  groups: T[]
  total: number
  stage: AttendanceGroupRouteWorkflowStage
  section: string
}

export function hydrateAttendanceGroupRoute<T extends { id: string }>(input: {
  groups: T[]
  total: number
  group: T
  step: AttendanceGroupRouteStep
  surface: AttendanceGroupRouteSurface | null
  currentStage: AttendanceGroupRouteWorkflowStage
}): AttendanceGroupRouteHydration<T> {
  const target = resolveAttendanceGroupRouteTarget(input.step, input.surface)
  if (!target) throw new Error('Invalid attendance group route target')
  const routeStage = resolveAttendanceGroupRouteStage(input.step)
  const groups = input.groups.filter(group => group.id !== input.group.id)
  groups.unshift(input.group)
  return {
    groups,
    total: Math.max(input.total, groups.length),
    stage: routeStage ?? input.currentStage,
    section: target.kind === 'admin-section' ? target.section : 'attendance-admin-groups',
  }
}
