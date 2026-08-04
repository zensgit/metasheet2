import { describe, expect, it } from 'vitest'
import { hydrateAttendanceGroupRoute } from '../src/views/attendance/attendanceGroupRouteHydration'

const GROUP_A = { id: 'a', name: 'First group' }
const GROUP_B = { id: 'b', name: 'Route group' }

describe('attendance group route hydration', () => {
  it('seeds the authorized schedule group before applying its schedule stage', () => {
    const result = hydrateAttendanceGroupRoute({
      groups: [GROUP_A],
      total: 1,
      group: GROUP_B,
      step: 'schedule',
      surface: null,
      currentStage: 'basics',
    })

    expect(result.groups.map(group => group.id)).toEqual(['b', 'a'])
    expect(result.stage).toBe('schedule')
    expect(result.section).toBe('attendance-admin-groups')
  })

  it('never lets rules hydration settle back on basics and keeps its closed surface', () => {
    const result = hydrateAttendanceGroupRoute({
      groups: [GROUP_A],
      total: 1,
      group: GROUP_B,
      step: 'rules',
      surface: 'rule-sets',
      currentStage: 'basics',
    })

    expect(result.stage).toBe('policies')
    expect(result.stage).not.toBe('basics')
    expect(result.section).toBe('attendance-admin-rule-sets')
  })

  it('keeps the route group and stage when a delayed ordinary list response arrives', () => {
    const delayedList = [{ id: 'a', name: 'Ordinary first group' }, { id: 'b', name: 'Stale list group' }]
    const result = hydrateAttendanceGroupRoute({
      groups: delayedList,
      total: delayedList.length,
      group: GROUP_B,
      step: 'schedule',
      surface: 'advanced-scheduling',
      currentStage: 'basics',
    })

    expect(result.groups[0]).toEqual(GROUP_B)
    expect(result.groups).toHaveLength(2)
    expect(result.stage).toBe('schedule')
    expect(result.section).toBe('attendance-admin-advanced-scheduling-workbench')
  })

  it('preserves a non-group calendar target without inventing a basics reset', () => {
    const result = hydrateAttendanceGroupRoute({
      groups: [GROUP_A],
      total: 1,
      group: GROUP_B,
      step: 'calendar',
      surface: null,
      currentStage: 'policies',
    })

    expect(result.stage).toBe('policies')
    expect(result.section).toBe('attendance-admin-holidays')
  })

  it.each([
    ['schedule', null, 'schedule', 'attendance-admin-groups'],
    ['schedule', 'shifts', 'schedule', 'attendance-admin-shifts'],
    ['schedule', 'assignments', 'schedule', 'attendance-admin-assignments'],
    ['schedule', 'advanced-scheduling', 'schedule', 'attendance-admin-advanced-scheduling-workbench'],
    ['calendar', null, 'people', 'attendance-admin-holidays'],
    ['rules', null, 'policies', 'attendance-admin-groups'],
    ['rules', 'rule-sets', 'policies', 'attendance-admin-rule-sets'],
  ] as const)('uses the R0 authority table for %s/%s', (step, surface, stage, section) => {
    const result = hydrateAttendanceGroupRoute({
      groups: [GROUP_A],
      total: 1,
      group: GROUP_B,
      step,
      surface,
      currentStage: 'people',
    })

    expect(result.stage).toBe(stage)
    expect(result.section).toBe(section)
  })

  it('fails closed when step and surface bypass the R0 parser as an illegal pair', () => {
    expect(() => hydrateAttendanceGroupRoute({
      groups: [GROUP_A],
      total: 1,
      group: GROUP_B,
      step: 'rules',
      surface: 'shifts',
      currentStage: 'basics',
    })).toThrow('Invalid attendance group route target')
  })
})
