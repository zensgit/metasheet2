// 备料分批拉取第一期 step 4 PR-7 — THE BOARD'S REFRESH STANZA, read on the web (design §9.1, §11, §13; plan §8).
//
// PURE. No I/O, no clock, no storage: one parser over the board's `refresh` key and the small derivations every
// surface reads from it — the 「可以导出」 verdict, the three renderings, the banner, the ledger/hold split and the
// rail count. Kept out of any `api/` directory on purpose (the vite browser harness routes `**/api/**`).
//
// WHAT THE SERVER SENDS (PR-5, deviation 7 / O-18). The board serializes ONLY `readProjectRefreshState(...)`'s own
// values-free object (plugins/plugin-integration-core/lib/stock-preparation-refresh-state.cjs):
//   { readable, status, statusLabel, governed, exportAllowed, settled, counts | null, unreadable?: { reason, store?, operation? } }
// — NOT design §13's richer stanza (no `holdSetFingerprint`, no `continuations[]`). Nothing here expects them.
//
// THREE ANSWERS, NEVER ONE FOR ANOTHER (plan §8):
//   absent       the key is not there at all — an OLDER backend (pre-PR-5). The board renders exactly as before (R-62 ⑤).
//   unreadable   the key is there and says it could not be read — or is there and malformed (FAIL CLOSED).
//   not_governed the project is not under the batch refresh: everything renders as on main.
//
// 「可以导出」 IS NEVER `exportAllowed` (#6566 review N5). `exportAllowed` keeps its PR-1 meaning (the status predicate
// alone): a never-settled pilot project answers `{ status:'complete', exportAllowed:true, settled:false }` while the
// export answers 409 `not_settled`. The ONE source of 「可以导出」 here is `stockPrepFormalSurfaceVerdict`, a
// transcription of the server's `formalSurfaceVerdict` (RS-MIRROR drives both over the real derivation).
//
// VALUES-FREE. The stanza carries tokens, counts and booleans only; this module keeps exactly those (clamped) and
// nothing else, and never persists anything.
import {
  STOCK_PREP_REFRESH_BANNER_PLAIN,
  type StockPrepPlainEntry,
} from './plainLanguage'

/** The derived status tokens, in the server's own order — byte-equal to `STATUS_TOKENS` (RS-MIRROR). */
export const STOCK_PREP_REFRESH_STATUS_TOKENS = Object.freeze([
  'unreadable',
  'not_governed',
  'executing',
  'failed_pending_recovery',
  'pending_confirmation',
  'change_pending_review',
  'confirmed_pending_execution',
  'executed_pending_settlement',
  'complete',
] as const)

export type StockPrepRefreshStatus = typeof STOCK_PREP_REFRESH_STATUS_TOKENS[number]

/** The server's own zh labels — byte-equal to `STATUS_LABELS_ZH` (RS-MIRROR). */
export const STOCK_PREP_REFRESH_STATUS_LABELS_ZH: Readonly<Record<StockPrepRefreshStatus, string>> = Object.freeze({
  unreadable: '状态读取失败',
  not_governed: '未启用',
  executing: '执行中',
  failed_pending_recovery: '失败待恢复',
  pending_confirmation: '待确认',
  change_pending_review: '变更待复核',
  confirmed_pending_execution: '已确认待执行',
  executed_pending_settlement: '已执行待核对',
  complete: '已完成',
})

export type StockPrepRefreshGoverned = 'pilot' | 'protected' | 'none' | 'unknown'

const GOVERNED_TOKENS: readonly StockPrepRefreshGoverned[] = Object.freeze(['pilot', 'protected', 'none', 'unknown'])

export interface StockPrepRefreshCounts {
  pendingConfirm: number | null
  confirmable: number | null
  openExecutions: number | null
  pendingReviews: number | null
  continuations: number | null
}

export interface StockPrepRefreshStanza {
  readable: boolean
  status: StockPrepRefreshStatus
  statusLabel: string
  governed: StockPrepRefreshGoverned
  /** PR-1's status predicate — kept for completeness, NEVER read for 「可以导出」 (see the header). */
  exportAllowed: boolean
  settled: boolean
  counts: StockPrepRefreshCounts | null
  unreadable: { reason: string; store?: string; operation?: string } | null
}

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function isStatus(value: unknown): value is StockPrepRefreshStatus {
  return typeof value === 'string' && (STOCK_PREP_REFRESH_STATUS_TOKENS as readonly string[]).includes(value)
}

