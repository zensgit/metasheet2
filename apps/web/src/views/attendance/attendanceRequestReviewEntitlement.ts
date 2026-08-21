// Navigability audit fix 2 (2026-08-22): AttendanceView.vue's approve/reject affordance on the
// "Recent requests" list was previously rendered ONLY for the single row matching
// `props.initialRequestId` (the deep-link focus id the approval center's `?requestId=` query
// produces) — the task home's own "Pending approvals" entry carries no `requestId`, so a viewer
// arriving from it saw a request list with no way to act on anything.
//
// This module is the pure entitlement predicate the row-level approve/reject `v-if` reads. Kept
// out of AttendanceView.vue's `<script setup>` because a `<script setup>` block cannot export a
// plain function for direct unit testing (project convention: pure per-row predicates that need
// unit coverage live in a sibling module, e.g. `makeupPunchRequestStatus.ts`).
//
// Entitlement signal (no new permission check invented): `GET /api/attendance/requests` is
// single-target-user scoped server-side (`targetUserId = parsed.data.userId ?? requesterId`,
// `WHERE user_id = $1` in plugins/plugin-attendance/index.cjs) and 403s the WHOLE request unless
// the caller passes `canAccessOtherUsers` for a foreign `userId`. So any row in the client's
// `requests` list whose owner differs from the viewer already only exists in that list because the
// viewer's read access to that owner's data was confirmed server-side — the same "compare the
// row's owner id to the current actor id" idiom AttendanceView.vue already uses for shift-swap
// entitlement (`canAcceptShiftSwap`: `item.counterpartyUserId === actor`). The final approve/reject
// POST still round-trips through the server's own W4 request-decision authorization
// (`resolveRequestDecisionActorAccess`) — this predicate only controls whether the BUTTON renders,
// never whether the action is allowed.
//
// Fail-closed by construction: a missing/blank actor or owner id (e.g. `currentUserId` not yet
// resolved from `auth.getCurrentUserId()`, or a row whose `user_id` the client type does not
// surface) renders no button rather than guessing.

export interface AttendanceReviewableRequestRow {
  status?: string | null
  /** `attendance_requests.user_id`, present on every row via the backend's `{ ...row }` spread in
   *  `mapAttendanceRequestRow` even though the FE `AttendanceRequest` interface historically did
   *  not declare it. */
  user_id?: string | null
  userId?: string | null
}

/** True when `status` (case-insensitive) is the pending state that both approve/reject and the
 *  legacy focused-only gate already require. */
export function isAttendanceRequestPending(row: AttendanceReviewableRequestRow): boolean {
  return String(row.status ?? '').trim().toLowerCase() === 'pending'
}

/**
 * Whether the current viewer should see approve/reject controls for `row`.
 *
 * - `isFocused`: the pre-existing deep-link-focus case (`?requestId=` from the approval center)
 *   stays honored unconditionally while the row is pending, regardless of ownership data —
 *   unchanged from `canReviewFocusedAttendanceRequest`'s prior behavior.
 * - Otherwise: pending AND the row's owner id differs from the viewer's own id, with BOTH ids
 *   required non-blank (fail-closed: no owner data or no resolved viewer id renders nothing).
 */
export function canReviewAttendanceRequestRow(
  row: AttendanceReviewableRequestRow,
  currentUserId: string | null | undefined,
  isFocused: boolean,
): boolean {
  if (!isAttendanceRequestPending(row)) return false
  if (isFocused) return true

  const actor = String(currentUserId ?? '').trim()
  const owner = String(row.user_id ?? row.userId ?? '').trim()
  if (!actor || !owner) return false
  return owner !== actor
}
