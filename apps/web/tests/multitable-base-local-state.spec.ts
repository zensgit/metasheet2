import { describe, expect, it } from 'vitest'
import type { MetaBase } from '../src/multitable/types'
import {
  decorateAndSortBases,
  readFavoriteBaseIds,
  readRecentBaseOpens,
  rememberRecentBaseOpen,
  toggleFavoriteBaseId,
} from '../src/multitable/utils/base-local-state'

const FAVORITE_BASES_KEY = 'metasheet:multitable:favorite-base-ids:v1'
const RECENT_BASES_KEY = 'metasheet:multitable:recent-base-opens:v1'

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    get length() {
      return store.size
    },
  } as Storage
}

function base(id: string, name = id): MetaBase {
  return { id, name }
}

describe('multitable base local state', () => {
  it('reads corrupted localStorage payloads defensively', () => {
    const storage = createMemoryStorage()
    storage.setItem(FAVORITE_BASES_KEY, '{bad')
    storage.setItem(RECENT_BASES_KEY, JSON.stringify([{ baseId: 'base_a' }, null, 'bad']))

    expect(readFavoriteBaseIds(storage)).toEqual([])
    expect(readRecentBaseOpens(storage)).toEqual([])
  })

  it('toggles favorite base ids and de-duplicates stored ids', () => {
    const storage = createMemoryStorage()
    storage.setItem(FAVORITE_BASES_KEY, JSON.stringify(['base_a', 'base_a']))

    expect(toggleFavoriteBaseId('base_b', storage)).toEqual(['base_b', 'base_a'])
    expect(toggleFavoriteBaseId('base_a', storage)).toEqual(['base_b'])
    expect(readFavoriteBaseIds(storage)).toEqual(['base_b'])
  })

  it('remembers recent opens with de-dupe and newest-first ordering', () => {
    const storage = createMemoryStorage()

    rememberRecentBaseOpen('base_a', storage)
    rememberRecentBaseOpen('base_b', storage)
    rememberRecentBaseOpen('base_a', storage)

    const recent = readRecentBaseOpens(storage)
    expect(recent.map((entry) => entry.baseId)).toEqual(['base_a', 'base_b'])
    expect(recent[0]?.openedAt).toBeTypeOf('string')
  })

  it('sorts favorites before recents and preserves API order fallback', () => {
    const bases = [
      base('base_a', 'A'),
      base('base_b', 'B'),
      base('base_c', 'C'),
      base('base_d', 'D'),
    ]

    const sorted = decorateAndSortBases(
      bases,
      ['base_c', 'missing_base'],
      [
        { baseId: 'base_b', openedAt: '2026-05-18T10:00:00.000Z' },
        { baseId: 'base_d', openedAt: '2026-05-18T09:00:00.000Z' },
        { baseId: 'missing_base', openedAt: '2026-05-18T11:00:00.000Z' },
      ],
    )

    expect(sorted.map((item) => item.id)).toEqual(['base_c', 'base_b', 'base_d', 'base_a'])
    expect(sorted[0]).toMatchObject({ id: 'base_c', isFavorite: true, lastOpenedAt: null })
    expect(sorted[1]).toMatchObject({ id: 'base_b', isFavorite: false, lastOpenedAt: '2026-05-18T10:00:00.000Z' })
    expect(sorted[3]).toMatchObject({ id: 'base_a', isFavorite: false, lastOpenedAt: null })
  })
})

