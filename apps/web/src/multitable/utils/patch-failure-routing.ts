/**
 * Record inspector v3 PR-B2 (docs/development/multitable-record-inspector-v3-design-20260905.md §1.3
 * "Field-anchored server errors" + §4 item 11): the ONE routing rule the workbench's `onDrawerPatch`
 * applies to a rejected inspector patch, kept as a pure function so its matrix can be pinned without
 * the workbench harness.
 *
 *   - `conflict` — `VERSION_CONFLICT`: the existing conflict banner (driven by `grid.conflict`, not
 *     by this function) plus a field marker under the control; no toast.
 *   - `field`    — the server anchored the failure to a field (`fieldErrors` present), OR the response
 *     is a 400 / 422, OR the code is `VALIDATION_ERROR`: inline `role=alert` under the field, value
 *     kept in the control; no toast. (Brief wording verbatim: "routes fieldErrors/400/422/
 *     VALIDATION_ERROR to inspectorFieldErrors[fieldId] instead of toast".)
 *   - `toast`    — every other code/status (403, 404, 409 CONFLICT, 500, 503, network, and a
 *     null failure — e.g. the composable's LOCAL row-action refusal that never reaches the server):
 *     today's toast, unchanged.
 *
 * Pre-check finding stated in the PR body (do not rely on it here): on this head the backend /patch
 * route never emits `fieldErrors` on any status, so in practice the `field` route is reached via the
 * 400 / `VALIDATION_ERROR` legs; the `fieldErrors` leg is the client-side normalisation contract
 * (`client.ts` normalizeFieldErrors) kept ready for a server that does send it.
 */
import type { GridPatchFailure } from '../composables/useMultitableGrid'

export type PatchFailureRoute = 'field' | 'conflict' | 'toast'

export function resolvePatchFailureRoute(failure: GridPatchFailure | null | undefined): PatchFailureRoute {
  if (!failure) return 'toast'
  if (failure.code === 'VERSION_CONFLICT') return 'conflict'
  if (failure.fieldErrors && Object.keys(failure.fieldErrors).length > 0) return 'field'
  if (failure.status === 400 || failure.status === 422) return 'field'
  if (failure.code === 'VALIDATION_ERROR') return 'field'
  return 'toast'
}

/**
 * The inline message for the field the user edited: the server's own per-field message when it sent
 * one for THAT field, else the failure's top-level message (already localised by client.ts). Never
 * parses `message` text for a field id — a client-known `fieldId` is the only anchor.
 */
export function fieldAnchoredPatchMessage(failure: GridPatchFailure): string {
  return failure.fieldErrors?.[failure.fieldId] ?? failure.message
}
