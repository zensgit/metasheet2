import { describe, expect, it } from 'vitest'
import {
  clearStoredConfig,
  readStoredBackend,
  readStoredConfig,
  readStoredRefresh,
  readStoredViewFilters,
  saveStoredBackend,
  saveStoredConfig,
  saveStoredRefresh,
  saveStoredViewFilters,
  type StorageLike,
} from '../src/metaStorage'

function createStorage(seed: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(seed))

  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

describe('metaStorage helpers', () => {
  it('reads and writes meta config and backend flags', () => {
    const storage = createStorage()

    saveStoredConfig({ sheetId: 'sheet-1', viewId: 'view-1' }, storage)
    saveStoredBackend(true, storage)

    expect(readStoredConfig(storage)).toEqual({ sheetId: 'sheet-1', viewId: 'view-1' })
    expect(readStoredBackend(storage)).toBe(true)

    clearStoredConfig(storage)
    expect(readStoredConfig(storage)).toBeNull()
  })

  it('returns null for malformed saved payloads', () => {
    const storage = createStorage({
      'metasheet.devMetaConfig': '{"viewId":"missing-sheet"}',
      'metasheet.devRefreshConfig': '{"intervalSec":"fast"}',
      'metasheet.devViewFilters': '{"type":"timeline"}',
    })

    expect(readStoredConfig(storage)).toBeNull()
    expect(readStoredRefresh(storage)).toBeNull()
    expect(readStoredViewFilters(storage)).toBeNull()
  })

  it('persists refresh and view-filter config', () => {
    const storage = createStorage()

    saveStoredRefresh({ autoRefresh: true, intervalSec: 30 }, storage)
    saveStoredViewFilters({ search: 'alpha', type: 'grid' }, storage)

    expect(readStoredRefresh(storage)).toEqual({ autoRefresh: true, intervalSec: 30 })
    expect(readStoredViewFilters(storage)).toEqual({ search: 'alpha', type: 'grid' })
  })
})
