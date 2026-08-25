import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  mergeSettings: (base: Record<string, unknown>, update: Record<string, unknown>) => Record<string, unknown>
  normalizeEmployeeQuickActionIconsSetting: (raw: unknown) => {
    makeup: string
    leave: string
    overtime: string
    swap: string
  }
  pickEmployeeQuickActionIconsPublic: (settings: unknown) => {
    makeup: string
    leave: string
    overtime: string
    swap: string
  }
}
const pluginSource = readFileSync(new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url), 'utf8')

const DEFAULTS = {
  makeup: 'clock-plus',
  leave: 'calendar',
  overtime: 'moon',
  swap: 'swap',
}

describe('employeeQuickActionIcons settings (visual-only)', () => {
  it('normalizes unset and invalid keys to the built-in defaults', () => {
    expect(helpers.normalizeEmployeeQuickActionIconsSetting(undefined)).toEqual(DEFAULTS)
    expect(helpers.normalizeEmployeeQuickActionIconsSetting(null)).toEqual(DEFAULTS)
    expect(helpers.normalizeEmployeeQuickActionIconsSetting({
      makeup: 'not-an-icon',
      leave: 'briefcase',
      extra: 'pin',
    })).toEqual({
      makeup: 'clock-plus',
      leave: 'briefcase',
      overtime: 'moon',
      swap: 'swap',
    })
  })

  it('mergeSettings shallow-merges icon keys and preserves them on unrelated PUTs', () => {
    const stored = helpers.mergeSettings({}, {
      employeeQuickActionIcons: { makeup: 'plus', leave: 'user' },
    })
    expect(stored.employeeQuickActionIcons).toEqual({
      makeup: 'plus',
      leave: 'user',
      overtime: 'moon',
      swap: 'swap',
    })

    const patched = helpers.mergeSettings(stored, {
      employeeQuickActionIcons: { overtime: 'briefcase' },
    })
    expect(patched.employeeQuickActionIcons).toEqual({
      makeup: 'plus',
      leave: 'user',
      overtime: 'briefcase',
      swap: 'swap',
    })

    const sibling = helpers.mergeSettings(patched, { minPunchIntervalMinutes: 5 })
    expect(sibling.employeeQuickActionIcons).toEqual(patched.employeeQuickActionIcons)
    expect(sibling.minPunchIntervalMinutes).toBe(5)
  })

  it('settingsSchema is enum-strict on write (illegal values 400 at the route)', () => {
    expect(pluginSource).toMatch(/makeup:\s*z\.enum\(EMPLOYEE_QUICK_ACTION_ICON_ID_VALUES\)/)
    expect(pluginSource).not.toMatch(/employeeQuickActionIcons:\s*z\.object\(\{\s*\n\s*makeup:\s*z\.string\(\)/)
    expect(pluginSource).toContain("'/api/attendance/employee-quick-action-icons'")
    expect(pluginSource).toContain("withPermission('attendance:read'")
    expect(pluginSource).toMatch(/GET',\s*[\n\s]*'\/api\/attendance\/settings',\s*[\n\s]*withPermission\('attendance:admin'/)
  })

  it('employee-readable projection returns only the four icon keys', () => {
    expect(helpers.pickEmployeeQuickActionIconsPublic({
      ipAllowlist: ['10.0.0.1'],
      geoFence: { lat: 1, lng: 2, radiusMeters: 3 },
      employeeQuickActionIcons: { makeup: 'plus', leave: 'user' },
    })).toEqual({
      makeup: 'plus',
      leave: 'user',
      overtime: 'moon',
      swap: 'swap',
    })
  })
})
