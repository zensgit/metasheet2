import type { ViewTypeFilter } from './viewFilters'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface StoredMetaConfig {
  sheetId: string
  viewId: string
}

export interface StoredRefreshConfig {
  autoRefresh: boolean
  intervalSec: number
}

export interface StoredViewFilters {
  search: string
  type: ViewTypeFilter
}

export const DEV_TOKEN_KEY = 'metasheet.devToken'
export const DEV_META_CONFIG_KEY = 'metasheet.devMetaConfig'
export const DEV_REFRESH_CONFIG_KEY = 'metasheet.devRefreshConfig'
export const DEV_BACKEND_CONFIG_KEY = 'metasheet.devBackendConfig'
export const DEV_VIEW_FILTER_KEY = 'metasheet.devViewFilters'

function resolveStorage(storage?: StorageLike | null) {
  if (storage) {
    return storage
  }

  if (typeof window === 'undefined') {
    return null
  }

  return window.localStorage
}

export function readStoredConfig(storage?: StorageLike | null): StoredMetaConfig | null {
  const target = resolveStorage(storage)
  if (!target) return null

  const raw = target.getItem(DEV_META_CONFIG_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { sheetId?: string; viewId?: string }
    if (!parsed.sheetId) return null

    return {
      sheetId: parsed.sheetId,
      viewId: parsed.viewId ?? '',
    }
  } catch {
    return null
  }
}

export function saveStoredConfig(config: StoredMetaConfig, storage?: StorageLike | null) {
  resolveStorage(storage)?.setItem(DEV_META_CONFIG_KEY, JSON.stringify(config))
}

export function clearStoredConfig(storage?: StorageLike | null) {
  resolveStorage(storage)?.removeItem(DEV_META_CONFIG_KEY)
}

export function readStoredRefresh(storage?: StorageLike | null): StoredRefreshConfig | null {
  const target = resolveStorage(storage)
  if (!target) return null

  const raw = target.getItem(DEV_REFRESH_CONFIG_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { autoRefresh?: boolean; intervalSec?: number }
    if (typeof parsed.intervalSec !== 'number') return null

    return {
      autoRefresh: Boolean(parsed.autoRefresh),
      intervalSec: parsed.intervalSec,
    }
  } catch {
    return null
  }
}

export function saveStoredRefresh(config: StoredRefreshConfig, storage?: StorageLike | null) {
  resolveStorage(storage)?.setItem(DEV_REFRESH_CONFIG_KEY, JSON.stringify(config))
}

export function readStoredBackend(storage?: StorageLike | null) {
  return resolveStorage(storage)?.getItem(DEV_BACKEND_CONFIG_KEY) === 'true'
}

export function saveStoredBackend(enabled: boolean, storage?: StorageLike | null) {
  resolveStorage(storage)?.setItem(DEV_BACKEND_CONFIG_KEY, enabled ? 'true' : 'false')
}

export function readStoredViewFilters(storage?: StorageLike | null): StoredViewFilters | null {
  const target = resolveStorage(storage)
  if (!target) return null

  const raw = target.getItem(DEV_VIEW_FILTER_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { search?: string; type?: ViewTypeFilter }
    const type = parsed.type ?? 'all'
    if (!['all', 'grid', 'kanban', 'calendar', 'gallery', 'form', 'other'].includes(type)) {
      return null
    }

    return {
      search: parsed.search ?? '',
      type,
    }
  } catch {
    return null
  }
}

export function saveStoredViewFilters(filters: StoredViewFilters, storage?: StorageLike | null) {
  resolveStorage(storage)?.setItem(DEV_VIEW_FILTER_KEY, JSON.stringify(filters))
}
