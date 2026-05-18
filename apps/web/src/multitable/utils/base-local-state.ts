import type { MetaBase } from '../types'

const FAVORITE_BASE_IDS_KEY = 'metasheet:multitable:favorite-base-ids:v1'
const RECENT_BASE_OPENS_KEY = 'metasheet:multitable:recent-base-opens:v1'
const RECENT_BASE_OPENS_LIMIT = 20

export interface RecentBaseOpen {
  baseId: string
  openedAt: string
}

export interface DecoratedBase extends MetaBase {
  isFavorite: boolean
  lastOpenedAt: string | null
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage
  return typeof localStorage === 'undefined' ? null : localStorage
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecentBaseOpen(value: unknown): value is RecentBaseOpen {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.baseId === 'string' && typeof record.openedAt === 'string'
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id.trim().length > 0)))
}

export function readFavoriteBaseIds(storage?: Storage | null): string[] {
  const target = getStorage(storage)
  if (!target) return []

  try {
    const raw = target.getItem(FAVORITE_BASE_IDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return isStringArray(parsed) ? uniqueIds(parsed) : []
  } catch {
    return []
  }
}

export function writeFavoriteBaseIds(ids: readonly string[], storage?: Storage | null): void {
  const target = getStorage(storage)
  if (!target) return

  try {
    target.setItem(FAVORITE_BASE_IDS_KEY, JSON.stringify(uniqueIds(ids)))
  } catch {
    // Local UI preferences are non-critical; private-mode/quota failures should not block navigation.
  }
}

export function toggleFavoriteBaseId(baseId: string, storage?: Storage | null): string[] {
  const current = readFavoriteBaseIds(storage)
  const next = current.includes(baseId) ? current.filter((id) => id !== baseId) : [baseId, ...current]
  writeFavoriteBaseIds(next, storage)
  return next
}

export function readRecentBaseOpens(storage?: Storage | null): RecentBaseOpen[] {
  const target = getStorage(storage)
  if (!target) return []

  try {
    const raw = target.getItem(RECENT_BASE_OPENS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed
        .filter(isRecentBaseOpen)
        .sort((left, right) => right.openedAt.localeCompare(left.openedAt))
        .slice(0, RECENT_BASE_OPENS_LIMIT)
      : []
  } catch {
    return []
  }
}

export function writeRecentBaseOpens(entries: readonly RecentBaseOpen[], storage?: Storage | null): void {
  const target = getStorage(storage)
  if (!target) return

  try {
    target.setItem(RECENT_BASE_OPENS_KEY, JSON.stringify(entries.slice(0, RECENT_BASE_OPENS_LIMIT)))
  } catch {
    // Recent-open ordering is best-effort local state only.
  }
}

export function rememberRecentBaseOpen(baseId: string, storage?: Storage | null): RecentBaseOpen[] {
  const nextEntry: RecentBaseOpen = {
    baseId,
    openedAt: new Date().toISOString(),
  }
  const next = [
    nextEntry,
    ...readRecentBaseOpens(storage).filter((entry) => entry.baseId !== baseId),
  ].slice(0, RECENT_BASE_OPENS_LIMIT)
  writeRecentBaseOpens(next, storage)
  return next
}

export function decorateAndSortBases(
  bases: readonly MetaBase[],
  favoriteBaseIds: readonly string[],
  recentBaseOpens: readonly RecentBaseOpen[],
): DecoratedBase[] {
  const baseIdSet = new Set(bases.map((base) => base.id))
  const favoriteSet = new Set(favoriteBaseIds.filter((id) => baseIdSet.has(id)))
  const recentByBaseId = new Map(
    recentBaseOpens
      .filter((entry) => baseIdSet.has(entry.baseId))
      .map((entry) => [entry.baseId, entry.openedAt]),
  )

  return bases
    .map((base, index) => ({
      ...base,
      isFavorite: favoriteSet.has(base.id),
      lastOpenedAt: recentByBaseId.get(base.id) ?? null,
      index,
    }))
    .sort((left, right) => {
      const leftFavorite = left.isFavorite ? 1 : 0
      const rightFavorite = right.isFavorite ? 1 : 0
      if (leftFavorite !== rightFavorite) return rightFavorite - leftFavorite

      const leftOpenedAt = left.lastOpenedAt ?? ''
      const rightOpenedAt = right.lastOpenedAt ?? ''
      if (leftOpenedAt !== rightOpenedAt) return rightOpenedAt.localeCompare(leftOpenedAt)

      return left.index - right.index
    })
    .map(({ index: _index, ...base }) => base)
}

