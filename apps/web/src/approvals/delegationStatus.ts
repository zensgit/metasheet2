// B2-05 — time-aware delegation status. A `DelegationRecord` only carries a raw `active` boolean
// (server-side: "not manually disabled" — see disableDelegation/disableOwnDelegation in
// delegations.ts, both of which just flip/DELETE the row). Neither list view previously consulted
// the `startAt`/`endAt` window at all, so a delegation whose window had already lapsed (or hadn't
// started yet) still rendered a flat "生效" tag — the UI lies. This combines `active` with the
// window against `now` into the true 4-state display status both views render.
//
// Read BOTH DelegationSettingsView.vue (admin) and MyDelegationView.vue (self-service) before
// writing this: they share the IDENTICAL `DelegationRecord` row shape (`active: boolean`,
// `startAt`/`endAt`: ISO string) — no per-view field-name normalization was actually needed. The
// parameter type below stays a narrow structural shape (not `DelegationRecord` itself) so this
// module has no view/Vue import and stays unit-testable in isolation (mirrors the other pure
// helpers in this folder, e.g. templateAuthoring.ts's validate* functions).
export interface DelegationStatusRow {
  active: boolean
  startAt: string
  endAt: string
}

export type DelegationDisplayStatus = '未开始' | '生效中' | '已过期' | '已停用'

export interface DelegationStatusResult {
  status: DelegationDisplayStatus
  /** True only when `status === '生效中'` AND `endAt` is within the next 72h (boundary inclusive). */
  expiringSoon: boolean
}

const EXPIRING_SOON_WINDOW_MS = 72 * 60 * 60 * 1000

/**
 * `active === false` (manually disabled) always wins — a disabled delegation reads "已停用"
 * regardless of what its window would otherwise say (including an already-past or not-yet-started
 * window). Otherwise the window against `now` decides 未开始 / 生效中 / 已过期. `startAt`/`endAt`
 * are treated as an INCLUSIVE window (`startAt <= now <= endAt` = 生效中), matching
 * `validateDelegationForm`'s only constraint (`endAt` strictly after `startAt`).
 *
 * Defensive: an unparseable boundary can't gate a real comparison, so it is treated as absent
 * (never trips 未开始/已过期 on its own) rather than throwing or silently miscategorizing —
 * malformed data degrades to 生效中 (the same "trust active" behavior the old binary tag had).
 */
export function delegationDisplayStatus(row: DelegationStatusRow, now: Date = new Date()): DelegationStatusResult {
  if (!row.active) return { status: '已停用', expiringSoon: false }

  const nowMs = now.getTime()
  const startMs = new Date(row.startAt).getTime()
  const endMs = new Date(row.endAt).getTime()
  const hasStart = Number.isFinite(startMs)
  const hasEnd = Number.isFinite(endMs)

  if (hasStart && nowMs < startMs) return { status: '未开始', expiringSoon: false }
  if (hasEnd && nowMs > endMs) return { status: '已过期', expiringSoon: false }

  const expiringSoon = hasEnd && (endMs - nowMs) <= EXPIRING_SOON_WINDOW_MS
  return { status: '生效中', expiringSoon }
}

/** Element Plus `el-tag` `type` per status — one distinct color per state. */
export const DELEGATION_STATUS_TAG_TYPE: Record<DelegationDisplayStatus, 'info' | 'success' | 'warning' | 'danger'> = {
  未开始: 'info',
  生效中: 'success',
  已过期: 'warning',
  已停用: 'danger',
}
