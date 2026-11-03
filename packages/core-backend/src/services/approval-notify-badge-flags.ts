/**
 * Default-OFF switches for the approval center's read-state badges (test report 2026-10-08).
 *
 * Each is ONE predicate read in two places that must agree for every value: the route gate of its
 * count endpoint (and the per-row list annotation), and the session feature the web reads to
 * decide whether to ask for the count at all. Exact literal 'true' only — no trimming, no case
 * folding, so 'TRUE', '1' and ' true' are all off. Read per call, never cached, so an operator
 * change takes effect without a code path that remembers an old value.
 *
 * Product choices behind each switch, and what turning it on means for historical rows, are
 * recorded in the global flag manifest (scripts/ops/global-history-flag-manifest.mjs) and the
 * approval flag ledger (docs/development/approval-parity-execution-ledger-20260817.md §7).
 */

/** 抄送我的 tab: unread-CC badge, per-row unread dot, `GET /api/approvals/cc-unread-count`. */
export function isApprovalCcUnreadBadgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APPROVAL_CC_UNREAD_BADGE_ENABLED === 'true'
}

/**
 * 我发起的 tab: new-outcome badge, per-row dot, `GET /api/approvals/mine-outcomes/unseen-count`.
 */
export function isApprovalMineOutcomeBadgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APPROVAL_MINE_OUTCOME_BADGE_ENABLED === 'true'
}
