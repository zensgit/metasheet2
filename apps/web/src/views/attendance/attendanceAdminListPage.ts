/** Backend `parsePagination` max for the attendance admin list family. */
export const ATTENDANCE_ADMIN_LIST_PAGE_SIZE = 200

/** User-driven load-more stops here so a huge total cannot be walked without a cap notice. */
export const ATTENDANCE_ADMIN_LIST_MAX_PAGES = 25

export interface AttendanceAdminListCursor {
  total: number
  page: number
  lastPageCount: number
}

export interface AttendanceAdminListPageInput {
  loaded: number
  total: number
  page: number
  lastPageCount: number
  maxPages?: number
}

export type AttendanceAdminListTruncationKind = 'complete' | 'more' | 'capped' | 'stalled'

export function createAttendanceAdminListCursor(): AttendanceAdminListCursor {
  return { total: 0, page: 0, lastPageCount: 0 }
}

export function resetAttendanceAdminListCursor(cursor: AttendanceAdminListCursor): void {
  cursor.total = 0
  cursor.page = 0
  cursor.lastPageCount = 0
}

export function attendanceAdminListPageParams(
  page = 1,
  pageSize = ATTENDANCE_ADMIN_LIST_PAGE_SIZE,
): { page: string; pageSize: string } {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const safeSize = Number.isFinite(pageSize) && pageSize >= 1
    ? Math.floor(pageSize)
    : ATTENDANCE_ADMIN_LIST_PAGE_SIZE
  return {
    page: String(safePage),
    pageSize: String(safeSize),
  }
}

export function readAttendanceListTotal(
  payload: { total?: unknown } | null | undefined,
  loadedCount: number,
): number {
  const total = Number(payload?.total)
  if (Number.isFinite(total) && total >= 0) return Math.floor(total)
  return Math.max(0, loadedCount)
}

export function attendanceListCanLoadMore(input: AttendanceAdminListPageInput): boolean {
  const maxPages = input.maxPages ?? ATTENDANCE_ADMIN_LIST_MAX_PAGES
  if (input.page < 1) return false
  if (input.page >= maxPages) return false
  if (input.total <= input.loaded) return false
  if (input.lastPageCount <= 0) return false
  return true
}

export function attendanceAdminListTruncationKind(
  input: AttendanceAdminListPageInput,
): AttendanceAdminListTruncationKind {
  if (input.total <= input.loaded) return 'complete'
  if (attendanceListCanLoadMore(input)) return 'more'
  const maxPages = input.maxPages ?? ATTENDANCE_ADMIN_LIST_MAX_PAGES
  if (input.page >= maxPages) return 'capped'
  return 'stalled'
}

export function shouldRequestAttendanceAdminListPage(
  input: AttendanceAdminListPageInput & { append: boolean },
): boolean {
  if (!input.append) return true
  return attendanceListCanLoadMore(input)
}

export function nextAttendanceAdminListPage(page: number, append: boolean): number {
  if (!append) return 1
  const current = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 0
  return current + 1
}

export function beginAttendanceAdminListRequest(
  cursor: AttendanceAdminListCursor,
  loaded: number,
  append: boolean,
): number | null {
  if (!shouldRequestAttendanceAdminListPage({
    append,
    loaded,
    total: cursor.total,
    page: cursor.page,
    lastPageCount: cursor.lastPageCount,
  })) return null
  return nextAttendanceAdminListPage(cursor.page, append)
}

export function appendAttendanceListItems<T>(
  current: readonly T[],
  incoming: readonly T[],
  idOf: (item: T) => string,
): T[] {
  if (incoming.length === 0) return current.slice()
  const seen = new Set<string>()
  for (const item of current) {
    const id = idOf(item)
    if (id) seen.add(id)
  }
  const next = current.slice()
  for (const item of incoming) {
    const id = idOf(item)
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    next.push(item)
  }
  return next
}

export function applyAttendanceAdminListPage<T>(input: {
  current: readonly T[]
  incoming: readonly T[] | null | undefined
  payload: { total?: unknown } | null | undefined
  page: number
  append: boolean
  idOf: (item: T) => string
}): { items: T[]; total: number; page: number; received: number } {
  const incoming = Array.isArray(input.incoming) ? input.incoming.slice() : []
  const items = input.append
    ? appendAttendanceListItems(input.current, incoming, input.idOf)
    : incoming
  const stalled = input.append && incoming.length > 0 && items.length === input.current.length
  return {
    items,
    total: readAttendanceListTotal(input.payload, items.length),
    page: input.page,
    received: stalled ? 0 : incoming.length,
  }
}

export function storeAttendanceAdminListPage<T>(
  cursor: AttendanceAdminListCursor,
  current: readonly T[],
  input: {
    incoming: readonly T[] | null | undefined
    payload: { total?: unknown } | null | undefined
    page: number
    append: boolean
    idOf: (item: T) => string
  },
): T[] {
  const applied = applyAttendanceAdminListPage({ ...input, current })
  cursor.total = applied.total
  cursor.page = applied.page
  cursor.lastPageCount = applied.received
  return applied.items
}
