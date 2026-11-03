/**
 * Record inspector v3 PR-B2 (docs/development/multitable-record-inspector-v3-design-20260905.md §1.3
 * "Field-anchored server errors" + §4 item 11): the ONE routing rule the workbench's `onDrawerPatch`
 * applies to a rejected inspector patch, kept as a pure function so its matrix can be pinned without
 * the workbench harness.
 *
 *   - `conflict` — `VERSION_CONFLICT`: the existing conflict banner (driven by `grid.conflict`, not
 *     by this function) plus a field marker under the control; the pre-existing toast is KEPT (round 2
 *     — §4 item 11's "all other codes keep the toast" is true verbatim).
 *   - `field`    — the server anchored the failure to a field (`fieldErrors` non-empty), OR the response
 *     is HTTP 422, OR the code is `VALIDATION_ERROR`: inline `role=alert` under the field, value kept in
 *     the control; no toast. Code-keyed, NOT status-keyed (round 2): a plain HTTP 400 carrying any OTHER
 *     code — e.g. the record-lock refusal, which ships as 400 `FORBIDDEN` — is a permission/lock
 *     refusal, not a field validation error, and keeps the toast.
 *   - `toast`    — every other code/status (400 with a non-validation code, 403, 404, 409 CONFLICT, 500,
 *     503, network, and a null failure — e.g. the composable's LOCAL row-action refusal that never
 *     reaches the server): today's toast, unchanged.
 *
 * Pre-check finding stated in the PR body (do not rely on it here): on this head the backend /patch
 * route never emits `fieldErrors` on any status, so in practice the `field` route is reached via the
 * `VALIDATION_ERROR` leg (the backend's value-validation envelope is 400 + `VALIDATION_ERROR`); the
 * `fieldErrors` leg is the client-side normalisation contract (`client.ts` normalizeFieldErrors) kept
 * ready for a server that does send it. Two non-field refusals ride the same 400 + `VALIDATION_ERROR`
 * envelope today (row-level edit denial; linked-records concurrency) and therefore route inline —
 * disclosed in the PR body, owner item.
 *
 * Whether the inline alert can actually RENDER (details tab active, field row present, inspector open
 * on that record) is NOT this function's concern — the workbench asks the inspector
 * (`canAnchorFieldError`) after resolving `field` and falls back to the toast when it cannot.
 */
import type { GridPatchFailure } from '../composables/useMultitableGrid'

export type PatchFailureRoute = 'field' | 'conflict' | 'toast'

export function resolvePatchFailureRoute(failure: GridPatchFailure | null | undefined): PatchFailureRoute {
  if (!failure) return 'toast'
  if (failure.code === 'VERSION_CONFLICT') return 'conflict'
  if (failure.fieldErrors && Object.keys(failure.fieldErrors).length > 0) return 'field'
  if (failure.status === 422) return 'field'
  if (failure.code === 'VALIDATION_ERROR') return 'field'
  return 'toast'
}

/**
 * The inline message for the field the user edited: the server's own per-field message when it sent a
 * NON-EMPTY one for THAT field, else the failure's top-level message. Both are the server's text passed
 * through verbatim by client.ts (`payload.message`; NOT localised client-side — the backend's
 * validation messages are English literals, exactly what the pre-B2 toast showed). Never parses
 * `message` text for a field id — a client-known `fieldId` is the only anchor. May return '' when the
 * server sent nothing usable; the workbench falls back to the toast in that case.
 */
export function fieldAnchoredPatchMessage(failure: GridPatchFailure): string {
  return failure.fieldErrors?.[failure.fieldId] || failure.message
}
