/**
 * Approval list hot-path — 已等待 aging + severity glanceability (UX batch-1 B1-03).
 *
 * Pure, Element-Plus-free helpers so "how long has this been waiting" is unit-testable
 * independent of the views that render it (`ApprovalCenterView`'s 待我处理/我发起的 tabs,
 * `ApprovalMobileList`'s card date line, `ApprovalDetailView`'s pending chip).
 *
 * O-8 / F8-1: the wording now follows the shell locale through a REQUIRED `isZh` argument (every
 * caller reads it from `useLocale()`). The earlier Chinese-only rule existed to avoid a
 * half-translated phrase ("Waited 3 天"); `waitingPhrase` below builds the WHOLE phrase in one
 * locale, so the label and the duration can no longer disagree.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Milliseconds elapsed between `createdAt` and `now`, clamped to >= 0 (a `createdAt` that is
 * slightly in the future — clock skew — reads as "just now" rather than a negative duration).
 * Returns `null` for an unparseable `createdAt` so callers can fail quiet instead of rendering
 * "NaN 小时".
 */
function elapsedMs(createdAt: string, now: Date): number | null {
  const createdMs = new Date(createdAt).getTime()
  if (Number.isNaN(createdMs)) return null
  return Math.max(0, now.getTime() - createdMs)
}

/**
 * Human-readable "已等待" duration: '刚刚' / '< 1 hour' under an hour, whole hours (rounded down)
 * from an hour up to a day, whole days (rounded down) from a day onward. An invalid/unparseable
 * `createdAt` renders as '' so callers can `v-if` it away.
 */
export function formatRelativeWait(createdAt: string, isZh: boolean, now: Date = new Date()): string {
  const elapsed = elapsedMs(createdAt, now)
  if (elapsed === null) return ''
  if (elapsed < HOUR_MS) return isZh ? '刚刚' : '< 1 hour'
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS)
    return isZh ? `${hours} 小时` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const days = Math.floor(elapsed / DAY_MS)
  return isZh ? `${days} 天` : `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * The whole "已等待 N" phrase in ONE locale — the label and the duration always come from the same
 * `isZh`, so the page can never render "Waited 3 天". `duration` is a `formatRelativeWait` result.
 */
export function waitingPhrase(duration: string, isZh: boolean): string {
  return isZh ? `已等待 ${duration}` : `Waiting ${duration}`
}

/** Aging severity band for coloring the 已等待 signal. */
export type ApprovalWaitSeverity = 'normal' | 'warn' | 'urgent'

/**
 * `normal` at or under 3 days, `warn` beyond 3 days, `urgent` beyond 7 days. An invalid
 * `createdAt` is treated as `normal` (fail-quiet, paired with `formatRelativeWait`'s '').
 */
export function waitSeverity(createdAt: string, now: Date = new Date()): ApprovalWaitSeverity {
  const elapsed = elapsedMs(createdAt, now)
  if (elapsed === null) return 'normal'
  if (elapsed > 7 * DAY_MS) return 'urgent'
  if (elapsed > 3 * DAY_MS) return 'warn'
  return 'normal'
}
