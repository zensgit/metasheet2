import { describe, expect, it } from 'vitest'
import {
  COMMON_ICON_STORAGE_KEY,
  DEFAULT_COMMON_ICONS,
  loadCommonIconPrefs,
  saveCommonIconPrefs,
} from '../src/views/attendance/attendanceEmployeeWorkspaceCommonIcons'

function memoryStorage(initial?: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    get length() { return map.size },
    clear() { map.clear() },
    getItem(key: string) { return map.has(key) ? map.get(key)! : null },
    key(index: number) { return [...map.keys()][index] ?? null },
    removeItem(key: string) { map.delete(key) },
    setItem(key: string, value: string) { map.set(key, value) },
  }
}

describe('attendanceEmployeeWorkspaceCommonIcons', () => {
  it('returns the four default pictograms when storage is empty', () => {
    expect(loadCommonIconPrefs(memoryStorage())).toEqual(DEFAULT_COMMON_ICONS)
    expect(DEFAULT_COMMON_ICONS).toEqual({
      'missing-punch': 'clock-plus',
      leave: 'calendar',
      overtime: 'moon',
      'shift-swap': 'swap',
    })
  })

  it('persists and reloads a per-action pictogram without touching other keys', () => {
    const storage = memoryStorage()
    saveCommonIconPrefs({
      ...DEFAULT_COMMON_ICONS,
      leave: 'briefcase',
    }, storage)
    expect(JSON.parse(storage.getItem(COMMON_ICON_STORAGE_KEY) ?? '{}')).toEqual({
      'missing-punch': 'clock-plus',
      leave: 'briefcase',
      overtime: 'moon',
      'shift-swap': 'swap',
    })
    expect(loadCommonIconPrefs(storage).leave).toBe('briefcase')
    expect(loadCommonIconPrefs(storage).overtime).toBe('moon')
  })

  it('ignores unknown action keys and unknown icon ids', () => {
    const storage = memoryStorage({
      [COMMON_ICON_STORAGE_KEY]: JSON.stringify({
        leave: 'not-an-icon',
        overtime: 'user',
        extra: 'pin',
      }),
    })
    expect(loadCommonIconPrefs(storage)).toEqual({
      ...DEFAULT_COMMON_ICONS,
      overtime: 'user',
    })
  })

  it('falls back to defaults when storage throws or holds invalid JSON', () => {
    const throwing = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    } as unknown as Storage
    expect(loadCommonIconPrefs(throwing)).toEqual(DEFAULT_COMMON_ICONS)
    expect(() => saveCommonIconPrefs(DEFAULT_COMMON_ICONS, throwing)).not.toThrow()
    expect(loadCommonIconPrefs(memoryStorage({
      [COMMON_ICON_STORAGE_KEY]: '{',
    }))).toEqual(DEFAULT_COMMON_ICONS)
  })
})
