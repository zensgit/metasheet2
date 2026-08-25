import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS,
  resolveEmployeeQuickActionIcons,
} from '../src/views/attendance/attendanceEmployeeWorkspaceCommonIcons'

describe('attendanceEmployeeWorkspaceCommonIcons', () => {
  it('returns the four default pictograms when unset', () => {
    expect(resolveEmployeeQuickActionIcons(undefined)).toEqual(DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS)
    expect(resolveEmployeeQuickActionIcons(null)).toEqual(DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS)
    expect(resolveEmployeeQuickActionIcons({})).toEqual({
      makeup: 'clock-plus',
      leave: 'calendar',
      overtime: 'moon',
      swap: 'swap',
    })
  })

  it('keeps valid keys and falls back unknown/invalid ones', () => {
    expect(resolveEmployeeQuickActionIcons({
      makeup: 'plus',
      leave: 'not-an-icon',
      overtime: 'user',
      extra: 'pin',
    })).toEqual({
      makeup: 'plus',
      leave: 'calendar',
      overtime: 'user',
      swap: 'swap',
    })
  })
})
