// View-layer-only 常用 icon keys for the employee overview.
// Original filled pictograms (面性 language, not Feishu trademark assets).
// Admin persists { makeup, leave, overtime, swap } on attendance settings.
// Employees read ONLY those four keys from GET /api/attendance/employee-quick-action-icons.
// unknown/invalid keys fall back to these defaults.
// Owner lock (2026-08-24): default glyphs are accepted — clock-plus / calendar /
// moon / swap. Do not restyle or replace those defaults.

export const COMMON_ICON_IDS = [
  'clock-plus',
  'calendar',
  'moon',
  'swap',
  'plus',
  'user',
  'briefcase',
  'pin',
] as const

export type CommonIconId = typeof COMMON_ICON_IDS[number]

export const EMPLOYEE_QUICK_ACTION_KEYS = ['makeup', 'leave', 'overtime', 'swap'] as const

export type EmployeeQuickActionKey = typeof EMPLOYEE_QUICK_ACTION_KEYS[number]

export type EmployeeQuickActionIcons = Record<EmployeeQuickActionKey, CommonIconId>

export const DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS: EmployeeQuickActionIcons = {
  makeup: 'clock-plus',
  leave: 'calendar',
  overtime: 'moon',
  swap: 'swap',
}

export function isCommonIconId(value: unknown): value is CommonIconId {
  return typeof value === 'string' && (COMMON_ICON_IDS as readonly string[]).includes(value)
}

export function resolveEmployeeQuickActionIcons(raw: unknown): EmployeeQuickActionIcons {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    makeup: isCommonIconId(source.makeup) ? source.makeup : DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.makeup,
    leave: isCommonIconId(source.leave) ? source.leave : DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.leave,
    overtime: isCommonIconId(source.overtime) ? source.overtime : DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.overtime,
    swap: isCommonIconId(source.swap) ? source.swap : DEFAULT_EMPLOYEE_QUICK_ACTION_ICONS.swap,
  }
}
