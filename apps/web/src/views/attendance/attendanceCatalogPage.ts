/**
 * Minimal catalog-list paging for attendance rosters.
 * Matches plugin `parsePagination` (`defaultPageSize` 50, `maxPageSize` 200).
 * There is no shared catalog helper on main; schedule-group loaders inline the same cap.
 */

export const ATTENDANCE_CATALOG_PAGE_SIZE = 200

/**
 * Reload buttons pass a click event. Load-more passes `{ append: true }`.
 * An event is a full reload: `append` is only honored on a plain options object.
 */
export function attendanceCatalogAppendRequested(
  options: { append?: boolean } | Event | undefined,
): boolean {
  if (!options || options instanceof Event) return false
  return options.append === true
}

export function attendanceCatalogListQuery(page: number): { page: string; pageSize: string } {
  const normalized = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  return {
    page: String(normalized),
    pageSize: String(ATTENDANCE_CATALOG_PAGE_SIZE),
  }
}

/** Keep a larger server total. A missing/invalid total means "only what this response loaded". */
export function readAttendanceCatalogTotal(total: unknown, loadedCount: number): number {
  const parsed = Number(total)
  const safeLoaded = Number.isFinite(loadedCount) && loadedCount > 0 ? Math.floor(loadedCount) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return safeLoaded
  return Math.max(Math.floor(parsed), safeLoaded)
}

export function readAttendanceCatalogPageNumber(page: unknown, fallback: number): number {
  const parsed = Number(page)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1
  }
  return Math.floor(parsed)
}

export function attendanceCatalogHasMore(loadedCount: number, total: number): boolean {
  return total > loadedCount
}

export function mergeAttendanceCatalogItems<T>(
  existing: readonly T[],
  incoming: readonly T[],
  idOf: (item: T) => string,
): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of existing) {
    const id = idOf(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(item)
  }
  for (const item of incoming) {
    const id = idOf(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(item)
  }
  return merged
}
