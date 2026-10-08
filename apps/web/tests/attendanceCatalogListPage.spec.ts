import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_CATALOG_MAX_PAGES,
  ATTENDANCE_CATALOG_PAGE_SIZE,
  applyCatalogPage,
  catalogCanLoadMore,
  catalogTruncationCopy,
  emptyCatalogListState,
  type CatalogListState,
} from '../src/views/attendance/attendanceCatalogListPage'

function row(id: string) {
  return { id }
}

describe('attendance catalog list page', () => {
  it('requests the API max page and discloses a short first page', () => {
    expect(ATTENDANCE_CATALOG_PAGE_SIZE).toBe(200)
    const state = applyCatalogPage(emptyCatalogListState(), {
      items: [row('a')],
      total: 51,
      page: 1,
    }, false)
    expect(state).toMatchObject({ total: 51, page: 1, capped: false })
    expect(catalogCanLoadMore(state)).toBe(true)
    expect(catalogTruncationCopy(1, 51, false)).toEqual({
      en: 'Showing 1 of 51',
      zh: '已显示 1/51',
    })
  })

  it('appends the next page and stops when ids repeat or the page cap is hit', () => {
    const first = applyCatalogPage(emptyCatalogListState(), {
      items: [row('a')],
      total: 3,
      page: 1,
    }, false)
    const second = applyCatalogPage(first, {
      items: [row('a'), row('b')],
      total: 3,
      page: 2,
    }, true)
    expect(second.items.map(item => item.id)).toEqual(['a', 'b'])
    expect(catalogCanLoadMore(second)).toBe(true)

    const stalled = applyCatalogPage(second, {
      items: [row('b')],
      total: 3,
      page: 3,
    }, true)
    expect(stalled.capped).toBe(true)
    expect(stalled.items).toHaveLength(2)
    expect(catalogCanLoadMore(stalled)).toBe(false)
    expect(catalogTruncationCopy(2, 3, true).en).toContain('List cap reached.')

    let paged: CatalogListState<{ id: string }> = emptyCatalogListState()
    for (let page = 1; page <= ATTENDANCE_CATALOG_MAX_PAGES; page += 1) {
      paged = applyCatalogPage(paged, {
        items: [row(`row-${page}`)],
        total: ATTENDANCE_CATALOG_MAX_PAGES + 5,
        page,
      }, page > 1)
    }
    expect(paged.capped).toBe(true)
    expect(catalogCanLoadMore(paged)).toBe(false)
    expect(paged.items).toHaveLength(ATTENDANCE_CATALOG_MAX_PAGES)
  })

  it('treats a missing total as the loaded length', () => {
    const state = applyCatalogPage(emptyCatalogListState(), {
      items: [row('only')],
      total: 'nope',
      page: 1,
    }, false)
    expect(state.total).toBe(1)
    expect(catalogCanLoadMore(state)).toBe(false)
  })
})
