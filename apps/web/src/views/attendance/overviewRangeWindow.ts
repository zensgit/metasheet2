// Overview calendar, request follow-up, and anomaly list share one rule:
// size the first page to the visible from–to range, never past the attendance
// API page cap, and tell the user when `total` is still larger than the rows
// actually returned. Reports keep their own 20-row record pager.

/** `parsePagination` default `maxPageSize` in plugins/plugin-attendance. */
export const OVERVIEW_API_PAGE_SIZE_CAP = 200

/** Reports record card pager. Overview must not reuse this as a silent calendar cap. */
export const REPORT_RECORDS_PAGE_SIZE = 20

/**
 * Smallest overview record page. 31 covers the default "today minus 30 days"
 * inclusive window and a 28–31 day month when there is one current row per work date.
 * The previous overview fetch used 20 and dropped the earlier days.
 */
export const OVERVIEW_RECORDS_PAGE_FLOOR = 31

/**
 * Requests are not one-per-day. The old overview fetch used 10, so pending rows
 * past that page never reached the attention chips. Ask for the API cap.
 */
export const OVERVIEW_REQUESTS_PAGE_FLOOR = OVERVIEW_API_PAGE_SIZE_CAP

/** Previous anomaly fetch. Grow with the day span, but do not shrink below this. */
export const OVERVIEW_ANOMALIES_PAGE_FLOOR = 50

export type OverviewRangeKind = 'records' | 'requests' | 'anomalies'

export interface OverviewWindow {
  page: number
  pageSize: number
  total: number
  fetched: number
  truncated: boolean
}

export interface OverviewRangeNotice {
  en: string
  zh: string
}

export function emptyOverviewWindow(): OverviewWindow {
  return { page: 1, pageSize: 0, total: 0, fetched: 0, truncated: false }
}

function parseIsoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const utc = Date.UTC(year, month - 1, day)
  const check = new Date(utc)
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    return null
  }
  return utc
}

/** Inclusive day count for `YYYY-MM-DD` endpoints. Null when the range is unusable. */
export function inclusiveDaySpan(from: string, to: string): number | null {
  const start = parseIsoDateUtc(from)
  const end = parseIsoDateUtc(to)
  if (start == null || end == null || end < start) return null
  return Math.floor((end - start) / 86_400_000) + 1
}

/**
 * Page size for an overview list: at least `floor`, at least the inclusive day
 * span, and never above the API cap. A null span keeps the floor.
 */
export function overviewWindowPageSize(from: string, to: string, floor: number): number {
  const span = inclusiveDaySpan(from, to)
  const needed = Math.max(floor, span ?? floor)
  return Math.min(OVERVIEW_API_PAGE_SIZE_CAP, Math.max(1, Math.floor(needed)))
}

export function readPagedPayload(body: unknown): { items: unknown[]; total: number } {
  const data = body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : undefined
  const record = data && typeof data === 'object'
    ? data as { items?: unknown; total?: unknown }
    : {}
  const items = Array.isArray(record.items) ? record.items : []
  const totalRaw = Number(record.total)
  const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : items.length
  return { items, total }
}

export function nextOverviewPage(window: OverviewWindow): number | null {
  if (!window.truncated) return null
  return window.page + 1
}

function mergeOverviewPages<T>(current: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of [...current, ...incoming]) {
    const key = keyOf(item)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    merged.push(item)
  }
  return merged
}

/**
 * Fold one API page into the overview window.
 * Truncated means `total` is still ahead of the raw rows fetched. A missing `total`
 * is treated as the returned length, so it does not invent a banner. An empty
 * follow-up page turns the banner off: there is nothing further to append.
 */
export function reduceOverviewPage<T>(input: {
  previousItems: T[]
  previousFetched: number
  incoming: T[]
  page: number
  pageSize: number
  total: number
  append: boolean
  keyOf: (item: T) => string
}): { items: T[]; window: OverviewWindow } {
  const items = mergeOverviewPages(input.append ? input.previousItems : [], input.incoming, input.keyOf)
  const fetched = (input.append ? input.previousFetched : 0) + input.incoming.length
  const total = Number.isFinite(input.total) && input.total >= 0 ? Math.floor(input.total) : fetched
  const followUpWasEmpty = input.append && input.incoming.length === 0
  const truncated = !followUpWasEmpty && fetched < total
  return {
    items,
    window: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      fetched,
      truncated,
    },
  }
}

export function overviewRangeNotice(
  kind: OverviewRangeKind,
  window: OverviewWindow,
  pendingInLoaded = 0,
): OverviewRangeNotice | null {
  if (!window.truncated) return null
  const remaining = Math.max(0, window.total - window.fetched)
  const loaded = window.fetched
  const total = window.total
  if (kind === 'records') {
    return {
      en: `Calendar shows ${loaded} of ${total} records in this range. ${remaining} earlier record(s) are missing from the grid until you load more.`,
      zh: `日历显示本区间 ${total} 条记录中的 ${loaded} 条。还有 ${remaining} 条更早的记录未出现在格子上，可继续加载。`,
    }
  }
  if (kind === 'requests') {
    return {
      en: `Pending count and follow-up use the latest ${loaded} of ${total} requests (${pendingInLoaded} pending in the loaded set). ${remaining} older request(s) are not included yet.`,
      zh: `待审批计数和跟进只统计最近 ${loaded} / ${total} 条申请（已加载里有 ${pendingInLoaded} 条待审批）。还有 ${remaining} 条更早的申请未计入。`,
    }
  }
  return {
    en: `Showing ${loaded} of ${total} anomalies. Batch resolve can only select loaded rows; ${remaining} later row(s) stay out of the list until you load more.`,
    zh: `当前显示 ${total} 条异常中的 ${loaded} 条。批量处理只能选择已加载行；还有 ${remaining} 条未出现在列表中，可继续加载。`,
  }
}
