/**
 * G-B2-11 (approval-automation-operation-ux-benchmark §B2-11) — "新待办到达刷新 pill".
 *
 * The audited gap: the tab-label badge polls the server and can show a fresh unread count while
 * the list underneath it is still the page that was loaded a while ago (badge 5 / list 3). The fix
 * is NOT to auto-refresh the list the moment the server count changes — an unannounced reload would
 * silently wipe out whatever rows the operator currently has checked in the 操作台 batch
 * approve/reject multi-select (`selectedPending` in ApprovalCenterView), and the operator would have
 * no idea why their selection vanished mid-triage. Instead we surface an explicit, dismissable pill
 * ("N 条新待办 · 点击刷新") and only reload on the operator's own click.
 *
 * The one trap this module exists to avoid: comparing the server's pending `count` against the
 * number of rows currently loaded on screen. That comparison is wrong because the list is PAGED —
 * moving to page 2 of a 30-row pending queue would make "count (30) > rows-on-this-page (10)" true
 * forever, permanently misreporting pagination as new arrivals. The correct comparison is against a
 * snapshot of `count` taken at the moment the list was last (re)loaded — `pendingCountAtLoad` — so a
 * subsequent rise in `count` above that snapshot is unambiguously new server-side arrivals, not
 * paging or a stale local read.
 */

export type ApprovalCenterTabName = 'pending' | 'mine' | 'cc' | 'completed'

export interface NewTodoPillInput {
  /** The view's currently active tab; the pill is 待我处理-only by design (only that tab has the
   * batch multi-select this feature protects). */
  activeTab: ApprovalCenterTabName | string
  /** Snapshot of the server's pending `count` taken at the last explicit list (re)load.
   * `null` means "no load has completed yet" — must never show a pill before that. */
  pendingCountAtLoad: number | null
  /** The latest known server pending `count` (the total, NOT the unread badge count and NOT the
   * number of rows currently rendered on the page). */
  currentPendingCount: number
}

export interface NewTodoPillState {
  visible: boolean
  /** Always >= 0. Never negative — a count that shrank (someone else actioned a row) is simply
   * not "new todos" and must not render as "-2 条新待办". */
  delta: number
}

const HIDDEN: NewTodoPillState = { visible: false, delta: 0 }

export function newTodoPillState({
  activeTab,
  pendingCountAtLoad,
  currentPendingCount,
}: NewTodoPillInput): NewTodoPillState {
  if (activeTab !== 'pending') return HIDDEN
  if (pendingCountAtLoad === null || !Number.isFinite(pendingCountAtLoad)) return HIDDEN
  if (!Number.isFinite(currentPendingCount)) return HIDDEN

  const delta = currentPendingCount - pendingCountAtLoad
  if (delta <= 0) return HIDDEN
  return { visible: true, delta }
}
