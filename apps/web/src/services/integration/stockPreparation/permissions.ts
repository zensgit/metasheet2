// O2 / R-11 — the web half of the `/stock-prep` confirmation-queue workbench permission vocabulary.
//
// R-11 in one line: what is visible must be actionable, and what is not permitted must not be
// visible. That is only achievable if the front end decides visibility with the SAME predicate the
// server decides authority with. This module is that predicate, written once, so no view can invent
// its own idea of what an operator may do.
//
// The server side is `hasStockPrepPermission` in
// plugins/plugin-integration-core/lib/http-routes.cjs. The two derivations agree by construction:
//
//   read    := admin | stockprep:read
//   confirm := admin | (stockprep:read AND stockprep:confirm)
//
// `stockprep:read` is the admission ticket. `stockprep:confirm` is additive on top of it and is not
// honored alone on either side — the route guard admits `/stock-prep` on `stockprep:read`, so a
// confirm-only principal could never reach the controls, and authority it cannot reach would be
// PERMITTED-BUT-HIDDEN.
//
// Shaped like apps/web/src/approvals/permissions.ts: plain predicates over an injected
// `hasPermission`, so a view can pass `useAuth().hasPermission` and a test can pass a fake without
// standing up a session.

/** Values-free queue, readiness — the workbench admission code. */
export const STOCK_PREP_READ_PERMISSION = 'stockprep:read'

/** Confirm a decision, and read back the value entry that confirming authors. */
export const STOCK_PREP_CONFIRM_PERMISSION = 'stockprep:confirm'

/**
 * The COMPLETE stock-prep vocabulary. There is deliberately no third code: reconcile and ledger
 * provisioning stay on the platform admin gate rather than getting an operator-shaped code for an
 * owner-level act. The closure is asserted on both sides (see the permission-matrix suites).
 */
export const STOCK_PREP_PERMISSIONS: readonly string[] = Object.freeze([
  STOCK_PREP_READ_PERMISSION,
  STOCK_PREP_CONFIRM_PERMISSION,
])

export type HasPermission = (permission: string) => boolean

/**
 * May this principal open the workbench and read the values-free queue?
 *
 * `useAuth().hasPermission` already returns true for an admin (its `snapshot.isAdmin` /
 * `roles.includes('admin')` short-circuit), which is why admin needs no separate branch here and
 * why an admin can never lose reach through this module.
 */
export function canReadStockPrepQueue(hasPermission: HasPermission): boolean {
  return hasPermission(STOCK_PREP_READ_PERMISSION)
}

/**
 * May this principal confirm a decision (and therefore read back its own value entry)?
 *
 * BOTH codes, mirroring the server's admission-ticket rule. Written as an explicit conjunction
 * rather than relying on the caller already being inside a read-gated view: a control that decides
 * its own visibility from the full rule cannot be pasted somewhere less guarded and silently widen.
 */
export function canConfirmStockPrepDecision(hasPermission: HasPermission): boolean {
  return hasPermission(STOCK_PREP_READ_PERMISSION) && hasPermission(STOCK_PREP_CONFIRM_PERMISSION)
}
