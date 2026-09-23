/** First page size for approval-flow and rule-set catalogs. Matches parsePagination max. */
export const ATTENDANCE_CATALOG_PAGE_SIZE = 200

/** 25 pages × 200 rows. Further rows stay disclosed; Load more stops. */
export const ATTENDANCE_CATALOG_MAX_PAGES = 25

export interface CatalogListItem {
  id: string
}

export interface CatalogListState<T extends CatalogListItem> {
  items: T[]
  total: number
  page: number
  capped: boolean
}

export function emptyCatalogListState<T extends CatalogListItem>(): CatalogListState<T> {
  return { items: [], total: 0, page: 0, capped: false }
}

export function readCatalogTotal(value: unknown, fallback: number): number {
  const total = Number(value)
  if (!Number.isFinite(total) || total < 0) return fallback
  return Math.floor(total)
}

export function applyCatalogPage<T extends CatalogListItem>(
  current: CatalogListState<T>,
  pageResult: { items: T[]; total: unknown; page: number },
  append: boolean,
): CatalogListState<T> {
  const incoming = Array.isArray(pageResult.items) ? pageResult.items : []
  let items: T[]
  let added = 0
  if (!append) {
    items = incoming.slice()
    added = items.length
  } else {
    const seen = new Set(current.items.map(item => item.id))
    items = current.items.slice()
    for (const item of incoming) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
      added += 1
    }
  }
  const total = readCatalogTotal(pageResult.total, items.length)
  let capped = append ? current.capped : false
  const stalled = incoming.length === 0 || (append && added === 0)
  if (stalled && total > items.length) capped = true
  if (pageResult.page >= ATTENDANCE_CATALOG_MAX_PAGES && total > items.length) capped = true
  return {
    items,
    total,
    page: pageResult.page,
    capped,
  }
}

export function catalogCanLoadMore<T extends CatalogListItem>(state: CatalogListState<T>): boolean {
  return !state.capped
    && state.page > 0
    && state.page < ATTENDANCE_CATALOG_MAX_PAGES
    && state.items.length < state.total
}

export function catalogTruncationCopy(
  loaded: number,
  total: number,
  capped: boolean,
): { en: string; zh: string } {
  const en = `Showing ${loaded} of ${total}`
  const zh = `已显示 ${loaded}/${total}`
  if (!capped) return { en, zh }
  return {
    en: `${en}. List cap reached.`,
    zh: `${zh}。已达到列表上限。`,
  }
}
