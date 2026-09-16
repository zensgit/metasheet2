import { describe, expect, it } from 'vitest'
import {
  COMMON_ICON_IDS,
  DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS,
  WORKSPACE_DISPLAY_ICON_IDS,
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

  it('keeps the check mark as first-viewport chrome only, not an admin picker key', () => {
    expect(COMMON_ICON_IDS).not.toContain('check')
    expect(WORKSPACE_DISPLAY_ICON_IDS).toContain('check')
    expect(resolveEmployeeQuickActionIcons({ makeup: 'check' }).makeup).toBe('clock-plus')
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
