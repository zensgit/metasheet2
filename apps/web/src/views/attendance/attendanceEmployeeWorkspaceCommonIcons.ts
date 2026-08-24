// View-layer-only 常用 icon prefs for the employee overview.
// Original filled pictograms (面性 language, not Feishu trademark assets).
// Persisted in localStorage — no API, punch, policy, or approval change.

export const COMMON_ICON_STORAGE_KEY = 'metasheet.attendance.ew.common-icons.v1'

export const COMMON_ACTION_KEYS = ['missing-punch', 'leave', 'overtime', 'shift-swap'] as const

export type CommonActionKey = typeof COMMON_ACTION_KEYS[number]

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

export type CommonIconPrefs = Record<CommonActionKey, CommonIconId>

export const DEFAULT_COMMON_ICONS: CommonIconPrefs = {
  'missing-punch': 'clock-plus',
  leave: 'calendar',
  overtime: 'moon',
  'shift-swap': 'swap',
}

export function isCommonIconId(value: unknown): value is CommonIconId {
  return typeof value === 'string' && (COMMON_ICON_IDS as readonly string[]).includes(value)
}

export function isCommonActionKey(value: unknown): value is CommonActionKey {
  return typeof value === 'string' && (COMMON_ACTION_KEYS as readonly string[]).includes(value)
}

function readStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadCommonIconPrefs(storage?: Storage | null): CommonIconPrefs {
  const defaults: CommonIconPrefs = { ...DEFAULT_COMMON_ICONS }
  const store = readStorage(storage)
  if (!store) return defaults
  try {
    const raw = store.getItem(COMMON_ICON_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>
    if (!parsed || typeof parsed !== 'object') return defaults
    const next = { ...defaults }
    for (const action of COMMON_ACTION_KEYS) {
      if (isCommonIconId(parsed[action])) next[action] = parsed[action]
    }
    return next
  } catch {
    return defaults
  }
}

export function saveCommonIconPrefs(prefs: CommonIconPrefs, storage?: Storage | null): void {
  const store = readStorage(storage)
  if (!store) return
  try {
    store.setItem(COMMON_ICON_STORAGE_KEY, JSON.stringify({
      'missing-punch': prefs['missing-punch'],
      leave: prefs.leave,
      overtime: prefs.overtime,
      'shift-swap': prefs['shift-swap'],
    }))
  } catch {
    // private mode / quota — keep in-memory prefs only
  }
}