function unreadableStanza(reason: string, failure?: { store?: string; operation?: string }): StockPrepRefreshStanza {
  return Object.freeze({
    readable: false,
    status: 'unreadable' as const,
    statusLabel: STOCK_PREP_REFRESH_STATUS_LABELS_ZH.unreadable,
    governed: 'unknown' as const,
    exportAllowed: false,
    settled: false,
    counts: null,
    unreadable: Object.freeze({ reason, ...(failure || {}) }),
  })
}

/**
 * Parse the board's `refresh` key. `undefined` (the key ABSENT — an older backend) → `null`. Anything present but
 * not a well-formed stanza → the `unreadable` stanza (fail closed), as is an unknown status token. Counts that are
 * not non-negative integers become `null`; the unreadable failure keeps only lower_snake tokens.
 */
export function parseStockPrepRefreshStanza(value: unknown): StockPrepRefreshStanza | null {
  if (value === undefined) return null
  if (!isPlainObject(value)) return unreadableStanza('malformed_stanza')
  if (!isStatus(value.status)) return unreadableStanza('unknown_status')
  const status = value.status
  if (status === 'unreadable' || value.readable !== true) {
    const failure: { store?: string; operation?: string } = {}
    const raw = isPlainObject(value.unreadable) ? value.unreadable : {}
    if (typeof raw.store === 'string' && TOKEN.test(raw.store)) failure.store = raw.store
    if (typeof raw.operation === 'string' && TOKEN.test(raw.operation)) failure.operation = raw.operation
    const reason = typeof raw.reason === 'string' && TOKEN.test(raw.reason) ? raw.reason : 'unreadable'
    return unreadableStanza(reason, failure)
  }
  const governed = typeof value.governed === 'string' && (GOVERNED_TOKENS as readonly string[]).includes(value.governed)
    ? value.governed as StockPrepRefreshGoverned
    : 'unknown'
  const rawCounts = isPlainObject(value.counts) ? value.counts : null
  const counts: StockPrepRefreshCounts | null = rawCounts
    ? Object.freeze({
      pendingConfirm: countOf(rawCounts.pendingConfirm),
      confirmable: countOf(rawCounts.confirmable),
      openExecutions: countOf(rawCounts.openExecutions),
      pendingReviews: countOf(rawCounts.pendingReviews),
      continuations: countOf(rawCounts.continuations),
    })
    : null
  return Object.freeze({
    readable: true,
    status,
    statusLabel: STOCK_PREP_REFRESH_STATUS_LABELS_ZH[status],
    governed,
    exportAllowed: value.exportAllowed === true,
    settled: value.settled === true,
    counts,
    unreadable: null,
  })
}

export type StockPrepFormalSurfaceRefusal = 'unreadable' | 'state' | 'not_settled'

/**
 * THE ONLY SOURCE OF 「可以导出」 on the web — a transcription of the server's `formalSurfaceVerdict`: a not-governed
 * project passes; a governed one passes only when `complete` AND settled; anything unreadable or malformed refuses.
 */
export function stockPrepFormalSurfaceVerdict(stanza: StockPrepRefreshStanza | null): { allowed: boolean; reason: StockPrepFormalSurfaceRefusal | null } {
  if (!stanza || stanza.readable !== true || !isStatus(stanza.status) || stanza.status === 'unreadable') {
    return { allowed: false, reason: 'unreadable' }
  }
  if (stanza.status === 'not_governed') return { allowed: true, reason: null }
  if (stanza.status !== 'complete') return { allowed: false, reason: 'state' }
  if (stanza.settled !== true) return { allowed: false, reason: 'not_settled' }
  return { allowed: true, reason: null }
}

/** True when the stanza blocks nothing: absent (older backend), not governed, or complete AND settled. */
export function stockPrepRefreshIsQuiet(stanza: StockPrepRefreshStanza | null): boolean {
  if (stanza === null) return true
  return stanza.readable === true && stockPrepFormalSurfaceVerdict(stanza).allowed
}

export type StockPrepRefreshRendering = 'absent' | 'not_governed' | 'unreadable' | 'none_pending' | 'pending'

