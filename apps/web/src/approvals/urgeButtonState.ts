/**
 * G-B2-12 — per-row 催办 button state.
 *
 * The old rule gated EVERY row's button on a single in-flight id, so nudging one request froze the
 * button on every other row. 催办 is a low-risk nudge (the server rate-limits it to 1 per
 * instance/user/hour), so unlike the inline approve/reject hot path — where racing two rows mutates
 * two approvals — concurrent per-row reminds are safe. Each row is therefore gated only by its OWN
 * in-flight request, plus a session memory of rows already nudged.
 *
 * `reminded` is deliberately session-scoped (not persisted): the authoritative "you already nudged
 * this" lives server-side as an hourly window. A localStorage copy would keep claiming 已催办 long
 * after that window expired — a stale claim is worse than no claim.
 *
 * O-8 / F8-1: the label/title follow the shell locale via the caller's `isZh` (required — the only
 * caller, ApprovalCenterView.vue, reads it from `useLocale()`).
 */
export interface UrgeButtonState {
  disabled: boolean
  loading: boolean
  label: string
  /** Native tooltip; empty when there is nothing honest to add. */
  title: string
}

export function urgeButtonState(
  rowId: string,
  remindingIds: ReadonlySet<string>,
  remindedIds: ReadonlySet<string>,
  isZh: boolean,
): UrgeButtonState {
  const loading = remindingIds.has(rowId)
  // While this row's own request is in flight, it renders as loading — not as 已催办 — even though
  // a success may have already recorded it (the two sets overlap for one synchronous tick).
  const reminded = !loading && remindedIds.has(rowId)
  return {
    loading,
    disabled: loading || reminded,
    label: reminded ? (isZh ? '已催办' : 'Reminded') : (isZh ? '催办' : 'Remind'),
    title: reminded ? (isZh ? '本次已催办（服务端每小时限一次）' : 'Reminder sent (the server allows one per hour)') : '',
  }
}
