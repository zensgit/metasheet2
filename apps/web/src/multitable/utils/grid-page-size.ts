// Grid rows-per-page choice (客户反馈 2026-10-21). The grid pages over the server's offset/limit view read;
// this is the `limit` a viewer picks for the classic pager (grouped grid, gallery) and the chunk the flat grid
// appends per scroll step. It is a per-viewer convenience, stored in localStorage per user + sheet — never in
// the view (a shared setting) and never in the URL/route.
//
// Only the listed sizes are ever applied: anything else read back (an older build's value, a hand-edited
// entry, garbage) is snapped into the set, so the server never sees a page size the UI does not offer.

export const GRID_PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const
export type GridPageSize = (typeof GRID_PAGE_SIZE_OPTIONS)[number]
export const DEFAULT_GRID_PAGE_SIZE: GridPageSize = 50

const STORAGE_PREFIX = 'metasheet:multitable:grid-page-size'

// Snap any value into GRID_PAGE_SIZE_OPTIONS: the largest option not above it (so 120 → 100, 9999 → 500),
// the smallest option for anything below 50, and the default for a non-number.
export function clampGridPageSize(value: unknown): GridPageSize {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_GRID_PAGE_SIZE
  let picked: GridPageSize = GRID_PAGE_SIZE_OPTIONS[0]
  for (const option of GRID_PAGE_SIZE_OPTIONS) {
    if (n >= option) picked = option
  }
  return picked
}

export function gridPageSizeStorageKey(userId: string, sheetId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${sheetId}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// The stored size for this user + sheet, snapped into the option set; null when there is no user or sheet yet,
// nothing stored, or storage is unavailable (private mode, quota, a throwing getter).
export function readGridPageSize(userId: string | null | undefined, sheetId: string | null | undefined): GridPageSize | null {
  if (!userId || !sheetId) return null
  try {
    const raw = storage()?.getItem(gridPageSizeStorageKey(userId, sheetId))
    if (raw == null || raw === '') return null
    return clampGridPageSize(raw)
  } catch {
    return null
  }
}

export function writeGridPageSize(userId: string | null | undefined, sheetId: string | null | undefined, size: unknown): void {
  if (!userId || !sheetId) return
  try {
    storage()?.setItem(gridPageSizeStorageKey(userId, sheetId), String(clampGridPageSize(size)))
  } catch {
    /* storage unavailable — the choice still applies for this session */
  }
}