/**
 * Plan §8's three renderings plus the two web states. `pendingHolds` is the open-hold count the caller saw (the
 * holds page's own list, or the stanza's `counts.pendingConfirm`); `null` defers to the stanza.
 */
export function stockPrepRefreshRendering(
  stanza: StockPrepRefreshStanza | null,
  options: { pendingHolds?: number | null } = {},
): StockPrepRefreshRendering {
  if (stanza === null) return 'absent'
  if (stanza.readable !== true || stanza.status === 'unreadable') return 'unreadable'
  if (stanza.status === 'not_governed') return 'not_governed'
  const fromCaller = countOf(options.pendingHolds)
  const pending = fromCaller !== null ? fromCaller : (stanza.counts?.pendingConfirm ?? 0)
  return pending > 0 ? 'pending' : 'none_pending'
}

export interface StockPrepRefreshBanner {
  /** The banner-copy key: a status token, or `unsettled` for a complete-but-unsettled project. */
  key: string
  status: StockPrepRefreshStatus
  zh: string
  en: string
  zhNext: string
  enNext: string
  /** The open-hold count folded into the sentence (pending_confirmation only), else null. */
  count: number | null
  /** True only for a puller (`canOpenQueue`) AND a project with holds to decide: the banner links to 拉取待确认. */
  link: boolean
}

function fill(text: string, n: number | null): string {
  return text.replace('{n}', n === null ? '' : String(n)).replace(/ {2,}/g, ' ')
}

/**
 * The 项目备料页 banner — for EVERYONE who can open the board (design §13: the floor sees the banner, counts and
 * tokens, no hold payload). `null` when the stanza blocks nothing (absent / not_governed / complete ∧ settled):
 * the page is then byte-for-byte what it was before PR-7.
 */
export function stockPrepRefreshBanner(
  stanza: StockPrepRefreshStanza | null,
  options: { canOpenQueue?: boolean } = {},
): StockPrepRefreshBanner | null {
  if (stanza === null) return null
  const verdict = stockPrepFormalSurfaceVerdict(stanza)
  if (stanza.readable === true && verdict.allowed) return null
  const key = stanza.readable !== true || stanza.status === 'unreadable'
    ? 'unreadable'
    : (stanza.status === 'complete' ? 'unsettled' : stanza.status)
  const entry: StockPrepPlainEntry | undefined = STOCK_PREP_REFRESH_BANNER_PLAIN[key] ?? STOCK_PREP_REFRESH_BANNER_PLAIN.unreadable
  const count = key === 'pending_confirmation' ? (stanza.counts?.pendingConfirm ?? null) : null
  return {
    key,
    status: stanza.status,
    zh: fill(entry.zh, count),
    en: fill(entry.en, count),
    zhNext: entry.zhNext ?? '',
    enNext: entry.enNext ?? '',
    count,
    link: options.canOpenQueue === true && key === 'pending_confirmation',
  }
}

/**
 * The board's 「等您拿主意 N 件」 is ledger work only. Since PR-5 `board.pendingDecisionCount` is the UNION of the
 * confirmation ledger's pending rows and the project's open refresh holds (operator-project-directory.cjs); holds are
 * a puller's work, shown by the banner. `holds` = the readable stanza's `counts.pendingConfirm`; `ledger` =
 * clamp(union − holds) — a clamp, not an equality: the union counts holds by project number across sheets, the stanza
 * by resolved sheet, and the two reads are not one snapshot. An absent / unreadable stanza leaves the union as ledger.
 */
export function stockPrepPendingSplit(board: { pendingDecisionCount?: unknown } | null | undefined, stanza: StockPrepRefreshStanza | null): { ledger: number; holds: number } {
  const union = countOf(board?.pendingDecisionCount) ?? 0
  if (!stanza || stanza.readable !== true) return { ledger: union, holds: 0 }
  const holds = stanza.counts?.pendingConfirm
  if (holds === null || holds === undefined) return { ledger: union, holds: 0 }
  return { ledger: Math.max(0, union - holds), holds }
}

/** The rail badge of 拉取待确认 for the OPEN project (R-62 ④): a positive open-hold count, else null. */
export function stockPrepRefreshRailCount(stanza: StockPrepRefreshStanza | null): number | null {
  if (!stanza || stanza.readable !== true) return null
  const pending = stanza.counts?.pendingConfirm
  return typeof pending === 'number' && pending > 0 ? pending : null
}
